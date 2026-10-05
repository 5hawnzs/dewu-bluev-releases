---
name: git-push-via-github-api
description: 在国内网络 / Windows 沙箱里把代码推到 GitHub，并实证「真的推上去了」。覆盖两类场景：(1) `git push` 被网络阻断（github.com:443 连不上、SSH 22/443 被 reset）但 `api.github.com` 仍可达时，改用 GitHub Git Data API 完成等效推送；(2) 首次把本地仓库接入私有仓库的 6 个必踩坑——系统级 credential.helper 与 store **叠加**导致 GCM 把推送挂死、沙箱代理对 github.com 返回 502、`refs/remotes/origin/*` 三级引用**静默写不进**（假成功）、系统级 `core.autocrlf=true` 悄悄改写行尾、单文件超 100MB 让整次推送被拒、以及用 API 反向自检密钥有没有泄露。
agent_created: true
---

# github.com 被阻断时，用 GitHub API 完成推送

## 什么时候用

`git push` 报下面这类错误，但浏览器/其他工具能访问 GitHub：

- `Failed to connect to github.com:443 after 21000 ms: Could not connect to server`
- `RPC failed; curl 52 Empty reply from server` + `send-pack: unexpected disconnect`
- SSH 也失败：`Connection reset by ... port 22`（改用 443 端口 `ssh.github.com` 同样被 reset）
- `git ls-remote` / `git fetch` 一起挂

**先做这个判断**（30 秒，决定走哪条路）：

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2:/c/Windows/system32:$PATH"
node -e "
const urls=['https://api.github.com','https://github.com','https://codeload.github.com','https://registry.npmjs.org'];
(async()=>{for(const u of urls){const t=Date.now();
 try{const r=await fetch(u,{method:'HEAD',signal:AbortSignal.timeout(12000)});console.log(' ',u,'=>',r.status,((Date.now()-t)/1000).toFixed(1)+'s')}
 catch(e){console.log(' ',u,'=> ERR',e.cause?.code||e.name)}}})()"
```

- **`api.github.com` 通 + `github.com` 不通** → 先做下面「重试直连」这一步，仍失败再走本文方案
- 两个都不通 → 放弃，让用户换网络/挂代理后再推

### 先重试直连：阻断是间歇性的，别急着绕路

实测（2026-09-19）：同一台机器上 `github.com` 先是超时、随后在没有任何改动的情况下自行恢复
（`git ls-remote` 与 `git push --dry-run` 均 200）。所以**判定为阻断后，先用下面两行确认一次再决定**，
能直连就直连，比走 API 简单得多（还不会有 commit sha 分叉问题）：

```bash
cd <repo>
timeout 60 git ls-remote origin refs/heads/main    # 拿到 sha 即通
timeout 60 git push --dry-run origin main          # Everything up-to-date / 列出待推提交 即通
```

⚠️ **先分清 `ls-remote` 是「失败」还是「返回 0 却零输出」** —— 后者不是网络问题，而是
**system 级 `helper-selector`（GCM）在挂死**（git 去调 GUI 认证助手 → 非交互环境里永远等不到）。
2026-09-21 实测：直连 `git ls-remote origin` **exit 0 且零输出**，进程"正常退出"、看起来链路没问题，
加上 `-c credential.helper= -c credential.helper=store` 之后**立刻**拿到远端 sha。
**判据：`exit 0 + 空输出` → 直接上 `credential.helper=`（下面 §1），不要再查网络。**
真正被阻断的形态是显式报错：`Recv failure: Connection was reset` /
`Failed to connect to github.com:443 after N ms`。

只有这两条**都**失败（而不是慢）时，才动 API 方案。推送前也可顺手设一次，
对弱网下的中途断流有帮助：`git config http.version HTTP/1.1 && git config http.postBuffer 524288000`。
#### ✅ 实测可用配方（2026-09-21，10 个提交一次推成功）

```bash
cd <repo>
GIT=/c/Users/Administrator/.workbuddy/vendor/PortableGit/cmd/git.exe
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  "$GIT" -c credential.helper= -c credential.helper=store -c http.proxy= -c https.proxy= \
  -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main
