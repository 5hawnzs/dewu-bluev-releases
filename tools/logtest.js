'use strict';
/*
 * 运行日志导出（src/main/logexport.js）纯逻辑回归 —— 纯 Node，不开窗口、不碰真配置。
 *
 * ★ 为什么这套必须存在：导出的那个文件是用户**要拿去对账、要发给同事**的东西。
 *   「导出成功但内容是错的」比「导出失败」坏得多，而且没人会当场发现。所以这里钉死四件事：
 *     1. 条数不许谎报 —— 筛选后 3 条就必须写「本次导出 3 条」，同时把「缓冲区共 N 条」也写出来，
 *        免得事后被当成「日志丢了半天」；
 *     2. 每行要有**完整日期时间**（界面只显示 HH:MM:SS，跨天之后就对不上了）；
 *     3. 行尾固定 \n（不是 os.EOL），否则同一份日志在不同机器上 diff 全是假差异；
 *     4. 落盘是真落盘：两个文件都在、内容与传入的 entries 一致；没给输出目录要**抛**，不许静默成功。
 *
 * 用法：node tools/logtest.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const L = require(path.join(ROOT, 'src/main/logexport.js'));

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) bad++;
};

const T = ts => new Date(ts).getTime();
const e = (level, msg, t, meta) => ({ level, msg, t, meta: meta || null });
const list = [
  e('info', '开始整理素材', T('2026-10-02T14:03:04')),
  e('ok', '整理完成：120 个叶子', T('2026-10-02T14:03:09')),
  e('warn', '有 2 个目录名里没有颜色段', T('2026-10-02T14:03:10')),
  e('error', '第 7 条发布失败：找不到「发布」按钮', T('2026-10-02T14:04:00'))
];

console.log('A. 等级口径 —— 认不出的等级算「信息」（与界面配色兜底同一口径）\n');
ok('四种等级的文案', L.LEVELS.map(l => L.levelLabel(l)).join('/') === '信息/成功/警告/错误', L.LEVELS.map(l => L.levelLabel(l)).join('/'));
ok('★ 认不出的等级（脏数据）落到「信息」，不许变成空字符串', L.levelLabel('weird') === '信息' && L.levelLabel(undefined) === '信息', L.levelLabel('weird'));
const c = L.countByLevel(list);
ok('分等级计数正确', c.info === 1 && c.ok === 1 && c.warn === 1 && c.error === 1 && c.total === 4, JSON.stringify(c));
ok('脏等级算进 info（total 不会因此少算）', (() => { const x = L.countByLevel([e('weird', 'x')]); return x.info === 1 && x.total === 1; })(),
  JSON.stringify(L.countByLevel([e('weird', 'x')])));
ok('空列表 ⇒ 全 0，不是 undefined', (() => { const x = L.countByLevel([]); return x.total === 0 && x.error === 0; })(), JSON.stringify(L.countByLevel([])));
ok('countByLevel 不吃 null', L.countByLevel(null).total === 0);

console.log('\nB. 文件名与路径 —— 「另存为」时不许覆盖上一次的日志\n');
ok('文件名带时间戳（到秒）', L.fileBase(new Date('2026-10-02T14:03:04')) === '运行日志_20261002-140304', L.fileBase(new Date('2026-10-02T14:03:04')));
ok('★ 同一分钟内导两次**不会**重名（排障时会反复导出，覆盖掉上次就出事）',
  L.fileBase(new Date('2026-10-02T14:03:04')) !== L.fileBase(new Date('2026-10-02T14:03:50')),
  L.fileBase(new Date('2026-10-02T14:03:04')) + ' vs ' + L.fileBase(new Date('2026-10-02T14:03:50')));
ok('文件名里没有冒号 / 斜杠（Windows 文件名不能含这些字符）',
  !/[:/\\*?"<>|]/.test(L.fileBase(new Date('2026-10-02T14:03:04'))), L.fileBase(new Date('2026-10-02T14:03:04')));
const pp = L.paths('D:/out', new Date('2026-10-02T14:03:04'));
ok('.log 与 .jsonl 同目录、同基名（一次导出两个文件，名字要能对上）',
  path.basename(pp.text, '.log') === path.basename(pp.json, '.jsonl'), JSON.stringify([path.basename(pp.text), path.basename(pp.json)]));
// 注意：Windows 下 path.dirname 会把 '/' 归一成 '\'，所以比之前要 normalize —— 断言别写死分隔符
ok('两个文件都落在传进来的输出目录里',
  path.normalize(path.dirname(pp.text)) === path.normalize('D:/out') && path.normalize(path.dirname(pp.json)) === path.normalize('D:/out'),
  path.dirname(pp.text));

console.log('\nC. 筛选条件那一行 —— 事后要能看出「为什么少了半天」\n');
ok('没筛：级别=全部 · 关键字=（无）', L.filterText({}) === '级别=全部 · 关键字=（无）', L.filterText({}));
ok('筛了错误级 + 关键字：两个都要出现', L.filterText({ level: 'error', q: '发布失败' }) === '级别=错误 · 关键字=发布失败', L.filterText({ level: 'error', q: '发布失败' }));
ok('空串关键字按「无」处理（不是显示成一对引号）', /关键字=（无）/.test(L.filterText({ level: 'warn', q: '' })), L.filterText({ level: 'warn', q: '' }));

console.log('\nD. 文本格式 —— 给人看的，必须自带上下文\n');
const txt = L.formatText(list, { exportedAt: T('2026-10-02T14:05:00'), appVersion: '1.0.1', filter: {}, bufferTotal: 4 });
ok('开头就是「运行日志导出」（一眼知道这是什么）', txt.startsWith('运行日志导出\n'), txt.split('\n')[0]);
ok('写了导出时间（完整日期时间，不是 HH:MM:SS）', /导出时间：2026-10-02 14:05:00/.test(txt), (txt.match(/导出时间：[^\n]*/) || [''])[0]);
ok('写了应用版本', /应用版本：1\.0\.1/.test(txt), (txt.match(/应用版本：[^\n]*/) || [''])[0]);
ok('写了筛选条件', /筛选条件：级别=全部 · 关键字=（无）/.test(txt), (txt.match(/筛选条件：[^\n]*/) || [''])[0]);
ok('★ 写了「本次导出 4 条」', /本次导出：4 条/.test(txt), (txt.match(/本次导出：[^\n]*/) || [''])[0]);
ok('★ 也写了「内存缓冲区共 4 条」', /内存缓冲区：共 4 条/.test(txt), (txt.match(/内存缓冲区：[^\n]*/) || [''])[0]);
ok('写了分等级统计', /分等级：信息 1 · 成功 1 · 警告 1 · 错误 1/.test(txt), (txt.match(/分等级：[^\n]*/) || [''])[0]);
ok('每行都带完整日期时间 + 中文等级',
  txt.includes('2026-10-02 14:03:04 [信息] 开始整理素材') && txt.includes('2026-10-02 14:04:00 [错误] 第 7 条发布失败：找不到「发布」按钮'),
  (txt.split('\n')[9] || '').slice(0, 60));
