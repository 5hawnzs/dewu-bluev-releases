'use strict';
/* 真机干跑：模拟「模拟器发布 → 点开始发布」后**第一条任务**在模拟器上怎么走。
   ─────────────────────────────────────────────────────────────────────────
   为什么要有它：2026-10-03 用户报「点了开始发布，模拟器上毫无动静，全部卡在排队」。
   那条路径的入口是 src/main/jobs.js 的 `publish.run` → `publisher.run()` —— 本脚本走的是
   **同一个 publisher.run**，不多不少，只是：

     ★ ① 不点「提交发布」（那是真把内容发出去的一下）。干跑只走到它前面一步，
         结尾再 dump 一次，证明「提交按钮真的在这一屏上」—— 有，只是没点。
     ★② 配置用**副本**：从本机 userData/config.json 复制一份到临时目录（定位表 / 设备 /
         间隔全是用户真实值），并把 paths.output 改到临时目录 ⇒ 台账、发布单、报告
         **一条都不会被写脏**。
     ★③ 素材是脚本现造的（2 张 jpg / 1 个 5 秒 mp4），推到设备相册用，干跑完可手动删。

   用法：
     node tools/pubsim.js                # 图文 + 视频各干跑一次（第一条任务）
     node tools/pubsim.js --kind=image   # 只跑图文
     node tools/pubsim.js --kind=video   # 只跑视频
   前置：模拟器在线（adb devices 看得到 127.0.0.1:16384），且得物已登录。
*/
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const arg = k => {
  const hit = process.argv.find(a => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : '';
};
const KINDS = arg('kind') ? [arg('kind')] : ['image', 'video'];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-pubsim-'));
const OUT = path.join(TMP, 'out');
fs.mkdirSync(OUT, { recursive: true });

// ---- 用户真实配置：复制一份到临时 userData（读真值，写只落临时目录） ----
const REAL_CFG = 'C:/Users/Administrator/AppData/Roaming/dewu-bluev-publisher/config.json';
if (!fs.existsSync(REAL_CFG)) {
  console.error('找不到本机配置：' + REAL_CFG + '\n（这台机器上没装/没跑过应用？先启动一次应用再干跑）');
  process.exit(1);
}
const real = JSON.parse(fs.readFileSync(REAL_CFG, 'utf8'));
const cfgCopy = JSON.parse(JSON.stringify(real));
cfgCopy.publish = Object.assign({}, real.publish || {}, {
  // 仓库内置那份 adb（node 直接跑时没有打包后的 resources/ 目录）
  adbPath: path.join(ROOT, 'vendor', 'adb', process.platform === 'win32' ? 'adb.exe' : 'adb')
});
cfgCopy.paths = Object.assign({}, real.paths || {}, { output: OUT });
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(cfgCopy, null, 2));

// ---- electron 替身（和 tools/adbtest.js 同一套）----
const fake = {
  app: {
    getPath: () => TMP, getVersion: () => '1.0.9', requestSingleInstanceLock: () => true,
    on() {}, whenReady: () => Promise.resolve(), quit() {}, setAppUserModelId() {}
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle() {}, on() {} }, dialog: {}, shell: {},
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on() {} },
  Notification: { isSupported: () => false }, screen: {},
  contextBridge: { exposeInMainWorld() {} }, ipcRenderer: {}
};
const origLoad = Module._load;
Module._load = function (r) { if (r === 'electron') return fake; return origLoad.apply(this, arguments); };

const store = require(path.join(ROOT, 'src/main/store.js'));
const adb = require(path.join(ROOT, 'src/main/services/adb.js'));
const publisher = require(path.join(ROOT, 'src/main/services/publisher.js'));
const uimap = require(path.join(ROOT, 'src/main/services/uimap.js'));
const jpeg = require(path.join(ROOT, 'node_modules/jpeg-js'));

// ★ 应用启动时会做这一步（src/main/index.js:53-55），干跑脚本必须补上，
//   否则 adb 既不是「手填的」也不是「内置的」⇒ 退化成系统 PATH 上的 'adb' ⇒ 每条命令 ENOENT。
adb.setAdbPath(store.get('publish.adbPath'));
adb.setBundledAdbDir(path.join(ROOT, 'vendor', 'adb'));
adb.setBundledApkPath(path.join(ROOT, 'vendor', 'adbkeyboard', 'ADBKeyboard.apk'));
const act = adb.getActiveAdb();
console.log('adb 用的是：' + act.path + '（来源 ' + act.source + '）');

