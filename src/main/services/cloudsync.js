'use strict';
/**
 * 云端同步：上行发布结果与脱敏后的任务级运行记录，不碰发布核心。
 *
 * ★ 这条线是**协作层**，不是执行层。它能解决的是「多个人各发各的，谁也不知道别人发到哪了」：
 *   各台机器把本机新增的发布结果和任务起止记录推到 Supabase，网页看板只读聚合。
 *   发布本身仍然只能由本机 adb 驱动模拟器完成 —— 浏览器碰不到 adb，这是硬边界。
 *
 * ★★ 四条红线（改这个文件前先读一遍）：
 *   1) **只许内置 anon / publishable key**。地址与 anon key 的取值：本机 config.json 里
 *      显式填的 > `clouddefaults.js` 的内置组织值（读取时兜底、**不写回**）。
 *      这里**任何地方**都不许出现 service_role key —— 那个 key 能绕过 RLS 读写全表，泄了等于裸奔。
 *      ★ 2026-10-08 起界面上**没有配置入口了**（用户要求：这块不给任何人看到）⇒
 *        改配置只能改 config.json，组织级切换走「发新包」。
 *   2) **失败绝不能阻断发布**。上行失败只记状态、静默退避；发布结果早就在本机 jsonl 里落盘了，
 *      云上少几条只是看板不全，绝不能反过来让发布挂掉（和 sheet.appendLog 一个口径）。
 *   3) **只上行结构化结果与任务起止/脱敏错误摘要**，不上传过程日志、素材内容、绝对路径。
 *   4) **幂等**：靠表上 (machine_id, ts, seq) 唯一索引，且**两半缺一不可** ——
 *      URL 上要写 `?on_conflict=machine_id,ts,seq`，头里要写 `Prefer: resolution=ignore-duplicates`。
 *      ★★ 只写后者是无效的（2026-10-02 实测：裸 POST 重复行 ⇒ 409 + 23505「duplicate key value
 *      violates unique constraint "publish_log_dedup"」；只有补上 ?on_conflict= 才 201 被静默跳过，
 *      响应头 `preference-applied` 也会确认 ignore-duplicates 真的生效了）。
 *      后果不是「多几行」而是**同步永久卡死**：整批 409 ⇒ 抛错 ⇒ 游标不前进 ⇒ 每轮都在同一批上重撞。
 *      游标只记录「读到第几行」，丢了最多重推被去重挡掉。
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
const runlog = require('./runlog');

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

/**
 * 把一次失败写成「能定位」的一句话（给界面与落盘共用）。
 *
 * ★★ 为什么必须把 cause 串起来：Node 的 fetch 在 DNS / 连接层失败时，`e.message` **只有六个字**
 *    `fetch failed`，真正的原因（ENOTFOUND / ECONNRESET / ETIMEDOUT / other side closed / bad port）
 *    全在 `e.cause` 里。2026-10-08 实测：DNS 解析失败与连接被拒**都**显示成 `fetch failed`，
 *    看不出任何区别 ⇒ 本机代理一断，界面上就只有这六个字，排查成本极高。
 *    undici 的 cause 可能还嵌一层（TypeError → SocketError → Error），所以往下扒最多 3 层。
 * ★ 绝不抛：这函数本身在 catch 里跑，它抛了就把真正的错误吞掉。
 */
function describeErr(e) {
  try {
    const base = String((e && e.message) || e || '未知错误');
    const bits = [base];
    // HTTP 类错误的消息里已经带了状态码，别写两遍
    if (e && e.status && base.indexOf('HTTP ') !== 0) bits.push('HTTP ' + e.status);
    let c = e && e.cause;
    for (let d = 0; c && d < 3; d++) {
      const t = c.code
        ? String(c.code) + (c.message && c.message !== c.code ? ' ' + c.message : '')
        : String(c.message || c);
      if (t && bits.indexOf(t) < 0) bits.push(t);
      c = c.cause;
    }
    return bits.join(' · ').slice(0, 300);
  } catch (_) {
    return '描述失败信息时又出错了';
  }
}

