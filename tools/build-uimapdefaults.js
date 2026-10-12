#!/usr/bin/env node
'use strict';
/**
 * 把一份抓好的 UI 定位表（uiMap）**灌成出厂内置表** `src/main/uimapdefaults.js`。
 *
 * 什么时候用：
 *   · 得物改版 ⇒ 在真机上「抓取页面结构 → 导入 UI 定位表」⇒ 再用本工具把新表打进源码 ⇒ **重发包**。
 *     （内置表的代价就在这：改版必须重打包。用户 2026-10-08 已接受。）
 *
 * 用法：
 *   node tools/build-uimapdefaults.js                         # 读本机 %APPDATA%/dewu-bluev-publisher/config.json 里的 publish.uiMap
 *   node tools/build-uimapdefaults.js --in D:\uiMap.json      # 读一份导出的 uiMap（publish.dump 生成的候选表也行）
 *   node tools/build-uimapdefaults.js --dry                   # 只校验与打印，不写文件
 *
 * ★★ 硬规矩（写进去之前必须过，过不了直接退出码 1，绝不生成一张"可能点偏"的表）：
 *   ① `steps` 必须非空；② 所有写死的 `tapXY` 坐标必须落在**该表的坐标系**内；
 *   ③ 坐标系戳（`screen`）优先取源表自带的（2026-10-04 起 `publish.dump` 会写）；
 *      源表没有时退到 `--screen WxH`（默认 1080x1920），并且**要求这些坐标装不进更小的常见档**
 *      （否则坐标不唯一、戳是猜的 —— 那就宁可不写，让运行时退回「逐点越界」那条判据，不误拦）。
 *
 * ★ 本工具**只写 `src/main/uimapdefaults.js`**，不碰 config.json、不碰 store.js。
 *   `store.get('publish.uiMap')` 的兜底在 store.withBuiltinMap()（读时兜底、不写回）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'main', 'uimapdefaults.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

function defaultConfigPath() {
  const appDir = 'dewu-bluev-publisher';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', appDir, 'config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', appDir, 'config.json');
  return path.join(os.homedir(), '.config', appDir, 'config.json');
}

const inFile = arg('in', defaultConfigPath());
const dry = !!arg('dry', false);
const screenArg = arg('screen', '1080x1920');

let um;
if (inFile && inFile !== true) {
  let raw;
  try {
    raw = fs.readFileSync(String(inFile), 'utf8');
  } catch (e) {
    console.error('★ 读不动输入文件：' + inFile + '（' + (e && e.code || e.message) + '）');
    console.error('  用 --in <文件> 指定一份 uiMap.json，或先跑一次 App 让 ' + defaultConfigPath() + ' 生成。');
    process.exit(1);
  }
  let j;
  try {
    j = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('★ 输入文件不是合法 JSON：' + inFile); process.exit(1);
  }
  um = j.publish && j.publish.uiMap ? j.publish.uiMap : j;   // 整份 config.json 或单份 uiMap 都能用
} else {
  console.error('★ 读不到输入文件：' + inFile); process.exit(1);
}
if (!um || !Array.isArray(um.steps) || !um.steps.length) {
  console.error('★ 源表里没有 steps（不是一份能用的定位表）'); process.exit(1);
}

// ---- 校验 ① 坐标 ----
const pts = [];
for (const [lbl, arr] of [['steps', um.steps], ['videoSteps', um.videoSteps || []]]) {
  arr.forEach((s, i) => {
    if (!s || s.action !== 'tapXY') return;
    for (const one of String(s.value).split(';')) {
      const [x, y] = one.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        console.error(`★ ${lbl}[${i}] 的 tapXY 坐标读不出来：${JSON.stringify(s.value)}`); process.exit(1);
      }
      pts.push({ lbl, i, x, y, raw: one });
    }
  });
}
console.log(`源表：steps=${um.steps.length} videoSteps=${(um.videoSteps || []).length} tapXY 点=${pts.length}`);

// ---- 校验 ③ 坐标系戳 ----
let screen;
if (um.screen && Number(um.screen.w) && Number(um.screen.h)) {
  screen = { w: Number(um.screen.w), h: Number(um.screen.h), landscape: !!um.screen.landscape, at: um.screen.at || um.generatedAt || Date.now() };
  console.log('坐标系戳来自源表自带：' + screen.w + 'x' + screen.h);
} else {
  const m = String(screenArg).match(/^(\d+)x(\d+)$/);
  if (!m) { console.error('★ --screen 要写成 WxH，例如 1080x1920'); process.exit(1); }
  const w = Number(m[1]), h = Number(m[2]);
  const fits = pts.every(p => p.x >= 0 && p.y >= 0 && p.x <= w - 1 && p.y <= h - 1);
  if (!fits) {
    console.error(`★ 表里有坐标落在 ${w}x${h} 之外 ⇒ 不许猜坐标系（换个 --screen，或先在真机重新抓表）`);
    console.error('   越界的点：' + JSON.stringify(pts.filter(p => p.x > w - 1 || p.y > h - 1).map(p => p.raw)));
    process.exit(1);
  }
  // 「唯一性」自检：不许存在明显更小的常见档也能装下（那说明这个 w/h 是猜的）
  const common = [[720, 1280], [900, 1600], [1080, 1920]].filter(s => s[0] < w && s[1] < h);
  const smaller = common.filter(s => pts.every(p => p.x <= s[0] - 1 && p.y <= s[1] - 1));
  if (smaller.length) {
    console.error(`★ 这些坐标也装得进 ${smaller.map(s => s.join('x')).join(' / ')} ⇒ 坐标系不唯一，不能拿 ${w}x${h} 当戳。`);
    console.error('   请改用源表自带的 screen 戳（真机上「抓取页面结构」会写），或显式指定正确的 --screen。');
    process.exit(1);
  }
  screen = { w, h, landscape: w > h, at: um.generatedAt || Date.now() };
  console.log('坐标系戳按 --screen 推断：' + w + 'x' + h + '（并已过「唯一性」自检）');
}
if (screen.landscape === undefined) screen.landscape = screen.w > screen.h;
// 新抓取的表保留实测 DPI；也可用显式参数补齐经过现场核对的旧表。
const density = Number(um.screen && um.screen.density) || Number(arg('density', 0));
if (density) {
  if (!Number.isInteger(density) || density < 120 || density > 640) throw new Error('DPI 参数必须在 120–640 范围内');
  screen.density = density;
}

const out = {
  package: um.package || '',
  generatedAt: um.generatedAt || Date.now(),
  screen,
  note: um.note || '',
  videoNote: um.videoNote || '',
  steps: um.steps,
  videoSteps: um.videoSteps || []
};

const B = '`';
const header = [
  "'use strict';",
  '/**',
  ' * ★★ 出厂内置的 **UI 定位表**（publish.uiMap）—— 打进安装包，装上即用。',
  ' *   ★ 本文件由 `node tools/build-uimapdefaults.js` 生成，**别手改** —— 改完重跑会被覆盖。',
  ' *',
  ' * 规矩（与 clouddefaults / llmdefaults 同一套）：',
  ' *   ' + B + "store.get('publish.uiMap')" + B + ' 只在**本机没有这个键**（undefined）时兜底成这里的表，',
  ' *   **绝不写回 config.json** ⇒ 以后换新表、重发包，各台升级后自动跟随（不会被焊死在旧表上）。',
  ' *   ★ 显式写成 null 是另一回事：「我就是要没有表」—— 那时**不许**被内置值顶掉。',
  ' *   ★ 用户自己抓/导入的表**优先于**这里。兜底实现在 store.withBuiltinMap()。',
  ' *',
  ' * ★ screen 是**抓取时的坐标系戳**：运行时（uimap.screenMismatch）拿它和当下设备尺寸比，',
  ' *   对不上就**当场拦下**，而不是让写死的坐标静默点偏（input tap 对越界坐标 rc=0、什么都不点）。',
  ' *   源表没带 screen 时由 build 工具按 --screen 推断，且必须过「唯一性」自检才会写进来。',
  ' */',
  'module.exports = '
].join('\n');
const text = header + JSON.stringify(out, null, 2) + ';\n';

if (dry) { console.log('--dry：只校验，不写盘（' + Buffer.byteLength(text) + ' 字节）'); process.exit(0); }
fs.writeFileSync(OUT, text, 'utf8');
console.log('已写出 ' + path.relative(ROOT, OUT) + '（' + Buffer.byteLength(text) + ' 字节）');
console.log('下一步：node tools/run-all.js defaultstest  然后重打包。');
