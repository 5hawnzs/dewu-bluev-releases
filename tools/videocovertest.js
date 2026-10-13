'use strict';
const assert = require('assert'), { PNG } = require('pngjs');
const cover = require('../src/main/services/videocover');
const box = { x1: 0, y1: 0, x2: 100, y2: 100 };
function png(draw) {
  const p = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4, n = draw(x, y); p.data[i] = p.data[i + 1] = p.data[i + 2] = n; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}
assert(!cover.analyse(png(() => 0), box).ok);
assert(!cover.analyse(png(() => 255), box).ok);
assert(!cover.analyse(png((_x,y) => y > 70 ? 255 : 0), box, .68).ok);
assert(cover.analyse(png((x,y) => (x+y)%50), box).ok);
assert.throws(() => cover.analyse(null, box));
assert.throws(() => cover.analyse(png(() => 0), { ...box, x2: 200 }));
console.log('PASS 黑场、纯白、白字遮罩不能通过；有细节暗色素材可通过；截图缺失和越界明确失败');

// 用真实封面流程与真实节点解析，模拟页面先出现、帧条和预览延迟加载。
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/services/videocover.js'), 'utf8');
const ID = 'com.shizhuang.duapp:id/';
function node(id, text = '', bounds = '[0,0][100,100]') {
  return `<node resource-id="${ID + id}" text="${text}" enabled="true" bounds="${bounds}" />`;
}
const next = node('tvNextStep', '下一步', '[80,0][100,10]');
const selection = (frames = 3, bottom = true) => '<hierarchy>' + node('tvTitle','设置封面') + node('titleBar','','[0,0][100,10]') + (bottom ? node('fl_bottom','','[0,80][100,100]') : '') + Array.from({length:frames},(_,i)=>node('image_frame','','['+(10+i*20)+',82]['+(25+i*20)+',98]')).join('') + next + '</hierarchy>';
const editing = '<hierarchy>'+node('tvTitle','编辑封面')+node('fl_cover','','[10,10][90,70]')+next+'</hierarchy>';
const finalPage = '<hierarchy>'+node('ivVideoCover','','[10,10][90,80]')+'</hierarchy>';
function fixture(options = {}, code = source) {
  let clock = 0, stage = 'select', reads = 0, selectReads = 0, editReads = 0, finalReads = 0, screenshots = 0, cancelled = false;
  const taps = [], logs = [];
  const adb = {
    dumpEx: async () => {
      reads++;
      if (options.cancelOnRead === reads) cancelled = true;
      let xml;
      if (options.wrongPage) xml = '<hierarchy>'+node('tvTitle','首页')+'</hierarchy>';
      else if(stage==='select') {
        selectReads++;
        if(selectReads <= (options.dumpFailures || 0)) return {ok:false,why:'页面结构暂不可读'};
        xml=selection(selectReads <= (options.delayedFrames || 0) ? 0 : (options.frames ?? 3),!options.missingBottom);
      } else if(stage==='edit') { editReads++;xml=editReads <= (options.delayedEdit || 0) ? '<hierarchy/>' : editing; }
      else { finalReads++;xml=finalReads <= (options.delayedFinal || 0) ? '<hierarchy/>' : finalPage; }
      return {ok:true,xml};
    },
    tap: async (_serial,x,y) => { taps.push({x,y});if(y===5) stage=stage==='select'?'edit':'final';return {ok:!options.tapFailure}; },
    screencap: async () => {
      screenshots++;
      if(options.cancelOnScreenshot===screenshots)cancelled=true;
      return options.black || screenshots <= (options.delayedImage || 0) ? png(()=>0) : png((x,y)=>(x+y)%100);
    }
  };
  const m={exports:{}};
  vm.runInNewContext(code,{module:m,exports:m.exports,Buffer,console,Date:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;queueMicrotask(fn);},require:n=>n==='./adb'?adb:n==='./uimap'?require('../src/main/services/uimap'):require(n)});
  return {cover:m.exports,ctx:{cancelled:()=>cancelled,log:m=>logs.push(m)},taps,logs,info:()=>({reads,selectReads,clock,screenshots})};
}
(async()=>{
  let f=fixture({delayedFrames:4,delayedEdit:2,delayedFinal:2,delayedImage:2});
  const recovered=await f.cover.select('测试设备',f.ctx);
  assert(recovered.final.ok&&f.taps.length===3&&f.info().selectReads>=5);
  console.log('PASS 帧条、候选图、编辑页和最终缩略图延迟加载后恢复，两个下一步各只点一次');
  f=fixture({dumpFailures:2});await f.cover.select('测试设备',f.ctx);assert(f.info().selectReads>=3);
  console.log('PASS 临时结构读取失败可重新读取，不直接结束整条视频');
  f=fixture({frames:1});assert((await f.cover.select('测试设备',f.ctx)).final.ok);assert.equal(f.taps.length,3);
  console.log('PASS 单帧短视频也能选择并核验，不能因少于两帧误拒绝');
  f=fixture({wrongPage:true});await assert.rejects(()=>f.cover.select('测试设备',f.ctx),/设置封面=无/);assert.equal(f.taps.length,0);
  console.log('PASS 始终在错误页面时明确失败，不能盲点或跳过核验');
  f=fixture({missingBottom:true});await assert.rejects(()=>f.cover.select('测试设备',f.ctx),/底栏=无/);assert.equal(f.taps.length,0);
  console.log('PASS 持续缺少控件时超时明确指出缺失项，不假报就绪');
  f=fixture({black:true,frames:1});await assert.rejects(()=>f.cover.select('测试设备',f.ctx),/候选视频封面均为黑场/);assert.equal(f.taps.length,1);
  console.log('PASS 持续黑场只选择候选，不点击下一步提交');
  for(const options of [{cancelOnRead:1},{cancelOnScreenshot:1}]){
    f=fixture(options);await assert.rejects(()=>f.cover.select('测试设备',f.ctx),/已取消/);assert(!f.taps.some(t=>t.y===5));
  }
  console.log('PASS 读取结构或截图期间取消，不能继续确认封面');
  f=fixture();assert((await f.cover.select('测试设备',f.ctx)).final.ok);
  assert.equal(f.info().selectReads,2);assert.equal(f.info().clock,500);
  console.log('PASS 正常封面无额外轮询等待，仅保留原有500ms候选帧稳定等待');
})().catch(error=>{console.error(error);process.exitCode=1});
