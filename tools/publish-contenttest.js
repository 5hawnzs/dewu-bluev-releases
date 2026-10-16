'use strict';
// 审计用例通过 publisher.run 执行真实代码，仅替换设备进程与 Electron adapter。
const fs=require('fs'),os=require('os'),path=require('path'),Module=require('module'),assert=require('assert');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bluev-transition-audit-'));
const original=Module._load;
Module._load=function(name){return name==='electron'?{app:{getPath:()=>tmp,isPackaged:false}}:original.apply(this,arguments)};
const dir=path.join(tmp,'fakeadb');fs.mkdirSync(dir);
for(const f of fs.readdirSync(path.join(root,'tools/fakeadb')))fs.copyFileSync(path.join(root,'tools/fakeadb',f),path.join(dir,f));
fs.writeFileSync(path.join(dir,'IME_ACTIVE'),'1');fs.writeFileSync(path.join(dir,'BACK_HOME'),'1');
const D='com.shizhuang.duapp:id/',HOME='com.shizhuang.duapp/.modules.home.ui.HomeActivity',PUB='com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
const node=(id,x,text='',extra='')=>`<node resource-id="${D+id}" text="${text}" enabled="true" bounds="[${x-10},90][${x+10},110]" ${extra}/>`;
const page=(nodes,focus=PUB)=>{fs.writeFileSync(path.join(dir,'window.xml'),'<hierarchy>'+nodes+'</hierarchy>');fs.writeFileSync(path.join(dir,'FOCUS'),focus)};
let observe=()=>{};const fake=require(path.join(root,'tools/fakeadb/adb')).makeFakeAdb(dir);
require('child_process').execFile=(bin,args,options,cb)=>fake(bin,args,options,(error,stdout,stderr)=>{if(!error)observe(args.join(' '));cb(error,stdout,stderr)});
const store=require(path.join(root,'src/main/store')),publisher=require(path.join(root,'src/main/services/publisher')),uimap=require(path.join(root,'src/main/services/uimap'));
const which=process.argv[2]||'recover-selection',fallback=process.argv[3]==='fallback',logs=[];
const itemDir=path.join(tmp,'素材');fs.mkdirSync(itemDir);fs.writeFileSync(path.join(itemDir,'1.mp4'),'测试视频');fs.writeFileSync(path.join(itemDir,'1.jpg'),'测试图片');
store.set({paths:{output:path.join(tmp,'输出')},publish:{device:'FAKE',intervalSec:0,submissionWaitMs:1000}});
const tap=id=>({name:id,action:'tapId',value:D+id});
const entry=[tap('tab_user'),tap('tvGoHomePage'),tap('rlPublish')];
const submit={...tap('submit'),name:'提交发布'};
let nextClicks=0,submissions=0,selected=0,inputAttempts=0;
page(node('tab_user',100)+node('tvGoHomePage',150)+node('rlPublish',200)+node('tab_trends',250)+node('ivCamera',300),HOME);
const enter=command=>{if(/input tap (?:200|300) 100/.test(command))page(node('flThumbSelect',350)+node('tvNextStep',500,'下一步'))};
let map,video=false;
if(which==='single-selection'){
 map={steps:[...entry,tap('flThumbSelect'),{name:'选图转场',action:'transition',until:D+'etTitle',from:D+'flThumbSelect',timeout:1200},tap('etTitle'),{name:'标题',action:'input',value:'${title}'},submit]};
 observe=command=>{
  if(/input tap (?:200|300) 100/.test(command))page(node('flThumbSelect',350));
  if(/input tap 350 100/.test(command))page(node('flThumbSelect',350)+node('tvNextStep',700,'下一步'));
  if(/input tap 700 100/.test(command)){nextClicks++;page(node('etTitle',600,'标题')+node('submit',400))}
  if(/input tap 400 100/.test(command)){submissions++;page('',HOME)}
 };
}
if(['unconfirmed-title','confirmed-title','recover-title'].includes(which)){
 map={steps:[...entry,tap('etTitle'),{name:'标题',action:'input',value:'${title}'},submit]};
 observe=command=>{
   if(/input tap (?:200|300) 100/.test(command))page(node('etTitle',600)+node('submit',400));
   if(/ADB_INPUT_(?:B64|TEXT)/.test(command)){inputAttempts++;page((which==='recover-title'?node('etTitle',600,inputAttempts>1?'标题':''):which==='confirmed-title'?node('etTitle',600,'标题'):'')+node('submit',400));}
   if(/input tap 400 100/.test(command)){submissions++;page('',HOME)}
 };
}
if(['partial-selection','recover-selection'].includes(which)){
 for(const name of ['2.jpg','3.jpg'])fs.writeFileSync(path.join(itemDir,name),'测试图片');
 const album=()=>node('flThumbSelect',350,'',selected?'checkable="true" checked="true"':'checkable="true" checked="false"')+node('flThumbSelect',450,'',selected>=2?'checkable="true" checked="true"':'checkable="true" checked="false"')+node('flThumbSelect',550,'',selected>=3?'checkable="true" checked="true"':'checkable="true" checked="false"')+node('tvNextStep',700,'下一步('+selected+')');
 map={steps:[...entry,{...tap('flThumbSelect'),count:'${imageCount}'},{name:'选图转场',action:'transition',until:D+'etTitle',from:D+'flThumbSelect',timeout:1200},tap('etTitle'),{name:'标题',action:'input',value:'${title}'},submit]};
 observe=command=>{
   if(/input tap (?:200|300) 100/.test(command))page(album());
   if(/input tap 350 100/.test(command)){selected=1;page(album())}
   if(which==='recover-selection' && !/input tap 350/.test(command) && /input tap 450 100/.test(command) && selected===1){selected=3;page(album())}
   if(/input tap 700 100/.test(command)){nextClicks++;page(node('etTitle',600,'标题')+node('submit',400))}
   if(/input tap 400 100/.test(command)){submissions++;page('',HOME)}
 };
}
(async()=>{
 const state={items:[{id:'A',dir:itemDir,absDir:itemDir,files:[{name:video?'1.mp4':'1.jpg',type:video?'video':'image'}]}],copyRows:[{id:'A',title:'标题',body:'正文',topics:[]}],verify:{rows:[]},publish:{mode:'adb',device:'FAKE',forceAlternateEntry:fallback,uiMap:map,rows:[{seq:1,id:'A',dir:'A',result:''}]}};
 if(['partial-selection','recover-selection'].includes(which))state.items[0].files=['1.jpg','2.jpg','3.jpg'].map(name=>({name,type:'image'}));
 const result=await publisher.run(state,{log:m=>logs.push(m)});
 const evidence={case:which,route:fallback?'fallback':'main',okCount:result.okCount,failCount:result.failCount,stoppedReason:result.stoppedReason,reason:result.rows[0].reason,nextClicks,submissions,selected,logs:logs.filter(m=>/回读不到|转场|目标屏|自动恢复/.test(m))};
 fs.writeFileSync(path.join(tmp,which+'-'+evidence.route+'.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence));
 if(which==='single-selection'){assert.equal(submissions,1);assert.equal(result.okCount,1)}
 if(which==='recover-title'){assert.equal(submissions,1);assert.equal(result.okCount,1);assert.equal(inputAttempts,2)}
 if(which==='confirmed-title'){assert.equal(submissions,1);assert.equal(result.okCount,1)}
 if(which==='unconfirmed-title')assert.equal(submissions,0,'标题回读未确认时不得继续提交');
 if(which==='recover-selection'){assert.equal(selected,3);assert.equal(submissions,1);assert.equal(result.okCount,1)}
 if(which==='partial-selection'){assert.equal(submissions,0,'补选两次仍仅1图时不得继续提交');assert(result.stoppedReason);assert(logs.filter(m=>m.includes('选材自动恢复：')).length===2)}
})().catch(e=>{console.error('发布复核回归失败：'+e.message);process.exitCode=1});

