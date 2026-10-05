---
name: workbuddy-slowness-triage
description: 诊断「WorkBuddy 桌面端越用越卡 / 越来越慢 / 启动就慢 / 一卡消息就没了 / 界面卡住不动」。用可复算的实测数字把「机器资源不足」与「应用自己背的历史包袱」分开，并定位到具体的会话、定时任务或缓存目录。当用户抱怨卡顿、发消息卡、切换工作区慢、启动慢时使用。
agent_created: true
---

# WorkBuddy 卡顿定位（实测优先）

## 0. 铁律：先分流症状，再决定查哪里

**别一上来就说「会话文件太大」。** 实测（2026-09-30）：一个 180.6 MB / 26,097 行的会话文件，
**完整读取 + 逐行 JSON 解析只要 1.35 秒**（133 MB/s）—— 纯 I/O 根本不是瓶颈。

| 用户说 | 优先查 |
|---|---|
| 「打开某个旧会话时卡」 | 那个会话的大小 / 条数（渲染成本） |
| **「启动就慢 / 一直卡」** | **并行会话数 + 定时任务 + 孤儿会话堆积**（§3） |
| 「打字 / 发消息时卡」 | 主线程日志的状态迁移频率（§4） |
| 「切工作区慢」 | 工作区 / 会话列表规模 |

结论必须建立在「量过」之上，并且**一定要问清「卡在哪一步」**。猜错病因 = 没修。

## 1. 先量资源（30 秒）——排除「机器不够」

Windows 沙箱里 Bash 每条命令必须自己补 PATH（否则报 `git: command not found`）：

```bash
export PATH="/c/Users/Administrator/.workbuddy/vendor/PortableGit/cmd:/usr/bin:/bin:/c/Windows/System32:$PATH"
```

★ **别被 stderr 里的 `.../cli/vendor/shim/shell-runtime-bash-env.sh: line 3: dirname: command not found` 误导** ——
那是 **WorkBuddy 自己的 shim 脚本**报的（每条命令都会刷一遍），**与你的 PATH 无关、无害、忽略**。

### ★★ 本机 PowerShell 工具**整条路都不通**（2026-10-02 实测，推翻下面的旧写法）

旧写法「stdout 不回显 ⇒ 用 `Set-Content` 写文件再 Read」**已失效**：
实测 `Set-Content` **连文件都没落盘**（再看目标 `_diag-res.txt` 报 `File does not exist`）⇒
**不要再拿 PowerShell 取证**，直接用下面的「无 PowerShell 替代取证」。

★ **`wmic.exe` 在程序黑名单里**：报
`PROGRAM BLOCKED BY SECURITY POLICY ... Program Blacklist`，且明确「不能批准、不能绕过、不要重试」
⇒ 取 CPU/内存那条路彻底断了，**别重试、别换 shell 绕**（要放开得用户自己去 安全中心 → 命令安全 → 程序黑名单）。

### 无 PowerShell 的替代取证（两条都实测可用）

```bash
# ① 每个 WorkBuddy 进程的内存（Bash 就能跑）
tasklist | grep -i workbuddy | awk '{print $1, $5, $6}'
# ② 日志里自带的内存探针：agent 进程的 rss/heap/cpuPercent —— 根本不用去量机器
grep -o 'WorkflowMemProbe.*' "logs/<日期>/<工作区>__*.log" | tail -3
```

实测（2026-10-02）：`tasklist` 里**一个 WorkBuddy.exe 吃 3,289,516 K ≈ 3.14 GB**（渲染/界面进程），
而 `WorkflowMemProbe` 显示 **agent 进程只有 rss 311~414 MB、cpuPercent 0.0~0.3** ⇒
**「卡」在界面侧、不在 agent 侧**。这一组对照能一次把锅分清，别再怀疑「是会话跑得太重」。

其余（旧写法保留作参照）——原本还想量这些，两条并行发：

- 资源：CPU 总负载 + 可用内存 + 各盘可用 + 物理磁盘活动
- 进程：`WorkBuddy*` 的**进程数 / 内存合计 / CPU 增量**（隔 5 秒采样两次算增量）

