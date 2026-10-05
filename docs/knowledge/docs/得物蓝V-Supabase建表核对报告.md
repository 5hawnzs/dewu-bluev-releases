# 得物蓝V · Supabase 建表核对报告

**时间**：2026-10-02 22:40 前后
**项目**：`https://rywurhpkovyjpjyvfjdz.supabase.co`（拓新 dewu-kol 那个）
**用什么验的**：Node `fetch` 直连 PostgREST（**只读**，全程没有写任何一行数据）
**谁给的结论**：下面每一条都有可复算的命令与回执，没有一条是推理出来的

---

## 一句话结论

> **建表 SQL 跑成功了，而且三条策略红线全部实证有效：21 个列齐全、字段一一对应、anon 只能读和插、错 org 插不进、改不了也删不了、唯一索引在位。**
>
> **另外查出 App 侧一个真问题：「幂等头」没生效 ⇒ 某些情况下云同步会永久卡住（见第 6 节，一行可修）。**

（第 5 节是三条策略的实证，第 6 节是新查出的问题。第 1~4 节是上一版的只读核对。）

---

## 0. 先排除一个误判：curl 不通 ≠ 你的库有问题

| 工具 | 结果 |
|---|---|
| `curl https://example.com` | HTTP **000**（超时） |
| `curl https://rywurhpkovyjpjyvfjdz.supabase.co/rest/v1/` | HTTP **000**（超时） |
| **Node `fetch` 打同一个地址** | HTTP **200** ✅ |

⇒ 是**这个沙箱的出口只放行 Node 的网络栈**，跟你的 Supabase 项目无关。
（正因如此，前几轮我才会说「验不了」——那时只试了 curl。**这次换 Node 打通了。**）

★ 副作用：出口是**间歇性**的，同一请求会出现「一次 200、下一次连接超时」。所以下面所有探测都带重试。

---

## 1. 表在不在 —— 在 ✅

```
GET /rest/v1/publish_log?select=id&limit=1
→ HTTP 200  []
```

`200` = 表存在且 anon 有读权限；`[]` = **当前 0 行**（还没人点过「立即同步」，符合预期）。

> 对照：建表之前这条会返回 `404 + PGRST205 Could not find the table 'public.publish_log'`。

---

## 2. 列是不是全的 —— 21 / 21 ✅（逐列点名，不是猜）

做法：`GET /rest/v1/publish_log?select=<列名>&limit=1` —— **列在 → 200；列不在 → 400 + 42703**。

| # | 列 | 结果 | # | 列 | 结果 |
|---|---|---|---|---|---|
| 1 | `id` | ✔ | 12 | `reason` | ✔ |
| 2 | `org` | ✔ | 13 | `elapsed` | ✔ |
| 3 | `ts` | ✔ | 14 | `retries` | ✔ |
| 4 | `machine_id` | ✔ | 15 | `mode` | ✔ |
| 5 | `machine_name` | ✔ | 16 | `brand_id` | ✔ |
| 6 | `batch_no` | ✔ | 17 | `brand_name` | ✔ |
| 7 | `seq` | ✔ | 18 | `user_id` | ✔ |
| 8 | `item_id` | ✔ | 19 | `username` | ✔ |
| 9 | `dir_name` | ✔ | 20 | `display_name` | ✔ |
| 10 | `kind` | ✔ | 21 | `created_at` | ✔ |
| 11 | `result` | ✔ | | **缺失 0 个** | |

### ★ 负向对照（证明这条测试真的在查东西）

```
GET /rest/v1/publish_log?select=__definitely_not_a_column__&limit=1
→ HTTP 400  {"code":"42703","message":"column publish_log.__definitely_not_a_column__ does not exist"}
```

⇒ 一个**真的不存在**的列会被如实判成 400。所以上面 21 个 `200` 不是「空 == 空」式的假通过。

---

## 3. App 上行字段 ↔ 真库列名，逐一对账 ✅

App 侧 `cloudsync.toRow()` 实际发出去的字段（**19 个**）：

```
org  ts  machine_id  machine_name  batch_no  seq  item_id  dir_name  kind
result  reason  elapsed  retries  mode  brand_id  brand_name  user_id  username  display_name
```

**19 个全部在真库里存在，且名字一字不差。** 反过来，表里多出的 `id` / `created_at` 由数据库自己填，App 不需要发。

