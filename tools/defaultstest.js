/* 出厂内置的「装上即用」资产（2026-10-08 用户口径：「装上即用」「直接固化」）
   要钉住的事：
     ① 出厂 store.defaults() 里**不许**有 publish.uiMap（写进去＝随保存落盘＝固化）；
     ② 本机没有这个键时，读出来**就是**内置表（38 步图文 + 41 步视频）⇒ 同事装完界面不再说「定位表未配」；
     ③ 读内置表**不写回** config.json（写回＝固化，换新表重发包顶不动）；
     ④ 显式 null 是「我就是要没有表」，**不许**被内置值顶掉（adbtest 靠它验「未配必须报错」）；
     ⑤ 本机自己抓/导入的表**优先于**内置表；
     ⑥ 内置表带 1080x1920 坐标系戳，8 个写死坐标全在屏内；且戳真能拦住别的分辨率（反向对照）。
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-def-'));
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
const uimap = require(path.join(base, 'src/main/services/uimap.js'));
const builtin = require(path.join(base, 'src/main/uimapdefaults.js'));

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfgRaw = () => (fs.existsSync(store.file()) ? fs.readFileSync(store.file(), 'utf8') : '{}');

(async () => {
  console.log('出厂内置资产（定位表）——' + TMP + '\n');

  /* ---- ① 出厂默认值里不许有它（不固化） ---- */
  const d = store.defaults();
  ok('默认启用在线文案模型', d.copy.llm.enabled === true);
  ok('发布间隔默认连续发布', d.publish.intervalSec === 0);
  fs.writeFileSync(store.file(), JSON.stringify({ copy: { llm: { enabled: false } }, publish: { intervalSec: 60 } }));
  ok('旧版配置首次升级切换到在线模型和连续发布', store.get('copy.llm.enabled') === true && store.get('publish.intervalSec') === 0);
  store.set({ publish: { intervalSec: 90 } });
  store.flush();
  delete require.cache[require.resolve(path.join(base, 'src/main/store.js'))];
  const reloaded = require(path.join(base, 'src/main/store.js'));
  ok('完成迁移后保留用户自行选择的 90 秒间隔', reloaded.get('publish.intervalSec') === 90);
  ok('① 出厂 publish.uiMap **不存在**（写进 defaults 就会随保存落盘 ⇒ 固化）',
    d.publish && d.publish.uiMap === undefined,
    JSON.stringify({ has: !!(d.publish && d.publish.uiMap), keys: Object.keys(d.publish || {}).length }));
  ok('① 但键列表里也没有它留下的空壳（不能是 null / {} —— 那会挡住兜底）',
    d.publish && !Object.prototype.hasOwnProperty.call(d.publish, 'uiMap'));

  /* ---- ② 空白机器：读出来就是内置表 ---- */
  const eff = store.get('publish.uiMap');
  const E = eff || {};                     // ★ 只为了「真出事时报红而不是崩掉」：破坏版下 eff 会是 undefined
  ok('② 新机器（本机没有这个键）⇒ 读出来**就是内置定位表**（同事装上即可发布）',
    !!eff && Array.isArray(E.steps) && E.steps.length === 38 && (E.videoSteps || []).length === 41,
    JSON.stringify({ steps: (E.steps || []).length, video: (E.videoSteps || []).length }));
  ok('② 换一条读取路径也拿得到（store.get(\'publish\') 这条链不能漏）',
    !!store.get('publish') && !!store.get('publish').uiMap && store.get('publish').uiMap.steps.length === 38);
  ok('② 内置表与抓表那台机器上的**逐字节一致**（不是编的：比对 steps/videoSteps 两份 JSON）',
    JSON.stringify(E.steps) === JSON.stringify(builtin.steps)
    && JSON.stringify(E.videoSteps) === JSON.stringify(builtin.videoSteps));
  ok('② 内置表里带着包名，publisher 用得上',
    E.package === 'com.shizhuang.duapp', String(E.package));
  // ★ 这条直接对准用户的目标（「同事装上就能发」）：publisher.connect() 里那句 hasMap 判据
  //   取的就是 store.get('publish') 这个对象 ⇒ 只有内置表时它也必须为 true，
  //   否则同事点发布会看到「定位表未配」被拦下。
  const pcfg = store.get('publish') || {};
  ok('② 按 publisher.cfg() 的取法算 hasMap ⇒ true（同事装完点发布不会被「定位表未配」拦下）',
    !!(pcfg.uiMap && pcfg.uiMap.steps && pcfg.uiMap.steps.length) === true);

  /* ---- ③ 读内置表**不写回** config.json ---- */
  store.set({ publish: { intervalSec: 45 } });     // 改一个无关设置，触发一次整份保存
  await sleep(400);                                 // scheduleSave 是 250ms 防抖
  const raw1 = cfgRaw();
  ok('③ 读过内置表之后，config.json 里**没有**它（不写回＝以后换表能自动跟随）',
    !/videoSteps/.test(raw1) && !/tapXY/.test(raw1) && !/com\.shizhuang\.duapp/.test(raw1),
    '命中：' + (['videoSteps', 'tapXY', 'com.shizhuang.duapp'].filter(s => raw1.includes(s)).join(',') || '(无)'));
  // 反向对照：证明上面那条判据**不是恒真** —— 真的显式写一张表进去，文件里就必须能看到
  store.set({ publish: { uiMap: { package: 'p', steps: [], videoSteps: [], screen: null } } });
  await sleep(400);
  ok('③ 反向对照：显式导入的表**确实会**落进 config.json（否则上面那条断言等于没查）',
    /videoSteps/.test(cfgRaw()) && /"package": "p"/.test(cfgRaw()));

  /* ---- ④ 显式 null = 「我就是要没有表」，不许被顶掉 ---- */
  store.set({ publish: { uiMap: null } });
  ok('④ 显式 null ⇒ 读出来还是 null（不被内置表顶掉；adbtest 靠它验「未配必须报错」）',
    store.get('publish.uiMap') === null, JSON.stringify(store.get('publish.uiMap')));
  await sleep(400);
  ok('④ 而且落盘也是 null，不是内置表', /"uiMap": null/.test(cfgRaw()));

  /* ---- ⑤ 本机的表优先于内置表 ---- */
  const mine = { package: 'mine', steps: [{ name: 'x', action: 'tapId', value: 'a/b' }], videoSteps: [] };
  store.set({ publish: { uiMap: mine } });
  ok('⑤ 本机自己抓/导入的表 ⇒ 完全用本机的（内置表一个字节都不参与）',
    JSON.stringify(store.get('publish.uiMap')) === JSON.stringify(mine));

  /* ---- ⑥ 坐标系戳 ---- */
  ok('⑥ 内置表带 1080x1920 竖屏坐标系戳（原表没有，是本次按实测补的）',
    builtin.screen && builtin.screen.w === 1080 && builtin.screen.h === 1920 && builtin.screen.landscape === false,
    JSON.stringify(builtin.screen));
  const pts = uimap.tapPointsOf(builtin.steps).concat(uimap.tapPointsOf(builtin.videoSteps));
  ok('⑥ 表里 8 个写死的 tapXY 坐标，全部落在 1080x1920 内（戳对得上，不误拦）',
    pts.length === 8 && uimap.outOfScreenTapPoints(builtin.steps.concat(builtin.videoSteps),
      { known: true, w: 1080, h: 1920 }).length === 0,
    '坐标数=' + pts.length + ' 越界=' + uimap.outOfScreenTapPoints(builtin.steps.concat(builtin.videoSteps), { known: true, w: 1080, h: 1920 }).length);
  // 反向对照：同一张表放到横屏 1920x1080 上，必须能认出越界（证明上面那条不是恒真）
  const cross = uimap.outOfScreenTapPoints(builtin.steps.concat(builtin.videoSteps), { known: true, w: 1920, h: 1080 });
  ok('⑥ 反向对照：同一张表放到 1920x1080 上 ⇒ 那两个 y≈1850 的坐标必须被认成越界',
    cross.length >= 2, JSON.stringify(cross.map(p => p.value)));
  // 戳的拦截语义
  const mm = uimap.screenMismatch(builtin.screen, { known: true, w: 900, h: 1600 });
  ok('⑥ 戳真能拦：同事的模拟器若是 900x1600（分辨率不同但坐标仍在屏内）⇒ 必须报 mismatch',
    mm.judgeable === true && mm.mismatch === true, mm.why);
  const mm2 = uimap.screenMismatch(builtin.screen, { known: true, w: 1080, h: 1920 });
  ok('⑥ 反向对照：同一坐标系下**不许**误报（不然所有人都发不出去）', mm2.mismatch === false);
  const mm3 = uimap.screenMismatch(builtin.screen, { known: false, w: 0, h: 0 });
  ok('⑥ 读不到当前尺寸时不当判据（不许拿猜的尺寸误拦）', mm3.judgeable === false);

  console.log('');
  console.log(process.exitCode ? '有 FAIL' : '全部通过');
})().catch(e => { console.log('FAIL  用例抛异常（不许抛）：' + (e && e.stack || e)); process.exitCode = 1; });
