'use strict';
/**
 * 覆盖安装后的自检：`app.asar` 里声明为 unpacked 的文件，必须在 `app.asar.unpacked` 下
 * 存在且**大小一致**。
 *
 * 为什么单独成模块：这条判据只依赖「列包 + 查大小」两个口子，用替身就能验完，
 * 不必真动 D 盘那份安装（自检不该改用户机器）。
 */
const path = require('path');

function normalize(name) {
  return String(name).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/**
 * @returns {{problems: string[], extra: string[], checked: number}}
 *   problems —— 装完不能用（缺失 / 半拷），调用方应回滚
 *   extra    —— 磁盘上多出来的文件，只登记（不影响启动）
 */
function checkUnpacked(asar, archive, unpackedRoot, fs = require('fs')) {
  const problems = [];
  const declared = [];
  for (const raw of asar.listPackage(archive)) {
    const name = normalize(raw);
    const stat = asar.statFile(archive, path.normalize(name));
    if (stat && stat.unpacked) declared.push({ name, size: stat.size });
  }
  for (const file of declared) {
    const full = path.join(unpackedRoot, file.name);
    if (!fs.existsSync(full)) { problems.push(`缺文件：${file.name}`); continue; }
    const actual = fs.statSync(full).size;
    if (actual !== file.size) problems.push(`大小不一致：${file.name}（应为 ${file.size}，实际 ${actual}）`);
  }
  let extra = [];
  if (declared.length && fs.existsSync(unpackedRoot)) {
    const want = new Set(declared.map(file => file.name));
    const walk = dir => {
      let out = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) out = out.concat(walk(full));
        else out.push(normalize(path.relative(unpackedRoot, full)));
      }
      return out;
    };
    extra = walk(unpackedRoot).filter(name => !want.has(name));
  }
  return { problems, extra, checked: declared.length };
}

module.exports = { checkUnpacked, normalize };