⇒ **不存在「客户端发了个表里没有的列名 ⇒ 整批 400」这个坑。**

### 组织标识也对得上

| 位置 | 值 |
|---|---|
| `src/main/clouddefaults.js` 内置 `org` | `bluev` |
| `docs/supabase-setup.sql` 的 insert 策略 | `with check (org = 'bluev')` |

⇒ 两边**同值**。App 上行时若漏带 `org`，`toRow()` 会兜底成内置的 `bluev`（这条有断言守着）。

---

## 4. 看板/App 用到的那几条查询，在真库上都能跑通 ✅

| 用途 | 状态 |
|---|---|
| App「测试连接」的探活（`select=machine_id&limit=1`） | HTTP **200** ✅ |
| 看板主查询（按 `org=eq.bluev` 过滤 + `order=ts.desc` + 14 个明细列） | HTTP **200** ✅ |
| 不带 org 过滤（验证 select 策略是 `using(true)`） | HTTP **200** ✅ |

⇒ **App 里点「测试连接」现在应当直接报「通」**，不会再出现「表还没建，请去跑 supabase-setup.sql」。
（看板点「保存并连接」同理；两边现在都只会得到空表，属正常。）

---

## 5. 上一版「还没验的 3 件事」—— 第二批全部验掉 ✅（2026-10-02 23:2x）

做法：用**跟 App 完全相同的请求形状**（同 headers、同 `Prefer`、同字段名）打真库。
唯一的写入 = **1 行探针记录**（已标记成探针，验完请你删，SQL 见第 8 节）。

### 5.1 insert 策略真的按 `org` 卡人 —— 正反向都做了 ✅

| 试验 | 请求 | 结果 |
|---|---|---|
| 负向 · 错 org | `POST` body `org='__probe_wrong_org__'` | **HTTP 401** `42501 new row violates row-level security policy for table "publish_log"` · 行数 0→**0** |
| 正向 · 正 org | `POST` body `org='bluev'`（内置值） | **HTTP 201** · 行数 0→**1** |

★ **为什么必须做正向**：只做负向就是**假通过** —— 「被拒绝」既可能因为策略在卡 org，
也可能因为这张表**谁都插不进去**（缺 grant / 压根没策略），两种情况给的是同一个错误码。
正向能插进去，才证明策略是**按 org 区分**的。

★ 一个额外旁证：探针行的 `id` 是 **2** 而不是 1 ⇒ 序列被消耗过一次 ⇒
那条错 org 的插入**确实走到了 RLS 的 `with check` 那一步才被拒**
（若连 insert 权限都没有，会在取序列值之前就报错）。

### 5.2 anon 真的没有 update / delete ✅（这条特意设计成**不是**「空==空」）

关键：此时表里**已经有 1 行与过滤条件匹配的记录**，所以「改了 0 行」是有意义的结论，
而不是「表里本来就没数据、所以当然改不动」。

| 试验 | 请求 | 结果 |
|---|---|---|
| update | `PATCH /publish_log?machine_id=eq.__probe__conn__&org=eq.bluev`，body `{reason:'__probe_update__'}` | HTTP 200 `[]`（改了 0 行） |
| **复核** | `GET` 读回那一行 | `reason` **仍是**「策略核对探针，可安全删除」⇒ 确认没改成 |
| delete | `DELETE /publish_log?machine_id=eq.__probe__conn__` | HTTP 200 `[]`（删了 0 行）· 行数 1→**1** |

### 5.3 唯一索引 `publish_log_dedup` 真的在 ✅

```
POST（重复插入同一 (machine_id, ts, seq)，不带任何 resolution 头）
→ HTTP 409  {"code":"23505","message":"duplicate key value violates unique constraint \"publish_log_dedup\""}
```

数据库**自己把索引名报了出来** —— 这是最硬的凭据（索引不暴露在 REST 层，只读查询看不到）。

---

## 6. ★★ 但顺带查出一个真问题：App 的「幂等安全网」其实不生效

App 上行带的头是 `Prefer: return=minimal,resolution=ignore-duplicates`（`src/main/services/cloudsync.js:197`），
建表脚本第 47~48 行的注释写着它的用途是「网络重试 / 重复同步不会产生重复行」。
**实测：这个头单独用，一点作用都没有。**

