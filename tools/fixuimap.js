'use strict';
/**
 * ★ 幂等的「定位表一键修正」脚本（可反复重跑，结果一致）。
 *
 * 用法：node tools/fixuimap.js
 *   （App 未运行时执行最稳；若 App 在跑，改完请立刻重启 App，否则可能被内存旧值回写覆盖。）
 *
 * 为什么需要它：config.json 会被运行中的 App / 脚本用内存里的旧值**回写覆盖**
 *   （store.set → 250ms 防抖整份写回），历史上多次把已改好的 uiMap 又刷回旧版
 *   （实测：删掉的「切 bluev 相册」两步会复活、好物会退回「只输货号」）。
 *   ⇒ 不再依赖「历史叠加改了多少次」，而是把**目标态规则**写死在这里：跑一次即得到正确配置。
 *
 * 目标态（与用户指令一一对应）：
 *   ① 入口三步幂等可重入（我 / 主页 带 whenNotOn:rlPublish 守卫；主页后加一步幂等补点）
 *      —— 修 seq12「上一条发完停在个人主页 ⇒ 下一条入口点空」。
 *   ② **不切 bluev 相册**：删掉「点开相册选择器」+「选中本工具专属相册」两步
 *      —— 用户原话「删除完所有其他不相关的素材后，不要 bluev 了」。
 *   ③ 好物搜索**输「货号+颜色」（无空格）**，然后**选结果第 1 格**
 *      —— 用户原话「好物搜索框，需要输入货号+颜色」「货号颜色，不要有空格」。
 */
const fs = require('fs');
const path = require('path');

const APP = 'C:\\Users\\Administrator\\AppData\\Roaming\\dewu-bluev-publisher';
const CFG = path.join(APP, 'config.json');
const DEWU = 'com.shizhuang.duapp';
const RLP = DEWU + ':id/rlPublish';
const GO = DEWU + ':id/tvGoHomePage';

const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const um = j.publish && j.publish.uiMap;
if (!um) { console.error('没有 uiMap'); process.exit(1); }

const bak = CFG + '.bak-before-fixall-' + Date.now();
fs.copyFileSync(CFG, bak);
console.log('备份:', path.basename(bak));

// ① 删掉「切 bluev 相册」两步（按名字，不依赖位置）
const DROP = /点开相册选择器|选中本工具专属相册/;
// ③ 好物：输「货号+颜色」
const GOODS_INPUT = /^好物(\d) · 输「货号/;
// ③ 好物：删掉「按颜色选那一格」（颜色已进搜索框）
const GOODS_BYCOLOR = /^好物\d · (选「\$\{goods\dColor\}」那一格|按「颜色」选对那一格)/;
// ③ 好物：退路步改名 + 去 whenNot → 「选结果第 1 格」

let log = [];
for (const key of ['steps', 'videoSteps']) {
  const before = (um[key] || []).length;
  const out = [];
  for (const s of (um[key] || [])) {
    const n = String(s.name || '');
    if (DROP.test(n)) { log.push(`删「${n}」`); continue; }
    if (GOODS_BYCOLOR.test(n)) { log.push(`删「${n}」`); continue; }
    const m = GOODS_INPUT.exec(n);
    if (m) {
      s.name = `好物${m[1]} · 输「货号+颜色」`;
      s.value = `\${goods${m[1]}Sku}\${goods${m[1]}Color}`;
      s.when = `goods${m[1]}Sku`;
      delete s.whenNot;
      out.push(s); continue;
    }
    const g2 = /^好物(\d) · 没填颜色就选第 1 格$/.exec(n);
    if (g2) {
      s.name = `好物${g2[1]} · 选结果第 1 格`;
      delete s.whenNot;
      out.push(s); continue;
    }
    out.push(s);
  }
  um[key] = out;

  // ① 入口守卫 + 幂等补点（先清掉历史遗留的守卫/补点，再按位置重建，保证幂等）
  const arr = um[key];
  // 移除已有的补点步（防止重跑时叠加）
  for (let i = arr.length - 1; i >= 0; i--) {
    if (/右上角「主页」· 补点/.test(arr[i].name || '')) arr.splice(i, 1);
  }
  const iMe = arr.findIndex(s => /底部「我」/.test(s.name || ''));
  const iGo = arr.findIndex(s => /右上角「主页」/.test(s.name || ''));
  if (iMe >= 0) arr[iMe].whenNotOn = RLP;
  if (iGo >= 0) {
    arr[iGo].whenNotOn = RLP;
    arr[iGo].name = '右上角「主页」（已在主页 tab 则跳过）';
    arr.splice(iGo + 1, 0, {
      name: '右上角「主页」· 补点（上一步没跳走才点，幂等）',
      action: 'tapId',
      value: GO,
      whenOn: GO
    });
  }
  console.log(`${key}: ${before} → ${arr.length} 步`);
}

fs.writeFileSync(CFG, JSON.stringify(j, null, 2), 'utf8');
console.log('改动', log.length, '处；已写回 config.json');
log.slice(0, 12).forEach(x => console.log('  -', x));
