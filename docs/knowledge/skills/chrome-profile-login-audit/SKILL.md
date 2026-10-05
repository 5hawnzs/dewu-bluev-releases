---
name: chrome-profile-login-audit
description: 审计一个 Chrome/Edge 的 user-data-dir（用户数据目录 / Profile），查清「为什么不用登录、不用验证码就能直接进后台」，并用实测数字给出结论与 RPA 接入方案。当用户说「分析 D:\xxx 这个文件夹，我加了 --user-data-dir 之后登录免验证码了」「这个 profile 是怎么保存登录态的」「帮我看看这份 Chrome 数据目录」「自动化怎么复用已登录的浏览器」时使用。
agent_created: true
---

# Chrome Profile 登录态审计

## 何时用

用户拿来一个目录（常被误称为"这个文件"），说自己用
`chrome.exe --user-data-dir="D:\xxx"` 启动后**免登录 / 免验证码**，想知道底层逻辑。

**先把认知纠正过来**：那不是文件，是 **Chrome 的用户数据目录（Profile）**。
免验证码的本质不是"绕过"，而是 **持久化 Cookie 复用 → 服务端认定已登录 → 登录流程被跳过 → 根本不到验证码那一步**。

## 核心判据（一眼定性）

| 检查点 | 免登录成立的证据 |
|---|---|
| `Default\Network\Cookies` | `is_persistent=1` 占比高（实测目标站点 100%） |
| 同名 Cookie 覆盖面 | 同一票据 Cookie 出现在多个子域（如 `stark.` / `m.` / `gravity.`） |
| `Last Browser` / `Last Version` | 指向真 chrome.exe + 版本号 → 是真实 Profile 而非伪造 |
| `Preferences → extensions.settings` | **0 个** → 排除"靠插件注入" |
| `Session Storage` vs `Network\Cookies` | 前者是会话级、后者是持久级；登录态在后者 |

## 步骤

### 1. 定位与体积

```python
import os
ROOT = r"D:\rpa_chrome\cabbeen"          # 用户给的路径
PROF = os.path.join(ROOT, "Default")
# 统计：文件数 / 总字节
tot = n = 0
for dp, dn, fn in os.walk(ROOT):
    for f in fn:
        try: tot += os.path.getsize(os.path.join(dp, f)); n += 1
        except OSError: pass
```

读纯文本标记文件（**注意编码**，见"坑"）：
`Last Version`、`Last Browser`、`Variations`、`Local State`(JSON)、`Default\Preferences`(JSON)。

### 2. 排除插件/脚本嫌疑（必做，否则结论站不住）

```python
import json, io
pr = json.loads(io.open(os.path.join(PROF, "Preferences"), encoding="utf-8", errors="replace").read())
print("extensions.settings 数量 =", len(pr.get("extensions", {}).get("settings", {})))
# 再看磁盘上 Default\Extensions 下还剩什么（通常只剩 Chrome 内置组件）
```
> Chrome 内置组件扩展 ID 白名单：`nmmhkkegccagdldgiimedpiccmgmieda`（Web Store Payments）、
> `mhjfbmdgcfjbbpaeojofohoefgiehjai`（PDF Viewer）等。这些不算"用户装的插件"。

### 3. 解 Cookies（**先拷贝再打开**，Chrome 运行时库被锁）

```python
import shutil, sqlite3, tempfile
tmp = tempfile.mkdtemp()
dst = os.path.join(tmp, "Cookies")
shutil.copy2(os.path.join(PROF, "Network", "Cookies"), dst)   # ← 必须拷贝
con = sqlite3.connect(dst); cur = con.cursor()
cur.execute("""SELECT host_key,name,expires_utc,is_persistent,is_secure,is_httponly
               FROM cookies ORDER BY host_key,name""")
```

**Chrome 时间戳换算**（微秒，1601-01-01 起算）：
```python
import datetime
EPOCH_OFFSET = 11644473600000000
dt = datetime.datetime(1970,1,1) + datetime.timedelta(microseconds=(expires_utc - EPOCH_OFFSET))
```
`expires_utc == 0` ⇒ **会话级 Cookie**（关浏览器即失）；这是"为什么以前不行"的关键反证。

**聚合一句最关键的话**：
```python
cur.execute("SELECT COUNT(*), SUM(is_persistent) FROM cookies")
```

### 4. 其他登录态载体（一个都别漏）

