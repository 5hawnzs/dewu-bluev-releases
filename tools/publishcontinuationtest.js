'use strict';
// 从真实批量发布入口连续执行；外部设备进程模拟首页/草稿箱两种提交返回页。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-continuation-'));
const load = Module._load;
Module._load = function(name) {
  if (name === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return load.apply(this, arguments);
};
const dir = path.join(tmp, 'fakeadb'); fs.mkdirSync(dir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(dir, file));
fs.writeFileSync(path.join(dir, 'IME_ACTIVE'), '1');
const HOME = 'com.shizhuang.duapp/.modules.home.ui.HomeActivity';
const DRAFT = 'com.shizhuang.duapp/media.activity.DraftActivity';
const PUB = 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
const PERSONAL = 'com.shizhuang.duapp/com.shizhuang.duapp.modules.personal.ui.home.PersonalActivity';
const focus = path.join(dir, 'FOCUS');
const windowFile = path.join(dir, 'window.xml');
const baseXml = fs.readFileSync(windowFile, 'utf8');
const draftXml = baseXml.replace('</hierarchy>', '<node resource-id="com.shizhuang.duapp:id/iv_draft_title" text="草稿箱" enabled="true" bounds="[0,0][1080,100]"/><node resource-id="com.shizhuang.duapp:id/fl_publish" text="发布新动态" enabled="true" bounds="[400,2250][680,2350]"/></hierarchy>');
const setPage = value => { fs.writeFileSync(focus, value); fs.writeFileSync(windowFile, value === DRAFT ? draftXml : baseXml); };
let submitted = 0, returns = [], personalStart = false, backPages = [];
let holdSubmissionMs=0, lastSubmissionAt=0, cleanupAfterSubmission=[];
const fake = require('./fakeadb/adb').makeFakeAdb(dir);
require('child_process').execFile = (bin, args, opts, cb) => fake(bin, args, opts, (error, stdout, stderr) => {
  const command = args.join(' ');
  if (personalStart && /am start/.test(command)) setPage(PERSONAL);
  if (personalStart && /input keyevent (?:4|KEYCODE_BACK)\b/.test(command)) setPage(backPages.shift() || HOME);
  if (!error && /input tap 101 101/.test(command)) setPage(DRAFT);
  if (!error && /input tap 540 2300/.test(command)) setPage(PUB);
  if (!error && /input tap 162 160/.test(command)) {
    const target=returns[submitted++]||HOME;lastSubmissionAt=Date.now();
    if(holdSubmissionMs){setPage(PUB);setTimeout(()=>setPage(target),holdSubmissionMs);}else setPage(target);
  }
  if(holdSubmissionMs&&lastSubmissionAt&&/rm -f /.test(command))cleanupAfterSubmission.push(Date.now()-lastSubmissionAt);
  cb(error, stdout, stderr);
});
const store = require('../src/main/store'), publisher = require('../src/main/services/publisher');
const itemDir = path.join(tmp, '素材'); fs.mkdirSync(itemDir); fs.writeFileSync(path.join(itemDir, '1.jpg'), '测试文件');
const steps = [
  { name: '首页发布入口', action: 'tapXY', value: '101,101' },
  { name: '草稿箱发布新动态', action: 'tapId', value: 'com.shizhuang.duapp:id/fl_publish', whenOn: 'com.shizhuang.duapp:id/iv_draft_title' },
  { name: '提交发布', action: 'tapText', value: '发布' }
];
store.set({ paths: { output: path.join(tmp, '输出') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000,
  uiMap: { package: 'com.shizhuang.duapp', steps } } });
const state = () => ({ items: [{ id: 'A', dir: itemDir, absDir: itemDir, files: [{name:'1.jpg',type:'image'}] }],
  copyRows:[{id:'A',title:'测试',body:'测试',topics:[]}], verify:{rows:[]},
  publish:{mode:'adb',device:'FAKE',rows:Array.from({length:3},(_,i)=>({seq:i+1,id:'A',dir:'A',result:''}))} });
const calls = () => fs.readFileSync(path.join(dir,'calls.log'),'utf8');
const ok = (label,value) => { assert(value,label); console.log('PASS '+label); };
(async()=>{
  store.set({ publish: { ensureAppTimeoutMs: 1200 } });
  personalStart = true; setPage(PERSONAL); returns = [HOME,HOME,HOME];
  const personal = await publisher.run(state()).catch(error => ({ error: error.message }));
  ok('云端个人主页起步：启动命令不改变旧任务栈时，App内返回首页并完成，不强停或重启', personal.okCount===3
    && /input keyevent (?:4|KEYCODE_BACK)\b/.test(calls()) && !/am force-stop|am start|monkey/.test(calls()));
  for (const start of ['com.shizhuang.duapp/.modules.product.ui.ProductDetailActivity', 'com.shizhuang.duapp/.modules.search.ui.SearchActivity',
    'com.shizhuang.duapp/com.shizhuang.cloudpix.main.CloudPixActivity']) {
    const before = calls().length;
    submitted = 0; setPage(start); backPages = [start, PERSONAL, HOME];
    const s = state(); s.publish.rows = s.publish.rows.slice(0,1);
    const result = await publisher.run(s); const trace = calls().slice(before);
    ok('其他浏览起点及同Activity内层返回收敛入口：'+start, result.okCount===1
      && (trace.match(/input keyevent 4/g)||[]).length===3 && !/am start|am force-stop|monkey/.test(trace));
  }
  for (const start of [PUB, 'com.shizhuang.duapp/.media.VideoEditActivity', 'com.shizhuang.duapp/.media.UploadActivity']) {
    const before = calls().length; setPage(start);
    const result = await publisher.run(state()).catch(error=>({error:error.message}));
    const trace = calls().slice(before);
    ok('未完成内容或上传页面不盲退、不保存草稿、不提交：'+start, !!result.error
      && /未完成内容/.test(result.error) && !/input |am start|am force-stop|\bpush /.test(trace));
  }
  {
    const before = calls().length; setPage(PERSONAL);
    fs.writeFileSync(windowFile, baseXml.replace('</hierarchy>', '<node text="是否继续编辑" resource-id="dialog" bounds="[0,0][100,100]"/></hierarchy>'));
    const result = await publisher.run(state()).catch(error=>({error:error.message}));
    ok('浏览Activity上的内容确认弹窗也不能盲退或选放弃', /确认弹窗/.test(result.error||'')
      && !/input |am start|am force-stop|\bpush /.test(calls().slice(before)));
  }
  {
    const before = calls().length; setPage(PERSONAL); backPages = Array(9).fill(PERSONAL);
    const result = await publisher.run(state()).catch(error=>({error:error.message}));
    ok('返回无效受时间及次数限制，不原地等待30秒或降级强停', /App内返回后未确认/.test(result.error||'')
      && (calls().slice(before).match(/input keyevent 4/g)||[]).length<=8
      && !/am start|am force-stop|\bpush /.test(calls().slice(before))); backPages=[];
  }
  {
    const before = calls().length; setPage('com.android.settings/.Settings'); submitted=0;
    const s=state();s.publish.rows=s.publish.rows.slice(0,1);
    const result=await publisher.run(s);const trace=calls().slice(before);
    ok('外部App起步只唤起一次得物，旧栈仍在浏览页则App内返回', result.okCount===1
      && (trace.match(/am start/g)||[]).length===1 && /input keyevent 4/.test(trace) && !/am force-stop/.test(trace));
  }
  personalStart = false; submitted = 0; fs.writeFileSync(path.join(dir,'calls.log'),'');
  {
    setPage('-'); fs.writeFileSync(path.join(dir,'TOP_FOCUS'), PUB);
    const result=await publisher.run(state()).catch(error=>({error:error.message}));
    ok('窗口焦点缺失时只认实际栈顶，后台首页不能绕过编辑页保护', /未完成内容/.test(result.error||'')
      && !/input |am start|am force-stop|\bpush /.test(calls()));
    fs.unlinkSync(path.join(dir,'TOP_FOCUS')); fs.writeFileSync(path.join(dir,'calls.log'),'');
  }
  store.set({ publish: { ensureAppTimeoutMs: 30000 } });
  setPage(HOME); returns = [DRAFT,DRAFT,HOME];
  const result = await publisher.run(state());
  let trace = calls();
  ok('提交返回草稿箱时三条连续完成，不启动、不强停、不退到桌面', result.okCount===3 && result.failCount===0 && submitted===3
    && !/am start|am force-stop|monkey|input keyevent (?:3|KEYCODE_HOME)\b/.test(trace));
  ok('草稿箱下一条直接用既有发布新动态入口，不重复首页路线', (trace.match(/input tap 101 101/g)||[]).length===1
    && (trace.match(/input tap 540 2300/g)||[]).length===3);
  const before=trace.length; submitted=0;returns=[HOME,HOME,HOME];setPage(HOME);
  const home=await publisher.run(state());trace=calls().slice(before);
  ok('提交返回首页时连续三条沿用正常入口，既不漏发也不点草稿内容',home.okCount===3 && submitted===3
    && (trace.match(/input tap 101 101/g)||[]).length===3 && !/am start|am force-stop|monkey/.test(trace));
  // 用户提出提交后仍需 3–5 秒；用真实发布入口验证等待期间不能清下一条。
  store.set({publish:{submissionWaitMs:6000}});submitted=0;returns=[HOME,HOME];setPage(HOME);
  holdSubmissionMs=3000;lastSubmissionAt=0;cleanupAfterSubmission=[];
  const uploadingState=state();uploadingState.publish.rows=uploadingState.publish.rows.slice(0,2);
  const uploading=await publisher.run(uploadingState);
  ok('提交后保持发布页三秒：等待正常返回再清下一条，连续两条成功',uploading.okCount===2
    && cleanupAfterSubmission.length>0&&Math.min(...cleanupAfterSubmission)>=2900);
  holdSubmissionMs=0;lastSubmissionAt=0;store.set({publish:{submissionWaitMs:1000}});
  const shared={};submitted=0;returns=[DRAFT,DRAFT,DRAFT];setPage(HOME);
  await publisher.run(state(),shared);
  const batchStart=calls().length;submitted=0;returns=[HOME,HOME,HOME];setPage(HOME);
  const nextBatch=await publisher.run(state(),shared);trace=calls().slice(batchStart);
  ok('复用调用上下文的新批次不误用上一批草稿箱返回页',nextBatch.okCount===3
    && (trace.match(/input tap 101 101/g)||[]).length===3);
  // 混合现场：媒体库已有上一条，但磁盘还有未索引的旧视频。不能靠强停后的重试顺带清掉。
  const adb=require('../src/main/services/adb');
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/尚未索引.mp4');
  const hiddenStart=calls().length;submitted=0;returns=[HOME,HOME,HOME];setPage(HOME);
  const hidden=await publisher.run(state());trace=calls().slice(hiddenStart);
  ok('全盘重扫新发现的未索引旧素材原地清除，不强停，三条仍连续发布',hidden.okCount===3
    && !/am force-stop|am start|monkey/.test(trace));
  await adb.push('FAKE',path.join(itemDir,'1.jpg'),'/sdcard/DCIM/Camera/外部残留.jpg');
  await adb.mediaScan('FAKE','/sdcard/DCIM/Camera/外部残留.jpg');
  const lockedStart=calls().length;
  fake.__appReset();fs.writeFileSync(path.join(dir,'DIR_LOCKED_BY_APP'),'1');setPage(HOME);
  // 持续占用是设备级故障：本条失败后停止批次，后续素材保留未执行。
  const locked=await publisher.run(state(),{busyRetryDelays:[1,2,3],busyRetryBudgetMs:12});trace=calls().slice(lockedStart);
  // ★★ 2026-10-15 口径变更（旧断言「持续占用 => 停批」是错的，rich 就是被它卡住的）：
  //   文件被占住时 `.nomedia` 能穿过占用、删掉索引后相册里就看不到它 ⇒ 本条能照常发。
  //   仍必须成立的是：不强停得物、后续条目继续执行（不再整批停摆）。
  ok('上一条文件持续占用时不再停批：隔离后照常发布，后续条目继续执行，不强停得物',
    locked.failCount===0&&locked.okCount===3&&!locked.stoppedReason
    && locked.rows.every(row=>row.result==='发布成功')&&!/am force-stop/.test(trace));
  fs.unlinkSync(path.join(dir,'DIR_LOCKED_BY_APP'));
  for(const page of ['com.shizhuang.duapp/.media.UploadActivity','com.shizhuang.duapp/.media.VideoEditActivity','com.shizhuang.duapp/.media.ClipActivity','com.shizhuang.duapp/.LoadingActivity']) {
    const before=calls().length;submitted=0;returns=[page];setPage(HOME);
    const result=await publisher.run(state());const trace=calls().slice(before);
    ok('提交落到非确定返回页不能宣布可继续或清下一条：'+page,!!result.stoppedReason&&submitted===1
      && result.rows[1].result==='未执行'&&(trace.match(/--method scan_volume/g)||[]).length>=1);
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
