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
  ok('两张图就绪后只提交一条，继续复用相机目录', normal.okCount === 1 && normal.failCount === 0
    && trace.filter(c => /\bpush /.test(c)).length === 2
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
  ok('上一条物理文件短暂占用：不先删索引掩盖失败，自然恢复后才推送提交', recovered.okCount===1
    && secondRm>firstRm && !busyTrace.slice(firstRm+1,secondRm).some(c=>/content delete|\bpush /.test(c))
    && !busyTrace.some(c=>/am force-stop/.test(c)));
  fs.writeFileSync(path.join(dir,'DIR_LOCKED_BY_APP'),'1');
  const lockedStart=calls().length;
  const locked=await publisher.run(state());
  ok('持续占用不会被伪装为成功：有限恢复后如实保留busy原因，不推送、不提交、不强停',locked.failCount===1
    && /rm:busy/.test(locked.rows[0].reason) && /恢复=3次/.test(locked.rows[0].reason)
    && !calls().slice(lockedStart).some(c=>/\bpush |input tap|am force-stop/.test(c)));
  fs.unlinkSync(path.join(dir,'DIR_LOCKED_BY_APP'));
  fs.writeFileSync(path.join(dir,'DELETE_LAG_ROUNDS'),'1');
  const delayed=await publisher.run(state());
  ok('物理删除后索引暂未回收：不能把Deleted 0当作清空，实际复查收敛后完成',delayed.okCount===1&&delayed.failCount===0);
  fs.writeFileSync(path.join(dir,'MEDIA_PERMISSION_DENIED'),'1');
  const deniedStart=calls().length;
  const denied=await publisher.run(state());
  const deniedTrace=calls().slice(deniedStart);
  ok('权限拒绝立即给出具体原因，不盲目恢复、不删除索引、不推送',denied.failCount===1
    && /permission/.test(denied.rows[0].reason) && !deniedTrace.some(c=>/content delete|\bpush |input tap/.test(c)));
  fs.unlinkSync(path.join(dir,'MEDIA_PERMISSION_DENIED'));
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
  const navIndex=overlapTrace.findIndex(c=>/input tap 150 150/.test(c));
  const scanIndex=overlapTrace.map((c,i)=>/--method scan_volume/.test(c)?i:-1).reduce((a,b)=>Math.max(a,b),-1);
  const entryIndex=overlapTrace.findIndex(c=>/input tap 200 200/.test(c));
  ok('清理期间仅并行进入个人主页，发布新动态及素材推送必须等待清理收敛',overlap.okCount===1
    && navIndex>=0&&navIndex<scanIndex&&entryIndex>scanIndex
    && overlapTrace.findIndex(c=>/\bpush /.test(c))>scanIndex);
  fs.writeFileSync(path.join(dir,'MEDIA_PERMISSION_DENIED'),'1');
  const overlapFailStart=calls().length;
  const overlapFailed=await publisher.run(state());
  ok('并行清理失败保留首个真实原因，取消导航不覆盖permission且不进发布入口',overlapFailed.failCount===1
    && /permission/.test(overlapFailed.rows[0].reason)
    && !calls().slice(overlapFailStart).some(c=>/input tap 200 200|\bpush /.test(c)));
  fs.unlinkSync(path.join(dir,'MEDIA_PERMISSION_DENIED'));
  store.set({publish:{uiMap:originalMap}});fs.writeFileSync(xmlFile,originalXml);
  fs.writeFileSync(path.join(dir,'DELETE_EXIT_139'),'after');
  fs.writeFileSync(path.join(dir,'QUERY_EXIT_139'),'1');
  fs.writeFileSync(path.join(dir,'SCAN_EXIT_139_AFTER_WRITE'),'1');
  const crashAfter=await publisher.run(state());
  ok('生产入口：删除已生效但命令139空输出，必须通过扫描回读确认后继续',crashAfter.okCount===1&&crashAfter.failCount===0);
  fs.unlinkSync(path.join(dir,'DELETE_EXIT_139'));
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
  fs.writeFileSync(path.join(dir,'RM_SILENT_KEEP'),'1');
  const physicalStart=calls().length;
  const physicalLeft=await publisher.run(state());
  ok('139且库暂空但物理文件仍在，不以空库伪装清理成功',physicalLeft.failCount===1
    && /物理文件缺失未确认/.test(physicalLeft.rows[0].reason)
    && !calls().slice(physicalStart).some(c=>/\bpush |input tap/.test(c)));
  fs.unlinkSync(path.join(dir,'DELETE_EXIT_139'));fs.unlinkSync(path.join(dir,'RM_SILENT_KEEP'));
  fs.unlinkSync(path.join(dir,'QUERY_EXIT_139'));fs.unlinkSync(path.join(dir,'SCAN_EXIT_139_AFTER_WRITE'));
})().catch(e => { console.error(e); process.exitCode = 1; });
