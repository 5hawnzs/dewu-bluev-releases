'use strict';
/**
 * 覆盖安装后的自检：asar 里声明为 unpacked 的文件（sharp / libvips 那些原生件）
 * 在 app.asar.unpacked 下必须真的存在、大小一致。
 *
 * 为什么这条判据必须在：用户 2026-10-17 报的「打开就弹 unknown software exception」
 * 有两次就落在「正在替换安装内容」的时间窗里；半拷的原生件正是这种崩法。
 * 装完自检不过就回滚，绝不允许把半成品留在机器上。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkUnpacked } = require('./lib/unpacked-check.cjs');

/** 假 asar：只要 listPackage / statFile 两个口子（与真 @electron/asar 同形） */
function fakeAsar(table) {
  return {
    listPackage: () => Object.keys(table).map(name => '/' + name),
    statFile: (archive, name) => table[String(name).replace(/\\/g, '/')] || { files: {} }
  };
}

function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-unpacked-'));
  for (const [name, bytes] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  }
  return root;
}

{
  const table = {
    'node_modules/@img/sharp.node': { unpacked: true, size: 4 },
    'node_modules/@img/libvips.dll': { unpacked: true, size: 8 },
    'src/main/index.js': { size: 16 }
  };
  const root = workspace({ 'node_modules/@img/sharp.node': 4, 'node_modules/@img/libvips.dll': 8 });
  const result = checkUnpacked(fakeAsar(table), 'app.asar', root, fs);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 2);
  console.log('PASS 原生件齐全时判定通过（只查声明为 unpacked 的那部分）');
}

{
  const table = {
    'node_modules/@img/libvips.dll': { unpacked: true, size: 8 },
    'node_modules/@img/sharp.node': { unpacked: true, size: 4 }
  };
  const root = workspace({ 'node_modules/@img/libvips.dll': 8 });
  const result = checkUnpacked(fakeAsar(table), 'app.asar', root, fs);
  assert.equal(result.problems.length, 1);
  assert.ok(/sharp\.node/.test(result.problems[0]) && /缺/.test(result.problems[0]), result.problems[0]);
  console.log('PASS 少了原生件必须报出来（并指名是哪一个）');
}

{
  const table = { 'node_modules/@img/libvips.dll': { unpacked: true, size: 8 * 1024 } };
  const root = workspace({ 'node_modules/@img/libvips.dll': 1024 });
  const result = checkUnpacked(fakeAsar(table), 'app.asar', root, fs);
  assert.equal(result.problems.length, 1);
  assert.ok(/大小/.test(result.problems[0]) && /libvips/.test(result.problems[0]), result.problems[0]);
  console.log('PASS 半拷（大小不符）必须报出来');
}

{
  const table = { 'node_modules/@img/libvips.dll': { unpacked: true, size: 8 } };
  const root = workspace({ 'node_modules/@img/libvips.dll': 8, 'stray.txt': 2 });
  const result = checkUnpacked(fakeAsar(table), 'app.asar', root, fs);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.extra, ['stray.txt']);
  console.log('PASS 多出来的文件只登记不判死（不影响启动）');
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-unpacked-'));
  const result = checkUnpacked(fakeAsar({ 'src/main/index.js': { size: 3 } }), 'app.asar', root, fs);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 0);
  console.log('PASS 包里没有 unpacked 声明时不要求 unpacked 目录存在');
}