# → 579c4f6..078fd2a  main -> main
```

三件事缺一不可：**空 `credential.helper=` 清掉 system 级 GCM**（否则挂死到超时）、
**`-c http.proxy=` + 去掉代理环境变量**（否则 502）、**`http.version=HTTP/1.1`**（弱网防断流）。
顺序：先 `ls-remote` 拿 sha 证明「认证/代理/引用」三条链路都通，再 push —— 别一上来就 push。

> 关键认知：**推送失败 ≠ 部署失败**。CI（GitHub Actions + Pages）跑在 GitHub 自己机房里，
> 只要 ref 更新成功，构建和上线照常。所以这里的唯一目标就是「把 ref 指到新 commit」。

## 方法

> ⚠️ **先把 PortableGit 塞进 PATH 再跑这两个脚本**：脚本内部用 `execFileSync("git", …)`，
> 受限 shell 里 `git` 不在 PATH 就会直接崩在 `spawnSync git ENOENT`
> （2026-09-21 实测，栈顶是 `child_process` 而不是脚本自己的报错，很容易误判成脚本坏了）：
> ```bash
> export PATH="/c/Users/<user>/.workbuddy/vendor/PortableGit/cmd:/c/Users/<user>/.workbuddy/vendor/PortableGit/bin:$PATH"
> ```

`scripts/gh-push.mjs` 按 git 的协议做同样四步，但全部走 `api.github.com`：

1. `POST /git/blobs` —— 每个改动文件建 blob（内容取 `git cat-file blob <sha>:<path>` 的**提交内字节**，不要读工作区文件，避免 CRLF 干扰）
2. `POST /git/trees` —— `base_tree` = 远端父提交的 tree，逐项放进去；**删除**用一条 `{ path, mode, type, sha: null }` 表示（见下）
3. `POST /git/commits` —— 父提交 = 远端 main，带上本地提交的 author/committer/时间/消息
4. `PATCH /git/refs/heads/main` —— 移动分支（**永远不要 force**）

```bash
# 在仓库根目录执行；脚本自己从 origin 里解析 token 和 owner/repo
node <skill>/scripts/gh-push.mjs
```

### 删除 / 重命名 / 网络抖动（2026-09-22 补，都是实测踩到才加的）

**① 含删除的提交**：脚本原来只写了一句「暂不支持删除」就 `exit 1`。
实测场景：把一个按天新增的运行时缓存 `datedrop_*.json` 加进 `.gitignore` 并 `git rm --cached` 之后，
**整次推送被拒**（本地提交没问题，是脚本没这个能力）。
Git Data API 的删法是给该路径一条 **`sha: null`** 的 tree 项（等价于从树上摘掉）。
顺带修掉一个隐患：`git diff --name-status` 的 `R<score>\t旧\t新` 行，
老代码 `split("\t").slice(1).join("\t")` 会把**两个路径拼成一个**（`旧\t新`）→ 拿去 `cat-file` 必然失败。
现已按状态码分别取：`D` 取 `parts[1]`；`R` = 删旧 + 增新；`C` 只增新。

**② `api.github.com` 间歇性跳变** ⇒ 每次调用加**连接级重试**（`GH_PUSH_RETRY`，默认 6，间隔 1.5s×i）。
证据：同一条 `gh-push.mjs` 连跑 6 次全是 `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`
（Node 内置 fetch 的 `connectTimeout` **只有 10s**，且**不走 `HTTP_PROXY`**），
但几分钟前它明明能通 —— 这不是脚本写错，是网络在抖。
重试是**安全的**：blob/tree 是内容寻址（同内容 → 同 sha），commit 重试最多多出一条没人引用的孤儿提交，
`PATCH /git/refs` 本身幂等。**HTTP 4xx/5xx 不重试**（直接暴露，别把真错误吞掉）。
`gh-sync.mjs` 同样加了这套重试（同一根因，只改一个脚本不够）。

```bash
GH_PUSH_RETRY=8 node <skill>/scripts/gh-push.mjs
```

**③ 本地领先多个提交（2026-09-22 补，实战死锁过）**
老脚本只支持「`HEAD^` == 远端 tip」的**单提交**推送，本地一旦领先 ≥2 个就 `exit 1`，并提示
「先想办法 fetch 对齐」—— **而 fetch 走的 `github.com:443` 正是本技能要绕开的那个不通的网络**
（实测 `git push` 直接 403），于是陷入死锁。
实测场景：本地 `7fad8c77 → dc83f12(记忆收口) → a894eaa(功能修复)`，远端停在 `7fad8c77`。

判据改对了：**不是**「远端 tip == `HEAD^`」，而是「**远端 tip 是不是 `HEAD` 的祖先**」（能不能快进）。

```bash
git merge-base --is-ancestor <远端tip> HEAD   # 退出码 0 = 是祖先 = 可快进 = 安全
```

是祖先 ⇒ 远端没有别人的新提交 ⇒ 按 `git rev-list --reverse <远端tip>..HEAD` 取链，
**逐个提交**建 blob/tree/commit（`base_tree` 与 `parents` 都用**上一个提交在 GitHub 侧的真实 sha**），
最后一次 `PATCH /git/refs`。脚本仍只支持**线性**历史：链上每个提交的父必须正好是前一个，有 merge 就明确拒绝。
「远端 sha 本地不存在」（GitHub 归一化过）时回退到老的「比 tree 判内容等价」那条路。

> ⚠️ **多提交推送会留下一个坑：中间提交的 GitHub 侧 sha 本地没有**，于是本地 `main` 指到最后一个
> 远端 sha 之后，它的**父对象缺失** ⇒ `git log` 直接报 `Could not read <中间sha>` /
> `Failed to traverse parents`（历史断了，`git diff HEAD~1` 之类全废）。
> 补法：`gh-sync.mjs` 新增 **`--no-ref`**（只把 commit 对象写进本地对象库、**不动任何 ref**），
> 把链上每个中间 sha 逐個物化进去：
>
> ```bash
> node <skill>/scripts/gh-sync.mjs <中间sha> --no-ref   # 每个中间提交来一次
> node <skill>/scripts/gh-sync.mjs <最后一个sha>        # 这回才动 ref
> git log --oneline -4 && git fsck --no-progress        # 验证：能回溯、无缺父对象
> ```
>
> `--no-ref` 模式下**故意跳过**「远端 tree == 本地 HEAD tree」那条校验（中间提交的 tree 当然不等于
> 当前 HEAD 的 tree），安全性由写完后的 `written === TARGET` 保证 —— **sha 本身就是内容哈希**。

### 自带三层校验，写坏远端会被拦下

脚本在每个环节都拿本地提交做比对，任一不符就中止并且**不动 ref**：

| 校验点 | 比对对象 | 不符的后果 |
|---|---|---|
| blob sha | `git rev-parse HEAD:<path>` | 内容获取错了 |
| tree sha | `git rev-parse HEAD^{tree}` | 拼装错了（多/少文件、模式不对） |
| commit sha | 本地 `HEAD` | 仅元数据序列化差异，**tree 一致则内容零差异**，可继续 |

实测经验：blob 与 tree 会 **100% 一致**；commit sha 通常不一致（GitHub 会归一化时间与消息序列化）。

### 让本地与远端重新指向同一个提交（可选但强烈建议）

commit sha 不一致会让本地 `main` 与 `origin/main` 分叉（虽然 tree 相同），之后 `git pull` 会试图 merge，
很烦。由于 github.com 不通、又 fetch 不到那个对象，可以**在本地把 GitHub 的 commit 对象重建出来**：

```bash
# 从上一个脚本输出里拿到 GitHub 侧的 sha
node <skill>/scripts/gh-sync.mjs <github侧commit sha>
```

脚本会取 `GET /git/commits/<sha>` 的字段拼出 commit 对象，用 `git hash-object -t commit -w --stdin` 写入本地对象库，
再 `git update-ref`。**git 自己会校验哈希**，拼错只会得到另一个 SHA（`-w` 由 fsck 兜底），不会写坏仓库。

实测到的两个坑（都已在脚本里处理）：

- `GET /git/commits/<sha>` 返回的 `parents` 是**对象数组**（`[{sha, url, html_url}]`），不是字符串数组；
  直接拼字符串会得到 `parent [object Object]` → `badParentSha1: invalid 'parent' line format`
- GitHub 存的提交与本地 `git commit` 的字节差异在于**消息结尾多一个换行**、**时区保留为本地偏移（+0800）**
  而不是 UTC。两者拼对即可精确复现（脚本内置穷举：消息后缀 × 时区，24 种组合秒出结果）

### ⚠️ 一次推多个提交 / 大文件 / sha 分叉（2026-09-21 实测）

> ★ **2026-09-22 更新：下面 ① 那套「手工挪 main + `commit-tree` 重建」已经不需要了。**
> `gh-push.mjs` 现在原生支持**一次推多个提交**（见上文「③ 本地领先多个提交」）：
> 直接 `node gh-push.mjs` 即可，它自己按 `rev-list` 逐个建对象、最后一次 PATCH ref。
> 下面的手工流程**只在脚本拒绝时**才用（例如历史非线性），留作应急记录。

**① `gh-push.mjs` 一次只推一个提交**（硬要求「远端 main == 本地 HEAD^」）。要一次推 N 个：

```bash
# 1) 把 main 临时移到「最早那条待推提交」（后面的提交变游离对象，**不碰工作区**）
git update-ref refs/heads/main <最早待推提交 sha>
node gh-push.mjs && node gh-sync.mjs <GitHub 侧 sha>
# 2) 用原 tree 重建下一条提交，父改成 GitHub 侧的 sha（纯对象操作）
git log -1 --format=%B <原提交> > msg.txt
Y=$(GIT_AUTHOR_NAME=… GIT_AUTHOR_EMAIL=… GIT_AUTHOR_DATE=… \
    GIT_COMMITTER_NAME=… GIT_COMMITTER_EMAIL=… GIT_COMMITTER_DATE=… \
    git commit-tree '<原提交>^{tree}' -p <GitHub侧sha> < msg.txt)
