'use strict';
// 固定 GitHub 分发源。客户端不包含上传凭据；下载完成也不自动安装。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const REPO = 'wfjdyhmtr2-glitch/dewu-bluev-releases';
const BUILD = 2026101306;
const FEED = `https://raw.githubusercontent.com/${REPO}/main/latest.json`;
let manifest, file, pending;
let state = { status: 'idle', current: app.getVersion(), build: BUILD, percent: 0, message: '尚未检查更新' };
function changed(patch) {
  state = { ...state, ...patch };
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:changed', state);
  return { ok: true, ...state };
}
function validate(m) {
  const u = new URL(m.url);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || !u.pathname.startsWith('/' + REPO + '/releases/download/') || !u.pathname.endsWith('.exe') || u.username || u.password || u.search || u.hash) throw Error('更新下载地址不符合分发源要求');
  if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.build) || !Number.isSafeInteger(m.bytes) || m.bytes < 1000000 || m.bytes > 1024 ** 3) throw Error('更新清单格式错误');
  return m;
}
async function check() {
  if (pending || ['checking', 'verifying', 'installing'].includes(state.status)) return { ok: true, ...state };
  changed({ status: 'checking', message: '正在检查 GitHub 更新…' });
  try {
    const r = await fetch(FEED + '?t=' + Date.now(), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!r.ok) throw Error('更新服务器返回 ' + r.status);
    const text = await r.text();
    if (text.length > 16384) throw Error('更新清单过大');
    manifest = validate(JSON.parse(text));
    return changed({ status: manifest.build > BUILD ? 'available' : 'current', latest: manifest.version, latestBuild: manifest.build, message: manifest.build > BUILD ? '有新版本可下载' : '当前已是最新构建', checkedAt: Date.now() });
  } catch (e) { return changed({ status: 'error', message: '暂时无法检查更新：' + e.message }); }
}
async function download() {
  if (pending) return pending;
  if (!manifest || manifest.build <= BUILD) return { ok: false, error: '请先检查更新' };
  pending = (async () => {
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `bluev-${manifest.build}.exe`);
    const partial = file + '.part';
    changed({ status: 'downloading', percent: 0, message: '正在下载安装包…' });
    let fd;
    try {
      const r = await fetch(manifest.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!r.ok || !r.body) throw Error('下载返回 ' + r.status);
      fd = fs.openSync(partial, 'w');
      const hash = crypto.createHash('sha256');
      let bytes = 0, last = 0;
      for await (const chunk of r.body) {
        bytes += chunk.length;
        if (bytes > manifest.bytes) throw Error('安装包大小不符合清单');
        fs.writeSync(fd, chunk); hash.update(chunk);
        if (Date.now() - last > 500) { last = Date.now(); changed({ percent: Math.floor(bytes / manifest.bytes * 100) }); }
      }
      fs.closeSync(fd); fd = undefined;
      if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) throw Error('安装包校验失败，请重新下载');
      fs.renameSync(partial, file);
      return changed({ status: 'downloaded', percent: 100, message: '下载并校验完成，点击重启并更新即可自动完成安装' });
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(partial); } catch {}
      return changed({ status: 'error', message: '下载失败：' + e.message });
    }
  })();
  try { return await pending; } finally { pending = null; }
}
async function install() {
  if (require('./jobs').list().length) return { ok: false, error: '请等待所有任务完成后再安装更新' };
  if (state.status !== 'downloaded' || !file || !fs.existsSync(file)) return { ok: false, error: '请先下载安装包' };
  changed({ status: 'verifying', percent: 0, message: '正在校验安装包，请稍候…' });
  try {
    // 流式校验让窗口持续响应，并按实际读取字节显示进度。
    const hash = crypto.createHash('sha256');
    let bytes = 0, last = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      bytes += chunk.length; hash.update(chunk);
      if (Date.now() - last > 100) { last = Date.now(); changed({ percent: Math.min(100, Math.floor(bytes / manifest.bytes * 100)) }); }
    }
    if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) {
      changed({ status: 'available', percent: 0, message: '安装包校验失败，请重新下载' });
      return { ok: false, error: '安装包校验失败，请重新下载' };
    }
    if (require('./jobs').list().length) {
      changed({ status: 'downloaded', percent: 100, message: '任务正在运行，请完成后重启并更新' });
      return { ok: false, error: '请等待所有任务完成后再安装更新' };
    }
    require('./store').flush();
    changed({ status: 'installing', percent: 100, message: '校验完成，正在启动更新…App 即将退出，更新完成后自动打开' });
    // 与 NSIS 官方更新器参数保持一致：静默升级原安装目录，安装完成重新启动。
    const child = spawn(file, ['--updated', '/S', '--force-run', '/D=' + path.dirname(app.getPath('exe'))], { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await new Promise(resolve => setTimeout(resolve, 700));
    app.quit(); return { ok: true };
  } catch (e) {
    changed({ status: 'downloaded', percent: 100, message: '无法启动更新：' + e.message + '，请重试' });
    return { ok: false, error: '无法启动安装程序：' + e.message };
  }
}
let scheduled = false;
function start() {
  if (scheduled) return;
  scheduled = true;
  // 下载完成后保留重启按钮，不让定时检查覆盖待安装状态。
  const automaticCheck = () => state.status === 'downloaded' ? undefined : check();
  const timer = setTimeout(automaticCheck, 20000); timer.unref();
  const interval = setInterval(automaticCheck, 60 * 60 * 1000); interval.unref();
}
module.exports = { status: () => ({ ok: true, ...state }), check, download, install, start, validate, BUILD, REPO };
