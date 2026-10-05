'use strict';
/**
 * 品牌注册表 + 品牌权限
 *
 * 为什么单独一个模块：
 *   品牌原来只是设置页上一个没人读的输入框（`copy.brand`），现在它是**跨模块的维度** ——
 *   文案 / 发布单 / 发布日志 / 统计 / 账号权限都要用到它。给它一份唯一定义，别让各处各写一套，
 *   否则「同一个品牌在两个地方叫法不同」这种事迟早会让统计对不上。
 *
 * 存在哪：
 *   注册表 → config.json 顶层 `brands`：`[{ id, name, enabled, note, createdAt }]`
 *   权限   → auth.json 里 `user.brands = ['brd_xxx', ...]`
 *
 * 两条硬规则：
 *   1. **品牌用 id 标识，权限也存 id**。管理员把「品牌甲」改名成「品牌甲 2026」时，
 *      权限不该跟着丢 —— 存名字就会丢。
 *   2. **认不出来的不等于没有**。历史发布记录里没有品牌字段，那是「未标品牌」（`UNKNOWN_NAME`），
 *      不是某个品牌的 0，也不能被悄悄丢掉。统计侧必须把它单列出来。
 *
 * ⚠️ 这是**本机离线**的权限，用途是「防误操作 + 让产出可归属」，**不是安全边界**：
 *    能碰到这台机器的人可以直接改 config.json / auth.json。界面上不要把它写成「安全隔离」。
 */
const crypto = require('crypto');
const store = require('./store');

const MAX_NAME = 24;
/** 单个品牌一段提示词的上限（字）。超了截断而不是报错：粘贴一整份文档时不该整条保存失败 */
const MAX_PROMPT = 4000;
const UNKNOWN_ID = '';                 // 历史记录 / 没选品牌时用
const UNKNOWN_NAME = '未标品牌';
/** 这些名字留给统计口径用，不能被注册成真实品牌，否则统计里会分不清是不是真的品牌 */
const RESERVED = [UNKNOWN_NAME, '全部', '全部品牌', '未分配', '已删除品牌'];

function newId() {
  // 不能只用 Date.now()：连着建两个品牌会撞同一毫秒（和 publisher.addDevice 是同一个坑）
  return 'brd_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function normName(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function key(s) { return normName(s).toLowerCase(); }
function normNote(s) { return String(s == null ? '' : s).trim().slice(0, 120); }

/**
 * 提示词正文。统一成 \n（粘贴来的多半是 \r\n），去掉首尾空白，并**限长**：
 * 这段字会原样拼进每次模型请求的 system，几万字的模板会把每一篇的请求都撑爆。
 */
function normPrompt(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, MAX_PROMPT);
}

function raw() {
  const v = store.get('brands');
  return Array.isArray(v) ? v : [];
}

/** 单条规整；名字为空的直接丢掉（不做「无名品牌」这种谁也对不上的东西） */
function normalize(b) {
  if (!b || typeof b !== 'object') return null;
  const name = normName(b.name);
  if (!name) return null;
  return {
    id: String(b.id || newId()),
    name,
    enabled: b.enabled !== false,
    note: normNote(b.note),
    // 品牌自己的文案提示词。留空 = 没配：文案生成会**明确报错**，不拿别的品牌的口吻顶替
    promptWrite: normPrompt(b.promptWrite),
    createdAt: Number(b.createdAt) || Date.now()
  };
}

/**
 * 首次运行把旧的单选「品牌」配置迁进来。
 * 用 `brandsSeeded` 标记，而不是「数组为空就补」—— 否则管理员故意删空品牌列表时会被反复塞回来。
 */
function ensure() {
  if (store.get('brandsSeeded')) return;
  if (raw().length) { store.set({ brandsSeeded: true }); return; }
  const legacy = normName(store.get('copy.brand'));
  const list = legacy
    ? [{ id: newId(), name: legacy, enabled: true, note: '由原「设置 → 品牌」单选框迁移', createdAt: Date.now() }]
    : [];
  store.set({ brands: list, brandsSeeded: true });
}

function list() {
  ensure();
  return raw().map(normalize).filter(Boolean);
}

function enabledList() { return list().filter(b => b.enabled); }

function byId(id) {
  const k = String(id == null ? '' : id);
  if (!k) return null;
  return list().find(b => b.id === k) || null;
}

function byName(name) {
  const k = key(name);
  if (!k) return null;
  return list().find(b => key(b.name) === k) || null;
}

/** 停用 / 删除后，界面上要能说清「这个 id 是什么」而不是只剩一串乱码 */
function labelOf(id, fallback) {
  const b = byId(id);
  if (b) return b.name;
  return fallback == null ? (id ? `已删除的品牌（${id}）` : UNKNOWN_NAME) : fallback;
}

function nameError(name, selfId) {
  const n = normName(name);
  if (!n) return '品牌名不能为空';
  if (n.length > MAX_NAME) return `品牌名最长 ${MAX_NAME} 个字`;
  if (RESERVED.some(r => key(r) === key(n))) return `「${n}」是统计口径的保留名，换一个`;
  const dup = list().find(b => key(b.name) === key(n) && b.id !== selfId);
  if (dup) return `品牌「${n}」已经存在（同名会被统计合并，所以不允许重复）`;
  return null;
}

function save(next) {
  const clean = next.map(normalize).filter(Boolean);
  store.set({ brands: clean, brandsSeeded: true });
  return list();
}

function add(input) {
  ensure();
  const name = normName(input && input.name);
  const err = nameError(name, null);
  if (err) return { ok: false, error: err };
  const b = {
    id: newId(), name,
    enabled: (input && input.enabled) !== false,
    note: normNote(input && input.note),
    promptWrite: normPrompt(input && input.promptWrite),
    createdAt: Date.now()
  };
  save(raw().concat([b]));
  return { ok: true, brand: b };
}