git update-ref refs/heads/main "$Y"
node gh-push.mjs && node gh-sync.mjs <新的 GitHub 侧 sha>
```
实测 2 个提交（含 8 张约 1 MiB 的 PNG）两次推送全部成功，`tree` 与本地逐字节一致。

**② `.mjs` 里 `execFileSync` 默认 `maxBuffer` 只有 1 MiB**
→ 仓库里有 >1 MiB 的二进制时（实测一张 **1,081,344 字节**的 PNG），`git cat-file blob` 抛 `ENOBUFS`；
报错对象里只看到一个巨大的 `stdout` Buffer、栈顶在 `child_process`，**极易误判成网络或脚本逻辑问题**。
`gh-push.mjs` 已把读 blob 的那处显式放大到 256 MiB。

**③ gh-sync 可能复现不了 GitHub 的归一化字节** → 本地与远端 sha 分叉（**tree 相同**）。
实测过**三个**根因，前两个都已修进 `gh-sync.mjs` —— 别把「复现失败」当成正常现象：
1. **穷举范围不够**：GitHub 侧消息尾的换行数与本地不同（`git commit -F` 是 +1、
   `git commit-tree` 是 +3 等）⇒ 后缀穷举已扩到 **0~4 个换行**。
2. ★★ **author 与 committer 的时间戳不能共用**（2026-09-24 实测，最容易被误判成「就是复现不了」）：
   老代码拿 `c.committer.date` 算出**同一个** epoch，同时写进 author 行和 committer 行。
   而**任何改写历史的操作都会让两者不等** —— 一次 `git commit --amend` 之后实测
   author = `…T16:05:24Z`、committer = `…T16:05:54Z`（**差 30 秒**）⇒ 穷举再多后缀/时区也必然 miss。
   修法：分别取 `c.author.date` / `c.committer.date`。
   ⇒ 教训：**「穷举失败」不等于「不能复现」，先想想还有哪个字段被想当然地复用了。**
3. 时区也别只信**进程** TZ（进程 TZ 是 UTC 时，`tzs` 只剩 `["+0000"]`，提交里真实的 `+0800`
   永远试不到）⇒ 现在会先从一个「tree 与远端相同」的本地提交的**原始 header** 里读真实 offset 当候选。

> ⚠️ 分叉的副作用是**本地历史断裂**：后续提交的父是 GitHub 侧 sha，本地没那个对象 →
> `git log` 直接 `error: Could not read <sha>` / `fatal: Failed to traverse parents`。
>
> ★★ **更糟的一种：ref 指向一个本地不存在的对象**（2026-09-24 实测踩到）——
> gh-sync 复现失败时**只**对齐 `refs/heads/main`（这是对的），但如果此时顺手把
> `refs/remotes/origin/main` 指向远端 sha，就会得到一个本地没有的对象，git 报
> `error: refs/remotes/origin/main: invalid sha1 pointer <sha>`，`git status` 显示 `[gone]`
> ——**比不写这个 ref 还糟**（`fsck` 也会报错）。
> ⇒ **铁律：先补对象，再写 ref。** 写 ref 之前先 `git cat-file -t <sha>` 确认是 `commit`。
>
> 工具（已固化成脚本，直接可用）：
> ```bash
> python <skill>/scripts/gh-fix-ref-obj.py <repo目录> <目标远端sha> [本地等价提交，默认 HEAD]
> ```
> 它拿本地等价提交的**原始字节**当基准，穷举「尾换行数 × author tz × committer tz」，
> 命中即 `hash-object -w` 写入对象库并回读 `cat-file -t`。核心逻辑（脚本就是它的固化）：
> ```python
> head, _, msg = git("cat-file commit " + local_equiv).partition(b"\n\n")
> body = msg.rstrip(b"\n")
> for tz in (b"+0800", b"+0000", b"-0000"):     # author / committer 各自穷举
>     for k in range(9):                        # 尾部换行数 0~8（实测命中过 k=2 / k=3）
>         cand = head_with_tz + b"\n\n" + body + b"\n" * k
>         if hash_object(cand) == target: hash_object_write(cand)   # 命中后写入对象库
> ```
> 补上对象之后：`git log` / `git fsck` 恢复正常，`refs/remotes/origin/main` 也可以写了
> （本沙箱里仍要**手工写松散 ref 文件再回读**，见 §3）；
> 也可以顺手把本地 `main` 指到远端那个 sha（tree 相同 ⇒ 工作区内容一个字节都不变），
> 这样 `git status` 就是干净的 `## main...origin/main`，不再是 `[ahead 1, behind 1]`。

