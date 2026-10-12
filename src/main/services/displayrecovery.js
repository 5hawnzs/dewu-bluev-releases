'use strict';
const adb = require('./adb');
const emulators = require('./emulators');

// 目标来自定位表；1080×1920、280 DPI 已在本机得物发布页逐节点核对。
function targetOf(screen) {
  if (!screen) return null;
  const w = Number(screen.w), h = Number(screen.h);
  const density = Number(screen.density) || (w === 1080 && h === 1920 ? 280 : 0);
  if (![w, h].every(n => Number.isInteger(n) && n >= 320 && n <= 4096)
    || !Number.isInteger(density) || density < 120 || density > 640) return null;
  return { w, h, density };
}

function previous(text, kind) {
  const pattern = kind === 'size' ? /Override size:\s*(\d+x\d+)/ : /Override density:\s*(\d+)/;
  const physical = kind === 'size' ? /Physical size:\s*\d+x\d+/ : /Physical density:\s*\d+/;
  if (!physical.test(text)) throw new Error('无法读取原有显示设置，未修改设备');
  const match = text.match(pattern);
  return match ? match[1] : 'reset';
}

async function repair(serial, screen, { check, cancelled = () => false, log = () => {} } = {}) {
  const target = targetOf(screen);
  if (!target) throw new Error('定位表缺少已验证的尺寸或 DPI，不能自动修改设备');
  const found = await emulators.discover();
  if (!found.instances.some(i => i.serial === serial)) throw new Error('未确认当前设备属于本机 MuMu，未修改显示设置');
  if (cancelled()) throw new Error('发布已取消');
  const live = await adb.uiSize(serial);
  if (!live.known || !live.initW || !live.initH) throw new Error('无法读取设备自然方向，未修改显示设置');
  const oldSize = await adb.shell(serial, 'wm size', { timeout: 5000 });
  const oldDpi = await adb.shell(serial, 'wm density', { timeout: 5000 });
  if (!oldSize.ok || !oldDpi.ok) throw new Error('无法备份当前显示设置，未修改设备');
  const restoreSize = previous(oldSize.stdout, 'size'), restoreDpi = previous(oldDpi.stdout, 'density');
  const small = Math.min(target.w, target.h), large = Math.max(target.w, target.h);
  const natural = live.initW > live.initH ? `${large}x${small}` : `${small}x${large}`;
  let changed = false;
  try {
    log(`定位表尺寸不匹配，自动调整当前 MuMu 为 ${target.w}×${target.h}、${target.density} DPI，并重新验证`, 'warn');
    changed = true;
    for (const command of ['wm size ' + natural, 'wm density ' + target.density]) {
      if (cancelled()) throw new Error('发布已取消');
      const result = await adb.shell(serial, command, { timeout: 5000 });
      if (!result.ok) throw new Error('显示设置命令失败：' + command.split(' ').slice(0, 2).join(' '));
    }
    const verified = await check(target);
    if (!verified || !verified.known || verified.w !== target.w || verified.h !== target.h || verified.density !== target.density) {
      throw new Error('修改后实际尺寸或 DPI 未达到定位表要求');
    }
    log(`显示设置恢复通过：${verified.w}×${verified.h}、${verified.density} DPI，继续本批次`, 'ok');
    return verified;
  } catch (error) {
    if (changed) {
      const size = await adb.shell(serial, 'wm size ' + restoreSize, { timeout: 5000 });
      const dpi = await adb.shell(serial, 'wm density ' + restoreDpi, { timeout: 5000 });
      error.message += size.ok && dpi.ok ? '；已恢复原显示设置' : '；恢复原显示设置失败，请检查模拟器显示设置';
    }
    throw error;
  }
}
module.exports = { targetOf, repair };
