'use strict';
/**
 * ADB 驱动层：只做「确实能做到」的真实动作，做不到就明确报错，绝不假装成功。
 *   - 设备在线 / 分辨率 / 包是否安装 / 工具可用性：真实探测
 *   - 推图 + 触发媒体扫描：真实命令
 *   - 界面结构抓取（uiautomator dump）+ 点击 / 输入：真实命令
 *   - 中文输入依赖 ADBKeyboard（com.android.adbkeyboard）—— apk 随包内置，
 *     探测里会说清「装没装 / 启用没启用」，并给一个「一键装上」的按钮
 *
 * ★ adb 本身也随包内置（`vendor/adb/` → 打包后 `resources/adb/`），
 *   解析顺序见下面 setAdbPath 那段注释：手填 > 内置 > 系统 PATH。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * adb 可执行文件从哪来 —— 三段，优先级从高到低：
 *   ① **用户手填**的完整路径（填了、且文件真的在 ⇒ 就用它。绝不因为「内置了一个」就悄悄替掉他的配置）
 *   ② **程序内置**（安装包里的 `resources/adb/adb.exe`，开发时是仓库 `vendor/adb/`）⇒ 新同事零配置
 *   ③ 系统 **PATH** 上的 `adb`（老用户既有的装法，不能被内置版本打断）
 *
 * 解析结果里带 `source`，界面照实显示「现在用的是哪一个、从哪来」—— 不猜、不藏。
 * 这一段只依赖 fs/path，不 require('store')：测试里换假 adb 只动 child_process 那一层就够了。
 */
let adbBin = 'adb';      // 用户手填值（'' 或 'adb' = 没填）
let bundledDir = '';     // 内置 adb 所在目录（打包后 resources/adb；开发时仓库 vendor/adb）
let bundledApk = '';     // 内置的中文输入法 apk（ADBKeyboard.apk 的绝对路径）

function setAdbPath(p) {
  const s = String(p == null ? '' : p).trim();
  adbBin = s || 'adb';
  return adbBin;
}
function getAdbPath() { return adbBin; }
function setBundledAdbDir(d) { bundledDir = String(d == null ? '' : d).trim(); return bundledDir; }
function getBundledAdbDir() { return bundledDir; }
function setBundledApkPath(p) { bundledApk = String(p == null ? '' : p).trim(); return bundledApk; }
function getBundledApkPath() { return bundledApk; }

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
function bundledAdbPath() { return bundledDir ? path.join(bundledDir, ADB_EXE) : ''; }

/**
 * ★ 纯函数（不碰文件系统），专门为了能被测试直接喂输入：
 *   `resolveAdbChoice({ configured, bundled, exists })` → { path, source, configuredMissing, bundled }
 * source 取值：`configured`（用你填的）/ `bundled`（用内置的）/ `path`（走系统 PATH）/
 *              `configured-missing`（你填的那个不存在，也**没有**可用的备选）
 */
function resolveAdbChoice({ configured = '', bundled = '', exists = () => false } = {}) {
  const cfg = String(configured || '').trim();
  const cfgIsPath = !!cfg && cfg !== 'adb';
  const cfgMissing = cfgIsPath && !exists(cfg);
  if (cfgIsPath && !cfgMissing) return { path: cfg, source: 'configured', configuredMissing: false, bundled: '' };
  if (bundled && exists(bundled)) return { path: bundled, source: 'bundled', configuredMissing: cfgMissing, bundled };
  return { path: cfg || 'adb', source: cfgIsPath ? 'configured-missing' : 'path', configuredMissing: cfgMissing, bundled: '' };
}

/** 当前实际会去执行的那个 adb（每次现算，不做缓存 —— 用户可能刚把文件放进去） */
function active() {
  return resolveAdbChoice({ configured: adbBin, bundled: bundledAdbPath(), exists: fs.existsSync });
}
function getActiveAdb() { return active(); }

/** 随包内置的这两样东西到底在不在（设置页「外部依赖」照实显示，不猜） */
function bundledStatus() {
  const exe = bundledAdbPath();
  return {
    dir: bundledDir, exe, exists: !!(exe && fs.existsSync(exe)),
    apk: bundledApk, apkExists: !!(bundledApk && fs.existsSync(bundledApk)),
    active: active()
  };
}

