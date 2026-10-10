'use strict';

const { app, ipcMain, dialog } = require('electron');
require('./test-runtime')({ app });
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-hotwords-xlsx-'));
app.setPath('userData', TMP);
app.disableHardwareAcceleration();

const handlers = {};
ipcMain.handle = (channel, fn) => {
  handlers[channel] = (_event, ...args) => {
    const frame = { url: require('../src/main/security').ENTRY };
    return fn({ senderFrame: frame, sender: { mainFrame: frame } }, ...args);
  };
};

app.whenReady().then(async () => {
  const store = require(path.join(ROOT, 'src/main/store.js'));
  const project = require(path.join(ROOT, 'src/main/project.js'));
  const auth = require(path.join(ROOT, 'src/main/auth.js'));
  const ipc = require(path.join(ROOT, 'src/main/ipc.js'));
  store.load();
  project.load();
  auth.load();
  auth.enabled = () => false; // 仅此隔离测试绕过登录，不连接云端，也不改产品默认值。
  ipc.register();

  let count = 0;
  const check = (label, condition) => {
    assert.ok(condition, label);
    console.log('PASS  ' + label);
    count++;
  };

  const filename = path.join(TMP, '词库.xlsx');
  let saveOptions, openOptions;
  dialog.showSaveDialog = async (_window, options) => {
    saveOptions = options;
    return { canceled: false, filePath: filename };
  };
  const groups = [{ key: '风格', words: ['简约百搭', '松弛感'] }];
  const exported = await handlers['hotwords:export']({}, groups);
  const bytes = fs.readFileSync(filename);
  check('导出按钮生成真实 xlsx 文件并使用 .xlsx 保存筛选', exported.ok
    && saveOptions.defaultPath.endsWith('.xlsx')
    && saveOptions.filters.some(f => f.extensions.includes('xlsx'))
    && bytes[0] === 0x50 && bytes[1] === 0x4b);

  dialog.showOpenDialog = async (_window, options) => {
    openOptions = options;
    return { canceled: false, filePaths: [filename] };
  };
  const imported = await handlers['hotwords:import']({});
  const style = imported.groups && imported.groups.find(g => g.key === '风格');
  check('导入按钮接受刚导出的 Excel，热词内容往返一致', imported.ok
    && style && style.words.includes('简约百搭') && style.words.includes('松弛感')
    && openOptions.filters.some(f => f.extensions.includes('xlsx')));

  const ExcelJS = require('exceljs');
  const lockedWorkbook = new ExcelJS.Workbook();
  const lockedSheet = lockedWorkbook.addWorksheet('热词库');
  lockedSheet.addRow(['分组', '热词']);
  lockedSheet.addRow(['收尾', '覆盖锁定词']);
  fs.writeFileSync(filename, Buffer.from(await lockedWorkbook.xlsx.writeBuffer()));
  const lockedImport = await handlers['hotwords:import']({});
  check('收尾可通过 Excel 导入编辑', lockedImport.ok && lockedImport.groups.find(g => g.key === '收尾').words.includes('覆盖锁定词'));

  fs.writeFileSync(filename, Buffer.alloc(2 * 1024 * 1024 + 1));
  const oversized = await handlers['hotwords:import']({});
  check('导入仍拦截超过 2 MB 的文件', !oversized.ok && /小于 2 MB/.test(oversized.error));

  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  check('取消导入安全返回', (await handlers['hotwords:import']({})).canceled === true);
  dialog.showSaveDialog = async () => ({ canceled: true });
  check('取消导出安全返回', (await handlers['hotwords:export']({}, groups)).canceled === true);

  console.log(`全部通过 ${count} 项热词 Excel IPC 检查`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
