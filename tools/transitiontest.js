'use strict';
/**
 * 转场模块（src/main/services/transition.js）与加固模块（src/main/services/uimapshape.js）的回归。
 *
 * 为什么单独有一份、不并进 adbtest：
 *   · 这两个模块的依赖是**注入**的（deps.dump / deps.tap / deps.parse / deps.sleep），
 *     所以判据本身**不接设备、不需要 electron** 就能验完；
 *   · 它们要守的是「同一类转场只有一套做法」这条结构结论（架构审查候选 1 / 候选 3），
 *     埋进那一大堆假设备用例里，坏了也看不出是哪条判据塌的。
 *
 * 守四件事：
 *   ① 转场判据：已在目标屏 ⇒ **一个像素都不点**；恰一颗「下一步」才点；同坐标的两层节点
 *      （flNextStep 容器 + tvNextStep 文字）去重成一颗；**点击后这一屏没变 ⇒ 绝不点第二下**；
 *      不在允许的屏幕组里、或没有唯一的「下一步」⇒ 不点，等到超时如实报错。
 *   ② 图文与视频两条转场走的是**同一个** module（视频那条要连点两跳＝实证）。
 *   ③ harden() 幂等；并且会摘掉旧式盲点**连它后面那条「补等待」**——
 *      这条曾经漏删过（判据看错了列表的尾巴），所以必须有用例盯住它。
 *   ④ 三条路（出厂内置表 / 界面抓表 suggest / 用户导入）拿到的加固步骤**形状逐字节一致**。
 */
const transition = require('../src/main/services/transition');
const shape = require('../src/main/services/uimapshape');
const uimap = require('../src/main/services/uimap');

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
};

const D = 'com.shizhuang.duapp:id/';
const NEXT_FL = D + 'flNextStep', NEXT_TV = D + 'tvNextStep';
const node = (id, bounds, text = '') =>
  `<node resource-id="${id}" text="${text}" clickable="true" enabled="true" bounds="${bounds}" />`;

// 真机实测的形状（2026-10-04 / MuMu 12 / 1080x1920）：
//   相册页那颗「下一步」在 dump 里是**两个节点**（容器 flNextStep + 文字 tvNextStep），
//   两者 bounds 完全相同 ⇒ 按中心点去重后必须只剩一颗。
const xAlbum = '<hierarchy>' + node(D + 'flThumbSelect', '[122,315][210,403]')
  + node(NEXT_FL, '[891,1794][1080,1892]') + node(NEXT_TV, '[891,1794][1080,1892]', '下一步') + '</hierarchy>';
const xEditor = '<hierarchy>' + node(D + 'edit_panel', '[0,0][1080,1920]')
  + node(NEXT_FL, '[891,1794][1080,1892]') + node(NEXT_TV, '[891,1794][1080,1892]', '下一步') + '</hierarchy>';
const xClip = '<hierarchy>' + node(D + 'editVideoView', '[0,0][1080,1600]')
  + node(NEXT_FL, '[891,1794][1080,1892]') + node(NEXT_TV, '[891,1794][1080,1892]', '下一步') + '</hierarchy>';
const xForm = '<hierarchy>' + node(D + 'etTitle', '[100,300][900,380]')
  + node(D + 'tvPublish', '[900,1800][1060,1880]', '发布') + '</hierarchy>';
const xCover = '<hierarchy>' + node(D + 'tv_skip', '[820,1857][980,1895]', '跳过')
  + node(D + 'tvCover', '[100,120][500,180]', '设置封面') + '</hierarchy>';
// 同一屏上出现**两颗不同位置**的「下一步」＝版式变了 ⇒ 宁可不点（点错就是误发）
const xAmbiguous = '<hierarchy>' + node(D + 'flThumbSelect', '[122,315][210,403]')
  + node(NEXT_FL, '[891,1794][1080,1892]') + node(NEXT_FL, '[400,1000][600,1100]') + '</hierarchy>';