function update(id, patch) {
  ensure();
  const cur = raw();
  const i = cur.findIndex(b => String(b.id) === String(id));
  if (i < 0) return { ok: false, error: '品牌不存在' };
  const p = patch || {};
  const next = Object.assign({}, normalize(cur[i]));
  if (p.name != null) {
    const name = normName(p.name);
    const err = nameError(name, next.id);
    if (err) return { ok: false, error: err };
    next.name = name;
  }
  if (p.enabled != null) next.enabled = !!p.enabled;
  if (p.note != null) next.note = normNote(p.note);
  if (p.promptWrite != null) next.promptWrite = normPrompt(p.promptWrite);
  cur[i] = next;
  save(cur);
  return { ok: true, brand: normalize(next) };
}

/** 删除只是「从注册表移除」：历史发布日志里的 brandId 还留着，统计会把它单列成「已删除的品牌」 */
function remove(id) {
  ensure();
  const cur = raw();
  const hit = cur.find(b => String(b.id) === String(id));
  if (!hit) return { ok: false, error: '品牌不存在' };
  save(cur.filter(b => String(b.id) !== String(id)));
  return { ok: true, brand: normalize(hit) };
}

/* ---------------- 权限 ---------------- */

/**
 * 这个品牌配没配「文案生成提示词」。
 * 没配就**不允许生成**：让模型自由发挥等于拿一个谁也没确认过的口吻在写，
 * 出来一堆看不出归属的文案比直接报错更难查。调用点见 jobs.run 的前置校验。
 */
function hasWritePrompt(b) { return !!(b && String(b.promptWrite || '').trim()); }

function isAdmin(user) { return !!(user && user.role === 'admin'); }

/**
 * 这个用户能用哪些品牌。
 * 管理员 = 全部启用中的品牌（`all: true`）。
 * 普通成员 = 名下且启用中的那些。
 * `assigned` 是原名下的 id（含已停用/已删除的），用来区分「没分配」和「分配了但都停用了」——
 * 这两种情况的界面提示必须不一样，否则用户会拿着错的原因去找管理员。
 */
function allowed(user) {
  const all = enabledList();
  // ★ 没有当前账号 = 免登录开发模式（auth.enabled() 为 false，guard 放行全部）。
  //   这里必须也按「全部」算，理由有两条：
  //   ① 与 resolveFor 里那段 `if (!user)` 的特判同一口径 —— 否则同一个模式下
  //      「任务能归属任意品牌、品牌列表却一个都不显示」，前后矛盾；
  //   ② 与 ipc.scopeOf() 也同一口径 —— 那里是「没账号 = 不设范围」，不然统计能看全部品牌，
  //      品牌下拉却是空的，用户只会以为是坏了。
  if (!user || isAdmin(user)) return { all: true, brands: all, ids: all.map(b => b.id), assigned: all.map(b => b.id) };
  const assigned = (Array.isArray(user && user.brands) ? user.brands : []).map(String).filter(Boolean);
  const mine = all.filter(b => assigned.includes(b.id));
  return { all: false, brands: mine, ids: mine.map(b => b.id), assigned };
}

/**
 * 解析「这次任务归属哪个品牌」，顺便把权限卡掉。
 *   required=true  —— 产出可发布内容的那些任务（文案/报告导入/发布单/发布）
 *   required=false —— 素材整理、合规这类准备动作（有就带上，没有算「未标」）
 *
 * 会自动补品牌的情形只有一种：**对方能用的品牌恰好只有一个**。
 * 有多个却没说 → 报错并列出可选值，不替他挑（挑错了产出的归属就是错的，比报错更难查）。
 */
function resolveFor(user, wantedId, opts = {}) {
  const required = !!opts.required;
  const wanted = String(wantedId == null ? '' : wantedId);

  // 没登录：免登录开发模式 / 测试里直接调 jobs。权限层已经不适用，有就给、没有就留空
  if (!user) {
    if (!wanted) return { ok: true, brand: null };
    const b = byId(wanted);
    return b ? { ok: true, brand: b } : { ok: false, error: `品牌不存在：${wanted}` };
  }

  const a = allowed(user);

  if (wanted) {
    const b = byId(wanted);
    if (!b) return { ok: false, error: `品牌不存在：${wanted}` };
    if (!a.all && !a.ids.includes(b.id)) {
      const mine = a.brands.map(x => x.name).join('、');
      return { ok: false, error: `没有「${b.name}」的操作权限（${mine ? '你有权限的是：' + mine : '你名下还没有可用的品牌'}）` };
    }
    return { ok: true, brand: b };
  }

  if (!required) return { ok: true, brand: null };

  if (!a.brands.length) {
    if (isAdmin(user)) return { ok: false, error: '还没有品牌可归属：先到「品牌与权限」页添加一个品牌' };
    return {
      ok: false,
      error: a.assigned.length
        ? '你名下的品牌都已停用或被删除，请联系管理员重新分配'
        : '当前账号还没有分配品牌，请联系管理员在「品牌与权限 → 账号管理」里分配后再操作'
    };
  }
  if (a.brands.length === 1) return { ok: true, brand: a.brands[0], auto: true };

  const scope = isAdmin(user) ? '可选' : '你有权限的';
  return { ok: false, error: `请先选择品牌（${scope}：${a.brands.map(b => b.name).join('、')}）` };
}

module.exports = {
  ensure, list, enabledList, byId, byName, labelOf,
  add, update, remove, nameError, hasWritePrompt,
  isAdmin, allowed, resolveFor,
  UNKNOWN_ID, UNKNOWN_NAME, RESERVED, MAX_NAME, MAX_PROMPT
};