ok('★ 行尾是 \\n，不是 \\r\\n（不同机器 diff 不许出现假差异）', !/\r/.test(txt), JSON.stringify(txt.slice(-3)));
ok('文件以换行结尾（否则编辑器会标「\\ No newline at end of file」）', txt.endsWith('\n'));

console.log('\nE. ★ 筛选后导出：两个数必须都写出来，且不一样\n');
const few = L.formatText(list.slice(0, 2), { exportedAt: Date.now(), appVersion: '1.0.1', filter: { level: 'error', q: 'x' }, bufferTotal: 500 });
ok('「本次导出：2 条」', /本次导出：2 条/.test(few), (few.match(/本次导出：[^\n]*/) || [''])[0]);
ok('「内存缓冲区：共 500 条」—— 两个数分开写，才不会被当成"日志丢了"', /内存缓冲区：共 500 条/.test(few), (few.match(/内存缓冲区：[^\n]*/) || [''])[0]);
ok('并且明确解释了为什么会不一致', /不一致/.test(few), (few.match(/内存缓冲区：[^\n]*/) || [''])[0].slice(0, 80));
ok('筛选条件也原样写进去（过几天还说得清是按什么筛的）', /级别=错误 · 关键字=x/.test(few), (few.match(/筛选条件：[^\n]*/) || [''])[0]);

