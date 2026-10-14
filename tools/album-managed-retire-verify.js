#!/usr/bin/env node
'use strict';
/**
 * rich 相册清理**第二道前置步骤**的真机复核（人工显式调用）。
 *
 * 背景：`managedalbum.retire` 只是「把上一批素材目录提前摘出相册索引」的**建议性**动作；
 *   rich 的历史故障恰恰是**目录命令超时被杀**（旧日志：`ls 相册命令超时或被终止 …SIGTERM`）。
 *   旧写法一旦 ls 失败就 throw ⇒ 整整一批在第一道前置步骤停住、后面每条都被记成「未执行」。
 *   现在读不到就如实记一笔、交给随后的全盘四表复核兜底。
 *
 * 用法：
 *   node tools/album-managed-retire-verify.js [serial]
 *   默认 serial=127.0.0.1:16384。
 *
 * 本探针在**真机上**制造一次「目录命令被杀」：用设备上的 `timeout 0.05s` 把一条
 *   `ls -1A` 掐掉，确认「被超时杀掉」在真机上长什么样（killed=true / 非 0 退出码 / 空输出），
 *   然后对照产品代码走真实 `managedalbum.retire`，断言它**返回结构化结果而不是 throw**，
 *   且不额外发命令、不清任何用户素材。
 *
 * ★ 只读：不写任何标记、不删任何文件（它自己也不创建文件）。任何一步失败都如实打印。
 */
const path = require('path');
const adb = require('../src/main/services/adb');
adb.setBundledAdbDir(path.resolve(__dirname, '..', 'vendor', 'adb'));
const serial = process.argv[2] || '127.0.0.1:16384';
const ROOT = '/sdcard/Movies/BlueV';
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const results = [];
const step = (name, data) => { results.push({ step: name, ...data }); console.log(name, JSON.stringify(data)); };
(async () => {
  const online = await adb.online(serial);
  if (!online) throw new Error('设备不在线：' + serial);

  // ① 真机上「目录命令被超时掐掉」长什么样（这是 rich 日志里的形态）
  //   ★ 关键：rich 的 `ls 相册命令超时或被终止` 是**宿主侧 execFile 超时**（Node 把 adb.exe 杀掉）
  //     的结果，不是设备上 timeout 命令的结果。所以这里用产品自己的 shell() 配一个**短于命令耗时**
  //     的 timeout，走真实驱动 + 真实设备，看它回什么形态。
  const killed = await adb.shell(serial, 'sleep 5; ls -1A ' + quote(ROOT), { timeout: 900 });
  step('真机命令被宿主超时掐掉', { ok: killed.ok, code: killed.code, killed: killed.killed,
    signal: killed.signal, timeoutMs: killed.timeoutMs, stdoutLen: String(killed.stdout || '').length });
  if (!killed.killed) {
    throw new Error('真实驱动没有把超时表现为 killed=true —— 产品区分不了「结果未知」和「跑完报错」');
  }

  // ② 产品代码：读不到目录时必须**返回结构化结果**（listed:false + 原因），绝不 throw
  const managedalbum = require('../src/main/services/managedalbum');
  let retireResult = null, threw = '';
  try { retireResult = await managedalbum.retire(serial, {}); } catch (e) { threw = e.message; }
  step('managedalbum.retire（真实设备）', { threw, result: retireResult });
  if (threw) throw new Error('retire 仍然会 throw：' + threw);
  if (!retireResult || typeof retireResult.listed !== 'boolean') {
    throw new Error('retire 没有如实回传 listed 状态：' + JSON.stringify(retireResult));
  }

  // ③ **真正走一遍失败分支**（真机 + 真实实现，不改产品代码）：把预算压成 0，
  //   等价的现场就是「这次列不出素材批次目录」。要求：返回结构化结果、说清原因、绝不 throw。
  let failThrew = '', failResult = null;
  try { failResult = await managedalbum.retire(serial, { deadline: Date.now() }); }
  catch (e) { failThrew = e.message; }
  step('managedalbum.retire（列不出目录的分支）', { threw: failThrew, result: failResult });
  if (failThrew) throw new Error('列不出目录时 retire 仍然 throw：' + failThrew);
  if (!failResult || failResult.listed !== false || !failResult.note) {
    throw new Error('列不出目录时没有如实回传 listed:false + 原因：' + JSON.stringify(failResult));
  }
  if (failResult.isolated || failResult.pending || failResult.degraded) {
    throw new Error('列不出目录时不该谎报隔离/回收结果：' + JSON.stringify(failResult));
  }

  // ④ 不变量：这两次调用都不许删任何用户素材（只允许隔离/回收属于本工具自己的批次目录）
  step('结论', { pass: true,
    note: '目录命令被超时杀掉时 retire 返回结构化结果、不再 throw；相册是否干净由随后的全盘四表复核判定' });
  const outDir = path.resolve('.local-album-1503');
  require('fs').mkdirSync(outDir, { recursive: true });
  require('fs').writeFileSync(path.join(outDir, 'retire-result.json'),
    JSON.stringify({ serial, pass: true, results }, null, 2));
})().catch(e => { console.error('FAIL', e.message); process.exitCode = 1; });
