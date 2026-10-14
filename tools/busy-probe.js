#!/usr/bin/env node
'use strict';
/**
 * 只在人工显式调用时运行的**只读**探针：验证「文件被进程持句柄时 rm 报 Text file busy」这一现场。
 *
 * 用法：
 *   node tools/busy-probe.js 127.0.0.1:16384 /sdcard/DCIM/Camera/xxx.mp4
 *
 * ★ 不改产品代码、不删用户素材：只对**调用者指定的那一个路径**做 rm / 释放后再 rm，
 *   并在开始前回显该路径是否存在。任何一步失败都如实打印，不假装通过。
 */
const path = require('path');
const adb = require('../src/main/services/adb');

const serial = process.argv[2];
const file = process.argv[3];
if (!serial || !file) { console.error('用法：node tools/busy-probe.js <serial> <设备路径>'); process.exit(2); }
if (!/^\/sdcard\//.test(file)) { console.error('只接受 /sdcard/ 下的路径'); process.exit(2); }

adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";

(async () => {
  const exists = await adb.shell(serial, '[ -f ' + quote(file) + ' ] && echo YES || echo NO');
  console.log('[1] 目标存在：' + String(exists.stdout).trim());
  if (String(exists.stdout).trim() !== 'YES') { console.log('目标不存在，无需继续（探针不造文件）'); return; }

  // 在设备上后台持句柄 12 秒：exec 9< 打开后 sleep，句柄一直在同一 shell 进程里。
  const holder = "nohup sh -c 'exec 9<" + file + "; sleep 12' >/dev/null 2>&1 & echo HELD=$!";
  const h = await adb.shell(serial, holder);
  console.log('[2] 已启动持句柄进程：' + String(h.stdout).trim());
  await new Promise(r => setTimeout(r, 800));

  const busy = await adb.shell(serial, 'rm -f ' + quote(file) + ' 2>&1; echo rc=$?');
  console.log('[3] 持句柄期间 rm：' + String(busy.stdout || busy.stderr).trim().replace(/\n/g, ' | '));

  console.log('[4] 等待句柄释放（13s）…');
  await new Promise(r => setTimeout(r, 13000));
  const after = await adb.shell(serial, 'rm -f ' + quote(file) + ' 2>&1; echo rc=$?');
  console.log('[5] 释放后 rm：' + String(after.stdout || after.stderr).trim().replace(/\n/g, ' | '));
  const left = await adb.shell(serial, '[ -e ' + quote(file) + ' ] && echo EXISTS || echo GONE');
  console.log('[6] 现在：' + String(left.stdout).trim());
})().catch(e => { console.error(e); process.exitCode = 1; });
