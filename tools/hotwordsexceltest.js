'use strict';

const assert = require('assert');
const ExcelJS = require('exceljs');
const transfer = require('../src/main/services/hotwordstransfer');

async function main() {
  assert.deepStrictEqual(require('../src/main/services/hotwords').sanitizeWords(['constructor', 'constructor']).words, ['constructor']);
  let count = 0;
  const check = (label, condition) => {
    assert.ok(condition, label);
    console.log('PASS  ' + label);
    count++;
  };

  const groups = [
    { key: '风格', words: ['简约百搭', '松弛感'] },
    { key: '色感', words: ['{色}调穿搭'] },
    { key: '收尾', words: [] }
  ];
  const buffer = await transfer.toXlsx(groups);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(transfer.SHEET_NAME);
  check('导出为可打开的 xlsx 工作簿并带正确表头', !!sheet
    && sheet.getCell('A1').value === '分组' && sheet.getCell('B1').value === '热词');
  check('导出的表格保留全部词条与空分组', sheet.rowCount === 5
    && sheet.getCell('A5').value === '收尾' && sheet.getCell('B5').value === '');

  const restored = await transfer.fromXlsx(buffer, ['风格', '色感', '收尾']);
  check('导出再导入保留中文分组、顺序、词条及空分组', JSON.stringify(restored) === JSON.stringify(groups));

  const editedBook = new ExcelJS.Workbook();
  const edited = editedBook.addWorksheet('热词库');
  edited.addRow(['分组', '热词']);
  edited.addRow(['风格', '简约百搭']);
  edited.addRow(['', '温柔通勤']);
  const editedGroups = await transfer.fromXlsx(Buffer.from(await editedBook.xlsx.writeBuffer()), ['风格']);
  check('支持 Excel 中同组后续行省略分组名', editedGroups[0].words.join('|') === '简约百搭|温柔通勤');

  const badHeaderBook = new ExcelJS.Workbook();
  const badHeader = badHeaderBook.addWorksheet('热词库');
  badHeader.addRow(['分类', '热词']);
  badHeader.addRow(['风格', '清爽']);
  const badHeaderBuffer = Buffer.from(await badHeaderBook.xlsx.writeBuffer());
  await assert.rejects(() => transfer.fromXlsx(badHeaderBuffer, ['风格']), /表头不正确/);
  console.log('PASS  拒绝列名不匹配的工作簿'); count++;

  const lockedBook = new ExcelJS.Workbook();
  const locked = lockedBook.addWorksheet('热词库');
  locked.addRow(['分组', '热词']);
  locked.addRow(['句式骨架', '不可覆盖']);
  const lockedBuffer = Buffer.from(await lockedBook.xlsx.writeBuffer());
  await assert.rejects(() => transfer.fromXlsx(lockedBuffer, ['风格']), /不存在或不可编辑/);
  console.log('PASS  拒绝覆盖不存在或不可编辑的分组'); count++;

  const formulaBook = new ExcelJS.Workbook();
  const formula = formulaBook.addWorksheet('热词库');
  formula.addRow(['分组', '热词']);
  formula.addRow(['风格', { formula: '1+1', result: 2 }]);
  const formulaBuffer = Buffer.from(await formulaBook.xlsx.writeBuffer());
  await assert.rejects(() => transfer.fromXlsx(formulaBuffer, ['风格']), /必须是文本/);
  console.log('PASS  拒绝公式或非文本词条'); count++;

  const forged = Buffer.from(buffer);
  const central = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(256 * 1024 * 1024, central + 24);
  await assert.rejects(() => transfer.fromXlsx(forged, ['风格']), /解压内容过大/);
  console.log('PASS  解压前拒绝压缩炸弹尺寸'); count++;
  const understated = Buffer.from(buffer);
  understated.writeUInt32LE(1, central + 24);
  await assert.rejects(() => transfer.fromXlsx(understated, ['风格']));
  console.log('PASS  拒绝伪造解压尺寸绕过上限'); count++;
  console.log(`全部通过 ${count} 项 Excel 词库导入导出检查`);
}

main().catch(error => { console.error(error); process.exit(1); });
