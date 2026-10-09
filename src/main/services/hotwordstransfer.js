'use strict';

const ExcelJS = require('exceljs');

const SHEET_NAME = '热词库';
const HEADER = ['分组', '热词'];
const MAX_ROWS = 5001;

// Excel 是 ZIP。解压前校验目录声明的大小，防止小文件解压后耗尽内存。
function checkArchive(buffer) {
  const fail = () => { throw new Error('Excel 压缩结构无效或解压内容过大'); };
  if (!Buffer.isBuffer(buffer) || buffer.length > 2 * 1024 * 1024 || buffer.length < 22) return fail();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) return fail();
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  let pos = buffer.readUInt32LE(end + 16), total = 0;
  const limit = pos + size;
  if (!count || count > 128 || count !== buffer.readUInt16LE(end + 8) || limit !== end) return fail();
  for (let i = 0; i < count; i++) {
    if (pos + 46 > limit || buffer.readUInt32LE(pos) !== 0x02014b50) return fail();
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10);
    const unpacked = buffer.readUInt32LE(pos + 24);
    total += unpacked;
    if ((flags & 1) || ![0, 8].includes(method) || total > 8 * 1024 * 1024) return fail();
    const local = buffer.readUInt32LE(pos + 42);
    if (local + 30 > end || buffer.readUInt32LE(local) !== 0x04034b50) return fail();
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.readUInt32LE(pos + 20);
    if (data + packed > buffer.readUInt32LE(end + 16)) return fail();
    // 实际解压器也必须遵守上限；只信 ZIP 目录无法挡住伪造的尺寸。
    if (method === 8) {
      const inflated = require('zlib').inflateRawSync(buffer.subarray(data, data + packed), { maxOutputLength: Math.max(1, unpacked) });
      if (inflated.length !== unpacked) return fail();
    } else if (packed !== unpacked) return fail();
    pos += 46 + buffer.readUInt16LE(pos + 28) + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
    if (pos > limit) return fail();
  }
  if (pos !== limit) return fail();
}

/** 把可编辑热词写成普通表格，用户可直接在 Excel 中修改。 */
async function toXlsx(groups) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '得物蓝V素材发布工具';
  workbook.subject = '本机热词库备份';
  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.columns = [{ width: 20 }, { width: 36 }];
  sheet.addRow(HEADER);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:B1';

  for (const group of groups || []) {
    const words = Array.isArray(group.words) ? group.words : [];
    if (!words.length) sheet.addRow([group.key, '']);
    else for (const word of words) sheet.addRow([group.key, word]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function cellText(cell, rowNo, colName) {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`第 ${rowNo} 行「${colName}」必须是文本`);
  return value.trim();
}

/** 读取 Excel 表格，支持把同一分组的后续行留空，便于人工编辑。 */
async function fromXlsx(buffer, editableGroups) {
  checkArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];
  if (!sheet) throw new Error('Excel 文件里没有工作表');
  if (sheet.rowCount > MAX_ROWS) throw new Error(`词库表超过 ${MAX_ROWS - 1} 行`);
  if (cellText(sheet.getCell('A1'), 1, '分组') !== HEADER[0]
    || cellText(sheet.getCell('B1'), 1, '热词') !== HEADER[1]) {
    throw new Error('表头不正确，请使用「分组」「热词」两列，或先导出一份词库模板');
  }

  const allowed = new Set(editableGroups || []);
  const byKey = new Map();
  let lastKey = '';
  for (let rowNo = 2; rowNo <= sheet.rowCount; rowNo++) {
    const row = sheet.getRow(rowNo);
    let key = cellText(row.getCell(1), rowNo, '分组');
    const word = cellText(row.getCell(2), rowNo, '热词');
    if (!key && !word) continue;
    if (key) lastKey = key;
    else key = lastKey;
    if (!key) throw new Error(`第 ${rowNo} 行没有分组名`);
    if (!allowed.has(key)) throw new Error(`第 ${rowNo} 行的分组「${key}」不存在或不可编辑`);
    if (!byKey.has(key)) byKey.set(key, []);
    if (word) byKey.get(key).push(word);
  }
  if (!byKey.size) throw new Error('表格中没有可导入的热词分组');
  return [...byKey].map(([key, words]) => ({ key, words }));
}

module.exports = { SHEET_NAME, HEADER, toXlsx, fromXlsx };
