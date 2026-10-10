'use strict';
const adb = require('./adb');
const uimap = require('./uimap');
const SYSTEM_PACKAGES = new Set(['com.android.permissioncontroller', 'com.google.android.permissioncontroller', 'com.android.packageinstaller', 'com.google.android.packageinstaller']);

function allowButton(xml) {
  const nodes = uimap.parseNodes(xml || '');
  const system = nodes.filter(n => SYSTEM_PACKAGES.has(n.pkg));
  const prompt = system.map(n => n.text).join(' ');
  // 必须是系统替得物申请媒体访问；不接管其他应用、相机、麦克风或定位权限。
  if (!/得物|\bdewu\b/i.test(prompt) || !/访问|access/i.test(prompt)
    || !/照片|视频|存储|媒体|photos|videos|storage/i.test(prompt)) return null;
  return system.find(n => n.enabled && n.clickable && n.box
    && /:id\/permission_allow_(?:all_)?button$/.test(n.id)
    && /^(全部允许|允许|Allow all|Allow)$/i.test(n.text.trim())) || null;
}

async function dump(serial, options, ctx = {}) {
  let result = await adb.dumpEx(serial, options);
  // 无弹窗时直接返回现有抓屏结果，不新增 ADB 调用或等待。
  for (let attempt = 0; result.ok && attempt < 2; attempt++) {
    const button = allowButton(result.xml);
    if (!button) return result;
    if (ctx.cancelled && ctx.cancelled()) throw Error('任务已取消');
    const tapped = await adb.tap(serial, button.center.x, button.center.y);
    if (!tapped.ok) throw Error('得物照片和视频权限授权失败：' + (tapped.stderr || tapped.stdout || '点击失败'));
    if (ctx.log) ctx.log('已允许得物访问照片和视频', 'info');
    await new Promise(resolve => setTimeout(resolve, 250));
    result = await adb.dumpEx(serial, options);
  }
  if (result.ok && allowButton(result.xml)) throw Error('得物照片和视频授权窗口仍未关闭，请检查设备权限');
  return result;
}
module.exports = { allowButton, dump };
