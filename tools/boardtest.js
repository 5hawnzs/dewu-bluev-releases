// 实际浏览器加载完整网页：6151 条发布数据，分页统计与明细翻页行为。
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-board-')));
app.disableHardwareAcceleration();
let fail = 0, pages = 0;
const ok = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fail++; };
const rows = Array.from({ length: 6151 }, (_, i) => ({ id:i+1,ts:Date.now()-i*1000,machine_id:'m1',machine_name:'电脑',user_id:'u'+i%2,username:'账号'+i%2,display_name:'同名',brand_id:'b'+i%2,brand_name:'品牌'+i%2,seq:i+1,result:i%2?'失败':'发布成功' }));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/rest/v1/')) {
    let data = url.pathname.endsWith('/publish_log') ? rows.slice() : [];
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
  await win.webContents.executeJavaScript("document.querySelector('#prevRows').click()");
  fs.writeFileSync(path.resolve(__dirname,'../../stats-board.png'),(await win.webContents.capturePage()).toPNG());
  win.destroy(); server.close(); app.exit(fail?1:0);
}).catch(e=>{console.error(e);server.close();app.exit(1);});
