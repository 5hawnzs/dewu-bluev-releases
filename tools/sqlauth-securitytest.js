'use strict';
require('./test-runtime')();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
let count = 0;
const ok = (label, value) => { assert(value, label); count++; console.log('PASS  ' + label); };
(async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec('create role anon; create role authenticated;');
    const sql = fs.readFileSync(path.join(__dirname, '../docs/supabase-auth-migration.sql'), 'utf8');
    const patch = fs.readFileSync(path.join(__dirname, '../docs/supabase-auth-security-migration.sql'), 'utf8');
    await db.exec(sql);
    ok('完整云端迁移可在隔离 PostgreSQL 中执行', true);
    const call = async (name, values) => (await db.query(`select public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) as result`, values)).rows[0].result;
    const setup = (await db.query('select bootstrap_code from bluev_private.settings')).rows[0].bootstrap_code;
    const admin = await call('bluev_auth_bootstrap', [setup, 'auditadmin', 'Audit@123', '测试管理员']);
    ok('初始化可创建管理员且初始化码只能用一次', admin.ok && !(await call('bluev_auth_bootstrap', [setup, 'secondadmin', 'Audit@123', '二号'])).ok);
    const manage = (action, payload, token = admin.token) => call('bluev_auth_admin', [token, action, JSON.stringify(payload)]);
    ok('无效会话不能读取管理员账号表', !(await manage('list_users', {}, 'invalid-audit-token')).ok);
    await manage('save_brands', { brands: [{ id: 'b1', name: '启用品牌', enabled: true }, { id: 'b2', name: '停用品牌', enabled: false }] });
    const invalid = await manage('create_user', { username: 'disabledbrand', password: 'Member@123', brands: ['b2'] });
    ok('不能用全部停用的品牌创建成员', !invalid.ok && /启用品牌/.test(invalid.error));
    const created = await manage('create_user', { username: 'auditmember', password: 'Member@123', brands: ['b1'] });
    ok('有启用品牌的成员可创建', created.ok);
    const member = await call('bluev_auth_login', ['auditmember', 'Member@123']);
    ok('普通成员不能直接调用管理员 RPC 提权', !(await manage('update_user', { id: created.user.id, role: 'admin' }, member.token)).ok);
    const removal = await manage('save_brands', { brands: [{ id: 'b2', name: '停用品牌', enabled: false }] });
    ok('不能删除启用成员的最后一个归属品牌', !removal.ok && (await call('bluev_auth_brands', [member.token])).brands.some(b => b.id === 'b1'));
    const other = await call('bluev_auth_login', ['auditmember', 'Member@123']);
    const changed = await call('bluev_auth_change_password', [member.token, 'Member@123', 'Member@456']);
    ok('改密后撤销其他设备旧会话，当前会话仍有效', changed.ok
      && !(await call('bluev_auth_status', [other.token])).ok && (await call('bluev_auth_status', [member.token])).ok);
    for (let i = 0; i < 6; i++) await call('bluev_auth_login', ['auditmember', 'wrong']);
    const locked = await call('bluev_auth_login', ['auditmember', 'Member@456']);
    ok('六次失败后正确密码也会被锁定五分钟', !locked.ok && /5 分钟/.test(locked.error));
    await db.exec('set role anon;');
    let denied = false;
    try { await db.query('select id from bluev_private.accounts'); } catch (e) { denied = /permission denied/i.test(e.message); }
    finally { await db.exec('reset role;'); }
    ok('匿名角色无法直接读取私有账号表', denied);
    await db.exec(patch);
    await db.exec(patch);
    ok('安全补丁重复执行不会重建账号、重置密码或生成初始化码',
      (await db.query('select count(*)::integer as n from bluev_private.accounts')).rows[0].n === 2
      && (await db.query('select bootstrap_code from bluev_private.settings')).rows[0].bootstrap_code === null
      && (await call('bluev_auth_status', [member.token])).ok);
    console.log(`全部通过 ${count} 项数据库安全检查`);
  } finally { await db.close(); }
})().catch(e => { console.error(e.message); process.exit(1); });
