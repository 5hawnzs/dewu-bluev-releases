/* 品牌权限 + 按品牌统计
   对应 README「品牌权限与统计」一节。真机背景：品牌很多，需要按账号分配品牌权限，
   并且管理员要能按品牌查发布的频次、数量与执行日志。

   覆盖：
     ① 品牌注册表：新增 / 重名 / 保留名 / 改名不丢权限 / 启用停用 / 删除
     ② 权限判定：管理员=全部；普通成员只看名下；单品牌自动补；多品牌必须选；越权被拒；
        名下品牌被删与「没分配」给出不同提示（两种情况的处置不一样）
     ③ 归属记录：发布日志每条带品牌与执行人；没品牌就如实记「未标」
     ④ 统计口径：**未标品牌单列、不并入任何品牌**；已删除品牌单列保留；
        0 条的品牌也要出现（「哪个品牌最近没在发」正是要看的东西）
     ⑤ 执行日志落盘（logbus 只有内存 500 条，重启即丢，管理员事后要能查）
     ⑥ 导出 xlsx：汇总 / 按天频次 / 品牌×执行人 / 执行日志
     ⑩ 执行日志**单独导出**（.log + .csv，带 BOM）：条数必须完整 —— 过去固定只导 100 条且不说明
     ⑪ 输出目录自检：共享盘掉线时能当场发现（日志是「写失败不报错」的），且自检不污染台账

   用法：node tools/brandtest.js
   注意：全部在临时目录里跑，不动你本机的 config.json / auth.json / publish-log.jsonl。
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-brand-'));
const fake = {
  app: { getPath: () => TMP, getVersion: () => '1.0.0', requestSingleInstanceLock: () => true, on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {},
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false }, screen: {},
  contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'electron') return fake; return origLoad.apply(this, arguments); };

const base = path.resolve(__dirname, '..');
const store = require(path.join(base, 'src/main/store.js'));
const brands = require(path.join(base, 'src/main/brands.js'));
const auth = require(path.join(base, 'src/main/auth.js'));
const sheet = require(path.join(base, 'src/main/services/sheet.js'));
const runlog = require(path.join(base, 'src/main/services/runlog.js'));
const stats = require(path.join(base, 'src/main/services/stats.js'));
const ExcelJS = require(path.join(base, 'node_modules', 'exceljs'));

store.load();
store.set({ paths: { output: TMP } });

let fail = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) fail++;
};
const day = n => Date.now() - n * 86400000;

(async () => {
  // ---- ① 注册表 ----
  // 出厂默认**不预设任何品牌名**（旧版本曾出厂就带一个品牌名 —— 全新安装不该出现别人家的品牌）
  ok('① 出厂默认不含任何品牌（copy.brand 空 + brands 空）',
    String(store.get('copy.brand') || '') === '' && brands.list().length === 0,
    JSON.stringify([store.get('copy.brand'), brands.list().map(b => b.name)]));
  // 旧版迁移：老配置里单选过一个品牌 ⇒ 首次读到时迁成一条记录（显式造场景，不再靠出厂默认值）
  store.set({ brands: [], brandsSeeded: false, copy: { brand: '品牌甲' } });
  const migrated = brands.list();
  ok('① 旧版单选品牌会在首次读取时迁成一条记录',
    migrated.length === 1 && migrated[0].name === '品牌甲', JSON.stringify(migrated.map(b => b.name)));
  brands.remove(migrated[0].id);
  ok('① 删空后不会被自动塞回来（靠 brandsSeeded 标记，不是「空数组就补」）', brands.list().length === 0);
  store.set({ copy: { brand: '' } });   // 还原成出厂值，别影响后面的断言

  const A = brands.add({ name: '品牌甲' });
  const B = brands.add({ name: 'brandx' });
  const C = brands.add({ name: '品牌丙' });
  ok('① 新增三个品牌', A.ok && B.ok && C.ok);
  ok('① 连续新增不会撞 id', new Set([A.brand.id, B.brand.id, C.brand.id]).size === 3);
  ok('① 重名被拒（大小写不敏感）', brands.add({ name: 'BRANDX' }).ok === false, brands.add({ name: 'BRANDX' }).error);
  ok('① 统计保留名不能当品牌名', brands.add({ name: '未标品牌' }).ok === false, brands.add({ name: '未标品牌' }).error);
  ok('① 空白名被拒', brands.add({ name: '   ' }).ok === false, brands.add({ name: '   ' }).error);

  // ---- ② 权限判定 ----
  const admin = { id: 'u1', role: 'admin', brands: [] };
  const one = { id: 'u2', role: 'user', brands: [A.brand.id] };
  const two = { id: 'u3', role: 'user', brands: [A.brand.id, B.brand.id] };
  const none = { id: 'u4', role: 'user', brands: [] };
  const dead = { id: 'u5', role: 'user', brands: ['brd_已删掉'] };

  ok('② 管理员 = 全部启用中的品牌', brands.allowed(admin).all === true && brands.allowed(admin).brands.length === 3);
  ok('② 普通成员只看到名下的', brands.allowed(two).brands.length === 2 && brands.allowed(one).brands.length === 1);

  ok('② 单品牌用户没选 → 自动补（不是报错）', (() => { const r = brands.resolveFor(one, '', { required: true }); return r.ok && r.auto && r.brand.id === A.brand.id; })());
  ok('② 多品牌用户没选 → 报错并列出可选项',
    (() => { const r = brands.resolveFor(two, '', { required: true }); return !r.ok && /品牌甲/.test(r.error) && /brandx/.test(r.error); })(),
    brands.resolveFor(two, '', { required: true }).error);
  ok('② 普通成员不能借别人的品牌 id 越权',
    (() => { const r = brands.resolveFor(one, B.brand.id, { required: true }); return !r.ok && /没有「brandx」的操作权限/.test(r.error); })(),
    brands.resolveFor(one, B.brand.id, { required: true }).error);
  ok('② 管理员用哪个品牌都行', brands.resolveFor(admin, C.brand.id, { required: true }).brand.id === C.brand.id);
  ok('② 「没分配品牌」的提示是去找管理员',
    /还没有分配品牌/.test(brands.resolveFor(none, '', { required: true }).error), brands.resolveFor(none, '', { required: true }).error);
  ok('② 「名下的品牌都被删/停用」的提示与「没分配」区分开',
    /已停用或被删除/.test(brands.resolveFor(dead, '', { required: true }).error), brands.resolveFor(dead, '', { required: true }).error);
  ok('② 非产出类任务（required=false）没品牌也放行，记为未标',
    (() => { const r = brands.resolveFor(none, '', { required: false }); return r.ok && r.brand === null; })());
  ok('② 不存在的品牌 id 明确报错', /品牌不存在/.test(brands.resolveFor(admin, 'brd_nope', { required: true }).error));
  ok('② 停用后普通成员就用不了了', (() => {
    brands.update(C.brand.id, { enabled: false });
    const r = brands.resolveFor({ role: 'user', brands: [C.brand.id] }, '', { required: true });
    brands.update(C.brand.id, { enabled: true });
    return !r.ok && /已停用或被删除/.test(r.error);
  })());

  // ---- ③ 归属记录：往 publish-log 里写几条带品牌/不带品牌的 ----
  const actor1 = { userId: 'u2', username: 'zhang', displayName: '张三' };
  const actor2 = { userId: 'u3', username: 'li', displayName: '李四' };
  const log = (brandId, brandName, actor, t, res, batch) => sheet.appendLog({
    batch, seq: 1, id: 'x', dir: 'D:/素材/叶子', at: '10:00:00', result: res, reason: '',
    retries: 0, elapsed: 65, mode: 'adb', kind: '图文',
    brandId, brandName, ...actor, ...(t ? { ts: t } : {})
  });
  const A2 = brands.add({ name: '临时品牌(待删)' }).brand;

  log(A.brand.id, A.brand.name, actor1, day(1), '发布成功', '品牌甲_第一批');
  log(A.brand.id, A.brand.name, actor1, day(1), '失败', '品牌甲_第一批');
  log(A.brand.id, A.brand.name, actor2, day(2), '发布成功', '品牌甲_第二批');
  log(B.brand.id, B.brand.name, actor2, day(1), '发布成功', 'brandx_第一批');
  log(A2.id, A2.name, actor1, day(1), '发布成功', '临时品牌_第一批');   // 品牌一会儿要删掉
  log('', '', actor1, day(3), '发布成功', '历史批次');                  // 2026-10-01 之前的记录：无品牌无执行人
  log('', '', actor1, day(3), '失败', '历史批次');

  const all = stats.query({ days: 0 });
  const pick = id => all.brands.find(b => b.id === id);
  ok('③ 发布日志确实带上了品牌与执行人',
    sheet.readLog().find(e => e.batch === '品牌甲_第一批').brandName === '品牌甲', '品牌甲_第一批');
  ok('③ 按品牌的条数算对了（品牌甲 3 条 / 成功 2 失败 1）',
    pick(A.brand.id).rows === 3 && pick(A.brand.id).ok === 2 && pick(A.brand.id).fail === 1,
    JSON.stringify({ rows: pick(A.brand.id).rows, ok: pick(A.brand.id).ok, fail: pick(A.brand.id).fail }));

  // ---- ④ 统计口径 ----
  ok('④ 未标品牌单独一桶，条数是真实的 2（不是 0，也没并进任何品牌）',
    all.untagged.rows === 2, `untagged=${all.untagged.rows}`);
  ok('④ 未标品牌没有被算进品牌甲',
    pick(A.brand.id).rows === 3 && all.untagged.rows === 2, `品牌甲=${pick(A.brand.id).rows} 未标=${all.untagged.rows}`);
  ok('④ 没有一条记录的品牌是空的却被算进某个品牌（总数对得上）',
    all.totals.rows === 7, `total=${all.totals.rows}`);

  const st = stats.query({ days: 0, brandId: '__none__' });
  ok('④ 「只看未标品牌」筛选命中 2 条且品牌列表为空',
    st.untagged.rows === 2 && st.brands.length === 0, `untagged=${st.untagged.rows} brands=${st.brands.length}`);

  const byA = stats.query({ days: 0, brandId: A.brand.id });
  ok('④ 按品牌筛选只出这一个品牌', byA.brands.length === 1 && byA.brands[0].rows === 3);

  const byUser = stats.query({ days: 0, userId: 'u2' });
  // 张三（u2）名下：品牌甲 2 条 + 待删品牌 1 条 + 无品牌的历史记录 2 条 = 5。
  // 一开始写成 3，是漏算了历史那两条 —— 断言错了，不是统计错了
  ok('④ 按执行人筛选：张三名下 5 条（含无品牌的历史记录）',
    byUser.totals.rows === 5, `rows=${byUser.totals.rows}`);

  const scoped = stats.query({ days: 0, scopeIds: [B.brand.id] });
  ok('④ 非管理员范围：只看得到 brandx，看不到品牌甲、也看不到别的品牌名',
    scoped.brands.length === 1 && scoped.brands[0].id === B.brand.id
    && !JSON.stringify(scoped).includes('品牌甲'),
    `brands=${scoped.brands.map(b => b.name).join('/')}`);
  ok('④ 非管理员范围下未标品牌为空（无法确认归属的不给他看）', scoped.untagged.rows === 0);

  // 0 条的品牌也要在列表里
  const extra = brands.add({ name: '还没发过的品牌' }).brand;
  const zero = stats.query({ days: 0 });
  ok('④ 一条都没发过的品牌也出现在列表里（rows: 0）——「哪个品牌最近没在发」正是要看的东西',
    zero.brands.some(b => b.id === extra.id && b.rows === 0),
    '还没发过的品牌 rows=' + (zero.brands.find(b => b.id === extra.id) || {}).rows);

  // 按天
  const d7 = stats.query({ days: 7 });
  const yDay = stats.dayOf(day(1));   // 「1 天前」那天的日期字符串（不写死日期，跨天跑也不会假红）
  const yCell = d7.daily.find(d => d.date === yDay);
  ok('④ 按天密集序列长度 = 7（缺口是 0，不是「没有这一天」）', d7.daily.length === 7, 'len=' + d7.daily.length);
  ok(`④ 「1 天前」${yDay} 那一格是 4 条`, !!yCell && yCell.rows === 4, JSON.stringify(yCell));
  ok('④ 品牌自己的 byDay 只列有数据的天', pick(A.brand.id).byDay.length === 2, JSON.stringify(pick(A.brand.id).byDay.map(d => d.date)));
  ok('④ 品牌上记录了最近一次发布时间', !!pick(A.brand.id).lastAt && pick(A.brand.id).lastDay.length === 10, pick(A.brand.id).lastDay);
  ok('④ 每个品牌带「谁发的、发了多少」', pick(A.brand.id).users.length === 2
    && pick(A.brand.id).users.find(u => u.userId === 'u2').rows === 2, JSON.stringify(pick(A.brand.id).users));

  // 范围外的记录不该出现在「最近 N 天」里
  const d1 = stats.query({ days: 1 });
  ok('④ 「最近 1 天」把 3 天前那两条历史记录排除在外',
    d1.totals.rows === 0 || d1.untagged.rows === 0, `rows=${d1.totals.rows} untagged=${d1.untagged.rows}`);

  // ---- 删品牌：历史记录必须原样保留并单列 ----
  const del = brands.remove(A2.id);
  const afterDel = stats.query({ days: 0 });
  ok('④ 品牌删了，历史记录没跟着消失', del.ok && afterDel.totals.rows === 7, `total=${afterDel.totals.rows}`);
  ok('④ 已删除品牌的记录单列成「已删除的品牌」，不会被并进别的品牌',
    afterDel.orphans.length === 1 && afterDel.orphans[0].id === A2.id && afterDel.orphans[0].rows === 1,
    JSON.stringify(afterDel.orphans.map(o => ({ id: o.id, rows: o.rows }))));
  ok('④ 删除后，别的品牌条数一点没变',
    afterDel.brands.find(b => b.id === A.brand.id).rows === 3);

  // ---- ⑤ 执行日志落盘 ----
  runlog.append({ kind: 'start', jobId: 'j1', label: '自动发布', type: 'publish.run', batch: '品牌甲_第一批', brandId: A.brand.id, brandName: A.brand.name, ...actor1 });
  runlog.append({ kind: 'log', level: 'info', msg: '行 1 发布完成', jobId: 'j1', label: '自动发布', type: 'publish.run', batch: '品牌甲_第一批', brandId: A.brand.id, brandName: A.brand.name, ...actor1 });
  runlog.append({ kind: 'end', ok: true, elapsedSec: 86.6, jobId: 'j1', label: '自动发布', type: 'publish.run', batch: '品牌甲_第一批', brandId: A.brand.id, brandName: A.brand.name, ...actor1 });
  runlog.append({ kind: 'end', ok: false, error: '设备掉线', elapsedSec: 12, jobId: 'j2', label: '自动发布', type: 'publish.run', batch: 'brandx_第一批', brandId: B.brand.id, brandName: B.brand.name, ...actor2 });
  ok('⑤ 执行日志写进了 run-log.jsonl（不是只在内存里）', fs.existsSync(runlog.file()) && runlog.read().length === 4, runlog.file());
  const rl = runlog.query({ days: 0 });
  ok('⑤ 最新在前', rl[0].jobId === 'j2', rl[0].jobId);
  ok('⑤ 按品牌筛执行日志', runlog.query({ days: 0, brandId: A.brand.id }).length === 3);
  ok('⑤ 非管理员范围下只拿得到自己品牌的日志',
    runlog.query({ days: 0, scopeIds: [B.brand.id] }).every(e => e.brandId === B.brand.id)
    && runlog.query({ days: 0, scopeIds: [B.brand.id] }).length === 1);
  ok('⑤ 品牌名是写入时的快照（日后改名也不影响旧日志）',
    runlog.read().find(e => e.jobId === 'j1').brandName === '品牌甲');

  const withRuns = stats.query({ days: 0 });
  ok('⑤ 统计里带上了任务次数与失败次数', withRuns.totals.runs === 2 && withRuns.totals.runFails === 1,
    `runs=${withRuns.totals.runs} fails=${withRuns.totals.runFails}`);
  ok('⑤ 执行日志里带着品牌 / 执行人 / 说明',
    withRuns.logs.some(e => e.brandName === '品牌甲' && e.displayName === '张三' && /发布完成|完成/.test(e.msg || '')),
    (withRuns.logs[0] || {}).msg);
  ok('⑤ 统计里明确给出日志文件位置与条数', /run-log\.jsonl$/.test(withRuns.sources.runLog.file) && withRuns.sources.runLog.entries === 4);

  // ---- ⑥ 导出 xlsx ----
  const exp = await stats.exportXlsx({ days: 0 });
  ok('⑥ 导出成功并落到输出目录', fs.existsSync(exp.file) && /品牌发布统计_/.test(path.basename(exp.file)), path.basename(exp.file));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(exp.file);
  const names = wb.worksheets.map(w => w.name);
  ok('⑥ 四个工作表：汇总 / 按天频次 / 品牌×执行人 / 执行日志',
    ['品牌汇总', '按天频次', '品牌×执行人', '执行日志'].every(n => names.includes(n)), names.join(' / '));
  const ws = wb.getWorksheet('品牌汇总');
  const texts = [];
  ws.eachRow(r => texts.push(String(r.getCell(1).value)));
  ok('⑥ 汇总表里「未标品牌」与「已删除的品牌」单独成行（不和真实品牌混在一起）',
    texts.includes('未标品牌') && texts.some(t => /^已删除的品牌/.test(t)), texts.join(' | '));
  const ws4 = wb.getWorksheet('执行日志');
  const logRows = [];
  ws4.eachRow((r, n) => { if (n > 1) logRows.push(r.getCell(1).value); });
  // 4 = 1 条「开始」+ 1 条任务日志 + 2 条「结束」。
  // 「开始」必须带上：只有开始没有结束 = 任务被中断（程序关了），这正是事后要查的
  ok('⑥ 执行日志表里有 4 行（含「开始」——只有开始没有结束就是被中断的批次）',
    logRows.length === 4, 'rows=' + logRows.length);

  // ---- ⑦ 账号侧集成 ----
  auth.load();
  const g = auth.status();
  ok('⑦ auth 与 brands 之间没有循环依赖，能一起加载', g.requireLogin === true);
  // 账号操作要管理员会话（guardAdmin），所以先登录出厂管理员 —— 不登录的话
  // createUser 会先被「未登录」挡掉，这个断言就测不到品牌校验本身了
  const login = auth.login(auth.DEFAULT_USER, auth.DEFAULT_PASS, false);
  ok('⑦ 能用出厂管理员登录（后面几条要管理员会话）', login.ok === true, login.error || '');
  ok('⑦ 新增账号时写进去的品牌 id 会被校验（不存在的直接报错）',
    (() => { const r = auth.createUser({ username: 'probe_user', password: 'Abc@1234', role: 'user', brands: ['brd_nope'] }); return r.ok === false && /不存在/.test(r.error); })(),
    JSON.stringify(auth.createUser({ username: 'probe_user', password: 'Abc@1234', role: 'user', brands: ['brd_nope'] })));
  const made = auth.createUser({ username: 'probe_user', password: 'Abc@1234', role: 'user', brands: [A.brand.id] });
  ok('⑦ 品牌 id 合法时能建账号并带上权限',
    made.ok === true && made.user.brands.length === 1, made.error || JSON.stringify(made.user && made.user.brands));
  const purged = auth.purgeBrand(A.brand.id);
  ok('⑦ 删品牌后清悬空授权（返回清了几个账号）', purged.ok === true && purged.users === 1, JSON.stringify(purged));

  // ---- ⑧ 真实归属链路：走 publisher 编排写出来的日志必须带品牌与执行人 ----
  // ③ 是直接调 sheet.appendLog 的桩级验证（只证明「写的时候带上了」）；
  // 这一段走真正的发布编排，防的是 publisher 里漏传 brandId/actor 却没人发现
  const publisher = require(path.join(base, 'src/main/services/publisher.js'));
  const before = sheet.readLog().length;
  await publisher.run({
    publish: {
      mode: 'mock', batch: '归属自检_批',
      rows: [{ seq: 1, id: 'leaf1', dir: 'D:/素材/leaf1', status: '排队', result: '', retries: 0 }],
      brandId: A.brand.id, brandName: A.brand.name
    },
    items: [{ id: 'leaf1', dir: 'D:/素材/leaf1', absDir: 'D:/素材/leaf1', sku: 'X', color: '红', files: [{ name: '1.jpg', size: 1, type: 'image' }] }],
    copyRows: [{ id: 'leaf1', title: '标题', body: '正文', topics: ['#a'] }],
    verify: { rows: [] }
  }, {
    log: () => {}, cancelled: () => false,
    brand: { brandId: A.brand.id, brandName: A.brand.name }, actor: actor1
  });
  const written = sheet.readLog().slice(before);
  ok('⑧ 真实发布编排写出的日志，每条都带品牌 id 与品牌名（快照）',
    written.length === 1 && written[0].brandId === A.brand.id && written[0].brandName === A.brand.name,
    JSON.stringify(written.map(x => ({ brandId: x.brandId, brandName: x.brandName }))));
  ok('⑧ 也带上了执行人（管理员要能追到人）',
    written[0] && written[0].userId === 'u2' && written[0].username === 'zhang',
    JSON.stringify({ userId: written[0] && written[0].userId, username: written[0] && written[0].username }));
  ok('⑧ 这条记录随后能出现在按品牌的统计里',
    stats.query({ days: 0, brandId: A.brand.id }).brands[0].rows === 4,
    'rows=' + stats.query({ days: 0, brandId: A.brand.id }).brands[0].rows);

  // ---- ⑨ 品牌文案提示词：存 / 读 / 限长，以及「没配就不许生成」 ----
  // 这一段盯的是「提示词真的在用」：原先 copy.promptWrite 只是个没人读的输入框，
  // 填了也不生效。所以既要证「存得进去」，也要证「存的东西真进了 system / 真能拦住任务」。
  const jobs = require(path.join(base, 'src/main/jobs.js'));
  const copywriter = require(path.join(base, 'src/main/services/copywriter.js'));

  const PW = '你是得物社区的内容运营专家，服务对象是 brandx 品牌蓝V账号。\n一、文案要根据配图内容设计，适配得物种草调性。';
  const r9 = brands.update(A.brand.id, { promptWrite: PW, promptFilter: '  \r\n  先按图片清晰度排序\r\n' });
  ok('⑨ 品牌能各带一份自己的提示词，读回来一致',
    r9.ok && r9.brand.promptWrite === PW && r9.brand.promptFilter === '先按图片清晰度排序',
    JSON.stringify({ w: r9.brand.promptWrite.slice(0, 14), f: r9.brand.promptFilter }));
  ok('⑨ 提示词里的 \\r\\n 被归一成 \\n（Windows 粘来的模板会带 \\r，直接拼进 system 会多出空行）',
    !/\r/.test(r9.brand.promptWrite), JSON.stringify(r9.brand.promptWrite.slice(0, 20)));

  const r9b = brands.update(A.brand.id, { promptWrite: 'x'.repeat(brands.MAX_PROMPT + 500) });
  ok(`⑨ 超长提示词截断到 ${brands.MAX_PROMPT} 字（粘一整份文档时不该整条保存失败）`,
    r9b.ok && r9b.brand.promptWrite.length === brands.MAX_PROMPT, 'len=' + r9b.brand.promptWrite.length);

  ok('⑨ hasWritePrompt：空串 / 只有空白都算「没配」',
    brands.hasWritePrompt({ promptWrite: '  \n ' }) === false
    && brands.hasWritePrompt({ promptWrite: 'x' }) === true
    && brands.hasWritePrompt(null) === false);

  brands.update(A.brand.id, { promptWrite: PW });          // 存回去给下面的行为级断言用
  brands.update(B.brand.id, { promptWrite: '', enabled: true });

  // 行为级：system 的拼装。只断言「源码里有这行字」证明不了拼对了，所以把函数抠出来真跑一遍
  const sys = copywriter.buildSystem(PW, copywriter.FORMATS[0], { angle: '细节质感' });
  ok('⑨ 品牌模板原文整段出现在 system 开头（不是被丢掉、也不是只取了一行）', sys.indexOf(PW) === 0);
  ok('⑨ 程序追加的输出约束仍在（JSON 字段 / 极限词 / 不要 markdown）—— 漏掉整批解析就崩',
    /只输出 JSON/.test(sys) && /极限词/.test(sys) && /markdown/.test(sys));
  ok('⑨ 没给品牌模板时回落到内置角色，而不是拼出一个空 system',
    /文案写手/.test(copywriter.buildSystem('', copywriter.FORMATS[0], { angle: '细节质感' })));

  // 行为级：直接调 generate 也得拦住（不能只有 jobs 那一道防线）
  let gErr = '';
  try {
    await copywriter.generate([{ id: 'x', sku: 'S', color: '红' }],
      { brandFull: { id: 'brd_x', name: '没配文案的品牌', promptWrite: '' }, log: () => {} });
  } catch (e) { gErr = e.message; }
  ok('⑨ 直接调 copywriter.generate 时，没配提示词照样抛错（第二道防线）',
    /还没配「文案生成提示词」/.test(gErr), gErr || '(没抛)');

  // 行为级：走 jobs.run 的完整链路 —— 拦住 + **不留台账**
  const sizeBefore = runlog.size();
  const denied = await jobs.run('copy.generate', { brandId: B.brand.id, batchId: '没配文案_批', sourceDir: TMP, label: '没配文案_批' });
  ok('⑨ 品牌没配提示词时，copy.generate 在起任务之前就被拦下',
    denied.ok === false && /还没配「文案生成提示词」/.test(denied.error || ''), denied.error || JSON.stringify(denied));
  ok('⑨ 被拦下的任务**一条台账都不留**（runlog 没增长）—— 否则台账里全是没跑成的假记录',
    runlog.size() === sizeBefore, `${sizeBefore} → ${runlog.size()}`);

  const letThrough = await jobs.run('copy.generate', { brandId: A.brand.id, batchId: '已配文案_批', sourceDir: TMP, label: '已配文案_批' });
  ok('⑨ 配了提示词的品牌**不会**被这条校验拦（它因为别的原因失败才对 —— 说明这道校验只认提示词）',
    !/还没配「文案生成提示词」/.test(letThrough.error || ''), letThrough.error || '(通过)');

  // ---- ⑩ 执行日志导出：条数必须**完整** ----
  // 老版本把执行日志只导出成 xlsx 的第 4 张表，且固定只导最近 100 条、界面上一句不提：
  // 拿去做月度对账就会少一大截，而且没人看得出来。这一段就是钉住这件事。
  const BIG = 160;
  for (let i = 0; i < BIG; i++) {
    runlog.append({
      kind: 'log', type: 'publish.run', level: i === 0 ? 'error' : 'info',
      // 第一条故意带逗号和引号：CSV 不转义的话一列会被撑成好几列，Excel 打开就错位
      msg: i === 0 ? '失败, 原因："库存不足"' : `批量日志 ${i + 1}`,
      username: 'zhang', displayName: '张三', brandId: A.brand.id
    });
  }
  const q10 = stats.query({ days: 0 });
  const q10all = stats.query({ days: 0, allLogs: true });
  ok('⑩ 界面上仍只取最近 100 条（一屏放不下），但会一并给出「一共几条」',
    q10.logs.length === 100 && q10.logsTotal > 100 && q10.logsTotal === q10all.logs.length,
    `显示 ${q10.logs.length} / 共 ${q10.logsTotal}`);

  const ex10 = await stats.exportRunLog({ days: 0 });
  const csv10 = fs.readFileSync(ex10.csvFile, 'utf8');
  const csvLines = csv10.replace(/^\uFEFF/, '').trim().split(/\r\n/);
  ok('⑩ 单独导出执行日志：.log 与 .csv 同名基名、都真落在输出目录里',
    fs.existsSync(ex10.file) && fs.existsSync(ex10.csvFile)
    && path.basename(ex10.file, '.log') === path.basename(ex10.csvFile, '.csv'),
    path.basename(ex10.file) + ' / ' + path.basename(ex10.csvFile));
  ok('⑩ ★导出条数 = 按当前筛选的全部条数（不是 100）',
    ex10.entries === q10all.logs.length && csvLines.length === q10all.logs.length + 1,
    `entries=${ex10.entries} · csv ${csvLines.length} 行（含表头）· 界面共 ${q10all.logs.length}`);

  const log10 = fs.readFileSync(ex10.file, 'utf8');
  ok('⑩ 文件头同时写「本次导出 N 条」与「日志文件里共 M 条」（差多少一眼看得出）',
    new RegExp(`^# 本次导出：${q10all.logs.length} 条$`, 'm').test(log10)
    && new RegExp(`^# 日志文件里共：${ex10.entriesInFile} 条`, 'm').test(log10)
    && ex10.entriesInFile === runlog.read().length,
    (log10.match(/^# 本次导出：.*$/m) || [''])[0]);
  ok('⑩ csv 带 BOM（Windows 上 Excel 双击不乱码）+ 中文表头',
    csv10.charCodeAt(0) === 0xFEFF && csvLines[0] === '时间,品牌,执行人,账号,任务,批次,级别,说明',
    csvLines[0]);
  ok('⑩ 说明里有逗号/引号时按 CSV 规则转义（否则一列会被撑成两三列）',
    csv10.includes('"失败, 原因：""库存不足"""'),
    (csv10.split(/\r\n/).find(l => l.includes('库存不足')) || '').slice(0, 60));

  const exp10 = await stats.exportXlsx({ days: 0 });
  const wb10 = new ExcelJS.Workbook();
  await wb10.xlsx.readFile(exp10.file);
  const rows10 = wb10.getWorksheet('执行日志').rowCount - 1;
  ok('⑩ xlsx 里那张「执行日志」表同样不截断（过去固定只导 100 行）',
    rows10 === q10all.logs.length, `${rows10} 行 / 共 ${q10all.logs.length}`);

  // ---- ⑪ 输出目录自检 ----
  // 日志是「追加写、失败不报错」的（写日志失败不能把发布搞挂，这个取舍没错），
  // 于是输出目录指向共享盘、盘一掉，统计就会**悄悄少数据而界面一切正常**。
  // 所以要能当场问一句「这台机器现在写得进去吗」，并且自检本身**不许污染台账**。
  const runBytesBefore = runlog.size();
  const chkOk = stats.checkOutput();
  ok('⑪ 输出目录正常时自检通过，三项全过（目录可建删 / 两个 jsonl 可追加打开）',
    chkOk.ok === true && chkOk.checks.length === 3 && chkOk.checks.every(c => c.ok),
    chkOk.checks.map(c => `${c.name}=${c.ok}`).join(' | '));
  ok('⑪ ★自检不污染台账：run-log 一个字节都没变（追加方式打开，不写内容）',
    runlog.size() === runBytesBefore, `${runBytesBefore} → ${runlog.size()}`);

  const outBefore11 = store.get('paths.output');
  try {
    fs.writeFileSync(path.join(TMP, 'not-a-dir'), 'x', 'utf8');   // 拿一个**文件**当目录用
    store.set({ paths: { output: path.join(TMP, 'not-a-dir', 'sub') } });
    const chkBad = stats.checkOutput();
    ok('⑪ 输出目录不可写时自检必须报错（共享盘掉线就是这个样子）',
      chkBad.ok === false && (chkBad.checks || []).some(c => !c.ok) && !!chkBad.error,
      (chkBad.error || '(没报错)').slice(0, 90));
  } finally {
    store.set({ paths: { output: outBefore11 } });
  }

  console.log('');
  console.log(fail ? `有 ${fail} 项没过。` : '全部通过。');
  console.log('userData(临时): ' + TMP);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('BRAND TEST ERROR', e);
  process.exit(1);
});
