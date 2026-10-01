'use strict';
const { ipcMain, dialog, shell, app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const store = require('./store');
const project = require('./project');
const logbus = require('./logbus');
const jobs = require('./jobs');
const auth = require('./auth');
const brands = require('./brands');
const imaging = require('./services/imaging');
const pool = require('./services/pool');
const stats = require('./services/stats');
const updater = require('./updater');
const wp = require('./util/winpath');
const winmod = require('./window');

function win() {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return w && !w.isDestroyed() ? w : null;
}

/** 业务通道一律要先登录；静态信息/外观/窗口控制类通道放行 */
function guard(fn) {
  return async (e, ...args) => {
    if (!auth.enabled()) return fn(e, ...args);
    if (!auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };
    return fn(e, ...args);
  };
}

/** 再上一层：只有管理员能调（改品牌、看全部品牌的统计都属于这一类）。免登录开发模式放行 */
function guardAdmin(fn) {
  return guard(async (e, ...args) => {
    const u = auth.current();
    if (auth.enabled() && (!u || u.role !== 'admin')) return { ok: false, error: '只有管理员能做这个操作' };
    return fn(e, ...args);
  });
}

/**
 * 统计/日志能看多大范围：管理员=全部（null），普通成员=自己名下的品牌。
 * 这个范围**在主进程算**，不信渲染层传上来的 scopeIds —— 否则改一下前端就能看别家的账。
 */
function scopeOf() {
  const u = auth.current();
  // 没有当前账号只可能是免登录开发模式（auth.enabled() 为真时 guard 已经把未登录拦掉了）。
  // 这时候不给「空数组」—— 空数组的含义是「一个品牌都不许看」，会把统计全滤成 0，
  // 看起来像「真的一条都没有」，那是假信息
  if (!u) return null;
  const a = brands.allowed(u);
  return a.all ? null : a.ids;
}

function register() {
  // ---- 账号与登录：登录页本身要用，不设门禁 ----
  ipcMain.handle('auth:status', () => auth.status());
  // 登录成功 → 窗口从「登录小窗」还原成正常尺寸；退出登录 → 重新收回小窗
  ipcMain.handle('auth:login', (_e, u, p, remember) => {
    const r = auth.login(u, p, remember);
    if (r && r.ok) winmod.setLoginMode(false);
    return r;
  });
  ipcMain.handle('auth:logout', () => {
    const r = auth.logout();
    winmod.setLoginMode(true);
    return r;
  });
  ipcMain.handle('auth:change-password', (_e, oldP, newP) => auth.changePassword(oldP, newP));
  ipcMain.handle('auth:users', () => auth.listUsers());
  ipcMain.handle('auth:create-user', (_e, input) => auth.createUser(input));
  ipcMain.handle('auth:update-user', (_e, id, patch) => auth.updateUser(id, patch));
  ipcMain.handle('auth:reset-password', (_e, id, newP) => auth.resetPassword(id, newP));
  ipcMain.handle('auth:remove-user', (_e, id) => auth.removeUser(id));

  // ---- 品牌注册表 ----
  // 读取对所有登录用户开放（发布侧要拉品牌下拉），但只回「这个人能用的」那部分 id；
  // 注册表本身（全部品牌名）要给管理员管，所以整体只对管理员回全量。
  ipcMain.handle('brand:list', guard(() => {
    const u = auth.current();
    const a = brands.allowed(u);
    // 提示词是各品牌自己的写作口径，只回「这个人用得上的」那份：
    // 管理员 = 全部；普通成员 = 名下启用中的品牌，其余品牌的 prompt 一律留空。
    // 不回全量是为了防一手「前端过滤漏了 → 成员打开别人的品牌看到空 → 一保存把人家的模板清了」
    const okIds = a.all ? null : a.ids;
    const promptOf = b => (okIds && !okIds.includes(b.id)) ? '' : (b.promptWrite || '');
    const filterOf = b => (okIds && !okIds.includes(b.id)) ? '' : (b.promptFilter || '');
    return {
      ok: true,
      isAdmin: a.all,
      brands: brands.list().map(b => ({
        id: b.id, name: b.name, enabled: b.enabled, note: b.note,
        promptWrite: promptOf(b), promptFilter: filterOf(b)
      })),
      mine: a.all ? brands.enabledList().map(b => b.id) : a.ids,
      defaultBrandId: store.get('copy.defaultBrandId') || ''
    };
  }));
  ipcMain.handle('brand:add', guardAdmin((_e, input) => {
    const r = brands.add(input);
    if (r.ok) logbus.ok(`已新增品牌「${r.brand.name}」`);
    return r;
  }));
  ipcMain.handle('brand:update', guardAdmin((_e, id, patch) => {
    const r = brands.update(id, patch);
    if (r.ok) logbus.ok(`品牌已更新：${r.brand.name}${r.brand.enabled ? '' : '（已停用）'}`);
    return r;
  }));
  // 提示词**不是**管理员专属：写文案的是运营，让每个人都去找管理员改模板不现实。
  // 但只能改自己名下有权限的品牌，而且**只开放提示词这两个字段** ——
  // 改名 / 启停 / 删除仍然走 brand:update / brand:remove（guardAdmin）
  ipcMain.handle('brand:prompts', guard((_e, id, patch) => {
    const u = auth.current();
    const a = brands.allowed(u);
    const b = brands.byId(id);
    if (!b) return { ok: false, error: '品牌不存在' };
    if (!a.all && !a.ids.includes(b.id)) return { ok: false, error: `没有「${b.name}」的操作权限` };
    const p = patch || {};
    const r = brands.update(id, { promptFilter: p.promptFilter, promptWrite: p.promptWrite });
    // 日志里只记品牌名：整段模板上千字，抄进 runlog 每条都占一大截
    if (r.ok) logbus.ok(`已更新品牌「${r.brand.name}」的提示词`);
    return r;
  }));
  ipcMain.handle('brand:remove', guardAdmin((_e, id) => {
    const b = brands.byId(id);
    const r = brands.remove(id);
    if (!r.ok) return r;
    // 顺手清掉账号上的悬空授权，并把默认品牌指回空
    const p = auth.purgeBrand(id);
    if (store.get('copy.defaultBrandId') === String(id)) store.set({ copy: { defaultBrandId: '' } });
    logbus.warn(`已删除品牌「${b ? b.name : id}」${p.ok && p.users ? `，同时清掉了 ${p.users} 个账号上的该品牌授权` : ''}`);
    return { ok: true, brand: r.brand, usersCleaned: (p.ok && p.users) || 0 };
  }));

  // ---- 品牌统计（频次 / 数量 / 执行日志）----
  ipcMain.handle('stats:query', guard((_e, opts) => {
    const o = Object.assign({}, opts || {});
    delete o.scopeIds;                       // 范围只认主进程算出来的，不认前端传的
    return Object.assign({ ok: true }, stats.query(Object.assign(o, { scopeIds: scopeOf() })));
  }));
  ipcMain.handle('stats:export', guard(async (_e, opts) => {
    const o = Object.assign({}, opts || {});
    delete o.scopeIds;
    const r = await stats.exportXlsx(Object.assign(o, { scopeIds: scopeOf() }));
    logbus.ok(`品牌统计已导出：${path.basename(r.file)}（${r.brands.length} 个品牌 · ${r.totals.rows} 条记录）`);
    return { ok: true, file: r.file, totals: r.totals, brandCount: r.brands.length };
  }));

  // ---- 应用更新（阶段 1）----
  // 检查 / 下载 / 安装**都只由用户点**：没有定时轮询、没有自动下载、没有自动重启。
  // 原因见 src/main/updater.js 文件头 —— 静默重启会拦腰截断正在跑的批量发布。
  ipcMain.handle('update:status', guard(() => Object.assign({ ok: true }, updater.status())));
  ipcMain.handle('update:check', guard(() => updater.check({ manual: true })));
  ipcMain.handle('update:download', guard(() => updater.download()));
  ipcMain.handle('update:install', guard(() => {
    // 唯一会重启应用的入口。哪怕用户点了，也要在「真有任务在跑」时拦住 ——
    // 重启把发布跑一半掐掉，那批素材的下场没人说得清
    const running = jobs.busy();
    if (running && running.length) {
      const first = running[0];
      return {
        ok: false,
        error: `还有 ${running.length} 个任务在跑（${first.label}${first.batch ? ' · ' + first.batch : ''}），装完会重启、把任务掐断。等跑完再装。`
      };
    }
    return updater.install();
  }));

  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    isWin: wp.isWin(),
    arch: process.arch,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    engine: imaging.engineName(),
    hasHeif: imaging.hasHeif(),
    pool: { size: pool.size(), source: pool.get().source, updatedAt: pool.get().updatedAt },
    userData: app.getPath('userData')
  }));

  ipcMain.handle('config:get', guard((_e, key) => store.get(key)));
  ipcMain.handle('config:set', guard((_e, patch) => { store.set(patch); return store.get(); }));

  ipcMain.handle('project:get', guard(() => project.get()));
  ipcMain.handle('log:history', guard(() => logbus.history()));

  ipcMain.handle('theme:get', () => ({ shouldUseDarkColors: nativeTheme.shouldUseDarkColors, themeSource: nativeTheme.themeSource }));
  ipcMain.handle('theme:set', (_e, source) => { nativeTheme.themeSource = source || 'system'; return nativeTheme.shouldUseDarkColors; });

  ipcMain.handle('job:run', guard((_e, type, args) => jobs.run(type, args || {})));
  ipcMain.handle('job:cancel', guard((_e, type) => jobs.cancel(type)));
  ipcMain.handle('job:busy', guard((_e, type) => jobs.busy(type)));

  ipcMain.handle('dialog:dir', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择目录',
      defaultPath: (opts && opts.defaultPath) || store.get('paths.source'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('dialog:file', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择文件',
      defaultPath: (opts && opts.defaultPath) || undefined,
      filters: (opts && opts.filters) || [{ name: '商品池', extensions: ['csv', 'tsv', 'txt', 'json'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('shell:open', guard(async (_e, p) => {
    if (!p) return false;
    const err = await shell.openPath(p);
    return err === '' ? true : err;
  }));
  ipcMain.handle('shell:reveal', guard((_e, p) => { if (p) shell.showItemInFolder(p); return true; }));

  // ---- 窗口控制（自绘标题栏） ----
  ipcMain.on('win:min', () => { const w = win(); if (w) w.minimize(); });
  ipcMain.on('win:toggle-max', () => {
    const w = win(); if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('win:close', () => { const w = win(); if (w) w.close(); });
  ipcMain.handle('win:is-max', () => { const w = win(); return w ? w.isMaximized() : false; });
  ipcMain.on('win:flash', () => { const w = win(); if (w) w.flashFrame(true); });
  ipcMain.on('win:fit-gate', (_e, h) => winmod.fitGate(h));   // 登录门：按卡片实测高度收紧窗口
}

module.exports = { register };
