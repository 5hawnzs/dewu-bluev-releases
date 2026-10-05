/**
 * 把 GitHub 侧生成的 commit 对象在本地重建出来，让本地分支与远端指向同一个提交。
 *
 * 背景：gh-push.mjs 走 API 推上去的 commit，SHA 往往与本地 git commit 不同
 * （GitHub 归一化了提交消息结尾与时间序列化），但 tree 完全一致。
 * 此时本地 main 与 origin/main 会「内容相同、SHA 不同」地分叉，之后 git pull 会尝试 merge，很烦。
 * 而 github.com 不通又 fetch 不到那个对象 —— 那就按 API 返回的字段把它拼出来。
 *
 * 安全性：用 git hash-object -t commit -w --stdin 写入，git 自己会做 fsck 与哈希校验；
 * 拼错了只会得到另一个 SHA（或直接拒绝写入），不可能写坏仓库。
 *
 * 用法：
 *   node gh-sync.mjs <github侧commit sha> [--branch main]
 */
import { execFileSync } from "node:child_process"
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"

const argv = process.argv.slice(2)
const TARGET = argv.find((a) => /^[0-9a-f]{40}$/i.test(a))
const bi = argv.indexOf("--branch")
const BRANCH = bi >= 0 && argv[bi + 1] ? argv[bi + 1] : "main"

if (!TARGET) {
  console.error("用法: node gh-sync.mjs <github侧commit sha> [--branch main]")
  process.exit(1)
}

const REPO = process.cwd()
const git = (args, opts = {}) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", ...opts })

/* ---------- 写 ref（带「回读验证 + 不落盘时回退写文件」）----------
 * ★ 2026-09-22 实测踩到（Windows / PortableGit + 沙箱），而且比一开始判断的更深：
 *   `git update-ref refs/remotes/origin/main <sha>` 在这个环境下**返回 rc=0（成功）却根本不落盘**
 *   ⇒ 脚本接着打印「✅ refs/heads/main 与 refs/remotes/origin/main 均已指向 …」= **假成功**，
 *     而 `git rev-parse refs/remotes/origin/main` 其实报 `unknown revision`、`git branch -a` 里也没有。
 *   第一次归因是「父目录 `.git/refs/remotes/origin/` 不存在、该环境 update-ref 不会 mkdir -p」，
 *   但**补齐父目录后仍然写不进**（`refs/heads/main` 之所以能写，只是因为它的父目录早就存在）。
 *   ⇒ 对策（与项目「不许让日志骗人」同一原则）：
 *     ① 先试 update-ref；失败则**直接写松散 ref 文件**（git 的 refs 本来就是 `<sha>\n` 纯文本）；
 *     ② 无论走哪条路，都**回读验证** + `cat-file -e` 确认对象在本地，值不对就报错退出。
 */
function setRef(ref, sha, { fatal = true } = {}) {
  const gitDir = git(["rev-parse", "--git-dir"]).trim()
  const file = join(gitDir, ref)
  const dir = dirname(file)
  // ⚠️ 别写成 `if (!existsSync(dir)) mkdirSync(...)`：2026-09-22 实测该沙箱下
  //    `existsSync` 会给出**过期视图**（目录实际不在、它却说在）⇒ 跳过 mkdir ⇒ 下一步 ENOENT。
  //    但**无条件 mkdirSync(recursive) 也不保险**：它同样会被「视图短路」
  //    （node 认为目录已存在 ⇒ 直接返回、不做系统调用）。实测就卡在这里：
  //      mkdirSync 报成功、`existsSync(dir)` 也给 true，
  //      可 `writeFileSync` 仍报 `ENOENT … .git/refs/remotes/origin/main`，
  //      而 bash 侧 `ls .git/refs/` 确认 `remotes/` 并没真的建出来。
  //    ⇒ **唯一可信的判据是「回读」**（下面 ③），它不依赖任何视图状态。
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 交给 ③ 的回读判定 */
  }

  // ① 先走官方 update-ref（正常环境一步到位）
  let ok = false
  try {
    git(["update-ref", ref, sha])
    ok = git(["rev-parse", ref]).trim() === sha
  } catch {
    ok = false
  }
  // ② 回退：直接写松散 ref 文件 —— git 的 refs 本来就是 `<sha>\n` 纯文本，
  //    这样写出来的 ref 是合法的、`git rev-parse` 认。
  if (!ok) {
    try {
      writeFileSync(file, sha + "\n")
    } catch {
      /* 交给 ③ 的回读判定 */
    }
  }

  // ③ 回读验证（**唯一可信的判据**，绝不凭「命令没报错」宣布成功）+ 对象存在性
  let got = "(ref 不存在)"
  try {
    got = git(["rev-parse", ref]).trim()
  } catch {
    /* 保持 (ref 不存在) */
  }
  let objOk = true
  try {
    git(["cat-file", "-e", sha])
  } catch {
    objOk = false
  }
  if (got === sha && objOk) return got

  const why = `期望 ${sha}，实际 ${got}` + (objOk ? "" : "（且对象不在本地对象库）")
  if (fatal) {
    console.error(`!! 写 ref 失败：${ref} ${why}`)
    console.error(`   （update-ref 与直接写松散文件都试过了，请人工检查 ${file}）`)
    process.exit(1)
  }
  // 非致命（如 refs/remotes/**）：**如实说明 + 给手工补救命令**，绝不谎报成功
  console.error(`⚠️  写 ref 未成功（非致命）：${ref} ${why}`)
  console.error(`    实测该沙箱下 node 无法在 .git/refs/ 下**新建目录**（mkdirSync 报成功，`)
  console.error(`    writeFileSync 仍报 ENOENT）。本地分支的**内容**不受影响（refs/heads 已对齐），`)
  console.error(`    只是 \`git status\` 看不出与远端的对应关系。手工补一次即可（Git Bash）：`)
  console.error(`      mkdir -p "${dir}" && echo ${sha} > "${file}"`)
  return null
}

