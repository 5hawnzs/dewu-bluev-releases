'use strict';
require('./test-runtime')();
const cp = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const runtime = path.resolve(__dirname, 'test-runtime.js');
let failed = 0;
const ok = (label, good) => { console.log((good ? 'PASS ' : 'FAIL ') + label); if (!good) failed++; };
function nodeCase(source) {
  return cp.spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000, windowsHide: true });
}
for (const stream of ['stdout', 'stderr']) {
  const r = nodeCase(`require(${JSON.stringify(runtime)})();process.${stream}.emit('error',Object.assign(new Error('断管'),{code:'EPIPE'}));process.exit(99);`);
  ok(`${stream} 异步断管立即失败退出`, r.status === 1 && !r.error);
}
const sync = nodeCase(`console.log=()=>{throw Object.assign(new Error('断管'),{code:'EPIPE'})};require(${JSON.stringify(runtime)})();console.log('测试');process.exit(99);`);
ok('console 同步断管立即失败退出且不递归写日志', sync.status === 1 && !sync.error && !sync.stderr);
const other = nodeCase(`console.log=()=>{throw Object.assign(new Error('真实错误'),{code:'EACCES'})};require(${JSON.stringify(runtime)})();console.log('测试');`);
ok('其他输出异常仍会失败并保留真实错误', other.status !== 0 && /真实错误/.test(other.stderr));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-runtime-'));
try {
  const script = path.join(dir, 'probe.cjs');
  const electronModule = path.resolve(__dirname, '../node_modules/electron');
  // 临时脚本使用 Electron 自带主进程，保护安装在首次输出之前。
  fs.writeFileSync(script, `const {app}=require('electron');require(${JSON.stringify(runtime)})({app});process.stdout.emit('error',Object.assign(new Error('断管'),{code:'EPIPE'}));app.exit(99);`);
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const r = cp.spawnSync(require(electronModule), ['--in-process-gpu', '--disable-gpu', script], { env, encoding:'utf8',timeout:15000,windowsHide:true });
  ok('真实 Electron 主进程断管无弹窗且按失败退出', r.status === 1 && !r.error);
} finally { fs.rmSync(dir, {recursive:true,force:true}); }
process.exit(failed ? 1 : 0);
