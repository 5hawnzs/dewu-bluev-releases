'use strict';
// 每批独立目录；隔离旧批后再核实全盘相册，物理回收失败不伪装为删除成功。
const crypto=require('crypto');
const path=require('path');
const adb=require('./adb');
const ROOT='/sdcard/Movies/BlueV';
const OWNER='BLUEV_MANAGED_V1';
const MARKER='.bluev-managed-v1';
const quote=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const ownedPath=p=>/^\/sdcard\/Movies\/BlueV\/\.?batch_[a-f0-9]{32}$/.test(p);
const hiddenName=dir=>dir.replace(/\/batch_([a-f0-9]{32})$/,'/.batch_$1');
const isHiddenName=dir=>/\/\.batch_[a-f0-9]{32}$/.test(dir);
async function command(serial,cmd,ctx={}) {
  if(ctx.cancelled&&ctx.cancelled())throw new Error('发布已取消');
  const left=ctx.deadline==null?8000:ctx.deadline-Date.now();
  if(left<=0)return {ok:false,stderr:'延后回收预算已用尽'};
  const r=await adb.shell(serial,cmd,{timeout:Math.max(1,Math.min(8000,left)),deadline:ctx.deadline});
  if(r.killed&&!ctx.soft)throw new Error('素材目录命令超时，未确认隔离');
  return r;
}
// 两级隔离：先写 .nomedia；写不进就把整目录改名成点开头（媒体扫描器同样跳过点开头目录）。
// 两级都不成也**不阻断** —— 真正判据是随后 clearAlbum 全盘复核与推送后的 albumMatches，
// 只有相册里确实还有外部素材时才允许停下批次（用户口径：相册就是上一条，不会混别的素材）。
async function isolate(serial,dir,ctx) {
  const hide=await command(serial,'touch '+quote(dir+'/.nomedia'),ctx);
  const check=await command(serial,'[ -f '+quote(dir+'/.nomedia')+' ] && echo EXISTS',ctx);
  if(hide.ok&&check.ok&&String(check.stdout||'').trim()==='EXISTS')return {ok:true,dir,how:'nomedia'};
  if(isHiddenName(dir))return {ok:true,dir,how:'already-hidden'};
  const target=hiddenName(dir);
  const moved=await command(serial,'mv '+quote(dir)+' '+quote(target),ctx);
  if(moved.ok) {
    const verify=await command(serial,'if [ -d '+quote(target)+' ] && [ ! -e '+quote(dir)+' ]; then echo RENAMED; fi',ctx);
    if(verify.ok&&String(verify.stdout||'').trim()==='RENAMED')return {ok:true,dir:target,how:'renamed'};
  }
  return {ok:false,dir,how:'failed'};
}
async function retire(serial,ctx={}) {
  // -A：改名后的隐藏目录（.batch_…）也必须列出来，否则它们永远回收不掉。
  const listing=await command(serial,'ls -1A '+quote(ROOT),ctx);
  if(!listing.ok) {
    if(/No such file or directory/.test(String(listing.stderr||'')+String(listing.stdout||'')))return {isolated:0,pending:0};
    throw new Error('读取素材批次目录失败，未确认隔离：'+(listing.stderr||listing.stdout||'未知'));
  }
  const directories=String(listing.stdout||'').trim().split(/\r?\n/)
    .map(n=>ROOT+'/'+n).filter(ownedPath);
  const owned=[];
  let degraded=0;
  for(const dir of directories) {
    const marker=await command(serial,'cat '+quote(dir+'/'+MARKER),ctx);
    if(!marker.ok||String(marker.stdout||'').trim()!==OWNER)continue;
    const iso=await isolate(serial,dir,ctx);
    if(iso.ok)owned.push(iso.dir); else degraded++;
  }
  if(owned.length) {
    // 扫描回执不作为隔离成功判据；clearAlbum / albumMatches 必须全盘回读确认。
    await adb.mediaScan(serial,'');
  }
  let pending=0;
  // 每条只尽力回收三个旧目录，避免历史积压拖住发布。未回收的目录始终保留隔离标记。
  const reclaimCtx={...ctx,soft:true,deadline:Date.now()+3000};
  for(const dir of owned.slice(0,3)) {
    const listing=await command(serial,'find '+quote(dir)+' -maxdepth 1 -type f',reclaimCtx);
    if(!listing.ok){pending++;continue;}
    const files=String(listing.stdout||'').trim().split(/\r?\n/).filter(Boolean)
      .map(p=>p.replace(/^\/storage\/emulated\/0\//,'/sdcard/'));
    const media=files.filter(p=>p!==dir+'/'+MARKER&&p!==dir+'/.nomedia');
    let failed=false;
    for(const file of media.slice(0,30)) {
      if(path.posix.dirname(file)!==dir||/[\r\n\0]/.test(file)){failed=true;break;}
      const rm=await command(serial,'rm -f '+quote(file),reclaimCtx);
      if(!rm.ok)failed=true;
    }
    // 目录有残留或读不到时保留 .nomedia，不能重扫复活旧素材。
    const remaining=await command(serial,'find '+quote(dir)+' -maxdepth 1 -type f',reclaimCtx);
    const left=String(remaining.stdout||'').trim().split(/\r?\n/).filter(Boolean)
      .map(p=>p.replace(/^\/storage\/emulated\/0\//,'/sdcard/'))
      .filter(p=>p!==dir+'/'+MARKER&&p!==dir+'/.nomedia');
    if(failed||!remaining.ok||left.length){pending++;continue;}
    const removed=await command(serial,'rm -f '+quote(dir+'/'+MARKER)+' '+quote(dir+'/.nomedia'),reclaimCtx);
    const emptied=await command(serial,'rmdir '+quote(dir),reclaimCtx);
    if(!removed.ok||!emptied.ok)pending++;
  }
  pending+=Math.max(0,owned.length-3);
  return {isolated:owned.length,pending,degraded};
}
async function create(serial,ctx={}) {
  const dir=ROOT+'/batch_'+crypto.randomBytes(16).toString('hex');
  const made=await command(serial,'mkdir -p '+quote(dir),ctx);
  if(!made.ok)throw new Error('新批素材目录创建失败');
  const mark=await command(serial,'printf '+OWNER+' > '+quote(dir+'/'+MARKER),ctx);
  const check=await command(serial,'cat '+quote(dir+'/'+MARKER),ctx);
  if(!mark.ok||!check.ok||String(check.stdout||'').trim()!==OWNER)throw new Error('新批素材目录归属标记未确认');
  return dir;
}
module.exports={retire,create};
