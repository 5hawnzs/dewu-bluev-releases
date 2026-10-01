'use strict';
/**
 * 清理发布源（COS）上堆积的老安装包。
 *
 * ★ 为什么需要它：产物名字里带版本号（`build.win.artifactName` 那一行），
 *   所以**每次发版天然新增一个约 88 MB 的文件**；而上传脚本只有「上传」能力、
 *   桶上也没有生命周期规则 ⇒ 老包只增不减。实测：4 个 exe 合计 343 MB。
 *
 * ★★ 为什么**不**改成「同名覆盖」（那个人人都会先想到的方案）：
 *     ① **回滚没了**。正式通道允许降级 —— 用户从测试版切回正式版靠它，出事回退也靠它。
 *        包被覆盖就回不去了，而且源上只留一份的话，「上次那个包」再也拿不回来。
 *     ② **审计线索没了**。「哪次更新对应哪个包」是事后唯一能对上的凭据。
 *     ③ 覆盖同版本号会让电子更新器按版本号比较后判「没有新版本」（上传脚本的 versionGate 拦的就是这个）。
 *   ⇒ 正确做法是**保留策略**，不是覆盖。
 *
 * 保留策略（每条通道各留「当前 + N 个可回滚的历史版本」，N 默认 1）：
 *   · `latest.yml` 指向的正式版版本  —— 必须有，删了客户端就收不到更新
 *   · `beta.yml`   指向的测试版版本  —— 有就必留
 *   · 正式通道：比当前正式版**低**的最新 N 个正式版（回滚目标）
 *   · 测试通道：比当前测试版**低**的最新 N 个预发布版（回滚目标）
 *   · ★ **认不出/解析不出版本的任何对象一律保留** —— 宁可留着，也不删看不懂的东西
 *   · ★ 两条 yml 清单本身永远保留
 *
 * ★ 默认就是 **dry-run**：不给 `--apply` 一个字节都不会删。要真删必须显式加 `--apply`。
 *
 * 用法：
 *   node tools/prune-release.js                    # 只看：要删哪些、能腾多少
 *   node tools/prune-release.js --apply            # 真的删
 *   node tools/prune-release.js --keep-more=2      # 每条通道多留 2 个历史版本（共 3 个）
 *   node tools/prune-release.js --apply --keep-more=0   # 激进：只留当前两个版本
 *
 * 凭据与 upload-release.js 同一套（环境变量或仓库根 `.env`，已 gitignore）。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const up = require(path.join(ROOT, 'tools/upload-release.js'));
const { parseManifest, compareVersion, humanSize, padTo, loadEnv, argOf, hasOf } = up;

// ★ 复用 upload-release.js 的那套（**同时支持 `--name value` 与 `--name=value`**）——
//   两边各写一份必然跑偏，而这里跑偏的后果是删错包。
const arg = (name, def) => argOf(process.argv, name, def);
const has = name => hasOf(process.argv, name);

/* ============================================================================
 * 一、纯逻辑（不碰网络、不碰文件系统，单独可测）
 * ==========================================================================*/

/**
 * 从产物文件名里抠出版本号。
 *
 * ★ **故意做得窄**：只认 electron-builder 按 `build.win.artifactName`
 *   （`${productName}-${version}-${arch}-win.${ext}`）产出的形状。
 *
 * 为什么不用通用 semver 正则：`得物蓝V素材发布工具-1.0.1-x64-win.exe` 里那个 `x64`
 * **本身就是一个合法的 semver 预发布段**（`1.0.1-x64` 是合法版本号）⇒ 通用正则会
 * 把版本读成 `1.0.1-x64`，于是「当前版本」永远匹配不上、回滚目标也算错，
 * 最后**删错包**。读错版本的后果是不可逆的，所以宁可认不出来（认不出来 = 保留）。
 *
 * @returns {{version:string, pre:boolean}|null}
 */
function artifactVersion(key) {
  const base = String(key == null ? '' : key).split('/').pop();
  if (!/\.exe(\.blockmap)?$/i.test(base)) return null;
  const m = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+?)?)-(?:x64|ia32|arm64|armv7l)-win\.exe(\.blockmap)?$/i.exec(base);
  if (!m) return null;
  const version = m[1];
  // 兜底：能被解析出来的必须真是个 semver（防止正则贪心吃掉别的东西）
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) return null;
  return { version, pre: version.includes('-') };
}

