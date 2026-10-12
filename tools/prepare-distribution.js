'use strict';
// 只准备本地分发文件：不联网、不上传、不读取发布密钥。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
function prepare(source = path.join(ROOT, 'dist')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const name = `${pkg.build.productName}-${pkg.version}-x64-win.exe`;
  const installer = path.join(source, name);
  const resources = path.join(source, 'win-unpacked/resources');
  const asar = require('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  const read = file => asar.extractFile(archive, file.split('/').join(path.sep)).toString('utf8');
  const bundled = JSON.parse(read('package.json'));
  for (const file of ['src/main/githubupdates.js', 'src/main/feedback.js', 'src/main/jobs.js', 'src/main/uimapdefaults.js', 'src/main/services/uimap.js', 'src/main/services/displayrecovery.js', 'src/main/services/diagnostics.js', 'src/main/services/adb.js', 'src/main/services/publisher.js', 'src/main/services/cloudsync.js', 'src/renderer/app.js', 'src/renderer/styles.css', 'src/renderer/release-motion.js']) {
    if (read(file) !== fs.readFileSync(path.join(ROOT, file), 'utf8')) throw new Error('安装包源码不是最终版本：' + file);
  }
  if (bundled.version !== pkg.version) throw new Error('构建版本与源码不一致，请重新打包');
  if (bundled.build?.publish) throw new Error('安装包仍配置自动更新源');
  if (/updater\.(init|scheduleStartupCheck)/.test(read('src/main/index.js'))) throw new Error('安装包仍调度自动检查');
  if (!/githubupdates/.test(read('src/main/ipc.js'))) throw new Error('安装包缺少 GitHub 更新入口');
  if (fs.existsSync(path.join(resources, 'app-update.yml'))) throw new Error('构建目录残留自动更新配置，请使用新的输出目录');
  const bytes = fs.statSync(installer).size;
  if (!bytes) throw new Error('安装包为空');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const out = path.join(ROOT, 'distribution', `v${pkg.version}`);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(installer, path.join(out, name));
  fs.copyFileSync(installer, path.join(out, `bluev-publisher-${pkg.version}-x64-win.exe`));
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
  const buildMatch = read('src/main/githubupdates.js').match(/const BUILD = (\d+);/);
  if (!buildMatch) throw new Error('找不到构建编号');
  const manifest = { version: pkg.version, build: Number(buildMatch[1]), platform: 'windows-x64', file: name, bytes, sha256, updateMode: 'github-download-restart-update' };
  fs.writeFileSync(path.join(out, 'distribution.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(out, '安装说明.txt'), `得物蓝V素材发布工具 ${pkg.version}\r\n\r\n支持 Windows 10/11 x64。首次下载 exe 后安装。\r\n安装本版后，在更新日志页检查更新并下载；下载完成点击“重启并更新”，将自动安装并重新启动。\r\n下载显示进度，不会自动退出；有任务运行时禁止重启更新。\r\n旧 1.1.0 不含更新入口，需先手动安装一次。此前 1.1.1 可在旧入口下载安装本修复包，后续使用重启更新。\r\n可用 SHA256SUMS.txt 核对文件。\r\n`);
  console.log(JSON.stringify({ directory: out, ...manifest }, null, 2));
  return { directory: out, ...manifest };
}
if (require.main === module) {
  try { prepare(process.argv[2] ? path.resolve(process.argv[2]) : undefined); }
  catch (e) { console.error('分发准备失败：' + e.message); process.exitCode = 1; }
}
module.exports = { prepare };
