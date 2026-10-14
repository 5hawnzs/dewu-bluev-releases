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
const focus = path.join(dir, 'FOCUS');
const windowFile = path.join(dir, 'window.xml');
const baseXml = fs.readFileSync(windowFile, 'utf8');
const draftXml = baseXml.replace('</hierarchy>', '<node resource-id="com.shizhuang.duapp:id/iv_draft_title" text="草稿箱" enabled="true" bounds="[0,0][1080,100]"/><node resource-id="com.shizhuang.duapp:id/fl_publish" text="发布新动态" enabled="true" bounds="[400,2250][680,2350]"/></hierarchy>');
const setPage = value => { fs.writeFileSync(focus, value); fs.writeFileSync(windowFile, value === DRAFT ? draftXml : baseXml); };
let submitted = 0, returns = [];
const fake = require('./fakeadb/adb').makeFakeAdb(dir);
require('child_process').execFile = (bin, args, opts, cb) => fake(bin, args, opts, (error, stdout, stderr) => {
  const command = args.join(' ');
  if (!error && /input tap 101 101/.test(command)) setPage(DRAFT);
  if (!error && /input tap 540 2300/.test(command)) setPage(PUB);
  if (!error && /input tap 162 160/.test(command)) setPage(returns[submitted++] || HOME);
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
  const lockedStart=calls().length;
  fake.__appReset();fs.writeFileSync(path.join(dir,'DIR_LOCKED_BY_APP'),'1');setPage(HOME);
  const locked=await publisher.run(state());trace=calls().slice(lockedStart);
  ok('上一条文件被占用时不以强停解锁、不推混杂素材，失败原因保留且后续条目仍处理',locked.failCount===3
    && locked.rows.every(row=>/未清净/.test(row.reason)) && !/am force-stop|\bpush |input tap /.test(trace));
})().catch(e=>{console.error(e);process.exitCode=1;});
