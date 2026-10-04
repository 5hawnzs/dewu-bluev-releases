'use strict';
/* 取坐标/看屏幕：**机器算坐标**，不要靠眼睛在缩略图上估。
   ─────────────────────────────────────────────────────────────────────────
   为什么要有它（2026-10-04 用户问「为啥你有具体坐标老是会点偏」）：
   我以前的做法是截一张图、肉眼看它是哪一格、再乘一个「缩放倍数」算出设备坐标。
   这**必然**会偏，因为：① 图被显示端缩到多少像素我不知道，倍数是猜的；
   ② `uiautomator dump` 的 bounds 本来就是**设备像素**，`input tap` 也吃设备像素 ——
   这中间根本不需要任何换算，是我自己多插了一步。实测那次就按 1.8 倍把 y 算成 235（真值 423）。
   ⇒ 这个脚本把「找元素 → 给出设备像素中心」做成一条命令，**没有一步是猜的**。

   还会顺手把两件事打出来（这两个是坐标用错的真正来源）：
     · **当前点击坐标系**（`dumpsys window displays` 的 `init=` / `cur=`）——
       它跟着**前台应用的方向**走：得物（竖屏锁定）在前台是 1080x1920，MuMu 桌面是 1920x1080。
       同一台机器两种都出现过（实测）。
     · dump 里 bounds 的最大值 —— 它必须落在 `cur=` 之内；不一致就说明抓的不是同一屏。

   用法：
     node tools/where.js                       # 列出这一屏所有**可点**节点（带文字/描述）
     node tools/where.js 下一步                 # 按文字/描述/resource-id 子串找
     node tools/where.js 127.0.0.1:16384 下一步  # 指定设备
     node tools/where.js --all                 # 连不可点的节点也列（排查用）

   ★ 只读：这个脚本**不发任何点击**，只 dump + 打印。
*/
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const adb = require(path.join(ROOT, 'src/main/services/adb.js'));
const uimap = require(path.join(ROOT, 'src/main/services/uimap.js'));

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const rest = argv.filter(a => a !== '--all');
const looksSerial = s => /^[A-Za-z0-9_.\-]+:\d+$/.test(s) || /^emulator-\d+$/.test(s);
const serialArg = rest.length && looksSerial(rest[0]) ? rest.shift() : '';
const query = rest.join(' ').trim();

function cfgDevice() {
  const p = 'C:/Users/Administrator/AppData/Roaming/dewu-bluev-publisher/config.json';
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return String((j.publish && j.publish.device) || '').trim();
  } catch (e) { return ''; }
}

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const cut = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

