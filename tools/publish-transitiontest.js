'use strict';
// 通过真实 publisher.run 验证慢页面；只替换设备进程 adapter。
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module'), assert = require('assert');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-publish-transition-'));
const load = Module._load;
Module._load = function(name) { return name === 'electron' ? { app: { getPath: () => tmp, isPackaged: false } } : load.apply(this, arguments); };
const dir = path.join(tmp, 'fakeadb'); fs.mkdirSync(dir);
for (const file of fs.readdirSync(path.join(__dirname, 'fakeadb'))) fs.copyFileSync(path.join(__dirname, 'fakeadb', file), path.join(dir, file));
fs.writeFileSync(path.join(dir, 'IME_ACTIVE'), '1');
const HOME = 'com.shizhuang.duapp/.modules.home.ui.HomeActivity';
const PUB = 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
const D = 'com.shizhuang.duapp:id/';
const node = (id, x, text = '', enabled = true) => `<node resource-id="${D+id}" text="${text}" enabled="${enabled}" bounds="[${x-10},90][${x+10},110]"/>`;
const page = (xml, focus = PUB) => { fs.writeFileSync(path.join(dir, 'window.xml'), '<hierarchy>'+xml+'</hierarchy>'); fs.writeFileSync(path.join(dir, 'FOCUS'), focus); };
let observe = () => {}, timers = [];
const later = (fn, ms) => timers.push(setTimeout(fn, ms));
const fake = require('./fakeadb/adb').makeFakeAdb(dir);
require('child_process').execFile = (bin, args, opts, cb) => fake(bin, args, opts, (error, stdout, stderr) => { if (!error) observe(args.join(' ')); cb(error, stdout, stderr); });
const store = require('../src/main/store'), publisher = require('../src/main/services/publisher');
const itemDir = path.join(tmp, '素材'); fs.mkdirSync(itemDir); fs.writeFileSync(path.join(itemDir, '1.jpg'), '测试文件');
const state = map => ({ items: [{ id: 'A', dir: itemDir, absDir: itemDir, files: [{ name: '1.jpg', type: 'image' }] }], copyRows: [{ id: 'A', title: '标题', body: '正文', topics: [] }], verify: { rows: [] }, publish: { mode: 'adb', device: 'FAKE', uiMap: map, rows: [{ seq: 1, id: 'A', dir: 'A', result: '' }] } });
store.set({ paths: { output: path.join(tmp, '输出') }, publish: { intervalSec: 0, device: 'FAKE', submissionWaitMs: 1000 } });
const tap = (id, name = id) => ({ name, action: 'tapId', value: D+id });
const submit = tap('submit', '提交发布');
async function run(map, options = {}) {
  const batch = state(map);
  if (options.video) { batch.items[0].files = [{ name: '1.mp4', type: 'video' }]; fs.writeFileSync(path.join(itemDir, '1.mp4'), '测试视频'); }
  if (options.fallback) batch.publish.forceAlternateEntry = true;
  if (options.completed) batch.publish.rows.push({ seq: 99, id: 'old', dir: '此前已发布', result: '发布成功' });
  try { return await publisher.run(batch); } finally { timers.forEach(clearTimeout); timers = []; }
}
(async () => {
  page(node('rlPublish', 200), HOME);
  let selectedTooEarly = false, ready = false;
  observe = command => {
    if (/input tap 200 100/.test(command)) later(() => { ready = true; page(node('photo', 350)+node('submit', 400)); }, 2000);
    if (/input tap 350 100/.test(command) && !ready) selectedTooEarly = true;
    if (/input tap 400 100/.test(command)) page('', HOME);
  };
  const result = await run({ steps: [tap('rlPublish'), tap('photo'), submit] }, {completed:true});
  assert.equal(result.okCount, 1, JSON.stringify(result.rows));
  assert.equal(selectedTooEarly, false);
  console.log('PASS 主入口相册延迟加载时确认换屏后才选材并提交');
  page(node('rlPublish', 200), HOME);
  let stage = 'home', nextClicks = 0;
  observe = command => {
    if (/input tap 200 100/.test(command)) { stage = 'album'; page(node('flThumbSelect', 350)+node('tvNextStep', 500, '下一步(1)')); }
    if (/input tap (?:500 100|985 1843)/.test(command)) {
      nextClicks++;
      if (stage === 'album') { stage = 'moving'; later(() => { stage = 'edit'; page(node('edit_panel', 450)+node('tvNextStep', 500, '下一步(1)')); }, 1800); }
      else if (stage === 'edit') { stage = 'moving'; later(() => { stage = 'title'; page(node('etTitle', 600, '标题')+node('submit', 400)); }, 1800); }
    }
    if (/input tap 400 100/.test(command)) page('', HOME);
  };
  const old = await run({ steps: [{ name: '确认入口', action: 'transition', until: D+'rlPublish', timeout: 1000 }, tap('rlPublish'), tap('flThumbSelect', '选中要发的图'), { name: '下一步', action: 'tapXY', value: '985,1843' }, tap('etTitle'), { name: '标题', action: 'input', value: '${title}' }, submit] });
  assert.equal(old.okCount, 1, JSON.stringify(old.rows));
  assert.equal(nextClicks, 2, '两次点击必须分别发生在相册页和图片编辑页');
  console.log('PASS 旧图文表在真实发布入口自动加固，慢转场逐屏确认后才填写标题');
  page(node('rlPublish', 200), HOME);
  observe = command => {
    if (/input tap 200 100/.test(command)) {
      page(node('tvRelevantProduct', 650, '关联好物', false)+node('submit', 400));
      later(() => page(node('tvRelevantProduct', 650, '关联好物')+node('submit', 400)), 1200);
    }
    if (/input tap 400 100/.test(command)) page('', HOME);
  };
  const goods = await run({ steps: [tap('rlPublish'), { ...tap('tvRelevantProduct'), waitEnabled: true, waitEnabledTries: 5 }, submit] });
  assert.equal(goods.okCount, 1, JSON.stringify(goods.rows));
  console.log('PASS 关联好物由禁用变为可用后继续，不因刷新节点崩溃');
  page(node('rlPublish',200),HOME);
  observe = command => {
    if (/input tap 200 100/.test(command)) page(node('ivProduct',650));
    if (/input tap 650 100/.test(command)) later(()=>page(node('etTitle',600)+node('submit',400)),2000);
    if (/input tap 400 100/.test(command)) page('',HOME);
  };
  const productReturn = await run({steps:[tap('rlPublish'),tap('ivProduct'),submit]});
  assert.equal(productReturn.okCount,1,JSON.stringify(productReturn.rows));
  console.log('PASS 选择好物后等待返回文案编辑页，再继续提交');
  // 已抓取并加固的图文表被视频复用时，必须按视频确认剪辑和封面。
  const { PNG } = require('pngjs');
  const png = new PNG({ width: 1080, height: 2400 });
  for (let y = 0; y < 2400; y++) for (let x = 0; x < 1080; x++) { const i = (y*1080+x)*4; png.data[i] = (x+y)%200; png.data[i+1] = x%200; png.data[i+2] = y%200; png.data[i+3] = 255; }
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG.sync.write(png));
  const boundsNode = (id, bounds, text = '') => `<node resource-id="${D+id}" text="${text}" enabled="true" bounds="${bounds}"/>`;
  const coverPage = node('tvTitle', 750, '设置封面')+boundsNode('titleBar','[0,0][1080,100]')+boundsNode('fl_bottom','[0,2200][1080,2400]')+boundsNode('image_frame','[50,2240][150,2280]')+node('tvNextStep',700,'下一步');
  const finalPage = node('etTitle',600,'标题')+node('submit',400)+boundsNode('ivVideoCover','[10,200][256,456]');
  page(node('rlPublish',200), HOME); stage = 'home';
  observe = command => {
    if (/input tap 200 100/.test(command)) { stage = 'album'; page(node('flThumbSelect',350)+node('tvNextStep',500,'下一步(1)')); }
    if (/input tap 500 100/.test(command)) {
      if(stage==='album') { stage='moving'; later(()=>{stage='clip';page(node('editVideoView',450)+node('tvNextStep',500,'下一步(1)'));}, 900); }
      else if(stage==='clip') { stage='moving'; later(()=>{stage='cover';page(coverPage);},900); }
    }
    if (/input tap 700 100/.test(command)) {
      if(stage==='cover') { stage='coverEdit';page(node('tvTitle',750,'编辑封面')+boundsNode('fl_cover','[10,200][800,1200]')+node('tvNextStep',700,'下一步')); }
      else if(stage==='coverEdit') { stage='title';page(finalPage); }
    }
    if (/input tap 400 100/.test(command)) page('', HOME);
  };
  const sharedMap = require('../src/main/services/uimapshape').harden({ steps: [tap('rlPublish'), tap('flThumbSelect','选中要发的图'), tap('etTitle'), {name:'标题',action:'input',value:'${title}'}, submit] }).map;
  const video = await run(sharedMap, {video:true});
  assert.equal(video.okCount,1,JSON.stringify(video.rows));
  console.log('PASS 视频复用图文表按视频目标逐屏确认并完成封面核验');
  for (const fallback of [false, true]) for (const videoKind of [false, true]) {
    const browse = node('tab_user',100)+node('tvGoHomePage',150)+node('rlPublish',200)+node('tab_trends',250)+node('ivCamera',300);
    page(browse,HOME);
    fs.writeFileSync(path.join(dir,'BACK_HOME'),'1');
    let unsafe = 0, clicked = 0;
    observe = command => {
      if (/input tap (?:200|300) 100/.test(command)) page(node('flThumbSelect',350)+node('tvNextStep',500,'下一步(1)'));
      if (/input tap 500 100/.test(command)) clicked++;
      if (/input tap (?:600|400) 100|ADB_INPUT_TEXT/.test(command)) unsafe++;
    };
    const stalled = await run({steps:[tap('tab_user'),tap('tvGoHomePage'),tap('rlPublish'),tap('flThumbSelect'),{name:'选材后的转场',action:'transition',until:videoKind?'设置封面':D+'etTitle',from:D+'flThumbSelect',timeout:1200,maxClicks:2},tap('etTitle'),{name:'标题',action:'input',value:'${title}'},submit]}, {fallback,video:videoKind});
    assert.equal(stalled.failCount,1); assert(stalled.stoppedReason); assert.equal(unsafe,0); assert.equal(clicked,1);
    console.log(`PASS ${fallback?'备用':'主'}入口${videoKind?'视频':'图文'}未确认换屏时停止，不重复下一步、不填标题、不提交`);
  }
  // 备用入口起手就是上一轮中断留下的「是否继续编辑」弹窗：必须点「放弃」再进动态。
  {
    const resumeTitle = `<node resource-id="${D}tv_title" text="是否继续编辑" enabled="true" bounds="[450,710][630,750]"/>`;
    const resumeBody = `<node resource-id="${D}tvContent" text="你有未编辑完的图文动态，是否继续？" enabled="true" bounds="[320,770][760,810]"/>`;
    const resumeCancel = `<node resource-id="${D}tvCancel" text="放弃" clickable="true" enabled="true" bounds="[339,1173][531,1247]"/>`;
    const browse = node('tab_user',100)+node('tvGoHomePage',150)+node('rlPublish',200)+node('tab_trends',250)+node('ivCamera',300);
    page(browse, HOME);
    let cancelTaps = 0, trendsTaps = 0, cameraTaps = 0, submitTaps = 0;
    observe = command => {
      if (/input tap 100 100/.test(command)) page(node('personal',110), 'com.shizhuang.duapp/com.shizhuang.duapp.modules.personal.ui.home.PersonalActivity');
      if (/input keyevent (?:4|KEYCODE_BACK)/.test(command)) page(resumeTitle+resumeBody+resumeCancel, HOME);
      if (/input tap 435 1210/.test(command)) { cancelTaps++; page(node('tab_trends',250)+node('ivCamera',300), HOME); }
      if (/input tap 250 100/.test(command)) { trendsTaps++; page(node('ivCamera',300), HOME); }
      if (/input tap 300 100/.test(command)) { cameraTaps++; page(node('flThumbSelect',350)+node('tvNextStep',500,'下一步(1)'), PUB); }
      if (/input tap 350 100/.test(command)) page(node('flThumbSelect',350)+node('tvNextStep',500,'下一步(1)'), PUB);
      if (/input tap 500 100/.test(command)) page(node('etTitle',600,'标题')+node('submit',400), PUB);
      if (/input tap 400 100/.test(command)) { submitTaps++; page('', HOME); }
    };
    const recovered = await run({ steps: [tap('tab_user'), tap('tvGoHomePage'), tap('rlPublish'), tap('flThumbSelect'), { name:'选图转场', action:'transition', until:D+'etTitle', from:D+'flThumbSelect', timeout:1200, maxClicks:2 }, tap('etTitle'), { name:'标题', action:'input', value:'${title}' }, submit] }, {fallback:true});
    assert.equal(recovered.okCount,1,JSON.stringify(recovered.rows));
    assert.equal(cancelTaps,1,'必须先点一次「放弃」关闭未完成内容提示');
    assert.equal(trendsTaps,1,'关闭提示后才进「动态」页签');
    assert.equal(cameraTaps,1,'进动态后才点相机');
    assert.equal(submitTaps,1,'入口弹窗清理后应正常提交');
    console.log('PASS 备用入口起手遇到「是否继续编辑」先点放弃，再进动态并完成发布');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
