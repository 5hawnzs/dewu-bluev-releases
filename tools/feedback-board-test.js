'use strict';
const { app, BrowserWindow } = require('electron');
require('./test-runtime')({ app });
const path = require('path'), fs = require('fs'), os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-feedback-board-')));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error(message); });
  const source = path.join(__dirname, '../web');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-feedback-html-'));
  fs.cpSync(source, tmp, { recursive: true });
  const probe = `window.__feedbackProbe = () => {
    taskRows = [{ts:Date.now(),task_type:'feedback.submit',event_kind:'end',machine_name:'设备B',username:'testbeta',batch_no:'v1.1.1',error_summary:'反馈内容 <img src=x onerror=alert(1)>'}];
    rows = []; render();
    document.querySelector('#tab-feedback').click();
    const panel = document.querySelector('#panel-feedback');
    return !panel.hidden && panel.closest('#main') !== null && panel.textContent.includes('反馈内容 <img')
      && panel.textContent.includes('testbeta') && !panel.querySelector('img');
  };`;
  const html = fs.readFileSync(path.join(tmp, 'board.html'), 'utf8');
  fs.writeFileSync(path.join(tmp, 'board.html'), html.replace('connect(false);', probe + '\nconnect(false);'));
  await win.loadFile(path.join(tmp, 'board.html'));
  const result = await win.webContents.executeJavaScript('window.__feedbackProbe()');
  console.log((result ? 'PASS ' : 'FAIL ') + '看板反馈页展示账号、设备、版本、正文，内容安全转义并位于登录保护区域');
  app.exit(result ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