function execAdb(args, { timeout = 20000, binary = false } = {}) {
  return new Promise(resolve => {
    execFile(active().path, args, {
      timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8'
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      stdout: stdout || (binary ? Buffer.alloc(0) : ''),
      stderr: String(stderr || ''),
      code: err ? err.code : null
    }));
  });
}

const withS = (serial, args) => (serial ? ['-s', serial] : []).concat(args);

async function version() {
  const r = await execAdb(['version']);
  return r.ok ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

async function devices() {
  const r = await execAdb(['devices']);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).slice(1)
    .map(l => l.trim()).filter(Boolean)
    .map(l => { const [serial, state] = l.split(/\s+/); return { serial, state }; });
}

async function online(serial) {
  const list = await devices();
  return list.find(d => d.serial === serial && d.state === 'device') || null;
}

async function shell(serial, cmd, opts) {
  return execAdb(withS(serial, ['shell', cmd]), opts);
}

async function push(serial, local, remote) {
  return execAdb(withS(serial, ['push', local, remote]), { timeout: 120000 });
}

/**
 * 推完素材触发媒体扫描，否则得物相册里看不到。
 *
 * ★★ 实测（2026-10-01，MuMu 12 / Android 12，900×1600）：**这一对广播都不生效**。
 *   · `MEDIA_MOUNTED` 已是受保护广播 ⇒ `SecurityException: Permission Denial:
 *     not allowed to send broadcast android.intent.action.MEDIA_MOUNTED from uid=2000(shell)`；
 *   · `MEDIA_SCANNER_SCAN_FILE` 能发出去（`Broadcast completed: result=0`）但**没有接收者**：
 *     发完等 20 秒，MediaStore 里依然查不到那个文件（不是慢，是没人处理）；
 *   · 直接 `content insert` 写 MediaStore 也没权限（shell 不在 media_rw 组）。
 *   ⇒ ★ **只有重启模拟器**（系统重扫）才会把新文件收进相册。
 *   （图片看起来"能进库"，是因为系统自己的 idle 扫描补上了小文件，跟这两条广播无关。）
 *
 *   所以调用方**必须**用 `mediaVisible()` 等「真的能看见」再往下走，等不到就明确失败 ——
 *   这里"发完就当成功"会在几步之后变成「相册里选不到素材」，极难查。
 *   这两条广播保留着：换设备/换系统版本可能仍然有效，成本只是一次 shell 调用。
 */
async function mediaScan(serial, remoteFile) {
  await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${remoteFile}`);
  return shell(serial, `am broadcast -a android.intent.action.MEDIA_MOUNTED -d file://${remoteFile.split('/').slice(0, -1).join('/')}`);
}

async function screencap(serial, outFile) {
  const r = await execAdb(withS(serial, ['exec-out', 'screencap', '-p']), { timeout: 20000, binary: true });
  if (!r.ok || !r.stdout.length) return null;
  return r.stdout;
}

/**
 * 媒体库里能不能看见这几个文件（= 得物相册里有没有）。
 *
 * 为什么非要有这一条：推完文件只发一条 MEDIA_SCANNER_SCAN_FILE 广播，**索引是异步的**。
 * 图片小、扫得快，所以一直没暴露；视频几十 MB，广播一发就去点相册 → 稳定「相册里选不到这条视频」，
 * 而且看起来像是点击步骤配错了，很难查。所以视频推完必须**等到真能看见**再往下走。
 *
 * 查不动这条命令时返回 ok:false 并把原始输出带回去 —— 不假装看到、也不假装没看到。
 * 返回 { ok, waited(秒), rows, error }
 */
