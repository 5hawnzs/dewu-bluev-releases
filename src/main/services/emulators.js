'use strict';
// 从 MuMu 自己的实例信息读取端口，不推算端口、不扫描局域网、不重启全局 ADB。
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(file, args, timeout = 7000) {
  return new Promise(resolve => execFile(file, args, {
    timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout || '', error: String(stderr || (error && error.message) || '') })));
}

function parseInfo(text) {
  const data = JSON.parse(String(text).replace(/^\uFEFF/, '').trim());
  return Object.values(data).filter(v => v && v.is_process_started === true).map(v => {
    const port = Number(v.adb_port);
    // 仅允许本机回环地址，拒绝异常端口与外部地址。
    const valid = Number.isInteger(port) && port > 0 && port <= 65535
      && (!v.adb_host_ip || ['127.0.0.1', 'localhost'].includes(v.adb_host_ip));
    return { name: String(v.name || `MuMu-${v.index}`), instance: String(v.index),
      serial: valid ? `127.0.0.1:${port}` : '', state: 'starting',
      detail: valid ? '' : '模拟器正在启动，等待连接端口就绪' };
  });
}

async function discover() {
  if (process.platform !== 'win32') return { instances: [], errors: [] };
  const candidates = new Set();
  const add = p => {
    if (!p) return;
    p = String(p).trim().replace(/^"|"$/g, '');
    const dir = /\.exe$/i.test(p) ? path.dirname(p) : p;
    for (const exe of [path.join(dir, 'mumu-cli.exe'), path.join(dir, 'nx_main', 'mumu-cli.exe')]) {
      if (fs.existsSync(exe)) candidates.add(exe);
    }
  };
  // 运行进程优先，其次安装注册表。进程查询失败时仍可走安装路径。
  const script = "$ErrorActionPreference='SilentlyContinue'; $items=@(); $items+=Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'MuMuNxMain.exe'} | ForEach-Object {$_.ExecutablePath}; foreach($key in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')){$items+=Get-ItemProperty $key | Where-Object {$_.DisplayName -match 'MuMu'} | ForEach-Object {$_.InstallLocation}}; ConvertTo-Json -Compress -InputObject @($items | Where-Object {$_})";
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const errors = [];
  try { if (result.ok) JSON.parse(result.stdout).forEach(add); else errors.push('MuMu 安装信息读取失败：' + result.error); }
  catch (e) { errors.push('MuMu 安装信息无法解析'); }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (root) { add(path.join(root, 'Netease', 'MuMuPlayer-12.0')); add(path.join(root, 'MuMuPlayer')); }
  }
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') add(`${drive}:\\MUMU\\MuMuPlayer`);
  const instances = [];
  for (const cli of candidates) {
    const info = await run(cli, ['info', '-v', 'all']);
    if (!info.ok) { errors.push('MuMu 实例信息读取失败：' + info.error); continue; }
    try { instances.push(...parseInfo(info.stdout)); }
    catch (e) { errors.push('MuMu 实例信息格式无法解析'); }
  }
  return { instances: instances.filter((v, i, all) => all.findIndex(x => x.serial ? x.serial === v.serial : x.name === v.name && x.instance === v.instance) === i), errors };
}

// 仅对发现的本机端口重连；每轮均以 devices 返回的真实状态为准。
async function connectDiscovered(adb, discovery, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let raw = await adb.devices({ strict: true });
  const instances = discovery.instances.map(v => ({ ...v }));
  const details = new Map();
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = instances.filter(v => v.serial && !raw.some(d => d.serial === v.serial && d.state === 'device'));
    if (!pending.length) break;
    // 同时最多连接四台，避免大量实例把 ADB 请求堆满。
    for (let i = 0; i < pending.length; i += 4) await Promise.all(pending.slice(i, i + 4).map(async v => {
      const current = raw.find(d => d.serial === v.serial);
      if (current && current.state === 'offline') await adb.execAdb(['-s', v.serial, 'reconnect'], { timeout: 3000 });
      const r = await adb.execAdb(['connect', v.serial], { timeout: 3000 });
      details.set(v.serial, String(r.stderr || r.stdout || '').trim());
    }));
    await delay(350);
    raw = await adb.devices({ strict: true });
  }
  return { raw, instances: instances.map(v => {
    const actual = raw.find(d => d.serial === v.serial);
    return { ...v, state: actual ? actual.state : (v.serial ? 'connect-failed' : 'starting'),
      detail: actual && actual.state === 'device' ? '' : (details.get(v.serial) || v.detail || '等待模拟器连接服务就绪，稍后自动重试') };
  }), errors: discovery.errors };
}

module.exports = { discover, parseInfo, connectDiscovered };
