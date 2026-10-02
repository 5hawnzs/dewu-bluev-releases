'use strict';
/**
 * 云端同步（阶段 1：只上行「发布结果」，不碰发布核心）
 *
 * ★ 这条线是**协作层**，不是执行层。它能解决的是「多个人各发各的，谁也不知道别人发到哪了」：
 *   各台机器把本机 publish-log.jsonl 里**新增的那几行**推到 Supabase，网页看板只读聚合。
 *   发布本身仍然只能由本机 adb 驱动模拟器完成 —— 浏览器碰不到 adb，这是硬边界。
 *
 * ★★ 四条红线（改这个文件前先读一遍）：
 *   1) **绝不内置密钥**。地址与 anon key 只从配置里读（管理员在「高级设置 → 云端协作」里填）。
 *      这里**任何地方**都不许出现 service_role key —— 那个 key 能绕过 RLS 读写全表，泄了等于裸奔。
 *   2) **失败绝不能阻断发布**。上行失败只记状态、静默退避；发布结果早就在本机 jsonl 里落盘了，
 *      云上少几条只是看板不全，绝不能反过来让发布挂掉（和 sheet.appendLog 一个口径）。
 *   3) **只上行结构化结果，不上行素材内容、不上行绝对路径**（dir 只取最后一段目录名）。
 *      日志原文也别上行 —— 行数会爆，且里面有本地路径。
 *   4) **幂等**：靠表上 (machine_id, ts, seq) 唯一索引 + `Prefer: resolution=ignore-duplicates`。
 *      网络重试 / 重复同步不会产生重复行；游标只记录「读到第几行」，丢了最多重推被去重挡掉。
 *
 * 为什么用「本机轮询式上行」而不是「网页连本机」：不开端口、不做配对、没有暴露面，
 * 且天然支持多机并发（各推各的，按 machine_id 区分）。这也是另一个项目实测跑通的形态。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('../store');
const wp = require('../util/winpath');
const CD = require('../clouddefaults');   // 内置默认值：界面上没填时用它（只有 anon/publishable key）

const BATCH = 200;          // 单批最多几行（PostgREST 一次插入）
const MAX_BATCHES = 5;      // 单次同步最多几批：台账积压很多时也要给界面留出响应
const TIMEOUT_MS = 15000;

let timer = null;
let syncing = false;
let pendingCache = { at: 0, value: 0 };

/** 游标与状态放哪：正常是 userData；纯 Node（tools/cloudtest.js）里没有 electron，退到临时目录 */
function dataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) { /* 纯 Node：没有 electron 实例 */ }
  return path.join(os.tmpdir(), 'dewu-bluev-publisher-test');
}

function stateFile() { return path.join(dataDir(), 'cloud-sync.json'); }

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch (e) {
    return { offset: 0, uploaded: 0, lastSyncAt: 0, lastError: '', fail: 0, nextTryAt: 0, reset: '' };
  }
}

function writeState(s) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const f = stateFile();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) { /* 只读盘 / 没权限：同步状态存不下，但绝不能因此让发布失败 */ }
}

function logFile() {
  return path.join(store.get('paths.output') || '', 'publish-log.jsonl');
}