const C = store.get('publish') || {};
const SERIAL = C.device || '';
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';

let fail = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) { fail++; process.exitCode = 1; }
};
const line = s => console.log(s);

/* ---------- 素材：图文 2 张 jpg / 视频 1 个 5 秒 mp4 ---------- */
function jpgBuf(r, g, b, size = 320) {
  const d = Buffer.alloc(size * size * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return jpeg.encode({ data: d, width: size, height: size }, 90).data;
}
function makeImageItem() {
  const dir = path.join(TMP, 'flat', '26FW-PUBSIM+干跑白+1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.jpg'), jpgBuf(230, 120, 90));
  fs.writeFileSync(path.join(dir, '2.jpg'), jpgBuf(90, 160, 230));
  // ★★ 2026-10-03 实测：**「关联好物」那一段必须用真实货号** ——
  //   干跑编的货号（26FW-PUBSIM）在得物里搜出来的规格是「黑色 / 迷彩/Camo / 多色 /
  //   紫色/Purple / 蓝色/Blue / 黑色/Black / Tan/谭」，跟编的颜色「干跑白」对不上 ⇒
  //   会卡在「按颜色选卡」那一步（实测：图文干跑就死在这）。
  //   ⇒ 干跑把货号/颜色都留空，定位表里那 7×3 步靠 when=goodsNSku 守卫**整段跳过**。
  //   **这一段干跑不覆盖**（下面报告里如实写）—— 要用真实货号发一条才知道好不好使。
  return { id: '1', dir, absDir: dir, sku: '', color: '', goods: [], files: [{ name: '1.jpg', type: 'image' }, { name: '2.jpg', type: 'image' }] };
}
function makeVideoItem() {
  const dir = path.join(TMP, 'flat', '26FW-PUBSIMV+干跑黑+1');
  fs.mkdirSync(dir, { recursive: true });
  const FF = path.join(ROOT, 'vendor', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!fs.existsSync(FF)) throw new Error('内置 ffmpeg 不在：' + FF);
  require('child_process').execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=5:size=540x960:rate=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    path.join(dir, '1.mp4')], { stdio: ['ignore', 'ignore', 'pipe'] });
  // ★ 同 makeImageItem：好物段用真实货号才走得通 ⇒ 干跑留空、整段跳过（不覆盖那一段）。
  return { id: '1', dir, absDir: dir, sku: '', color: '', goods: [], files: [{ name: '1.mp4', type: 'video' }] };
}

/* ---------- 干跑主体 ---------- */
// ★ 得物首页 = HomeActivity。**不许**用 /\.home\./ 这种宽松正则：
//   实测 `com.shizhuang.duapp.modules.personal.ui.home.PersonalActivity`（个人主页）里也带 ".home."，
//   会把它误判成首页 ⇒ 干跑从个人主页起跑 ⇒ 第 1 步 tapXY(945,1869) 点到内容卡片、
// ★★ 2026-10-03 真机实测：得物**冷启动后会恢复「未编辑完的内容」**，此时点底部任何 tab 都会弹
//   「你有未编辑完的图文动态，是否继续？」（放弃 / 继续）—— 用户原话：「因为现在你没有正式发布，
//   你都是保存草稿，所以回主页会弹这个弹窗，后续正式发布就不会有这个问题了，可以直接点击放弃→回到主页」。
//   实测证据（干跑视频第一条就栽在这）：上一条图文停在编辑页（干跑不提交）⇒ 下一条一开始点「我」
//   就撞上它，报「找不到 tvGoHomePage；当前可见文本：…是否继续？/ 放弃 / 继续」。
//   ★ 而且 `mCurrentFocus` **仍显示 HomeActivity** —— 这弹窗不是独立 Window，dumpsys 看不出来，
//     只有 dump 才看得到（此前一直以为是「按 id 找首页失灵」）。
//   ★ 这一步只修在**干跑脚本**里（起跑准备），**不进产品定位表**：正式发布会点「提交发布」，
//     不会留下未编辑内容 ⇒ 不会有这个弹窗。
async function dismissDraftResume(serial) {
  const d = await publisher.dumpEx(serial, { pkg: uimap.DEWU.pkg, retries: 0 });
  if (!d.ok) return false;
  const nodes = uimap.parseNodes(d.xml);
  if (!nodes.some(n => /是否继续/.test(String(n.text || '')))) return false;
  const btn = uimap.findNodes(nodes, { text: '放弃' }).find(x => x && x.center)
    || uimap.findNodes(nodes, { contains: '放弃' }).find(x => x && x.center);
  if (!btn) return false;
  line('   ⚠ 得物弹了「你有未编辑完的图文动态，是否继续？」—— 点「放弃」（干跑不提交，上一条留的是半成品）');
  await adb.tapSeq(serial, [{ x: btn.center.x, y: btn.center.y }], 0);
  await new Promise(r => setTimeout(r, 1500));
  return true;
}