/** 同步失败的台账（一行一次）。放输出目录，和 publish-log.jsonl 并排，方便一起交上来 */
function errorLogFile() {
  return path.join(store.get('paths.output') || '', 'cloud-sync-errors.log');
}

const ERR_LOG_MAX = 1024 * 1024;   // 单文件上限 1MB，超了滚一次（保留 .1），绝不无限长

/**
 * 追加一行失败台账。
 * ★ 为什么非落盘不可：`logbus` **只进内存**（环形缓存），而且成功后 `lastError` 立刻被清空 ⇒
 *   事后在磁盘上一条痕迹都没有。2026-10-08 实测：`run-log.jsonl` / `config.json` / 整个工作区
 *   搜「云端同步失败」**0 命中** ⇒ 出事只能靠猜。落盘之后，下次只要把这个文件拿出来就能定性。
 * ★ 绝不抛：写不进去（盘满/只读/输出目录还没配）也只是少一条证据，绝不能反过来让同步或发布挂掉。
 */
function appendErrorLog(text) {
  try {
    const dir = store.get('paths.output') || '';
    if (!dir) return;                        // 输出目录都没配，无处可写
    fs.mkdirSync(wp.toLong(dir), { recursive: true });
    const f = wp.toLong(errorLogFile());
    try {
      if (fs.statSync(f).size > ERR_LOG_MAX) fs.renameSync(f, f + '.1');
    } catch (_) { /* 文件还不存在，正常 */ }
    const line = `[${new Date().toISOString()}] ${text}\n`;
    fs.appendFileSync(f, line, 'utf8');
  } catch (_) { /* 写不进去就算了 —— 证据少一条，好过把发布拖下水 */ }
}

function logFile() {
  return path.join(store.get('paths.output') || '', 'publish-log.jsonl');
}

function runLogFile() {
  return path.join(store.get('paths.output') || '', 'run-log.jsonl');
}

