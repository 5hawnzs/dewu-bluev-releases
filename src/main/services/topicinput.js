'use strict';
const adb = require('./adb');

// 识别原定位表中的独立话题占位符，图文和视频共用，不要求用户重新导入表。
function mark(raw, filled) {
  return Object.assign({}, filled, {
    topicInput: raw.action === 'input' && /^\s*\$\{topic\d+\}\s*$/.test(String(raw.value || ''))
  });
}

async function send(serial, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const r = await adb.shell(serial, `am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
  if (!r.ok) throw new Error('话题输入失败：' + (r.stderr || '设备未接受输入').trim());
}

async function ready(serial) {
  const kbd = await adb.keyboardReady(serial);
  if (!kbd.active) throw new Error('话题输入需要 ADBKeyboard 为当前输入法，当前是：' + (kbd.current || '未知'));
}

async function write(serial, value, ctx) {
  const name = String(value == null ? '' : value).trim().replace(/^#+/, '');
  if (!name) return;
  // 一次提交多个话题会退回普通文字，拒绝悄悄改写或截掉用户输入。
  if (/[\s#]/u.test(name)) throw new Error('每个话题列只能填写一个话题，不能包含空白或内部 #：' + name);
  await ready(serial);
  // MuMu 实测：分隔符与 # 可合并，话题名必须另一次提交；中文与英文都走同一通道。
  await send(serial, '\n#');
  await send(serial, name);
  ctx.topicNeedsEnd = true;
}

async function finish(serial, ctx) {
  if (!ctx || !ctx.topicNeedsEnd) return;
  await ready(serial);
  // 最后一个话题不结束时，编辑页虽蓝色，预览仍可能是普通文字。
  await send(serial, ' ');
  ctx.topicNeedsEnd = false;
}

module.exports = { mark, write, finish };