// 陌生屏：不在任何允许的屏幕组里，但屏上确实有一颗「下一步」⇒ 也必须不点
const xStranger = '<hierarchy>' + node(D + 'someOtherScreen', '[0,0][1080,1920]')
  + node(NEXT_FL, '[891,1794][1080,1892]') + '</hierarchy>';

/** 假设备：screens 按**每轮抓屏**的顺序取，最后一屏会一直重复（模拟卡住） */
function harness(screens, opts = {}) {
  let i = 0;
  const taps = [];
  return {
    taps,
    polls: () => i,
    deps: {
      dump: async () => {
        const s = screens[Math.min(i, screens.length - 1)];
        i++;
        if (typeof s === 'string') return { ok: true, xml: s, why: '' };
        return Object.assign({ ok: false, why: opts.dumpWhy || '抓屏失败' }, s);
      },
      tap: async (serial, x, y) => {
        taps.push(x + ',' + y);
        return opts.tapOk === false ? { ok: false, stderr: 'error: device offline' } : { ok: true };
      },
      sleep: async () => {},
    },
  };
}

async function play(screens, spec, opts = {}) {
  const h = harness(screens, opts);
  let result = null, error = null;
  try { result = await transition.run('FAKE', spec, { log: () => {} }, h.deps); }
  catch (e) { error = e; }
  return { result, error, taps: h.taps, polls: h.polls() };
}

/** 把一份表加固后的步骤名串起来，便于断言顺序 */
const namesOf = steps => steps.map(s => String(s.name || s.action)).join(' → ');

