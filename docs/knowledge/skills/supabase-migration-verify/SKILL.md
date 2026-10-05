---
name: supabase-migration-verify
description: 用「anon 实测」判定 Supabase/PostgREST 项目里某个 migration 到底跑没跑、某条 RLS/授权到底生效没生效，并把需要用户手跑的 SQL 可靠地交到他手上。当出现「这个 migration 跑了吗」「怎么确认数据库里有没有这个函数/列」「我发你的 SQL 在附件里看不到」「跑完自检返回 true 是什么意思」「关掉 anon 对某函数的执行权」「这条 RLS 策略真的在拦吗」「重复插入会不会长重行/幂等到底生效没」，或要给项目加一条「迁移落地状态核对」的检查时使用。含：可复用的只读探针脚本模板 + 判定表（404 / 401 / 200 / 400 各代表什么）、`information_schema` 会「假绿」的坑、PostgREST 按「函数名+参数名」匹配导致**把「跑过」误判成「没跑」**的坑、用 anon 验 insert/update/delete 权限的**正反向对照法**（只做负向＝假通过；测写权限前必须先造一行匹配记录）、以及 `Prefer: resolution=ignore-duplicates` **必须配 `on_conflict` 才生效**（否则 409，客户端会卡死）的坑，最后是把 SQL 交到用户手上的正确姿势（正文内联 + Markdown 合集）。
agent_created: true
---

# Supabase 迁移落地状态核对 + SQL 交付

## 何时用

- 用户问「这个 migration 到底跑了没有」——**别猜、别只看本地文件在不在**。
- 你写了 `revoke` / `grant` / RLS 类脚本，要确认**权限真的生效了**（而不是「SQL 执行成功」）。
- 用户说「你发我的 SQL 我在附件里看不到」——这是**交付通道**问题，不是文件问题。

---

## 一、权威判定：用 anon 实测，**不要**用 `information_schema`

### 为什么 `information_schema` 会假绿

PG **新建函数的默认权限是「PUBLIC 可执行」**。于是：

| 自检写法 | 假绿方式 |
|---|---|
| 数 `information_schema.routine_privileges` 里 `grantee='anon'` 的**行数** | 该视图只显示**显式**授权。`revoke ... from public` 若没生效，anon 照样能调，而行数**仍然是 0** → 打印「通过」 |
| 同上 | 它**完全没查 `authenticated`**。`grant ... to authenticated` 失败 → 功能彻底不可用，自检照样「通过」 |

**权威做法**：`has_function_privilege('<role>', <oid>, 'EXECUTE')` 会把「PUBLIC 继承」「角色成员关系」一起算进去，得到的是「**实际**能不能执行」。或者更硬 —— **直接以 anon 身份打一次 RPC**。

### 判定表（`POST /rest/v1/rpc/<fn>`，用 anon key）

| 返回 | 含义 |
|---|---|
| `404` + `Could not find the function` | 函数**不存在** → 对应 migration 没跑 |
| `401` / `403` / 含 `42501` | 函数**存在**且 anon **无权** → revoke 生效 ✅ |
| `200` + 返回值 | 函数存在且 anon **可执行** → revoke **尚未生效**（这才是要修的） |
| `400` | 函数存在（只是参数/取值被拒）—— 也算「存在」 |

结构类 migration 用**列探测**：
`GET /rest/v1/<表>?select=<列>&limit=1` → `200` 存在 ／ **`400` + `42703`** 不存在。

### ⚠️ 两个会把「跑过」误判成「没跑」的坑

1. **PostgREST 按「函数名 + 参数名」匹配** —— 参数名猜错，**照样返 `404 Could not find the function`**。
   ```
   create or replace function public.perm_rank(p text) ...        -- 参数就叫 p
   ```
   POST `{"p_email":"x"}` → 404（假「不存在」）；POST `{"p":"x"}` → 200（才对）。
   ★ 最危险的是**同批函数里一真一假**：`can_edit_module(p_key text)` 我猜对了返 200，
   `perm_rank` 猜错返 404 —— 两个矛盾结论并排输出，极易蒙过去。
   **规训：报「函数不存在」之前，必须先回读 `create or replace function` 原文取签名。**
2. **DB 列名 ≠ 前端/文档里的字段名**。曾有前端叫 `owner` 的字段，真列名是 `added_by`
   （migration 文件名叫 `..._excl_owner.sql`，误导）→ 报「列不存在」，差点误判 migration 没跑。
   **规训：报「列不存在」之前，回读 migration 原文的 `add column` 语句。**

