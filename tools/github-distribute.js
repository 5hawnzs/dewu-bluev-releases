'use strict';
// 公开仓库仅上传白名单分发文件。授权令牌只在发布进程内使用。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const OWNER = 'wfjdyhmtr2-glitch', NAME = 'dewu-bluev-releases', REPO = OWNER + '/' + NAME;
async function main() {
  const lines = fs.readFileSync(path.join(process.env.USERPROFILE, '.git-credentials'), 'utf8').split(/\r?\n/);
  let token;
  for (const line of lines) {
    try {
      const u = new URL(line); if (u.hostname !== 'github.com' || !u.password) continue;
      const candidate = decodeURIComponent(u.password);
      const r = await fetch(`https://api.github.com/repos/${OWNER}/dewu-bluev-publisher`, { headers: { Authorization: 'Bearer ' + candidate, 'User-Agent': 'bluev-distribution' } });
      const d = await r.json(); if (r.ok && d.permissions?.push) { token = candidate; break; }
    } catch {}
  }
  if (!token) throw Error('本机 GitHub 授权不可用');
  const headers = { Authorization: 'Bearer ' + token, 'User-Agent': 'bluev-distribution', Accept: 'application/vnd.github+json' };
  async function api(endpoint, method = 'GET', body) {
    const r = await fetch('https://api.github.com' + endpoint, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    const d = r.status === 204 ? null : await r.json();
    if (!r.ok) throw Error(`GitHub ${r.status}: ${d?.message}`); return d;
  }
  let repository;
  const check = await fetch('https://api.github.com/repos/' + REPO, { headers });
  if (check.status === 404) repository = await api('/user/repos', 'POST', { name: NAME, private: false, auto_init: true, description: '得物蓝V素材发布工具 · Windows 安装包与更新清单（不含源码）' });
  else { repository = await check.json(); if (!check.ok) throw Error('分发仓库读取失败'); }
  if (repository.private || repository.full_name !== REPO) throw Error('仓库身份或可见性不符合要求');
  console.log(JSON.stringify({ repository: repository.html_url, private: repository.private }));
  if (process.argv.includes('--create-only')) return;
  const dir = path.resolve(__dirname, '../distribution/v1.1.1');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'distribution.json'), 'utf8'));
  const exe = fs.readFileSync(path.join(dir, m.file));
  if (crypto.createHash('sha256').update(exe).digest('hex') !== m.sha256) throw Error('本地安装包校验失败');
  const tag = 'v' + m.version + '-build.' + m.build;
  const releases = await api('/repos/' + REPO + '/releases?per_page=100');
  let release = releases.find(x => x.tag_name === tag);
  if (release && !release.draft) throw Error('此构建已发布，禁止覆盖');
  if (!release) release = await api('/repos/' + REPO + '/releases', 'POST', { tag_name: tag, name: '得物蓝V素材发布工具 ' + m.version, draft: true, body: '专用发布模拟器改用媒体库删除、重扫和回读清理，不再依赖目录ls检查，不新建或切换相册；补齐未索引素材重扫和特殊文件名删除。视频显式选择并核验非黑封面；云端增加逐阶段实测耗时；修复计时刷新与取消状态，同一设备避免发布和重跑并发。\n\n安装前请保存编辑内容并退出应用。\nSHA-256：' + m.sha256 });
  for (const name of [m.file, 'SHA256SUMS.txt', 'distribution.json']) {
    const binaryName = `bluev-publisher-${m.version}-x64-win.exe`;
    const remoteName = name === m.file ? binaryName : name;
    const body = name === 'SHA256SUMS.txt' ? Buffer.from(`${m.sha256}  ${binaryName}\n`) : name === 'distribution.json' ? Buffer.from(JSON.stringify({ ...m, file: binaryName }, null, 2) + '\n') : fs.readFileSync(path.join(dir, name));
    const existing = release.assets?.find(a => a.name === remoteName);
    if (existing) { if (existing.digest !== 'sha256:' + crypto.createHash('sha256').update(body).digest('hex')) throw Error('草稿附件不同，停止覆盖'); continue; }
    const r = await fetch(release.upload_url.replace(/\{.*$/, '') + '?name=' + encodeURIComponent(remoteName), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(15 * 60000) });
    const d = await r.json(); if (!r.ok) throw Error('上传失败 ' + r.status + ': ' + d.message);
    if (d.size !== body.length || d.digest !== 'sha256:' + crypto.createHash('sha256').update(body).digest('hex')) throw Error('远端文件校验失败');
    console.log(JSON.stringify({ uploaded: d.name, bytes: d.size }));
  }
  release = await api('/repos/' + REPO + '/releases/' + release.id, 'PATCH', { draft: false, make_latest: 'true' });
  const installer = release.assets.find(a => a.digest === 'sha256:' + m.sha256 && a.size === m.bytes);
  if (!installer) throw Error('正式 Release 中找不到校验一致的安装包');
  const latest = { version: m.version, build: m.build, bytes: m.bytes, sha256: m.sha256, url: installer.browser_download_url };
  const contentsPath = '/repos/' + REPO + '/contents/latest.json';
  const old = await fetch('https://api.github.com' + contentsPath, { headers });
  const oldData = old.ok ? await old.json() : null;
  await api(contentsPath, 'PUT', { message: '发布 ' + tag + ' 更新清单', content: Buffer.from(JSON.stringify(latest, null, 2) + '\n').toString('base64'), ...(oldData ? { sha: oldData.sha } : {}), branch: 'main' });
  console.log(JSON.stringify({ release: release.html_url, manifest: latest }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
