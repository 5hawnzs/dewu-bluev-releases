'use strict';
/**
 * 得物 App 的安卓安装包 —— **随包内置**，用来兜「模拟器自带的应用商店里搜不到得物」这种情况。
 *
 * ★★ 为什么内置而不是让用户自己去下：
 *   ① 模拟器商店搜不到、网上搜到的安装包渠道五花八门（捆广告 / 缺 ABI / 签名不对），
 *      用户装不上还怪工具；② 内置这一份是**核过**的：字节数与 md5 都写死在下面，
 *      装之前先比大小，对不上直接拒绝装（见 install）。
 *
 * ★★ 三条必须守住的行为（都是「别把用户的东西弄丢」）：
 *   1. **已经装过得物就不动它**。得物里是登录状态 + 本地草稿，重复安装纯属无谓风险。
 *      ⇒ 先读设备（pm list / dumpsys），已装就只回版本号，**一条 install 都不发**；
 *      真要覆盖，必须是用户显式点「覆盖重装」（force=true）。
 *   2. **装完必须回读确认**（`pm list packages` 里真的出现了才算成）——
 *      `adb install` 说 Success 不等于设备上真装上了（§BO/§BC3 同一条原则：不许假成功）。
 *   3. **读不到设备 ≠ 没装**。`pm list packages` 本身失败（设备掉线/adb 换 server）时
 *      返回 installed=null，绝不把它当成「没装」然后一路装下去（「未知 ≠ 0」）。
 *
 * ★ 事实（从这两份**包本身**读出来的，不是按文件名猜的 —— 见 vendor/README.md 那一节）：
 *   包名 com.shizhuang.duapp · versionName 6.0.5 · versionCode 1140 · compileSdk 35
 *   ABI 只有 arm64-v8a / armeabi-v7a（**没有 x86_64**）⇒ MuMu 12 要靠它自带的 ARM 兼容层跑，
 *   安装本身不受影响（adb install 不看 ABI），但装完打不开就是这条原因，不是包坏了。
 */
const fs = require('fs');
const path = require('path');
const adb = require('./adb');

/** 内置文件名（改了名字 vendor/README.md 与 uicheck 的 md5 台账要一起改） */
const FILE = 'dewu_6.0.5.apk';
/** 字节数：装之前拿它当「这一份是不是完整」的判据（比 md5 便宜，133 MB 每次算哈希太亏） */
const BYTES = 133315131;
/** md5：只在需要"这份到底是不是核过的那一份"时算（目前用于 vendor 台账与自检） */
const MD5 = '50092bccb263498a16e4fbb57762ae5f';
const PKG = 'com.shizhuang.duapp';
const VERSION = '6.0.5';
const VERSION_CODE = 1140;

/** 设备上「得物」的包名判据 —— 与 adb.probe 里那条同口径（有渠道包叫 poizon / global 包） */
const PKG_RE = /^com\.shizhuang\.(duapp|poizon)/i;

let bundledDir = '';

/** index.js 在启动时注入：打包后 `resources/dewu`，开发时 `<仓库>/vendor/dewu` */
function setBundledDir(d) { bundledDir = d || ''; }
function getBundledDir() { return bundledDir; }
function bundledPath() { return bundledDir ? path.join(bundledDir, FILE) : ''; }

/**
 * 内置包在不在、完不完整。设置页「外部依赖」那一行照它显示，一个字都不许猜。
 * ★ 刻意**不算 md5**：这个函数会在每次 app:info（界面刷新）里被调用，133 MB 算哈希
 *   要 0.3~1 秒，界面会肉眼可见地卡一下。大小对不上就已经能判出「这份不完整」了。
 */
function status() {
  const p = bundledPath();
  let bytes = 0;
  let exists = false;
  if (p) {
    try { exists = fs.existsSync(p); if (exists) bytes = fs.statSync(p).size; } catch (e) { exists = false; bytes = 0; }
  }
  return {
    file: FILE, path: p, exists, bytes, expectBytes: BYTES, md5: MD5,
    sizeOk: exists && bytes === BYTES,
    version: VERSION, versionCode: VERSION_CODE, pkg: PKG
  };
}

/** 只在需要出处比对时用（会真的读一遍 133 MB）—— 目前没有调用点，留着就等于死代码，故不导出 */
/**
 * 把内置的那一份**另存为**到用户选的位置（界面上「下载到本机」）。
 * ★ 走本地复制而不是从网上下：包本来就随包内置了，再走网络只会多一个失败面，
 *   而且「下载」这个词在这里的真实含义就是「把安装包弄到你手边」。
 */
function saveAs(target) {
  const st = status();
  if (!st.exists) return { ok: false, error: `安装包里没有内置得物安装包（应该在 ${st.path || 'resources/dewu'}）` };
  if (!st.sizeOk) {
    return { ok: false, error: `内置的 ${FILE} 大小不对（${st.bytes} 字节，应该是 ${BYTES}）—— 这份安装包不完整，重新装一次本工具再试` };
  }
  if (!target) return { ok: false, error: '没给保存路径' };
  try {
    fs.copyFileSync(st.path, target);
  } catch (e) {
    return { ok: false, error: `写不进这个位置：${(e && e.message) || e}` };
  }
  let bytes = 0;
  try { bytes = fs.statSync(target).size; } catch (e) { bytes = 0; }
  if (bytes !== st.bytes) {
    // 复制完必须回读大小 —— 磁盘满 / 被杀软拦下都会留下一个半截文件，那时说"存好了"就是骗人
    return { ok: false, error: `存出来的文件只有 ${bytes} 字节（应该 ${st.bytes}），没存完整，换个位置再试`, path: target };
  }
  return { ok: true, path: target, bytes };
}

