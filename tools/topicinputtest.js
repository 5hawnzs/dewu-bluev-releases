'use strict';
const assert = require('assert/strict');
const adb = require('../src/main/services/adb');
const topic = require('../src/main/services/topicinput');
const uimap = require('../src/main/services/uimap');
const publisher = require('../src/main/services/publisher');
let count = 0;
let sent = [];
let active = true;
let failAt = -1;
adb.keyboardReady = async () => ({ active, current: active ? 'com.android.adbkeyboard/.AdbIME' : '其它输入法' });
adb.shell = async (_serial, cmd) => {
  const text = Buffer.from(cmd.split(' ').pop(), 'base64').toString('utf8');
  sent.push(text);
  return { ok: sent.length !== failAt, stderr: '注入的设备失败' };
};
function ok(name, test) { assert.ok(test, name); count++; console.log('PASS ' + name); }
function reset() { sent = []; active = true; failAt = -1; return {}; }
async function rejects(name, fn) { await assert.rejects(fn); count++; console.log('PASS ' + name); }

(async () => {
  const names = ['男生穿搭', '秋冬穿搭', '日常穿搭', '通勤穿搭', '简约穿搭'];
  let ctx = reset();
  for (let i = 0; i < names.length; i++) {
    const raw = { action: 'input', value: '${topic' + (i + 1) + '}' };
    const step = topic.mark(raw, uimap.fill(raw, { ['topic' + (i + 1)]: '#' + names[i] }));
    await publisher.runStep('test', step, {}, ctx);
  }
  ok('五话题分别提交前缀和名称，英文中文走同一广播通道', JSON.stringify(sent) === JSON.stringify(names.flatMap(n => ['\n#', n])));
  await publisher.runStep('test', { action: 'wait', value: 1 }, {}, ctx);
  ok('离开话题段前补一次结束空格，共 11 次提交', sent.length === 11 && sent[10] === ' ' && !ctx.topicNeedsEnd);
  await topic.finish('test', ctx);
  ok('结束动作幂等，不重复加空格', sent.length === 11);
  ctx = reset();
  await topic.write('test', ' #OOTD ', ctx);
  await topic.finish('test', ctx);
  ok('英文话题去前导 #，两次提交且正常结束', JSON.stringify(sent) === JSON.stringify(['\n#', 'OOTD', ' ']));
  ctx = reset();
  await topic.write('test', '', ctx);
  await topic.write('test', '###', ctx);
  await topic.finish('test', ctx);
  ok('空话题不产生孤立 # 或结束空格', sent.length === 0);
  for (const bad of ['#男生穿搭 #秋冬穿搭', '男生\n穿搭', '男生#穿搭']) {
    await rejects('非法多话题在发送前报错：' + JSON.stringify(bad), () => topic.write('test', bad, ctx));
  }
  ok('非法输入没有向设备写入部分内容', sent.length === 0);
  active = false;
  await rejects('输入法不可用时停止', () => topic.write('test', '#男生穿搭', ctx));
  ok('输入法失败前不提交 #', sent.length === 0);
  for (const pos of [1, 2]) {
    ctx = reset(); failAt = pos;
    await rejects('第 ' + pos + ' 次话题提交失败会中断', () => topic.write('test', '#男生穿搭', ctx));
    ok('失败后不再发送后续话题片段 ' + pos, sent.length === pos);
  }
  ctx = reset(); await topic.write('test', '#男生穿搭', ctx); failAt = 3;
  await rejects('末尾空格提交失败不允许继续发布', () => topic.finish('test', ctx));
  ok('结束失败保留未完成状态', ctx.topicNeedsEnd);
  for (const raw of [
    { action: 'input', value: '${title}' }, { action: 'input', value: '${body}' },
    { action: 'input', value: '${goods1Sku}' }, { action: 'input', value: '正文 #普通文字' },
    { action: 'tapText', value: '${topic1}' }, { action: 'input', value: '${title}${topic1}' }
  ]) ok('普通步骤不误判为话题：' + raw.value, !topic.mark(raw, uimap.fill(raw, {})).topicInput);
  ok('自定义表中的 topic5 也兼容', topic.mark({ action: 'input', value: '${topic5}' }, { value: '#简约穿搭' }).topicInput);
  console.log('全部通过：' + count + ' 项');
})().catch(e => { console.error('FAIL', e); process.exitCode = 1; });