/* ---------- 解析 owner/repo 与 token ----------
 * ⚠️ 与 gh-push.mjs 同一套逻辑，别各写各的（2026-09-21 实测踩到）：
 *   本脚本原来只从 origin 抠 `user:token@github.com/owner/repo`，
 *   而真实仓库的 origin 常常是干净的 `https://github.com/owner/repo.git`
 *   （凭据由 credential.helper=store 存在 ~/.git-credentials）→ 直接报
 *   「无法从 origin 解析出 token」而完全不可用。
 * 另外 slug 的正则要防「把 .git 吃进 slug」：
 *   `(.+?)(?:\.git)?$` 会匹配出 `owner/repo.git`（API 路径变成 /repos/owner/repo.git → 404），
 *   必须用 `([^/\s]+?)(?:\.git)?$` 才切得干净。
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

// ★ 2026-09-22 补：**连接级重试**（与 gh-push.mjs 同一根因）。
//   实测：`api.github.com` 在能通与不能通之间**间歇性**跳变（同一条命令连跑 6 次可能全失败），
//   Node 内置 fetch 的 connectTimeout 只有 10s、且不走 HTTP_PROXY。
//   本脚本读写都很轻，重试代价可忽略；GET /git/commits 是纯读，重试绝对安全。
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

/* ---------- 1. 取远端那个提交 ---------- */
const c = await gh("GET", `/git/commits/${TARGET}`)
const localTree = git(["rev-parse", "HEAD^{tree}"]).trim()
console.log("远端提交 tree :", c.tree.sha)
console.log("本地提交 tree :", localTree)
// ★ 2026-09-22 补：`--no-ref`（物化**祖先**提交对象）时这条校验不适用 ——
//   中间提交的 tree 当然不等于**当前 HEAD** 的 tree。安全性由后面的
//   `written === TARGET` 保证：sha 本身就是内容哈希，写进去的字节与远端逐字节相同。
const NO_REF_EARLY = argv.includes("--no-ref")
if (c.tree.sha !== localTree && !NO_REF_EARLY) {
  console.error("!! tree 不一致（内容不同），拒绝继续。请人工核对。")
  process.exit(1)
}
console.log(NO_REF_EARLY && c.tree.sha !== localTree
  ? "ℹ️ --no-ref 模式：这是要物化的**祖先**提交，其 tree 与本 HEAD 不同属正常（只写对象、不动 ref）\n"
  : "✅ tree 一致（内容完全相同），只是 commit 对象不同\n")
console.log("message   :", JSON.stringify(c.message))
console.log("author    :", c.author.name, c.author.email, c.author.date)
console.log("committer :", c.committer.name, c.committer.email, c.committer.date)

/* ---------- 2. 穷举字节组合复现 commit 对象 ---------- */
// 注意：GET /git/commits 的 parents 是对象数组 [{sha,url,...}]，不是字符串数组
const parents = (c.parents || []).map((p) => (typeof p === "string" ? p : p.sha))
const base = c.message.replace(/\n+$/, "")

// ★ 2026-09-24 修（实测踩到，后果是 ref 指向一个本地不存在的对象）：
//   **author 与 committer 的时间戳必须各自取**，不能都用 committer 的。
//   证据：本仓库一次 `git commit --amend` 之后，API 返回
//     author.date    = 2026-09-23T16:05:24Z
//     committer.date = 2026-09-23T16:05:54Z   ← **差 30 秒**
//   老写法 `tzSecLocal`（取自 committer）同时写进 author 行 ⇒ 穷举再多后缀/时区也不可能命中
//   ⇒ 脚本报「未能在本地复现该 commit 对象」并**只对齐 refs/heads/main**；
//     调用方若顺手把 refs/remotes/origin/main 指向远端 sha，就得到一个本地没有的对象 ⇒
//     `error: refs/remotes/origin/main: invalid sha1 pointer <sha>` + `[gone]`（比不写 ref 还糟）。
//   ★ 凡是改写历史的操作（amend / rebase / cherry-pick / filter-branch）都会让两者不等，
//     所以这不是边角情况，而是「每次 amend 必踩」。
const secA = Math.floor(new Date(c.author.date).getTime() / 1000)
const secC = Math.floor(new Date(c.committer.date).getTime() / 1000)