`gh-push.mjs` 另加两层**用 tree 判**的兜底（安全：tree 一致 ⇒ 远端没有别人的新提交）：
- 远端 tip 的 tree == 本地 `HEAD` 的 tree → **本次提交的内容已在远端**，跳过（不造空提交）
- 远端 tip 的 tree == 本地 `HEAD^` 的 tree → 同一份内容两个 sha，**放行**
  （⚠️ 放行时 base 与 parent 都必须换成**远端那个 sha**，否则 `GET /git/commits/<本地sha>` 直接 404）

**④ ⚠️ 复现失败时别急着手写 `refs/remotes/origin/main`**
那个 sha 的对象不在本地对象库里 → git 直接判 `bad ref` / `missing object`
（`show-ref`、`for-each-ref` 都会报错并跳过它），**比 `[gone]` 更糟**。
**先把对象补进库（见 ③），再写 ref** —— 那时 `git status -sb` 会显示 `## main...origin/main`（无 `[gone]`、无 ahead/behind）。

### 如果不想动本地仓库

内容已在远端，本地不动也能用；等 github.com 恢复后执行：

```bash
git fetch origin && git reset --hard origin/main
```

## 前置条件

- Token 必须有 **Contents: Read and write**（fine-grained PAT 只勾这一个就够）
- Token 可放在 remote URL 里（`https://user:token@github.com/owner/repo.git`），脚本会解析出来；
  **不要**把 token 写进任何会被提交的文件
