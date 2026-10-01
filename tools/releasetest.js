'use strict';
/*
 * 发版工具（tools/upload-release.js）纯逻辑回归 —— 纯 Node，不联网、不碰 COS、不读 dist。
 *
 * 为什么单独一套：这条链上**失败是静默的**。
 *   - `latest.yml` 里的 path 读错 ⇒ 客户端按错名字下载 ⇒ 全员 404，但本机看不出任何异常；
 *   - 源上同版本号被覆盖 ⇒ 客户端判「没有新版本」⇒ 用户永远收不到更新，还查不出原因；
 *   - 把「便携版」exe 传上去 ⇒ portable 根本不支持自动更新，等于发了个用不了的包。
 * 这三件事都发生在「上传」这一刻，而真实上传没法在回归里跑（要凭据、要联网），
 * 所以把判定逻辑抽成纯函数（parseManifest / pickInstaller / versionGate）单独守。
 *
 * 用法：node tools/releasetest.js
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { parseManifest, humanSize, padTo, pickInstaller, versionGate } = require(path.join(ROOT, 'tools/upload-release.js'));

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) bad++;
};

/** 与 padTo 同一套宽度规则（中文按 2 格），测试里独立实现一遍，免得抄错自己 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

// electron-builder 24.13.3 真实生成的 latest.yml 格式（中文产物名 + 单文件）
const REAL_YML = [
  'version: 1.0.0',
  'files:',
  '  - url: 得物蓝V素材发布工具-1.0.0-x64-win.exe',
  '    sha512: 4XmKfxu2+lgFNc3RM5FYG9r/HMISpPKWbs5WbTuPx7+luOR/Rfp3QU6JGza4Iim1Eg5lVOohIoI0AzMTUbKOgA==',
  '    size: 89151447',
  'path: 得物蓝V素材发布工具-1.0.0-x64-win.exe',
  'sha512: 4XmKfxu2+lgFNc3RM5FYG9r/HMISpPKWbs5WbTuPx7+luOR/Rfp3QU6JGza4Iim1Eg5lVOohIoI0AzMTUbKOgA==',
  "releaseDate: '2026-10-01T10:08:14.585Z'",
  ''
].join('\n');

console.log('A. parseManifest —— 读错 path 就是全员 404\n');

{
  const m = parseManifest(REAL_YML);
  ok('真实 latest.yml：version 读对', m.version === '1.0.0', m.version);
  ok('真实 latest.yml：path 读对（完整中文名，没被截断）',
    m.path === '得物蓝V素材发布工具-1.0.0-x64-win.exe', m.path);
  ok('真实 latest.yml：files 里恰好 1 条且与 path 一致',
    m.files.length === 1 && m.files[0] === m.path, JSON.stringify(m.files));
}

{
  const m = parseManifest(REAL_YML.replace(/\n/g, '\r\n'));
  ok('CRLF 换行：version / path 都不带尾随 \\r（否则名字对不上就是 404）',
    m.version === '1.0.0' && m.path === '得物蓝V素材发布工具-1.0.0-x64-win.exe',
    JSON.stringify([m.version, m.path]));
}

{
  const m = parseManifest('version: 2.1.0\nfiles:\n  - url: my app-2.1.0-x64-win.exe\npath: my app-2.1.0-x64-win.exe\n');
  ok('文件名里带空格不会被截断', m.path === 'my app-2.1.0-x64-win.exe' && m.files[0] === 'my app-2.1.0-x64-win.exe', m.path);
}

{
  const m = parseManifest('version: 2.1.0\nfiles:\n  - url: a-2.1.0.exe\n  - url: b-2.1.0.exe\npath: a-2.1.0.exe\n');
  ok('多文件（win + mac）时顺序保持、一条不丢', m.files.length === 2 && m.files[0] === 'a-2.1.0.exe' && m.files[1] === 'b-2.1.0.exe', JSON.stringify(m.files));
}

{
  const m = parseManifest('');
  ok('空文本返回空值而不是抛异常（上层才能给出「先打包」的提示）',
    m.version === '' && m.path === '' && m.files.length === 0, JSON.stringify(m));
}

{
  const m = parseManifest('files:\n  - url: only-1.0.0.exe\n');
  ok('只有 url、没有 path 时不编造 path（宁可让上层报错，也不能瞎猜）',
    m.path === '' && m.files.length === 1, JSON.stringify(m));
}

console.log('\nB. pickInstaller —— 便携版传上去等于发了个用不了的包\n');

{
  const picked = pickInstaller([
    '得物蓝V素材发布工具-1.0.0-x64-win.exe',
    '得物蓝V素材发布工具-1.0.0-x64-便携版.exe',
    'latest.yml',
    '得物蓝V素材发布工具-1.0.0-x64-win.exe.blockmap',
    'builder-debug.yml'
  ]);
  ok('只挑出安装版，恰好 1 个', picked.length === 1, JSON.stringify(picked));
  ok('挑出来的里面绝不含「便携版」', picked.every(f => !f.includes('便携版')), JSON.stringify(picked));
  ok('挑出来的就是那个 -win.exe', picked[0] === '得物蓝V素材发布工具-1.0.0-x64-win.exe', picked[0]);
}

{
  const picked = pickInstaller(['只-有-便携版-1.0.0-便携版.exe']);
  ok('只有便携版时返回空数组（上层据此报错，绝不静默传错文件）',
    Array.isArray(picked) && picked.length === 0, JSON.stringify(picked));
}

console.log('\nC. versionGate —— 不涨版本号就覆盖，用户永远收不到更新\n');

{
  const g = versionGate('', '2.0.0', false);
  ok('源上读不出清单时**不拦**（读不出来不等于已存在同版本）', g.block === false, JSON.stringify(g));
}
{
  const g = versionGate('1.0.0', '2.0.0', false);
  ok('版本号涨了：放行', g.block === false, JSON.stringify(g));
}
{
  const g = versionGate('1.0.0', '1.0.0', false);
  ok('源上已是同版本号且没加 --force：**必须拦住**', g.block === true, JSON.stringify(g));
}
{
  const g = versionGate('1.0.0', '1.0.0', true);
  ok('同版本号 + --force：放行且标记 forced（用户明确要覆盖）',
    g.block === false && g.forced === true, JSON.stringify(g));
}
{
  const g = versionGate('1.0.0', '', false);
  ok('本地版本读不出时不拦（交给上游的「版本号必须一致」那条去报错）', g.block === false, JSON.stringify(g));
}

console.log('\nD. humanSize —— 388 B 不能显示成 "0.0 MB"\n');

ok('388 字节 → "388 B"', humanSize(388) === '388 B', humanSize(388));
ok('93420 字节 → "91.2 KB"（不再显示成 0.1 MB）', humanSize(93420) === '91.2 KB', humanSize(93420));
ok('89151447 字节 → "85.0 MB"', humanSize(89151447) === '85.0 MB', humanSize(89151447));
ok('1024 → "1.0 KB"（边界不越界）', humanSize(1024) === '1.0 KB', humanSize(1024));
ok('1048576 → "1.0 MB"（边界不越界）', humanSize(1048576) === '1.0 MB', humanSize(1048576));
ok('负数 / NaN → "—"，不抛异常', humanSize(-1) === '—' && humanSize(NaN) === '—', humanSize(-1) + ' / ' + humanSize(NaN));

console.log('\nE. padTo —— 清单表格按显示宽度对齐\n');

ok('「安装包」(3 汉字=6 格) 补到 10 格', dispWidth(padTo('安装包', 10)) === 10, JSON.stringify(padTo('安装包', 10)));
ok('「版本清单」(4 汉字=8 格) 补到 10 格', dispWidth(padTo('版本清单', 10)) === 10, JSON.stringify(padTo('版本清单', 10)));
ok('「增量块图」与「安装包」补齐后显示宽度相同',
  dispWidth(padTo('增量块图', 10)) === dispWidth(padTo('安装包', 10)),
  JSON.stringify([padTo('增量块图', 10), padTo('安装包', 10)]));
ok('纯 ASCII 名按 1 格算', padTo('abc', 10) === 'abc' + ' '.repeat(7), JSON.stringify(padTo('abc', 10)));
ok('超宽时也至少留 1 个空格（不会把两列粘在一起）', padTo('一个很长很长很长的名字', 4).endsWith(' '), JSON.stringify(padTo('一个很长很长很长的名字', 4)));

console.log('\n核心不变量：path 与 files[0] 一致、便携版永不上传、同版本号默认拦下。');
console.log(bad ? ('有 ' + bad + ' 项未通过') : '全部通过');
process.exit(bad ? 1 : 0);
