'use strict';
require('./test-runtime')();
/**
 * 一键回归（跨平台：macOS / Linux / Windows 都能跑）
 *   node tools/run-all.js            跑全部
 *   node tools/run-all.js smoke      只跑名字里带 smoke 的
 *
 * 覆盖：
 *   smoke          造临时素材跑完整流水线
 *   adbtest        假 adb 验证真实发布通道
 *   pendingtest    发布单被占用 → 整批暂存 → 下次补写
 *   compliancetest 合规边界 + 导出报告 + 非 mp4 视频自动转 mp4（含 type 不被改成图片）
 *   videotest      视频转 mp4（内置 ffmpeg 现造样本，真读产物：转封装优先 / 转码兜底 / 失败如实报错不留半成品）
 *   batchtest      多批次并行 / 取消 / 按批次重导出日志
 *   copytest       文案生成（看图写：真发图 / 模型名解析 / 连不上不冒充 + 带时间戳的 AI 内容报告 + 一致性核对）
 *   reporttest     「AI 内容报告」导入 → 发布 → 回写
 *   brandtest      品牌权限 + 按品牌统计（未标品牌单列 / 已删除品牌保留）
 *   uicheck        隐藏窗口加载真实渲染层（10 个页签 + 零控制台报错 + 运行日志页同步/筛选/导出）
 *   logintest      登录门（未登录拦截 / 口令 / 权限 / 防爆破）
 *   gatetest       登录门窗口尺寸（未登录收缩成小窗 / 登录后还原 / 退出再收缩）
 *   updatertest    自动更新状态机（下载完绝不自动重启 / 便携版与开发模式如实说不可用 / 可选文件日志）
 *   releasetest    发版工具纯逻辑（latest.yml 读错就是 404 / 便携版永不上传 / 同版本号默认拦下）
 *   prunetest      老包清理策略（唯一会删东西的工具：读错版本号就删错包 / 源上状态不明时一个字节都不删）
 *   logtest        运行日志导出格式（条数不许谎报 / 完整日期时间 / 行尾固定 \n / 真落盘）
 *   cloudauth-test 云端统一账号（只用 anon key / 不公开账号表 / 安全函数固定 search_path / 无回退本机登录）
 *   cloudtest      云端同步（关着不联网 / 只推增量 / 幂等头 / 不留绝对路径 / 失败不推进游标 /
 *                  内置的只能是 anon key / 导入配置先校验并拦下 service_role）
 *
 * 三个 Electron 套件需要有桌面会话（远程桌面里要有人在的会话，纯后台 SSH 会起不来）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const FILTER = process.argv[2] || '';
const IS_WIN = process.platform === 'win32';

/** 在 Node 里 require('electron') 返回的是可执行文件路径（不是模块） */
function electronBin() {
  try {
    const p = require(path.join(ROOT, 'node_modules', 'electron'));
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch (e) { /* 没装 electron */ }
  return path.join(ROOT, 'node_modules', '.bin', IS_WIN ? 'electron.cmd' : 'electron');
}

const NODE = process.execPath;
const ELECTRON = electronBin();

// 子进程环境：ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成纯 Node
// （require('electron').app 变 undefined → 两个 Electron 套件一上来就 TypeError），必须清掉
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.ELECTRON_RUN_AS_NODE;

// uicheck / logintest / gatetest 只加载隐藏窗口，不需要 GPU。但在没有桌面会话或没有可用 GPU 的环境里
// （远程/CI/沙箱）GPU 进程会反复退出并 FATAL 掉整个 Electron，所以固定关掉 GPU、改进程内渲染。
const ELECTRON_FLAGS = ['--in-process-gpu', '--disable-gpu'];

const SUITES = [
  ['titlehistorytest', 'node', ['tools/titlehistorytest.js']],
  ['testruntimetest', 'node', ['tools/testruntimetest.js']],
  ['historytest', 'node', ['tools/historytest.js']],
  ['boardtest', 'electron', ['tools/boardtest.js']],
  ['securitytest', 'node', ['tools/securitytest.js']],
  ['sqlauth-securitytest', 'node', ['tools/sqlauth-securitytest.js']],
  ['topicinputtest', 'node', ['tools/topicinputtest.js']],
  ['emulatortest', 'node', ['tools/emulatortest.js']],
  ['smoke', 'node', ['tools/smoke.js']],
  ['adbtest', 'node', ['tools/adbtest.js']],
  ['mediaquerytest', 'node', ['tools/mediaquerytest.js']],
  ['publish-sequencetest', 'node', ['tools/publish-sequencetest.js']],
  ['albumreadytest', 'node', ['tools/albumreadytest.js']],
  ['publishcontinuationtest', 'node', ['tools/publishcontinuationtest.js']],
  ['frontendstatetest', 'node', ['tools/frontendstatetest.js']],
  ['diagnosticstest', 'node', ['tools/diagnosticstest.js']],
  ['sleepguardtest', 'node', ['tools/sleepguardtest.js']],
  ['displayrecoverytest', 'node', ['tools/displayrecoverytest.js']],
  ['mediapermissiontest', 'node', ['tools/mediapermissiontest.js']],
  ['pendingtest', 'node', ['tools/pendingtest.js']],
  ['writebacktest', 'node', ['tools/writebacktest.js']],
  ['compliancetest', 'node', ['tools/compliancetest.js']],
  ['videotest', 'node', ['tools/videotest.js']],
  ['videocovertest', 'node', ['tools/videocovertest.js']],
  ['batchtest', 'node', ['tools/batchtest.js']],
  ['copytest', 'node', ['tools/copytest.js']],
  ['reporttest', 'node', ['tools/reporttest.js']],
  ['brandtest', 'node', ['tools/brandtest.js']],
  ['uicheck', 'electron', ['tools/uicheck.js']],
  ['logintest', 'electron', ['tools/logintest.js']],
  ['gatetest', 'electron', ['tools/gatetest.js']],
  ['updatertest', 'node', ['tools/updatertest.js']],
  ['github-updatetest', 'node', ['tools/github-update-test.js']],
  ['releasetest', 'node', ['tools/releasetest.js']],
  ['prunetest', 'node', ['tools/prunetest.js']],
  ['logtest', 'node', ['tools/logtest.js']],
  ['cloudauth-test', 'node', ['tools/cloudauth-test.js']],
  ['cloudtest', 'node', ['tools/cloudtest.js']],
  ['feedbacktest', 'node', ['tools/feedbacktest.js']],
  ['feedback-board-test', 'electron', ['tools/feedback-board-test.js']],
  ['apiusagetest', 'node', ['tools/apiusagetest.js']],
  ['defaultstest', 'node', ['tools/defaultstest.js']],
  ['hotwordsexceltest', 'node', ['tools/hotwordsexceltest.js']],
  ['hotwordstransfertest', 'electron', ['tools/hotwordstransfertest.js']],
  ['heictest', 'node', ['tools/heictest.js']]
];

/** macOS 上本机 Electron 二进制会因签名问题被 SIGKILL，先自签一遍（幂等） */
function fixElectronOnMac() {
  if (process.platform !== 'darwin') return;
  const app = path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  if (!fs.existsSync(app)) return;
  spawnSync('xattr', ['-cr', app], { stdio: 'ignore' });
  spawnSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
}

console.log(`node: ${NODE}`);
console.log(`electron: ${ELECTRON}`);
if (!fs.existsSync(ELECTRON) && !ELECTRON.endsWith('.cmd')) {
  console.log('⚠️ 找不到 Electron 可执行文件：先 npm install（跑 uicheck / logintest 需要它）');
}
fixElectronOnMac();
console.log('回归开始（每改一处都要跑完这一套）\n');

// ---- 0) 前置：得物安装包在仓库里是**分卷**存的（单文件 100 MiB 上限，见 vendor/README.md §4.1）----
// 不先拼回单文件，uicheck / adbtest 里那几条「内置的得物安装包在仓库里」会红 ——
// 而那是**夹具没准备好**、不是产品坏了，很容易把人带偏。所以这一步失败就直接中止并说清原因，
// 不把它混进下面 18 套的 PASS/FAIL 里（它不是断言，是前置）。
{
  const r = spawnSync(NODE, [path.join(ROOT, 'tools', 'dewuapk-assemble.js')], {
    cwd: ROOT, encoding: 'utf8', env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    console.log('❌ 前置失败：得物安装包拼不回来（vendor/dewu 下的分卷片段缺了或坏了）');
    console.log(out.split(/\r?\n/).map(l => '   ' + l).join('\n'));
    console.log('   这一步没过就别往下看了 —— 后面 uicheck / adbtest 的失败是它引起的。\n');
    process.exit(1);
  }
  console.log('前置（得物安装包分卷拼接）：' + out.split(/\r?\n/).pop().trim() + '\n');
}

let failed = 0;
let totalPass = 0;
for (const [name, kind, args] of SUITES) {
  if (FILTER && !name.includes(FILTER)) continue;
  const bin = kind === 'electron' ? ELECTRON : NODE;
  const argv = kind === 'electron' ? ELECTRON_FLAGS.concat(args) : args;
  const r = spawnSync(bin, argv, { cwd: ROOT, encoding: 'utf8', env: CHILD_ENV, timeout: 240000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length;
  totalPass += pass;
  const code = r.status == null ? 1 : r.status;
  if (code === 0 && fail === 0 && pass > 0) {
    console.log(`  ✅ ${name.padEnd(16)} PASS ${String(pass).padEnd(4)}`);
  } else {
    failed++;
    console.log(`  ❌ ${name.padEnd(16)} PASS ${String(pass).padEnd(4)} FAIL ${fail} (exit ${code})`);
    const bad = out.split(/\r?\n/).filter(l => /^FAIL/.test(l) || /ERROR|Error:/.test(l)).slice(0, 12);
    if (bad.length) console.log(bad.map(l => '       ' + l).join('\n'));
    if (!pass && !bad.length) console.log(`       ${(out.split(/\r?\n/).filter(Boolean).slice(0, 8).join('\n       '))}`);
  }
}

console.log('');
if (failed === 0) {
  console.log(`全部通过，共 ${totalPass} 项断言。`);
} else {
  console.log(`有 ${failed} 套没过（通过 ${totalPass} 项），失败项已列在上面。`);
}
process.exit(failed === 0 ? 0 : 1);
