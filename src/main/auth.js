'use strict';
/**
 * 账号与登录。开发/回归仍可走本机 auth.json；正式安装版默认走 Supabase 统一账号。
 *
 * - 账号库：userData/auth.json，和 config.json 分开存，避免被「设置 → 保存」整体覆盖
 * - 口令：crypto.scrypt + 每账号随机盐，只存哈希，不存明文
 * - 会话：主进程内存中的 session；勾了「记住登录」会写入 auth.json，7 天内免密
 * - 初始化：首次启动自动建一个管理员账号
 *     账号 admin / 口令 BlueV@2026
 *     也可以在首次启动前用环境变量指定：BLUEV_ADMIN_USER / BLUEV_ADMIN_PASS
 *   （用 BLUEV_ADMIN_PASS 指定过就不再提示「改默认口令」）
 * - 想临时免登录开发：BLUEV_NO_LOGIN=1
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const wp = require('./util/winpath');
const brands = require('./brands');
const cloudauth = require('./services/cloudauth');

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'BlueV@2026';
const REMEMBER_DAYS = 7;
const MAX_FAIL = 6;                 // 连续失败到此次数后锁定
const LOCK_MS = 5 * 60 * 1000;     // 锁定 5 分钟
const MIN_PASS = 6;

let db = null;
let session = null;
let cloudSession = null;           // { token, user, remembered }
const fails = new Map();            // 小写用户名 -> { n, until }

/* ---------------- 存储 ---------------- */
function file() { return path.join(app.getPath('userData'), 'auth.json'); }

// 正式包统一走云端。开发者可以显式设 BLUEV_LOCAL_AUTH=1 隔离回归数据；
// 不把本地账号自动回退成云端登录失败的后门。
function cloudMode() {
  if (app && app.isPackaged) return true;
  return enabled() && process.env.BLUEV_LOCAL_AUTH !== '1' && process.env.BLUEV_CLOUD_AUTH === '1';
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(10).toString('hex');
}

function makeUser(username, password, role, displayName) {
  const salt = newSalt();
  return {
    id: newId(),
    username: String(username).trim(),
    displayName: String(displayName || username).trim(),
    role: role === 'admin' ? 'admin' : 'user',
    // 品牌权限：存的是品牌 id（config.json → brands[].id），不是品牌名 —— 改名不该把权限弄丢。
    // 管理员不看这个字段（恒等于「全部品牌」）；把管理员降级成普通成员时它是空的 = 默认无权限，
    // 这是故意的：降权后应当由管理员显式分配，而不是继承他当管理员时的「全部」。
    brands: [],
    salt,
    hash: hashPassword(password, salt),
    mustChange: false,
    disabled: false,
    createdAt: Date.now(),
    lastLoginAt: null
  };
}

/**
 * 管理员账号的三个来源，优先级从高到低：
 *   1) 环境变量 BLUEV_ADMIN_USER / BLUEV_ADMIN_PASS
 *   2) userData/auth.seed.json —— { "username": "xxx", "password": "xxx" }，首次启动读走后即删
 *   3) 出厂默认 admin / BlueV@2026
 */
function seedFrom() {
  let username = (process.env.BLUEV_ADMIN_USER || '').trim();
  let password = process.env.BLUEV_ADMIN_PASS || '';
  if (!username || !password) {
    try {
      const f = path.join(app.getPath('userData'), 'auth.seed.json');
      const j = JSON.parse(fs.readFileSync(wp.toLong(f), 'utf8'));
      username = username || String(j.username || '').trim();
      password = password || String(j.password || '');
      fs.unlinkSync(wp.toLong(f));    // 明文口令不留盘
    } catch (e) { /* 没放种子文件，走默认 */ }
  }
  return { username: username || DEFAULT_USER, password: password || DEFAULT_PASS, usingDefault: !password };
}

function seed() {
  const s = seedFrom();
  const admin = makeUser(s.username, s.password, 'admin', '管理员');
  admin.mustChange = s.usingDefault;   // 还在用出厂口令 → 提示改掉
  return { version: 1, users: [admin], remember: null, usingDefault: s.usingDefault, updatedAt: Date.now() };
}

function load() {
  if (db) return db;
  try {
    const raw = fs.readFileSync(wp.toLong(file()), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users) || !parsed.users.length) throw new Error('empty');
    db = parsed;
  } catch (e) {
    db = seed();
    save();
  }
  if (db.remember && typeof db.remember !== 'object') db.remember = null;
  // 老 auth.json 里的账号没有 brands 字段 → 补成空数组（= 无品牌权限）并落盘。
  // 补一次就写回去，免得每次启动都算一遍、也免得下游到处再判一次 undefined
  let migrated = false;
  for (const u of db.users) if (!Array.isArray(u.brands)) { u.brands = []; migrated = true; }
  if (migrated) save();
  restoreSession();
  return db;
}