**判据**：CPU < 10% 且可用内存 > 8 GB 且系统盘可用 > 20 GB ⇒ **资源不是瓶颈**。

> 实测基线（2026-09-30，本机 16 核 / 32 GB）：CPU 总负载 **2%**、可用内存 **17.2 GB**、
> C 盘可用 **76.3 GB**、物理磁盘活动 **2.5%**、磁盘队列 **0** ⇒ 资源充足。
> **CPU 与磁盘都空着却卡 ⇒ 不要往硬件上找，去查应用自己。**

## 2. 量数据规模

```bash
export PATH="/c/Users/Administrator/.workbuddy/vendor/PortableGit/usr/bin:/c/Windows/System32:/c/Windows:$PATH"
find /c/Users/Administrator/.workbuddy/projects -name '*.jsonl' \
     -printf '%s\t%TY-%Tm-%Td\t%p\n' 2>/dev/null | sort -rn | head
du -sm /c/Users/Administrator/.workbuddy/*/ 2>/dev/null | sort -rn
```

实测参考量级（2026-09-30）：`traces/` 1.4 GB / 730 个；`logs/` 539 MB（单文件最大 60.5 MB）；
`projects/` 317 MB / 467 个会话 / 19 个工作区，**单个最大 180.6 MB / 26,097 行**；
`binaries/` 724 MB、`app/` 147 MB（**别动**）。

## 3. ★「启动就慢 / 一直卡」的三大真凶（按命中率排序）

