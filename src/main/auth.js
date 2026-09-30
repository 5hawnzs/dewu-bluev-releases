'use strict';
/**
 * 本机账号与登录（纯离线，不联网、无服务端）
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

const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'BlueV@2026';
const REMEMBER_DAYS = 7;
const MAX_FAIL = 6;                 // 连续失败到此次数后锁定
const LOCK_MS = 5 * 60 * 1000;     // 锁定 5 分钟
const MIN_PASS = 6;

let db = null;
let session = null;
const fails = new Map();            // 小写用户名 -> { n, until }

/* ---------------- 存储 ---------------- */
function file() { return path.join(app.getPath('userData'), 'auth.json'); }

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
    mustChange: !!u.mustChange, disabled: !!u.disabled,
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null
  };
}

/* ---------------- 会话 ---------------- */
function restoreSession() {
  const r = db.remember;
  if (!r || !r.until || r.until < Date.now()) { if (r) { db.remember = null; save(); } return; }
  const u = findUserById(r.userId);
  if (!u || u.disabled) { db.remember = null; save(); return; }
  session = { userId: u.id, loginAt: Date.now(), remembered: true };
}

function enabled() { return process.env.BLUEV_NO_LOGIN !== '1'; }

function current() {
  if (!session) return null;
  const u = findUserById(session.userId);
  if (!u || u.disabled) { session = null; return null; }
  return u;
}

function status() {
  load();
  const u = current();
  return {
    requireLogin: enabled(),
    user: u ? publicUser(u) : null,
    isAdmin: !!(u && u.role === 'admin'),
    userCount: db.users.length,
    rememberDays: REMEMBER_DAYS,
    // 出厂口令还没改时，登录页给个明示，免得拿到包的人无从下手
    defaultHint: db.usingDefault ? { username: findUser(DEFAULT_USER) ? DEFAULT_USER : db.users[0].username, password: DEFAULT_PASS } : null
  };
}

function login(username, password, remember) {
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
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  return { ok: true, users: db.users.map(publicUser), currentId: g.user.id };
}

function createUser(input) {
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const ne = nameError(input && input.username);
  if (ne) return { ok: false, error: ne };
  const pe = passError(input && input.password);
  if (pe) return { ok: false, error: pe };
  if (findUser(input.username)) return { ok: false, error: '这个账号已经存在' };
  const u = makeUser(input.username, input.password, input.role, input.displayName || input.username);
  db.users.push(u);
  save();
  return { ok: true, user: publicUser(u) };
}

function updateUser(id, patch) {
  const g = guardAdmin();
  if (g.error) return { ok: false, error: g.error };
  load();
  const u = findUserById(id);
  if (!u) return { ok: false, error: '账号不存在' };
  const p = patch || {};
  if (p.displayName != null) u.displayName = String(p.displayName).trim() || u.username;
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

module.exports = {
  load, status, login, logout, enabled, current,
  changePassword, listUsers, createUser, updateUser, resetPassword, removeUser,
  DEFAULT_USER, DEFAULT_PASS
};
