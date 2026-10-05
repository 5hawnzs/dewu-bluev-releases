/**
 * github.com:443 不可达时，用 api.github.com 完成等效的 git push。
 *
 * 四步与 git 协议一致：建 blob → 建 tree（base_tree = 远端父提交的 tree）
 * → 建 commit（父 = 远端 main）→ PATCH refs/heads/main。
 *
 * 三层校验（blob / tree / commit）任一不符就中止，绝不动 ref，避免写坏远端。
 *
 * 用法（在仓库根目录，Node 18+）：
 *   node gh-push.mjs                # 推送当前 HEAD 到 main
 *                                   # ★ 本地领先多个提交也支持：只要远端 tip 是 HEAD 的祖先（可快进），
 *                                   #   就按 `git rev-list --reverse <远端tip>..HEAD` 逐个建对象、最后一次 PATCH ref
 *   node gh-push.mjs --branch dev   # 推到别的分支
 *   node gh-push.mjs --dry-run      # 只校验不写 ref
 * 环境变量：`GH_PUSH_RETRY`（连接级重试次数，默认 6）
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const getArg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const BRANCH = getArg("--branch", "main")
const DRY_RUN = argv.includes("--dry-run")

const REPO = process.cwd()
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", ...opts })

/* ---------- 1. 解析 owner/repo 与 token ----------
 * token 优先取 origin URL 里的 userinfo；没有就回退到 ~/.git-credentials
 * （两者都是本机 git 用的同一个凭据，`credential.helper=store` 就存在这里）。
 * ⚠️ 假设「origin 里一定有 token」曾让脚本无法运行 —— 2026-09-21 实测的仓库
 * origin 就是干净的 https://github.com/owner/repo.git。
 */
const remote = git(["remote", "get-url", "origin"]).trim()
const slugM = remote.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/)
if (!slugM) {
  console.error("无法从 origin 解析 owner/repo，当前 origin:", remote)
  process.exit(1)
}
const slug = `${slugM[1]}/${slugM[2]}`

function parseCred(url) {
  // 两种输入都要吃下：完整 remote（...@github.com/owner/repo.git）与凭据存储里的裸行（...@github.com）
  const cm = String(url).trim().match(/^https:\/\/([^:@/]+):([^@]+)@github\.com(?:\/|$)/)
  if (!cm) return null
  try {
    return { user: decodeURIComponent(cm[1]), token: decodeURIComponent(cm[2]) }
  } catch {
    return { user: cm[1], token: cm[2] }
  }
}

let cred = parseCred(remote)
let credsFile = null
if (!cred) {
  credsFile = join(process.env.HOME || process.env.USERPROFILE || homedir(), ".git-credentials")
  try {
    for (const line of readFileSync(credsFile, "utf8").split(/\r?\n/)) {
      const c = parseCred(line)
      if (c) { cred = c; break }
    }
  } catch { /* 读不到就当没凭据，下面统一报错 */ }
}
if (!cred) {
  console.error("拿不到 GitHub token。两种给法任选其一：")
  console.error("  a) origin 带凭据：https://user:token@github.com/owner/repo.git")
  console.error("  b) 写进凭据存储：git config credential.helper store 后 push 一次，")
  console.error(`     或直接把 https://user:token@github.com 写进 ${credsFile}`)
  process.exit(1)
}
const token = cred.token
console.log(`仓库 : ${slug}`)
console.log(`凭据 : ${cred.user} / ****${token.slice(-4)}  (来源：${remote.includes("@") ? "origin URL" : credsFile})`)
const API = `https://api.github.com/repos/${slug}`