//   直接打开动态详情（干跑第一次就栽在这上面）。
const HOME_RE = /com\.shizhuang\.duapp\/[\w.]*(Home|Main)Activity/;
async function goHome(serial) {
  // 干跑第 1 步是点底部「我」（首页 tab_user，实测 bounds [810,1819][1080,1920]），
  // 所以起点必须是首页；在别的屏上点这个坐标就是乱点。
  for (let i = 0; i < 5; i++) {
    // ★ 先拆「是否继续编辑」弹窗：它在的时候，下面按钮全是白点（实测）
    if (await dismissDraftResume(serial)) continue;
    const f = await publisher.currentFocus(serial);
    if (f && HOME_RE.test(f)) return f;
    await publisher.runStep(serial, { action: 'back' }, {}, {});
    await new Promise(r => setTimeout(r, 900));
  }
  // 还是没到首页 ⇒ 冷启动得物。
  //   为什么必须冷启动：停在「发布编辑页」时按 back 只会弹「返回编辑 / 保存并退出 / 取消」，
  //   back 键被这个对话框吃掉，再按多少次都出不来（实测）。
  await adb.shell(serial, 'am force-stop com.shizhuang.duapp').catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  await adb.shell(serial, 'monkey -p com.shizhuang.duapp -c android.intent.category.LAUNCHER 1').catch(() => {});
  await new Promise(r => setTimeout(r, 9000));
  // ★ 冷启动后得物会**恢复未编辑内容** ⇒ 起跑前必须再拆一次「是否继续编辑」弹窗
  for (let i = 0; i < 4; i++) { if (!await dismissDraftResume(serial)) break; }
  return await publisher.currentFocus(serial);
}