/** 降序排列版本（新的在前）；解析不出来的不参与比较 */
function sortVersions(list) {
  return list.slice().sort((a, b) => -compareVersion(a, b));
}

/**
 * 定保留/删除名单。**唯一的判定入口** —— 命令行和测试走的是同一条路。
 *
 * @param {Array<{key:string, size:number}>} objects 桶里的全部对象
 * @param {{stableVersion?:string, betaVersion?:string, keepPerChannel?:number}} opts
 * @returns {{keep:Array, remove:Array, notes:Array<string>}}
 */
function planPrune(objects, opts) {
  const o = opts || {};
  const keepMore = Math.max(0, Number(o.keepPerChannel == null ? 1 : o.keepPerChannel) || 0);
  const list = Array.isArray(objects) ? objects : [];
  const notes = [];

  const arts = [];
  const keep = [];
  for (const it of list) {
    const v = artifactVersion(it.key);
    if (v) arts.push({ key: it.key, size: Number(it.size) || 0, version: v.version, pre: v.pre });
    else keep.push({ key: it.key, size: Number(it.size) || 0, why: '不是一个能认出版本的安装包（清单 / 占位 / 名字不认识）⇒ 一律保留' });
  }

  const rel = sortVersions([...new Set(arts.filter(a => !a.pre).map(a => a.version))]);
  const pre = sortVersions([...new Set(arts.filter(a => a.pre).map(a => a.version))]);

  const stableCur = String(o.stableVersion || '').trim();
  const betaCur = String(o.betaVersion || '').trim();

  // ★★ 闸门一：读不到 latest.yml 的版本号就**一个字节都不删**。
  //    「源上状态不明」的时候做破坏性操作，正是最容易把唯一那份可用包毁掉的场景。
  if (!stableCur) {
    const why = '读不到 latest.yml 的版本号 ⇒ 源上状态不明（清单丢了 / 还没发过正式版）。**不删任何东西**，先查清源上到底怎么了。';
    return {
      keep: list.map(x => ({ key: x.key, size: Number(x.size) || 0, why })),
      remove: [], notes: [why], stableCur: '', betaCur, rollbacks: []
    };
  }

  // ★ 闸门二：看不到 beta.yml 时，测试通道的包**全留**（不猜「它大概不要了」）。
  if (!betaCur && pre.length) {
    notes.push(`看不到 beta.yml（测试通道还没发过？）⇒ 桶里 ${pre.length} 个预发布版本的包**一律保留**；真要清测试通道的包，先确认那条通道还要不要。`);
  }

  const whyOf = new Map();   // version → 为什么保留
  whyOf.set(stableCur, '当前正式版（latest.yml 指向它，删了客户端就收不到更新）');
  if (betaCur) whyOf.set(betaCur, '当前测试版（beta.yml 指向它）');

  // 回滚目标：各自比「当前」低的最新 keepMore 个（各留最新的那一档）
  const rollbacks = [];
  for (const v of rel.filter(x => compareVersion(x, stableCur) < 0).slice(0, keepMore)) {
    whyOf.set(v, `回滚目标（正式通道，比 ${stableCur} 旧）`);
    rollbacks.push(v);
  }
  if (betaCur) {
    for (const v of pre.filter(x => compareVersion(x, betaCur) < 0).slice(0, keepMore)) {
      whyOf.set(v, `回滚目标（测试通道，比 ${betaCur} 旧）`);
      rollbacks.push(v);
    }
  }

  // ★★ 闸门三：比「当前版本」还新的，一律保留。那多半是「包传上去了、清单没传成」的残留 ——
  //    删掉它等于把唯一那份可用的包毁掉，而它恰恰是马上要用来救场的那一份。
  for (const a of arts) {
    if (whyOf.has(a.version)) continue;
    const cur = a.pre ? betaCur : stableCur;
    if (!cur) continue;
    if (compareVersion(a.version, cur) > 0) {
      whyOf.set(a.version, `比该通道当前版本（${cur}）还新，但清单没指向它 ⇒ 保留（多半是「包传上去了、清单没传成」，先查清楚）`);
      notes.push(`${a.version} 比${a.pre ? '测试' : '正式'}通道当前版本 ${cur} 还新，却没被清单指向 ⇒ 本次保留它，不当作旧包清掉。`);
    }
  }
  // 看不到 beta.yml 时，预发布版全留
  if (!betaCur) for (const v of pre) whyOf.set(v, '测试通道状态不明（没有 beta.yml）⇒ 保留，不猜');

  const remove = [];
  for (const a of arts) {
    if (whyOf.has(a.version)) keep.push({ key: a.key, size: a.size, why: whyOf.get(a.version) });
    else remove.push({
      key: a.key, size: a.size,
      why: `${a.pre ? '测试' : '正式'}通道上已被淘汰的旧包（保留名单里没有 ${a.version}）`
    });
  }

  // 兜底：认出了安装包却一个都没保住 —— 那说明判定逻辑和现实脱节了，停下来别删
  if (arts.length && !keep.some(k => artifactVersion(k.key))) {
    notes.push('警告：认出了安装包，但一个都没落进保留名单 ⇒ 判定逻辑有问题，本次**不删任何东西**。');
    return { keep: keep.concat(remove.map(r => ({ key: r.key, size: r.size, why: '判定异常，暂不删' }))), remove: [], notes, stableCur, betaCur, rollbacks };
  }
  if (list.some(x => /\.exe$/i.test(x.key)) && !arts.length) {
    notes.push('警告：桶里有 .exe，但一个版本号都没认出来（产物命名规则改过？）—— 本次**不会删任何东西**。');
  }

  return { keep, remove, notes, stableCur, betaCur, rollbacks };
}

