// 实际浏览器加载完整网页：6151 条发布数据，分页统计与明细翻页行为。
const { app, BrowserWindow } = require('electron');
require('./test-runtime')({ app });
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-board-')));
app.disableHardwareAcceleration();
let fail = 0, pages = 0;
const ok = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const rows = Array.from({ length: 6151 }, (_, i) => ({ id:i+1,ts:Date.now()-i*1000,machine_id:'m1',machine_name:'电脑',user_id:'u'+i%2,username:'账号'+i%2,display_name:'同名',brand_id:'b'+i%2,brand_name:'品牌'+i%2,seq:i+1,result:i%2?'失败':'发布成功' }));
const runRows = [
  { id:1,event_id:'r1',ts:Date.now()-1000,machine_id:'m1',machine_name:'电脑',event_kind:'end',task_type:'copy.generate',brand_id:'b0',brand_name:'品牌0',user_id:'u0',username:'账号0',display_name:'同名',ok:true,
    api_usage:{ version:1,requests:2,unreportedRequests:0,inputTokens:1200,outputTokens:400,cachedInputTokens:0,estimatedCostCny:0.005,costKnown:true,byMedia:{image:{requests:2,unreportedRequests:0,inputTokens:1200,outputTokens:400,cachedInputTokens:0,estimatedCostCny:0.005,costKnown:true}} } },
  { id:2,event_id:'r2',ts:Date.now()-2000,machine_id:'m1',machine_name:'电脑',event_kind:'end',task_type:'copy.generate',brand_id:'b0',brand_name:'品牌0',user_id:'u0',username:'账号0',display_name:'同名',ok:true,
    api_usage:{ version:1,requests:1,unreportedRequests:0,inputTokens:800,outputTokens:300,cachedInputTokens:0,estimatedCostCny:0.003,costKnown:false,byMedia:{video:{requests:1,unreportedRequests:0,inputTokens:800,outputTokens:300,cachedInputTokens:0,estimatedCostCny:0.003,costKnown:false}} } },
  { id:3,event_id:'r3',ts:Date.now()-3000,machine_id:'m2',machine_name:'另一台电脑',event_kind:'end',task_type:'copy.generate',brand_id:'b1',brand_name:'品牌1',user_id:'u1',username:'账号1',display_name:'同名',ok:true,
    api_usage:{ version:1,requests:1,unreportedRequests:1,inputTokens:500,outputTokens:100,cachedInputTokens:0,estimatedCostCny:0,costKnown:false,byMedia:{text:{requests:1,unreportedRequests:1,inputTokens:500,outputTokens:100,cachedInputTokens:0,estimatedCostCny:0,costKnown:false}} } },
  { id:4,event_id:'r4',ts:Date.now()-4000,machine_id:'m2',machine_name:'另一台电脑',event_kind:'end',task_type:'copy.generate',brand_id:'b1',brand_name:'品牌1',user_id:'u1',username:'账号1',display_name:'同名',ok:true,api_usage:null }
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/rest/v1/')) {
    let data = url.pathname.endsWith('/publish_log') ? rows.slice() : (url.pathname.endsWith('/run_log') ? runRows.slice() : []);
    for (const v of url.searchParams.getAll('id')) { const n=Number(v.slice(v.indexOf('.')+1)); data=data.filter(e=>v.startsWith('gt.')?e.id>n:e.id<=n); }
    data.sort((a,b)=>url.searchParams.get('order')==='id.desc'?b.id-a.id:a.id-b.id);
    if (url.searchParams.get('select') !== 'id' && url.pathname.endsWith('/publish_log')) pages++;
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data.slice(0,Number(url.searchParams.get('limit'))||1000))); return;
  }
  const file = url.pathname === '/' ? 'board.html' : url.pathname.slice(1);
  if (!['board.html','metrics.js','vendor/supabase.js'].includes(file)) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(path.join(__dirname,'../web',file),'utf8');
  if (file==='board.html') body=body.replace('https://rywurhpkovyjpjyvfjdz.supabase.co','http://127.0.0.1:'+server.address().port);
  res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':'application/javascript'); res.end(body);
});
app.whenReady().then(async () => {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const win = new BrowserWindow({ show:false, width:1280,height:1000, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
  await win.loadURL('http://127.0.0.1:'+server.address().port);
  for(let i=0;i<100;i++) { if(await win.webContents.executeJavaScript("!document.querySelector('#main').hidden")) break; await new Promise(r=>setTimeout(r,100)); }
  const result = await win.webContents.executeJavaScript(`(() => {
    const $=s=>document.querySelector(s);
    const total=Number($('#tAccounts tbody').textContent.replace(/[^0-9]/g,''));
    const sum=id=>[...document.querySelectorAll(id+' tbody tr')].reduce((n,tr)=>n+Number(tr.cells[1].textContent),0);
    const first=$('#tRows tbody tr').cells[5].textContent;
    $('#nextRows').click(); const second=$('#tRows tbody tr').cells[5].textContent;
    for(let i=0;i<35;i++) $('#nextRows').click();
    return { visible:!$('#main').hidden, accounts:$('#tAccounts tbody').rows.length, brands:$('#tBrands tbody').rows.length,
      accountSum:sum('#tAccounts'), brandSum:sum('#tBrands'), first,second,last:$('#tRows tbody').lastElementChild.cells[5].textContent,
      lastCount:$('#tRows tbody').rows.length, nextDisabled:$('#nextRows').disabled, label:$('#rowsPage').textContent };
  })()`);
  ok('网页实际加载全部分页，超过 5000 条',result.visible && pages>=7);
  ok('网页全部账号汇总合计 6151',result.accounts===2 && result.accountSum===6151);
  ok('网页全部品牌汇总合计 6151',result.brands===2 && result.brandSum===6151);
  ok('明细实际点击下一页显示第 201 条',result.first==='1' && result.second==='201');
  ok('末页可看到第 6151 条，分页没有隐藏历史',result.last==='6151' && result.lastCount===151 && result.nextDisabled);
  ok('明细显示总条数和总页数',/31 \/ 31/.test(result.label) && /6151/.test(result.label));
  const filter = await win.webContents.executeJavaScript(`(() => {
    const el=document.querySelector('#fUser'); const choices=el.options.length;
    el.value='u0'; el.dispatchEvent(new Event('change'));
    const trs=document.querySelectorAll('#tAccounts tbody tr');
    const single=trs.length===1 && trs[0].cells[1].textContent==='3076';
    el.value=''; el.dispatchEvent(new Event('change')); return { choices,single };
  })()`);
  ok('网页同名账号可按独立账号筛选',filter.choices===3 && filter.single);
  const api = await win.webContents.executeJavaScript(`(() => {
    const $=s=>document.querySelector(s), total=()=>$('#apiKpis').textContent.replace(/\\s+/g,' ').trim();
    const table=()=>[...$('#tApiUsage tbody').rows].map(r=>[...r.cells].map(c=>c.textContent.trim()));
    const all={kpis:total(),rows:table(),notice:$('#apiUsageNotice').textContent};
    $('#fUser').value='u0'; $('#fUser').dispatchEvent(new Event('change'));
    const user={rows:table(),notice:$('#apiUsageNotice').textContent};
    $('#fUser').value=''; $('#fBrand').value='b1'; $('#fBrand').dispatchEvent(new Event('change'));
    const brand={rows:table(),notice:$('#apiUsageNotice').textContent};
    $('#fBrand').value=''; $('#fDays').value='1'; $('#fDays').dispatchEvent(new Event('change'));
    const day={rows:table()};
    return {all,user,brand,day};
  })()`);
  ok('AI 用量按账号与品牌分组，区分图文/视频/纯文本及费用未知状态',api.all.rows.length===2
    && api.all.rows.some(r=>r[0]==='同名 / 账号0 / 品牌0' && r[1]==='3' && r[2]==='2,000' && r[3]==='700' && r[4]==='0' && r[5]==='2' && r[6]==='1' && r[8].startsWith('至少 ¥'))
    && api.all.rows.some(r=>r[0]==='同名 / 账号1 / 品牌1' && r[1]==='1' && r[8]==='未计价'),JSON.stringify(api.all.rows));
  ok('旧任务与未返回用量分别标注，不伪装成 0 元',/1 个任务没有用量记录/.test(api.all.notice) && /1 个请求未返回 token 用量/.test(api.all.notice));
  ok('账号筛选同步过滤 AI token 用量',api.user.rows.length===1 && api.user.rows[0][1]==='3');
  ok('品牌筛选按品牌 ID 过滤 AI token 用量',api.brand.rows.length===1 && api.brand.rows[0][0].endsWith('品牌1'));
  ok('时间筛选同步过滤 AI token 用量',api.day.rows.length===2);
  ok('部分请求未知费率时仍保留其余请求的已估算费用',api.all.rows.some(r=>r[0]==='同名 / 账号0 / 品牌0' && r[8]==='至少 ¥0.0080'));
  await win.webContents.executeJavaScript("document.querySelector('#prevRows').click()");
  fs.writeFileSync(path.join(os.tmpdir(),'bluev-board-test.png'),(await win.webContents.capturePage()).toPNG());
  win.destroy(); server.close(); app.exit(fail?1:0);
}).catch(e=>{console.error(e);server.close();app.exit(1);});
