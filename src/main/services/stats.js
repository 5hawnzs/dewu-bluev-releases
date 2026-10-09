'use strict';
/**
 * 按品牌的发布统计（频次 / 数量 / 执行日志）
 *
 * 数据源两条，职责分开：
 *   publish-log.jsonl —— 逐条发布结果 → **数量**与**频次**按它算
 *   run-log.jsonl     —— 任务级流水 → **执行日志**按它算
 *
 * 三条口径规则，都是「不许把不知道的写成 0」：
 *   1. 日志里没有 brandId → 进 `untagged`（未标品牌），**不并进任何品牌**。
 *      2026-10-01 之前产出的记录全是这样，所以这里的条数不是 0，是真实存在的一批数据。
 *   2. brandId 指向一个已从注册表删掉的品牌 → 进 `orphans`，原样保留，不丢也不改名。
 *   3. 零条的品牌也要出现在结果里（`rows: 0`）—— 「哪个品牌最近没在发」正是要看的东西，
 *      把 0 行品牌藏起来等于把这个问题藏起来。
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const store = require('../store');
const wp = require('../util/winpath');
const brands = require('../brands');
const sheet = require('./sheet');
const runlog = require('./runlog');

const OK = '发布成功';
const FAIL = '失败';
/** 「只看未标品牌」用的哨兵值（界面下拉里的一项）。空串表示「不筛选」，所以另给一个值 */
const UNTAGGED_FILTER = '__none__';