(async () => {
  console.log('转场模块 + 加固模块 —— 不接设备，判据直接用注入的假设备喂进去\n');

  /* ---------- ① 图文转场：判据本身 ---------- */
  {
    const spec = shape.imageTransition();
    ok('① spec 形状：until 指向标题输入框，from 是相册或图片编辑页',
      spec.until === D + 'etTitle' && spec.from.length === 2
      && spec.from.includes(D + 'flThumbSelect') && spec.from.includes(D + 'edit_panel'),
      JSON.stringify({ until: spec.until, from: spec.from }));

    const at = await play([xForm], spec);
    ok('① 已经在标题页 ⇒ 立刻过，一个像素都不点', at.result && at.result.clicks === 0 && at.taps.length === 0,
      JSON.stringify({ clicks: at.result && at.result.clicks, taps: at.taps }));

    // 坐标由这条按钮自己的 bounds 算出来：**[891,1794][1080,1892] 的中心 = (986,1843)**。
    // ★ 注意别和文档里那个「985,1843」搞混 —— 那是**旧盲点写死的坐标**（真机量出来的近似值）；
    //   现在不再用写死坐标，而是按当前这屏实际那颗按钮的中心点。两个值差 1 个像素，属正常。
    const one = await play([xAlbum, xForm], spec);
    ok('① 相册页那颗「下一步」是两层同坐标节点 ⇒ 去重后只点一次（按钮中心 986,1843）',
      one.result && one.result.clicks === 1 && one.taps.length === 1 && one.taps[0] === '986,1843',
      JSON.stringify(one.taps));

    const editor = await play([xEditor, xForm], spec);
    ok('① 多图会先落在图片编辑页 ⇒ 从那一屏再点一次才到标题页',
      editor.result && editor.result.clicks === 1 && editor.taps.length === 1, JSON.stringify(editor.taps));

    // ★★ 这条是真机上最贵的一课：点击之后这一屏**还没渲染完**时，同一个坐标底下
    //    可能已经是新屏的别的按钮（编辑页右下角是「下一步」，标题页右下角是「发布」）⇒ 连点＝误发。
    const slow = await play([xAlbum, xAlbum, xAlbum, xAlbum, xForm], spec);
    ok('① 点击后这一屏连着三轮没变 ⇒ 绝不点第二下，等它自己换过去再继续',
      slow.result && slow.result.clicks === 1 && slow.taps.length === 1 && slow.polls >= 5,
      JSON.stringify({ clicks: slow.result && slow.result.clicks, taps: slow.taps.length, polls: slow.polls }));

    const stuck = await play([xAlbum], Object.assign({}, spec, { timeout: 30 }));
    ok('① 这一屏始终没变 ⇒ 只点一次就如实报「转场未确认」，不点第二下',
      stuck.error && stuck.error.code === 'PUBLISH_TRANSITION_UNCONFIRMED' && stuck.taps.length === 1
      && /已点击下一步 1 次/.test(stuck.error.message),
      stuck.error ? stuck.error.message.slice(0, 90) : '（居然没报错）');

    const amb = await play([xAmbiguous], Object.assign({}, spec, { timeout: 30 }));
    ok('① 同一屏两颗不同位置的「下一步」⇒ 一颗都不点（点了就是拿猜的当判据）',
      amb.error && amb.error.code === 'PUBLISH_TRANSITION_UNCONFIRMED' && amb.taps.length === 0
      && /没有唯一可点的/.test(amb.error.message),
      amb.error ? amb.error.message.slice(0, 90) : '（居然没报错）');

    const stranger = await play([xStranger], Object.assign({}, spec, { timeout: 30 }));
    ok('① 已经跑到陌生屏（不在 from 里）⇒ 也不点，如实说是「不在允许的屏幕」',
      stranger.error && stranger.error.code === 'PUBLISH_TRANSITION_UNCONFIRMED' && stranger.taps.length === 0
      && /已不在允许的屏幕/.test(stranger.error.message),
      stranger.error ? stranger.error.message.slice(0, 90) : '（居然没报错）');

    const noTitle = await play([xAlbum, xEditor, xEditor], Object.assign({}, spec, { timeout: 30 }));
    ok('① 点满了仍然没确认 ⇒ 报错里说清点过几次、当前可见内容是什么（不是一句「失败了」）',
      noTitle.error && noTitle.error.code === 'PUBLISH_TRANSITION_UNCONFIRMED'
      && noTitle.taps.length === 2 && /当前可见内容/.test(noTitle.error.message)
      && /未填写、未提交/.test(noTitle.error.message),
      noTitle.error ? noTitle.error.message.slice(0, 110) : '（居然没报错）');

    const nope = await play([xAlbum], spec, { tapOk: false });
    ok('① 点击回执没确认（设备掉线那种）⇒ 当场报错、不重复点', nope.error
      && nope.error.code === 'PUBLISH_TRANSITION_UNCONFIRMED' && nope.taps.length === 1
      && /device offline/.test(nope.error.message),
      nope.error ? nope.error.message.slice(0, 90) : '（居然没报错）');

    const blind = await play([{ ok: false }], Object.assign({}, spec, { timeout: 30 }), { dumpWhy: '这一屏读不到' });
    ok('① 抓不到界面结构 ⇒ 不点、如实报错（读不到 ≠ 知道自己在哪一屏）',
      blind.error && blind.taps.length === 0,
      blind.error ? blind.error.message.slice(0, 90) : '（居然没报错）');
  }

  /* ---------- ② 视频转场：同一个 module，连点两跳 ---------- */
  {
    const spec = shape.videoTransition();
    ok('② spec 形状：until 是封面页的精确文字「设置封面」', spec.until === '设置封面', JSON.stringify(spec.until));

    const two = await play([xAlbum, xClip, xCover], spec);
    ok('② 相册 → 剪辑页 → 设置封面页：两跳都由同一个 module 完成（原来靠两条固定 wait）',
      two.result && two.result.clicks === 2 && two.taps.length === 2 && two.taps.every(t => t === '986,1843'),
      JSON.stringify(two.taps));

    const atCover = await play([xCover], spec);
    ok('② 已经在封面页 ⇒ 一个像素都不点', atCover.result && atCover.result.clicks === 0 && atCover.taps.length === 0);

    const slowClip = await play([xAlbum, xClip, xClip, xClip, xCover], spec);
    ok('② 剪辑页点完之后没换屏 ⇒ 不点第三下（maxClicks 是上限，不是计划）',
      slowClip.result && slowClip.result.clicks === 2 && slowClip.taps.length === 2,
      JSON.stringify({ clicks: slowClip.result && slowClip.result.clicks, taps: slowClip.taps.length }));
  }

  /* ---------- ③ harden：摘掉旧式盲点 + 它后面那条「补等待」 ---------- */
  {
    const oldImage = {
      package: 'com.shizhuang.duapp',
      steps: [
        { name: '选中要发的图（前 N 张，N＝这个叶子的图片数）', action: 'tapId', value: D + 'flThumbSelect', count: '${imageCount}' },
        { name: '下一步', action: 'tapXY', value: '985,1843' },
        { name: '图片编辑页 · 下一步（选多张图才会出现这一屏）', action: 'tapXY', value: '985,1843', whenOn: D + 'edit_panel' },
        { name: '等结果出来', action: 'wait', value: 800 },
        { name: '点标题输入框', action: 'tapId', value: D + 'etTitle' },
        { name: '填标题', action: 'input', value: '${title}' },
      ],
      videoSteps: [],
    };
    const a = shape.harden(oldImage);
    ok('③ 旧表的两个盲点都被摘掉，换成一条转场步骤',
      a.removed.length === 2 && a.added.length === 1 && a.map.steps.filter(s => s.action === 'transition').length === 1,
      JSON.stringify({ removed: a.removed }));
    // ★ 插入点必须是**选素材那一步之后**：排到「点标题输入框」后面，框还没出现就去点它，等于白点一轮。
    ok('③ 转场插在「选中要发的图」紧后面，不是排在点标题输入框之后',
      namesOf(a.map.steps) === '选中要发的图（前 N 张，N＝这个叶子的图片数） → 选图后的转场 · 等到标题填写页 → 等结果出来 → 点标题输入框 → 填标题',
      namesOf(a.map.steps));
    ok('③ 名字里不带「等下一屏 / 转场」的 wait 不许被误删（判据不能宽成「所有 wait」）',
      a.map.steps.some(s => s.action === 'wait' && s.name === '等结果出来'), namesOf(a.map.steps));

    const oldVideo = {
      package: 'com.shizhuang.duapp',
      steps: [
        { name: '选中要发的图', action: 'tapId', value: D + 'flThumbSelect' },
        { name: '填标题', action: 'input', value: '${title}' },
      ],
      videoSteps: [
        { name: '选中要发的视频（相册第 1 格）', action: 'tapXY', value: '166,359' },
        { name: '下一步（离开相册）', action: 'tapXY', value: '985,1843' },
        { name: '等下一屏（转场，盲点没有抓屏 ⇒ 只能固定等）', action: 'wait', value: 1200 },
        { name: '剪辑页 · 下一步', action: 'tapXY', value: '985,1843' },
        { name: '等下一屏（转场，盲点没有抓屏 ⇒ 只能固定等）', action: 'wait', value: 1200 },
        { name: '点标题输入框', action: 'tapId', value: D + 'etTitle' },
        { name: '填标题', action: 'input', value: '${title}' },
      ],
    };
    const b = shape.harden(oldVideo);
    // ★★ 这条就是「补等待漏删」的反证用例：盲点先被摘掉之后，如果拿**已保留列表的尾巴**
    //    去判「前一步是不是盲点」，这两条 wait 会**留在表里**（而盲点已经不在了）。
    ok('③ 视频那四步（盲点+补等待+盲点+补等待）整段换成一条转场，两条补等待都跟着走',
      b.removed.length === 4 && b.map.videoSteps.filter(s => s.action === 'transition').length === 1
      && b.map.videoSteps.filter(s => s.action === 'wait').length === 0,
      JSON.stringify({ removed: b.removed }));
    ok('③ 视频转场也插在「选中要发的视频」紧后面',
      namesOf(b.map.videoSteps) === '选中要发的视频（相册第 1 格） → 选视频后的转场 · 等到设置封面页 → 点标题输入框 → 填标题',
      namesOf(b.map.videoSteps));
    ok('③ 图文那份也没被顺手改坏（同一函数处理两条链，各管各的）',
      b.map.steps.filter(s => s.action === 'transition').length === 1
      && b.map.steps[1].action === 'transition');

    const again = shape.harden(a.map);
    ok('③ 幂等：对已加固的表再跑一次，一个字节都不变、added/removed 都是空的',
      JSON.stringify(again.map) === JSON.stringify(a.map) && again.added.length === 0 && again.removed.length === 0,
      JSON.stringify({ added: again.added, removed: again.removed }));
    const third = shape.harden(again.map);
    ok('③ 再跑第三次仍然一模一样（不会慢慢堆出一串转场步骤）',
      JSON.stringify(third.map) === JSON.stringify(a.map)
      && third.map.steps.filter(s => s.action === 'transition').length === 1);

    const noInput = shape.harden({ steps: [{ name: '选中要发的图', action: 'tapId', value: D + 'flThumbSelect' }] });
    ok('③ 表里没有输入步 ⇒ 一个字都不动（不是一份能用的表，不许瞎补）',
      noInput.added.length === 0 && noInput.removed.length === 0 && noInput.map.steps.length === 1);
    const noSelect = shape.harden({ steps: [{ name: '随便一步一步', action: 'tapId', value: 'x/y' }, { name: '填标题', action: 'input', value: '${title}' }] });
    ok('③ 找不到「选素材」那一步 ⇒ 也不动（没有可靠的插入点）',
      noSelect.added.length === 0 && noSelect.map.steps.length === 2);
  }

  /* ---------- ④ 三条路同一个形状 ---------- */
  {
    const shapeOf = s => JSON.stringify({ action: s.action, until: s.until, from: s.from, maxClicks: s.maxClicks, timeout: s.timeout });
    const builtin = require('../src/main/uimapdefaults.js');
    const hardenedBuiltin = shape.harden({ steps: builtin.steps, videoSteps: builtin.videoSteps });
    const sug = uimap.suggest([], 'com.shizhuang.duapp');

    const pick = (steps, action) => (steps || []).find(s => s.action === action);
    const bi = pick(hardenedBuiltin.map.steps, 'transition');
    const si = pick(sug.steps, 'transition');
    ok('④ 出厂内置表加固后得到的转场 = 界面抓表得到的转场（形状逐字节一致）',
      !!bi && !!si && shapeOf(bi) === shapeOf(si), JSON.stringify({ builtin: bi && shapeOf(bi), suggest: si && shapeOf(si) }));
    const bv = pick(hardenedBuiltin.map.videoSteps, 'transition');
    const sv = pick(sug.videoSteps, 'transition');
    ok('④ 视频那条同理（否则用户重抓一次表就把修复换回旧行为）',
      !!bv && !!sv && shapeOf(bv) === shapeOf(sv), JSON.stringify({ builtin: bv && shapeOf(bv), suggest: sv && shapeOf(sv) }));

    const siIdx = sug.steps.findIndex(s => s.action === 'transition');
    const svIdx = sug.videoSteps.findIndex(s => s.action === 'transition');
    ok('④ 抓表产出的转场也紧跟在「选素材」那一步后面（不是插到第一条 input 之前）',
      siIdx > 0 && /选图|选中要发/.test(String(sug.steps[siIdx - 1].name || ''))
      && svIdx > 0 && /选中要发/.test(String(sug.videoSteps[svIdx - 1].name || '')),
      JSON.stringify({ 图文前一步: sug.steps[siIdx - 1] && sug.steps[siIdx - 1].name, 视频前一步: sug.videoSteps[svIdx - 1] && sug.videoSteps[svIdx - 1].name }));

    // 内置表和导入旧表在 publisher.run 的真实执行入口加固；行为验证见 publish-transitiontest.js。
    console.log('      （生产执行入口现已统一加固，图文/视频按实际内容类型确认目标页）');
  }

  console.log('');
  console.log(process.exitCode ? '有 FAIL' : '全部通过');
})().catch(e => { console.log('FAIL  用例抛异常（不许抛）：' + (e && e.stack || e)); process.exitCode = 1; });

