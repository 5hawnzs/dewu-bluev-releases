'use strict';
// 只读取公开更新清单、下载安装包并校验；模拟旧构建，不调用安装。
const fs = require('fs'), path = require('path'), os = require('os'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-download-probe-'));
const filename = path.resolve(__dirname, '../src/main/githubupdates.js');
const source = fs.readFileSync(filename, 'utf8');
const actual = Number(source.match(/const BUILD = (\d+);/)[1]);
const current = Number(process.env.BLUEV_PROBE_BUILD || actual - 1);
assert(Number.isSafeInteger(current) && current < actual, '验证构建号必须早于待发布构建');
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, getVersion: () => '1.1.1', quit: () => { throw Error('验证不得退出并安装'); } }, BrowserWindow: { getAllWindows: () => [] } };
  return load.apply(this, arguments);
};
const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source.replace(/const BUILD = \d+;/, 'const BUILD = ' + current + ';'), filename);
(async () => {
  const updater = mod.exports;
  const start = Date.now(), check = await updater.check();
  assert.equal(check.status, 'available', JSON.stringify(check));
  assert.equal(check.latestBuild, actual, '公开清单尚未指向最新构建');
  console.log(JSON.stringify({ phase: 'check', currentBuild: current, latestBuild: check.latestBuild, sameVersion: check.latest === '1.1.1' }));
  const downloaded = await updater.download();
  assert.equal(downloaded.status, 'downloaded', JSON.stringify(downloaded));
  const file = path.join(tmp, 'updates', 'bluev-' + check.latestBuild + '.exe');
  const result = { ok: true, latestBuild: check.latestBuild, bytes: fs.statSync(file).size, seconds: (Date.now() - start) / 1000, sha256Verified: true, installed: false };
  fs.writeFileSync(path.resolve(__dirname, '../../investigation-20261012/github-download-probe.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  fs.unlinkSync(file);
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
