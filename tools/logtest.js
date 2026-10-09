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

console.log('\nI. ★ 分级口径（tier）—— 「大结论」进界面、「过程明细」不进（2026-10-05 用户口径）\n');
{
  const LB = require(path.join(ROOT, 'src/main/logbus.js'));
  ok('logbus.DETAIL 就是 { tier: "detail" }（调用点别各写各的字符串）',
    LB.DETAIL && LB.DETAIL.tier === 'detail', JSON.stringify(LB.DETAIL));

  const e1 = LB.info('自检-大结论');
  ok('★ 不传 opts 的是**大结论**：entry 上没有 tier 字段（默认可见，老调用点一行都不用改）',
    e1.tier === undefined && !('tier' in e1), JSON.stringify(e1).slice(0, 90));

  const e2 = LB.info('自检-过程明细', null, LB.DETAIL);
  ok('★ 传了 DETAIL 的是**明细**：entry.tier === "detail"（界面据此过滤掉）',
    e2.tier === 'detail', JSON.stringify(e2).slice(0, 90));

  ok('★ 四级都支持 tier（ok/warn/error 也一样能标明细）',
    LB.ok('a', null, LB.DETAIL).tier === 'detail'
    && LB.warn('b', null, LB.DETAIL).tier === 'detail'
    && LB.error('c', null, LB.DETAIL).tier === 'detail');

  const hist = LB.history();
  ok('★ 明细与大结论**都进内存 history**（明细只是不上界面，不许丢 —— 查看详情 / 台账都要它）',
    hist.some(x => x.msg === '自检-大结论') && hist.some(x => x.msg === '自检-过程明细' && x.tier === 'detail'),
    `history ${hist.length} 条`);
  ok('meta 与 opts 互不干扰（opts 是第 4 个参数，不会串进 meta）',
    (() => { const x = LB.info('m', { batch: 'B1' }, LB.DETAIL); return x.meta && x.meta.batch === 'B1' && x.tier === 'detail'; })());

  // ★★ 任务流水该走哪一级：规则只此一处（jobs.js 的 ctx.log 直接调它）
  ok('★ ctx.log 的默认结果是「明细」：普通 info / ok / warn 流水一律沉底',
    LB.tierOf('info') === 'detail' && LB.tierOf('ok') === 'detail' && LB.tierOf('warn') === 'detail'
    && LB.tierOf(undefined) === 'detail',
    [LB.tierOf('info'), LB.tierOf('ok'), LB.tierOf('warn')].join('/'));
  ok('★★ 例外①：level=error 的流水**必须**给用户看（真出错，不许因为「太细」藏起来）',
    LB.tierOf('error') === 'ui', LB.tierOf('error'));
  ok('★★ 例外②：显式 opts.ui=true（ctx.conclude 走的这条路）→ 大结论',
    LB.tierOf('info', { ui: true }) === 'ui' && LB.tierOf('warn', { ui: true }) === 'ui',
    LB.tierOf('info', { ui: true }));
  ok('别的 opts 字段不会误判成大结论（只认 ui === true 这一个显式开关）',
    LB.tierOf('info', { tier: 'detail' }) === 'detail' && LB.tierOf('info', { ui: 1 }) === 'detail'
    && LB.tierOf('info', { ui: 'true' }) === 'detail',
    LB.tierOf('info', { ui: 'true' }));
}

console.log('\nJ. ★ 导出文件头：界面看不见的明细，也得把条数说出来\n');
{
  const withDetail = L.formatText(list, { exportedAt: T('2026-10-02T14:05:00'), appVersion: '1.0.1', filter: {}, bufferTotal: 4, bufferDetail: 37 });
  ok('★ 有明细时多写一行「过程明细：另有 37 条」',
    /过程明细：另有 37 条/.test(withDetail), (withDetail.match(/过程明细：[^\n]*/) || [''])[0].slice(0, 80));
  ok('并且说清了完整台账在哪（run-log.jsonl）', /run-log\.jsonl/.test(withDetail));
  ok('★ 「内存缓冲区」那一行的老口径**没被改**（下游/同事按它读账）',
    /内存缓冲区：共 4 条/.test(withDetail), (withDetail.match(/内存缓冲区：[^\n]*/) || [''])[0]);
  ok('没有明细时**不写**这一行（0 条明细不占版面，也不谎报）',
    !/过程明细/.test(L.formatText(list, { exportedAt: Date.now(), appVersion: '1.0.1', filter: {}, bufferTotal: 4 })));
  ok('bufferDetail 缺省/脏值都当 0，不写出「另有 NaN 条」',
    !/过程明细/.test(L.formatText(list, { bufferTotal: 1, bufferDetail: undefined }))
    && !/过程明细/.test(L.formatText(list, { bufferTotal: 1, bufferDetail: '' })));
}

/* ★ K 段要 await 真跑任务 ⇒ 连同收尾一起放进一个 async 主体
 *（CommonJS 里顶层 await 会直接报 ERR_AMBIGUOUS_MODULE_SYNTAX，别踩） */
