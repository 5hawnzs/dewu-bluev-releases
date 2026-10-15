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
  // ★★★ 2026-10-15：retire 做的全是**建议性**动作（提前把上一批摘出索引、顺手回收）。
  //   所以这里一律用 soft 上下文：命令被超时杀掉 ⇒ 返回未成功、由调用方如实记一笔，
  //   而不是 throw 把**整批**停死。真正的判据留在随后 albumready → clearAlbum 的全盘四表复核
  //   （它自己会在相册确实不干净时如实停批）。取消仍然照旧抛「发布已取消」（那是用户意图）。
  const advCtx={...ctx,soft:true};
  // -A：改名后的隐藏目录（.batch_…）也必须列出来，否则它们永远回收不掉。
  const listing=await command(serial,'ls -1A '+quote(ROOT),advCtx);
  if(!listing.ok) {
    // ★★★ 2026-10-15（别再改回 throw）：这一步只是「把上一批目录从相册索引里摘掉」的**建议性**优化，
    //   列不出目录**不等于相册不干净** —— 真正的判据是紧接着的全盘四表复核（clearAlbum）与推送后的
    //   albumMatches。旧写法只要 ls 失败（rich 的历史现场就是**目录命令超时被杀**）就 throw，
    //   于是整整一批在第一道前置步骤停住、后面每条都被记成「未执行」，代价远大于它的收益。
    //   ⇒ 读不到就如实报出来（listed:false + 原因），交给全盘复核兜底；一条命令都不多发。
    const said=String(listing.stderr||'')+String(listing.stdout||'');
    if(/No such file or directory/.test(said))return {isolated:0,pending:0,degraded:0,listed:true,note:''};
    return {isolated:0,pending:0,degraded:0,listed:false,
      note:listing.killed?'素材批次目录列表命令超时或被终止（'+(listing.signal||'未知信号')+'），改由全盘相册复核兜底'
        :'素材批次目录列表读取失败（'+(said.trim()||'无错误详情')+'），改由全盘相册复核兜底'};
  }
  const directories=String(listing.stdout||'').trim().split(/\r?\n/)
    .map(n=>ROOT+'/'+n).filter(ownedPath);
  const owned=[];
  let degraded=0;
  for(const dir of directories) {
    const marker=await command(serial,'cat '+quote(dir+'/'+MARKER),advCtx);
    if(!marker.ok||String(marker.stdout||'').trim()!==OWNER)continue;
    const iso=await isolate(serial,dir,advCtx);
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
  return {isolated:owned.length,pending,degraded,listed:true,note:''};
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
// ROOT 一并导出：调用方（albumready → clearAlbum）要用它推算「哪些目录不许写 .nomedia」
// —— 本批新素材就落在 ROOT 下面，所以 ROOT 本身 + 它的上层会被禁。写死一份会漂。
module.exports={retire,create,ROOT};
