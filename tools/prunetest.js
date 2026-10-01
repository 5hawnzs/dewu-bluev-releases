'use strict';
/*
 * 老包清理工具（tools/prune-release.js）纯逻辑回归 —— 纯 Node，不联网、不碰 COS。
 *
 * ★ 为什么这套必须存在：这是**仓库里唯一会删东西**的工具，而且删的是源上大概 88 MB 的
 *   安装包 —— 删错了没法恢复（桶上没有版本控制的话）。所以判定逻辑必须钉死：
 *     · 读错版本号 ⇒ 删错包（`1.0.1-x64-win.exe` 里那个 `x64` 本身就是个合法的 semver 预发布段）
 *     · 源上状态不明（读不到 latest.yml）⇒ 必须**一个字节都不删**（fail-closed）
 *     · 比当前版本还新的包 ⇒ 必须留（多半是「包传上去了、清单没传成」）
 *     · 认不出的对象 ⇒ 必须留
 *
 * 用法：node tools/prunetest.js
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { artifactVersion, sortVersions, planPrune, assertNeverRemovesCurrent, sumSize } = require(path.join(ROOT, 'tools/prune-release.js'));

let bad = 0;
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) bad++;
};

const S = '得物蓝V素材发布工具';
const exe = v => `${S}-${v}-x64-win.exe`;
const bm = v => `${S}-${v}-x64-win.exe.blockmap`;
const keys = list => list.map(x => x.key).sort();
const findKey = (plan, k) => plan.keep.find(x => x.key === k);

console.log('A. artifactVersion —— 读错版本号就是删错包\n');

ok('普通正式版：抠出 1.0.1', JSON.stringify(artifactVersion(exe('1.0.1'))) === JSON.stringify({ version: '1.0.1', pre: false }), JSON.stringify(artifactVersion(exe('1.0.1'))));
ok('★ 陷阱：`1.0.1-x64-win.exe` 的版本必须是 1.0.1，**不是** 1.0.1-x64（x64 本身是合法预发布段）',
  artifactVersion(exe('1.0.1')).version === '1.0.1', artifactVersion(exe('1.0.1')).version);
ok('预发布版：1.0.1-beta.2（带 . 分段）', JSON.stringify(artifactVersion(exe('1.0.1-beta.2'))) === JSON.stringify({ version: '1.0.1-beta.2', pre: true }), JSON.stringify(artifactVersion(exe('1.0.1-beta.2'))));
ok('.blockmap 同样能抠出版本（它和 exe 同一个版本，必须一起处理）',
  artifactVersion(bm('1.0.1-beta.2')).version === '1.0.1-beta.2', JSON.stringify(artifactVersion(bm('1.0.1-beta.2'))));
ok('清单文件 latest.yml / beta.yml 认不出（⇒ 会被保留，永远不删）',
  artifactVersion('latest.yml') === null && artifactVersion('beta.yml') === null,
  JSON.stringify([artifactVersion('latest.yml'), artifactVersion('beta.yml')]));
ok('便携版 exe 认不出（产物名里没有 -win.exe）⇒ 保留，不当作常规产物删',
  artifactVersion(`${S}-1.0.1-x64-便携版.exe`) === null, JSON.stringify(artifactVersion(`${S}-1.0.1-x64-便携版.exe`)));
ok('不认识的 exe / 非 exe 一律认不出 ⇒ 保留', artifactVersion('setup.exe') === null && artifactVersion('notes.txt') === null && artifactVersion('app-1.0.1-x64-win.zip') === null,
  JSON.stringify([artifactVersion('setup.exe'), artifactVersion('notes.txt'), artifactVersion('app-1.0.1-x64-win.zip')]));
ok('同形状的第三方产物照样认出版本（判定只看形状，不看名字对不对）',
  (artifactVersion('my-tool-2.0.0-x64-win.exe') || {}).version === '2.0.0', JSON.stringify(artifactVersion('my-tool-2.0.0-x64-win.exe')));
ok('带目录前缀的 key 也能处理（桶里可能有人在控制台建过文件夹）',
  JSON.stringify(artifactVersion('archive/' + exe('1.0.0'))) === JSON.stringify({ version: '1.0.0', pre: false }), JSON.stringify(artifactVersion('archive/' + exe('1.0.0'))));
ok('其它架构同样认（arm64 / ia32）', artifactVersion(`${S}-1.0.1-arm64-win.exe`).version === '1.0.1' && artifactVersion(`${S}-1.0.1-ia32-win.exe`).version === '1.0.1');
ok('空值 / undefined 不抛异常', artifactVersion('') === null && artifactVersion(null) === null && artifactVersion(undefined) === null);
ok('两段版本号（1.0）认不出 ⇒ 保留（不硬凑成 1.0.0）', artifactVersion(`${S}-1.0-x64-win.exe`) === null, JSON.stringify(artifactVersion(`${S}-1.0-x64-win.exe`)));

console.log('\nB. sortVersions —— 版本比较别按字符串\n');
ok('降序：1.0.10 > 1.0.9 > 1.0.1', JSON.stringify(sortVersions(['1.0.1', '1.0.10', '1.0.9'])) === JSON.stringify(['1.0.10', '1.0.9', '1.0.1']), JSON.stringify(sortVersions(['1.0.1', '1.0.10', '1.0.9'])));
ok('正式版排在预发布版前面（1.0.1 > 1.0.1-beta.2）', JSON.stringify(sortVersions(['1.0.1-beta.2', '1.0.1'])) === JSON.stringify(['1.0.1', '1.0.1-beta.2']));

console.log('\nC. planPrune —— 保留策略（真实桶内容 + 一个更老的包）\n');

// 真实桶（实测 2026-10-02 的 12 个对象）再加两个「本该被清掉」的老包
const BUCKET = [
  { key: 'stable/', size: 0 },
  { key: 'beta/', size: 0 },
  { key: exe('1.0.0'), size: 89151294 },
  { key: bm('1.0.0'), size: 93520 },
  { key: exe('1.0.1'), size: 92229456 },
  { key: bm('1.0.1'), size: 96000 },
  { key: exe('1.0.1-beta.1'), size: 89000000 },
  { key: bm('1.0.1-beta.1'), size: 93000 },
  { key: exe('1.0.1-beta.2'), size: 89150000 },
  { key: bm('1.0.1-beta.2'), size: 93200 },
  { key: 'latest.yml', size: 388 },
  { key: 'beta.yml', size: 390 },
  { key: exe('0.9.0'), size: 80000000 },        // 更老的正式版 ⇒ 该清
  { key: exe('1.0.1-beta.0'), size: 88000000 }  // 更老的测试版 ⇒ 该清
];

{
  const plan = planPrune(BUCKET, { stableVersion: '1.0.1', betaVersion: '1.0.1-beta.2', keepPerChannel: 1 });
  const kept = keys(plan.keep), rem = keys(plan.remove);

  ok('当前正式版 1.0.1 被保留', kept.includes(exe('1.0.1')) && kept.includes(bm('1.0.1')));
  ok('当前测试版 1.0.1-beta.2 被保留（两条通道互不影响）',
    kept.includes(exe('1.0.1-beta.2')) && kept.includes(bm('1.0.1-beta.2')));
  ok('正式通道的回滚目标 1.0.0 被保留（这是「能回退」的唯一依据）',
    kept.includes(exe('1.0.0')) && kept.includes(bm('1.0.0')), kept.includes(exe('1.0.0')));
  ok('测试通道的回滚目标 1.0.1-beta.1 被保留', kept.includes(exe('1.0.1-beta.1')));
  ok('清单文件永远保留', kept.includes('latest.yml') && kept.includes('beta.yml'));
  ok('0 字节的 stable/ beta/ 占位对象保留（不是我们造的，不碰）', kept.includes('stable/') && kept.includes('beta/'));
  ok('★ 只清掉两个真正被淘汰的：0.9.0 与 1.0.1-beta.0',
    JSON.stringify(rem) === JSON.stringify([exe('0.9.0'), exe('1.0.1-beta.0')].sort()), JSON.stringify(rem));
  ok('保留理由写清楚了「为什么留」（不是黑箱）',
    /当前正式版/.test(findKey(plan, exe('1.0.1')).why) && /回滚目标/.test(findKey(plan, exe('1.0.0')).why),
    findKey(plan, exe('1.0.0')).why);
  ok('删除理由也写清楚了', /已被淘汰/.test(plan.remove.find(r => r.key === exe('0.9.0')).why));
  ok('腾出的体积算得出来', sumSize(plan.remove) === 80000000 + 88000000, sumSize(plan.remove));
  ok('★ 绝不会把「当前版本」放进删除名单（最后一道闸）', assertNeverRemovesCurrent(plan).ok === true);
}

{
  const plan = planPrune(BUCKET, { stableVersion: '1.0.1', betaVersion: '1.0.1-beta.2', keepPerChannel: 0 });
  const rem = keys(plan.remove);
  ok('--keep-more=0：连回滚目标也清（1.0.0 / 1.0.1-beta.1 都进删除名单）',
    rem.includes(exe('1.0.0')) && rem.includes(exe('1.0.1-beta.1')), JSON.stringify(rem));
  ok('但当前的两个版本仍然一个都不在删除名单里',
    !rem.includes(exe('1.0.1')) && !rem.includes(exe('1.0.1-beta.2')), JSON.stringify(rem));
  ok('清单仍然保留', keys(plan.keep).includes('latest.yml'));
}

{
  const plan = planPrune(BUCKET, { stableVersion: '1.0.1', betaVersion: '1.0.1-beta.2', keepPerChannel: 3 });
  ok('--keep-more=3：桶里所有版本都留（不够那么多档就不清）', plan.remove.length === 0, JSON.stringify(keys(plan.remove)));
}

console.log('\nD. ★★ 三条 fail-closed 闸门（源上状态不明时不许删）\n');

{
  const plan = planPrune(BUCKET, { stableVersion: '', betaVersion: '1.0.1-beta.2', keepPerChannel: 1 });
  ok('★ 读不到 latest.yml 的版本 ⇒ 删除名单为空（一个字节都不删）', plan.remove.length === 0, JSON.stringify(keys(plan.remove)));
  ok('★ 并且给出原因，不静默', plan.notes.some(n => /latest\.yml/.test(n)), plan.notes.join(' | '));
  ok('★ 这种状态下**所有**对象都在保留名单里', plan.keep.length === BUCKET.length, `${plan.keep.length} / ${BUCKET.length}`);
}

{
  const withNewer = BUCKET.concat([
    { key: exe('1.0.2'), size: 93000000 },            // 包传上去了、latest.yml 没传成
    { key: exe('1.0.1-beta.5'), size: 93000000 }      // 同上（测试通道）
  ]);
  const plan = planPrune(withNewer, { stableVersion: '1.0.1', betaVersion: '1.0.1-beta.2', keepPerChannel: 1 });
  const kept = keys(plan.keep);
  ok('★★ 比当前正式版还新的 1.0.2 必须保留（多半是清单没传成，删了就没救）', kept.includes(exe('1.0.2')), JSON.stringify(keys(plan.remove)));
  ok('★★ 比当前测试版还新的 1.0.1-beta.5 同样保留', kept.includes(exe('1.0.1-beta.5')));
  ok('★ 而且这件事会写在 notes 里（不用人猜为什么没清）', plan.notes.some(n => /1\.0\.2/.test(n)), plan.notes.join(' | '));
  ok('该清的两个老包照样清（不是一刀切全留）', keys(plan.remove).includes(exe('0.9.0')));
}

{
  const noBetaYml = BUCKET.filter(x => !/\.yml$/.test(x.key));
  const plan = planPrune(noBetaYml, { stableVersion: '1.0.1', betaVersion: '', keepPerChannel: 1 });
  const kept = keys(plan.keep);
  ok('★ 看不到 beta.yml ⇒ 测试通道的包一律保留（不猜「大概不要了」）',
    kept.includes(exe('1.0.1-beta.0')) && kept.includes(exe('1.0.1-beta.1')) && kept.includes(exe('1.0.1-beta.2')), JSON.stringify(kept.filter(k => /beta/.test(k))));
  ok('★ 正式通道照常清（0.9.0 仍被淘汰）', keys(plan.remove).includes(exe('0.9.0')), JSON.stringify(keys(plan.remove)));
  ok('并且说明为什么留了测试通道的包', plan.notes.some(n => /beta\.yml/.test(n)), plan.notes.join(' | '));
}

{
  const weird = [{ key: 'setup.exe', size: 10 }, { key: 'a.zip', size: 20 }, { key: 'latest.yml', size: 388 }];
  const plan = planPrune(weird, { stableVersion: '1.0.1', betaVersion: '', keepPerChannel: 1 });
  ok('★ 一个版本号都认不出来时：删除名单为空 + 给出警告（绝不「因为没认出来就删掉」）',
    plan.remove.length === 0 && plan.notes.some(n => /一个版本号都没认出来/.test(n)), plan.notes.join(' | '));
}

{
  const plan = planPrune([], { stableVersion: '1.0.1', betaVersion: '', keepPerChannel: 1 });
  ok('空桶不抛异常', plan.remove.length === 0 && plan.keep.length === 0);
  const plan2 = planPrune(null, { stableVersion: '1.0.1', betaVersion: '' });
  ok('objects 传 null 也不抛异常', plan2.remove.length === 0);
}

console.log('\nE. assertNeverRemovesCurrent —— 判定异常时拒绝执行\n');

{
  // 人工造一个「自相矛盾」的计划：当前版本竟出现在删除名单里
  const badPlan = {
    stableCur: '1.0.1', betaCur: '',
    remove: [{ key: exe('1.0.1'), size: 1, why: '（故意造错）' }], keep: []
  };
  const g = assertNeverRemovesCurrent(badPlan);
  ok('★ 当前版本出现在删除名单里 ⇒ 判定为不合格，拒绝执行', g.ok === false && /当前版本/.test(g.error), g.error);
  const goodPlan = { stableCur: '1.0.1', betaCur: '', remove: [{ key: exe('0.9.0'), size: 1, why: '' }], keep: [] };
  ok('合法计划放行', assertNeverRemovesCurrent(goodPlan).ok === true);
  const noCur = { stableCur: '', betaCur: '', remove: [{ key: exe('0.9.0'), size: 1, why: '' }], keep: [] };
  ok('没有当前版本可比时不误报', assertNeverRemovesCurrent(noCur).ok === true);
}

console.log('\n核心不变量：当前版本两个包必留、清单必留、源上状态不明时一个字节都不删。');
console.log(bad ? ('有 ' + bad + ' 项未通过') : '全部通过');
process.exit(bad ? 1 : 0);
