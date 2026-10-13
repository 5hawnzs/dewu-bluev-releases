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
function checkCancelled(ctx) {
  if (ctx.cancelled?.()) throw new Error('已取消');
}
async function click(serial, nodes, id, ctx) {
  checkCancelled(ctx);
  const n = nodes.find(n => n.id === ID + id && n.enabled && n.center);
  if (!n) throw new Error('封面流程缺少按钮：' + id);
  const r = await adb.tap(serial, n.center.x, n.center.y);
  if (!r.ok) throw new Error('封面按钮点击失败：' + id);
}
async function pause(ctx) {
  for (let i = 0; i < 5; i++) {
    checkCancelled(ctx);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  checkCancelled(ctx);
}
// 页面标题先出现不代表视频解码与帧条已经完成；只回读等待，不盲点下一步。
async function waitReady(label, read, ctx, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let why = '页面尚未就绪', attempts = 0;
  while (true) {
    checkCancelled(ctx);
    try {
      const result = await read();
      checkCancelled(ctx);
      attempts++;
      if (result.ready) {
        if (attempts > 1) ctx.log?.(`${label}已就绪（回读 ${attempts} 次）`, 'info');
        return result.value;
      }
      why = result.why;
    } catch (error) {
      checkCancelled(ctx);
      attempts++;
      why = error.message;
    }
    if (Date.now() >= deadline) throw new Error(`${label}等待超时：${why}（回读 ${attempts} 次）`);
    await pause(ctx);
  }
}
async function verify(serial, ctx = {}) {
  return waitReady('发布编辑页视频封面', async () => {
    const nodes = await inspect(serial);
    const n = nodes.find(n => n.id === ID + 'ivVideoCover');
    if (!n) return { ready: false, why: '发布编辑页没有视频封面' };
    // 下方是“编辑封面”文字遮罩，排除它，避免黑图因白字而误通过。
    const result = analyse(await adb.screencap(serial), n.box, .68);
    return { ready: result.ok, value: result, why: '封面仍为黑场或空画面' };
  }, ctx);
}
async function select(serial, ctx = {}) {
  const { nodes, frames, preview } = await waitReady('设置封面页视频帧条', async () => {
    const nodes = await inspect(serial);
    const onPage = nodes.some(n => n.id === ID + 'tvTitle' && n.text === '设置封面');
    const frames = nodes.filter(n => n.id === ID + 'image_frame' && n.center && n.box?.x2 > n.box?.x1 && n.box?.y2 > n.box?.y1);
    const title = nodes.find(n => n.id === ID + 'titleBar');
    const bottom = nodes.find(n => n.id === ID + 'fl_bottom');
    const preview = title?.box && bottom?.box ? { x1: bottom.box.x1, x2: bottom.box.x2, y1: title.box.y2, y2: bottom.box.y1 } : null;
    const ready = onPage && frames.length >= 1 && preview && preview.x2 - preview.x1 >= 20 && preview.y2 - preview.y1 >= 20;
    return { ready, value: { nodes, frames, preview }, why: `设置封面=${onPage ? '有' : '无'}，帧数=${frames.length}，标题栏=${title?.box ? '有' : '无'}，底栏=${bottom?.box ? '有' : '无'}，预览区域=${ready ? '有效' : '未就绪'}` };
  }, ctx);
  let selected = null;
  const tried = new Set();
  for (const fraction of [.5, .25, .75, .1, .9]) {
    const index = Math.min(frames.length - 1, Math.floor(frames.length * fraction));
    if (tried.has(index)) continue;
    tried.add(index);
    checkCancelled(ctx);
    const frame = frames[index];
    const r = await adb.tap(serial, frame.center.x, frame.center.y);
    if (!r.ok) throw new Error('选择视频封面帧失败');
    await pause(ctx);
    let result;
    try {
      result = await waitReady('候选视频帧预览', async () => {
        const sampled = analyse(await adb.screencap(serial), preview);
        return { ready: sampled.ok, value: sampled, why: '候选帧仍为黑场或空画面' };
      }, ctx, 2500);
    } catch (error) {
      checkCancelled(ctx);
      ctx.log?.(`当前封面帧未通过，尝试其他候选：${error.message}`, 'warn');
      continue;
    }
    if (result.ok) { selected = { fraction, ...result }; break; }
  }
  if (!selected) throw new Error('候选视频封面均为黑场或空画面，停止发布');
  // 再读当前页按钮，避免加载期间布局变化后使用旧坐标。
  const fresh = await inspect(serial);
  checkCancelled(ctx);
  if (!fresh.some(n => n.id === ID + 'tvTitle' && n.text === '设置封面')) throw new Error('选择视频帧后页面已变化，停止点击');
  await click(serial, fresh, 'tvNextStep', ctx);
  const edit = await waitReady('编辑封面页预览', async () => {
    const nodes = await inspect(serial);
    if (!nodes.some(n => n.id === ID + 'tvTitle' && n.text === '编辑封面')) return { ready: false, why: '未进入编辑封面页' };
    const cover = nodes.find(n => n.id === ID + 'fl_cover');
    if (!cover?.box) return { ready: false, why: '缺少封面预览控件 fl_cover' };
    return { ready: analyse(await adb.screencap(serial), cover.box).ok, value: nodes, why: '编辑封面预览仍为空或黑场' };
  }, ctx);
  await click(serial, edit, 'tvNextStep', ctx);
  const final = await verify(serial, ctx);
  ctx.log?.(`视频封面已选择第 ${Math.round(selected.fraction * 100)}% 位置候选帧；最终缩略图对比度 ${final.contrast}，非黑采样 ${final.litPercent}%`, 'info');
  return { ...selected, final };
}
module.exports = { analyse, select, verify };