/** 只要删除名单里出现「当前版本」的键，就是算法错了 ⇒ 直接拒绝执行（最后一道闸） */
function assertNeverRemovesCurrent(plan) {
  const cur = [plan.stableCur, plan.betaCur].filter(Boolean);
  for (const r of plan.remove) {
    const v = artifactVersion(r.key);
    if (v && cur.includes(v.version)) {
      return { ok: false, error: `保留名单里说 ${v.version} 是该通道的当前版本，它却出现在删除名单里（${r.key}）` };
    }
  }
  return { ok: true };
}

/** 把删除名单按「保留最新的一档」之外去重汇总体积 */
function sumSize(list) { return list.reduce((a, b) => a + (Number(b.size) || 0), 0); }

/* ============================================================================
 * 二、与 COS 打交道（只在 main 里用）
 * ==========================================================================*/

function cosClient() {
  let COS;
  try { COS = require('cos-nodejs-sdk-v5'); }
  catch (e) { console.error('缺 cos-nodejs-sdk-v5，先 npm i -D cos-nodejs-sdk-v5'); process.exit(2); }
  return new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 600000 });
}

function makeApi(cos, B, R) {
  return {
    listAll: () => new Promise((res, rej) => {
      const out = [];
      const page = Marker => cos.getBucket({ Bucket: B, Region: R, MaxKeys: 1000, Marker }, (e, d) => {
        if (e) return rej(e);
        for (const o of (d && d.Contents) || []) out.push({ key: o.Key, size: Number(o.Size) || 0, at: o.LastModified });
        if (d && d.IsTruncated && (d.Contents || []).length) page(d.NextMarker || out[out.length - 1].key);
        else res(out);
      });
      page('');
    }),
    getText: Key => new Promise((res, rej) => cos.getObject({ Bucket: B, Region: R, Key, DataType: 'text' },
      (e, d) => e ? rej(e) : res(String(d.Body)))),
    head: Key => new Promise(res => cos.headObject({ Bucket: B, Region: R, Key }, (e, d) => res(e ? null : d))),
    del: Keys => new Promise((res, rej) => cos.deleteMultipleObject({
      Bucket: B, Region: R, Objects: Keys.map(Key => ({ Key }))
    }, (e, d) => e ? rej(e) : res(d)))
  };
}

/** 清单读不出来时返回 ''（不是抛异常）—— 「读不到」和「没有」必须区分开，但都不该中断清理 */
async function readManifestVersion(api, key) {
  try {
    const body = await api.getText(key);
    return parseManifest(body).version || '';
  } catch (e) { return ''; }
}