function save() {
  if (!db) return;
  db.updatedAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(wp.toLong(tmp), JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, file());
  } catch (e) { /* 只读盘等场景静默降级 */ }
}

function findUser(name) {
  const k = String(name || '').trim().toLowerCase();
  return db.users.find(u => String(u.username).toLowerCase() === k) || null;
}
function findUserById(id) { return db.users.find(u => u.id === id) || null; }

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role,
    brands: (Array.isArray(u.brands) ? u.brands : []).map(String),
    mustChange: !!u.mustChange, disabled: !!u.disabled,
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null
  };
}

/**
 * 校验要写入的品牌权限。
 * 认不出来的 id **直接报错，不静默丢弃** —— 静默丢弃意味着「我勾了 3 个品牌，界面也说保存成功，
 * 实际只生效 2 个」，这种账不平最难查。已停用但还存在的品牌是允许分配的（管理员可能只是临时停用）。
 */
function brandsError(ids) {
  if (ids == null) return null;
  if (!Array.isArray(ids)) return '品牌权限要给一个数组';
  const all = brands.list();
  const known = new Set(all.map(b => b.id));
  const bad = ids.map(String).filter(x => x && !known.has(x));
  if (bad.length) return `这些品牌不存在（可能已被删除）：${bad.join('、')}；当前可用品牌：${all.map(b => b.name).join('、') || '（一个都没有）'}`;
  return null;
}
function cleanBrands(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
}

/* ---------------- 会话 ---------------- */
function restoreSession() {
  const r = db.remember;
  if (!r || !r.until || r.until < Date.now()) { if (r) { db.remember = null; save(); } return; }
  const u = findUserById(r.userId);
  if (!u || u.disabled) { db.remember = null; save(); return; }
  session = { userId: u.id, loginAt: Date.now(), remembered: true };
}

function enabled() { return !!(app && app.isPackaged) || process.env.BLUEV_NO_LOGIN !== '1'; }

function current() {
  if (cloudMode()) {
    if (cloudSession && cloudSession.expiresAt && cloudSession.expiresAt <= Date.now()) cloudSession = null;
    return cloudSession && cloudSession.user ? cloudSession.user : null;
  }
  if (!session) return null;
  const u = findUserById(session.userId);
  if (!u || u.disabled) { session = null; return null; }
  return u;
}

function status() {
  if (cloudMode()) return cloudStatus();
  load();
  const u = current();
  return {
    requireLogin: enabled(),
    user: u ? publicUser(u) : null,
    isAdmin: !!(u && u.role === 'admin'),
    userCount: db.users.length,
    rememberDays: REMEMBER_DAYS
    // ★ 出厂账号提示（defaultHint）已删：登录页不再回显 admin / 口令（2026-10-02 用户要求）。
    //   出厂口令本身没变，管理员账号与 mustChange 提示都还在。
  };
}

// 网络故障沿用本次运行中已验证的会话，但不能超过令牌有效期。
// 不用磁盘缓存绕过首次登录，也不忽略服务器明确返回的失效结果。
function transientCloudStatus(error) {
  const now = Date.now();
  const active = cloudSession && cloudSession.expiresAt > now;
  if (!active) cloudSession = null;
  return { requireLogin: true, user: active ? cloudSession.user : null,
    isAdmin: !!(active && cloudSession.user.role === 'admin'),
    rememberDays: REMEMBER_DAYS, cloud: true, offline: true, error };
}

// 云端仅同步品牌身份和权限；本机提示词不被其他设备覆盖。
function applyCloudBrands(rows) {
  const local = new Map(brands.list().map(b => [b.id, b.promptWrite || '']));
  brands.replaceAll(rows.map(b => ({ ...b, promptWrite: local.get(b.id) || '' })));
}

async function syncBrandDirectory(token, list) {
  const remote = await cloudauth.brands(token);
  if (!remote.ok || !Array.isArray(remote.brands)) return remote;
  // 兼容既有服务端接口：保留其旧提示词列，不上传本机编辑的提示词。
  const oldPrompts = new Map(remote.brands.map(b => [b.id, b.promptWrite || '']));
  return cloudauth.admin(token, 'save_brands', {
    brands: list.map(b => ({ ...b, promptWrite: oldPrompts.get(b.id) || '' }))
  });
}