console.log('\nF. ★ 不造假：0 条就说 0 条\n');
const zero = L.formatText([], { exportedAt: T('2026-10-02T14:05:00'), appVersion: '0.0.0', filter: {}, bufferTotal: 0 });
ok('0 条时写「本次导出：0 条」，不编造内容', /本次导出：0 条/.test(zero), (zero.match(/本次导出：[^\n]*/) || [''])[0]);
ok('0 条时正文里没有任何日志行（只有 8 行表头 + 1 行空）', zero.split('\n').length === 9, zero.split('\n').length + ' 行');
ok('0 条时版本取不到就写「（未知）」，不写假版本号',
  /应用版本：（未知）/.test(L.formatText([], {})), (L.formatText([], {}).match(/应用版本：[^\n]*/) || [''])[0]);

console.log('\nG. jsonl —— 一行一条，能原样解回来\n');
const jl = L.formatJsonl(list);
const back = jl.split('\n').filter(Boolean).map(s => JSON.parse(s));
ok('行数与条数一致', back.length === 4, String(back.length));
ok('每行都是合法 JSON（能被 JSON.parse 解回来）', back[3].msg === list[3].msg && back[3].level === 'error', JSON.stringify(back[3]).slice(0, 90));
ok('带中文等级文案（脚本读 level，人读 levelText）', back[2].levelText === '警告' && back[2].level === 'warn', JSON.stringify(back[2]).slice(0, 90));
ok('保留了 meta（批次这类线索就在这里，丢了就查不出是哪一批）',
  JSON.parse(L.formatJsonl([e('info', 'x', T('2026-10-02T14:03:04'), { batch: '7月第六批' })])).meta.batch === '7月第六批');
ok('0 条 ⇒ 空字符串（不是一行 "null"）', L.formatJsonl([]) === '' && L.formatJsonl(null) === '', JSON.stringify(L.formatJsonl([])));
ok('行尾同样是 \\n', !/\r/.test(jl) && jl.endsWith('\n'));

console.log('\nH. 真落盘 —— 说导出成功就必须真有文件\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-logtest-'));
const r = L.writeFiles({ outputDir: dir, entries: list, meta: { exportedAt: T('2026-10-02T14:05:00'), appVersion: '1.0.1', filter: {}, bufferTotal: 4 }, date: new Date('2026-10-02T14:03:04') });
ok('两个文件都真在磁盘上', fs.existsSync(r.text) && fs.existsSync(r.json), `${path.basename(r.text)} · ${path.basename(r.json)}`);
ok('返回的条数 = 传进去的条数', r.count === 4, String(r.count));
ok('.log 内容 = formatText 的结果（不存在"写了一半"）', fs.readFileSync(r.text, 'utf8') === L.formatText(list, { exportedAt: T('2026-10-02T14:05:00'), appVersion: '1.0.1', filter: {}, bufferTotal: 4 }));
ok('.jsonl 也是完整内容', fs.readFileSync(r.json, 'utf8') === L.formatJsonl(list));

const r0 = L.writeFiles({ outputDir: dir, entries: [], meta: {}, date: new Date('2026-10-02T14:06:00') });
ok('★ 0 条也照样产出两个文件（点了导出就不能骗人），只是 .jsonl 是空的',
  fs.existsSync(r0.text) && fs.existsSync(r0.json) && r0.count === 0 && fs.readFileSync(r0.json, 'utf8') === '',
  `${path.basename(r0.text)} ${fs.statSync(r0.text).size}B`);

const deep = path.join(dir, 'a', 'b', 'c');
const r2 = L.writeFiles({ outputDir: deep, entries: list.slice(0, 1), meta: {} });
ok('输出目录还不存在时会自己建出来（不报一个看不懂的 ENOENT）', fs.existsSync(r2.text), deep);

let threw = '';
try { L.writeFiles({ outputDir: '', entries: list, meta: {} }); } catch (e2) { threw = e2.message; }
ok('★ 没有输出目录 ⇒ 抛错（不许静默成功、也不许写到当前工作目录里去）', /输出目录/.test(threw), threw || '(没抛)');

let threw2 = '';
try { L.writeFiles(null); } catch (e3) { threw2 = e3.message; }
ok('参数整个不传也是抛错，不是 TypeError 之外的静默行为', /输出目录/.test(threw2), threw2 || '(没抛)');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e4) { /* 临时目录，删不掉也不影响结论 */ }

console.log('\n' + (bad ? `FAILED：${bad} 条不通过` : '全部通过'));
process.exit(bad ? 1 : 0);