| 路径 | 说明 |
|---|---|
| `Default\Login Data` | `SELECT origin_url, username_value, length(password_value) FROM logins` —— 保存的密码（自动填充的第二重保险）。**不要解密密码值。** |
| `Default\Local Storage\leveldb\*.ldb/.log` | 二进制 leveldb，用 `re.findall(rb"[ -~]{4,80}")` 抽可打印串找域与键名 |
| `Default\Session Storage` | 同上，但为会话级 |
| `Default\Network\Device Bound Sessions` | `SELECT COUNT(*) FROM dbsc_session_tbl`，**0 行 = 未启用设备绑定会话** |
| `Local State` → `os_crypt.encrypted_key` | Cookie 值的加密密钥，受 **Windows DPAPI** 保护 |
| `Default\History` | `SELECT url,visit_count FROM urls WHERE url LIKE '%目标域%'` 印证业务用途 |

### 5. 并发状态检查

- `SingletonLock` / `SingletonCookie` / `SingletonSocket` 存在 ⇒ **有实例正在占用该目录**。
- `Default\LOCK` 是 Chromium 常驻文件，**存在是正常的**，不要当成"被占用"。
- 查真实占用：`Get-CimInstance Win32_Process` 过滤 chrome，看 `CommandLine` 里的 `--user-data-dir`。

## 报告必须写进去的三条硬约束

1. **Cookie 会过期** —— 把具体到期日算出来告知（实测：`stark.dewu.com` 的 `sk`/`dwsm` 为 +28 天）。
2. **DPAPI 绑「本机 + 本 Windows 用户」** —— 整份目录拷到别的机器/别的 Windows 账号，**Cookie 解不开**。
   跨机迁移必须**在目标机人工登录一次**重新生成，不是拷贝目录。`dbsc_session_tbl` 为空**不能**推出"可移植"。
3. **同一 user-data-dir 不能被两个 Chrome 实例同时持有**（`SingletonLock`）⇒ 自动化必须"附加"已开实例，不能另起一个。

## RPA 接入（给方案，不只给结论）

**方式 A（推荐）CDP 挂载**
```cmd
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --user-data-dir="D:\rpa_chrome\cabbeen" --remote-debugging-port=9222 ^
  --no-first-run --no-default-browser-check "https://stark.dewu.com/"
```
```python
browser = p.chromium.connect_over_cdp("http://127.0.0.1:9222")
ctx = browser.contexts[0]; page = ctx.pages[0] if ctx.pages else ctx.new_page()
```
> ★ **Chrome 136+ 起 `--remote-debugging-port` 必须配合"非默认"的 `--user-data-dir` 才生效。**
> 用户已有自定义目录，恰好满足 —— 别建议他改回默认目录。
>
> ★ 用 `--remote-debugging-port=0` 或先探测端口，别硬写 9222 跟别的工具撞。

**方式 B Playwright 持久化上下文**
```python
ctx = p.chromium.launch_persistent_context(user_data_dir=r"D:\rpa_chrome\cabbeen",
                                           channel="chrome", headless=False)
```
> ★ **`channel="chrome"` 是关键**：用 Playwright 自带 Chromium 会带自动化指纹（`navigator.webdriver` 等），
> 风控敏感度上升。本机已装真 Chrome 就用真的。

A、B **不可同时用于同一 `user_data_dir`**。

## 诚实边界（写进报告，别省）

- Cookie 值**是加密的**，不解密就**不能断言"哪一条是登录票据"**。只能描述形态（同名多子域、有效期长短）
  并明确写"具体哪条是票据，未解密确认"。
- **不要解密** Cookie 值，**不要**用这些凭据对目标站点发起请求 —— 那是用户的账号凭据。
- 未做过的验证要说"未验证"，不要用"应该/大概"包装成结论。

## 坑

- ⚠️ **Chrome 的 `Last Version` / `Last Browser` 可能是 UTF-16LE**。用 `encoding="utf-8"` 读会带进 `\x00` 字节，
  写进报告后被 Read 工具判为 "binary file" 直接看不了。
  ⇒ 生成报告前统一过滤：`txt = "".join(ch for ch in txt if ch in "\n\t" or ord(ch) >= 32)`（见技能 `win-sandbox-scripting` §8）。
- ⚠️ **不要用 `GetFileVersionInfo` + 手写 `VS_FIXEDFILEINFO` 结构体读 chrome.exe 版本** —— 实测返回垃圾值。
  改双源交叉验证：`Last Version` 文件 + 运行中 chrome 进程的 `--annotation=ver=`。
- ⚠️ Cookies / History / Login Data 都是 SQLite，**Chrome 运行时被独占锁** ⇒ 一律「先 `copy2` 到 temp 再 open」。
  同理**不要在 Chrome 运行时整目录复制**（可能拿到半写状态）。
- ⚠️ 输出目录内容极多（本机 4933 文件 / 846 MB）⇒ 列目录前先按需过滤，别把 `Get-ChildItem -Recurse` 全量回显。