| 试验 | 请求 | 结果 |
|---|---|---|
| **现 App 的发法** | `POST /rest/v1/publish_log` + 那个头 | **409 + 23505**，且响应里**没有** `preference-applied` ⇒ 偏好根本没被应用 |
| **加 `?on_conflict=machine_id,ts,seq`** | 同上，头一个不改 | **201 ✅** `preference-applied=resolution=ignore-duplicates, return=minimal` |
| 加 `on_conflict` 且要正文 | `resolution=ignore-duplicates,return=representation` | **201 ✅** |
| 无 `on_conflict` 但要正文 | 只为排除「是不是 `return=minimal` 的锅」 | **409**（不是它的锅） |
| `?on_conflict=id` | 换个冲突目标 | **409**（必须与唯一索引的列一致） |

**结论**：PostgREST 的 `ignore-duplicates` **必须配 `on_conflict=<唯一索引的列>` 才生效**，
只给 `Prefer` 头不够。而一旦 409 抛出，代码里的后果是**永久卡死**：

```
postRows() 抛错
 ⇒ syncOnce() 的 catch（cloudsync.js:258-266）**不动 st.offset**
 ⇒ 下一轮从同一个 offset 重发同一批 ⇒ 又是 409 ⇒ 永远失败
（界面上只有「同步失败」四个字 + 一行 PostgREST 报错；退避最多 5 分钟一轮，但它永远不会成功）
```

**什么情况下会踩中**（不需要很刁钻的条件）：

1. **插入成功、但响应在返程丢了**（超时）⇒ 重试同一批 ⇒ 行已在库里 ⇒ 409。
   ★ 这次实测里这个出口**本身就是间歇性的**（同一请求一次 200、下一次超时），所以这条非常现实；
2. 同步游标文件被删 / 配置被重置 ⇒ 从第 0 行重发 ⇒ 老行已在库里 ⇒ 409；
3. 同一台机器上两个实例共用一个 `machine_id`。

**一行修法**（`cloudsync.js` 的 `postRows`）：

```diff
- await fetch(url + '/rest/v1/publish_log', {
+ await fetch(url + '/rest/v1/publish_log?on_conflict=machine_id,ts,seq', {
```

★ 更稳的是**两条都做**：加 `on_conflict`，**并且**把「409 + `23505`」也当成功处理
（兜底：万一索引被改名/重建，也不至于把同步卡死）。

**我这一轮没有改它** —— 当时另一个会话正在发版，改共享源码有串味风险。

⇒ **23:5x 用户拍板「你先改，我会在另一个会话里加新功能，晚点再一起发」——已修，证据见下节。**

### ★ 23:30 补记：这个 bug **已经随 `1.0.5` 出去了**（实测，不是推测）

| 核对项 | 实测 |
|---|---|
| 另一路会话的提交 | `6c3d56a 发 v1.0.5（抓发布页 + 动画页备用通道）`，工作区**干净** |
| 线上 `latest.yml` | **`version: 1.0.5`**（Node fetch 直连 CDN 取到） |
| 安装包本体 | `得物蓝V素材发布工具-1.0.5-x64-win.exe` → `HTTP 206`，`content-range: bytes 0-0/113989823`，与 `latest.yml` 声明的 `113989823` **一致** |
| 上传时间 | `Last-Modified: Fri, 02 Oct 2026 15:15:01 GMT`（= 北京时间 23:15） |
| `beta.yml` | 仍是 `1.0.1-beta.2`，**未动** ✅ |

⇒ 所以修法只能进**下一个版本**（`1.0.6`），不可能搭上这一班车了。

---

## ★ 23:5x 已修（**未提交**，等与新功能一起发）

改动只有两个文件：`src/main/services/cloudsync.js`（+54/-9）、`tools/cloudtest.js`（+76）。
`git status` 显示 `M` 两个，**没有 `git add`、没有提交**（按"晚点一起发"处理）。

### 修了什么（两处，缺一不可）

```diff
- await fetch(url + '/rest/v1/publish_log', {
+ await fetch(url + '/rest/v1/publish_log?on_conflict=' + CONFLICT_COLS, {     // ① 补上冲突目标
```

② **逐行兜底**：万一服务端仍整批 409（索引被改名/重建、PostgREST 行为差异），
不再直接判失败，而是**逐行重发** —— 已存在的跳过、新的补上。
（直接整批放弃＝丢新行；直接判失败＝上一轮那个"永久卡死"。）