### 写权限探测：**先造一行匹配记录**，否则探针无效

PostgREST 的 `PATCH` **必须带 filter**，否则返 `400 UPDATE requires a WHERE clause`（这跟权限无关）。
补上 `?id=eq.<不存在的 id>` 之后，又常常先被 **identity column** 校验挡住（`400 428C9`）。

★ 更根本的问题：**表里没有任何匹配行时，「改了 0 行」是「空==空」，什么都证明不了** ——
不管策略给不给，结果都是 0 行。**如实记「未验证」，不许当成「写被允许/被拒」。**

**正确做法（用 anon 就能做，2026-10-02 实测有效）**：

1. 先用 anon **插入 1 行自带标识的探针**（如 `machine_id='__probe__conn__'`、`machine_name='⚠ 探针（可删）'`、`ts=0`）；
2. 再拿这行去做 `PATCH` / `DELETE`，filter 正好匹配它 ⇒ 此时「0 行」才真的说明「没权限」；
3. **复核**：`GET` 读回该行，确认字段**真的没被改**、行数**真的没少**；
4. 收尾把 `delete` 交给用户 —— anon 通常删不掉，**而这正是要验的结论**。

### ★ insert 策略：只做负向＝假通过

`POST` 一行**错 org / 错角色的数据**被拒（`401/403 + 42501 row-level security policy`）**不能**证明策略在按值校验：
「谁都插不进去」（缺 grant、压根没策略）给的是**同一个错误码**。
**必须再做一次正向** —— 用**正确的值**插一行，返 `201` 才算证明策略**按值区分**。

★ 旁证技巧：被 RLS 拒的插入**会消耗 identity 序列** —— 探针行拿到 `id=2` 而不是 1，
说明它**走到了 `with check` 才被拒**，不是卡在权限层。

### ★★ `Prefer: resolution=ignore-duplicates` **单独给不生效**（必须配 `on_conflict`）

一个**会让人以为已经做了幂等、实际没有**的坑：

| 请求（全部是对**已存在**的行重复插入） | 结果 |
|---|---|
| `POST /rest/v1/<表>` + `Prefer: return=minimal,resolution=ignore-duplicates` | **409** + `23505`；响应里**没有** `preference-applied` ⇒ 偏好没被应用 |
| `POST /rest/v1/<表>?on_conflict=<唯一索引的列>` + **同样的头** | **201** ✅ `preference-applied=resolution=ignore-duplicates, ...` |
| `?on_conflict=<主键>`（而冲突发生在别的唯一索引上） | **409** |

⇒ 判据：**`on_conflict` 的列必须与真正冲突的唯一索引一致**；
**响应头里有没有 `preference-applied`，就是「偏好到底生效没有」的凭据**（别只看请求头写了什么）。

**为什么值得单独记**：客户端一旦把这种「幂等失败」当普通错误、且**不推进游标**，
重试批就会永远撞同一行 ⇒ **同步永久卡死**（不是一次失败）。而「插入成功但响应超时」这种情形，
**网络越差越容易踩**。

**修法（两处，缺一不可 —— 2026-10-02 实测）**：
1. **请求侧**补上 `?on_conflict=<唯一索引的列>`（正常路径由服务端静默去重）；
2. **客户端容忍**这种冲突：整批 409 时**逐行重发**（已存在的跳过、新行补上），而不是整批判失败
   （整批放弃＝丢新行；整批判失败＝上面那个永久卡死）。
   ★ 容忍的判据**只认 `409 + 23505`** —— `409 + 42P10`（没有匹配的唯一约束）必须照旧报错，
   否则会把真配置错误当「已存在」吞掉 ⇒ **静默丢数据**。

★★ 一个反直觉但实测确凿的点：**只做 ② 不做 ① 也能不卡死**
（整批 409 → 逐行也 409 → 全被当「已存在」跳过 → 反而「成功」）。
⇒ **真正救命的那一半是「兜底」，不是 `on_conflict`**；① 决定的是正常路径要不要多花 N 次请求。
两条都要做。
★ 回归要**分两条断言**焊住：**请求形状**（URL 里真有 `on_conflict=…`）+ **行为**（喂 409 回包后游标必须前进）。
只写形状断言 ⇒ 兜底被删了照样全绿；只写行为断言 ⇒ 少了 `on_conflict` 也照样全绿（被兜底救回）——
这就是「一处缺陷多条防线，只拆一条假绿」在幂等场景的具体样子。