function printPlan(plan, apply) {
  console.log(`\n保留（${plan.keep.length} 个对象）：`);
  for (const k of plan.keep) {
    console.log(`  ${padTo(humanSize(k.size), 10)}${k.key}`);
    console.log(`      ↳ ${k.why}`);
  }
  console.log(`\n${apply ? '要删' : '将删'}（${plan.remove.length} 个对象，合计 ${humanSize(sumSize(plan.remove))}）：`);
  if (!plan.remove.length) console.log('  （没有可清的 —— 已经在保留策略内了）');
  for (const r of plan.remove) console.log(`  ${padTo(humanSize(r.size), 10)}${r.key}   ↳ ${r.why}`);
  for (const n of plan.notes || []) console.log(`\n注意：${n}`);
}

async function main() {
  loadEnv();
  const apply = !!has('apply');
  const keepMore = Number(arg('keep-more', '1'));

  if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY || !process.env.COS_BUCKET || !process.env.COS_REGION) {
    console.error('缺少凭据。需要 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION（环境变量或 .env）。');
    process.exit(2);
  }
  const cos = cosClient();
  const B = process.env.COS_BUCKET, R = process.env.COS_REGION;
  const DOMAIN = (process.env.COS_DOMAIN || `https://${B}.cos.${R}.myqcloud.com`).replace(/\/+$/, '');
  const api = makeApi(cos, B, R);

  console.log(`目标      ${DOMAIN}`);
  console.log(`策略      每条通道保留「当前 + ${keepMore} 个可回滚的历史版本」；认不出的一律保留`);
  console.log(`模式      ${apply ? '★ --apply：会真的删除' : '--dry-run（默认）：只看不删'}`);

  const objects = await api.listAll();
  console.log(`\n桶内共 ${objects.length} 个对象，合计 ${humanSize(sumSize(objects))}`);

  const stableVersion = await readManifestVersion(api, 'latest.yml');
  const betaVersion = await readManifestVersion(api, 'beta.yml');
  console.log(`latest.yml → ${stableVersion || '(读不到)'}`);
  console.log(`beta.yml   → ${betaVersion || '(读不到 / 还没有测试版)'}`);

  const plan = planPrune(objects, { stableVersion, betaVersion, keepPerChannel: keepMore });
  printPlan(plan, apply);

  const guard = assertNeverRemovesCurrent(plan);
  if (!guard.ok) { console.error(`\n拒绝执行：${guard.error}`); process.exit(1); }

  if (!apply) {
    console.log('\n--dry-run：什么都没删。确认上面这份名单没问题后，加 --apply 真的执行。');
    return;
  }
  if (!plan.remove.length) { console.log('\n没有要删的，什么都没做。'); return; }

  const keys = plan.remove.map(r => r.key);
  let done = 0;
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    process.stdout.write(`删除 ${chunk.length} 个对象 … `);
    const d = await api.del(chunk);
    const errs = (d && d.Error) || [];
    done += chunk.length - errs.length;
    console.log(errs.length ? `ok（${errs.length} 个失败：${errs.map(e => e.Key).join(', ')}）` : 'ok');
  }

  console.log(`\n已删除 ${done} 个对象，腾出约 ${humanSize(sumSize(plan.remove))}。`);
  // ★ 删完必须复核「当前版本那两个包还在」—— 说删干净了得拿源上的事实说话，不是靠推断
  const still = [];
  for (const k of plan.keep) {
    if (artifactVersion(k.key)) still.push({ key: k.key, ok: !!(await api.head(k.key)) });
  }
  const missing = still.filter(s => !s.ok);
  for (const s of still) console.log(`  复核 ${s.ok ? '在' : '★ 不在了'}  ${s.key}`);
  if (missing.length) { console.error(`\n★ 有 ${missing.length} 个保留对象不见了 —— 立刻检查源上 latest.yml 指向的包是否还能下。`); process.exit(1); }
  console.log('\n复核通过：保留名单里的安装包一个都没少。');
}

module.exports = { artifactVersion, sortVersions, planPrune, assertNeverRemovesCurrent, sumSize };
if (require.main === module) main().catch(e => { console.error('\n失败：' + ((e && (e.code || e.message)) || e)); process.exit(1); });