async function cloudStatus() {
  load();
  const token = (cloudSession && cloudSession.token) || (db.cloudRemember && db.cloudRemember.token) || '';
  let loginNotice = '';
  if (token) {
    const r = await cloudauth.status(token);
    if (r.ok && r.user) {
      const candidate = { token, user: normalizeCloudUser(r.user), remembered: !!(db.cloudRemember && db.cloudRemember.token === token), expiresAt: Number(r.expiresAt) || 0, verifiedAt: Date.now() };
      // Also hydrate the canonical brand directory on startup and every status refresh.
      // A remembered session on a new device must not depend on a local config.json copy.
      const remoteBrands = await cloudauth.brands(token);
      if (!remoteBrands.ok || !Array.isArray(remoteBrands.brands)) {
        if (!remoteBrands.sessionInvalid) return transientCloudStatus(remoteBrands.error || '品牌权限同步暂时不可用');
        cloudSession = null;
        return { requireLogin: true, user: null, isAdmin: false, cloud: true,
          error: remoteBrands.error || '无法读取品牌权限，请重试' };
      }
      applyCloudBrands(remoteBrands.brands);
      cloudSession = candidate;
      if (cloudSession.remembered) { db.cloudRemember.user = cloudSession.user; save(); }
      return { requireLogin: true, user: cloudSession.user, isAdmin: cloudSession.user.role === 'admin', userCount: null, rememberDays: REMEMBER_DAYS, cloud: true,
        brandsRevision: JSON.stringify(remoteBrands.brands.map(b => [b.id, b.name, b.enabled])) };
    }
    if (!r.sessionInvalid) return transientCloudStatus(r.error || '暂时无法校验登录状态');
    cloudSession = null;
    loginNotice = r.error || '';
    if (db.cloudRemember) { delete db.cloudRemember; save(); }
    if (r.setupRequired) return { requireLogin: true, user: null, isAdmin: false, rememberDays: REMEMBER_DAYS, cloud: true, setupRequired: true, error: r.error };
  }
  const s = await cloudauth.setupState();
  if (!s.ok) return { requireLogin: true, user: null, isAdmin: false, rememberDays: REMEMBER_DAYS, cloud: true, setupRequired: !!s.setupRequired, error: s.error };
  return { requireLogin: true, user: null, isAdmin: false, rememberDays: REMEMBER_DAYS, cloud: true, bootstrapRequired: !s.initialized, bootstrapAvailable: !!s.bootstrapAvailable, error: loginNotice };
}

function normalizeCloudUser(u) {
  return { id: String(u.id || ''), username: String(u.username || ''), displayName: String(u.displayName || u.username || ''),
    role: u.role === 'admin' ? 'admin' : 'user', brands: Array.isArray(u.brands) ? u.brands.map(String) : [],
    mustChange: !!u.mustChange, disabled: !!u.disabled, createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null };
}

async function cloudLogin(username, password, remember) {
  const r = await cloudauth.login(username, password);
  if (!r.ok || !r.token || !r.user) return r;
  const user = normalizeCloudUser(r.user);
  cloudSession = { token: r.token, user, remembered: !!remember, expiresAt: Number(r.expiresAt) || Date.now() + REMEMBER_DAYS * 86400000, verifiedAt: Date.now() };
  load();
  if (remember) db.cloudRemember = { token: r.token, user, until: cloudSession.expiresAt };
  else delete db.cloudRemember;
  save();

  // Brand IDs and assignments are global too; pull the canonical list on every device.
  let cloudBrands = await cloudauth.brands(r.token);
  if (!cloudBrands.ok) {
    await cloudauth.logout(r.token);
    cloudSession = null; if (remember) delete db.cloudRemember; save();
    return cloudBrands;
  }
  const localBrands = brands.list();
  if (user.role === 'admin' && (!Array.isArray(cloudBrands.brands) || cloudBrands.brands.length === 0) && localBrands.length) {
    const seeded = await syncBrandDirectory(r.token, localBrands);
    if (!seeded.ok) {
      await cloudauth.logout(r.token);
      cloudSession = null; if (remember) delete db.cloudRemember; save();
      return { ok: false, error: `云端品牌初始化失败：${seeded.error || '未知错误'}` };
    }
    cloudBrands = { ok: true, brands: localBrands };
  }
  applyCloudBrands(Array.isArray(cloudBrands.brands) ? cloudBrands.brands : []);
  return { ok: true, user };
}