### 唯一索引的真凭据：让数据库自己说

裸重复插入（**不带**任何 resolution 头）→ `409 + 23505 + duplicate key value violates unique constraint "<索引名>"`。
索引不暴露在 REST 层，这是唯一能拿到**索引名**的途径。

### 探针脚本模板（只读）

```python
# 凭据：anon key 用于「模拟未登录者」；service key 用于读结构/数据（若 RLS 对 anon 隐藏）
cfg = io.open('deploy/config.js', encoding='utf-8').read()
URL  = re.search(r'SUPABASE_URL:\s*"([^"]+)"', cfg).group(1)
ANON = re.search(r'SUPABASE_ANON_KEY:\s*"([^"]+)"', cfg).group(1)

def call(key, path, body=None, method=None):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    r = urllib.request.Request(
        URL + path, data=data, method=(method or ('POST' if data else 'GET')),
        headers={'apikey': key, 'Authorization': 'Bearer ' + key,
                 'Content-Type': 'application/json', 'Accept': 'application/json',
                 'Prefer': 'return=representation'})
    try:
        resp = urllib.request.urlopen(r, timeout=60)
        return resp.status, resp.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace')

def anon_rpc(fn, body):
    st, txt = call(ANON, '/rest/v1/rpc/' + fn, body)
    low = txt.lower()
    if st == 404 or 'could not find the function' in low:
        return '❌ 不存在（migration 未跑）'
    if st in (401, 403) or '42501' in txt or 'permission denied' in low:
        return '✅ 存在 · anon 不可执行（revoke 生效）'
    if st == 200:
        return '⚠️ 存在 · anon 可执行（待 revoke）'
    if st == 400:
        return '✅ 存在（只是参数/取值被拒）'
    return '? 未知'
```

**探测时一律用一个「肯定不存在」的 id**（如 `9223372036854775807`），别碰真实数据。

### ⚠️ 「故意保留」别被自动化标签带偏

给探针加自动标签时，注意**有些函数对 anon 可执行是设计要求**：
RLS 策略是以**查询者身份**求值的，所以 `can_write()` / `is_member()` / `is_admin()` / `my_role()`
这类被 RLS 调用的函数**必须**让 anon 可执行 —— 收掉会**掐断整库读取**。
脚本里给它们打「⚠️ 待 revoke」是**误导**，报告里别把它们列进「待修」。

---

## 二、把 SQL 交到用户手上

### 症状
用户说「你发我的 SQL 在附件里一个都看不到」。

### 定性（先别怀疑文件）
**先确认文件都在**（sha / 字节数可复算），再说通道。然后**如实排序可能原因**，
因为你看不到用户客户端的附件列表：

1. 客户端设置里的「**产物回传到小程序**」开关未开 ⇒ 一关则**所有**附件都到不了（含 png/md）；
2. `.sql` 属**不可预览类型**，被客户端过滤。客户端**明确**支持内联渲染的是 **Markdown**。

### 对策（不依赖任何开关）
1. **正文里内联** ` ```sql ` 代码块 —— 这是唯一 100% 可达的通道，**必做**；
2. 同时打包一份 **Markdown 合集**（`.sql` 附件不作为唯一手段）。

### 合集生成器的两个硬要求
- 写文件时 `io.open(p,'w',encoding='utf-8', newline='')` 并**断言 `CR == 0`**
  （Windows 下 `newline=None` 会把 `\n` 翻成 `\r\n`，污染整个文件）。
- **顺序用显式列表，别用 `os.listdir` / `sorted` 的字母序**
  （会把 `revoke_public_exec.sql` 排到 `migration_15` 之后，与指南表格的 1/2 编号对不上，
  读的人会以为跑错顺序）。
- 生成完**必须做保真校验**：从 md 里正则解析出每段，与源文件**逐字节 + sha 比对**，
  输出「收录 N / 一致 N / 漏收 0」。别靠肉眼。

```python
blocks = re.findall(r'#### `([^`]+)`\n\n(.*?)\n\n```sql\n(.*?)\n```', md, re.S)
src = io.open(path).read().rstrip('\n')
assert src == body      # 逐字节
```

---

## 三、回报里必须写清的三件事

1. **哪些已跑、哪些没跑** —— 逐项给出**实测证据**（HTTP 码 / 返回值），不是「应该跑了」。
2. **哪些是「故意保留」** —— 避免用户以为漏修。
3. **哪些没测出来** —— 例如无效探针，明说「未验证」，不许糊过去。