(async () => {
  adb.setAdbPath('');
  adb.setBundledAdbDir(path.join(ROOT, 'vendor', 'adb'));

  let serial = serialArg || cfgDevice();
  if (!serial) {
    const list = await adb.devices();
    const online = (list || []).filter(d => d.state === 'device' || d.online);
    serial = (online[0] && online[0].serial) || (list[0] && list[0].serial) || '';
  }
  if (!serial) {
    console.error('没找到设备：先让模拟器跑起来（或把序列号当第一个参数传进来，例如 127.0.0.1:16384）');
    process.exitCode = 1; return;
  }
  console.log('设备      = ' + serial);

  // ① 当前点击坐标系（tap 与 dump bounds 共用的那个空间）
  const size = await adb.uiSize(serial);
  if (size.known) {
    console.log(`坐标系    = ${size.w}x${size.h}（${size.landscape ? '横屏' : '竖屏'}）`
      + (size.initW ? ` · 自然方向 ${size.initW}x${size.initH}${size.rotated ? ' ⇒ ★ 当前是转过的' : ''}` : ''));
  } else {
    console.log('坐标系    = ★ 读不到（dumpsys window displays 没给出 cur=）—— 越界判据会失效');
  }
  const focus = await adb.currentFocus(serial);
  console.log('前台      = ' + (focus || '（读不到）'));
  console.log('');

  // ② dump（带包名 ⇒ 动画页会退到 dumpsys 备用通道）
  const pkgMatch = String(focus || '').match(/^([a-zA-Z0-9_.]+)\//);
  const d = await adb.dumpEx(serial, { pkg: (pkgMatch && pkgMatch[1]) || uimap.DEWU.pkg, retries: 1 });
  if (!d.ok) {
    console.error('抓不到界面结构：' + d.why + (d.idle ? '（这个页面一直不 idle）' : ''));
    console.error('  先确认模拟器没锁屏；得物发布页首屏是动画页，正常会走 dumpsys 备用通道。');
    process.exitCode = 1; return;
  }
  if (d.via === 'dumpsys' || d.noText) {
    console.log('★ 这一屏是动画页，走的是 dumpsys 备用通道：**只有 id / 坐标、没有文字** ——');
    console.log('  按文字找的话在这里找不到，请改用 resource-id（下面列出的 id 可以直接用）。');
    console.log('');
  }
  const nodes = uimap.parseNodes(d.xml);
  const withBox = nodes.filter(n => n.box);

  // ③ 夹具自检：dump 的 bounds 必须落在坐标系里（不在 ⇒ 抓的不是同一屏，别拿它当坐标用）
  if (size.known && withBox.length) {
    const maxX = Math.max.apply(null, withBox.map(n => n.box.x2));
    const maxY = Math.max.apply(null, withBox.map(n => n.box.y2));
    const inside = maxX <= size.w && maxY <= size.h;
    console.log(`dump 边界 = x≤${maxX} y≤${maxY} ⇒ ${inside ? '落在坐标系内（一致）' : '★ 超出屏幕！两份数据不是同一屏，别用'}`);
    console.log('');
  }

  // ④ 找节点
  let hit;
  if (query) {
    const q = query.toLowerCase();
    hit = nodes.filter(n => n.box && (
      String(n.text).toLowerCase().includes(q)
      || String(n.desc).toLowerCase().includes(q)
      || String(n.id).toLowerCase().includes(q)));
  } else {
    hit = nodes.filter(n => n.box && (showAll || n.clickable || n.text || n.desc));
  }

  if (!hit.length) {
    console.log('没找到匹配「' + query + '」的节点。这一屏上的文字有：');
    console.log('  ' + (nodes.filter(n => n.text).slice(0, 30).map(n => n.text).join(' / ') || '（空）'));
    process.exitCode = 1; return;
  }

  console.log(`命中 ${hit.length} 个节点（坐标是**设备像素**，直接就是 input tap 要的值）：`);
  console.log(pad('#', 4) + pad('中心(x,y)', 14) + pad('bounds', 30) + pad('可点', 6) + pad('可用', 6) + '文字 / 描述 / id');
  console.log('-'.repeat(120));
  hit.slice(0, 40).forEach((n, i) => {
    const oob = size.known && (n.center.x > size.w - 1 || n.center.y > size.h - 1);
    console.log(pad(i + 1, 4)
      + pad(n.center.x + ',' + n.center.y + (oob ? ' ★越界' : ''), 14)
      + pad(cut(n.bounds, 29), 30)
      + pad(n.clickable ? '是' : '否', 6)
      + pad(n.enabled === false ? '禁用' : '是', 6)
      + cut([n.text, n.desc, n.id].filter(Boolean).join(' | '), 60));
  });
  if (hit.length > 40) console.log(`… 还有 ${hit.length - 40} 个，用更具体的词再找一次`);
  console.log('');
  console.log('★ 要把它写进定位表就用上面那个「中心」：{"action":"tapXY","value":"' + hit[0].center.x + ',' + hit[0].center.y + '"}');
  console.log('  （写死坐标的前提是版式固定；动态内容请用 tapId / tapText 让它当场去 dump 里找）');
})().catch(e => { console.error('WHERE ERROR', e); process.exitCode = 2; });