async function cloudBootstrap(setupCode, username, password, displayName, remember) {
  const r = await cloudauth.bootstrap(setupCode, username, password, displayName);
  if (!r.ok || !r.token || !r.user) return r;
  const user = normalizeCloudUser(r.user);
  cloudSession = { token: r.token, user, remembered: !!remember, expiresAt: Number(r.expiresAt) || Date.now() + REMEMBER_DAYS * 86400000 };
  load();
  if (remember) db.cloudRemember = { token: r.token, user, until: cloudSession.expiresAt };
  save();
  const localBrands = brands.list();
  let warning = '';
  if (localBrands.length) {
    const b = await syncBrandDirectory(r.token, localBrands);
    if (!b.ok) warning = `管理员已创建，但本机品牌目录未能上云：${b.error || '未知错误'}`;
  }
  return { ok: true, user, warning };
}

function login(username, password, remember) {
  if (cloudMode()) return cloudLogin(username, password, remember);
  load();
  const key = String(username || '').trim().toLowerCase();
  const lock = fails.get(key);
  if (lock && lock.until > Date.now()) {
    return { ok: false, error: `失败次数过多，请 ${Math.ceil((lock.until - Date.now()) / 60000)} 分钟后再试` };
  }
  if (!key || !password) return { ok: false, error: '请输入账号和密码' };

  const u = findUser(key);
  if (!u) return bumpFail(key, '账号或密码不正确');
  if (u.disabled) return { ok: false, error: '账号已停用，请联系管理员' };
  if (!check(password, u)) return bumpFail(key, '账号或密码不正确');

  fails.delete(key);
  u.lastLoginAt = Date.now();
  db.remember = remember ? { userId: u.id, until: Date.now() + REMEMBER_DAYS * 86400000 } : null;
  save();
  session = { userId: u.id, loginAt: Date.now(), remembered: !!remember };
  return { ok: true, user: publicUser(u) };
}

function bumpFail(key, msg) {
  const cur = fails.get(key) || { n: 0, until: 0 };
  cur.n += 1;
  if (cur.n >= MAX_FAIL) { cur.n = 0; cur.until = Date.now() + LOCK_MS; }
  fails.set(key, cur);
  return { ok: false, error: msg };
}

function check(pw, u) {
  const a = Buffer.from(hashPassword(pw, u.salt), 'hex');
  const b = Buffer.from(String(u.hash || ''), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function logout() {
  if (cloudMode()) {
    const old = cloudSession && cloudSession.token;
    cloudSession = null;
    load(); delete db.cloudRemember; save();
    return old ? cloudauth.logout(old) : { ok: true };
  }
  if (db) { db.remember = null; save(); }
  session = null;
  return { ok: true };
}

/* ---------------- 管理员操作 ---------------- */
function guardAdmin() {
  const u = current();
  if (!u) return { error: '未登录' };
  if (u.role !== 'admin') return { error: '只有管理员能做这个操作' };
  return { user: u };
}

function changePassword(oldPw, newPw) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    if (!token) return Promise.resolve({ ok: false, error: '未登录' });
    return cloudauth.changePassword(token, oldPw, newPw).then(r => {
      if (r.ok && cloudSession) { cloudSession.user.mustChange = false; if (db.cloudRemember) db.cloudRemember.user = cloudSession.user; save(); }
      return r;
    });
  }
  load();
  const u = current();
  if (!u) return { ok: false, error: '未登录' };
  if (!check(oldPw || '', u)) return { ok: false, error: '当前密码不对' };
  const bad = passError(newPw);
  if (bad) return { ok: false, error: bad };
  u.salt = newSalt();
  u.hash = hashPassword(newPw, u.salt);
  u.mustChange = false;
  db.usingDefault = false;
  save();
  return { ok: true };
}

function passError(pw) {
  const s = String(pw || '');
  if (s.length < MIN_PASS) return `口令至少 ${MIN_PASS} 位`;
  if (/[\u4e00-\u9fa5]/.test(s)) return '口令不要用中文';
  return null;
}
function nameError(name) {
  const s = String(name || '').trim();
  if (s.length < 3 || s.length > 32) return '账号要 3–32 位';
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return '账号只能用字母、数字、点、下划线、短横线';
  return null;
}

function listUsers() {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'list_users', {}) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  return { ok: true, users: db.users.map(publicUser), currentId: g.user.id };
}