async function mediaVisible(serial, remoteFiles, { timeoutMs = 120000, pollMs = 2000, onTick } = {}) {
  const want = (Array.isArray(remoteFiles) ? remoteFiles : [remoteFiles]).filter(Boolean);
  if (!want.length) return { ok: true, waited: 0, rows: '' };
  // /sdcard 与 /storage/emulated/0 是同一个地方，但 MediaStore 的 _data 记的是后者
  const asMedia = p => String(p).replace(/^\/sdcard\//, '/storage/emulated/0/');
  const t0 = Date.now();
  let rows = '';
  let lastErr = '';
  for (;;) {
    const r = await shell(serial, 'content query --uri content://media/external/video/media --projection _data', { timeout: 20000 });
    rows = String(r.stdout || '');
    lastErr = String(r.stderr || '').trim();
    if (r.ok && want.every(p => rows.includes(asMedia(p)) || rows.includes(p))) {
      return { ok: true, waited: +((Date.now() - t0) / 1000).toFixed(1), rows };
    }
    const waited = Date.now() - t0;
    if (waited >= timeoutMs) {
      return { ok: false, waited: +(waited / 1000).toFixed(1), rows, error: r.ok ? '' : (lastErr || 'content query 执行失败') };
    }
    if (onTick) onTick(Math.round(waited / 1000));
    await new Promise(res => setTimeout(res, pollMs));
  }
}

const DUMP_REMOTE = '/sdcard/bluev_window.xml';
/**
 * 系统动画开关（三个）。得物发布页上有一个跟随它运行的循环动画：
 * 实测 animator_duration_scale=1 时 uiautomator 永远等不到 idle（连续 60 次、约 10 分钟全失败），
 * 同一秒内只把它置 0 就能立刻抓到 —— 所以「关动画重试一次，抓完还原」是可行的兜底。
 */
const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

const sleepMs = ms => new Promise(res => setTimeout(res, Math.max(0, Number(ms) || 0)));

/** 读三个动画开关；读不齐就不动它们（宁可重试失败，也不猜着改回去） */
async function animGet(serial) {
  const r = await shell(serial, ANIM_KEYS.map(k => `settings get global ${k}`).join('; '));
  if (!r.ok) return null;
  const vals = String(r.stdout || '').trim().split(/\s+/);
  if (vals.length !== ANIM_KEYS.length) return null;
  return vals;
}

/** 关闭三个动画开关 */
async function animSet(serial, v) {
  return shell(serial, ANIM_KEYS.map(k => `settings put global ${k} ${v}`).join('; '));
}

/** 还原；原本「没设过」的要用 delete，别把字面量 "null" 写进去 */
async function animRestore(serial, vals) {
  const cmd = ANIM_KEYS
    .map((k, i) => (vals[i] === 'null' ? `settings delete global ${k}` : `settings put global ${k} ${vals[i]}`))
    .join('; ');
  return shell(serial, cmd);
}

/**
 * 抓一次，成功/失败都给出结构化结果 —— **绝不会返回上一次的旧内容**。
 *
 * 为什么要先 rm：uiautomator dump 失败时**不写文件**（实测「页面不 idle」失败后，
 * 目标文件仍是上一次的 47 字节哨兵，一字未动）。而旧实现是共用一个远端路径、
 * 抓完直接 cat，且不检查 dump 的返回 —— 失败时会把**上一个页面**的结构当成本页返回，
 * 调用方于是拿着旧页面的坐标去点新页面。这是「静默点错」，比报错危险得多。
 */
async function dumpOnce(serial) {
  await shell(serial, `rm -f ${DUMP_REMOTE}`);
  const r = await shell(serial, `uiautomator dump ${DUMP_REMOTE}`, { timeout: 30000 });
  const out = String(r.stdout || '').trim();
  if (!/dumped to/i.test(out)) {
    const last = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
    return { ok: false, idle: /idle state/i.test(out), why: last || 'uiautomator dump 没有任何输出' };
  }
  const c = await shell(serial, `cat ${DUMP_REMOTE}`, { timeout: 20000 });
  if (!c.ok || !/</.test(String(c.stdout || ''))) return { ok: false, idle: false, why: 'dump 已写出，但内容读不出来' };
  return { ok: true, xml: String(c.stdout).replace(/^\s*[\s\S]*?<\?xml/, '<?xml').trim() };
}

/**
 * dump 的详细版：拿不到时告诉调用方**为什么**（是页面不 idle，还是设备不在线）。
 * 返回 { ok, xml?, why, idle, animOff }
 */
async function dumpEx(serial, { retries = 1, retryMs = 1200, allowAnimOff = true } = {}) {
  let last = { ok: false, idle: false, why: '未尝试' };
  for (let i = 0; i <= retries; i++) {
    const r = await dumpOnce(serial);
    if (r.ok) return { ok: true, xml: r.xml, why: '', animOff: false };
    last = r;
    if (i < retries) await sleepMs(retryMs);
  }
  if (!last.idle || !allowAnimOff) return Object.assign({ animOff: false }, last);

  const before = await animGet(serial);
  if (!before) {
    return Object.assign({ animOff: false }, last, {
      why: last.why + '（想临时关掉系统动画重试，但读不到设备的动画开关，所以没动它）'
    });
  }
  await animSet(serial, 0);
  try {
    const r = await dumpOnce(serial);
    if (r.ok) return { ok: true, xml: r.xml, why: '', animOff: true };
    return Object.assign({ animOff: true }, r, { why: r.why || last.why });
  } finally {
    // 无论成功还是抛错都还原：不能把用户设备的设置留在改过的状态
    await animRestore(serial, before);
  }
}

let lastDump = null;
/** uiautomator dump → XML；抓不到返回 null（保持老调用方的契约）。要原因用 dumpEx。 */
async function dump(serial, opts) {
  lastDump = await dumpEx(serial, opts);
  return lastDump.ok ? lastDump.xml : null;
}

/** 最近一次 dump 的详情，供日志/界面说明「为什么抓不到」 */
function lastDumpInfo() {
  return lastDump;
}

async function tap(serial, x, y) {
  return shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
}

async function keyevent(serial, code) {
  return shell(serial, `input keyevent ${code}`);
}

/** 中文必须走 ADBKeyboard 广播；纯 ASCII 可以退化到 input text */
async function inputText(serial, text, { adbKeyboard = false } = {}) {
  if (adbKeyboard) {
    const esc = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/ /g, '%s');
    const r = await shell(serial, `am broadcast -a ADB_INPUT_TEXT --es msg "${esc}"`);
    if (r.ok && /result=0/.test(r.stdout)) return r;
  }
  const esc = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/ /g, '%s');
  return shell(serial, `input text "${esc}"`);
}

