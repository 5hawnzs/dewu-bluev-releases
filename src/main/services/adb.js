'use strict';
/**
 * ADB 驱动层：只做「确实能做到」的真实动作，做不到就明确报错，绝不假装成功。
 *   - 设备在线 / 分辨率 / 包是否安装 / 工具可用性：真实探测
 *   - 推图 + 触发媒体扫描：真实命令
 *   - 界面结构抓取（uiautomator dump）+ 点击 / 输入：真实命令
 *   - 中文输入依赖 ADBKeyboard（com.android.adbkeyboard），探测里会明确告诉你装没装
 */
const { execFile } = require('child_process');

function execAdb(args, { timeout = 20000, binary = false } = {}) {
  return new Promise(resolve => {
    execFile('adb', args, {
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

/** 推完图必须触发媒体扫描，否则得物相册里看不到 */
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

async function packages(serial, filter) {
  const r = await shell(serial, 'pm list packages');
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean)
    .filter(p => !filter || p.includes(filter));
}

/** 驱动自检：把「能不能真的发」拆成可验证的几条 */
async function probe(serial) {
  const out = { serial, adb: null, device: null, resolution: null, appPackage: null, adbKeyboard: false, tools: {}, notes: [] };
  out.adb = await version();
  if (!out.adb) { out.notes.push('没检测到 adb —— 装 platform-tools 并加进 PATH，或在设置里填 adb 完整路径'); return out; }

  out.device = await online(serial);
  if (!out.device) {
    const list = await devices();
    out.notes.push(list.length
      ? `设备 ${serial} 不在线，当前列表：${list.map(d => d.serial + '(' + d.state + ')').join('、')}`
      : 'adb 在线但没有任何设备，先在模拟器里打开 ADB 调试');
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

  if (!out.tools.uiautomator) {
    const d = lastDumpInfo() || {};
    out.notes.push(d.idle
      ? `uiautomator dump 失败：当前页面一直不 idle（得物发布页会这样），拿不到界面结构 —— 原始输出「${d.why || ''}」`
      : `uiautomator dump 失败：拿不到界面结构，无法定位发布按钮${d.why ? ` —— 原始输出「${d.why}」` : ''}`);
  }
  if (!out.tools.screencap) out.notes.push('screencap 失败：失败时截不了图');
  if (!out.adbKeyboard) out.notes.push('未装 ADBKeyboard：中文标题/正文输入会失败（ASCII 不受影响）');
  if (!out.appPackage) out.notes.push('设备里没找到得物 App 包名，请确认已安装登录');
  return out;
}

module.exports = {
  execAdb, version, devices, online, shell, push, mediaScan, mediaVisible, screencap,
  dump, dumpEx, lastDumpInfo, tap, keyevent, inputText, packages, probe
};