const localOffset = -new Date().getTimezoneOffset() // 分钟，东八区 = 480
const fmtTz = (mins) => {
  const sign = mins >= 0 ? "+" : "-"
  const a = Math.abs(mins)
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`
}
const tzLocal = fmtTz(localOffset)

// ★ 时区同样别只信进程 TZ（进程 TZ=UTC 时会漏掉提交里真实的 +0800）：
//   先借一个「tree 与远端相同」的本地提交，从它**原始 header** 里读真实 offset 当候选。
let tzFromLocal = []
try {
  for (const sha of git(["rev-list", "--max-count=80", "HEAD"]).trim().split("\n")) {
    if (!sha) continue
    if (git(["rev-parse", sha + "^{tree}"]).trim() !== c.tree.sha) continue
    const raw = git(["cat-file", "commit", sha])
    tzFromLocal = (raw.match(/^[ac]\w+ .* [+-]\d{4}$/gm) || []).map((l) => l.slice(-5))
    break
  }
} catch (e) { /* HEAD 不可用时忽略，仍靠进程 TZ 兜底 */ }
const tzs = [...new Set(["+0000", tzLocal, ...tzFromLocal])]

let hit = null
for (const suffix of ["", "\n", "\n\n", "\n\n\n", "\n\n\n\n"]) {
  for (const tzA of tzs) {
    for (const tzC of tzs) {
      const obj =
        `tree ${c.tree.sha}\n` +
        parents.map((p) => `parent ${p}\n`).join("") +
        `author ${c.author.name} <${c.author.email}> ${secA} ${tzA}\n` +
        `committer ${c.committer.name} <${c.committer.email}> ${secC} ${tzC}\n` +
        `\n` +
        base +
        suffix
      const sha = git(["hash-object", "-t", "commit", "--stdin"], { input: obj }).trim()
      if (sha === TARGET) {
        hit = { obj, suffix: JSON.stringify(suffix), tzA, tzC }
        break
      }
    }
    if (hit) break
  }
  if (hit) break
}

if (!hit) {
  console.log("\n⚠️ 未能在本地复现该 commit 对象（GitHub 的字节序列化与预期不同）")
  console.log("   远端内容没问题，本地可等 github.com 可达后再对齐：")
  console.log(`   git fetch origin && git reset --hard origin/${BRANCH}`)
  process.exit(0)
}

console.log(`\n复现成功：消息后缀 ${hit.suffix}，author tz ${hit.tzA}，committer tz ${hit.tzC}`)
const written = git(["hash-object", "-t", "commit", "-w", "--stdin"], {
  input: hit.obj,
}).trim()
if (written !== TARGET) {
  console.error("!! 写入后 SHA 与目标不符，不做 ref 更新")
  process.exit(1)
}
console.log("✅ commit 对象已写入本地对象库:", written)

/* ---------- 3. 本地分支与远端跟踪引用一起对齐 ---------- */
// ★ 2026-09-22 补：`--no-ref` = **只把 commit 对象写进本地对象库，不动任何 ref**。
//   为什么需要：gh-push 现在能推**多个提交**（本地领先 N 个时逐个建对象），
//   但 GitHub 会归一化消息/时间 ⇒ 中间那些提交在 GitHub 侧是**新的 sha**，本地没有。
//   于是「本地 main 指到最后一个远端 sha」之后，它的**父对象在本地缺失** ⇒
//   `git log` 直接报 `Could not read <中间sha>` / `Failed to traverse parents`（历史断了）。
//   逐一把中间 sha 用 `--no-ref` 物化进本地对象库即可补齐。
const NO_REF = argv.includes("--no-ref")
if (NO_REF) {
  console.log(`\n--no-ref：只写入对象，不更新 ref（当前 HEAD 仍是 ${git(["rev-parse", "--short", "HEAD"]).trim()}）`)
  process.exit(0)
}
const old = git(["rev-parse", "HEAD"]).trim()
if (old !== TARGET) {
  setRef(`refs/heads/${BRANCH}`, TARGET)
}
// `refs/remotes/**` 用**非致命**模式：该沙箱下 node 写不进这个目录（详见 setRef 注释），
// 但它只影响 `git status` 的 ahead/behind 显示、**不影响内容一致性** ⇒ 不该让整步失败。
const rref = setRef(`refs/remotes/origin/${BRANCH}`, TARGET, { fatal: false })
console.log(`✅ refs/heads/${BRANCH} = ${git(["rev-parse", `refs/heads/${BRANCH}`]).trim()}`)
if (rref) {
  console.log(`✅ refs/remotes/origin/${BRANCH} = ${rref}`)
} else {
  console.log(`⚠️ refs/remotes/origin/${BRANCH} 未写成功（原因与手工补救见上）—— **内容不受影响**`)
}
if (old !== TARGET) console.log("   旧提交", old.slice(0, 7), "成为游离对象，不影响工作区内容")

console.log("\n工作区状态：")
console.log(git(["status", "--short"]).trim() || "  （干净，无待提交改动）")
console.log(`\n提交地址：https://github.com/${slug}/commit/${TARGET}`)
