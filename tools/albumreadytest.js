'use strict';
// 使用真实发布入口；仅在设备进程这一外部 seam 注入取消，复现推送途中停止。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-albumready-'));
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const dir = path.join(tmp, 'fakeadb'); fs.mkdirSync(dir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(dir, file));
fs.writeFileSync(path.join(dir, 'IME_ACTIVE'), '1');
fs.writeFileSync(path.join(dir, 'FOCUS'), 'com.shizhuang.duapp/.modules.home.ui.HomeActivity');
const fakeAdb = require('./fakeadb/adb').makeFakeAdb(dir);
let cancelled = false, cancelOnPush = false;
require('child_process').execFile = function(bin, args, options, callback) {
  return fakeAdb(bin, args, options, (error, stdout, stderr) => {
    if (cancelOnPush && args.includes('push')) cancelled = true;
    callback(error, stdout, stderr);
  });
};
const store = require('../src/main/store'), publisher = require('../src/main/services/publisher');
const itemDir = path.join(tmp, '素材'); fs.mkdirSync(itemDir);
for (const name of ['1.jpg', '2.jpg']) fs.writeFileSync(path.join(itemDir, name), '测试文件');
store.set({ paths: { output: path.join(tmp, '输出') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000,
  uiMap: { package: 'com.shizhuang.duapp', steps: [{ name: '提交发布', action: 'tapText', value: '发布' }] } } });
const state = () => ({ items: [{ id: 'A', dir: itemDir, absDir: itemDir, files: ['1.jpg','2.jpg'].map(name => ({name, type:'image'})) }],
  copyRows: [{id:'A',title:'测试',body:'测试',topics:[]}], verify:{rows:[]},
  publish:{mode:'adb',device:'FAKE',rows:[{seq:1,id:'A',dir:'A',goods:1,result:''}]} });