### 3.1 并行会话数 —— 每个会话 = 一组进程

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'WorkBuddy*' }
```
按 `--type=` 分类：`renderer` 的**个数 ≈ 打开着的窗口数**；
`main(无--type)` 里除 1 个应用主进程外，**其余基本是每个会话的 agent 进程**。

> 实测异常样本：13 个进程 = `renderer ×1`（**单进程 1.34 GB**）+ `main ×9` + gpu/utility/crashpad 各 1。
> **一个 renderer 吃 1.34 GB** 就是「界面全量 DOM 膨胀」的信号。

### 3.2 定时任务是「会话工厂」（最容易漏）

```text
automation_update(mode="list")
```
看 **ACTIVE + `FREQ=HOURLY`** 的任务个数与 `BYMINUTE`。
实测：**6 个每小时任务（:07 / :17 / :27 / :37 / :47 / :57）** ⇒ 约每 10 分钟拉起一个新会话 + 一组
agent 进程，用户感受就是「一直卡」。**先看任务，再怀疑别的。**

（本平台已知怪癖：`next_run = 本次完成时刻 + 55 分钟`，`BYMINUTE` 会被忽略 → 任务扎堆触发。
详见技能 `win-sandbox-scripting` §6.2。）

### 3.3 会话堆积

```bash
for d in /c/Users/Administrator/.workbuddy/projects/*/; do
  echo "$(ls -1 "$d"*.jsonl 2>/dev/null | wc -l)  $(basename $d)"
done | sort -rn
```

实测：工作区 `...-2026-09-18-19-34-22-dewu-kol` 里躺着 **444 个会话文件**（占全部 467 个的 95%，
合计仅 39.9 MB，平均 90 KB/个）；创建日期集中在 09-18 ~ 09-25，其中 09-19 一天 161 个，
且分布在**全部 24 个小时**（每小时 11~31 个）→ 典型的每小时定时任务产物。

> ★★ **踩过的坑（必须避免）**：`projects/<目录名>` 把 `C:\...\a\b` 编码成 `c-...-a-b`，
> 用 `-` 同时表示冒号和反斜杠，**而真实文件夹名里本身就含 `-`（如 `2026-09-18-19-34-22`）**
> ⇒ **目录名不可逆推**。我曾据此误判「真实目录已不存在」，实际路径是
> `C:\Users\Administrator\WorkBuddy\2026-09-18-19-34-22\dewu-kol`（存在，是活跃仓库）。
> **正确做法：读 jsonl 里每一行自带的 `cwd` 字段**：
> ```bash
> head -1 "<session>.jsonl" | python -c "import sys,json;print(json.loads(sys.stdin.read())['cwd'])"
> ```
> **不要用目录名反推工作区路径，也不要把「推不出来」写成「目录不存在」。**

### 3.4 ★ 并行会话「看不见」时去哪找

**用户看不到 ≠ 没在跑。** WorkBuddy 的会话列表**按工作区过滤**：同一块盘下不同的文件夹
= 不同工作区 ⇒ 你在 A 工作区里**根本看不到** B 工作区的会话在并行跑。

**定位法**（按「最近被写入」而非「最大」排，才能抓正在跑的）：
```bash
find /c/Users/Administrator/.workbuddy/projects -maxdepth 2 -name '*.jsonl' \
     -printf '%T@\t%TY-%Tm-%Td %TH:%TM\t%s\t%p\n' 2>/dev/null | sort -rn | head -12 \
  | awk -F'\t' '{printf "%s  %8.2f MB  %s\n", $2, $3/1048576, $4}'
```
再**隔 1 分钟重跑一次**：**两次 mtime 都在前进 = 真的在跑**（不是历史残留）。

实测：同一盘 `E:\WORKBUDDY\` 下三个工作区 `2026-09-30-17-35-35` / `-18-05-37` / `-17-58-51`
**三份会话全在同时写入**；用户在 `17-58-51` 的会话列表里**看不到**另外两个，
因为它们是**另外两个工作区**。⇒ 回答「哪个并行没看见」时必须给出**工作区路径 +
会话首条提问**，让用户能在界面上认出来（提取方法见 §4 末）。

### 3.5 ★ 周期性崩溃循环（最容易被误当成「整机卡机」）

「CPU / 内存 / 磁盘全都不紧张，却还是一阵阵卡」⇒ **去 Windows 事件日志找周期性崩溃**：

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application';ID=1000,1002;StartTime=(Get-Date).AddHours(-24)} |
  Where-Object { $_.Message -like '*<进程名>*' } | Sort-Object TimeCreated
```

**判据：同一个程序 24 小时内崩 N 次、且间隔高度一致** ⇒ 崩溃 → 看门狗重启 的死循环
（每次崩溃写转储 = 一次 CPU/磁盘尖峰）。

实测（2026-10-01）：`AweSun.exe`（向日葵远程控制）**02:44–10:59 共 34 次崩溃，间隔几乎恒为 16.2 分钟**，
异常码 `0xc0000005`（访问违例），配套 `awesun_guard`（看门狗，45 MB）在重启它。
⇒ 若用户是**经向日葵远程**操作这台机器，感受就是「每 16 分钟画面卡住 / 断开一次」。
（同期另有 2 次 `electron.exe` 崩溃 `0x80000003`，但仅 2 次、间隔无规律 ⇒ **不构成循环，别写进去**。）

**排除项也必须写出来**（本次实测）：CPU **1.4%**、物理内存可用 **10.37 GB（67% 已用）**、
提交 **25.50 / 39.03 GB**、**页面文件仅用 959 MB / 7,424 MB（峰值 1,022 MB）、PagesPerSec = 7**、
磁盘 `% Disk Time` **0.4%**、队列 **0**、无 2004(资源耗尽) / 41 / 6008 / 磁盘错误事件
⇒ **不是内存耗尽、不是换页、不是磁盘瓶颈。别把「卡机」归到内存上。**

> ⚠️ 「内存占用 68%」看着吓人，但**提交量与页面文件都宽松**就不叫内存压力。
> **判据看 `PagesPerSec` 与页面文件当前使用量**，不是看「已用百分比」。

### 3.6 ★★ 界面「完全卡死 → 自己消失」= 渲染进程崩溃 ⇒ 直奔 Crash-Log

**判据（用户原话）**：「点不了任何东西」「连思考过程都看不到」「自动卡退 / 弹回桌面」。
这类**别再去量 CPU / 内存**——那是查「慢」的方法。**直接读崩溃报告**，位置固定：

```
<USERPROFILE>\.workbuddy\logs\Crash-Log\crash-report-main-<pid>-<launchTs>.json
```

配套两个文件：
- `<USERPROFILE>\.workbuddy\logs\startup\startup-YYYY-MM-DD.log` —— 自动重启时刻（`=== Process started ===`）
- `<USERPROFILE>\.workbuddy\logs\AppStartup.log` —— `[AppStartup]` / `[WindowFocus]` / `[WindowBlur]` 事件流
- `<USERPROFILE>\.workbuddy\logs\update\update-YYYYMMDD.log` —— **自动更新是否被拦（见下）**

**判定三步**（缺一步都别下结论）：

1. 所有 WorkBuddy 进程的 `StartTime` 是否**集中在同一分钟** ⇒ 是**自动重启**（用户自己关的会散开）。
2. `entries[]` 里是否出现
   `"type":"renderer_crash"` + `"errorMessage":"Renderer process gone: reason=killed, exitCode=1"`
   ⇒ **界面进程被杀**。通常紧跟 `child_process_crash`(NetworkService) 与 `gpu_crash` —— 三连即全界面死亡。
3. 崩溃前是否有 `renderer_js_error` ⇒ **前端未捕获异常**，是**真 bug**，不是配置问题。

**实测（2026-09-18 ~ 10-01，本机共 12 份报告，可直接引用为基线）**：

| 项 | 实测 |
|---|---|
| `renderer_crash` | 13 次（**同一型**，每次死亡形态一致） |
| `child_process_crash`（NetworkService 陪葬） | 11 次 |
| `gpu_crash`（陪葬） | 10 次 |
| `renderer_js_error` | 19 条，**只有两类**：`Uncaught TypeError: Cannot read properties of undefined`、`ResizeObserver loop completed with undelivered notifications`、`blocks is not iterable` |
| **OOM / out of memory** | **全部报告中一处都没有** ⇒ 不是内存耗尽，别去加内存 |
| 退出码 | `reason=killed exitCode=1` **23 次**；`exitCode=1073807364`(0x40010004) 1 次 |

⇒ 结论必须写成「**客户端缺陷**」，**不是「你的机器不行」**。这类问题**本机修不了**，只能三条路：
① 减少并发会话 + 定期重启来**规避**；② **升级版本**；③ 把 `Crash-Log` 目录打包交给官方。

★ **配套必查：自动更新是否被拦**（最容易漏，漏了用户会白等新版）：
`update-YYYYMMDD.log` 里出现

```
[INFO ] [win32] Install dir guard: first-time warning
[WARN ] [win32] Update blocked by install dir guard
```

⇒ 用户被**钉在旧版本**，**即使官方在新版修了这个 bug 他也收不到**。这条必须写进交付并给出
「手动安装 / 换非受保护安装目录」的建议。
（实测本机装在 `C:\Users\Administrator\AppData\Local\Programs\WorkBuddy`，更新即被该守卫拦下。）

★ 顺带把「相关」和「因果」分开写：能证明的是「**崩溃时渲染进程已 2.49 GB / 连续运行 18.6 h**」，
**不能**断言「涨到 2.49 GB 必定崩」——除非做过对照复现。措辞上不要越界。

> **基线更新（2026-10-02，同机累计）**：`Crash-Log` 共 **14 份报告** ⇒ `renderer_crash` **15 次**
> （同一型 `reason=killed exitCode=1`）、`child_process_crash` 13、`gpu_crash` 12、`renderer_js_error` 24，
> **OOM 命中仍然是 0**。崩溃间隔**不规律**（9/21、9/22×2、9/24、10/1×2、10/2）⇒ 这**不是** §3.5 那种
> 「恒定间隔的崩溃循环」，别混为一谈。最近一次 `renderer_js_error` 是前端未捕获异常：
> `Uncaught TypeError: Cannot read properties of undefined (reading 'length')` at
> **`summarizeBlocks`（`connector-*.js`）** ⇒ 仍是**客户端缺陷**，本机修不了。
> 同时观测到那台机器的渲染进程已涨到 **3.14 GB**（`tasklist` 实测）——**只写观测，不写因果**。

## 4. 日志取证（主线程日志是金矿）

- `~/.workbuddy/logs/<当天>/workbuddyMainThread__*.log` —— 全局（状态迁移、连接器、市场扫描）
- `~/.workbuddy/logs/<当天>/<工作区名>__*.log` —— **每个会话一份**

**查「谁在忙」**：
```bash
grep -oE '"sessionId":"[a-f0-9-]+"' workbuddyMainThread__*.log | sort | uniq -c | sort -rn
```
**查「忙到什么程度、是否在加速」**：
```bash
grep -oE '^\[[0-9/]+ ([0-9]+:[0-9]+):' workbuddyMainThread__*.log \
  | sed -E 's/.* ([0-9]+:[0-9]+):/\1/' | sort | uniq -c
```
实测：50 分钟内 3 个会话共 **417 次** planning↔working 迁移，且**逐步加速**
（17:35 约 5 次/分钟 → 18:25 约 **25 次/分钟**）。

**查「有没有在反复做同一件重活」**（规范化后数重复行，最能暴露放大器）：
```bash
sed -E 's/^\[[0-9/]+ [0-9:. ]+\] //' <会话日志> | sed -E 's/[0-9]+/N/g' | sort | uniq -c | sort -rn | head -15
```
实测命中：`McpManager.list: starting (scope=all)` ×95、`MarketplaceStorage.getMarketplaces` ×85、
`getConnectedServers()` ×73 —— **主线程在反复全量扫市场 / 连接器**。
本机配了 **250+ 个 connector**，每次全量扫描都很贵 ⇒ 这就是「CPU 不高但界面一直顿」的典型机制。

**查「卡在哪一分钟」**（把「慢」落成具体时刻，最有说服力）：

```bash
# ① 会话切换风暴：AppStartup.log 里同一秒内连发多条 [SessionSwitch]
grep -c 'SessionSwitch' /c/Users/Administrator/.workbuddy/logs/AppStartup.log
# ② 新进程冷启动（整套 MCP 全量扫 / LSP / 插件首载）——它一起来就卡
grep -E '\[Startup\]|\[FirstScreen\]|McpManager\.list: starting' "logs/<日期>/<工作区>__*.log" | tail -20
```

实测（2026-10-02 12:08）：`AppStartup.log` 里 **1.3 秒内连发 12 条 `[SessionSwitch]`（同一个 sessionId）**，
同时段日志里新 agent 进程正在冷启动（`[Startup] McpManager.list: starting (scope=all)`、
`LSPManager initialized`、`PluginPolicyService ... loadPolicies for the first time`、
`HotReload cwd changed ... rebinding watchers`）⇒
**冷启动风暴 + 会话视图反复重建 = 用户看到的「卡住不动 / 点不了」**。

**噪声**：`[Warning] enterpriseId is missing, skipping models API call` 属正常，不是故障。

**从 jsonl 认出「这个会话在干什么」**（`.jsonl` 每行一个 JSON，结构实测如下）：

| 字段 | 取值 |
|---|---|
| `type` | `message` / `reasoning` / `file-history-snapshot` |
| `role` | `user` / `assistant` |
| `content[].type` | `input_text` / `output_text` / `reasoning_text` |
| `timestamp` | **毫秒**（>1e12 要 /1000 才是秒） |
| `cwd` | **工作区真实路径**（※ 反推目录名不可靠，见 §3.3） |

真实用户提问被包在 `<user_query>…</user_query>` 里；`<system-reminder>` 开头的是注入上下文，
**不是用户说的话**。⇒ 取标题 = 在 `role=='user'` 的文本里正则抓 `<user_query>`：

```python
import io, json, re
def first_query(path):
    with io.open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try: o = json.loads(line)
            except Exception: continue
            if not isinstance(o, dict) or o.get('type') != 'message' or o.get('role') != 'user':
                continue
            texts = [b.get('text','') for b in o.get('content', [])
                     if isinstance(b, dict) and b.get('type') in ('text','input_text')]
            m = re.search(r'<user_query>\s*(.*?)\s*</user_query>', '\n'.join(texts), re.S)
            if m: return m.group(1)
    return None
```

### ⚠️ 取证陷阱：别把「提示词里的引用」当成「真实输出」

2026-10-01 亲手踩到：分析守候类定时任务的会话时，我在 jsonl 里 grep
「设备 PC-01 尚未授权接单」「已有监听器在运行」，**两个都命中了**，差点写成
「守候了一整夜但没接单，等于白跑」的结论。

**其实那是 prompt 正文里的说明性文字被原样记进了会话**（每个会话各命中 1 次 =
提示词各引用 1 次）。**真实工具输出里，这两个词一次都没出现。**

⇒ **必须按角色分流统计**，不能直接对整个文件 grep：

```python
is_prompt = (o.get('role') == 'user' and '<user_query>' in blob)   # 提示词原文
prompt_hits, real_hits = {}, {}                                     # 分开计数
```

分流通计后的真相：真实输出里只有「守候结束」与轮次计数（`第 N/7 轮`）。
**结论：脚本一直正常，7 轮全跑满** —— 与 grep 直方图给出的印象完全相反。

> 同一条铁律的通用形式：**在「我自己写的提示词」也存在于记录里的场景中，
> 任何字符串统计都必须先做「谁说的」分流**，否则提示词会污染一切证据。

## 5. 出结论时的正确姿势

- **分档归因**：① 资源不足（罕见，先排除）；② **并行会话 + 定时任务**（最高频）；
  ③ 单会话过大（渲染成本）；④ 应用状态累积（进程数、长时间未重启）。
- **必须反问「卡在哪一步」**：打开旧会话 / 打字发消息 / 切工作区 / **启动就慢 / 一直卡**。
- **说清代价**：清 `traces/` + 旧 `logs/` **只回收磁盘**，磁盘没满时对「卡」几乎没帮助；
  解决单个大会话卡顿的**只有「开新会话」**（换工作区不管用）。
- **推测必须标成推测**：本机 `HipsDaemon` / `HipsTray`（火绒 HIPS）在跑、Windows Defender 已关。
  HIPS 实时拦截会拖慢文件与进程操作，**能解释「CPU/磁盘都空却卡」，但本次未做 A/B 实测**
  ⇒ 只能写成「候选原因 + 可验证做法（加入排除目录后对比）」，不要写成结论。

## 6. 安全边界

`~/.workbuddy` 在**家目录**下 ⇒ 按个人目录处理：**先扫描、只出清单，得到明确确认再动手**；
优先「**移动到备份目录**」而非直接删除。
**绝对不要动**：`binaries/`、`app/`、`vendor/`、`workbuddy.db*`、`settings.json`、会话状态文件。
**定时任务只能由用户确认后、通过 `automation_update` 改**，不要自己动。

## 7. 修复优先级（实测有效顺序）

0. **★ 先分清是「慢」还是「崩」**：用户说「点不了 / 自动卡退」⇒ 直接走 **§3.6**，
   **别先去量资源**（量完也解释不了崩溃，会白跑一轮）。查到 `renderer_crash` 就明确告知：
   **这是客户端缺陷，本机修不了**，只给「规避 + 升级 + 报官方」三条路。
1. **只留 1 个会话**，关掉其余窗口（立刻见效）。
2. **降频 / 合并定时任务**：6 个每小时任务 → 1 个（会话产出从 6/小时降到 1/小时）。**见 §7.1**。
3. **完全退出重启**（不是最小化；确认进程清零）。渲染进程内存 **>1500 MB 就该重启**。
4. 归档老会话与老缓存（约 2 GB，属「清理」不属「提速」）。
5. 换新会话前先写**交接单**，别把上下文留在旧会话里。

**★ 交付给用户时要顺带做的一件事（实测有效、成本极低）**：
把当前会话的 jsonl **导出成离线 Markdown**。用户说「历史记录看不到了」时，
先验证 jsonl 完整性（逐行 `json.loads`，报「行数 / 损坏行数 / 是否以换行结束」），
**数据没丢就给证据 + 顺手导出**，这比解释一百句都管用。

★ **如果崩的不是当前会话、而是用户刚在用、界面上已经点不开的那条** ⇒ 走技能
**`session-crash-recovery`**（怎么认出「刚崩的那条」、解析 jsonl 的三个坑、
`conversation_history_summary` 现成交接单、以及「把已做完的待办从待办清单里摘掉」）。

### 7.1 ★ 合并「每小时守候型」定时任务的正确做法

**最大的坑：合并 ≠ 把 6 条删成 1 条。** 错开的多条任务（:07/:17/…/:57）本质是**接力覆盖**：
每条跑 54 分钟、每 10 分钟起一条 ⇒ 全天连续无缝隙。
**直接砍成 1 条，每小时会露出约 6 分钟空窗**（守候类任务漏掉的正是「用户刚点下的请求」）。

⇒ 合并时**必须把单条任务的守候时长补到 ≥60 分钟**：
本次把「6 次 × `--budget=9` = 54 min」改成 **「7 次 × 9 min = 63 min」**。

标准流程：

1. `automation_update(mode="list")` → 找出 **ACTIVE + `FREQ=HOURLY`** 的全部条目，记下 id 与 `BYMINUTE`。
2. **逐条 `mode="view"` 核对 prompt 是否逐字一致**（只差 `BYMINUTE` 才可安全合并）。
   ※ 别拿「名字像」当依据 —— 本次 6 条实测 prompt 完全一致，才动手。
3. **就地改造其中 1 条**（优先留最早创建的那条，保住血缘），而不是新建：
   改 `name`（标注「合并版」）、改 `prompt`（重复次数提到覆盖 ≥60 min）、
   `rrule` 保留原 `BYMINUTE`、`status=ACTIVE`。
4. **其余各条置 `status=PAUSED`，不要删** —— 暂停可一键还原，删了要靠客服。
5. **回读 `mode="list"` 验收**：ACTIVE 的每小时任务**只剩 1 条**，其余全 PAUSED；
   并把「合并前 N 条 / 合并后 1 条」写成可核对的前后对比。

**必须一起交付的代价说明**（写清，别藏）：
- **冗余度下降**：原来 6 条互为备份，某条挂掉还有别的顶；现在仅 1 条，
  中途异常就**要等到下一个整点才恢复**。
- 单次 turn 若有时长上限，63 分钟可能被截断 ⇒ 观察首个整点的实际执行时长再决定是否回调。
- 合并后 `cwds` 回读会变成正斜杠（`C:/Users/...`），属正常规范化，不是故障。

**★ 合并后第 1 天的实测（2026-10-01，必须照此回检并写进交付）**：

| 检查项 | 实测 | 判定 |
|---|---|---|
| 单次是否跑满 7 轮 | **65.7 / 66.0 / 65.6 / 65.9 分钟** | ✅ 7×9min 成立，**未被 turn 时限截断** |
| 轮次完整性 | 会话回复「7 轮均正常接替守候至预算用尽」 | ✅ 达标 |
| **实际触发间隔** | **~121 分钟**（04:29 结束 → **05:24** 下一次） | ⚠️ **不是 1 小时** |

**⇒ 关键坑在这里**：平台 `next_run = 完成时刻 + 55 分钟` ⇒ **66 + 55 = 121 分钟一轮**，
**覆盖率只有 66/121 ≈ 55%，每 2 小时露出约 55 分钟无人守候**。

所以「合并成 1 条每小时任务」**根本达不到原来的全天连续覆盖**。要真正无缝，只有三条路：
① 单次时长拉到 **≥115 分钟**（`--budget` 或次数加大）；
② 保留 **2 条错开**（如 `:07` 与 `:37`）互相补位；
③ 改成**常驻进程**（守护进程 / 计划任务），而不是每小时触发的会话。

**这一步必须在动手合并前就跟用户讲清并让他选**，别合完了才说覆盖掉了。
