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
 * 设备现在**真的能用 ADBKeyboard 打中文**吗。
 *
 * ★ 判据只有一个：**它是不是设备当前的输入法**（`settings get secure default_input_method`）。
 *   注意三种状态别混：① 没装 ② 装了但没 `ime enable` ③ 启用了但不是当前输入法 ——
 *   ②③ 两种下 `ADB_INPUT_TEXT` 广播都**没有接收者**（接收器是跟着 AdbIME 服务动态注册的，
 *   实测 `cmd package query-receivers -a ADB_INPUT_TEXT` 回 `No receivers found`）。
 *
 * ★ 故意**不做缓存**：一次发布里输入步骤也就几条，多出来的是一次 `settings get`（几十毫秒），
 *   而缓存会带来「用户刚点了装输入法、前几秒还被判为没启用」这种假失败 —— 不值得。
 *   读不到就重试一次；仍读不到按「不可用」处理（宁可不发，也不发一条没标题的帖子）。
 */
async function keyboardReady(serial) {
  let current = await defaultIme(serial);
  if (!current) current = await defaultIme(serial);
  return { active: /adbkeyboard/i.test(current), current };
}

/**
 * 往当前焦点输入框里打字。
 *
 * ★★ 这一条踩过两个坑，都是实测出来的（2026-10-02，MuMu 12 / Android 12，
 *    拿 Chrome 地址栏当靶子，截图取证）：
 *
 *   ① **`input text` 注不进中文。** `input text "中文标题"` 打完之后地址栏**纹丝不动**
 *      （同一流程里 `input text "abc"` 正常进框），而这条命令**退出码是 0、标准输出为空** ——
 *      光看返回值发现不了。⇒ 中文只有 `ADB_INPUT_TEXT` 广播这一条路，没有"退而求其次"。
 *
 *   ② **广播的返回码也不能当成功依据。** `am broadcast -a ADB_INPUT_TEXT` 在「有人接」
 *      和「没人接」两种情况下返回**一模一样**（都是 `Broadcast completed: result=0`）。
 *      ⇒ 旧实现拿 `result=0` 当"打进去了"，等于给「中文压根没进去」盖了个合格的章；
 *        更早的实现则把这条判断整个交给了配置项 `publish.adbKeyboard`，而这个键
 *        **全仓没有任何地方会写它**（界面没开关、默认配置里也没有）⇒ 恒为假
 *        ⇒ 中文永远走 `input text` ⇒ 标题/正文永远是空的，流程却一路报「发布成功」。
 *
 * 所以这里改成：**先问设备真实状态，再决定怎么发**；中文打不进去就**明确失败**，
 * 让上层如实报错，绝不静默退化去 `input text` 假装成功。
 */
async function inputText(serial, text) {
  const s = String(text == null ? '' : text);
  const esc = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/ /g, '%s');
  const asciiOnly = /^[\t\n\r\x20-\x7E]*$/.test(s);

  // 纯 ASCII：`input text` 实测可用，而且不依赖设备上的输入法状态，优先用它
  if (asciiOnly) return shell(serial, `input text "${esc}"`);

  const kbd = await keyboardReady(serial);
  if (!kbd.active) {
    const short = s.length > 12 ? s.slice(0, 12) + '…' : s;
    return {
      ok: false, code: 'ime-not-active', stdout: '',
      stderr: `要输入的内容「${short}」里有中文（或其它非 ASCII 字符），这类字符只有 ADBKeyboard 能打进去，`
        + `而设备上它现在不是当前输入法（当前是 ${kbd.current || '未知'}）—— 广播没有人接收，一个字也进不去。`
        + '（不要去改「用 input text 硬打」：实测它对中文无效，却照样返回成功，会把没标题没正文的帖子发出去。）'
        + '处理：到「模拟器发布」页点一次「一键装上中文输入法」，再重新发布。'
    };
  }
  return shell(serial, `am broadcast -a ADB_INPUT_TEXT --es msg "${esc}"`);
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
 * 当前抢焦点的窗口 / Activity 原文。
 *
 * 用途只有一个：dump 抓不到时，告诉用户**当时停在哪一屏**。
 * 实测（2026-10-02）：同一个得物发布页（TotalPublishProcessActivity），卡住时连续 4 次
 * `could not get idle state`（连临时关掉系统动画都救不了）；把 App 切到后台再回前台之后，
 * 同一页同一窗口 id **8/8 全部抓到**。所以「抓不到」是**跟当前这一屏的状态有关**的，
 * 不写清停在哪一屏，用户只会以为工具坏了。
 */