(async () => {
console.log('\nK. ★ 端到端：真跑一次任务，验证「流水走明细、结论走大结论」的接线\n');
{
  // 真的 require 一次 src/main/jobs.js（它要用 electron）⇒ 按本项目既有做法喂一个假 electron，
  // 并把 userData 指到临时目录 —— **绝不许碰用户的 config.json / 输出目录**。
  const Module = require('module');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-logtest-jobs-'));
  const fakeElectron = {
    app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    ipcMain: { handle() {}, on() {} },
    dialog: {}, shell: {}, nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
    Notification: { isSupported: () => false },
    screen: {}, contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, arguments);
  };

  try {
    const LB = require(path.join(ROOT, 'src/main/logbus.js'));
    const jobs = require(path.join(ROOT, 'src/main/jobs.js'));
    // 日志套件需要真实发布任务，显式创建隔离品牌，避免被前置归属校验拦下。
    require(path.join(ROOT, 'src/main/brands.js')).add({ name: '日志测试品牌' });

    // 造一个最小素材目录：一个叶子文件夹（货号+颜色）
    const srcDir = path.join(TMP, 'src');
    fs.mkdirSync(path.join(srcDir, '26FW-YB160+冠军白'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, '26FW-YB160+冠军白', 'a.jpg'), 'x');
    fs.writeFileSync(path.join(srcDir, '26FW-YB160+冠军白', 'b.jpg'), 'x');

    const beforeN = LB.history().length;
    const plan = await jobs.run('flatten.plan', { sourceDir: srcDir });
    const run = await jobs.run('flatten.run', { sourceDir: srcDir });
    ok('前置：两次任务都真跑起来了（否则下面测的是空气）', !!plan.ok && !!run.ok,
      JSON.stringify({ plan: plan.ok, run: run.ok, err: run.error || plan.error || '' }).slice(0, 120));

    const fresh = LB.history().slice(beforeN).filter(e => /素材整理|待整理清单/.test(String(e.msg)));
    const details = fresh.filter(e => e.tier === 'detail');
    const concl = fresh.filter(e => e.tier !== 'detail' && /素材整理完成/.test(String(e.msg)));
    ok('★ ctx.log 那一串**真落成明细**（每步耗时/目录/链接数…都不进界面）',
      details.length >= 2, `${details.length} 条明细：${details.map(e => String(e.msg).slice(0, 26)).join(' | ')}`);
    ok('★★ ctx.conclude 那句**真落成大结论**（没有 tier 字段 ⇒ 界面看得见）',
      concl.length === 1 && /素材整理完成【/.test(concl[0].msg), concl.map(e => e.msg).join(' | ').slice(0, 140));
    ok('★ 结论里带的是**真实数字**（不是占位/空串）',
      /【1 个叶子目录 · 链接 2 · 复制 0 · 2 B】/.test(concl.length ? concl[0].msg : ''),
      concl.length ? concl[0].msg : '(没有结论)');
    ok('任务级 logbus.info（待整理清单）仍是大结论 —— 它本来就是说给用户听的',
      fresh.some(e => e.tier !== 'detail' && /待整理清单：1 个叶子目录/.test(String(e.msg))));

    // ---- 发布（模拟通道，两秒级）：用户点名要的那句「目标/成功/失败」必须真出现 ----
    const project = require(path.join(ROOT, 'src/main/project.js'));
    project.patch({
      sourceDir: srcDir, flatDir: srcDir,
      items: [{
        id: '26FW-YB160+冠军白', dir: '26FW-YB160+冠军白', absDir: path.join(srcDir, '26FW-YB160+冠军白'),
        sku: '26FW-YB160', color: '冠军白', seq: 1, files: [{ name: 'a.jpg', size: 1, type: 'image' }]
      }],
      copyRows: [], verify: { rows: [] },
      sheet: { file: '', rowCount: 1, colCount: 26, locked: false, exportedAt: 0 },
      publish: {
        mode: 'mock', batch: '自检批',
        rows: [{ seq: 1, id: '26FW-YB160+冠军白', dir: '26FW-YB160+冠军白', goods: 1, images: 1, startAt: '', status: '排队', result: '', reason: '' }]
      }
    });
    const b2 = LB.history().length;
    const pub = await jobs.run('publish.run', {});
    ok('前置：模拟发布真跑起来了（不碰设备，只演练节奏/回写）', !!(pub && pub.ok), JSON.stringify(pub && pub.error || '').slice(0, 100));

    const pubFresh = LB.history().slice(b2);
    const uiPub = pubFresh.filter(e => e.tier !== 'detail');
    const detPub = pubFresh.filter(e => e.tier === 'detail');
    ok('★ 每行结果 + 每步流水（行 1[图文] 发布完成 / 批量发布完成）**全是明细**，不进用户界面',
      detPub.some(e => /行 1\[图文\] 发布完成/.test(String(e.msg)))
      && !uiPub.some(e => /行 1\[图文\] 发布完成|批量发布完成/.test(String(e.msg)))
      && detPub.length >= 3,
      `明细 ${detPub.length} 条 · 大结论 ${uiPub.length} 条`);
    ok('★★ 发布大结论就是用户要的那句格式；模拟通道**如实写成「模拟发布完成」**（没真发就不许说「发布成功」）',
      uiPub.some(e => /模拟发布完成【目标 1 条，模拟成功 1 条，失败 0 条】/.test(String(e.msg))),
      uiPub.map(e => String(e.msg)).join(' | ').slice(0, 200));
    ok('★「开始发布（…）：N 条」也是大结论（用户得先知道这批要发几条）',
      uiPub.some(e => /开始发布（模拟通道）：1 条/.test(String(e.msg))));
  } catch (e) {
    ok('K 段不许抛异常（抛了就等于没测）', false, (e && e.message) || String(e));
  }

  Module._load = origLoad;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e5) { /* 临时目录 */ }
}

console.log('\n' + (bad ? `FAILED：${bad} 条不通过` : '全部通过'));
process.exit(bad ? 1 : 0);
})();
