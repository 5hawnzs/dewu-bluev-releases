#!/usr/bin/env node
'use strict';
/**
 * 把 vendor/dewu/ 下**分卷存放**的得物安装包拼回单文件。
 *
 * 为什么要分卷（2026-10-08 实测踩到）：
 *   Gitee 与 GitHub 都是「**单文件超过 100 MiB 就拒绝整次 push**」（不是只跳过那个文件）。
 *   得物安装包 133,315,131 字节 = 127.1 MiB，直接进 git 会把整次推送打回来：
 *     remote: ... size: 120.666MB, exceeds quota 100MB
 *   而且 gzip -9 压到 120.6 MiB 也还是过不去 ⇒ 只能切成 <100 MiB 的片段存放。
 *   片段进 git，拼回来的单文件不进（已写进 .gitignore）。
 *
 * 用法：
 *   node tools/dewuapk-assemble.js           缺了或对不上才拼（幂等）
 *   node tools/dewuapk-assemble.js --force   无条件重拼
 *   node tools/dewuapk-assemble.js --check   只校验、一个字节都不写（CI / 打包前自检）
 *
 * 退出码：0 = 产物已就绪且与台账一致；1 = 片段缺/坏或拼回来对不上（会把半成品删掉，不留坏文件）
 *
 * ★ 判据只用「片段字节数之和」与「拼回来之后的 md5」——不依赖片段的文件名规律之外的东西，
 *   片段数从 2 变成 3 也不需要改这里（按名字排序后顺序拼接即可）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'vendor', 'dewu');
const dewuapk = require(path.join(ROOT, 'src', 'main', 'services', 'dewuapk.js'));

const FILE = dewuapk.FILE;                 // dewu_6.0.5.apk
const BYTES = dewuapk.BYTES;               // 133,315,131
const MD5 = dewuapk.MD5;                   // 50092bcc…
const OUT = path.join(DIR, FILE);

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const CHECK = argv.includes('--check');

function md5File(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

/** 按名字排序取片段。`dewu_6.0.5.apk.part01` / `.part02` … */
function parts() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .filter(f => f.startsWith(FILE + '.part'))
    .sort()
    .map(f => path.join(DIR, f));
}

function bail(msg) {
  console.error('❌ ' + msg);
  process.exit(1);
}

const ps = parts();
if (!ps.length) {
  bail(`vendor/dewu 下没有 ${FILE}.part* 片段 —— 仓库不完整（git clone 没跑完？还是片段被 .gitignore 吃掉了？）`);
}

const sum = ps.reduce((n, p) => n + fs.statSync(p).size, 0);
if (sum !== BYTES) {
  bail(`片段字节数之和 = ${sum}，应该是 ${BYTES}（${ps.length} 片）—— 有片段缺了或坏了，别拿它打包`);
}
if (ps.some(p => fs.statSync(p).size === 0)) bail('有 0 字节的片段');

// 已经是对的那一份就直接收工（幂等：反复调用不再读写 133 MB）
if (!FORCE && fs.existsSync(OUT)) {
  const st = fs.statSync(OUT);
  if (st.size === BYTES && md5File(OUT) === MD5) {
    console.log(`✅ ${FILE} 已就绪（${BYTES} 字节 / md5 ${MD5.slice(0, 8)}…），未改动`);
    process.exit(0);
  }
  if (CHECK) bail(`${FILE} 在，但与台账对不上（${st.size} 字节）`);
}

if (CHECK) {
  console.log(`✅ 片段齐（${ps.length} 片，合计 ${sum} 字节），但没有拼回来的 ${FILE} —— --check 模式不写盘`);
  process.exit(0);
}

console.log(`拼接 ${ps.length} 片 → ${FILE}`);
console.log('  ' + ps.map(p => path.basename(p) + '(' + fs.statSync(p).size + ')').join(' + '));

// 直接顺序追加：不用一次性把 133 MB 读进内存
const tmp = OUT + '.assembling';
try {
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const p of ps) fs.writeSync(fd, fs.readFileSync(p));
  } finally {
    fs.closeSync(fd);
  }

  const sz = fs.statSync(tmp).size;
  if (sz !== BYTES) throw new Error(`拼出来 ${sz} 字节，应该是 ${BYTES}`);
  const hex = md5File(tmp);
  if (hex !== MD5) throw new Error(`拼出来 md5 ${hex}，台账是 ${MD5} —— 片段坏了或版本不对`);

  fs.renameSync(tmp, OUT);
} catch (e) {
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  // 半成品一律不留（同 dewuapk.saveAs 的口径：不许留个看起来像成品的东西）
  try { if (fs.existsSync(OUT) && fs.statSync(OUT).size !== BYTES) fs.unlinkSync(OUT); } catch {}
  bail(e.message);
}

console.log(`✅ 拼好了：${OUT}（${BYTES} 字节 / md5 ${MD5}）`);
// 顺带把「git 会不会误收这个产物」提醒一句（.gitignore 里那条是配套的）
try {
  const ignored = execFileSync('git', ['check-ignore', '-q', OUT], { cwd: ROOT, stdio: 'ignore' });
  console.log('   （git 已忽略这个单文件；进仓库的是片段）');
} catch {
  console.log(`   ⚠️ 注意：${FILE} 现在**没有被 .gitignore 忽略** —— 别把它 git add 进去（127 MiB 会被远端整次拒收）`);
}