// ★ 2026-09-22 补：**连接级重试**。
//   实测：`api.github.com` 在能通与不能通之间**间歇性**跳变 —— 同一条命令连跑 6 次，
//   可能全是 `ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT`（Node 内置 fetch 的 connectTimeout
//   只有 10s，且**不走 HTTP_PROXY**）。这不是脚本写错，是网络在抖。
//   因此每次 API 调用重试 N 次（间隔递增）。**安全性**：这里所有写操作都是幂等的 ——
//   blob/tree 是内容寻址（同样内容 → 同样 sha），commit 重试最多多出一条没人引用的孤儿提交，
//   ref 的 PATCH 也是幂等的。
const RETRY = Number(process.env.GH_PUSH_RETRY || 6)
async function ghOnce(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gh-push-via-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}\n${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}
async function gh(method, path, body) {
  let last
  for (let i = 1; i <= RETRY; i++) {
    try {
      return await ghOnce(method, path, body)
    } catch (e) {
      last = e
      const net = /ECONNRESET|ECONNREFUSED|UND_ERR|EPIPE|ETIMEDOUT|fetch failed|Connect Timeout/i.test(String(e && e.message) + String(e && e.cause))
      if (!net) throw e                       // HTTP 4xx/5xx 之类不重试，直接暴露
      if (i === RETRY) break
      const wait = 1500 * i
      console.error(`   … ${method} ${path} 第 ${i} 次失败（网络），${wait}ms 后重试`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw last
}

/* ---------- 2. 本地提交信息 ---------- */
const headSha = git(["rev-parse", "HEAD"]).trim()
console.log("本地 HEAD   :", headSha)

/* ---------- 3. 远端 tip 与本地 HEAD 的关系 ---------- */
const ref = await gh("GET", `/git/ref/heads/${BRANCH}`)
const remoteTip = ref.object.sha
console.log(`远端 ${BRANCH}  :`, remoteTip)

/* ★ 2026-09-22 补：**本地领先多个提交**（原来只支持「HEAD^ == 远端 tip」的单提交推送）。
 *   实战踩到：本地 `7fad8c77 → dc83f12(记忆收口) → a894eaa(功能修复)`，远端停在 `7fad8c77`。
 *   老代码把「远端 tip ≠ HEAD^」一律判成「远端有新提交」并拒绝 + 提示「先 fetch 对齐」——
 *   而 fetch 走的 `github.com:443` 正是本技能要绕开的那个不通的网络（实测 `git push` 直接 403）⇒ **死锁**。
 *   正确判据不是「远端 tip == HEAD^」，而是「**远端 tip 是不是 HEAD 的祖先**」（能不能快进）。
 *   是祖先 ⇒ 远端没有别人的新提交 ⇒ 安全；随后逐个提交建对象（父链依次接上），最后一次 PATCH ref。
 */
let baseSha
let chain
let remoteTipIsAncestor = false
try {
  git(["cat-file", "-e", `${remoteTip}^{commit}`])   // 远端这个 sha 本地有吗
  try {
    git(["merge-base", "--is-ancestor", remoteTip, headSha])
    remoteTipIsAncestor = true
  } catch { /* 本地有这个 sha，但不是 HEAD 的祖先 ⇒ 真分叉 */ }
} catch { /* 本地根本没有这个 sha（GitHub 归一化过时间/消息）⇒ 走下面的「内容等价」判据 */ }

if (remoteTipIsAncestor) {
  if (remoteTip === headSha) {
    console.log("   ✅ 远端 == 本地 HEAD，无新提交")
    process.exit(0)
  }
  baseSha = remoteTip
  chain = git(["rev-list", "--reverse", `${remoteTip}..${headSha}`]).trim().split("\n").filter(Boolean)
  /* 只支持**线性**历史：链上每个提交的父必须正好是前一个（链首的父 = 远端 tip）。
   * 有 merge / 分叉就明确拒绝，绝不猜。 */
  for (let i = 0; i < chain.length; i++) {
    const want = i === 0 ? remoteTip : chain[i - 1]
    const got = git(["rev-parse", `${chain[i]}^`]).trim()
    if (got !== want) {
      console.error(`!! ${remoteTip.slice(0, 7)}..HEAD 不是线性历史（有 merge 或分叉），本脚本不支持。`)
      console.error(`   ${chain[i].slice(0, 7)} 的父是 ${got.slice(0, 7)}，期望 ${want.slice(0, 7)}`)
      process.exit(1)
    }
  }
  console.log(`\n待推送提交 ${chain.length} 个（远端 tip 是本地 HEAD 的祖先 ⇒ 可快进）：`)
  for (const c of chain) console.log("  →", c.slice(0, 7), git(["log", "-1", "--format=%s", c]).trim())
} else {
  /* 回退到老逻辑：远端 sha 在本地不存在（GitHub 归一化过），只能比 tree 判「内容等价」。 */
  const parentSha0 = git(["rev-parse", `${headSha}^`]).trim()
  const localTree0 = git(["rev-parse", `${headSha}^{tree}`]).trim()
  /* ⚠️ gh-sync 偶发复现不了 GitHub 归一化后的 commit 字节（实测：消息由
   * `git commit-tree` 生成的那条没能复现）→ 本地与远端 sha 分叉、但 tree 完全相同。
   * 这种分叉是「同一份内容、两个 sha」，**不会覆盖任何远端内容**，放行是安全的；
   * 一刀切拒绝会让「下次推送」直接卡死（脚本只说 fetch 对齐，而 github.com 正是不通的那个）。
   * 判据用 tree 而不是 sha：tree 是内容哈希，tree 一致 ⇒ 远端没有别人的新提交。 */
  const remoteCommit = await gh("GET", `/git/commits/${remoteTip}`)
  const parentLocalTree = git(["rev-parse", `${parentSha0}^{tree}`]).trim()
  /* 情况 1：远端 tip 的内容 == 本地 HEAD 的内容 → 本次提交其实已经推上去了
   * （gh-push 成功但 gh-sync 没跟上时就是这样），直接结束，别造空提交。 */
  if (remoteCommit.tree.sha === localTree0) {
    console.log("   ✅ 远端 tip 的 tree 与本地 HEAD 相同 —— 本次提交的内容已在远端，无需推送")
    process.exit(0)
  }
  if (remoteCommit.tree.sha !== parentLocalTree) {
    console.error("!! 远端分支与本地父提交不一致（远端有新提交），拒绝写入。先想办法 fetch 对齐。")
    console.error(`   远端父 tree   = ${remoteCommit.tree.sha}`)
    console.error(`   本地 HEAD^ tree = ${parentLocalTree}`)
    process.exit(1)
  }
  console.log("   ⚠️ 远端 sha 与本地 HEAD^ 不同，但 tree 一致（同一份内容、两个 sha）→ 放行")
  baseSha = remoteTip
  chain = [headSha]
}

/* ---------- 4~7. 逐个提交：变更清单 → blob → tree → commit ---------- */
// 每个提交都在**上一个提交在 GitHub 侧的真实 sha / tree** 上叠加（base_tree 必须是远端存在的那个）。
// 参数：这次要推的本地提交 / 它在 GitHub 侧的父 sha / 父 tree。
async function pushOne(cSha, parentRemoteSha, parentTreeSha) {
  const cTree = git(["rev-parse", `${cSha}^{tree}`]).trim()
  const cMessage = git(["log", "-1", "--format=%B", cSha])
  const [an, ae, aI, cn, ce, cI] = git([
    "log", "-1", "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI", cSha,
  ]).trim().split("\0")
  const cSubject = git(["log", "-1", "--format=%s", cSha]).trim()

  console.log(`\n── ${cSha.slice(0, 7)}  ${cSubject}`)
  console.log("   本地 tree :", cTree)

  /* ---------- 4. 变更清单（含删除 / 重命名） ---------- */
  // ⚠️ 必须带 `-c core.quotepath=false`（2026-09-21 实测修复）：
  //    git 默认会把**非 ASCII 路径**转义并加双引号输出，形如
  //      A\t"_colcmp_\346\224\271\345\211\215..."
  //    把这些带引号的字符串直接拿去 `cat-file` / `rev-parse` 会报
  //      fatal: path '"_colcmp_...' does not exist in '<sha>'
  //    而错误信息里的乱码很难一眼看出是引号问题 —— 之前的推送都没事，
  //    只是因为恰好没有「新增非 ASCII 文件名」的提交。
  //    注：极端情况下（文件名含制表符/换行）仍会带引号，那属于本脚本未覆盖的范围。
  //
  // ★ 2026-09-22 补：**删除与重命名**（原来只有一句「暂不支持删除」就 `exit 1`）。
  //   实测踩到：把 `datedrop_*.json` 加进 .gitignore 并 `git rm --cached` 之后，整个推送被拒。
  //   Git Data API 的写法是给该路径一条 **`sha: null`** 的 tree 项（等价于从树上摘掉）。
  //   ⚠️ 顺带修一个隐患：`R<score>\t旧\t新` 这类行，老代码 `split('\t').slice(1).join('\t')`
  //      会把**两个路径拼成一个**（`旧\t新`）→ 拿去 `cat-file` 必然失败。
  //      所以按状态码分别取：D 取 parts[1]；R/C 取 parts[2]（并各自记录旧路径）。
  const nameStatus = git(["-c", "core.quotepath=false", "diff", "--name-status", `${cSha}^`, cSha])
    .trim().split("\n").filter(Boolean)
  const files = []          // 需要建 blob 的路径（新增 / 修改 / 重命名后的新路径）
  const deletes = []        // 需要从远端树上摘掉的路径
  for (const l of nameStatus) {
    const parts = l.split("\t")
    const st = parts[0] || ""
    if (st.startsWith("D")) { deletes.push(parts[1]); continue }
    if (st.startsWith("R")) { deletes.push(parts[1]); files.push(parts[2]); continue }  // 重命名 = 删旧 + 增新
    if (st.startsWith("C")) { files.push(parts[2]); continue }                          // 复制 = 只增新
    files.push(parts[1])
  }
  console.log(`   变更文件 ${files.length} 个${deletes.length ? `，删除 ${deletes.length} 个` : ""}`)

  /* ---------- 5. 建 blob，并核对与本地提交一致 ---------- */
  const treeEntries = []
  for (const path of files) {
    // 取「提交里的字节」，避免工作区 CRLF 影响
    // ⚠️ 必须显式放大 maxBuffer：execFileSync 默认上限 1 MiB，
    // 仓库里有 >1 MiB 的二进制（实测一张 1,081,344 字节的 PNG）时会抛
    // ENOBUFS 崩溃（错误对象里只看到一个大 Buffer，很容易误判成别的问题）。
    const raw = git(["cat-file", "blob", `${cSha}:${path}`], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    })
    const localBlob = git(["rev-parse", `${cSha}:${path}`]).trim()
    const blob = await gh("POST", "/git/blobs", {
      content: Buffer.from(raw).toString("base64"),
      encoding: "base64",
    })
    const ok = blob.sha === localBlob
    console.log(`   ${ok ? "✓" : "✗"} ${path}  blob=${blob.sha.slice(0, 10)}`)
    if (!ok) {
      console.error(`!! ${path} 的 blob 与本地提交不一致，中止`)
      process.exit(1)
    }
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha })
  }
  // 删除：tree 项 `sha: null` = 从树上摘掉该路径（Git Data API 的删法）
  for (const path of deletes) {
    console.log(`   ✗ ${path}  （删除：sha=null）`)
    treeEntries.push({ path, mode: "100644", type: "blob", sha: null })
  }

  /* ---------- 6. 建 tree（base 用远端侧真实存在的那个 tree） ---------- */
  const tree = await gh("POST", "/git/trees", {
    base_tree: parentTreeSha,
    tree: treeEntries,
  })
  if (tree.sha !== cTree) {
    console.error("!! 生成的 tree 与本地 tree 不一致，中止")
    console.error(`   GitHub = ${tree.sha}`)
    console.error(`   本地   = ${cTree}`)
    process.exit(1)
  }

  /* ---------- 7. 建 commit ---------- */
  const commit = await gh("POST", "/git/commits", {
    message: cMessage,
    tree: tree.sha,
    parents: [parentRemoteSha],
    author: { name: an, email: ae, date: aI },
    committer: { name: cn, email: ce, date: cI },
  })
  console.log(
    commit.sha === cSha
      ? `   新 commit : ${commit.sha}  ✓ 与本地提交 SHA 完全一致`
      : `   新 commit : ${commit.sha}  ⚠️ SHA 与本地不同（GitHub 会归一化消息/时间），tree 一致即内容零差异`,
  )
  return { sha: commit.sha, tree: tree.sha }
}

/* ---------- 依次推送链上的每个提交（父链逐节接上） ---------- */
let lastSha = baseSha
let lastTree = (await gh("GET", `/git/commits/${baseSha}`)).tree.sha
for (const c of chain) {
  const r = await pushOne(c, lastSha, lastTree)
  lastSha = r.sha
  lastTree = r.tree
}

if (DRY_RUN) {
  console.log("\n--dry-run：不更新 ref。")
  process.exit(0)
}

/* ---------- 8. 移动 ref（永不 force） ---------- */
await gh("PATCH", `/git/refs/heads/${BRANCH}`, { sha: lastSha, force: false })
console.log(`\n✅ refs/heads/${BRANCH} 已更新为 ${lastSha}`)
console.log(`   https://github.com/${slug}/commit/${lastSha}`)
if (lastSha !== headSha) {
  console.log("\n👉 建议接着跑 gh-sync.mjs，把本地分支也对齐到同一个提交：")
  console.log(`   node gh-sync.mjs ${lastSha} --branch ${BRANCH}`)
}
