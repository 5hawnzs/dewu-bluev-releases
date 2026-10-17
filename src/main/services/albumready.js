'use strict';
// 相册就绪协议集中于此；每批独立目录，旧批隔离后再核实全盘索引。
const path = require('path');
const adb = require('./adb');
const mainimg = require('./mainimg');
const managedalbum = require('./managedalbum');
const store = require('../store');

/**
 * 本条素材**实际**要落地的目录（就是 `managedalbum.create` 要建的那个批次目录的位置）。
 * clearAlbum 用它推算「哪些目录不许写 .nomedia」——只有这一条路径本身 + 它的上层会藏掉新素材。
 * ★ 为什么不用写死的清单：本版本新素材落在 `/sdcard/Movies/BlueV/batch_*`，与 `DCIM` 无关，
 *   而写死的清单把 `DCIM` 也禁了 ⇒ 历史残留落在那里时**必然停批**、一点办法都没有（rich 的现场）。
 */
function clearedLandingRoot(ctx) {
  // ★ 单一事实来源：新素材落在 managedalbum.ROOT 下的**独立批次目录**里，
  //   所以「不许写标记」的范围就是 ROOT 本身 + 它的上层。写死一份会跟实现漂开。
  return adb.toMediaPath(managedalbum.ROOT);
}

/**
 * 标记「素材/相册就绪这一段」的失败：这一条按失败记，但**不要收回现场重走一遍**。
 *
 * 为什么：这一段是设备侧的清理 / 推图 / 写库 / 排主图，重走一遍不会变好，而且第二次
 * 可能把第一次写进去的隔离标记（`.nomedia`）当成放行依据 —— 等于把一个还留在盘上的旧素材
 * 静默当成清干净了（回归用例：139 且库空但物理文件仍在）。页面侧的失败（入口/转场/内容）
 * 仍然照常重试，两者不混。
 */
function noRetry(error) {
  error.noRetry = true;
  return error;
}

