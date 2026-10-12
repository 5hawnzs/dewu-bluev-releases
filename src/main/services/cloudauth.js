'use strict';
// Central account service. Only the public Supabase key is used by this client; account
// hashes and session rows stay in the private Postgres schema behind narrowly granted RPCs.
const CD = require('../clouddefaults');

const TIMEOUT_MS = 12000;

async function rpc(name, body) {
  const base = String(CD.url || '').replace(/\/+$/, '');
  const key = String(CD.anonKey || '');
  if (!base || !key) return { ok: false, error: '云端账号服务未配置' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      const code = data && (data.code || data.error_code);
      if (res.status === 404 || code === 'PGRST202' || code === 'PGRST205') {
        return { ok: false, setupRequired: true, error: '云端账号表尚未初始化，请先在 Supabase 执行 docs/supabase-auth-migration.sql' };
      }
      return { ok: false, offline: res.status === 429 || res.status >= 500,
        error: `云端账号服务返回 HTTP ${res.status}${code ? ` · ${code}` : ''}` };
    }
    if (data && typeof data === 'object') {
      // 仅数据库明确返回的会话失效结果可触发退出；HTTP 和解析错误不算失效。
      if ((name === 'bluev_auth_status' || name === 'bluev_auth_brands')
          && data.ok === false && data.error === '登录已过期') data.sessionInvalid = true;
      return data;
    }
    return { ok: false, offline: true, error: '云端账号服务返回了无效响应' };
  } catch (e) {
    const detail = e && e.name === 'AbortError' ? '请求超时' : String((e && e.cause && e.cause.code) || (e && e.message) || e);
    return { ok: false, offline: true, error: `无法连接云端账号服务：${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

const setupState = () => rpc('bluev_auth_setup_state', {});
const bootstrap = (setupCode, username, password, displayName) => rpc('bluev_auth_bootstrap', {
  p_setup_code: setupCode, p_username: username, p_password: password, p_display_name: displayName || ''
});
const login = (username, password) => rpc('bluev_auth_login', { p_username: username, p_password: password });
const status = token => rpc('bluev_auth_status', { p_token: token || '' });
const admin = (token, action, payload) => rpc('bluev_auth_admin', { p_token: token || '', p_action: action, p_payload: payload || {} });
const brands = token => rpc('bluev_auth_brands', { p_token: token || '' });
const changePassword = (token, oldPassword, newPassword) => rpc('bluev_auth_change_password', {
  p_token: token || '', p_old: oldPassword, p_new: newPassword
});
const logout = token => rpc('bluev_auth_logout', { p_token: token || '' });

module.exports = { setupState, bootstrap, login, status, admin, brands, changePassword, logout };