async function currentFocus(serial) {
  const r = await shell(serial, 'dumpsys window | grep mCurrentFocus');
  const s = String(r.stdout || '').trim();
  const m = s.match(/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/);
  return m ? m[1] : '';
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
    adbKeyboardCurrent: '', focus: null,
    tools: {}, notes: [], fix: []
  };
  const say = (level, title, how, act2) => out.fix.push(act2 ? { level, title, how, act: act2 } : { level, title, how });

  // 只有「真的退了回去」才说"已自动改用X"。三种来源全不可用时不报这条 ——
  // 那种情况下面那条「没找到 adb」才是正主，这里再说一遍等于让用户以为有备胎。
  if (act.configuredMissing && act.source !== 'configured-missing') {
    const toWhat = act.source === 'bundled' ? '程序内置的 adb' : '系统 PATH 里的 adb';
    out.notes.push(`手填的 adb 路径「${adbBin}」不存在，已自动退回${act.source === 'bundled' ? '内置' : 'PATH'}：${act.path}`);
    say('warn', `你填的 adb 路径不存在，已自动改用${toWhat}`,
      `在「设置 → 高级设置」的「adb 路径」里填的是「${adbBin}」，这个文件找不到。`
      + `现在用的是${toWhat}（不影响使用）。`
      + '建议把那一格清空（留空=自动：优先内置、再退系统），或者把路径改对。');
  }

  out.adb = await version();
  if (!out.adb) {
    // 现在正常情况下这里是**不会**出现的：包里有内置 adb。真报出来，只可能是安装包不完整、
    // 或者用户手填了一个不存在的路径又没清掉。
    out.notes.push(`没检测到 adb（解析结果：path=${act.path} source=${act.source}`
      + (act.configuredMissing ? ` · 手填的「${adbBin}」不存在` : '') + '）');
    const hint = '★ 也可以临时在「设置 → 高级设置」的「adb 路径」里，指定模拟器自带的那个'
      + '（MuMu 默认在 D:\\MUMU\\MuMuPlayer\\nx_main\\adb.exe），填完立刻生效，再点一次上面的「检查能不能发布」。';
    say('bad', '没找到 adb —— 它是电脑跟模拟器之间的“对讲机”',
      (act.configuredMissing ? `你在「高级设置 → adb 路径」里填的「${adbBin}」不存在 —— 先把它清空（留空=自动）。` : '')
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
        ? `模拟器现在能连上的是「${usable[0].serial}」：点「设备管理」里的「扫描设备」，`
          + '下面会把它列出来，再点它那一行的「加入并使用」。'
          + '★ 模拟器每次重启，这个名字可能变，别照抄上一次的。'
        : '三步：① 先把模拟器启动起来；② 确认模拟器设置里打开了「ADB 调试」；'
          + '③ 回来点「扫描设备」，从列出来的设备里点「加入并使用」。');
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
    const kbd = await keyboardReady(serial);
    out.adbKeyboardActive = kbd.active;
    out.adbKeyboardCurrent = kbd.current;
  }

  if (!out.tools.uiautomator) {
    const d = lastDumpInfo() || {};
    const on = await currentFocus(serial);
    out.focus = on;
    out.notes.push((d.idle
      ? `uiautomator dump 失败：当前页面一直不 idle（得物发布页会这样），拿不到界面结构 —— 原始输出「${d.why || ''}」`
      : `uiautomator dump 失败：拿不到界面结构，无法定位发布按钮${d.why ? ` —— 原始输出「${d.why}」` : ''}`)
      + (on ? ` · 当时停在这一屏：${on}` : ''));
    // ★ 这一条**只是"此刻这一屏抓不动"，不代表 adb / uiautomator 坏了**（实测：同一台设备
    //   切到桌面就能抓到，几秒后回到同一页也能抓到）。所以文案里必须把这两件事分开说，
    //   否则用户会以为要重装 / 换工具。
    say('bad', '现在这一屏抓不到界面（发布时会找不到按钮）',
      (on ? `刚才是停在「${on.split('/').pop()}」这一屏上。` : '')
      + '① 把得物退到首页、或切到桌面再点一次「检查能不能发布」（实测这一步就能恢复）；'
      + '② 还不行就把模拟器里其他占着画面的应用关掉、确认没锁屏。'
      + '得物自己的发布页本来就偶发抓不动，这是已知情况，不是 adb 坏了。');
  } else {
    out.focus = await currentFocus(serial);
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
      : `ADBKeyboard 已装但没设成当前输入法（ime list 里是「${out.adbKeyboardIme || '没找到'}」，`
        + `当前输入法是「${out.adbKeyboardCurrent || '未知'}」）—— 广播没有接收者，中文一个字也进不去`);
    // ★ 为什么是 bad 而不是 warn：得物的标题/正文/话题几乎全是中文，而**中文只有 ADBKeyboard
    //   这一条通道**（实测 `input text` 对中文无效，却照样返回 0）。没有它，发布会直接在这几步
    //   失败（改之前更糟：会静默发出一条没标题没正文的帖子）。所以这不是"影响体验"，是"发不出去"。
    say('bad',
      out.adbKeyboard ? '中文发不出去（输入法装了，但不是当前输入法）' : '中文标题和正文发不出去（没装中文输入法）',
      (!out.adbKeyboard ? '得物的标题、正文、话题都是中文，中文只有 ADBKeyboard 这一条输入通道，'
        + '`input text` 是打不进的（实测）。只发英文和数字不受影响。' : '')
      + (canInstall
        ? '点下面的按钮一键搞定（装进模拟器 + 启用 + 设成当前输入法），完事再点一次「检查能不能发布」。'
          + '★ 注意：「程序内置了输入法」= 安装包自带这个 apk，不等于已经装进模拟器并启用 —— 这一步必须做一次。'
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
  installKeyboard, adbKeyboardIme, defaultIme, keyboardReady, currentFocus
};
