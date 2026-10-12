'use strict';
const { ipcMain, dialog, shell, app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fileIO = require('fs').promises;
const store = require('./store');
const project = require('./project');
const logbus = require('./logbus');
const logexport = require('./logexport');
const jobs = require('./jobs');
const auth = require('./auth');
const logincredentials = require('./logincredentials');
const brands = require('./brands');
const promptprofiles = require('./promptprofiles');
const imaging = require('./services/imaging');
const video = require('./services/video');   // ★ 不许漏：config:set 里改 ffmpeg 路径要立刻生效（漏了＝ReferenceError，接口直接报错）
const cloudsync = require('./services/cloudsync');   // 云端协作（可选）：只上行发布结果，发布核心不依赖它
const pool = require('./services/pool');
const copywriter = require('./services/copywriter');   // 「模型配置」弹窗要读**当前生效**的模型（无网络，只解析配置）
const hotwords = require('./services/hotwords');   // 标题热词库（读写 + 红线校验都在它里面）
const hotwordstransfer = require('./services/hotwordstransfer');
const stats = require('./services/stats');
const adb = require('./services/adb');
const dewuapk = require('./services/dewuapk');   // 内置的得物 App 安装包（设置页「下载到本机」用它）
const wp = require('./util/winpath');
const winmod = require('./window');
const security = require('./security');

function win() {
  const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  return w && !w.isDestroyed() ? w : null;
}

/** 业务通道一律要先登录；静态信息/外观/窗口控制类通道放行 */
function guard(fn) {
  return async (e, ...args) => {
    if (!auth.enabled()) return fn(e, ...args);
    if (!auth.current()) return { ok: false, error: '未登录或登录已过期，请重新登录' };
    return logbus.withActor(auth.current(), () => fn(e, ...args));
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
 * 发布统计能看多大范围：管理员=全部（null），普通成员=自己名下的品牌。
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

// 历史执行台账仅管理员可读；前端传入的权限字段不生效。
function statsOptions(opts) {
  return Object.assign({}, opts || {}, { scopeIds: scopeOf(),
    includeRunLogs: !auth.enabled() || !!(auth.current() && auth.current().role === 'admin') });
}

function register() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!security.trustedSender(event)) return { ok: false, error: '不允许的页面来源' };
    return fn(event, ...args);
  });
  const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (security.trustedSender(event)) fn(event, ...args);
  });
  // ---- 账号与登录：登录页本身要用，不设门禁 ----
  handle('auth:status', () => auth.status());
  handle('feedback:submit', guard((_e, text) => require('./feedback').submit(text, auth.current())));
  handle('auth:saved-login', () => logincredentials.read());
  // 身份确认后仍保持登录小窗，等渲染层准备好首页后再放大。
  handle('auth:login', async (_e, u, p, remember) => {
    const r = await auth.login(u, p, remember);
    if (r.ok) logincredentials.remember(u, p);
    return r;
  });
  handle('auth:ui-ready', guard(() => { winmod.setLoginMode(false); return { ok: true }; }));
  handle('auth:logout', async () => {
    const r = await auth.logout();
    winmod.setLoginMode(true);
    return r;
  });
  handle('auth:change-password', async (_e, oldP, newP) => {
    const user = auth.current();
    const r = await auth.changePassword(oldP, newP);
    if (r.ok && user) logincredentials.remember(user.username, newP);
    return r;
  });
  handle('auth:users', () => auth.listUsers());
  handle('auth:create-user', (_e, input) => auth.createUser(input));
  handle('auth:update-user', (_e, id, patch) => auth.updateUser(id, patch));
  handle('auth:reset-password', (_e, id, newP) => auth.resetPassword(id, newP));
  handle('auth:remove-user', (_e, id) => auth.removeUser(id));
  handle('auth:bootstrap', async (_e, setupCode, username, password, displayName, remember) => {
    const r = await auth.cloudBootstrap(setupCode, username, password, displayName, remember);
    if (r.ok) logincredentials.remember(username, password);
    return r;
  });

  // ---- 品牌注册表 ----
  // 读取对所有登录用户开放（发布侧要拉品牌下拉），但只回「这个人能用的」那部分 id；
  // 注册表本身（全部品牌名）要给管理员管，所以整体只对管理员回全量。
  handle('brand:list', guard(() => {
    const u = auth.current();
    const a = brands.allowed(u);
    // 提示词是各品牌自己的写作口径，只回「这个人用得上的」那份：
    // 管理员 = 全部；普通成员 = 名下启用中的品牌，其余品牌的 prompt 一律留空。
    // 不回全量是为了防一手「前端过滤漏了 → 成员打开别人的品牌看到空 → 一保存把人家的模板清了」
    const okIds = a.all ? null : a.ids;
    const promptOf = b => (okIds && !okIds.includes(b.id)) ? '' : (b.promptWrite || '');
    return {
      ok: true,
      isAdmin: a.all,
      brands: brands.list().filter(b => !okIds || okIds.includes(b.id)).map(b => ({
        id: b.id, name: b.name, enabled: b.enabled, note: b.note,
        promptWrite: promptOf(b)
      })),
      mine: a.all ? brands.enabledList().map(b => b.id) : a.ids,
      defaultBrandId: store.get('copy.defaultBrandId') || ''
    };
  }));
  handle('prompt:save', guard((_e, id, input) => promptprofiles.save(id, input)));
  handle('brand:add', guardAdmin(async (_e, input) => {
    const before = brands.list();
    const r = brands.add(input);
    if (r.ok) {
      const synced = await auth.syncBrands(brands.list());
      if (!synced.ok) { brands.replaceAll(before); return { ok: false, error: `云端品牌同步失败，已撤销本机修改：${synced.error || '未知错误'}` }; }
    }
    if (r.ok) logbus.ok(`已新增品牌「${r.brand.name}」`);
    return r;
  }));
  handle('brand:update', guardAdmin(async (_e, id, patch) => {
    const before = brands.list();
    const r = brands.update(id, patch);
    if (r.ok) {
      const synced = await auth.syncBrands(brands.list());
      if (!synced.ok) { brands.replaceAll(before); return { ok: false, error: `云端品牌同步失败，已撤销本机修改：${synced.error || '未知错误'}` }; }
    }
    if (r.ok) logbus.ok(`品牌已更新：${r.brand.name}${r.brand.enabled ? '' : '（已停用）'}`);
    return r;
  }));
  // 提示词**不是**管理员专属：写文案的是运营，让每个人都去找管理员改模板不现实。
  // 但只能改自己名下有权限的品牌，而且**只开放提示词这两个字段** ——
  // 改名 / 启停 / 删除仍然走 brand:update / brand:remove（guardAdmin）
  handle('brand:prompts', guard(async (_e, id, patch) => {
    const u = auth.current();
    const a = brands.allowed(u);
    const b = brands.byId(id);
    if (!b) return { ok: false, error: '品牌不存在' };
    if (!a.all && !a.ids.includes(b.id)) return { ok: false, error: `没有「${b.name}」的操作权限` };
    const p = patch || {};
    const r = brands.update(id, { promptWrite: p.promptWrite });
    // 提示词只保存在当前设备，不向云端写入。
    // 日志里只记品牌名：整段模板上千字，抄进 runlog 每条都占一大截
    if (r.ok) logbus.ok(`已更新品牌「${r.brand.name}」的提示词`);
    return r;
  }));
  handle('brand:remove', guardAdmin(async (_e, id) => {
    const before = brands.list();
    const b = brands.byId(id);
    const r = brands.remove(id);
    if (!r.ok) return r;
    // 顺手清掉账号上的悬空授权，并把默认品牌指回空
    const p = auth.purgeBrand(id);
    const pr = await p;
    if (!pr.ok) { brands.replaceAll(before); return { ok: false, error: pr.error || '无法删除该品牌：请先给相关成员分配其他品牌' }; }
    const synced = await auth.syncBrands(brands.list());
    if (!synced.ok) { brands.replaceAll(before); return { ok: false, error: `云端品牌同步失败，已恢复本机品牌：${synced.error || '未知错误'}` }; }
    if (store.get('copy.defaultBrandId') === String(id)) store.set({ copy: { defaultBrandId: '' } });
    logbus.warn(`已删除品牌「${b ? b.name : id}」${pr.ok && pr.users ? `，同时清掉了 ${pr.users} 个账号上的该品牌授权` : ''}`);
    return { ok: true, brand: r.brand, usersCleaned: (pr.ok && pr.users) || 0 };
  }));

  // ---- 品牌统计（频次 / 数量 / 执行日志）----
  handle('stats:query', guard(async (_e, opts) => {
    const o = Object.assign({}, opts || {});
    delete o.scopeIds;                       // 范围只认主进程算出来的，不认前端传的
    const history = require('./services/publishhistory');
    if (auth.cloudMode()) await history.refresh(require('./services/sheet').logFile());
    const queryOpts = statsOptions(o);
    const current = auth.current();
    const queried = stats.query(queryOpts);
    // 本账号身份只认登录会话；时间、品牌及执行人筛选与页面共用。
    const account = auth.cloudMode() ? await history.account(current && current.id, queryOpts) : null;
    let apiUsage = null;
    if (auth.cloudMode()) {
      const isAdmin = !!(current && current.role === 'admin');
      apiUsage = await cloudsync.queryApiUsage({
        fromTs: queried.range.fromTs, toTs: queried.range.toTs,
        brandId: queryOpts.brandId || '', userId: isAdmin ? (queryOpts.userId || '') : (current && current.id || ''),
        scopeIds: scopeOf()
      });
    }
    return Object.assign({ ok: true, account, apiUsage }, queried);
  }));
  handle('stats:export', guard(async (_e, opts) => {
    const o = Object.assign({}, opts || {});
    delete o.scopeIds;
    const r = await stats.exportXlsx(statsOptions(o));
    logbus.ok(`品牌统计已导出：${path.basename(r.file)}（${r.brands.length} 个品牌 · ${r.totals.rows} 条记录）`);
    return { ok: true, file: r.file, totals: r.totals, brandCount: r.brands.length };
  }));
  // 单独导出「执行日志」（run-log.jsonl，任务级）—— .log 给人看 + .csv 给 Excel，
  // **不截断**（xlsx 那张执行日志表过去只导最近 100 条、界面上一句不提）。
  // ★ 同样删掉前端传来的 scopeIds：可见范围只认主进程算出来的
  handle('stats:exportLog', guardAdmin(async (_e, opts) => {
    const o = Object.assign({}, opts || {});
    delete o.scopeIds;
    const r = await stats.exportRunLog(statsOptions(o));
    logbus.ok(`执行日志已导出：${path.basename(r.file)}（本次 ${r.entries} 条 · 日志文件里共 ${r.entriesInFile} 条）`);
    return { ok: true, file: r.file, csvFile: r.csvFile, entries: r.entries, entriesInFile: r.entriesInFile };
  }));
  // 输出目录可写性自检：日志是「追加写、失败不报错」的，共享盘掉线时会**静默少数据**。
  // ★ 只查配置里那个输出目录，不收前端传的路径；只读性质（建一个临时文件再删掉 + 追加方式打开）
  handle('stats:checkPath', guard(() => stats.checkOutput()));

  const githubupdates = require('./githubupdates');
  for (const method of ['status', 'check', 'download', 'install']) handle('update:' + method, guard(() => githubupdates[method]()));
  handle('update:set-channel', guard(() => ({ ok: false, error: '当前仅提供正式版更新' })));
  githubupdates.start();

  handle('app:info', () => ({
    platform: process.platform,
    isWin: wp.isWin(),
    arch: process.arch,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    engine: imaging.engineName(),
    hasHeif: imaging.hasHeif(),
    pool: { size: pool.size(), source: pool.get().source, updatedAt: pool.get().updatedAt },
    // 随包内置的外部依赖（adb / 中文输入法 apk）在不在 —— 设置页照实显示
    vendor: adb.bundledStatus(),
    // ★ 内置的得物 App 安装包（模拟器应用商店里搜不到得物时的兜底）。
    //   这一行少了，「外部依赖」表里那一行就只能显示"状态取不到"—— 界面在骗人（同下面 ffmpeg 那条）。
    //   ★ 只回路径/字节数这类轻量信息：md5 要读 133 MB，秒级的卡顿不能塞进界面刷新路径里。
    dewuApk: dewuapk.status(),
    // ★ 视频转码那条依赖：ffmpeg 的三段解析结果（手填 > 内置 > PATH）。
    //   少了这一行，「外部依赖」表里那行永远是「状态取不到」—— 界面在骗人（2026-10-02 抓到）。
    ffmpeg: video.status(),
    userData: app.getPath('userData')
  }));

  // 「模型配置」弹窗开的时候读一次：**当前实际在用**的模型是哪个、是哪来的（本机配置 / 跟随内置）。
  // ★ 纯本地解析（copywriter.cfgOf 不发网络请求）⇒ 开弹窗不会有等待感。
  // ★★ 只回 `apiKeySet` 布尔，**不回明文 key** —— 弹窗的输入框从 config:get 取原值，这条通道没必要带密钥。
  // ★ 它替代的正是原来「设置 → 高级设置 → 文案模型」那块：搬进弹窗后，「留空＝跟随内置」这个语义
  //   仍然要有**唯一的可见出口**（否则用户只看到空框，不知道实际用的是什么，界面等于在骗人）。
  handle('llm:effective', guard(() => {
    const c = copywriter.cfgOf();
    const raw = store.get('copy.llm') || {};
    const src = k => (String(raw[k] == null ? '' : raw[k]).trim() ? '本机配置' : '跟随内置');
    return {
      enabled: c.enabled, vision: c.vision,
      endpoint: c.endpoint, endpointSource: c.endpointSource,
      model: c.model, modelSource: src('model'),
      apiKeySet: !!c.apiKey, apiKeySource: c.apiKeySource,
      imageCount: c.imageCount, imageMaxSide: c.imageMaxSide, videoFrames: c.videoFrames
    };
  }));

  const configView = key => {
    const view = JSON.parse(JSON.stringify(store.get()));
    const allowed = scopeOf();
    if (allowed) view.brands = (view.brands || []).filter(b => allowed.includes(b.id));
    if (!key) return view;
    return String(key).split('.').reduce((o, k) => o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined, view);
  };
  handle('config:get', guard((_e, key) => configView(key)));
  handle('config:set', guard((_e, patch) => {
    try { security.validateConfigPatch(patch, !auth.enabled() || auth.current().role === 'admin'); }
    catch (e) { return { ok: false, error: e.message }; }
    store.set(patch);
    // adb 路径改完要**立刻**生效：用户填完就想点「检查能不能发布」看结果对不对，不该等重启
    if (patch && patch.publish && Object.prototype.hasOwnProperty.call(patch.publish, 'adbPath')) {
      adb.setAdbPath(store.get('publish.adbPath'));
    }
    // ffmpeg 同理：改完再点「合规检查」，非 mp4 的视频应该立刻从「需手动」变成能自动转
    if (patch && patch.publish && Object.prototype.hasOwnProperty.call(patch.publish, 'ffmpegPath')) {
      video.setFfmpegPath(store.get('publish.ffmpegPath'));
    }
    return configView();
  }));

  // ---- 标题热词库（左侧「热词库」页）----
  // 所有登录用户可编辑本机词库；只写本机配置，不同步到其他电脑。
  handle('hotwords:get', guard(() => hotwords.libraryView()));
  handle('hotwords:save', guard((_e, groups, opts) => hotwords.saveLibrary(groups, opts)));
  handle('hotwords:reset', guard(() => hotwords.resetLibrary()));
  handle('hotwords:export', guard(async (_e, groups) => {
    try {
      const checked = hotwords.sanitizeLibrary(groups);
      if (checked.rejected.length) return { ok: false, error: '词库中有不允许使用的词，请修改后导出' };
      const result = await dialog.showSaveDialog(win(), {
        title: '导出本机热词库', defaultPath: '蓝V热词库.xlsx',
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      await fileIO.writeFile(result.filePath, await hotwordstransfer.toXlsx(checked.groups));
      return { ok: true };
    } catch (error) { return { ok: false, error: '导出失败：' + error.message }; }
  }));
  handle('hotwords:import', guard(async () => {
    try {
      const result = await dialog.showOpenDialog(win(), {
        title: '导入热词库', properties: ['openFile'],
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
      const filename = result.filePaths[0];
      if ((await fileIO.stat(filename)).size > 2 * 1024 * 1024) return { ok: false, error: '词库文件过大，请选择小于 2 MB 的 Excel 文件' };
      const editable = hotwords.libraryView().editable;
      const groups = await hotwordstransfer.fromXlsx(await fileIO.readFile(filename), editable);
      const checked = hotwords.sanitizeLibrary(groups);
      if (checked.rejected.length) return { ok: false, error: '导入文件含有不允许使用的词：' + checked.rejected.map(x => x.word).join('、') };
      return { ok: true, groups: checked.groups };
    } catch (error) { return { ok: false, error: '导入失败：' + error.message }; }
  }));

  // ★★ 2026-10-08 用户要求：「云端协作」整块从**界面上删掉**（不给任何人看到）
  //   ⇒ 这里原来那 5 个 cloud:* IPC（status / sync / test / export / import）已**一并删除**，
  //     preload 里对应的 5 个通道也删了 ⇒ 渲染层再也够不到它们（既看不见，也改不了）。
  //   ★ 删的是**入口**，不是功能：上行链路 cloudsync.js 一个字节没动，
  //     且出厂默认就是开的（store.js 的 cloud 块 + clouddefaults.js 的内置地址 / anon key）。
  //   ★ cloudsync 的 exportConfig / importConfig / test 三个函数**保留** ——
  //     tools/cloudtest.js 直接调它们做服务级断言（不走 IPC），删了会红一片。

  handle('project:get', guard(() => project.get()));
  handle('log:history', guard(() => logbus.visibleHistory()));
  // 运行日志导出：写成一个 .log（给人看）+ 一个 .jsonl（给脚本看），落到输出目录。
  // 主进程按当前账号与筛选条件生成导出内容；普通成员只能导出本人日志。
  handle('log:export', guard((_e, payload) => {
    const p = payload || {};
    const filter = Object.assign({}, p.filter || {});
    // 从主进程缓存重新筛选，拒绝前端夹带其他账号的日志或伪造总条数。
    const visible = logbus.visibleHistory().filter(e => e.tier !== 'detail');
    try {
      const range = logexport.timeRange(filter);
      const entries = visible.filter(e => Number(e.t) >= range.from && Number(e.t) <= range.to);
      const r = logexport.writeFiles({
        outputDir: store.get('paths.output'),
        entries,
        meta: {
          exportedAt: Date.now(),
          appVersion: app.getVersion(),
          filter,
          bufferTotal: visible.length
        }
      });
      logbus.ok(`运行日志已导出：${path.basename(r.text)}`);
      return { ok: true, file: r.text, jsonFile: r.json, count: r.count };
    } catch (e) {
      // ★ 绝不吞：导出失败就说失败。说一句「已导出」然后磁盘上没文件，是最坏的那种假成功
      return { ok: false, error: `导出运行日志失败：${e.code ? e.code + ' ' : ''}${e.message}` };
    }
  }));

  // 主题：日间 / 夜间 / 玻璃 三档（口径见 window.normSkin / SKINS）。★ 必须**落盘** ——
  // 只改 nativeTheme 的话下次启动又回到默认值，用户会以为「切了没记住」。
  // ★ 返回值统一成 window.theme() 那整个对象（含 theme 字段）：渲染层要靠它区分「玻璃」和「深色」，
  //   只回一个 shouldUseDarkColors 的话，玻璃和夜间在渲染层长得一模一样。
  handle('theme:get', () => {
    // ★ 先做一次幂等的归一（把配置里的口径真正套到 nativeTheme 上）。
    //   只报 themeSource 是不够的：nativeTheme 还是 'system' 时 shouldUseDarkColors 会跟着 Windows 走，
    //   于是「themeSource=light」和「界面是深色」同时成立 —— 真窗口自检抓到过。
    winmod.applyStoredTheme();
    return winmod.theme();
  });
  handle('theme:set', (_e, source) => {
    const s = winmod.normSkin(source);
    nativeTheme.themeSource = winmod.nativeForSkin(s);
    store.set({ ui: { theme: s } });
    winmod.refreshBackdrop();      // ★ 见 window.refreshBackdrop：深色↔玻璃 不触发 updated，必须显式重算
    return winmod.theme();
  });
  // 顶栏那个按钮走这条：**三档循环** 浅色 → 深色 → 玻璃 → 浅色。返回值 = 切完之后的完整主题。
  handle('theme:toggle', () => {
    const s = winmod.nextSkin(store.get('ui.theme'));
    nativeTheme.themeSource = winmod.nativeForSkin(s);
    store.set({ ui: { theme: s } });
    winmod.refreshBackdrop();      // ★ 同上
    return winmod.theme();
  });

  handle('job:run', guard((_e, type, args) => jobs.run(type, args || {})));
  handle('job:cancel', guard((_e, type) => jobs.cancel(type)));
  handle('job:busy', guard((_e, type) => jobs.busy(type)));

  handle('dialog:dir', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择目录',
      defaultPath: opts && opts.parentOf ? path.dirname(String(opts.parentOf)) : ((opts && opts.defaultPath) || undefined),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  handle('dialog:file', guard(async (_e, opts) => {
    const w = win();
    const r = await dialog.showOpenDialog(w, {
      title: (opts && opts.title) || '选择文件',
      defaultPath: (opts && opts.defaultPath) || undefined,
      filters: (opts && opts.filters) || [{ name: '商品池', extensions: ['csv', 'tsv', 'txt', 'json'] }],
      properties: ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  handle('shell:open', guard(async (_e, p) => {
    if (!await security.canOpenPath(p)) return false;
    const err = await shell.openPath(p);
    return err === '' ? true : err;
  }));
  handle('shell:openExternal', guard(async (_e, value) => {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.username || url.password) return false;
      await shell.openExternal(url.href);
      return true;
    } catch (_) {
      return false;
    }
  }));
  handle('shell:reveal', guard((_e, p) => { if (p) shell.showItemInFolder(p); return true; }));

  /**
   * 「下载到本机」：把**内置**的得物安装包另存到用户选的位置（不联网）。
   * ★ 为什么不做成"从网上下"：这个包本来就随包内置了，走网络只会多一份失败面。
   *   用户要的是"把安装包弄到手边好拖进模拟器"，另存为正好就是这件事。
   * ★ 存完**回读大小**（dewuapk.saveAs 里做）—— 磁盘满/被杀软拦下会留半截文件，
   *   那时回一句"存好了"就是骗人。
   */
  handle('apk:saveDewu', guard(async () => {
    const st = dewuapk.status();
    if (!st.exists) return { ok: false, error: `安装包里没有内置得物安装包（应该在 ${st.path || 'resources/dewu'}）` };
    if (!st.sizeOk) {
      return { ok: false, error: `内置的 ${st.file} 大小不对（${st.bytes} 字节，应该是 ${st.expectBytes}）—— 这份安装包不完整，重新装一次本工具再试` };
    }
    const r = await dialog.showSaveDialog(win(), {
      title: '把得物安装包存到本机',
      defaultPath: path.join(app.getPath('downloads'), st.file),
      filters: [{ name: '安卓安装包 (apk)', extensions: ['apk'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    return dewuapk.saveAs(r.filePath);
  }));

  // ---- 窗口控制（自绘标题栏） ----
  on('win:min', () => { const w = win(); if (w) w.minimize(); });
  on('win:toggle-max', () => {
    const w = win(); if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  on('win:close', () => { const w = win(); if (w) w.close(); });
  handle('win:is-max', () => { const w = win(); return w ? w.isMaximized() : false; });
  on('win:flash', () => { const w = win(); if (w) w.flashFrame(true); });
  on('win:fit-gate', (_e, h) => winmod.fitGate(h));   // 登录门：按卡片实测高度收紧窗口
}

module.exports = { register };