const IME_COMPONENT_DEFAULT = 'com.android.adbkeyboard/.AdbIME';

/** 设备「已启用」的输入法里有没有 ADBKeyboard（返回组件名，没有则空串） */
async function adbKeyboardIme(serial) {
  const r = await shell(serial, 'ime list -s');
  if (!r.ok) return '';
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => /adbkeyboard/i.test(s)) || '';
}

/** 设备当前默认输入法组件名（用来分辨「装了但没启用」） */
async function defaultIme(serial) {
  const r = await shell(serial, 'settings get secure default_input_method');
  return r.ok ? String(r.stdout || '').trim() : '';
}

/**
 * 一键装上内置的中文输入法。★ **三步缺一不可**：
 *   ① `adb install -r ADBKeyboard.apk`
 *   ② `ime enable <组件>` —— 只装了不启用，`ADB_INPUT_TEXT` 广播没人接
 *   ③ `ime set <组件>`    —— 不设成当前输入法，中文仍然打不进输入框
 *
 * ★ 副作用必须说清：设成默认输入法后，**在模拟器里手动点输入框不会弹出键盘**
 *   （ADBKeyboard 就是个"给脚本用的"输入法，这是它的正常表现）。
 *   所以这一步**只由用户点按钮触发，绝不自动做**。
 */
async function installKeyboard(serial) {
  const apk = bundledApk;
  if (!apk) return { ok: false, step: 'apk', error: '这个安装包里没有内置中文输入法（ADBKeyboard.apk）' };
  if (!fs.existsSync(apk)) return { ok: false, step: 'apk', error: `内置的 ${path.basename(apk)} 找不到：${apk}` };

  const inst = await execAdb(withS(serial, ['install', '-r', apk]), { timeout: 180000 });
  const instText = String(inst.stdout || '') + String(inst.stderr || '');
  if (!inst.ok || !/Success/i.test(instText)) {
    return { ok: false, step: 'install', error: instText.trim() || `adb install 退出码 ${inst.code}`, raw: instText.trim() };
  }

  const comp = (await adbKeyboardIme(serial)) || IME_COMPONENT_DEFAULT;
  const en = await shell(serial, `ime enable ${comp}`);
  const st = await shell(serial, `ime set ${comp}`);
  const after = await defaultIme(serial);
  const nowDefault = /adbkeyboard/i.test(after);
  return {
    ok: nowDefault, step: nowDefault ? 'done' : 'ime', apk, component: comp, defaultIme: after,
    error: nowDefault ? '' : `输入法装好了，但没能设成默认（现在默认的是 ${after || '未知'}）—— 原始输出：`
      + (String(en.stdout || '') + String(st.stdout || '') + String(st.stderr || '')).trim(),
    raw: (instText + '\n' + en.stdout + '\n' + st.stdout).trim()
  };
}

async function packages(serial, filter) {
  const r = await shell(serial, 'pm list packages');
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean)
    .filter(p => !filter || p.includes(filter));
}