function pad2(n) { return String(n).padStart(2, '0'); }
function dayOf(ts) {
  const d = new Date(Number(ts) || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dayLabel(days) { return days > 0 ? `最近 ${days} 天` : '全部时间'; }
function dateTimeOf(ts) {
  const d = new Date(ts);
  return `${dayOf(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function blankAcc() {
  return { rows: 0, ok: 0, fail: 0, other: 0, batches: new Set(), dayMap: new Map(), userMap: new Map(), lastAt: 0 };
}
function addRow(acc, e) {
  acc.rows++;
  if (e.result === OK) acc.ok++;
  else if (e.result === FAIL) acc.fail++;
  else acc.other++;

  const b = e.batch || '未标批次';
  acc.batches.add(b);

  const d = dayOf(e.ts);
  const day = acc.dayMap.get(d) || { date: d, rows: 0, ok: 0, fail: 0, other: 0 };
  day.rows++;
  if (e.result === OK) day.ok++;
  else if (e.result === FAIL) day.fail++;
  else day.other++;
  acc.dayMap.set(d, day);

  const uid = String(e.userId || '');
  const u = acc.userMap.get(uid) || { userId: uid, username: e.username || '', displayName: e.displayName || '', rows: 0, ok: 0, fail: 0 };
  u.rows++;
  if (e.result === OK) u.ok++;
  else if (e.result === FAIL) u.fail++;
  acc.userMap.set(uid, u);

  const t = Number(e.ts) || 0;
  if (t > acc.lastAt) acc.lastAt = t;
}
function finish(acc) {
  const byDay = [...acc.dayMap.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  const users = [...acc.userMap.values()].sort((a, b) => b.rows - a.rows);
  return {
    rows: acc.rows, ok: acc.ok, fail: acc.fail, other: acc.other,
    batches: acc.batches.size,
    lastAt: acc.lastAt || 0,
    lastDay: acc.lastAt ? dayOf(acc.lastAt) : '',
    byDay, users
  };
}

/** run-log 的一条 → 屏幕与导出**共用**的形状（两条路各写一遍必然走偏） */
function mapRunLog(e) {
  const lvl = e.kind === 'end' ? (e.ok ? 'ok' : 'error') : (e.kind === 'start' ? 'run' : (e.level || 'info'));
  const msg = e.kind === 'end'
    ? `${e.label || e.type} ${e.ok ? '完成' : '失败'}${e.ok ? '' : '：' + (e.error || '')}（${e.elapsedSec == null ? '—' : e.elapsedSec + 's'}）`
    : (e.kind === 'start' ? `${e.label || e.type} 开始` : e.msg);
  return {
    ts: e.ts, kind: e.kind, type: e.type, label: e.label, batch: e.batch,
    brandId: e.brandId || '', brandName: e.brandName || brands.labelOf(e.brandId),
    username: e.username || '', displayName: e.displayName || '',
    level: lvl, msg
  };
}

/**
 * @param {object} opts
 *   days      统计最近多少天；0 / 不传=全部。默认 30
 *   brandId   只看某个品牌
 *   userId    只看某个执行人
 *   scopeIds  数组时=非管理员，只统计这些品牌；null / 不传=管理员，全部
 *   logLimit  返回多少条最近执行日志（默认 100，**界面用**）
 *   allLogs   true = 执行日志**不截断**（导出用）。★ 导出只给 100 条却不说，就是假账
 */
function query(opts = {}) {
  const customRange = opts.rangeMode === 'custom';
  const days = customRange ? 0 : (opts.days == null ? 30 : (Number(opts.days) || 0));
  let fromTs = days > 0 ? Date.now() - days * 86400000 : 0;
  let toTs = Date.now();
  let rangeLabel = dayLabel(days);
  if (customRange) {
    fromTs = new Date(String(opts.fromAt || '')).getTime();
    toTs = new Date(String(opts.toAt || '')).getTime();
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) throw new Error('请选择开始时间和结束时间');
    if (toTs < fromTs) throw new Error('结束时间不能早于开始时间');
    rangeLabel = '自定义时间';
  }
  const scope = Array.isArray(opts.scopeIds) ? opts.scopeIds.map(String) : null;
  const wantBrand = String(opts.brandId || '');
  const onlyUntagged = wantBrand === UNTAGGED_FILTER;
  const wantUser = String(opts.userId || '');
  const logLimit = opts.allLogs ? 0 : (Number(opts.logLimit) > 0 ? Number(opts.logLimit) : 100);

  const registry = brands.list();
  const known = new Map(registry.map(b => [b.id, b]));
  const notes = [];

  const raw = sheet.readLog();
  const entries = raw.filter(e => ((!customRange && !fromTs) || Number(e.ts) >= fromTs)
    && (!customRange || Number(e.ts) <= toTs));

  const accs = new Map();          // key: brandId / '' / 未知 id
  let considered = 0;
  for (const e of entries) {
    const key = String(e.brandId || '');
    if (onlyUntagged) { if (key) continue; }
    else if (wantBrand && key !== wantBrand) continue;
    if (wantUser && String(e.userId || '') !== wantUser) continue;
    if (scope) {
      // 非管理员：只统计明确属于自己品牌范围的记录。认不出品牌的记录不给（无法确认归属）
      if (!key || !scope.includes(key)) continue;
    }
    considered++;
    if (!accs.has(key)) accs.set(key, blankAcc());
    addRow(accs.get(key), e);
  }

  // ---- 品牌维度：注册表里的品牌全部列出（含 0 条），保证「最近没在发」看得见 ----
  // 非管理员必须按 scope 过滤，否则会把别的品牌名漏给他看；「只看未标品牌」时品牌列表本就该是空的
  const list = onlyUntagged ? [] : registry
    .filter(b => (!scope || scope.includes(b.id)) && (!wantBrand || b.id === wantBrand))
    .map(b => Object.assign({ id: b.id, name: b.name, enabled: b.enabled !== false, orphan: false }, finish(accs.get(b.id) || blankAcc())));

  const untagged = Object.assign({ id: '', name: brands.UNKNOWN_NAME, enabled: true, orphan: false }, finish(accs.get('') || blankAcc()));

  const orphans = [...accs.keys()]
    .filter(k => k && !known.has(k))
    .map(k => Object.assign({ id: k, name: `已删除的品牌（${k}）`, enabled: false, orphan: true }, finish(accs.get(k))));

  // 合计直接从同一份累加里取，别再用「list + untagged + orphans」拼一遍 ——
  // 拼法一旦和上面的过滤条件走偏（比如 scope 滤掉了品牌），总数就和明细对不上
  const totals = { rows: 0, ok: 0, fail: 0, other: 0, batches: new Set() };
  for (const acc of accs.values()) {
    totals.rows += acc.rows; totals.ok += acc.ok; totals.fail += acc.fail; totals.other += acc.other;
    for (const b of acc.batches) totals.batches.add(b);
  }

  // ---- 按天（密集：从起始日到今天的每一天都要有行，缺口是 0 而不是「没有这一天」）----
  const daily = [];
  let denseDays = days > 0 ? Math.min(days, 120) : 0;
  let dailyTruncated = false;
  if (denseDays > 0) {
    const all = new Map();
    for (const acc of accs.values()) for (const d of acc.dayMap.values()) {
      const cur = all.get(d.date) || { date: d.date, rows: 0, ok: 0, fail: 0, other: 0 };
      cur.rows += d.rows; cur.ok += d.ok; cur.fail += d.fail; cur.other += d.other;
      all.set(d.date, cur);
    }
    const today = new Date();
    for (let i = denseDays - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      daily.push(all.get(key) || { date: key, rows: 0, ok: 0, fail: 0, other: 0 });
    }
  } else if (customRange) {
    const all = new Map();
    for (const acc of accs.values()) for (const d of acc.dayMap.values()) {
      const cur = all.get(d.date) || { date: d.date, rows: 0, ok: 0, fail: 0, other: 0 };
      cur.rows += d.rows; cur.ok += d.ok; cur.fail += d.fail; cur.other += d.other;
      all.set(d.date, cur);
    }
    const first = new Date(fromTs); first.setHours(0, 0, 0, 0);
    const last = new Date(toTs); last.setHours(0, 0, 0, 0);
    const span = Math.max(1, Math.floor((Date.UTC(last.getFullYear(), last.getMonth(), last.getDate())
      - Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) / 86400000) + 1);
    dailyTruncated = span > 120;
    denseDays = Math.min(span, 120);
    const cursor = new Date(last);
    cursor.setDate(cursor.getDate() - denseDays + 1);
    for (let i = 0; i < denseDays; i++) {
      const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
      daily.push(all.get(key) || { date: key, rows: 0, ok: 0, fail: 0, other: 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // ---- 执行人维度（跨品牌合计）----
  const userMap = new Map();
  for (const acc of accs.values()) for (const u of acc.userMap.values()) {
    const cur = userMap.get(u.userId) || { userId: u.userId, username: u.username, displayName: u.displayName, rows: 0, ok: 0, fail: 0 };
    cur.rows += u.rows; cur.ok += u.ok; cur.fail += u.fail;
    if (!cur.username && u.username) { cur.username = u.username; cur.displayName = u.displayName; }
    userMap.set(u.userId, cur);
  }
  const users = [...userMap.values()].sort((a, b) => b.rows - a.rows);

  // ---- 任务执行日志 ----
  // 'start' 也要带上：一条「开始」后面没有对应的「结束」，就说明任务是被中断的
  // （程序被关、进程被杀）—— 这正是管理员事后要查的东西，不能只看完成的
  const includeRunLogs = opts.includeRunLogs !== false;
  const runRaw = includeRunLogs ? runlog.read() : [];
  const runRows = includeRunLogs ? runlog.query({ days, fromTs: customRange ? fromTs : undefined, toTs: customRange ? toTs : undefined,
    brandId: wantBrand, userId: wantUser, scopeIds: scope, preloaded: runRaw }) : [];
  const ends = runRows.filter(e => e.kind === 'end');
  // 界面与导出**共用这一套映射**（口径只写一遍，免得导出和屏幕上的说明对不上）
  const logRows = runRows
    .filter(e => e.kind === 'log' || e.kind === 'start' || e.kind === 'end')
    .map(mapRunLog);
  const logs = logLimit > 0 ? logRows.slice(0, logLimit) : logRows;

  if (!raw.length) notes.push('还没有发布记录：跑一次发布后会写进 publish-log.jsonl。');
  // 只有「开始」没有「结束」= 任务被中断（程序关了 / 进程被杀）。不报出来就会看着像「那批没跑过」
  const openStarts = [...new Set(runRows.filter(e => e.kind === 'start').map(e => e.jobId))]
    .filter(id => id && !ends.some(e => e.jobId === id));
  if (openStarts.length) notes.push(`有 ${openStarts.length} 个任务只有「开始」没有「结束」（多半是程序被关或进程被杀）。记录都在，可按 jobId 对照。`);
  if (untagged.rows) {
    notes.push(`有 ${untagged.rows} 条发布记录没有品牌标记（2026-10-01 之前的记录没有这个字段，也可能是发布时没选品牌），已单列为「${brands.UNKNOWN_NAME}」，没有并入任何品牌。`);
  }
  if (orphans.length) notes.push(`有 ${orphans.length} 个品牌的记录来自已从注册表删除的品牌，原样保留（不会被算进别的品牌）。`);
  if (scope) notes.push('你只能看到自己有权限的品牌；未标品牌的历史记录仅管理员可见。');
  if (onlyUntagged) notes.push(`已筛选「只看未标品牌」：命中 ${untagged.rows} 条。`);
  if (wantUser) notes.push('已按执行人筛选。');

  return {
    generatedAt: Date.now(),
    range: {
      days, label: rangeLabel, fromTs, toTs, dailyTruncated,
      from: customRange ? dateTimeOf(fromTs) : (fromTs ? dayOf(fromTs) : '（全部）'),
      to: customRange ? dateTimeOf(toTs) : dayOf(Date.now())
    },
    sources: {
      publishLog: { file: sheet.logFile(), entries: raw.length, entriesInRange: entries.length, size: fileSize(sheet.logFile()) },
      runLog: includeRunLogs ? { file: runlog.file(), entries: runRaw.length, size: runlog.size() } : null
    },
    totals: {
      rows: totals.rows, ok: totals.ok, fail: totals.fail, other: totals.other,
      batches: totals.batches.size,
      runs: ends.length,
      runFails: ends.filter(e => !e.ok).length,
      // 界面上要能说清「这一屏是不是筛过的」，否则 0 条会被当成「真的没发过」
      filtered: considered !== entries.length || raw.length !== entries.length,
      consideredInRange: entries.length,
      totalInLog: raw.length
    },
    // 「屏幕上显示了几条」与「按当前筛选一共几条」分开给 —— 界面据此写明「显示最近 100 条 / 共 M 条」，
    // 否则 100 条会被当成「一共就这么多」
    logsShown: logs.length,
    logsTotal: logRows.length,
    brands: list, untagged, orphans, daily, users, logs, notes
  };
}

function fileSize(f) {
  try { return fs.statSync(wp.toLong(f)).size; } catch (e) { return 0; }
}

/** 「N 条 / 成功 / 失败」的一行文字，界面与导出共用，避免两处口径走偏 */
function line(b) {
  return `${b.rows} 条（成功 ${b.ok} / 失败 ${b.fail}${b.other ? ' / 其他 ' + b.other : ''}）· ${b.batches} 个批次 · 最近 ${b.lastDay || '—'}`;
}

/**
 * 导出 xlsx：品牌汇总 / 按天频次 / 品牌×执行人 / 执行日志 四个工作表。
 * 未标品牌与已删除品牌**单独成行并标注**，不和真实品牌混在一张表里对不上账。
 * ★ 执行日志这张表 **不截断**（老版本只导最近 100 条、界面上一句不提：
 *   拿去做月度对账就会少一大截，且没人看得出来）。
 */
async function exportXlsx(opts = {}) {
  const r = query(Object.assign({}, opts, { allLogs: true }));
  const wb = new ExcelJS.Workbook();
  wb.creator = '得物蓝V素材发布工具';
  wb.created = new Date();

  const head = ws => {
    const h = ws.getRow(1);
    h.font = { bold: true, size: 11 };
    h.eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEBE4' } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFC9C7BF' } } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const ws1 = wb.addWorksheet('品牌汇总');
  ws1.columns = [
    { header: '品牌', key: 'name', width: 26 },
    { header: '状态', key: 'state', width: 12 },
    { header: '发布条数', key: 'rows', width: 11 },
    { header: '成功', key: 'ok', width: 9 },
    { header: '失败', key: 'fail', width: 9 },
    { header: '其他', key: 'other', width: 9 },
    { header: '批次数', key: 'batches', width: 9 },
    { header: '最近发布', key: 'last', width: 13 },
    { header: '执行人', key: 'users', width: 34 }
  ];
  head(ws1);
  const rowsAll = [
    ...r.brands.map(b => ({ name: b.name, state: b.enabled ? '启用' : '已停用', b, flag: false })),
    ...(r.untagged.rows > 0 ? [{ name: r.untagged.name, state: '历史无品牌记录', b: r.untagged, flag: true }] : []),
    ...r.orphans.map(o => ({ name: o.name, state: '品牌已删除', b: o, flag: true }))
  ];
  for (const x of rowsAll) {
    const row = ws1.addRow({
      name: x.name, state: x.state, rows: x.b.rows, ok: x.b.ok, fail: x.b.fail, other: x.b.other,
      batches: x.b.batches, last: x.b.lastDay || '',
      users: x.b.users.map(u => `${u.displayName || u.username || '（未记录执行人）'} ${u.rows}`).join(' / ')
    });
    if (x.flag) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF6E5' } }; });
  }
  ws1.getRow(1).font = { bold: true };

  const ws2 = wb.addWorksheet('按天频次');
  ws2.columns = [
    { header: '日期', key: 'date', width: 13 },
    { header: '当日条数', key: 'rows', width: 11 },
    { header: '成功', key: 'ok', width: 9 },
    { header: '失败', key: 'fail', width: 9 },
    { header: '其他', key: 'other', width: 9 }
  ];
  head(ws2);
  for (const d of r.daily) ws2.addRow(d);

  const ws3 = wb.addWorksheet('品牌×执行人');
  ws3.columns = [
    { header: '品牌', key: 'brand', width: 26 },
    { header: '执行人', key: 'user', width: 20 },
    { header: '账号', key: 'acct', width: 18 },
    { header: '条数', key: 'rows', width: 9 },
    { header: '成功', key: 'ok', width: 9 },
    { header: '失败', key: 'fail', width: 9 }
  ];
  head(ws3);
  for (const x of rowsAll) {
    if (!x.b.users.length) { ws3.addRow({ brand: x.name, user: '（无记录）', acct: '', rows: 0, ok: 0, fail: 0 }); continue; }
    for (const u of x.b.users) {
      ws3.addRow({ brand: x.name, user: u.displayName || '（未记录执行人）', acct: u.username || '', rows: u.rows, ok: u.ok, fail: u.fail });
    }
  }

  if (opts.includeRunLogs !== false) {
  const ws4 = wb.addWorksheet('执行日志');
  ws4.columns = [
    { header: '时间', key: 'time', width: 20 },
    { header: '品牌', key: 'brand', width: 20 },
    { header: '执行人', key: 'user', width: 16 },
    { header: '任务', key: 'label', width: 24 },
    { header: '批次', key: 'batch', width: 24 },
    { header: '结果', key: 'level', width: 10 },
    { header: '说明', key: 'msg', width: 60 }
  ];
  head(ws4);
  const pad = n => String(n).padStart(2, '0');
  for (const e of r.logs) {
    const d = new Date(e.ts);
    ws4.addRow({
      time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      brand: e.brandName, user: e.displayName || e.username || '（未记录）',
      label: e.label || e.type || '', batch: e.batch || '',
      level: e.level === 'ok' ? '完成' : (e.level === 'error' ? '失败' : (e.level === 'warn' ? '告警' : '')),
      msg: e.msg || ''
    });
  }

  }
  const outDir = opts.dir || store.get('paths.output');
  if (!outDir) throw new Error('没有配置输出目录：先到「设置 → 路径」里选一个输出目录');
  await wp.mkdirp(outDir);
  const file = path.join(outDir, `品牌发布统计_${wp.stamp()}.xlsx`);
  await wb.xlsx.writeFile(wp.toLong(file));
  return { file, ...r };
}

/** `20261002-025011`（带秒）。统计类导出会**反复导**（排障时导完再导一次），
 *  只到分钟的话第二次会把上一份**悄悄覆盖**，要留的那份就没了 */
function stampSec(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fullTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function filterText(o, r) {
  const parts = [`范围=${r.range.label}`];
  if (o.rangeMode === 'custom') parts[0] += `（${r.range.from} → ${r.range.to}）`;
  if (o.brandId === UNTAGGED_FILTER) parts.push('品牌=（只看未标品牌）');
  else if (o.brandId) parts.push(`品牌=${brands.labelOf(o.brandId)}（${o.brandId}）`);
  else parts.push('品牌=（全部）');
  if (o.userId) parts.push(`执行人=${o.userId}`);
  if (Array.isArray(o.scopeIds)) parts.push(`可见范围=${o.scopeIds.length} 个品牌（非管理员）`);
  return parts.join(' · ');
}

/**
 * 单独导出「执行日志」（run-log.jsonl，任务级）→ `执行日志_<时间戳>.log` + `.csv`。
 *
 * 为什么不复用「导出 xlsx」：那个是一整套统计（汇总 / 频次 / 品牌×执行人 / 执行日志），
 * 要的是「一张表看全」；而排障、对账、发给同事时只要**这一份日志**，
 * 且必须**条数完整** —— 所以这里不截断，并把筛选条件与两个条数写进文件头。
 */
async function exportRunLog(opts = {}) {
  const o = Object.assign({}, opts);
  const r = query(Object.assign({}, o, { allLogs: true }));
  const rows = r.logs || [];
  const outDir = o.dir || store.get('paths.output');
  if (!outDir) throw new Error('没有配置输出目录：先到「设置 → 路径」里选一个输出目录');
  await wp.mkdirp(outDir);

  const lvText = e => e.level === 'ok' ? '完成' : (e.level === 'error' ? '失败' : (e.level === 'warn' ? '告警' : (e.level === 'run' ? '开始' : '信息')));

  // ★ 两个条数分开写：筛选后多少、日志文件里一共多少。只写前者的话，
  //   「怎么只有 3 条」这种问题过几天就没人说得清了
  const head = [
    '# 得物蓝V 执行日志（任务级）· 导出时间 ' + fullTime(Date.now()),
    '# 筛选条件：' + filterText(o, r),
    `# 本次导出：${rows.length} 条`,
    `# 日志文件里共：${r.sources.runLog.entries} 条（两者不一致 = 上面的筛选条件筛掉了一部分）`,
    `# 日志文件：${wp.toDisplay(r.sources.runLog.file || '')}`,
    '# ' + '-'.repeat(58)
  ];
  const body = rows.map(e =>
    `${fullTime(e.ts)} [${lvText(e)}] ${e.brandName} · ${e.displayName || e.username || '未记录执行人'} · `
    + `${e.label || e.type || ''}${e.batch ? ' · ' + e.batch : ''} · ${e.msg || ''}`);

  const csv = [['时间', '品牌', '执行人', '账号', '任务', '批次', '级别', '说明']];
  for (const e of rows) {
    csv.push([
      fullTime(e.ts), e.brandName, e.displayName || e.username || '（未记录执行人）', e.username || '',
      e.label || e.type || '', e.batch || '', lvText(e), e.msg || ''
    ]);
  }

  const base = `执行日志_${stampSec()}`;
  const file = path.join(outDir, base + '.log');
  const csvFile = path.join(outDir, base + '.csv');
  await fs.promises.writeFile(wp.toLong(file), head.concat(body).join('\r\n') + '\r\n', 'utf8');
  // csv 带 BOM：不带的话 Windows 下 Excel 双击打开中文会乱码（和「重导出日志」一个口径）
  await fs.promises.writeFile(wp.toLong(csvFile), '\uFEFF' + csv.map(x => x.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');

  return { file, csvFile, entries: rows.length, entriesInFile: r.sources.runLog.entries, range: r.range };
}

/**
 * 输出目录可写性自检。
 *
 * 为什么非要有它：`publish-log.jsonl` / `run-log.jsonl` 都是**追加写、失败不报错**
 * （写日志失败不能反过来把发布搞挂 —— 这个取舍本身是对的）。可一旦输出目录指向共享盘而
 * 盘掉线 / 没权限 / 被安全软件拦，统计就会**悄悄少数据、界面却一切正常** ——
 * 那正是「界面骗人」。所以给管理员一个按钮，当场问一句「这台机器现在写得进去吗」。
 *
 * 两件事分开测，因为它们会各自出问题：
 *   ① 目录能不能**建/删文件**（共享盘掉线、无写权限 —— 在这里现形）
 *   ② 两个 jsonl 能不能以**追加方式打开**（与真写日志同一条打开路径；
 *      ★ 一个字节都不写，免得污染台账 —— 台账只该有真实发布记录）
 */
function checkOutput(opts = {}) {
  // 目录只认配置里的那个，不收调用方传进来的路径（免得被当成任意路径探测器）
  const dir = opts.dir || store.get('paths.output');
  const res = { dir: wp.toDisplay(dir || ''), checks: [] };
  if (!dir) {
    res.ok = false;
    res.error = '没有配置输出目录：先到「设置 → 路径」里选一个输出目录';
    return res;
  }

  const tmp = path.join(dir, `._write-test-${Date.now()}.tmp`);
  try {
    fs.mkdirSync(wp.toLong(dir), { recursive: true });
    fs.writeFileSync(wp.toLong(tmp), 'ok', 'utf8');
    fs.unlinkSync(wp.toLong(tmp));
    res.checks.push({ name: '输出目录可建可删文件', ok: true, detail: wp.toDisplay(dir) });
  } catch (e) {
    res.checks.push({ name: '输出目录可建可删文件', ok: false, detail: `${e.code || ''} ${e.message}`.trim() });
  }

  const logs = [['发布日志 publish-log.jsonl', sheet.logFile()], ['执行日志 run-log.jsonl', runlog.file()]];
  for (const [name, f] of logs) {
    let existed = false;
    try { existed = fs.existsSync(wp.toLong(f)); } catch (e) { existed = false; }
    let ok = true, detail = wp.toDisplay(f);
    try {
      const fd = fs.openSync(wp.toLong(f), 'a');   // 'a' = 追加（不存在则创建），与写日志同一个打开方式
      fs.closeSync(fd);
      if (!existed) detail += '（本来不存在，已就地创建 —— 第一次发布本来也会创建）';
    } catch (e) {
      ok = false;
      detail = `${e.code || ''} ${e.message}`.trim();
    }
    res.checks.push({ name: name + ' 可追加打开', ok, detail });
  }

  res.ok = res.checks.every(c => c.ok);
  if (!res.ok) res.error = res.checks.filter(c => !c.ok).map(c => `${c.name}：${c.detail}`).join('；');
  return res;
}

module.exports = { query, exportXlsx, exportRunLog, checkOutput, line, dayOf, OK, FAIL };