- 脚本用 Node 内置 `fetch`（Node 18+），无需安装依赖

## 验证推送真的生效

> ⚠️ **「复核脚本本身缺参数」会打出看起来像「推送失败」的 FAIL**（2026-09-24 实测）：
> 项目里的 `_verify_push.mjs <期望的远端 ref sha> [本地参照提交]` 若**不带参数**跑，
> `wantRef` 是 `undefined` ⇒「远端 ref == 期望 sha」**必然 FAIL**，而同一屏 12 条全 PASS ⇒
> 极易当成「推上去了但 ref 没动」。**别只看那一行 FAIL，先看它右边是不是「只印了一个 sha、没有 `vs …`」**。
> ⇒ 已给该脚本加守卫：缺参数时打印用法并以 **退出码 2** 退出（与「真失败 = 1」区分开）。
> **通用做法**：凡「人工传参的验证脚本」，缺参一律报用法退出，绝不降级成一条 FAIL ——
> 假失败与假绿一样会骗人。

推完别只看脚本输出，用 API 确认三件事：

```bash
# 1) 远端 ref 是不是你那个 sha
curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/<owner>/<repo>/git/ref/heads/main

# 2) CI 有没有被触发、结果如何（等它完成再看线上）
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/<owner>/<repo>/actions/runs?branch=main&per_page=3"

# 3) 部署产物里有没有你的新代码（最强的端到端证据）
```