async function dryRun(kind) {
  line('');
  line('══════════ 干跑：' + (kind === 'video' ? '发布视频' : '发布图文') + '（第一条任务）══════════');
  const item = kind === 'video' ? makeVideoItem() : makeImageItem();
  const copyRow = {
    id: '1',
    title: kind === 'video' ? '干跑不发布·视频标题' : '干跑不发布·图文标题',
    body: '这是干跑正文。\n只验证流程走到提交前一步。\n不会真的发出去。',
    topics: ['干跑话题'], sku: item.sku, color: item.color
  };

  const mapSrc = C.uiMap || {};
  const rawSteps = (kind === 'video' && (mapSrc.videoSteps || []).length) ? mapSrc.videoSteps : (mapSrc.steps || []);
  const all = rawSteps.map(s => Object.assign({}, s));
  // ★ 剔掉「提交发布」那一步 —— 点了就真发出去了
  const isPublishTap = s => /tvPublish/i.test(String(s.value || '')) || /提交发布|发布$/.test(String(s.name || ''));
  const submitStep = all.find(isPublishTap);
  const steps = all.filter(s => !isPublishTap(s));

  const state = {
    items: [item],
    copyRows: [copyRow],
    verify: { rows: [] },
    publish: {
      mode: 'adb', device: SERIAL, rows: [{ seq: 1, id: '1', dir: item.dir, kind, goods: 1, images: 0, startAt: '', status: '排队', result: '', reason: '' }],
      batch: '干跑-' + kind,
      // ★★ 2026-10-03 事故修复：videoSteps 也**必须**剔除「提交发布」。
      //   原来只剔了 steps ⇒ 视频干跑走 videoSteps 时，「提交发布」照样会被点（真发出去）。
      uiMap: Object.assign({}, mapSrc, { steps, videoSteps: all.filter(s => !isPublishTap(s)) })
    }
  };

  const t0 = Date.now();
  const logLines = [];
  const trace = [];
  let lastStep = '';
  let q = Promise.resolve();   // 串行队列：onRow 是同步回调，但读前台是异步的，不能并发（会乱序）
  const ctx = {
    log: (msg, lv) => { const s = `[${stamp()}] ${msg}`; logLines.push(s); line('   ' + (lv === 'warn' ? '⚠ ' : lv === 'ok' ? '✓ ' : '· ') + s); },
    // ★ 逐屏轨迹：每一步开始前记一次「前台是哪个 Activity」——
    //   干跑最值钱的产物：一眼看出「定位表以为第 N 步跳到 A 屏，实际停在 B 屏」。
    onRow: row => {
      const name = row.status;
      if (!name || name === lastStep) return;
      lastStep = name;
      q = q.then(async () => {
        const f = await publisher.currentFocus(SERIAL).catch(() => '');
        const short = String(f || '').replace(/^Window\{[^}]*\}\s*/, '').replace('com.shizhuang.duapp/', '');
        trace.push({ step: name, focus: short });
        line(`      ↳ 到这一步时的屏幕：${short || '(读不到)'}`);
      });
    },
    cancelled: () => false
  };

  let err = null, res = null;
  try {
    res = await publisher.run(state, ctx);
  } catch (e) { err = e; }
  await q.catch(() => {});
  await new Promise(r => setTimeout(r, 400));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  line('');
  line(`── 结果（耗时 ${secs}s）──`);
  const row = (res && res.rows && res.rows[0]) || null;
  ok(`${kind}) 第一条任务跑完，没抛异常`, !err, err ? err.message : (row ? `${row.result}` : ''));
  if (row) {
    line(`   行状态：${row.status} / ${row.result}${row.reason ? '（原因：' + row.reason + '）' : ''}`);
    ok(`${kind}) 结果写的是「发布成功」`, row.result === '发布成功', row.result);
  }
  // 视频：绝不能再等 MediaStore。
  // ★ 断言文案必须贴**真实输出**：第一次写的是「等媒体库索引」，而代码里实际抛的是
  //   「视频已推到设备，但等了 182s 媒体库还没索引到」—— 两边对不上 ⇒ 明明等了 182 秒，
  //   断言却 PASS（假绿）。两处都认。
  const waitedLines = logLines.filter(l => /媒体库还没索引到|等媒体库索引/.test(l));
  ok(`${kind}) 没有再出现「等媒体库索引」`, waitedLines.length === 0, waitedLines[0] || '（日志里没有）');
  if (kind === 'video') {
    ok('video) ★ 视频推完真的写进媒体库并确认（得物相册读的就是这张表）',
      logLines.some(l => /确认写进媒体库/.test(l)),
      logLines.filter(l => /媒体库|已推/.test(l))[0] || '（没找到）');
  } else {
    ok('image) 图文按图片数一次点了多张（选图步）', logLines.some(l => /一次点了 2 个/.test(l)),
      logLines.filter(l => /一次点了/.test(l))[0] || '（没找到「一次点了 N 个」—— 选图步没按 count 点多张）');
  }
  // ★ 2026-10-03 诊断：把轨迹末尾（含**步骤名**）打出来。
  //   原来的轨迹只有屏幕名、没有步骤名 ⇒ 看不出「哪一步之后屏幕变了」。
  line('   轨迹（末尾 12 条，含步骤名）：');
  for (const t of trace.slice(-12)) line(`     · ${t.step} → ${t.focus || '(读不到)'}`);
  // 提交按钮在不在屏上（有，只是没点）
  const dump = await publisher.dumpEx(SERIAL, { pkg: uimap.DEWU.pkg, retries: 1 });
  let onScreen = false, via = '';
  if (dump.ok) {
    via = dump.via || 'uiautomator';
    const nodes = uimap.parseNodes(dump.xml);
    onScreen = nodes.some(n => /tvPublish/i.test(String(n.id || '')));
  }
  ok(`${kind}) 干跑停在「提交发布」前一步，且提交按钮真在这一屏上（本次没点）`,
    onScreen, onScreen ? `找到 id=com.shizhuang.duapp:id/tvPublish（通道 ${via}）` : `这一屏上没找到 tvPublish（via=${via || '抓不到'}）`);
  line(`   剔除的那一步：${submitStep ? (submitStep.name + ' [' + submitStep.action + '] ' + submitStep.value) : '（定位表里没找到提交步！）'}`);

  // ★★ 复核（本次修复的核心）：这条素材**真的在媒体库里**吗？
  //   真机上 push ≠ 进库 —— 不进库的话，得物相册里根本看不到它（点别的格子就会报
  //   「暂不支持的视频格式」）。publisher 内部已经走过一遍，这里独立再查一次，
  //   免得「内部那条确认是假绿」。
  // ★ 2026-10-03（第三十四轮）：素材现在推到**本工具专属目录** bluev（得物相册里是一个独立相册），
  //   不再是 /sdcard/DCIM/Camera（那是聚合目录，设备上所有素材混在一起）。
  const remoteOf = f => '/sdcard/DCIM/Camera/bluev/' + String(f.name).replace(/[^\w.\-+]/g, '_');
  const remotes = (item.files || []).map(remoteOf);
  const mv = await adb.mediaVisible(SERIAL, remotes, { timeoutMs: 3000, pollMs: 500 });
  ok(`${kind}) ★★ 复核：推的素材真在媒体库里（= 得物相册看得到它）`, mv.ok,
    mv.ok ? `${remotes.length} 个都在库里（${mv.waited}s）` : `不在库里：${mv.error || '超时'} / ${remotes.join('、')}`);
  return { secs, logLines };
}