async function prepare(serial, item, row, ctx = {}) {
  const log = ctx.log || (() => {});
  const conclude = ctx.conclude || log;
  const cancelled = ctx.cancelled || (() => false);
  const checkCancelled = () => { if (cancelled()) throw new Error('发布已取消'); };
  checkCancelled();
  const c = ctx.publishConfig || store.get('publish') || {};
  const isVideo = row.kind === 'video';
  const mediaWord = isVideo ? '视频' : '图';
  const media = (item.files || []).filter(f => f.type === (isVideo ? 'video' : 'image'));
  if (!media.length) throw new Error('没有可推送的素材文件');
  let remoteDir;
  const remotes = [];
  // 只以媒体库与扫描后回读确认清空；目录列表不是发布正确性的判据。
  // 全盘初查为空时仍须扫描，覆盖尚未入库的上一条素材。
  row.status = '清理相册';
  if (ctx.onRow) ctx.onRow(row);
  checkCancelled();
  const clearStarted = Date.now();
  require('./diagnostics').phase('清理相册', row.seq);
  const retired=await managedalbum.retire(serial,{cancelled});
  // ★★ 2026-10-15：读不到素材批次目录**不是**失败（只是少了一次「提前把上一批摘出索引」的机会），
  //   如实说出来 —— 下面的全盘四表复核才是相册干净与否的唯一判据。绝不因此停批。
  if(retired.listed===false)log(row.dir+'：'+retired.note,'warn');
  if(retired.isolated)log(row.dir+'：上一批已从相册隔离，物理文件待回收目录 '+retired.pending+' 个','info');
  // ★★ 2026-10-15：`degraded` 必须有消费者 —— 它是「上一批目录两级隔离都没成功」的**唯一**信号，
  //   过去算出来却没人读，等于静默失效（架构审计的结论之一）。这里如实说出来，
  //   由下面的全盘复核兜底；兜不住时 clearAlbum 会停批。
  if(retired.degraded)log(row.dir+'：上一批有 '+retired.degraded+' 个目录的隔离标记未确认，改由全盘相册复核兜底','warn');
  const cleared = await adb.clearAlbum(serial, {
    deadline: clearStarted + 90000, cancelled,
    // ★ 本条素材**实际**要落地的目录（每批独立目录）—— clearAlbum 用它推算「哪些目录不许写
    //   `.nomedia`」（只有这一条路径本身+它的上层会藏掉本条新素材）。不传就退回保守表。
    //   旧行为把 `DCIM` 一类**跟本批无关**的目录也一律禁止 ⇒ 历史残留落在那里时必然停批。
    landingRoot: clearedLandingRoot(ctx),
    // 退避间隔可注入；生产最多四轮，不把持续占用反复拖到总预算。
    // 回归覆盖短暂恢复与持续占用；清不掉就如实停止，绝不强停得物。
    busyRetryDelays: ctx.busyRetryDelays,
    busyRetryBudgetMs: ctx.busyRetryBudgetMs
  });
  if (!cleared.ok) {
    const error = new Error('上一条相册素材未清净：' + (cleared.error || '未知原因'));
    error.code = cleared.code;
    throw noRetry(error);
  }
  checkCancelled();
  // ★★ 2026-10-15：必须把「已从相册移除」与「物理文件待回收」**分开说**（用户口径：不许造假成功）。
  //   相册看不到它 = 这一条能安全发布；磁盘上文件还在 = 另一件事，如实交代、释放后自动回收。
  const pendingFiles=Array.isArray(cleared.physicalPending)?cleared.physicalPending:[];
  log(`${row.dir}：相册已清空（回收 ${cleared.removed} 条记录，耗时 ${((Date.now() - clearStarted) / 1000).toFixed(2)}s）`
    +(pendingFiles.length?`；另有 ${pendingFiles.length} 个物理文件未删除、待回收（已用 .nomedia 隔离，相册里看不到它，不影响本条发布；句柄释放后自动真删）`:''),'info');
  // 全盘相册验证通过后才导航；新素材索引与主页导航可并行，发布入口在最后屏障之后。
  if (ctx.startNavigation) ctx.startNavigation();
  checkCancelled();
  remoteDir=await managedalbum.create(serial,{cancelled});

  const pushStarted = Date.now();
  require('./diagnostics').phase('推送及索引素材', row.seq);
  let needsVolumeScan = false;
  const safeNames = media.map(f => String(f.name).replace(/[^\w.\-+]/g, '_'));
  const usedNames = new Set();
  for (const [index, f] of media.entries()) {
    checkCancelled();
    row.status = `推送素材 ${index + 1}/${media.length}`;
    if (ctx.onRow) ctx.onRow(row);
    checkCancelled();
    const abs = path.join(item.absDir || item.dir, f.name);
    let remoteName = safeNames[index];
    if (safeNames.filter(n => n === remoteName).length > 1) {
      do { remoteName = index + '_' + remoteName; } while (safeNames.includes(remoteName) || usedNames.has(remoteName));
    }
    usedNames.add(remoteName);
    const remote = `${remoteDir}/${remoteName}`;
    const r = await adb.push(serial, abs, remote);
    if (!r.ok) throw new Error(`推${mediaWord}片失败 ${f.name}：${(r.stderr || '').trim()}`);
    remotes.push(remote);
  }
  // 文件推送保持顺序，单文件索引最多两个并行；整卷兜底仍只执行一次。
  for (let index = 0; index < remotes.length; index += 2) {
    if (cancelled()) throw new Error('已取消');
    row.status = `索引素材 ${Math.min(index + 2, remotes.length)}/${media.length}`;
    if (ctx.onRow) ctx.onRow(row);
    checkCancelled();
    const scans = await Promise.all(remotes.slice(index, index + 2)
      .map(remote => adb.mediaScan(serial, remote, { fallbackVolume: false })));
    if (scans.some(sc => !sc.ok)) needsVolumeScan = true;
  }
  checkCancelled();
  if (needsVolumeScan) {
    row.status = '索引素材';
    if (ctx.onRow) ctx.onRow(row);
    checkCancelled();
    const sc = await adb.mediaScan(serial, '');
    if (!sc.ok) log(`${row.dir}：批量扫描返回异常，下面仍须核实全部素材入库`, 'warn');
  }
  log(`${row.dir}：素材推送及索引 ${(Date.now() - pushStarted) / 1000}s`, 'info');

  // ★★★ 2026-10-05（第四十一轮）**主图排序** —— 这里是「哪张当内容主图」的唯一开关。
  //   得物取**相册第 1 格**作内容主图（用户口径）；而第 1 格 = 设备上文件时间（MediaStore
  //   `date_modified`）**最新的那张** —— 真机三步实验的结论与出处见 adb.makeNewest 的注释。
  //   所以要某张当主图，就得把它在设备上的时间设成这一组里最新的。
  //   ★ 挑哪张：名字以 1 开头（`1_xxx.jpg`）优先，否则按**第 1 张**（最先拍到 / 收到的那张）。
  //     用户真实素材实测 3 个叶子：「第 1 张」3/3 合格；而改前的实际行为（最后一张）有 2/3 是
  //     背面图 —— 用户报的就是这个（「不然老是放一些人物的背面图在主图上」）。挑法见 services/mainimg.js。
  //   ★ 视频不参与：只有图文才拿相册里的图当内容图（用户口径）。
  //   ★★ 排不成 ⇒ **这一条就不发**（抛错，不默默发一条主图放错的帖子）：主图放错是用户明确报过
  //     的损失，而「发不出去」他当场就能看见；含糊过去等于让界面骗人。
  checkCancelled();
  if (!isVideo) {
    require('./diagnostics').phase('核实主图顺序', row.seq);
    const pick = mainimg.pickMainImage(item.files);
    if (pick.main && media.length > 1) {
      const idx = media.findIndex(f => f && f.name === pick.main.name);
      if (idx < 0) {
        throw new Error(`内部不一致：挑出来的主图「${pick.main.name}」不在要推的图片清单里`
          + `（清单：${media.map(f => f.name).join('、')}）—— 先查 services/mainimg.js 的挑法，别猜。`);
      }
      row.status = '排主图';
      if (ctx.onRow) ctx.onRow(row);
      checkCancelled();
      const mr = await adb.makeNewest(serial, remotes[idx], remotes);
      if (!mr.ok) {
        throw noRetry(new Error(`没能把主图「${pick.main.name}」排到相册第 1 格：${mr.error}`
          + ' —— 相册第 1 格就是得物的内容主图，排不成就只能按「最后拍的那张」当主图'
          + '（实测那就是你说的背面图）。这步靠设备端 touch + 重扫媒体库两步完成。'));
      }
      checkCancelled();
      const rescan = await adb.mediaScan(serial, remotes[idx]);
      // 某些新设备的 content CLI 会在扫描动作执行后以非 0/139 退出。
      // 命令回执不是得物相册使用的事实来源；MediaStore 回读才是。先复核数据库，
      // 不要因为 CLI 的退出状态把已经正确重扫的主图误判成失败。
      checkCancelled();
      const nw = await adb.mediaNewest(serial, remotes);
      if (!nw.ok) {
        const raw = String(rescan.raw || '').replace(/\s+/g, ' ').trim().slice(0, 180) || '无命令回显';
        throw noRetry(new Error(`主图「${pick.main.name}」重扫后没能从媒体库核实：${nw.error}`
          + `；扫描命令=${rescan.how || '未知'}（${raw}）`
          + ' —— 读不到就不算排成，不会继续发布。'));
      }
      if (nw.newest !== adb.toMediaPath(remotes[idx])) {
        const times = remotes.map(p => `${p.split('/').pop()}=${nw.times && nw.times[adb.toMediaPath(p)]}`).join('，');
        const raw = String(rescan.raw || '').replace(/\s+/g, ' ').trim().slice(0, 140) || '无命令回显';
        throw noRetry(new Error(`排完主图后回读媒体库，最新的仍是「${nw.newest.split('/').pop()}」，`
          + `不是要当主图的「${pick.main.name}」（库内时间：${times}；扫描命令=${rescan.how || '未知'}：${raw}）`
          + ' —— 这一条的主图会放错，先不发。'));
      }
      if (!rescan.ok) {
        const raw = String(rescan.raw || '').replace(/\s+/g, ' ').trim().slice(0, 180) || '无命令回显';
        log(`${row.dir}：扫描命令返回异常（${rescan.how || '未知'}：${raw}），但已从媒体库核实主图时间最新`, 'warn');
      }
      log(`${row.dir}：主图 = ${pick.main.name}（${mainimg.whyText(pick)}），已排到相册第 1 格`, 'info');
      if (pick.why === 'marker-many') {
        conclude(`${row.dir}：这个叶子里有 ${pick.marked.length} 张图的名字都以 1 开头`
          + `（${pick.marked.join('、')}）—— 只取了排在最前的那张当主图，其余的 1 请去掉`, 'warn');
      }
    }
  }

  // ★★ 2026-10-03 真机实测（127.0.0.1:16384 / MuMu 12 / Android 12，全部可复算）：
  //  **得物相册读的就是 MediaStore**。三条证据：
  //   · adb push 一个 mp4 到 /sdcard/DCIM/Camera，它【不在 MediaStore】⇒ 得物相册里【看不到】它
  //     （相册第 1 格仍是旧内容，格子上的时长标记和库里完全对得上）；
  //   · 用 `content call --uri content://media/external/file --method scan_file --arg <全路径>`
  //     把它索引进库（返回 content://media/external_primary/video/media/N）⇒ 冷启动得物打开相册，
  //     它**立刻出现在第 1 格**（实测那条 00:15 就是刚推的）；
  //   · 库里指向「文件已删」的**僵尸记录**，会在相册里显示成一个【黑缩略图的格子】，
  //     点它必弹 Toast「暂不支持的视频格式」—— 得物去解码时文件已不存在。
  //  ⇒ 所以推完必须**确认真的进库了**再往下走。以前那条路（发两条广播）在这台设备上
  //    没有任何接收者，这才是「视频已推到设备，但等了 182.9s 媒体库还没索引到」的真根因。
  //  ★ 图文同样要走这条：图片不进库，得物相册里一样看不到它。
  checkCancelled();
  row.status = '写媒体库';
  require('./diagnostics').phase('核实媒体库', row.seq);
  if (ctx.onRow) ctx.onRow(row);
  checkCancelled();
  const sec = Number(c.videoIndexTimeoutSec) > 0 ? Number(c.videoIndexTimeoutSec) : 20;
  const w = await adb.mediaVisible(serial, remotes, {
    timeoutMs: sec * 1000,
    onTick: s => { checkCancelled(); row.status = `写媒体库确认 ${s}s`; if (ctx.onRow) ctx.onRow(row); checkCancelled(); }
  });
  if (!w.ok) {
    throw noRetry(new Error(`${mediaWord}片已推到设备，但没能写进媒体库（得物相册里看不到它）：等了 ${w.waited}s`
      + (w.error ? `，${w.error}` : '')));
  }
  checkCancelled();
  const exactAlbum = await adb.albumMatches(serial, remotes);
  checkCancelled();
  if (!exactAlbum.ok) throw noRetry(new Error(exactAlbum.error));
  log(`${row.dir}：已推 ${media.length} 个${mediaWord}片，并确认写进媒体库（${w.waited}s）`, 'info');

  // 推送与索引期间并行推进的主页导航必须在这里收敛；任一分支失败都不进发布入口。
  if (ctx.awaitNavigation) {
    require('./diagnostics').phase('等待个人主页导航', row.seq);
    await ctx.awaitNavigation();
  }
  checkCancelled();
  return { remotes, remoteDir };
}
module.exports = { prepare };