第 3 步的做法：抓线上 `index.html` → 取出引用的 js → grep 你新增的界面文案。
若线上 chunk 的哈希与本地 `npm run build` 产物哈希相同，说明**上线产物与本地测过的完全一致**。
（实测：本地 `out/assets/index-CcljMQwJ.js` 与线上同名同哈希）

⚠️ **`secrets.template.json` 返回 200 不等于泄漏**：它是分发包里的**占位模板**（值形如
「（管理员提供，与前端 config.js 中的相同）」）。判泄漏要两步：① 真名 `secrets.json` 必须 404；
② 拿**真实密钥值**（整串 + 前 40 + 后 40 字符）在 `git diff --cached` 里反查，命中数必须为 0——
只看有没有 200 会把模板误报成事故，白折腾一轮。

用 API 复核时，token 从 `~/.git-credentials` 解析即可（正则 `^https:\/\/[^:]+:([^@]+)@github\.com$`），
**不要**把 token 打到日志里。要确认的三件事：远端 ref 的 sha、`contents/secrets.json` 是否 404、
远端 `deploy/index.html` 的 blob sha 是否等于本机 `git rev-parse HEAD:deploy/index.html`（这条是内容零差异的硬证据）。

> ⚠️ **别把上面这段正则写进 `node -e "..."`**（2026-09-21 实测）：Bash 会把双引号里的
> `\/`、`\.` 的反斜杠先吃掉 → 正则变成 `^https:////[^:]+:...@github/.com` →
> `SyntaxError: missing ) after argument list`，**报错位置在 `node -e` 的源码上，很容易误判成
> 「node 坏了」或「token 解析逻辑不对」**。落成一个 `.js` 文件再 `node file.js` 跑即可
> （顺带还能把「本地 blob sha」用 `process.argv` 传进去比对）。
> ★ 同理：**内容零差异的硬证据要拿 blob sha 比**，不是比文件大小 ——
> `git rev-parse HEAD:<path>` 与 `GET /repos/.../contents/<path>?ref=main` 返回的 `.sha` 必须**完全相等**
> （实测：`deploy/index.html` → `74977f11…` / `deploy/dewu-kol-tools.zip` → `fe5fb118…`，
> 配 `ls-remote origin refs/heads/main` 拿到的 ref sha 一起看，三条齐了才算「推上去了」）。

## 首次接入：在 Windows 沙箱里把本地仓库推上去（6 个必踩的坑）

> 实测 2026-09-20（WorkBuddy Windows 沙箱 + PortableGit 2.55 + 私有仓库首推 1147 文件 / 145MB）。

### 0. 先证明「git 通」，再关心体积
`git ls-remote` 只要 5 秒，却能把**认证 / 代理 / 引用**三条链路一次验完。**永远先 ls-remote 再 push**，
否则大仓库失败时分不清是网络、认证还是文件太大。
```bash
GIT=/c/Users/<user>/.workbuddy/vendor/PortableGit/cmd/git.exe   # 受限 shell 里 git 常不在 PATH
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  "$GIT" -c credential.helper= -c credential.helper=store -c http.proxy= -c https.proxy= \
  ls-remote origin
```

### 1. ⚠️ 认证助手是**叠加**的，GCM 会把推送悬停住（最坑的一个）
`credential.helper` 在 system / global / repo 三级 config 里**累加**，不是覆盖。
Git for Windows 常在 **system 级**装 `helper-selector`（GCM）；即使你把 global 设成
`credential.helper store`，git 仍会**先调用 GCM** → 它试图弹 GUI → 非交互环境下**挂死**
（实测：拉 10 分钟零输出，最后被 timeout 杀掉，而远端一个字节都没收到）。
必须用**空值重置助手栈**（空值的作用就是"清空前面累加的 helper"）：
```bash
"$GIT" -c credential.helper= -c credential.helper=store push -u origin main
```
诊断：`GIT_TRACE=1 git ls-remote origin` 会打印实际调用了哪些 helper。

### 2. 沙箱系统代理会挡 GitHub（502）
`http_proxy=http://127.0.0.1:<port>` 对 github.com 的 CONNECT 返回
`CONNECT tunnel failed, response 502`。必须显式绕过（`-c http.proxy=` 设空 + 去掉环境变量）：
```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  "$GIT" -c http.proxy= -c https.proxy= push -u origin main
```
⚠️ 注意 **`api.github.com` 往往不经代理也能通**（Node/curl 直连正常），所以「API 通」**不**代表「git 通」；
反过来 `github.com` 直连是**间歇性**的（实测：一次 40 秒传完 145MB，几分钟后连续失败）。
**推送失败先原样重试**，不要急着改成走 API。

