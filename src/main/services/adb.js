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

/** uiautomator dump → XML */
async function dump(serial) {
  const remote = '/sdcard/bluev_window.xml';
  await shell(serial, `uiautomator dump ${remote}`, { timeout: 30000 });
  const r = await shell(serial, `cat ${remote}`, { timeout: 20000 });
  if (!r.ok || !/</.test(r.stdout)) return null;
  return r.stdout.replace(/^\s*[\s\S]*?<\?xml/, '<?xml').trim();
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

  const pkgs = await packages(serial);
  out.appPackage = pkgs.find(p => /shizhuang|duapp|poizon|dewu/i.test(p)) || null;
  out.adbKeyboard = pkgs.some(p => p.includes('com.android.adbkeyboard'));

  if (!out.tools.uiautomator) out.notes.push('uiautomator dump 失败：拿不到界面结构，无法定位发布按钮');
  if (!out.tools.screencap) out.notes.push('screencap 失败：失败时截不了图');
  if (!out.adbKeyboard) out.notes.push('未装 ADBKeyboard：中文标题/正文输入会失败（ASCII 不受影响）');
  if (!out.appPackage) out.notes.push('设备里没找到得物 App 包名，请确认已安装登录');
  return out;
}

module.exports = {
  execAdb, version, devices, online, shell, push, mediaScan, screencap,
  dump, tap, keyevent, inputText, packages, probe
};