function readEntries() {
  try {
    return fs.readFileSync(wp.toLong(logFile()), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

/**
 * 单条台账 → 上行的行。
 * ★ 只留「看板要聚合的字段」：时间 / 机器 / 人 / 批次 / 篇号 / 结果 / 原因 / 耗时。
 *   dir 只取最后一段（款目录名，**不带绝对路径**）；reason 截断，防止异常堆栈把路径带上去。
 */
function toRow(e, machine) {
  const dir = String((e && e.dir) || '');
  const base = path.basename(dir.replace(/\\/g, '/'));
  return {
    // 组织标识：insert 策略要按它校验（见 docs/supabase-setup.sql 的 with check (org = 'bluev')）。
    // ★★ 这里必须兜底到内置默认值：漏了这个字段不是「少一列」，而是**整批被 RLS 拒收**，
    //    而界面上只显示「同步失败」，排查成本极高。org 本就是组织级常量，兜底不改变语义。
    org: (machine && machine.org) || CD.org,
    ts: Number(e.ts) || 0,
    machine_id: machine.id,
    machine_name: machine.name,
    batch_no: String(e.batch || ''),
    seq: Number(e.seq) || 0,
    item_id: String(e.id || ''),
    dir_name: base,
    kind: String(e.kind || ''),
    result: String(e.result || ''),
    reason: String(e.reason || '').slice(0, 200),
    elapsed: Number(e.elapsed) || 0,
    retries: Number(e.retries) || 0,
    mode: String(e.mode || ''),
    brand_id: String(e.brandId || ''),
    brand_name: String(e.brandName || ''),
    user_id: String(e.userId || ''),
    username: String(e.username || ''),
    display_name: String(e.displayName || '')
  };
}

/**
 * 机器标识：一次生成、写进配置，之后不变（否则同一台机器在云上会变成两台）。
 * create=false 时**不落盘、不生成**（给状态显示用 —— 没启用就先别往配置里写东西）。
 */
function machineOf(create) {
  const cfg = store.get('cloud') || {};
  const name = String(cfg.machineName || '').trim() || os.hostname() || '未命名机器';
  const org = String(cfg.org || '').trim() || CD.org;
  let id = String(cfg.machineId || '');
  if (!id) {
    if (create === false) return { id: '', name, org };
    id = 'm_' + crypto.randomUUID().slice(0, 8);
    try { store.set({ cloud: { machineId: id } }); } catch (e) { /* 存不下就用内存里的 */ }
  }
  return { id, name, org };
}

function cfgOf() {
  const c = store.get('cloud') || {};
  return {
    enabled: !!c.enabled,
    // ★ 界面上没填（或被清空）时落回内置的组织默认值，这样「装上就能连」，不用每台手填
    url: String(c.url || CD.url).trim().replace(/\/+$/, ''),
    anonKey: String(c.anonKey || CD.anonKey).trim(),
    intervalSec: Number(c.intervalSec) || 30
  };
}

/**
 * 导出配置（给别的机器用）：一段 JSON，含地址与 key。
 * ★ 只有管理员能调（ipc 层 guardAdmin）；导出的是 anon/publishable key，不是 service_role。
 */
function exportConfig() {
  const cfg = cfgOf();
  const c = store.get('cloud') || {};
  return { ok: true, url: cfg.url, anonKey: cfg.anonKey, org: String(c.org || CD.org) };
}

/**
 * 导入配置：把导出那段 JSON 粘贴进来。**先校验再落盘**，落盘前连一次确认能用。
 * ★ 校验的意义：粘进来一个错地址会让所有机器集体失联，而这毛病在界面上只是「同步失败」四个字。
 */
async function importConfig(input) {
  const p = input || {};
  const url = String(p.url || '').trim().replace(/\/+$/, '');
  const key = String(p.anonKey || '').trim();
  if (!/^https:\/\/[a-z0-9.-]+\.(supabase\.co|supabase\.in)(:\d+)?$/i.test(url)) {
    return { ok: false, error: '地址看着不对：应当是 https://xxxx.supabase.co 这种形式' };
  }
  if (!key) return { ok: false, error: '缺少 anon key' };
  if (/service_role|secret/i.test(key)) {
    return { ok: false, error: '这把是 secret / service_role key —— 绝不能填进客户端，请换 anon key' };
  }
  const org = String(p.org || CD.org).trim() || CD.org;
  store.set({ cloud: { url, anonKey: key, org } });
  const t = await test();
  configure();
  return t.ok
    ? { ok: true, url, org, machineId: t.machineId }
    : { ok: false, error: '配置已保存，但连不上：' + t.error };
}

async function postRows(url, key, rows) {
  const res = await fetch(url + '/rest/v1/publish_log', {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      // 撞唯一索引就跳过（重复同步 / 重试的安全网），不返回正文省带宽
      Prefer: 'return=minimal,resolution=ignore-duplicates'
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 读不到正文就算了 */ }
    const err = new Error(`HTTP ${res.status}${detail ? ' · ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
}

/** 同步一次。返回 { ok, uploaded, pending, error, skipped } —— 永远不抛 */
async function syncOnce(opts = {}) {
  if (syncing) return { ok: false, uploaded: 0, skipped: '正在同步中' };
  const cfg = cfgOf();
  const st = readState();
  if (!cfg.enabled) return { ok: false, uploaded: 0, skipped: '未启用', pending: pending() };
  if (!cfg.url || !cfg.anonKey) {
    writeState(Object.assign(st, { lastError: '还没填 Supabase 地址或 anon key', fail: st.fail + 1 }));
    return { ok: false, uploaded: 0, error: '还没填 Supabase 地址或 anon key', pending: pending() };
  }
  if (!opts.force && st.nextTryAt && Date.now() < st.nextTryAt) {
    return { ok: false, uploaded: 0, skipped: '上次失败，退避中', pending: pending() };
  }

  syncing = true;
  try {
    const all = readEntries();
    // ★ 台账被「数据清理」清空 / 换过输出目录后，游标会指到比文件更远的地方。
    //   不重置的话 offset 永远大于行数 ⇒ 之后再也不上行（界面看着像同步正常，云上却一条没有）
    if (st.offset > all.length) {
      // 先留证据再改：消息里要写「原来指到哪」，否则界面上只能看到「游标(0)」，看不出发生了什么
      st.reset = `台账只剩 ${all.length} 行，而游标停在 ${st.offset} —— 已重置为 0`;
      st.offset = 0;
    }
    const slice = all.slice(st.offset);
    if (!slice.length) {
      pendingCache = { at: Date.now(), value: 0 };
      return { ok: true, uploaded: 0, pending: 0, offset: st.offset, lastSyncAt: st.lastSyncAt };
    }
    const machine = machineOf();
    const rows = slice.map(e => toRow(e, machine));
    let sent = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      if ((i / BATCH) >= MAX_BATCHES) break;      // 剩下的下一轮再推，不卡住界面
      const chunk = rows.slice(i, i + BATCH);
      await postRows(cfg.url, cfg.anonKey, chunk);
      sent += chunk.length;
    }
    st.offset += sent;
    st.uploaded += sent;
    st.lastSyncAt = Date.now();
    st.lastError = '';
    st.fail = 0;
    st.nextTryAt = 0;
    writeState(st);
    pendingCache = { at: Date.now(), value: Math.max(0, all.length - st.offset) };
    return { ok: true, uploaded: sent, pending: Math.max(0, all.length - st.offset), offset: st.offset, lastSyncAt: st.lastSyncAt };
  } catch (e) {
    st.fail = (st.fail || 0) + 1;
    // 退避：30s → 60s → 120s … 最多 5 分钟。失败不该一直重试着刷云端
    const backoff = Math.min(300, cfg.intervalSec * Math.pow(2, st.fail)) * 1000;
    st.nextTryAt = Date.now() + backoff;
    st.lastError = String(e.message || e);
    writeState(st);
    try { require('../logbus').warn(`云端同步失败（${st.fail} 次，${Math.round(backoff / 1000)}s 后重试）：${st.lastError}`); } catch (_) { /* 没日志总线就算了 */ }
    return { ok: false, uploaded: 0, error: st.lastError, pending: pending() };
  } finally {
    syncing = false;
  }
}

/** 还没上行的条数（界面显示用）。3 秒缓存：状态可能被轮询，别每次都读一遍 jsonl */
function pending() {
  if (pendingCache.at && Date.now() - pendingCache.at < 3000) return pendingCache.value;
  const st = readState();
  const n = Math.max(0, readEntries().length - (st.offset || 0));
  pendingCache = { at: Date.now(), value: n };
  return n;
}

/** 给界面的状态。**不含 key** —— 密钥只留在主进程配置里，不往渲染层传 */
function status() {
  const cfg = cfgOf();
  const st = readState();
  const m = machineOf(false);
  return {
    enabled: cfg.enabled,
    configured: !!(cfg.url && cfg.anonKey),
    url: cfg.url,
    intervalSec: cfg.intervalSec,
    machineId: m.id,
    machineName: m.name,
    offset: st.offset || 0,
    uploaded: st.uploaded || 0,
    lastSyncAt: st.lastSyncAt || 0,
    lastError: st.lastError || '',
    nextTryAt: st.nextTryAt || 0,
    reset: st.reset || '',
    syncing,
    pending: pending()
  };
}

/** 连一下云端，只验证「地址通 + key 能用 + 表在」：查 1 行，不写任何东西 */
async function test() {
  const cfg = cfgOf();
  if (!cfg.url || !cfg.anonKey) return { ok: false, error: '还没填 Supabase 地址或 anon key' };
  try {
    const res = await fetch(cfg.url + '/rest/v1/publish_log?select=machine_id&limit=1', {
      method: 'GET',
      headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (e) { /* 忽略 */ }
      return { ok: false, error: `HTTP ${res.status}${detail ? ' · ' + detail : ''}` };
    }
    return { ok: true, machineId: machineOf().id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function start() {
  stop();
  const cfg = cfgOf();
  if (!cfg.enabled) return;
  const ms = Math.max(10, cfg.intervalSec) * 1000;
  timer = setInterval(() => { syncOnce().catch(() => {}); }, ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  setTimeout(() => { syncOnce().catch(() => {}); }, 3000).unref?.();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 配置改了（启用状态 / 间隔）→ 重启定时器 */
function configure() {
  start();
}

module.exports = { status, syncOnce, test, start, stop, configure, toRow, readEntries, pending, exportConfig, importConfig, stateFile, logFile, dataDir };