### 3. ⚠️ 三级引用写不进去，而且**假装成功**
沙箱文件系统下，git 能写 `refs/testref`（1 级）、`refs/remotes/testref`（2 级），
但 **任何 3 级引用都会静默失败** —— 不只是 `refs/remotes/origin/main`，
**`refs/heads/backup/pre-slim` 这种带斜杠的分支名同样中招**（`git branch -f backup/pre-slim HEAD`
会打印成功，然后 `git branch` 里根本看不到它，**回滚点就这么丢了**）。
失败形态：`git fetch` / `git update-ref` / `git branch -f` 全部返回 0、`FETCH_HEAD` 也正常，
可 ref 文件就是不出现 → `git status` 常驻
`Your branch is based on 'origin/main', but the upstream is gone`。

> ★ **2026-09-24 补充：`git fetch` 的「输出」也会骗人。**
> 实测它照旧打印 `* [new branch]  main -> origin/main`（看着像成功新建了跟踪分支），
> 而紧接着 `git rev-parse origin/main` 直接报 `unknown revision` —— ref 根本没落盘。
> ⇒ **别拿 fetch 的 stdout 当证据**，一律 `git rev-parse <ref>` 回读。
> 同日另一条经验：`github.com` 那会儿是**通的**，直连 `git push` 一次成功
> （`2300bd4..d1aa088  main -> main`），**推完仍然 `[gone]`** —— 按上面两行补 ref 即恢复
> `## main...origin/main`。⇒ 结论顺序仍是「**先试直连**（带 `/usr/bin/timeout`），
> 不行再走 API」，两条路都要补 ref + 回读。

> **铁律：这个环境里「写引用」的命令返回码完全不可信**，必须复核：
> `git show-ref` 或 `find .git/refs -type f`。别用带 `/` 的分支名（改用 `refs/backup-preslim` 这种 2 级）。

```bash
# 验证是否中招：返回 0 但列表里没有 origin/main
"$GIT" update-ref refs/remotes/origin/main "$("$GIT" rev-parse HEAD)" && find .git/refs -type f
```
**解法**（git 能正常**读**手工写的 ref；已验证持久）：
```bash
mkdir -p .git/refs/remotes/origin
printf '%s\n' "$("$GIT" rev-parse HEAD)" > .git/refs/remotes/origin/main
"$GIT" branch -vv      # 应显示 [origin/main]，status -sb 显示 ## main...origin/main
```
> 实测 2026-09-21：**直连 `git push`（不走 API）同样会留下 `## main...origin/main [gone]`**
> —— 不是只在走 API 时才中招。因为直连时**本地 HEAD 的 sha 就等于远端 sha**（对象已在本地库里），
> 所以直接按上面两行补 ref 即可，不需要先补对象。补完 `git branch -vv` 显示 `[origin/main]`、
> `status -sb` 显示 `## main...origin/main`（无 ahead/behind、无 `[gone]`）就是干净了。

> ★ 2026-09-22 追记（**脚本侧已自带防护，不必再靠人记得复核**）：
> `gh-sync.mjs` 的 `setRef()` 现在 ① 写前尽力 `mkdirSync`；
> ② 写后**回读 `git rev-parse <ref>` 校验**；③ `refs/remotes/**` 走**非致命**模式
> （只警告 + 打印现成的手工补救命令，不 `exit 1`），`refs/heads/**` 仍致命（写不成必须报错）。
> **起因**：脚本原来写完就直接打印「✅ refs/heads/main 与 refs/remotes/origin/main 均已指向 …」，
> **根本不回读** ⇒ 报成功而 `git branch -a` 里什么都没有（正是本节说的「假装成功」）。
>
> ⚠️ **node 侧同样会被骗**（本次实测，与原节互补）：
> `fs.mkdirSync(dir, { recursive: true })` **返回成功**、`fs.existsSync(dir)` **也给 `true`**，
> 可紧接着 `fs.writeFileSync()` 仍报 `ENOENT`，`ls` 一看目录压根没建出来
> —— `recursive: true` 在「视图认为已存在」时会**直接短路、不做系统调用**。
> ⇒ **别用 `existsSync` 判断「要不要建目录」**；**唯一可信的判据永远是「回读 / 落地后再看」**。
> （补 ref 之后 `git rev-parse refs/remotes/origin/main` 能返回 sha，才算真的成功。）