/**
 * 读设备上得物装没装、装的哪个版本。
 * @returns {{ok:boolean, installed:(boolean|null), version:string, pkgs:string[], error:string}}
 *   **installed=null 表示"读不出来"** —— 与 false（确认没装）是两件事，调用方必须分开处理。
 */
async function deviceState(serial) {
  if (!serial) return { ok: false, installed: null, version: '', pkgs: [], error: '还没选设备' };
  const r = await adb.shell(serial, 'pm list packages');
  if (!r.ok) {
    return {
      ok: false, installed: null, version: '', pkgs: [],
      error: (String(r.stderr || '') + String(r.stdout || '')).trim() || `pm list packages 退出码 ${r.code}`
    };
  }
  const pkgs = String(r.stdout || '').split(/\r?\n/)
    .map(l => l.replace(/^package:/, '').trim()).filter(Boolean).filter(p => PKG_RE.test(p));
  if (!pkgs.length) return { ok: true, installed: false, version: '', pkgs: [] };
  // 版本号让**设备端先筛**（真机这份 dumpsys 有几百 KB，整份拉回来又慢又占内存）
  const v = await adb.shell(serial, `dumpsys package ${pkgs[0]} | grep -m1 versionName`);
  const version = ((String(v.stdout || '').match(/versionName=(\S+)/) || [])[1] || '');
  return { ok: true, installed: true, version, pkgs };
}

/**
 * 把内置的得物安装包装进设备。
 * @param {string} serial
 * @param {{force?:boolean}} [opts] force=true 才会在"已经装了"的情况下覆盖重装（`-r -d`）
 */
async function install(serial, opts = {}) {
  const st = status();
  if (!st.exists) {
    return { ok: false, step: 'apk', error: `这个安装包里没有内置得物安装包（应该在 ${st.path || 'resources/dewu'}）` };
  }
  if (!st.sizeOk) {
    return {
      ok: false, step: 'apk',
      error: `内置的 ${FILE} 大小不对（${st.bytes} 字节，应该是 ${BYTES}）—— 安装包不完整，重新装一次本工具最省事`
    };
  }
  if (!serial) return { ok: false, step: 'device', error: '还没选设备 —— 先在「模拟器发布」页点「扫描设备」，再把那一台「加入并使用」' };

  const on = await adb.online(serial);
  if (!on) {
    const list = await adb.devices();
    return {
      ok: false, step: 'device',
      error: `设备 ${serial} 不在线` + (list.length ? `（adb 现在认到的是：${list.map(d => `${d.serial}(${d.state})`).join('、')}）` : '（adb 一台设备都没认到）')
    };
  }

  const before = await deviceState(serial);
  if (!before.ok) {
    return { ok: false, step: 'probe', error: `读不出设备上装了什么（不是"没装"）：${before.error}`, raw: before.error };
  }

  if (before.installed && !opts.force) {
    // ★ 关键分支：已经装了 ⇒ **哪条 install 都不发**，只回报看到的版本
    return {
      ok: true, step: 'already', already: true, replaced: false,
      installedVersion: before.version, apkVersion: VERSION, pkg: before.pkgs[0], serial
    };
  }

  const args = ['-s', serial, 'install', '-r'];
  // `-d` = 允许版本号降级。只在用户显式点「覆盖重装」时才加上：
  // 设备上是更新版的得物时，不加它会报 INSTALL_FAILED_VERSION_DOWNGRADE。
  if (opts.force) args.push('-d');
  args.push(st.path);

  const inst = await adb.execAdb(args, { timeout: 300000 });
  const text = (String(inst.stdout || '') + String(inst.stderr || '')).trim();
  if (!inst.ok || !/Success/i.test(text)) {
    return {
      ok: false, step: 'install', raw: text,
      error: text || `adb install 退出码 ${inst.code}`,
      hint: /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(text)
        ? '设备上那一份得物和这个包**签名不一样**（多半是别的渠道包）—— 只能先在模拟器里把它卸载再装，卸载会清掉登录状态和本地草稿，所以这一步交给人工决定，工具不自动做。'
        : ''
    };
  }

  // 回读：adb 说 Success 也要去设备上再看一眼
  const after = await deviceState(serial);
  if (!after.ok || !after.installed) {
    return {
      ok: false, step: 'verify', raw: text,
      error: 'adb install 回的是 Success，但回读 `pm list packages` 里没有得物 —— 不假装装上了'
        + (after.error ? `（回读本身也失败：${after.error}）` : '')
    };
  }

  return {
    ok: true, step: 'done', already: false, replaced: !!before.installed,
    installedVersion: after.version, apkVersion: VERSION, pkg: after.pkgs[0], serial, raw: text
  };
}

module.exports = {
  FILE, BYTES, MD5, PKG, VERSION, VERSION_CODE,
  setBundledDir, getBundledDir, bundledPath,
  status, saveAs, deviceState, install
};