function createUser(input) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'create_user', input || {}) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const ne = nameError(input && input.username);
  if (ne) return { ok: false, error: ne };
  const pe = passError(input && input.password);
  if (pe) return { ok: false, error: pe };
  if (findUser(input.username)) return { ok: false, error: '这个账号已经存在' };
  const whole = brandsError(input && input.brands);
  if (whole) return { ok: false, error: whole };
  const u = makeUser(input.username, input.password, input.role, input.displayName || input.username);
  u.brands = cleanBrands(input && input.brands);
  db.users.push(u);
  save();
  return { ok: true, user: publicUser(u) };
}

function updateUser(id, patch) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'update_user', Object.assign({ id }, patch || {})) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const u = findUserById(id);
  if (!u) return { ok: false, error: '账号不存在' };
  const p = patch || {};
  if (p.displayName != null) u.displayName = String(p.displayName).trim() || u.username;
  if (p.brands != null) {
    const be = brandsError(p.brands);
    if (be) return { ok: false, error: be };
    // 存着不清：管理员改回普通成员时原来的分配还在，不用重配一遍。
    // 管理员的**实际**范围永远是「全部品牌」（brands.allowed 里判的），这里的值只是留档
    u.brands = cleanBrands(p.brands);
  }
  if (p.role != null) {
    if (u.id === g.user.id) return { ok: false, error: '不能改自己的角色' };
    u.role = p.role === 'admin' ? 'admin' : 'user';
  }
  if (p.disabled != null) {
    if (u.id === g.user.id) return { ok: false, error: '不能停用自己' };
    if (p.disabled && u.role === 'admin' && db.users.filter(x => x.role === 'admin' && !x.disabled).length <= 1) {
      return { ok: false, error: '至少要留一个启用中的管理员' };
    }
    u.disabled = !!p.disabled;
  }
  save();
  return { ok: true, user: publicUser(u) };
}

function resetPassword(id, newPw) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'reset_password', { id, password: newPw }) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const u = findUserById(id);
  if (!u) return { ok: false, error: '账号不存在' };
  const pe = passError(newPw);
  if (pe) return { ok: false, error: pe };
  u.salt = newSalt();
  u.hash = hashPassword(newPw, u.salt);
  u.mustChange = true;
  save();
  return { ok: true, user: publicUser(u) };
}

function removeUser(id) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'remove_user', { id }) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const u = findUserById(id);
  if (!u) return { ok: false, error: '账号不存在' };
  if (u.id === g.user.id) return { ok: false, error: '不能删自己' };
  if (u.role === 'admin' && db.users.filter(x => x.role === 'admin' && !x.disabled).length <= 1) {
    return { ok: false, error: '至少要留一个管理员' };
  }
  db.users = db.users.filter(x => x.id !== id);
  if (db.remember && db.remember.userId === id) db.remember = null;
  save();
  return { ok: true };
}

/**
 * 品牌从注册表删除后，把账号上指向它的授权清掉。
 * 不清也能跑（`brands.allowed` 会滤掉不存在的 id），但会越攒越多悬空引用，
 * 界面上一堆「已删除的品牌」也干扰判断。删一个品牌顺手清一次最省事。
 * 返回清理了几个账号，好让界面说清影响面。
 */
function purgeBrand(brandId) {
  if (cloudMode()) {
    const token = cloudSession && cloudSession.token;
    return token ? cloudauth.admin(token, 'list_users', {}).then(async r => {
      if (!r.ok) return r;
      for (const u of (r.users || [])) if ((u.brands || []).includes(String(brandId))) {
        const x = await cloudauth.admin(token, 'update_user', { id: u.id, brands: u.brands.filter(b => b !== String(brandId)) });
        if (!x.ok) return x;
      }
      return { ok: true, users: (r.users || []).filter(u => (u.brands || []).includes(String(brandId))).length };
    }) : Promise.resolve({ ok: false, error: '未登录' });
  }
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const id = String(brandId || '');
  if (!id) return { ok: false, error: '缺少品牌 id' };
  let n = 0;
  for (const u of db.users) {
    if (Array.isArray(u.brands) && u.brands.includes(id)) {
      u.brands = u.brands.filter(x => x !== id);
      n++;
    }
  }
  if (n) save();
  return { ok: true, users: n };
}

module.exports = {
  load, status, login, logout, enabled, current, cloudMode, cloudBootstrap,
  changePassword, listUsers, createUser, updateUser, resetPassword, removeUser,
  purgeBrand,
  syncBrands: (list) => cloudMode() && cloudSession ? syncBrandDirectory(cloudSession.token, list) : Promise.resolve({ ok: true }),
  cloudBrands: () => cloudMode() && cloudSession ? cloudauth.brands(cloudSession.token) : Promise.resolve({ ok: true, brands: brands.list() }),
  DEFAULT_USER, DEFAULT_PASS
};