(async () => {
  line('临时现场   = ' + TMP);
  line('设备       = ' + SERIAL + '（来自本机 config.json 的 publish.device）');
  line('通道       = ' + (C.mode || '(空)') + ' · 定位表 图文 ' + ((C.uiMap || {}).steps || []).length + ' 步 / 视频 ' + ((C.uiMap || {}).videoSteps || []).length + ' 步');
  line('间隔       = ' + (C.intervalSec || 60) + 's（视频单独值 ' + (C.videoIntervalSec || 0) + 's，0 = 跟随上面的）');
  line('进库确认等待 = ' + (C.videoIndexTimeoutSec || 0) + 's（0 = 用内置 20s：得物相册读 MediaStore，推完必须确认进库）');
  if (!SERIAL) { ok('0) 配置里有选中的设备', false, 'publish.device 是空的'); return; }

  // 起点：先回首页，并如实记录停在哪一屏
  const focus = await goHome(SERIAL);
  line('');
  line('起点：' + (focus || '(读不到前台)'));
  // ★★ 硬保险：起点**必须**是得物首页。
  //   为什么不能放宽：定位表第 1 步是 tapXY(945,1869)，而在「发布编辑页」上
  //   这个坐标正好落在 `tvPublish`（发布按钮 [205,1815][1045,1892]）里 ——
  //   起点错成编辑页 = 干跑第一下就把内容真发出去。实测踩到过（见 HANDOFF）。
  //   ⇒ 宁可这次干跑不做，也不在未知的屏上点坐标。
  ok('0) 起点是得物首页（HomeActivity）—— 不是就中止，绝不在别的屏上点坐标',
    !!focus && HOME_RE.test(focus), focus || '(读不到前台)');
  if (!(focus && HOME_RE.test(focus))) {
    line('★ 已中止：把模拟器手动退到得物首页（有底部「我 / 购买 / 探索」那一屏）再跑一次。');
    return;
  }

  for (const k of KINDS) {
    await dryRun(k);
    // 两条之间回首页，免得第二次从编辑页起跑
    if (KINDS.length > 1) await goHome(SERIAL);
  }

  line('');
  line('══════════ 干跑结束 ══════════');
  line('★ 全程没有点「提交发布」⇒ 模拟器上的内容都停在编辑页，没有真的发出去。');
  line('★ 台账 / 发布单 / 报告一条都没写（输出目录是临时目录：' + OUT + '）。');
  line('★ 「关联好物」那一段（点关联好物 → 搜货号 → 按颜色选卡）**干跑没有覆盖**：');
  line('  它用的货号必须是得物里真实存在的，编一个只会卡在选卡那步（实测）。要用真实货号发一条才算验过。');
  line('★ 干跑素材在设备的专属相册目录 /sdcard/DCIM/Camera/bluev/ 下（1.jpg 2.jpg 1.mp4）。');
  line('  （这个目录是 App 每条发布前会清空的专属目录；得物相册下拉里它显示成一个独立相册。）');
  if (fail) { line(''); line(`==== FAIL ${fail} 条 ====`); }
})();
