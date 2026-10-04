#!/usr/bin/env node
'use strict';
/* 包内核验（发版用）：把一个 electron-builder 产物目录/asar 逐条验干净，不挑文件比对。
 *
 * 用法：
 *   node tools/verifypack.js                       # 默认查 dist/win-unpacked，版本取 package.json
 *   node tools/verifypack.js --version 1.0.14
 *   node tools/verifypack.js --res D:/work/_rel1014/dist/win-unpacked/resources
 *   node tools/verifypack.js --need "src/main/services/compliance.js=enforceMaxMB" \
 *                            --need "src/renderer/app.js=体积不限" \
 *                            --absent "src/renderer/app.js=超 10MB 压缩"
 *
 * 为什么要有它（踩过的坑，别重走）：
 *  1) @electron/asar 的 listPackage 返回的路径**带前导反斜杠**（`\package.json`），
 *     extractFile / statFile 无论传「原始串」还是「正斜杠串」都可能 not found
 *     ⇒ 本脚本一律走 **extractAll 到临时目录**，再当普通目录读（稳、可复算）。
 *  2) 内置二进制（adb / ffmpeg / adbkeyboard）由 build.extraResources 放在 asar **外面**的
 *     `resources/<name>/`，不在 asar 里 ⇒ 必须查产物目录，否则会误报「没随包」。
 *  3) 版本号要「三处一致」：package.json（源码）/ asar 内 package.json / 产物文件名。
 *
 * 退出码：有 FAIL 即 1（可直接接进流水线）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === '--' + name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const WINUNPACKED = arg('dir', path.join(ROOT, 'dist', 'win-unpacked'));
const RES = arg('res', path.join(WINUNPACKED, 'resources'));
const ASAR = arg('asar', path.join(RES, 'app.asar'));
const EXPECT_VER = arg('version', (() => { try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return ''; } })());
const NEED = argAll('need').map(s => { const i = s.lastIndexOf('='); return { file: s.slice(0, i), sub: s.slice(i + 1) }; });
const ABSENT = argAll('absent').map(s => { const i = s.lastIndexOf('='); return { file: s.slice(0, i), sub: s.slice(i + 1) }; });

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  cond ? pass++ : fail++;
};
const walk = (dir, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

(async () => {
  const asar = require(path.join(ROOT, 'node_modules', '@electron/asar'));

  ok('asar 存在', fs.existsSync(ASAR), fs.existsSync(ASAR) ? (fs.statSync(ASAR).size / 1048576).toFixed(1) + ' MB · ' + ASAR : ASAR);

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blv-verifypack-'));
  await asar.extractAll(ASAR, TMP);
  const files = walk(TMP, []);
  const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  ok('asar 解包非空（文件数 / 体积）', files.length > 1500 && bytes > 20 * 1048576,
    `${files.length} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`);

  const read = (rel) => fs.readFileSync(path.join(TMP, rel), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  if (EXPECT_VER) ok(`asar 内 package.json 版本 == ${EXPECT_VER}`, pkg.version === EXPECT_VER, pkg.version);
  ok('asar 内 name 正确', pkg.name === 'dewu-bluev-publisher', pkg.name);

  const srcVer = (() => { try { return JSON.parse(read('package.json')).version; } catch (e) { return ''; } })();
  const fname = fs.existsSync(path.join(ROOT, 'dist')) ? (fs.readdirSync(path.join(ROOT, 'dist')).find(n => n.endsWith('.exe')) || '') : '';
  ok('版本三处一致（源码 / asar 内 / 产物文件名）',
    srcVer === EXPECT_VER && (!fname || fname.includes(EXPECT_VER)),
    `源码 ${EXPECT_VER} · asar ${srcVer} · 产物 ${fname || '(未找到 exe)'}`);

  // 关键源码文件必须在（防「asar 只打进半棵树」这类静默事故）
  for (const rel of ['src/main/index.js', 'src/main/services/compliance.js', 'src/main/services/publisher.js',
    'src/main/services/adb.js', 'src/renderer/app.js', 'src/renderer/index.html']) {
    let has = false; try { has = fs.statSync(path.join(TMP, rel)).size > 0; } catch (e) {}
    ok(`关键源码在包里：${rel}`, has);
  }

  // 内置二进制（在 asar 外面的 resources/ 下，见文件头第 2 条）
  for (const [name, must] of [['adb', 'adb.exe'], ['ffmpeg', 'ffmpeg.exe'], ['adbkeyboard', 'AdbKeyboard.apk']]) {
    const d = path.join(RES, name);
    const list = fs.existsSync(d) ? fs.readdirSync(d) : [];
    ok(`内置 ${name}/ 随包（含 ${must}）`, list.length > 0 && fs.existsSync(path.join(d, must)),
      list.length ? list.join(' ') : '（目录不存在：' + d + '）');
  }

  // 调用方指定的正/反向断言（发版时逐条写清「这版该有什么、不该有什么」）
  for (const { file, sub } of NEED) {
    let body = ''; try { body = read(file); } catch (e) { body = ''; }
    ok(`须在包里：${file} 含「${sub}」`, body.includes(sub), body ? `文件 ${body.length} 字符` : '文件读不到');
  }
  for (const { file, sub } of ABSENT) {
    let body = ''; try { body = read(file); } catch (e) { body = ''; }
    ok(`不得在包里：${file} 不含「${sub}」`, !!body && !body.includes(sub));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n共 ${pass + fail} 项：PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