const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n');
const ok = (label, value) => { assert(value, label); console.log('PASS ' + label); };
(async () => {
  const start = performance.now();
  const normal = await publisher.run(state());
  const trace = calls();
  ok('两张图就绪后只提交一条，素材放入独立批次目录', normal.okCount === 1 && normal.failCount === 0
    && trace.filter(c => /\bpush /.test(c)).length === 2
    && trace.filter(c=>/\bpush /.test(c)).every(c=>/Movies\/BlueV\/batch_[a-f0-9]{32}/.test(c))
    && !trace.some(c => /ls -A |find .* -type f|DCIM\/Camera\/bluev/.test(c)));
  const beforePush = trace.slice(0, trace.findIndex(c => /\bpush /.test(c)));
  ok('正常每条只执行一次全盘重扫清理，并在推送之前完成',
    beforePush.filter(c => /--method scan_volume/.test(c)).length === 1
    && trace.filter(c => /--method scan_volume/.test(c)).length === 1);
  console.log('METRIC ' + JSON.stringify({ commands: trace.length, elapsedMs: Math.round(performance.now() - start) }));
  const before = trace.length;
  cancelOnPush = true;
  const stopped = await publisher.run(state(), { cancelled: () => cancelled });
  const tail = calls().slice(before);
  const afterPush = tail.slice(tail.findIndex(c => /\bpush /.test(c)) + 1);
  ok('第一张推送期间取消后不再推第二张、不索引、不提交', stopped.cancelled
    && tail.filter(c => /\bpush /.test(c)).length === 1
    && !afterPush.some(c => /content call |input tap /.test(c)));
  cancelled = false; cancelOnPush = false;
  const nextStart = calls().length;
  const atProgress = await publisher.run(state(), { cancelled: () => cancelled,
    onRow: row => { if (row.status === '推送素材 1/2') cancelled = true; } });
  ok('进度回调中取消后，第一张也不能继续推送', atProgress.cancelled
    && !calls().slice(nextStart).some(c => /\bpush /.test(c)));
  cancelled = false;
  const adb = require('../src/main/services/adb');
  await adb.push('FAKE', path.join(itemDir,'1.jpg'), '/sdcard/DCIM/Camera/上一条.jpg');
  await adb.mediaScan('FAKE', '/sdcard/DCIM/Camera/上一条.jpg');
  fs.writeFileSync(path.join(dir,'MEDIA_BUSY_ROUNDS'),'1');
  const busyStart = calls().length;
  const recovered = await publisher.run(state());
  const busyTrace = calls().slice(busyStart);
  const firstRm = busyTrace.findIndex(c=>/rm -f .*上一条/.test(c));
  const secondRm = busyTrace.findIndex((c,i)=>i>firstRm && /rm -f .*上一条/.test(c));
  // ★★ 2026-10-15 口径变更（旧断言「必须先无索引删除」是错的：rm 失败时旧代码直接 return，
  //   于是库记录永远删不掉 —— 那正是 rich 连续失败的写法）。新口径：
  //   占用时先写 .nomedia 隔离、再删索引，相册里就看不到它了；物理文件删不掉只记「待回收」。
  // 只看**这一条素材所在目录**（DCIM/Camera）的动作：别把上游「上一批目录」的 .nomedia 算进来。
  const isoIndex = busyTrace.findIndex(c=>/touch '\/storage\/emulated\/0\/DCIM\/Camera\/\.nomedia'/.test(c));
  const delIndex = busyTrace.findIndex(c=>/content delete/.test(c));
  ok('上一条物理文件占用：先写 .nomedia 隔离、再删索引，物理文件如实记待回收，照样推送提交',
    recovered.okCount===1 && firstRm>=0 && isoIndex>firstRm && delIndex>isoIndex
    && !busyTrace.some(c=>/am force-stop/.test(c)));
  // ★★ 2026-10-15 口径变更：句柄晚释放（旧版本要等到第 5 次 rm 才放行）**不再拖着本条空等**。
  //   占用中先把 .nomedia 写进去、再删库记录 ⇒ 相册里立刻看不到它，本条可以直接发布；
  //   物理文件如实留在磁盘上（待回收），句柄释放后由下一次清理真正删掉。
  //   旧断言「必须有 5 次 rm 才放行」测的是「等句柄」这条已被推翻的路（rich 就是被它拖死的）。
  const preclean = await adb.clearAlbum('FAKE');
  assert(preclean.ok, '前置清空失败：' + preclean.error);
  await adb.push('FAKE', path.join(itemDir,'1.jpg'), '/sdcard/DCIM/Camera/上一条.jpg');
  await adb.mediaScan('FAKE', '/sdcard/DCIM/Camera/上一条.jpg');
  // 真机语义：句柄一直被握着（不是「忙几轮就好」）—— `rm` 恒 busy，`content delete` 记录能删，
  //   但**物理文件与 push 记录都留着**，所以没有 .nomedia 的话重扫必复活。
  fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'上一条');
  const lateStart = calls().length;
  const late = await publisher.run(state());
  const lateTrace = calls().slice(lateStart);
  const lateRmTries = lateTrace.filter(c=>/rm -f .*上一条/.test(c)).length;
  ok('句柄晚释放也不空等：占用中隔离后立刻发布，物理文件如实留待回收，不强停得物',
    late.okCount===1 && late.failCount===0 && lateRmTries<=2
    && !lateTrace.some(c=>/am force-stop/.test(c))
    && [...fakeAdb.__physicalMedia].some(p=>/上一条\.jpg/.test(p)));
  // 句柄释放 ⇒ 下一次清理必须真的删掉物理文件并撤掉 .nomedia（隔离不是永久占着磁盘）。
  fs.unlinkSync(path.join(dir,'MEDIA_HELD'));
  const reclaimStart = calls().length;
  const reclaimed = await adb.clearAlbum('FAKE');
  const reclaimTrace = calls().slice(reclaimStart);
  ok('句柄释放后延后回收真的删掉旧素材、撤掉 .nomedia（隔离不是永久占着磁盘）',
    reclaimed.ok && ![...fakeAdb.__physicalMedia].some(p=>/上一条\.jpg/.test(p))
    && reclaimTrace.some(c=>/rm -f .*\.nomedia/.test(c)));
  fs.writeFileSync(path.join(dir,'DIR_LOCKED_BY_APP'),'1');
  const isolatedState=state();isolatedState.publish.rows.push({seq:2,id:'A',dir:'B',goods:1,result:''});
  const isolatedStart=calls().length;
  const isolated=await publisher.run(isolatedState);
  ok('上一批持续占用仍连续两条成功：旧批隔离后不混入相册、不强停、不等待删除',
    isolated.okCount===2&&isolated.failCount===0&&!isolated.stoppedReason
    && [...fakeAdb.__managedDirs.values()].some(v=>v.hidden)
    && [...fakeAdb.__physicalMedia].length>2
    && !calls().slice(isolatedStart).some(c=>/am force-stop/.test(c)));
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部占用.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部占用.jpg');
  const lockedStart=calls().length;
  // 持续占用分支：新口径下**不再失败**（.nomedia 隔离 + 删索引后相册已看不见它），
  // 但必须仍然：不强停、物理文件如实进待回收、日志与"确实删掉"分开说。
  const locked=await publisher.run(state(), { busyRetryDelays: [1, 2, 3], busyRetryBudgetMs: 12 });
  ok('持续占用不再假装失败也不再空等：隔离后照常发布，物理文件留待回收，不强停得物',
    locked.okCount===1 && locked.failCount===0
    && calls().slice(lockedStart).some(c=>/touch .*\.nomedia/.test(c))
    && !calls().slice(lockedStart).some(c=>/am force-stop/.test(c)));
  const blockedBatch=state();
  blockedBatch.publish.rows.push({seq:2,id:'A',dir:'B',goods:1,result:''});
  const boundedStart=calls().length;
  const bounded=await publisher.run(blockedBatch, {busyRetryDelays:[0]});
  const boundedTrace=calls().slice(boundedStart);
  ok('持续占用不阻塞整批：两条都继续，没有重复清理或强停', bounded.okCount===2 && bounded.failCount===0
    && !bounded.stoppedReason && boundedTrace.filter(c=>/rm -f .*外部占用/.test(c)).length<=3
    && !boundedTrace.some(c=>/am force-stop/.test(c)));
  fs.unlinkSync(path.join(dir,'DIR_LOCKED_BY_APP'));
  fs.writeFileSync(path.join(dir,'DELETE_LAG_ROUNDS'),'1');
  const delayed=await publisher.run(state());
  ok('物理删除后索引暂未回收：不能把Deleted 0当作清空，实际复查收敛后完成',delayed.okCount===1&&delayed.failCount===0);
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/权限验证.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/权限验证.jpg');
  // ★★ 2026-10-15 口径变更：现在「rm 失败」本身**不再**当场失败 —— 只要隔离标记能写上、
  //   索引能删掉、重扫不复活，相册就是干净的（旧裁决「rm 失败就停」正是 rich 死循环的写法）。
  //   所以这里要摆出**真正不可恢复**的现场：文件被句柄占住（删不掉，重扫会复活）
  //   **且隔离标记也写不进去**（NOMEDIA_DENIED）⇒ 库记录删了也会被扫回来。
  //   这时必须如实失败、不推素材、不进发布页，并把原因说成「隔离标记未确认」而不是「rm busy」。
  fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'权限验证');
  fs.writeFileSync(path.join(dir,'NOMEDIA_DENIED'),'1');
  const deniedStart=calls().length;
  const denied=await publisher.run(state());
  const deniedTrace=calls().slice(deniedStart);
  ok('文件占住且隔离标记写不进时如实阻断：原因说清是隔离未确认，不推素材、不进发布页',
    denied.failCount===1 && /隔离标记/.test(denied.rows[0].reason)
    && !deniedTrace.some(c=>/\bpush |input tap/.test(c)));
  const ordinaryState=state();ordinaryState.publish.rows.push({seq:2,id:'A',dir:'B',goods:1,result:''});
  const ordinary=await publisher.run(ordinaryState,{onRow:r=>{
    if(r.seq===1&&r.result==='失败'&&fs.existsSync(path.join(dir,'MEDIA_HELD'))){
      fs.unlinkSync(path.join(dir,'MEDIA_HELD'));fs.unlinkSync(path.join(dir,'NOMEDIA_DENIED'));
    }
  }});
  ok('普通单条失败仍继续：首条隔离失败、次条恢复后成功，不能误停整批',
    ordinary.failCount===1&&ordinary.okCount===1&&!ordinary.stoppedReason&&ordinary.rows[1].result==='发布成功');
  const originalMap=store.get('publish.uiMap');
  const xmlFile=path.join(dir,'window.xml'), originalXml=fs.readFileSync(xmlFile,'utf8');
  fs.writeFileSync(xmlFile,originalXml.replace('</hierarchy>',
    '<node resource-id="com.shizhuang.duapp:id/tab_user" text="我" enabled="true" bounds="[90,90][110,110]"/>'+
    '<node resource-id="com.shizhuang.duapp:id/tvGoHomePage" text="主页" enabled="true" bounds="[140,140][160,160]"/>'+
    '<node resource-id="com.shizhuang.duapp:id/rlPublish" text="发布新动态" enabled="true" bounds="[190,190][210,210]"/></hierarchy>'));
  store.set({publish:{uiMap:{steps:[
    {action:'tapId',value:'com.shizhuang.duapp:id/tab_user',name:'底部我'},
    {action:'tapId',value:'com.shizhuang.duapp:id/tvGoHomePage',name:'右上角主页'},
    {action:'tapId',value:'com.shizhuang.duapp:id/rlPublish',name:'发布新动态'},
    {action:'tapText',value:'发布',name:'提交发布'}]}}});
  fs.writeFileSync(path.join(dir,'MEDIA_BUSY_ROUNDS'),'1');
  const overlapStart=calls().length;
  const overlap=await publisher.run(state());
  const overlapTrace=calls().slice(overlapStart);
  const overlapFirstRm=overlapTrace.findIndex(c=>/rm -f /.test(c));
  const lastScan=overlapTrace.map((c,i)=>/--method scan_volume/.test(c)?i:-1).reduce((a,b)=>Math.max(a,b),-1);
  const navIndex=overlapTrace.findIndex(c=>/input tap 150 150/.test(c));
  const entryIndex=overlapTrace.findIndex(c=>/input tap 200 200/.test(c));
  const lastPush=overlapTrace.map((c,i)=>/\bpush /.test(c)?i:-1).reduce((a,b)=>Math.max(a,b),-1);
  // ★★ 2026-10-14 rich 四连失败后收紧：清理相册期间**一个界面动作都不许发**。
  //   原因：上一条已发布视频可能还挂在得物里（个人主页/播放器持解码句柄）⇒ 清理时点界面
  //   会把它继续拉住，rm 永远 busy。导航改到「清理收敛之后」再启动，与推送/索引重叠，
  //   省时效果保留；发布新动态仍留在最后一道屏障之后。
  ok('清理相册期间不触碰得物界面，主页导航在清理收敛后才启动',overlap.okCount===1
    && overlapFirstRm>=0&&lastScan>overlapFirstRm
    && !overlapTrace.slice(overlapFirstRm,lastScan+1).some(c=>/input tap /.test(c))
    && navIndex>lastScan&&entryIndex>navIndex&&entryIndex>lastPush);
  // 真正清不掉的现场：文件被占住 + 隔离标记写不进去（rm 被拒但索引删除会连文件一起删掉，
  // 只有「占住 + 标记写不进」才会让记录被扫回来）。
  fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'外部残留');
  fs.writeFileSync(path.join(dir,'NOMEDIA_DENIED'),'1');
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部残留.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部残留.jpg');
  const overlapFailStart=calls().length;
  const overlapFailed=await publisher.run(state());
  ok('清理失败时一个界面动作都不发、不推素材、不进发布入口',overlapFailed.failCount===1
    && /隔离标记/.test(overlapFailed.rows[0].reason)
    && !calls().slice(overlapFailStart).some(c=>/input tap |\bpush /.test(c)));
  fs.unlinkSync(path.join(dir,'MEDIA_HELD'));fs.unlinkSync(path.join(dir,'NOMEDIA_DENIED'));
  store.set({publish:{uiMap:originalMap}});fs.writeFileSync(xmlFile,originalXml);
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部残留.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部残留.jpg');
  fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'after');
  fs.writeFileSync(path.join(dir,'QUERY_EXIT_139'),'1');
  fs.writeFileSync(path.join(dir,'SCAN_EXIT_139_AFTER_WRITE'),'1');
  const crashAfter=await publisher.run(state());
  ok('生产入口：删除已生效但命令139空输出，必须通过扫描回读确认后继续',crashAfter.okCount===1&&crashAfter.failCount===0);
  fs.unlinkSync(path.join(dir,'DELETE_EXIT_139'));
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部残留.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部残留.jpg');
  fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'before');
  const crashStart=calls().length;
  const crashBefore=await publisher.run(state());
  ok('同样139但索引持续残留时绝不推送或提交',crashBefore.failCount===1
    && /cli-139-unknown/.test(crashBefore.rows[0].reason)
    && !calls().slice(crashStart).some(c=>/\bpush |input tap/.test(c)));
  fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'before-once');
  const crashRetry=await publisher.run(state());
  ok('139未生效后恢复：同一路径复查收敛才继续',crashRetry.okCount===1);
  fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'after');
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部残留.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部残留.jpg');
  fs.writeFileSync(path.join(dir,'RM_SILENT_KEEP'),'1');
  const physicalStart=calls().length;
  const physicalLeft=await publisher.run(state());
  ok('139且库暂空但物理文件仍在，不以空库伪装清理成功',physicalLeft.failCount===1
    && /物理文件缺失未确认/.test(physicalLeft.rows[0].reason)
    && !calls().slice(physicalStart).some(c=>/\bpush |input tap/.test(c)));
  fs.unlinkSync(path.join(dir,'DELETE_EXIT_139'));fs.unlinkSync(path.join(dir,'RM_SILENT_KEEP'));
  fs.unlinkSync(path.join(dir,'QUERY_EXIT_139'));fs.unlinkSync(path.join(dir,'SCAN_EXIT_139_AFTER_WRITE'));
  const managed=require('../src/main/services/managedalbum');
  const reclaimRounds=Math.ceil(fakeAdb.__managedDirs.size/3)+1;
  for(let i=0;i<reclaimRounds;i++)await managed.retire('FAKE');
  ok('占用释放后延后回收确实删除旧物理素材，归属目录可回收',
    ![...fakeAdb.__physicalMedia].some(p=>p.includes('/Movies/BlueV/')));
  const foreign='/sdcard/Movies/BlueV/batch_'+ 'f'.repeat(32);
  fakeAdb.__managedDirs.set(foreign,{owner:'FOREIGN',hidden:false});
  await managed.retire('FAKE');
  ok('名称相似但没有工具归属标记的目录不隔离不回收',fakeAdb.__managedDirs.get(foreign).hidden===false);
  fakeAdb.__managedDirs.delete(foreign);
  await publisher.run(state());
  fs.writeFileSync(path.join(dir,'MANAGED_HIDE_DENIED'),'1');
  const hideStart=calls().length;
  const hideFailed=await publisher.run(state());
  // ★★ 2026-10-15 口径变更（旧断言「标记写失败必须阻断」已被推翻）：所谓「隔离标记」只是
  //   **手段**，判据始终是「全盘四表复查为空 + 推送后 albumMatches 一致」。
  //   上一批目录的 .nomedia 写不进去时，clearAlbum 会兜到同一件事
  //   （给那个批次目录自己写标记 + 删索引 + 重扫复查），此时相册确实干净 ⇒ 应当继续发布；
  //   只有当兜底也做不到（复查仍有记录）时才允许停下批次。
  ok('上一批目录标记写失败时由全盘复查兜底：相册确实干净就继续发布，不无谓停批',
    hideFailed.failCount===0 && hideFailed.okCount===1
      && !calls().slice(hideStart).some(c=>/am force-stop/.test(c)));
  fs.unlinkSync(path.join(dir,'MANAGED_HIDE_DENIED'));

  // ==========================================================================
  // ★★★ 2026-10-15 新增：rich 现场的三条决定性用例（旧路径 / 防误伤 / 重扫复活）
  //   前三条在真机 MuMu 上逐一复算过（rm/mv 全 busy，只有 .nomedia 能穿过；删掉标记再扫记录立刻回来）。
  // ==========================================================================
  {
    // ① rich 的旧路径：素材在 DCIM/Camera/bluev（1404 及更早版本留下的位置），
    //    被句柄占住时也必须能隔离 + 删索引 + 放行 —— 这是所有老设备升级后的共同现场。
    await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/bluev/旧版本残留.mp4');
    await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/bluev/旧版本残留.mp4');
    fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'旧版本残留');
    const legacyStart=calls().length;
    const legacy=await adb.clearAlbum('FAKE');
    const legacyTrace=calls().slice(legacyStart);
    ok('rich 旧路径（DCIM/Camera/bluev）占用中：隔离 + 删索引后照常放行，物理文件如实待回收',
      legacy.ok && legacy.physicalPending.length===1
      && legacyTrace.some(c=>/touch '\/storage\/emulated\/0\/DCIM\/Camera\/bluev\/\.nomedia'/.test(c))
      && legacyTrace.some(c=>/content delete/.test(c)));
    // ② 占用一释放，延后回收必须真的把物理文件删掉并撤掉隔离标记
    //    （只隔离不删除会白占用户磁盘；标记留着则会让该目录以后推什么都进不了相册）。
    fs.unlinkSync(path.join(dir,'MEDIA_HELD'));
    const reclaimed=await adb.clearAlbum('FAKE');
    ok('占用释放后延后回收真的删掉物理文件、撤掉 .nomedia（隔离不是永久占着磁盘）',
      reclaimed.ok && reclaimed.physicalPending.length===0
      && ![...fakeAdb.__physicalMedia].some(p=>/旧版本残留/.test(p)));
    // ③ 反向对照：没被占用的素材必须**当场**真的删掉，不能一律改成「只隔离」拖延。
    await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/bluev/空闲残留.mp4');
    const scanIdle=await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/bluev/空闲残留.mp4');
    const idle=await adb.clearAlbum('FAKE');
    ok('没被占用的素材当场真的删掉（只隔离不删会白占用户磁盘）',
      scanIdle.ok && idle.ok && idle.physicalPending.length===0
      && ![...fakeAdb.__physicalMedia].some(p=>p.includes('空闲残留')));
    // ④ 防误伤：素材直接在 Movies/BlueV 根（本批新素材的落地目录）⇒ 绝不允许写根 .nomedia，
    //    清不掉时如实停批，而不是把本条要发的新素材一起隐藏。
    await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/Movies/BlueV/根上残留.mp4');
    await adb.mediaScan('FAKE','/sdcard/Movies/BlueV/根上残留.mp4');
    fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'根上残留');
    const rootStart=calls().length;
    const rootHeld=await adb.clearAlbum('FAKE');
    ok('素材落在本批落地目录（Movies/BlueV 根）时绝不写根 .nomedia：如实停批，不隐藏新素材',
      !rootHeld.ok && rootHeld.left===1 && rootHeld.code==='ALBUM_ISOLATION_FAILED'
      && !calls().slice(rootStart).some(c=>/touch '\/storage\/emulated\/0\/Movies\/BlueV\/\.nomedia'/.test(c)));
    fs.unlinkSync(path.join(dir,'MEDIA_HELD'));
    await adb.clearAlbum('FAKE');
    // ④ 重扫复活的反面证据：隔离标记写进去之后，全盘扫描**不能**把记录扫回来。
    await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/复活验证.jpg');
    await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/复活验证.jpg');
    fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'复活验证');
    const res=await adb.clearAlbum('FAKE');
    const after=await adb.mediaScan('FAKE','');
    const lib=await adb.shell('FAKE','content query --uri content://media/external/images/media --projection _id:_data');
    ok('隔离后重扫不复活：相册判据是"索引里没有它"，不是"磁盘文件没了"',
      res.ok===true && after.ok===true && !/复活验证/.test(String(lib.stdout||'')));
    fs.unlinkSync(path.join(dir,'MEDIA_HELD'));
    await adb.clearAlbum('FAKE');
    ok('占用释放后待回收文件被真正删掉（隔离不是永久占着磁盘）',
      ![...fakeAdb.__physicalMedia].some(p=>/复活验证|旧版本残留|根上残留/.test(p)));

    // ========================================================================
    // ★★★ 2026-10-15 新增（rich 的**第二种现场**，与上面「删索引成功」那条不同）：
    //   `content delete` 回 139 且**空输出**（真机长期现象：得物内容提供者删完就崩），
    //   与此同时文件还**被句柄占住**（`rm` 报 Text file busy）。这两件事在 rich 的日志里是
    //   同时出现的，而旧收尾逻辑只看「物理文件在不在」、不看「隔离标记是否已确认」：
    //   隔离明明写进去了、四表复查也是空的，它仍然以「物理文件缺失未确认」停批。
    //   新口径：**隔离已确认 = 相册确实看不到它**（重扫不会复活），物理文件删不掉只记
    //   「待回收」，本条照常发布；只有隔离**没**确认时，「物理文件还在」才真的意味着会被扫回来。
    // ========================================================================
    await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/bluev/139占用残留.mp4');
    await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/bluev/139占用残留.mp4');
    fs.writeFileSync(path.join(dir,'MEDIA_HELD'),'139占用残留');
    fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'after');
    const comboStart=calls().length;
    const combo=await publisher.run(state());
    const comboTrace=calls().slice(comboStart);
    ok('139空输出 + 句柄占用同时出现：隔离已确认时照常发布，物理文件如实记待回收，不强停得物',
      combo.okCount===1&&combo.failCount===0
      && comboTrace.some(c=>/touch '\/storage\/emulated\/0\/DCIM\/Camera\/bluev\/\.nomedia'/.test(c))
      && !comboTrace.some(c=>/am force-stop/.test(c)));
    fs.unlinkSync(path.join(dir,'DELETE_EXIT_139'));
    fs.unlinkSync(path.join(dir,'MEDIA_HELD'));
    await adb.clearAlbum('FAKE');
    ok('139+占用组合解除后：物理文件被真正删掉、隔离标记被撤（不靠假成功掩盖磁盘残留）',
      ![...fakeAdb.__physicalMedia].some(p=>/139占用残留/.test(p)));
  }

})().catch(e => { console.error(e); process.exitCode = 1; });
