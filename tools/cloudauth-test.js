'use strict';
// Unit tests for the desktop's narrow Supabase auth RPC client. Network is stubbed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const auth = require('../src/main/services/cloudauth');
const sql = fs.readFileSync(path.join(__dirname, '..', 'docs', 'supabase-auth-migration.sql'), 'utf8');

let tests = 0;
function ok(label, fn) {
  try { fn(); tests++; console.log('PASS  ' + label); }
  catch (e) { console.error('FAIL  ' + label + ' → ' + (e && e.message || e)); process.exitCode = 1; }
}

async function main() {
  const originalFetch = global.fetch;
  const originalModuleLoad = Module._load;
  const requests = [];
  try {
    global.fetch = async (url, options) => {
      requests.push({ url: String(url), options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, token: 'unit-test-token', user: { id: 'u1', role: 'admin' } }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    };
    const login = await auth.login('operator', 'NeverPrintThis123');
    ok('登录通过 HTTPS RPC，口令只出现在请求体而不会被拼进 URL', () => {
      assert.equal(login.ok, true);
      assert.match(requests[0].url, /\/rest\/v1\/rpc\/bluev_auth_login$/);
      assert(!requests[0].url.includes('NeverPrintThis123'));
      assert.equal(requests[0].body.p_password, 'NeverPrintThis123');
      assert.equal(requests[0].options.headers.Authorization.startsWith('Bearer sb_publishable_'), true);
    });
    await auth.admin('unit-test-token', 'list_users', {});
    ok('管理员会话令牌作为参数传递，客户端仍只用公开 anon key', () => {
      assert.match(requests[1].url, /bluev_auth_admin$/);
      assert.equal(requests[1].body.p_token, 'unit-test-token');
      assert.equal(requests[1].body.p_action, 'list_users');
      assert(!/service_role|secret/i.test(requests[1].options.headers.Authorization));
    });

    global.fetch = async () => new Response(JSON.stringify({ code: 'PGRST202', message: 'missing function' }), { status: 404 });
    const missing = await auth.setupState();
    ok('数据库迁移尚未执行时给出明确设置提示', () => {
      assert.equal(missing.setupRequired, true);
      assert.match(missing.error, /supabase-auth-migration\.sql/);
    });

    global.fetch = async () => { const e = new Error('network down'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
    const offline = await auth.setupState();
    ok('云端不可达时明确报错，不回退到本机管理员账号', () => {
      assert.equal(offline.offline, true);
      assert.match(offline.error, /ECONNREFUSED/);
    });

    // Exercise the production branch of auth.js with an isolated Electron userData directory.
    const fakeData = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-cloud-auth-'));
    const fakeElectron = { app: { isPackaged: true, getPath: () => fakeData } };
    const originalLoad = Module._load;
    const liveFetch = global.fetch;
    process.env.BLUEV_NO_LOGIN = '0';
    process.env.BLUEV_LOCAL_AUTH = '0';
    Module._load = function (request) { if (request === 'electron') return fakeElectron; return originalLoad.apply(this, arguments); };
    delete require.cache[require.resolve('../src/main/auth')];
    const mainAuth = require('../src/main/auth');
    let cloudBrandPulls = 0;
    global.fetch = async (url) => {
      const name = String(url).split('/').pop();
      const body = name === 'bluev_auth_setup_state'
        ? { ok: true, initialized: true, bootstrapAvailable: false }
        : name === 'bluev_auth_login'
          ? { ok: true, token: 'session-token', expiresAt: Date.now() + 3600000, user: { id: 'user-1', username: 'shared-user', displayName: '成员', role: 'user', brands: ['brd_one'] } }
          : name === 'bluev_auth_brands'
            ? (cloudBrandPulls++, { ok: true, brands: [{ id: 'brd_one', name: '品牌一', enabled: true, promptWrite: 'template' }] })
            : name === 'bluev_auth_status'
              ? { ok: true, expiresAt: Date.now() + 3600000, user: { id: 'user-1', username: 'shared-user', displayName: '成员', role: 'user', brands: ['brd_one'] } }
              : { ok: true };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const start = await mainAuth.status();
    const signedIn = await mainAuth.login('shared-user', 'password', false);
    const refreshed = await mainAuth.status();
    ok('正式安装版使用云端登录、刷新云端身份与品牌权限，退出后清除会话', () => {
      assert.equal(mainAuth.cloudMode(), true);
      assert.equal(start.user, null);
      assert.equal(start.bootstrapRequired, false);
      assert.equal(signedIn.ok, true);
      assert.equal(refreshed.user.username, 'shared-user');
      assert.equal(mainAuth.current().brands[0], 'brd_one');
    });
    ok('记住登录恢复时也会重新拉取云端品牌目录，支持新设备首次登录', () => {
      assert(cloudBrandPulls >= 2, `expected login + status brand pulls, got ${cloudBrandPulls}`);
    });
    process.env.BLUEV_NO_LOGIN = '1';
    process.env.BLUEV_LOCAL_AUTH = '1';
    ok('正式安装包忽略开发免登录与本机账号开关', () => {
      assert.equal(mainAuth.enabled(), true);
      assert.equal(mainAuth.cloudMode(), true);
    });
    const successFetch = global.fetch;
    global.fetch = async (url, opts) => String(url).endsWith('bluev_auth_brands')
      ? new Response(JSON.stringify({ ok: false, error: '权限读取失败' }), { status: 200 })
      : successFetch(url, opts);
    const failedScope = await mainAuth.status();
    ok('品牌权限暂时读取失败时保留已验证会话，下次联网继续刷新', () => {
      assert.equal(failedScope.user.username, 'shared-user');
      assert.equal(mainAuth.current().username, 'shared-user');
      assert.equal(failedScope.offline, true);
    });
    global.fetch = successFetch;
    await mainAuth.logout();
    assert.equal(mainAuth.current(), null);
    Module._load = originalLoad;
    global.fetch = liveFetch;
    delete process.env.BLUEV_LOCAL_AUTH;
    delete process.env.BLUEV_NO_LOGIN;
  } finally {
    global.fetch = originalFetch;
    delete process.env.BLUEV_LOCAL_AUTH;
    delete process.env.BLUEV_NO_LOGIN;
    Module._load = originalModuleLoad;
  }

  ok('账号数据不在公开表中，所有安全定义 RPC 固定空 search_path', () => {
    assert.match(sql, /create schema if not exists bluev_private/i);
    assert.match(sql, /revoke all on schema bluev_private from public, anon, authenticated/i);
    const defs = [...sql.matchAll(/create or replace function[\s\S]*?security definer[\s\S]*?as \$\$/gi)];
    assert(defs.length >= 7, `found ${defs.length} security definer functions`);
    for (const m of defs) assert.match(m[0], /set search_path\s*=\s*''/i, m[0].slice(0, 100));
    assert.match(sql, /pgcrypto/i);
    assert.match(sql, /gen_salt\(''bf'',12\)/i);
    assert.match(sql, /pg_catalog\.format\('select %I\.crypt\(\$1,%I\.gen_salt/i);
    assert.match(sql, /update bluev_private\.settings set bootstrap_code = null/i);
    assert(!/service_role/i.test(sql));
  });
  if (!process.exitCode) console.log(`全部通过，共 ${tests} 项断言。`);
}

main().catch(e => { console.error('CLOUD AUTH TEST ERROR', e); process.exitCode = 1; });