/**
 * 设备检查：把「能不能真的发」拆成可验证的几条。
 *
 * ★ 返回体里同时带两套说法，别混用：
 *   · `notes` —— 给**排查问题的人**看的技术原文（命令输出、原始报错）
 *   · `fix`   —— 给**普通用户**看的：{ level:'bad'|'warn', title, how }
 *     title = 「现在卡在哪」，how = 「下一步点哪里」。界面上只显示这一套，
 *     notes 收进折叠区。以前界面上直接摆 7 行术语，用户看到「不满足」也不知道该干什么。
 */
async function probe(serial) {
  const act = active();
  const apkPath = bundledApk;
  const out = {
    serial, ts: Date.now(),
    adbPath: act.path, adbSource: act.source, adbConfigured: adbBin,
    adbBundled: bundledAdbPath() || null, adbConfiguredMissing: act.configuredMissing,
    imeApkBundled: apkPath || null, imeApkExists: !!(apkPath && fs.existsSync(apkPath)),
    adb: null, device: null, resolution: null,
    appPackage: null, adbKeyboard: false, adbKeyboardIme: '', adbKeyboardActive: false,
    tools: {}, notes: [], fix: []
  };
  const say = (level, title, how, act2) => out.fix.push(act2 ? { level, title, how, act: act2 } : { level, title, how });

  // 只有「真的退了回去」才说"已自动改用X"。三种来源全不可用时不报这条 ——
  // 那种情况下面那条「没找到 adb」才是正主，这里再说一遍等于让用户以为有备胎。
  if (act.configuredMissing && act.source !== 'configured-missing') {
    const toWhat = act.source === 'bundled' ? '程序内置的 adb' : '系统 PATH 里的 adb';
    out.notes.push(`手填的 adb 路径「${adbBin}」不存在，已自动退回${act.source === 'bundled' ? '内置' : 'PATH'}：${act.path}`);
    say('warn', `你填的 adb 路径不存在，已自动改用${toWhat}`,
      `在「设备管理」那一行填的是「${adbBin}」，这个文件找不到。`
      + `现在用的是${toWhat}（不影响使用）。`
      + '建议把那一格**清空**（留空=自动：优先内置、再退系统），或者把路径改对。');
  }

  out.adb = await version();
  if (!out.adb) {
    // 现在正常情况下这里是**不会**出现的：包里有内置 adb。真报出来，只可能是安装包不完整、
    // 或者用户手填了一个不存在的路径又没清掉。
    out.notes.push(`没检测到 adb（解析结果：path=${act.path} source=${act.source}`
      + (act.configuredMissing ? ` · 手填的「${adbBin}」不存在` : '') + '）');
    const hint = '★ 也可以临时在下面「设备管理」最后一行「adb 路径」里，手填模拟器自带的那个'
      + '（MuMu 默认在 D:\\MUMU\\MuMuPlayer\\nx_main\\adb.exe），填完立刻生效，再点一次上面的「检查能不能发布」。';
    say('bad', '没找到 adb —— 它是电脑跟模拟器之间的“对讲机”',
      (act.configuredMissing ? `你在「adb 路径」里填的「${adbBin}」不存在 —— 先把它清空（留空=自动）。` : '')
      + (bundledAdbPath()
        ? `程序内置的那份也没找到（应该在 ${bundledAdbPath()}）—— 多半是安装包不完整，重新装一次本工具最省事。`
        : '这台机器上没有内置的 adb。')
      + hint);
    return out;
  }

  out.device = await online(serial);
  if (!out.device) {
    const list = await devices();
    // 这一条是「整张表都报错」最常见的原因：serial 填错。
    // MuMu 的「网络桥接地址」（127.0.0.1:16385 这类）和 adb 侧真正认到的 serial
    // （emulator-5554）经常不是同一个 —— 填错就每一项都失败，看起来像设备坏了，其实只是名字不对。
    const usable = list.filter(d => d.state === 'device');
    out.notes.push(list.length
      ? `设备 ${serial} 不在线。adb 现在认到的是：${list.map(d => `${d.serial}(${d.state})`).join('、')}`
        + (usable.length ? ` —— 上面「设备」那一栏请选「${usable[0].serial}」。模拟器重启后端口/名字可能变，别照抄上一次的。` : '')
      : 'adb 在线但一个设备都没有：先把模拟器启动起来，并在模拟器设置里打开 ADB 调试');
    say('bad', serial ? `你选的设备「${serial}」没连上` : '还没选设备',
      usable.length
        ? `模拟器现在能连上的是「${usable[0].serial}」：在下面的设备列表里点它的「选用」；'
          + '列表里没有就先点「检测在线」再看。★ 模拟器每次重启，这个名字可能变，别照抄上一次的。`
        : '三步：① 先把模拟器启动起来；② 确认模拟器设置里打开了「ADB 调试」；'
          + '③ 回来点「检测在线」，从列表里点一台的「选用」。');
    return out;
  }

  const sz = await shell(serial, 'wm size');
  if (sz.ok) out.resolution = (sz.stdout.match(/(\d+x\d+)/) || [])[1] || null;
  out.tools.input = (await shell(serial, 'input')).ok;
  out.tools.screencap = (await screencap(serial)).length > 0;
  out.tools.uiautomator = !!(await dump(serial));
  if (out.tools.uiautomator) {
    const d = lastDumpInfo();
    if (d && d.animOff) out.notes.push('自检时页面一直不 idle，已临时关掉系统动画才抓到结构（已还原）');
  }

  const pkgs = await packages(serial);
  out.appPackage = pkgs.find(p => /shizhuang|duapp|poizon|dewu/i.test(p)) || null;
  out.adbKeyboard = pkgs.some(p => p.includes('com.android.adbkeyboard'));
  if (out.adbKeyboard) {
    // 装了 ≠ 能用：必须「已启用」且「是当前输入法」，否则 ADB_INPUT_TEXT 广播打不进字
    out.adbKeyboardIme = await adbKeyboardIme(serial);
    out.adbKeyboardActive = /adbkeyboard/i.test(await defaultIme(serial));
  }

  if (!out.tools.uiautomator) {
    const d = lastDumpInfo() || {};
    out.notes.push(d.idle
      ? `uiautomator dump 失败：当前页面一直不 idle（得物发布页会这样），拿不到界面结构 —— 原始输出「${d.why || ''}」`
      : `uiautomator dump 失败：拿不到界面结构，无法定位发布按钮${d.why ? ` —— 原始输出「${d.why}」` : ''}`);
    say('bad', '读不到 App 的界面（发布时会找不到按钮）',
      '① 先把得物退回到首页，再点一次「检查能不能发布」；'
      + '② 还不行就把模拟器里其他占着画面的应用关掉。得物自己的发布页本来就抓不动，这是已知情况。');
  }
  if (!out.tools.screencap) {
    out.notes.push('screencap 失败：失败时截不了图');
    say('warn', '能发，但发布失败时截不了图（以后排查会麻烦些）',
      '一般是模拟器权限问题：重启模拟器，再点一次「检查能不能发布」。');
  }
  if (!out.adbKeyboard || !out.adbKeyboardActive) {
    const canInstall = out.imeApkExists;
    out.notes.push(!out.adbKeyboard
      ? '未装 ADBKeyboard：中文标题/正文输入会失败（ASCII 不受影响）'
      : `ADBKeyboard 已装但没设成当前输入法（ime list 里是「${out.adbKeyboardIme || '没找到'}」）—— 中文照样打不进去`);
    say('warn',
      out.adbKeyboard ? '能发，但中文打不进去（输入法装了、没启用）' : '能发，但中文标题和正文会打不进去',
      (!out.adbKeyboard ? '中文标题和正文会打不进去，只发英文和数字不受影响。' : '')
      + (canInstall
        ? '点下面的按钮一键搞定（装好 + 启用 + 设成当前输入法），完事再点一次「检查能不能发布」。'
        : '这台机器的安装包里没有内置输入法，需要自己装一个 ADBKeyboard（包名 com.android.adbkeyboard）。'),
      canInstall ? { act: 'pub:installIme', label: '一键装上中文输入法' } : null);
  }
  if (!out.appPackage) {
    out.notes.push('设备里没找到得物 App 包名，请确认已安装登录');
    say('bad', '模拟器里没找到「得物」',
      '确认这台模拟器装的是得物并且已经登录，再点一次「检查能不能发布」。');
  }
  return out;
}

module.exports = {
  execAdb, version, devices, online, shell, push, mediaScan, mediaVisible, screencap,
  dump, dumpEx, lastDumpInfo, tap, keyevent, inputText, packages, probe,
  setAdbPath, getAdbPath, setBundledAdbDir, getBundledAdbDir, bundledAdbPath,
  setBundledApkPath, getBundledApkPath, resolveAdbChoice, getActiveAdb, bundledStatus,
  installKeyboard, adbKeyboardIme, defaultIme
};