### 4. 行尾：`core.autocrlf` 可能在**系统级**是 true
会静默改写行尾。若项目有「按字节断言源码」的测试（本项目就是），必须在 `git add` **之前**关掉：
```bash
"$GIT" config core.autocrlf false     # 仓库级，紧跟 git init 之后
```
检查顺序很重要：`git init` → `config core.autocrlf false` → `git add -A`。

### 5. 大文件：GitHub 单文件硬限 100MB
127MB 的 APK 会让**整次推送被拒**（不是只跳过那个文件）。**`git add` 之前**先扫：
```bash
find . -type f -size +40M -not -path "./.git/*" -printf "%s\t%p\n" | sort -rn
```
超限文件写进 `.gitignore`（或改用 Git LFS）。⚠️ `.gitignore` 对**已跟踪**文件无效，
已误加的要 `git rm --cached -f <file>`（文件在暂存后被外部改动过时必须 `-f`）。

### 6. 密钥泄露自检：别只信 .gitignore，要问远端
提交后**用 API 反向验证**，这比看 `git status` 强得多：
```js
// 必须 404；出现 200 说明密钥已泄露，立即轮换
for (const p of ['secrets.json','secrets.example.json']) {
  const r = await fetch(`https://api.github.com/repos/<owner>/<repo>/contents/${p}`, {headers:{Authorization:'Bearer '+t}});
  console.log(p, r.status);
}
```
另可 grep 服务端密钥的特征串，确认它只出现在被忽略的那个文件里。

### 7. ⚠️ 凭据常常**不在 origin 里**（脚本会因此直接退出，无法运行）

`git remote -v` 与 `~/.git-credentials` 是两码事：很多仓库的 origin 就是干净的
`https://github.com/owner/repo.git`，密码由 `credential.helper=store` 从 `~/.git-credentials` 取。
`gh-push.mjs` 原来只从 origin 解析 token → 遇到这种仓库直接报
「无法从 origin 解析出 token」而完全不可用。

**已修（两个脚本都要一起修，别只修一个）**：origin 里没有 userinfo 时自动回退读
`~/.git-credentials`，并打印凭据来源（只显示尾 4 位）。
2026-09-21 实测：`gh-push.mjs` 修好了、`gh-sync.mjs` 忘了修 → push 成功、sync 立刻报
「无法从 origin 解析出 token」，而 **sync 不是可选的**（见下）。
`gh-sync.mjs` 同时还有一个 slug 正则缺陷：`(.+?)(?:\.git)?$` 会把 `.git` 吃进 slug
（API 路径变成 `/repos/owner/repo.git` → 404），必须用 `([^/\s]+?)(?:\.git)?$`。

> ⚠️ **push 完必须紧跟 gh-sync**：`gh-push.mjs` 第 3 步要求
> 「远端 main 的 sha == 本地 HEAD^」。走 API 推上去的 commit sha 与本地不同（GitHub 会
> 归一化消息/时间），于是**下一次 push 一定失败**，除非先把本地对齐到 GitHub 那个 sha。
> 换句话说：**只 push 不 sync = 下次推不动**。

判定一个仓库属于哪种情况：

```bash
git config --get-all credential.helper      # 出现 store → 走 ~/.git-credentials
ls -la ~/.git-credentials                   # 有文件即说明凭据在这里
```

写解析函数时注意：**完整 remote 与凭据存储的裸行格式不同**（后者没有 `/owner/repo` 尾巴），
正则要用 `@github\.com(?:\/|$)` 收尾，两种都吃下 —— 只锚 `$` 会让「本来就支持」的远程 URL 反而失效。

## 不要做的事

- ❌ 不要用 `git push --force` / `PATCH ref {force:true}`：内容已一致，force 只会掩盖真问题
- ❌ 不要在 `base_tree` 里只放改动文件却不带 `base_tree` 参数：那会把整个仓库替换成这几个文件
- ❌ 不要为了「让 sha 一致」去改提交消息或时间：内容正确比 sha 好看重要
- ❌ 不要把「推送失败」当成「任务失败」向用户汇报；先确认 CI 侧的部署结果