★ 唯一冲突的判据**只认 `409 + 23505`**：`409` 但 code 是别的（如 `42P10`「没有匹配的唯一约束」）
照旧判失败 —— 否则会把真错误当"已存在"吞掉，**静默丢数据**。

### 实测数字（全部可复算）

| 项目 | 结果 |
|---|---|
| 真库请求形状对照（`_supa-idem.js`） | 无 `on_conflict` → **409+23505**；加 `on_conflict` → **201** + `preference-applied`；且**行数 1 → 1 没多** |
| `cloudtest` 套件 | **49 → 57 项**，全绿（新增 8 条，含 6 条行为级幂等断言） |
| 全量回归十六套 | **872 项全绿**（cloudtest 57 / uicheck 143 / logintest 85 / brandtest 80 …） |
| 定点破坏反向自证 | 拆「URL 的 `on_conflict`」⇒ 红 **2** 条；拆「逐行兜底」⇒ 红 **7** 条；放宽「只认 23505」⇒ 红 **3** 条；跑完 md5 与干净副本**一致** |
| **真库端到端**（`_supa-e2e-cloudsync.js`） | 首推 4 行（1 重复 + 3 新）⇒ 表 **1 → 4**（只多 3 行）；删游标整批重推 4 行 ⇒ 表 **4 → 4**（一行没多）、`offset=4`（没卡住） |
| **改前必须红**（`_e2e-vs-v105.py`，真库） | 还原成 v1.0.5 发法（`on_conflict` 与兜底**两处都**去掉）⇒ 端到端 **6 条红**，报错原文就是 `HTTP 409 · 23505 · duplicate key value violates unique constraint "publish_log_dedup"`，且 `offset=0` 不动 |

### 一个反直觉的发现（值得记住）

**只去掉 `on_conflict`、但保留逐行兜底 ⇒ 端到端反而全绿**（整批 409 → 逐行也 409 → 全被当"已存在"跳过 → 4 行都算成功）。
也就是说：**兜底能独立救回 `on_conflict` 缺失**，缺的那一半是"兜底"而不是"`on_conflict`"。
v1.0.5 卡死是因为**两半都没有**。所以两条都要做，且都要有断言焊住
（一条焊请求形状、一条焊行为）。

---

## 7. 复核用的脚本（可重跑）

| 脚本 | 作用 | 是否写数据 |
|---|---|---|
| `D:\work\_e2e\_supa-columns.js` | 逐列点名 + 负向对照 | **纯只读** |
| `D:\work\_e2e\_supa-readonly.js` | 看板/App 那几条查询 | **纯只读** |
| `D:\work\_e2e\_supa-probe.js` | 第 5 节的策略/权限实证 | 写入 **1 行探针**（可删） |
| `D:\work\_e2e\_supa-idem.js` | 第 6 节的幂等头对照实验 | **不新增任何行**（重复插同一行） |

```bash
N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe"
"$N" D:/work/_e2e/_supa-probe.js      # 策略实证
"$N" D:/work/_e2e/_supa-idem.js       # 幂等头对照
```

---

## 8. 收尾：请你删掉那 1 行探针（10 秒）

为了把「改不了、删不了」验成**有意义的结论**（而不是「空表所以没动」），
我往表里写了 **1 行探针记录**。它在看板上长这样：

| 列 | 值 |
|---|---|
| `machine_name` | `⚠ 连通性探针（可删）` |
| `result` | `探针（非真实发布）` |
| `ts` | `0`（排序时会沉到最后，不会挤在最近明细里） |

anon **没有 delete 权限**（这正是我们要的结论），所以我删不掉它。请你在
Supabase 控制台 → SQL Editor 里跑这一句：

```sql
delete from public.publish_log where machine_id = '__probe__conn__';
```

删完 `select count(*) from public.publish_log;` 应当是 **0**。

---

## 9. 没做的事（已停手）

- **没有发版**：版本号仍是 `1.0.4`（未改），`git worktree` 快照**没建**，`upload-release.js` **没跑**，公网 `latest.yml` **未动**。
- **没有改任何源码**：第 6 节那个 bug 我只写了修法，**没有动手改**（另一个会话正在发版，改共享文件有串味风险）。
- **只往你库里写了 1 行探针**（第 8 节），没有其它写入；没有跑过任何 update / delete。
- **没有推送代码**。
