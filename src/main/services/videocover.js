'use strict';
// 以得物当前页面控件确定区域，不用整屏亮度冒充封面亮度。
const { PNG } = require('pngjs');
const adb = require('./adb');
const uimap = require('./uimap');
const ID = 'com.shizhuang.duapp:id/';
function analyse(buffer, box, bottom = 1) {
  if (!buffer || !box) throw new Error('取不到封面截图或区域，不能核验封面');
  const png = PNG.sync.read(buffer);
  const w = box.x2 - box.x1, h = (box.y2 - box.y1) * bottom;
  if (w < 20 || h < 20 || box.x1 < 0 || box.y1 < 0 || box.x2 > png.width || box.y2 > png.height) {
    throw new Error('封面区域超出截图，不能核验封面');
  }
  let min = 255, max = 0, lit = 0, count = 0;
  for (let y = Math.ceil(box.y1 + h * .15); y < box.y1 + h * .85; y += Math.max(1, Math.floor(h / 100))) {
    for (let x = Math.ceil(box.x1 + w * .15); x < box.x1 + w * .85; x += Math.max(1, Math.floor(w / 100))) {
      const i = (y * png.width + x) * 4;
      const l = .299 * png.data[i] + .587 * png.data[i + 1] + .114 * png.data[i + 2];
      min = Math.min(min, l); max = Math.max(max, l); count++; if (l > 20) lit++;
    }
  }
  return { ok: count > 0 && lit / count > .01 && max - min >= 12,
    contrast: Math.round(max - min), litPercent: count ? +(100 * lit / count).toFixed(2) : null };
}
async function inspect(serial) {
  const d = await adb.dumpEx(serial, { retries: 0, preferAnimOff: true });
  if (!d.ok) throw new Error('封面页结构读取失败：' + d.why);
  return uimap.parseNodes(d.xml);
}
async function click(serial, nodes, id) {
  const n = nodes.find(n => n.id === ID + id && n.enabled && n.center);
  if (!n) throw new Error('封面流程缺少按钮：' + id);
  const r = await adb.tap(serial, n.center.x, n.center.y);
  if (!r.ok) throw new Error('封面按钮点击失败：' + id);
}
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
async function verify(serial) {
  const nodes = await inspect(serial);
  const n = nodes.find(n => n.id === ID + 'ivVideoCover');
  if (!n) throw new Error('发布编辑页没有视频封面，停止提交');
  // 下方是“编辑封面”文字遮罩，排除它，避免黑图因白字而误通过。
  const result = analyse(await adb.screencap(serial), n.box, .68);
  if (!result.ok) throw new Error('发布编辑页封面仍为黑场或空画面，停止提交');
  return result;
}
async function select(serial, ctx = {}) {
  const nodes = await inspect(serial);
  if (!nodes.some(n => n.id === ID + 'tvTitle' && n.text === '设置封面')) {
    throw new Error('没有到达设置封面页，停止选择，避免点错页面');
  }
  const frames = nodes.filter(n => n.id === ID + 'image_frame' && n.center);
  const title = nodes.find(n => n.id === ID + 'titleBar');
  const bottom = nodes.find(n => n.id === ID + 'fl_bottom');
  if (frames.length < 2 || !title?.box || !bottom?.box) throw new Error('取不到视频帧条或封面预览区域');
  const preview = { x1: bottom.box.x1, x2: bottom.box.x2, y1: title.box.y2, y2: bottom.box.y1 };
  let selected = null;
  for (const fraction of [.5, .25, .75, .1, .9]) {
    if (ctx.cancelled?.()) throw new Error('已取消');
    const frame = frames[Math.min(frames.length - 1, Math.floor(frames.length * fraction))];
    const r = await adb.tap(serial, frame.center.x, frame.center.y);
    if (!r.ok) throw new Error('选择视频封面帧失败');
    await pause();
    const result = analyse(await adb.screencap(serial), preview);
    if (result.ok) { selected = { fraction, ...result }; break; }
  }
  if (!selected) throw new Error('候选视频封面均为黑场或空画面，停止发布');
  await click(serial, nodes, 'tvNextStep');
  await pause();
  const edit = await inspect(serial);
  if (!edit.some(n => n.id === ID + 'tvTitle' && n.text === '编辑封面')) throw new Error('选择封面后未进入编辑封面页');
  const cover = edit.find(n => n.id === ID + 'fl_cover');
  if (!analyse(await adb.screencap(serial), cover?.box).ok) throw new Error('编辑封面预览为空，停止发布');
  await click(serial, edit, 'tvNextStep');
  await pause();
  const final = await verify(serial);
  ctx.log?.(`视频封面已选择第 ${Math.round(selected.fraction * 100)}% 位置候选帧；最终缩略图对比度 ${final.contrast}，非黑采样 ${final.litPercent}%`, 'info');
  return { ...selected, final };
}
module.exports = { analyse, select, verify };
