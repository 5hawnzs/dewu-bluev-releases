// 渲染层动作接口回归：运行实际代码，IPC 用独立 adapter 控制返回与时序。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0;
function check(label, fn) { fn(); passed++; console.log('PASS  ' + label); }
function context(values) { return vm.createContext({ JSON, Object, Number, ...values }); }
function block(from, to) { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))); }
function saveBlock() { return block('async function checkedConfigSet(', '/**\n * 页内所有 data-cfg'); }
async function statsRace() {
  let finish;
  const sent = [];
  const state = { auth: {}, statsBusy: false, statsOpts: { brandId: 'A', days: 30 } };
  const c = context({ state, renderAll() {}, appApi: { statsQuery: opts => {
    sent.push(JSON.parse(JSON.stringify(opts))); return new Promise(resolve => { finish = resolve; });
  } } });
  vm.runInContext(block('async function loadStats()', 'function syncStatsExportButtons()'), c);
  const pending = vm.runInContext('loadStats()', c);
  state.statsOpts.brandId = 'B';
  finish({ ok: true, rows: [{ brandId: 'A' }] });
  await pending;
  check('查询期间修改筛选：返回结果仍属于发起时的 A，禁止作为 B 导出', () => {
    assert.equal(sent[0].brandId, 'A'); assert.equal(state.stats.rows[0].brandId, 'A');
    assert.equal(state.statsQueryOpts.brandId, 'A'); assert.equal(vm.runInContext('statsFiltersCurrent()', c), false);
  });
}
async function rejectedSave() {
  const toasts = []; let reads = 0;
  const c = context({ state: { config: { original: true }, tab: 7 },
    document: { querySelectorAll: () => [{ dataset: { cfg: 'copy.requiredTopic' }, type: 'text', value: '#测试' }] },
    appApi: { configSet: async () => ({ ok: false, error: '测试拒绝保存' }), configGet: async () => { reads++; return {}; } },
    toast: (message, kind) => toasts.push({ message, kind }), renderAll() {} });
  vm.runInContext(saveBlock(), c);
  vm.runInContext('runSave = ' + source.match(/'cfg:save':\s*(async \(\) => \{[^\n]*\})/)[1], c);
  await vm.runInContext('runSave()', c);
  check('保存被拒绝：展示原因且不提示成功、不刷新覆盖现有草稿', () => {
    assert.equal(toasts.length, 1); assert.equal(toasts[0].kind, 'err');
    assert.match(toasts[0].message, /测试拒绝保存/); assert.equal(reads, 0); assert.equal(c.state.config.original, true);
  });
}
async function saveOtherResults() {
  for (const reject of [false, true]) {
    const toasts = []; let reads = 0;
    const c = context({ state: { config: { original: true }, tab: 3 },
      document: { querySelectorAll: () => [{ dataset: { cfg: 'publish.intervalSec' }, type: 'text', value: '0' }] },
      appApi: { configSet: async patch => { assert.equal(patch.publish.intervalSec, 0); if (reject) throw new Error('连接断开'); return { publish: { intervalSec: 0 } }; },
        configGet: async () => { reads++; return { publish: { intervalSec: 0 } }; } },
      toast: (message, kind) => toasts.push({ message, kind }), renderAll() {} });
    vm.runInContext(saveBlock(), c);
    vm.runInContext('runSave = ' + source.match(/'cfg:save':\s*(async \(\) => \{[^\n]*\})/)[1], c);
    await vm.runInContext('runSave()', c);
    check(reject ? '保存连接断开：如实提示且保留原状态' : '保存成功：兼容真实 IPC 配置对象并提示成功', () => {
      assert.equal(toasts.length, 1); assert.equal(toasts[0].kind, reject ? 'err' : 'ok'); assert.equal(reads, reject ? 0 : 1);
      if (reject) assert.match(toasts[0].message, /连接断开/);
      else { assert.equal(toasts[0].message, '已保存'); assert.equal(c.state.config.publish.intervalSec, 0); }
    });
  }
}
async function importFailure() {
  const cases = [
    { error: '素材路径不存在或不是文件夹：D:\\不存在。如果这份报告的「素材路径」是空的，导入时选一下这一批的素材目录即可', expected: 0 },
    { error: '表头里找不到「素材路径」列；读到的是：标题 / 文案', expected: 0 },
    { error: '报告里没有一条能用的：第 2 行 缺「素材路径」，也没有指定这一批的素材目录', expected: 1 }
  ];
  for (const item of cases) {
    let picks = 0; const toasts = [];
    const c = context({ state: { project: { publish: {} } }, lastCopyReport: null,
      brandArgs: (_type, args) => args, renderAll() {}, toast: text => toasts.push(text),
      appApi: { pickFile: async () => 'report.xlsx', run: async () => ({ ok: false, error: item.error }),
        pickDir: async () => { picks++; return null; } } });
    vm.runInContext('runImport = ' + block("'sheet:importReport': ", "'pub:connect':").replace(/^'sheet:importReport': /, '').replace(/,\s*$/, ''), c);
    await vm.runInContext('runImport()', c);
    check('报告导入只在确实缺路径时询问目录：' + item.error.slice(0, 28), () => {
      assert.equal(picks, item.expected); if (!item.expected) assert.equal(toasts[0], item.error);
    });
  }
}
async function modelSaveRejected() {
  const toasts = []; let closed = false, reads = 0;
  const c = context({ state: { config: {} }, $: () => ({ value: '测试模型' }),
    appApi: { configSet: async () => ({ ok: false, error: '禁止保存' }), configGet: async () => { reads++; return {}; } },
    closeModelModal: () => { closed = true; }, toast: text => toasts.push(text) });
  const helper = block('async function checkedConfigSet(', 'async function saveCfgFromDom()');
  if (helper) vm.runInContext(helper, c);
  vm.runInContext('runModel = ' + block("'lm:save': ", '// 「提示词配置」').replace(/^'lm:save': /, '').replace(/,\s*$/, ''), c);
  let error;
  try { await vm.runInContext('runModel()', c); } catch (e) { error = e; }
  check('真实模型保存被拒绝：中断成功提示与关闭弹窗，错误交点击入口展示', () => {
    assert.match(String(error && error.message), /禁止保存/); assert.equal(closed, false); assert.equal(reads, 0); assert.equal(toasts.length, 0);
  });
}
function draftBackground() {
  for (const change of ['same', 'tab', 'auth']) {
    let onProject;
    const makeFields = () => [{ dataset: { cfg: 'copy.requiredTopic' }, type: 'text', value: '#旧', defaultValue: '#旧' },
      { dataset: { cfg: 'verify.api.apiKey' }, type: 'password', value: '旧密钥', defaultValue: '旧密钥' }];
    let fields = makeFields();
    const pane = { dataset: {}, querySelectorAll: () => fields };
    const state = { tab: 3, auth: { user: { id: 'u1', role: 'admin', brands: ['A'] } } };
    const c = context({ state, $: () => pane, document: { activeElement: null }, appApi: { onProject: fn => { onProject = fn; } },
      renderAll: () => { fields = makeFields(); pane.dataset.cfgOwner = helper ? vm.runInContext('cfgDraftOwner()', c) : ''; } });
    const helper = block('function cfgDraftOwner()', 'function renderAll()');
    if (helper) vm.runInContext(helper, c);
    pane.dataset.cfgOwner = helper ? vm.runInContext('cfgDraftOwner()', c) : '';
    fields[0].value = '#未保存'; fields[1].value = '未保存密钥';
    if (change === 'tab') state.tab = 7;
    if (change === 'auth') state.auth.user = { id: 'u2', role: 'member', brands: [] };
    vm.runInContext(source.match(/  appApi\.onProject\([^\n]+/)[0], c);
    onProject({ changed: true });
    check('后台项目事件草稿归属：' + change, () => {
      assert.equal(fields[0].value, change === 'same' ? '#未保存' : '#旧');
      assert.equal(fields[1].value, '旧密钥'); assert.equal(state.project.changed, true);
    });
  }
}
(async () => { await statsRace(); await rejectedSave(); await saveOtherResults(); await importFailure(); await modelSaveRejected(); draftBackground(); console.log(`前端状态回归 ${passed} 项通过`); })().catch(error => { console.error(error); process.exitCode = 1; });