function readEntries() {
  try {
    return fs.readFileSync(wp.toLong(logFile()), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readRunEntries() {
  try {
    return fs.readFileSync(wp.toLong(runLogFile()), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

/** 只留可排错的短错误摘要，并抹掉本机绝对路径与凭据样式字符串。 */
function safeRunText(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Windows 异常常把含空格路径用引号包住，先整体删除，再处理未加引号的路径片段。
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\)[\s\S]*?\1/g, '[本机路径]')
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, '[本机路径]')
    .replace(/\\\\[^\\\s]+\\[^\s"'<>|]*/g, '[网络路径]')
    .replace(/\/(?:Users|home|root|private|tmp|var|mnt|Volumes)\/[^\s"'<>]*/g, '[本机路径]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/ig, 'Bearer [已隐藏]')
    .replace(/(?:service[_ -]?role|secret|anon)[_ -]?(?:key)?\s*[:=]\s*[^\s,;]+/ig, '[已隐藏凭据]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/** 任务运行表只接收开始/结束事件；过程日志可能含路径、商品信息，不上传。 */
function toRunRow(e, machine, index = 0) {
  if (!e || (e.kind !== 'start' && e.kind !== 'end')) return null;
  const stableId = e.eventId || crypto.createHash('sha256')
    .update(`${machine.id}\n${index}\n${JSON.stringify(e)}`).digest('hex');
  return {
    org: (machine && machine.org) || CD.org,
    event_id: String(stableId),
    ts: Number(e.ts) || 0,
    machine_id: machine.id,
    machine_name: machine.name,
    task_id: String(e.jobId || ''),
    event_kind: e.kind,
    task_type: safeRunText(e.type),
    task_label: safeRunText(e.label),
    batch_no: safeRunText(e.batch),
    brand_id: String(e.brandId || ''),
    brand_name: safeRunText(e.brandName),
    user_id: String(e.userId || ''),
    username: safeRunText(e.username),
    display_name: safeRunText(e.displayName),
    ok: e.kind === 'end' ? !!e.ok : null,
    cancelled: e.kind === 'end' ? !!e.cancelled : false,
    elapsed_sec: e.kind === 'end' ? Number(e.elapsedSec) || 0 : null,
    error_summary: e.kind === 'end' && !e.ok ? safeRunText(e.error) : ''
  };
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
 * 机器指纹：Windows 读注册表 MachineGuid（**装系统时生成**）。
 * ★ 为什么需要它：machineId 原来是**随机** UUID，一旦配置被搬运/清空就换一个新的 ⇒
 *   同一台物理机在云上变成两台，且整本台账会以新 id 重推一遍（唯一键含 machine_id，去不掉）⇒ 看板数字翻倍。
 *   实测证据（2026-10-08 真库）：189 项真实工作占了 367 行，其中 178 项**同时**挂
 *   `m_ce61ca24` 与 `m_fb6e1a86` 两个标识，且 ts 完全相同。
 *   MachineGuid 在「重装 App / 清 config.json / 换 Windows 用户」下都不变，正好补上这个洞。
 *   （读不到就返回空串 ⇒ 退回原来的随机行为，绝不因为读不到注册表就崩。）
 */
let fpCache = null;
function machineFingerprint() {
  if (fpCache !== null) return fpCache;
  fpCache = '';
  try {
    if (process.platform === 'win32') {
      const out = require('child_process').execFileSync(
        'reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/.exec(String(out));
      if (m) fpCache = m[1].trim().toLowerCase();
    }
  } catch (e) { /* 读不到注册表（权限/非 Windows）⇒ 留空串，走随机兜底 */ }
  return fpCache;
}

/** 纯函数：指纹 → 机器标识。**同一个指纹永远得到同一个 id**（这就是修「同一台机变两台」的关键）。 */
function idFromFingerprint(fp) {
  const s = String(fp || '').trim();
  if (!s) return '';
  return 'm_' + crypto.createHash('sha1').update('bluev|' + s).digest('hex').slice(0, 8);
}

/**
 * 机器标识：一次生成、写进配置，之后不变（否则同一台机器在云上会变成两台）。
 * create=false 时**不落盘、不生成**（给状态显示用 —— 没启用就先别往配置里写东西）。
 *
 * ★★ 生成顺序（**不要**改成「一律按指纹重算」）：
 *   ① 配置里已有 machineId ⇒ 照用。**绝不因为指纹不同就迁移** ——
 *      迁移＝换 id＝整本台账以新 id 重推一遍＝看板再翻一倍（真库实测过这个后果）。
 *   ② 没有 ⇒ 由机器指纹派生（同一台机永远是同一个 id，清配置也认得回来）。
 *   ③ 指纹也读不到 ⇒ 退回随机（保持原行为）。
 */
function machineOf(create) {
  const cfg = store.get('cloud') || {};
  const name = String(cfg.machineName || '').trim() || os.hostname() || '未命名机器';
  const org = String(cfg.org || '').trim() || CD.org;
  let id = String(cfg.machineId || '');
  if (!id) {
    if (create === false) return { id: '', name, org };
    id = idFromFingerprint(machineFingerprint()) || ('m_' + crypto.randomUUID().slice(0, 8));
    try { store.set({ cloud: { machineId: id } }); } catch (e) { /* 存不下就用内存里的 */ }
  }
  return { id, name, org };
}

/** 配置里**本机显式填的**值（不兜底、不写回）。留空 ⇒ 跟随内置（见 cfgOf）。 */
function explicitOf() {
  const c = store.get('cloud') || {};
  return {
    url: String(c.url || '').trim().replace(/\/+$/, ''),
    anonKey: String(c.anonKey || '').trim(),
    org: String(c.org || '').trim()
  };
}

function cfgOf() {
  const c = store.get('cloud') || {};
  const e = explicitOf();
  return {
    enabled: !!c.enabled,
    // ★★ 留空 ⇒ 在这里兜底到内置的组织默认值，**读完就算了、绝不写回配置**。
    //    这样「装上就能连、各台不用手填」和「以后换项目只要发新包、各台升级自动跟随」同时成立。
    //    ★ 一定不要把兜底值写回 store：写回＝固化进 config.json，而卸载都不删 ⇒ 新包顶不动它。
    url: e.url || CD.url,
    anonKey: e.anonKey || CD.anonKey,
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

/** 幂等的两半：冲突目标列（写进 URL）与 resolution 头。少任何一半都会在重复行上 409。 */
const CONFLICT_COLS = 'machine_id,ts,seq';

/** 这一条错误是不是「撞唯一键」——只认 409 + 23505，别的错（42P10 没有对应唯一约束、网络断）不许吞 */
function isDupErr(e) {
  return !!e && e.status === 409 && /23505|duplicate key/i.test(String(e.detail || e.message || ''));
}

/** 单次 POST（一次调用 = 一批）。非 2xx 抛错，错误上带 status/detail 供上层分辨。 */
async function insertRows(url, key, table, conflictCols, rows) {
  const res = await fetch(url + '/rest/v1/' + table + '?on_conflict=' + conflictCols, {
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
    err.detail = detail;
    throw err;
  }
}

/**
 * 推一批，返回「这批可以前进多少行」。
 *
 * ★★ 正常路径：一次 POST 全进；重复的行由 ignore-duplicates 在服务端静默跳过（游标照常前进）。
 * ★★ 兜底路径：万一批级 409（唯一冲突）—— 说明服务端没按 on_conflict 去重（索引是后补的、
 *    或 PostgREST 行为有差异）。这时**逐行重发**：已存在的跳过、新的补上。
 *    为什么必须兜底而不是直接整批放弃：整批 409 若是被当成失败，上一次同步的 catch 不会推进游标
 *    ⇒ 每一轮都在同一批上重撞 ⇒ **同步永久卡死**（v1.0.5 实测故障）。
 *    逐行重发既保住「新的那几行不会丢」，又保证「这一批最终能过」。
 */
async function postRows(url, key, table, conflictCols, rows) {
  try {
    await insertRows(url, key, table, conflictCols, rows);
    return rows.length;
  } catch (e) {
    if (!isDupErr(e)) throw e;          // 不是唯一冲突 ⇒ 照旧失败（退避、不推进游标）
    let done = 0;
    for (const row of rows) {
      try { await insertRows(url, key, table, conflictCols, [row]); }
      catch (e2) { if (!isDupErr(e2)) throw e2; }   // 单行也撞唯一键 ⇒ 它本来就在云上，算已上行
      done++;
    }
    return done;
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
  // ★ 留一份「这一轮读到的台账」给 catch 用：失败时要如实写积压数，
  //   而 `pending()` 有 3 秒缓存（那边是给界面轮询用的），在 catch 里取到的是**上一轮的旧值** ——
  //   把旧值当成本次失败时的积压写进证据文件，就是写了一个假数字（宁可写 ? 也不写错的 0）。
  let ledgerRows = null;
  let taskRows = null;
  let publishSent = 0;
  let taskSent = 0;
  try {
    if (await require('./publishhistory').refresh(wp.toLong(logFile()))) st.offset = 0;
    const historyBefore = require('./publishhistory').cutoff();
    if (historyBefore > (Number(st.historyBefore) || 0)) { st.offset = 0; st.historyBefore = historyBefore; }
    const all = readEntries();
    ledgerRows = all;
    const allTasks = readRunEntries();
    taskRows = allTasks;
    // 首次升级只从当前文件末尾开始，避免把旧版完整运行日志批量补传。
    if (!Number.isInteger(st.runOffset) || st.runOffset < 0) st.runOffset = allTasks.length;
    if (st.runOffset > allTasks.length) {
      st.reset = `运行日志现有 ${allTasks.length} 行，游标停在 ${st.runOffset} —— 已跳到末尾`;
      st.runOffset = allTasks.length;
    }
    // ★ 台账被「数据清理」清空 / 换过输出目录后，游标会指到比文件更远的地方。
    //   不重置的话 offset 永远大于行数 ⇒ 之后再也不上行（界面看着像同步正常，云上却一条没有）
    if (st.offset > all.length) {
      // 先留证据再改：消息里要写「原来指到哪」，否则界面上只能看到「游标(0)」，看不出发生了什么
      st.reset = `台账只剩 ${all.length} 行，而游标停在 ${st.offset} —— 已重置为 0`;
      st.offset = 0;
    }
    const slice = all.slice(st.offset);
    const machine = machineOf();
    const rows = slice.slice(0, BATCH * MAX_BATCHES).map(e => toRow(e, machine));
    for (let i = 0; i < rows.length; i += BATCH) {
      if ((i / BATCH) >= MAX_BATCHES) break;      // 剩下的下一轮再推，不卡住界面
      const chunk = rows.slice(i, i + BATCH);
      // ★ 用返回的「可前进行数」而不是 chunk.length：唯一冲突走逐行兜底时，两者含义相同（都全过），
      //   但让计数走同一个来源，将来加别的容错才不会被悄悄绕过。
      publishSent += await postRows(cfg.url, cfg.anonKey, 'publish_log', CONFLICT_COLS, chunk);
    }
    st.offset += publishSent;
    st.uploaded += publishSent;

    // 每轮最多处理 1000 条事件；start/end 上传，过程 log 留在本机。
    const taskSlice = allTasks.slice(st.runOffset, st.runOffset + BATCH * MAX_BATCHES);
    const taskPayload = taskSlice.map((e, i) => toRunRow(e, machine, st.runOffset + i)).filter(Boolean);
    for (let i = 0; i < taskPayload.length; i += BATCH) {
      taskSent += await postRows(cfg.url, cfg.anonKey, 'run_log', 'machine_id,event_id', taskPayload.slice(i, i + BATCH));
    }
    st.runOffset += taskSlice.length;
    st.runUploaded = (st.runUploaded || 0) + taskSent;
    st.lastSyncAt = Date.now();
    st.lastError = '';
    st.fail = 0;
    st.nextTryAt = 0;
    writeState(st);
    pendingCache = { at: Date.now(), value: Math.max(0, all.length - st.offset) };
    return { ok: true, uploaded: publishSent, runUploaded: taskSent,
      pending: Math.max(0, all.length - st.offset), pendingRun: Math.max(0, allTasks.length - st.runOffset),
      offset: st.offset, runOffset: st.runOffset, lastSyncAt: st.lastSyncAt };
  } catch (e) {
    st.fail = (st.fail || 0) + 1;
    // 退避：30s → 60s → 120s … 最多 5 分钟。失败不该一直重试着刷云端
    const backoff = Math.min(300, cfg.intervalSec * Math.pow(2, st.fail)) * 1000;
    st.nextTryAt = Date.now() + backoff;
    // ★★ 记「能定位」的那句话，而不是 `String(e.message)` —— 后者在 DNS/连接失败时只有 `fetch failed`
    //    六个字（cause 被丢掉），正是 2026-10-08 排查「为什么时不时同步失败」时卡住的地方。
    st.lastError = describeErr(e);
    writeState(st);
    try {
      require('../logbus').warn(`云端同步失败（${st.fail} 次，${Math.round(backoff / 1000)}s 后重试）：${st.lastError}`);
    } catch (_) { /* 没日志总线就算了 */ }
    // 同时落一条盘：`logbus` 只进内存，而下次成功会把 lastError 清空 —— 不落盘就永远无法复盘
    const pend = ledgerRows ? Math.max(0, ledgerRows.length - (st.offset || 0)) : '?';
    const taskPend = taskRows ? Math.max(0, taskRows.length - (st.runOffset || 0)) : '?';
    appendErrorLog(`fail=${st.fail} backoff=${Math.round(backoff / 1000)}s offset=${st.offset} pending=${pend} runOffset=${st.runOffset || 0} pendingRun=${taskPend} err=${st.lastError}`);
    return { ok: false, uploaded: publishSent, runUploaded: taskSent, error: st.lastError, pending: pending(),
      pendingRun: taskRows ? Math.max(0, taskRows.length - (st.runOffset || 0)) : 0 };
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

function pendingRun() {
  const st = readState();
  if (!Number.isInteger(st.runOffset)) return 0;
  return Math.max(0, readRunEntries().length - st.runOffset);
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
    // ★★ 界面靠这两个字段如实说「当前实际在用哪个地址、是跟随内置还是本机指定」。
    //    这是删掉 applyCloudDefaults 之后替代「把值写进配置」的那条不变量：
    //    显示的是主进程真正在用的值，就不存在「框里空着、后台照推」的错觉。
    //    （uicheck 里有断言焊住：界面显示的地址 === status().url）
    urlSource: explicitOf().url ? 'custom' : 'builtin',
    builtinUrl: CD.url,
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
    pending: pending(),
    runOffset: st.runOffset || 0,
    runUploaded: st.runUploaded || 0,
    pendingRun: pendingRun()
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
      // ★ 表还没建 —— 这是**每个人第一次用必然走的路**（凭据已内置，建表 SQL 只能由人在控制台跑）。
      //   照直甩一串 PostgREST JSON 的话，用户只会看到「连不上」+ 一段看不懂的英文。
      if (/PGRST205|Could not find the table|does not exist/i.test(detail)) {
        return {
          ok: false,
          error: '能与这个项目连通，但表还没建：请在 Supabase 控制台的 SQL Editor 里跑一次 docs/supabase-setup.sql'
            + '（返回原文：' + detail.slice(0, 120) + '）'
        };
      }
      return { ok: false, error: `HTTP ${res.status}${detail ? ' · ' + detail : ''}` };
    }
    const taskRes = await fetch(cfg.url + '/rest/v1/run_log?select=event_id&limit=1', {
      method: 'GET',
      headers: { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!taskRes.ok) {
      let detail = '';
      try { detail = (await taskRes.text()).slice(0, 180); } catch (e) { /* 忽略 */ }
      if (/PGRST205|Could not find the table|does not exist/i.test(detail)) {
        return { ok: false, error: '发布结果表正常，但任务日志表还没建：请在 Supabase SQL Editor 运行 docs/supabase-runlog-migration.sql' };
      }
      return { ok: false, error: `任务日志表检查失败：HTTP ${taskRes.status}${detail ? ' · ' + detail : ''}` };
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
  const st = readState();
  if (!Number.isInteger(st.runOffset)) {
    // 升级后的首次同步从当前日志末尾开始，旧历史不自动补传。
    st.runOffset = readRunEntries().length;
    writeState(st);
  }
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

module.exports = { status, syncOnce, test, start, stop, configure, toRow, toRunRow, safeRunText, readEntries, readRunEntries, pending, pendingRun, exportConfig, importConfig, explicitOf, stateFile, logFile, runLogFile, dataDir,
  // 机器标识：idFromFingerprint 是纯函数（断言直接打它）；machineFingerprint 只读不写
  idFromFingerprint, machineFingerprint,
  // 失败可诊断性：describeErr 是纯函数（断言直接打它）；errorLogFile/appendErrorLog 给测试读落盘台账
  describeErr, errorLogFile, appendErrorLog };
