'use strict';
/** 任务编排：统一进度 / 日志 / 取消 / 任务栏进度 / 完成通知 */
const { BrowserWindow, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const logbus = require('./logbus');
const project = require('./project');
const store = require('./store');
const auth = require('./auth');
const brands = require('./brands');
const flatten = require('./services/flatten');
const compliance = require('./services/compliance');
const copywriter = require('./services/copywriter');
const verify = require('./services/verify');
const sheet = require('./services/sheet');
const report = require('./services/report');
const aireport = require('./services/aireport');
const publisher = require('./services/publisher');
const dewuapk = require('./services/dewuapk');   // 内置的得物 App 安装包（装进模拟器那条兜底路）
const pool = require('./services/pool');
const runlog = require('./services/runlog');
const wp = require('./util/winpath');

/**
 * 任务实例化：每个 job 有自己的 id / token(取消) / 进度 / 日志标签，
 * 「运行中的批次」可以同时存在多个（真机：7月第六批 与 种草0625 同时「处理中」）。
 *
 * running: id -> job{ id, type, label, batch, token, progress, startedAt }
 * byType:  type -> Set<id>   （同一时间能不能再起一个由 PARALLEL_TYPES 决定）
 */
const running = new Map();
const byType = new Map();

/** 可并行的任务：批次级（一个批次一个实例，互不覆盖） */
const PARALLEL_TYPES = new Set(['copy.generate']);

/**
 * 产出「可发布内容」的任务 —— 这几个必须有品牌归属，否则发出去的东西查不到是谁做的、算哪个品牌的。
 * 素材整理 / 合规 / 校验 / 商品池属于准备动作，归属可有可无（没有就记「未标品牌」）。
 * 归属规则与提示语都在 brands.resolveFor 里，这里只声明「哪些任务必须有」。
 */
const BRAND_SCOPED = new Set(['copy.generate', 'report.import', 'sheet.export', 'publish.run', 'publish.rerun']);

/** 任务类型 → 界面上给人的名字 */
const TYPE_LABEL = {
  'flatten.plan': '素材整理 · 生成清单', 'flatten.run': '素材整理',
  'compliance.scan': '合规检查', 'compliance.scanParent': '合规检查 · 父目录',
  'compliance.fix': '合规处理', 'compliance.exportReport': '导出合规报告',
  'copy.generate': 'AI 文案生成', 'copy.llmtest': '文案接口自检', 'copy.llmmodels': '拉取模型清单',
  'verify.check': '好物货号颜色预检',
  'sheet.export': '导出发布单', 'report.import': '导入 AI 内容报告',
  'publish.run': '自动发布', 'publish.rerun': '发布重跑',
  'publish.exportLog': '重导出日志', 'pool.import': '导入商品池'
};

/** 批次级产物目录：每个批次一个文件夹，互不覆盖 */
function batchDir(batchId) { return path.join(store.get('paths.output'), 'batches', String(batchId).replace(/[<>:"|?*\\/]/g, '_')); }

/**
 * 「这一批素材实际放在哪个文件夹」—— items 的 absDir 指向哪儿，产物就落在哪儿。
 *
 * ★★ 2026-10-03 修一个落点错：「文案生成」的 AI 内容报告原来写死在 `project.sourceDir`
 *   （每次现场选的那个**原始素材目录**）。可做完「素材整理」之后，这一批条目（items）
 *   全都在 `flat_<时间戳>/` 里 —— 合规检查、隔离、转 JPG 都是在那一份副本上做的。
 *   于是：人在整理后的带时间戳文件夹里干活，报告却掉回了还没处理的原始目录。
 *   ⇒ 落点一律按 **items 实际所在的父目录**算，拿不到才退回调用方给的兜底值。
 */
function itemsDir(items, fallback) {
  const first = (items || []).find(it => it && (it.absDir || it.dir));
  if (!first) return fallback || '';
  const abs = String(first.absDir || first.dir);
  const parent = path.dirname(abs);
  return (parent && parent !== abs) ? parent : (fallback || '');
}

function typeIds(type) { return byType.get(type) || new Set(); }

function send(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    w.webContents.send(channel, payload);
  }
}

function taskbar(v) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setProgressBar(v);
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) { /* 通知不可用不影响主流程 */ }
}

/**
 * ★ 2026-10-02：「设置 → 素材根目录」已删 —— 出厂不再预设任何素材位置（素材目录每次现场选，
 *   结果存在 project.sourceDir）。所以这里不能再拿一个默认目录兜底：没显式给、工程里也没存过，
 *   就直接说清要干什么。否则 undefined 会被一路交到 readdirSafe，
 *   冒出来的是一句「The path argument must be of type string」这种没人看得懂的错。
 */
function needSourceDir(dir) {
  if (!dir) throw new Error('还没选素材目录 —— 点「选择目录」选一个再试；导入报告时可以在弹框里选这一批的素材目录');
  return dir;
}

/**
 * ★★ 2026-10-04（用户口径，原话）：「**后续如果电脑上开着，禁止发布，提示用户需要关掉那个 excel
 *   才能开始发布任务**」。
 *
 * 为什么必须**开跑之前**就拦（而不是等发完了再报）：
 *   发布结果要**回写**到两个 Excel —— 「AI 内容报告」（B=实际执行时间 / C=执行结果）与「发布单」。
 *   这两个文件被 Excel/WPS 打开着时，回写会抛 `EBUSY`，代码只能把结果**暂存**起来
 *   （`pending-results.json`）、等下次运行再补写 —— 用户看到的就是「失败了，日志还写不进去」，
 *   而**整批发布已经白跑完了**（真机实测：一次 3 条、总耗时 87.4s，结果一条都没落进报告）。
 *   ⇒ 与其发完再告诉他「写不进去」，不如**一条都不发**就拦住，让他先关掉。
 *
 * ★ 判据见 wp.probeWritable（`r+` 试开，已用独占句柄对照实验验过真会红）。
 * ★ 只 `open` + `close`，**一个字节都不写** —— 这是运营的账。
 * ★ 报告文件不存在（`exists:false`）不算占用；路径为空直接跳过。
 */
async function assertExcelClosed(files) {
  const list = (files || []).map(f => String(f || '')).filter(Boolean);
  const busy = [];
  for (const f of list) {
    const p = await wp.probeWritable(f);
    if (p.exists && p.busy) busy.push(f);
  }
  if (!busy.length) return { checked: list.length, busy: [] };
  const names = busy.map(f => path.basename(f)).join('、');
  throw new Error(`请先关掉 Excel / WPS 再开始发布：「${names}」现在正被别的程序打开着。`
    + '发布结果要回写进这个文件，开着的话一条都写不进去（只能暂存），整批就白跑了 —— '
    + '所以直接拦住不发。关掉它（不用保存改动，直接关窗口即可）再点「开始发布」。');
}

async function dispatch(type, args, ctx) {
  const st = () => project.get();
  switch (type) {
    case 'flatten.plan': {
      const dir = needSourceDir(args.sourceDir || st().sourceDir);
      const plan = await flatten.plan(dir, ctx);
      logbus.info(`待整理清单：${plan.total} 个叶子目录 · ${plan.fileTotal} 个文件`);
      return plan;
    }
    case 'flatten.run': {
      const dir = needSourceDir(args.sourceDir || st().sourceDir);
      const res = await flatten.run(dir, store.get('flatten'), ctx);
      if (!res.ok) throw new Error(res.message);
      project.patch({ sourceDir: dir, flatDir: res.flatDir, items: res.items, verify: { rows: [], checkedAt: 0 }, copyRows: [], sheet: { file: '', rowCount: res.items.length, colCount: 26, locked: false, exportedAt: 0 } });
      // 大结论（2026-10-05）：一行说清这次整理出来多少
      ctx.conclude(`素材整理完成【${res.summary}】`);
      return res;
    }
    case 'compliance.scan': {
      if (!st().items.length) throw new Error('请先做素材整理');
      const { rows, stats } = await compliance.scan(st().items, ctx);
      project.patch({ compliance: { rows, stats, scannedAt: Date.now() } });
      // 大结论（2026-10-05）：逐条的判定过程在明细里，这里只给用户几个数
      ctx.conclude(`合规检查完成【检查 ${stats.total} 个文件 · 通过 ${stats.ok} · 待处理 ${stats.todo} · 需人工 ${stats.manual}】`,
        stats.manual ? 'warn' : 'ok');
      return { rows, stats };
    }
    case 'compliance.scanParent': {
      const dir = needSourceDir(args.dir || st().sourceDir);
      const r = await compliance.scanParent(dir, ctx);
      project.patch({ compliance: { rows: r.rows, stats: r.stats, groups: r.groups, scannedAt: Date.now() } });
      ctx.conclude(`父目录检查完成【${r.groups.length} 个批次 · ${r.stats.total} 个文件 · 可自动处理 ${r.stats.todo} · 需人工 ${r.stats.manual}】`,
        r.stats.manual ? 'warn' : 'ok');
      return { groups: r.groups.map(g => ({ name: g.name, stats: g.stats })), stats: r.stats };
    }
    case 'compliance.fix': {
      const s = st();
      const r = await compliance.fix(s.items, s.compliance.rows, ctx);
      project.patch({ compliance: { rows: r.rows, stats: s.compliance.stats, scannedAt: s.compliance.scannedAt } });
      ctx.conclude(`合规处理完成【转换 ${r.converted} · 隔离 ${r.isolated} · 失败 ${r.failed}】`, r.failed ? 'warn' : 'ok');
      return r;
    }
    case 'copy.generate': {
      // 批次级：真机是「选择素材目录并启动任务」，多个批次可以同时「处理中」。
      // 每个批次自带素材清单，产物写进「输出目录/batches/<批次>/copy.json」，
      // 不去动当前项目的单例状态（否则两个批次会互相覆盖）。
      if (args.sourceDir) {
        const dir = args.sourceDir;
        const batchId = args.batchId || (path.basename(dir) + '_' + wp.stamp());
        const plan = await flatten.plan(dir, ctx);
        if (ctx.cancelled()) throw new Error(`批次「${batchId}」已被取消`);
        if (!plan.total) throw new Error(`这个目录里没有找到素材叶子目录：${dir}`);
        const items = plan.rows.map(r => ({
          id: r.name, dir: r.name, absDir: r.from, sku: r.sku, color: r.color, seq: r.seq,
          files: r.files.map(f => ({ name: f, size: 0, type: wp.isVideo(f) ? 'video' : (wp.isJunk(f, false) ? 'junk' : 'image') }))
        }));
        logbus.info(`[${batchId}] 批次素材：${items.length} 个叶子目录（${dir}）`, { batch: batchId });
        const r = await copywriter.generate(items, ctx);
        const out = batchDir(batchId);
        await wp.mkdirp(out);
        const file = path.join(out, 'copy.json');
        await fs.promises.writeFile(wp.toLong(file), JSON.stringify({
          batchId, sourceDir: dir, createdAt: Date.now(), count: r.rows.length,
          brandId: ctx.brand.brandId, brandName: ctx.brand.brandName,
          actor: ctx.actor && ctx.actor.username ? ctx.actor.username : '',
          warning: r.warning || '', llm: r.llm || null,
          genSource: r.genSource || '', modelId: r.modelId || '', endpoint: r.endpoint || '',
          items: items.map(i => ({ id: i.id, dir: i.dir, sku: i.sku, color: i.color, files: i.files.length })),
          rows: r.rows
        }, null, 2), 'utf8');
        logbus.ok(`[${batchId}] 批次完成：${r.rows.length} 篇 → ${wp.toDisplay(file)}`, { batch: batchId });

        // ★ 带时间戳的 AI 内容报告：落在**本批素材文件夹**里（用户 2026-10-02 拍板），
        //   写不进去才退到批次输出目录，并且会用「如实告警」把换地方这件事说出来。
        const rep = await aireport.write({
          dir: itemsDir(items, dir), fallbackDir: out, batch: batchId,
          brandName: ctx.brand.brandName, sourceDir: dir,
          items, rows: r.rows,
          gen: { modelId: r.modelId, genSource: r.genSource, endpoint: r.endpoint, endpointSource: r.endpointSource, vision: r.vision }
        });
        logbus.ok(`[${batchId}] AI 内容报告（${rep.rows} 行）→ ${wp.toDisplay(rep.file)}`, { batch: batchId });
        if (rep.verify && !rep.verify.ok) logbus.warn(`[${batchId}] 报告自检没通过：${rep.verify.why}`, { batch: batchId });
        if (rep.flagged) {
          logbus.warn(`[${batchId}] 报告里 ${rep.flagged} 行的「文案核对」不是「一致」`
            + `（要人工看 ${rep.byLevel.warn} 行 · 明显有问题 ${rep.byLevel.bad} 行）—— 打开报告按那一列筛一下`, { batch: batchId });
        } else if (rep.rows) {
          logbus.ok(`[${batchId}] ${rep.rows} 行的文案/货号/颜色自动核对全部「一致」`, { batch: batchId });
        }
        // 大结论（2026-10-05）：一行说完这批「目标/成功/失败」，并如实标出文案到底是不是 AI 写的
        //   —— 「看起来像 AI、其实是本地模板」正是用户最恼的那种，必须一眼看得见（不许瞒）。
        const okN = r.rows.filter(x => x.status === '已生成').length;
        ctx.conclude(`文案生成成功【目标 ${items.length} 条，成功 ${okN} 条，失败 ${r.failed} 条】（${r.genSource || (r.llm ? 'AI' : '本地模板')}）`,
          r.failed ? 'warn' : 'ok');
        return {
          batchId, count: r.rows.length, file, warning: r.warning, llm: r.llm,
          genSource: r.genSource || '', modelId: r.modelId || '', vision: !!r.vision,
          reportFile: rep.file, reportRows: rep.rows, reportFlagged: rep.flagged,
          reportByLevel: rep.byLevel, reportVerify: rep.verify, reportFallback: rep.fellBack
        };
      } else {
        // ★ 2026-10-08 用户要求删除页签 3 的「按当前素材生成」按钮（原话：「一般没点目录的时候
        //   不会有当前素材，所以这两个功能重复了」）⇒ 这里随之删除它独享的那条分支：
        //   「拿当前工程 items 生成 + 回写 project.copyRows」。
        //   留一条**显式报错**而不是让 case 落空返回 undefined —— 万一还有调用方不带 sourceDir，
        //   要立刻看到「必须指定素材目录」，不许静默地什么都没发生。
        throw new Error('文案生成必须指定素材目录：请点「选择素材目录并启动任务」（一个目录 = 一个批次）。');
      }
    }
    // 「拉取模型清单」（2026-10-08）：给「文案生成 → 模型配置」弹窗用 —— 把这个接口**真认的**模型列出来，
    // 用户点一个当「默认模型」，存的是接口 id（不是显示名）。
    // ★ 为什么要有这一步：用户填的是显示名，接口只认自己的 id —— 实测填 `deepseek v4.1 flash` 直接 400
    //   （`The supported API model names are deepseek-flash, deepseek-v4-pro, ...`）。清单拉回来点一下最省事。
    // ★★ 允许 args.endpoint / args.apiKey 覆盖配置：弹窗里刚粘完地址就能拉清单，**不必先存一遍**
    //   （先存再拉的话，地址填错也被写进配置，还得再擦掉）。留空才落回已保存的配置。
    // ★ 拉不到不抛异常（返回 listErr）：有些网关就是不提供 /models，那是「清单拉不到」而不是「任务失败」。
    case 'copy.llmmodels': {
      const c = copywriter.cfgOf();
      const ownEnd = String(args.endpoint || '').trim();
      const ownKey = String(args.apiKey || '').trim();
      const endpoint = ownEnd || c.endpoint;
      const apiKey = ownKey || c.apiKey;
      const endpointSource = ownEnd ? '表单里填的' : c.endpointSource;
      if (!endpoint) return { ok: true, endpoint: '', endpointSource, models: [], listErr: '还没填接口地址' };
      if (!apiKey) return { ok: true, endpoint, endpointSource, models: [], listErr: '还没填 API Key' };
      let models = [];
      try {
        const list = await copywriter.listModels({ endpoint, apiKey });
        models = list.map(m => ({
          id: String(m.id),
          name: String(m.name || m.id),
          // 清单里写没写收图（`input_modalities` 里有 `image`）—— 直接摆给用户看，省得生成完才发现不看图
          image: copywriter.imageCapability(m)
        }));
      } catch (e) {
        logbus.warn(`模型清单拉不到（${e.message}）`);
        return { ok: true, endpoint, endpointSource, models: [], listErr: e.message };
      }
      logbus.info(`模型清单：${models.length} 个可选（${endpoint}）`);
      return { ok: true, endpoint, endpointSource, models, listErr: '', current: c.model };
    }
    // 「接口自检」：一次网络往返把「地址通不通 / 模型名接口认不认 / 这个模型收不收图」说清楚。
    // 为什么要有这个按钮：上一版这些事**全靠生成时才暴露**，而失败还被静默吞成「本地模板」，
    // 于是用户看到的是一堆模板货，却看不到「其实是接口没连上」。
    // ★ 2026-10-08 起按钮搬进「模型配置」弹窗 ⇒ 允许 args 覆盖，让它**测表单里当前填的**地址 / Key / 启用，
    //   而不是测那份可能还没保存的旧配置（否则用户改完地址点自检，检的还是旧的，结论会骗人）。
    case 'copy.llmtest': {
      const c = copywriter.cfgOf();
      if (String(args.endpoint || '').trim()) { c.endpoint = String(args.endpoint).trim(); c.endpointSource = '表单里填的'; }
      if (String(args.apiKey || '').trim()) { c.apiKey = String(args.apiKey).trim(); c.apiKeySource = '表单里填的'; }
      const wantEnabled = args.enabled === undefined ? c.enabled : (args.enabled === true || args.enabled === 'true');
      if (!wantEnabled) {
        return { ok: true, enabled: false, note: '模型开关关着（当前用本地模板出文案，不是 AI 文案）' };
      }
      const pf = await copywriter.preflight(c);
      if (!pf.ok) throw new Error(`连不上：${pf.why}（接口地址 ${c.endpoint}，来源：${c.endpointSource}）`);
      const note = pf.image === false
        ? `模型「${pf.modelId}」的清单里没有 image ⇒ 写文案时不会看图，标题容易「像 AI 批量做的」`
        : (pf.image === true ? `模型「${pf.modelId}」支持看图 ⇒ 文案会按实拍图写` : `清单没写这个模型收不收图，真发一张试试才知道`);
      logbus.ok(`接口自检通过：${c.endpoint}（${c.endpointSource}）· 模型 ${pf.modelId} · ${pf.modelHow}`);
      if (pf.listErr) logbus.warn(`模型清单拉不到（${pf.listErr}），只能按配置的模型名直接发`);
      logbus.info(note);
      return {
        ok: true, enabled: true, endpoint: c.endpoint, endpointSource: c.endpointSource,
        modelId: pf.modelId, modelName: pf.modelName, modelHow: pf.modelHow,
        image: pf.image, imageCount: c.imageCount, imageMaxSide: c.imageMaxSide,
        keySet: !!c.apiKey, listErr: pf.listErr, note
      };
    }
    case 'compliance.exportReport': {
      const c = st().compliance || {};
      if (!(c.rows || []).length) throw new Error('没有合规报告：先做一次「开始检查」或「检查父目录」');
      return await compliance.exportReport(
        { rows: c.rows, stats: c.stats, groups: c.groups },
        { log: ctx.log, dir: args.dir || store.get('paths.output'), format: args.format }
      );
    }
    case 'verify.check': {
      if (!st().items.length) throw new Error('请先做素材整理');
      const r = await verify.check(st().items, ctx);
      project.patch({ verify: { rows: r.rows, stats: r.stats, checkedAt: Date.now() } });
      // 大结论（2026-10-05）：只有「会被拦下不发」才是用户要立刻知道的
      ctx.conclude(`货号颜色校验完成【${r.rows.length} 条 · 通过 ${r.stats.pass} · 需人工 ${r.stats.manual}`
        + ` · 会被拦下不发 ${r.stats.blocked}】`, r.stats.blocked ? 'warn' : 'ok');
      return r;
    }
    case 'sheet.export': {
      const s = st();
      if (!s.items.length) throw new Error('没有可导出的素材');
      const pc = store.get('publish') || {};
      // ★ 0 是合法值（连续发布）⇒ 不能写 `pc.intervalSec || ...`，否则发布单里
      //   「期待发布时间」会按 60 秒排开，和真实执行时刻对不上。
      const intervalSec = publisher.gapSecFor('image', pc);
      const r = await sheet.exportSheet(s, Object.assign({ intervalSec }, args || {}));
      // 导出发布单会重建 publish.rows，必须把上一批的「Excel 行号」按 id 带过来：
      // 从「AI 内容报告」导进来的行靠 reportRow 才能把发布结果回写进原报告，
      // 丢了它 → 回写时被过滤成空集 → 界面显示「已回写报告：0 行」且不报错（静默失效）。
      const prevById = new Map((s.publish.rows || []).map(x => [String(x.id), x]));
      const pubRows = r.rows.map((row, i) => {
        const id = s.items[i] ? s.items[i].id : String(i + 1);
        const prev = prevById.get(String(id)) || {};
        return {
          seq: i + 1, id, dir: row[1],
          goods: row[11] ? (row[13] ? 2 : 1) : 1,
          images: 0, startAt: '', status: '排队',
          expect: row[17], title: row[4], goods1: row[11] ? (row[11] + (row[12] ? ' / ' + row[12] : '')) : '',
          result: row[20] === '校验未通过' ? '校验未通过' : '',
          reason: row[21] || '',
          // 「这条发图文还是视频」也要跟着带过来：发布单本身没有「内容类型」列，
          // 只从 items 重建的话这个判定会丢，视频条会被当成图文推图
          kind: prev.kind || '',
          contentType: prev.contentType || '',
          videos: prev.videos || 0,
          reportRow: Number(prev.reportRow || 0)      // 0 = 不是从报告导进来的，回写时会被跳过
        };
      });
      project.patch({ sheet: { file: r.file, rowCount: r.rowCount, colCount: r.colCount, locked: false, exportedAt: Date.now() }, publish: Object.assign({}, s.publish, { rows: pubRows, batch: path.basename(r.file, '.xlsx'), brandId: ctx.brand.brandId, brandName: ctx.brand.brandName }) });
      return r;
    }
    case 'report.import': {
      // 真机流水线的中间产物：上游产「AI 内容报告」xlsx，我们直接吃它 → 生成发布队列
      const file = args.file;
      // 先把上次被占用的报告结果补写掉（对齐真机「下次运行先补写」）
      const flushed = await report.mergeResults(file, []);
      if (flushed.updated) logbus.ok(`先补写了上次暂存的 ${flushed.updated} 条报告结果`);

      const rep = await report.readReport(file);
      const batch = args.batch || path.basename(file, path.extname(file));
      const built = await report.build(rep, {
        batch,
        dir: args.dir || '',              // 报告里没写素材路径时，用界面上选的这一批素材目录
        generateCopy: async sub => (await copywriter.generate(sub, ctx)).rows
      });
      if (!built.pairs.length) {
        const why = built.problems.slice(0, 3).map(p => `第 ${p.rowNo} 行 ${p.why}`).join('；');
        throw new Error(
          `报告里没有一条能用的（共 ${built.problems.length} 行有问题：${why}${built.problems.length > 3 ? '…' : ''}）` +
          '。如果这份报告的「素材路径」是空的，导入时选一下这一批的素材目录即可'
        );
      }

      // 含视频 / 没有图片的行：走现有「校验未通过」机制跳过，界面标红并写明原因（不静默丢）
      const verifyRows = built.blocked.map(b => ({ id: b.id, pass: false, block: true, conclusion: '校验未通过', note: b.note, level: 'bad' }));
      project.patch({
        items: built.items,
        copyRows: built.copyRows,
        verify: { rows: verifyRows, checkedAt: Date.now(), stats: null },
        // ★★ 必须写成 Object.assign(旧 publish, {...})，不许整块替换 ——
        //   2026-10-03 实测事故：整块替换把 publish.mode / device / probe 一起抹掉了，
        //   而 publisher.run 读不到 mode 就**默认走模拟通道**（根本不碰设备）。于是用户点了
        //   「开始发布」，界面一路绿「发布成功」，模拟器里却毫无动静 —— 表现就是「点了没反应」。
        //   同理不再顺手把 connected 重置成 false：导入一份报告，跟设备连没连上没有任何关系。
        publish: Object.assign({}, st().publish, {
          rows: built.publishRows,
          batch, running: false, startedAt: 0,
          reportFile: file, reportSheet: rep.sheetName, reportDir: args.dir || (rep.hasDir ? '' : ''),
          // 批次归属定在「导入/导出」这一刻，发布时沿用 —— 中途换品牌不该把这一批的账改掉
          brandId: ctx.brand.brandId, brandName: ctx.brand.brandName
        })
      });

      logbus.ok(`报告已导入：${built.publishRows.length} 条待发布 · 批次「${batch}」`);
      const fromReport = built.copyRows.filter(r => r.from === '报告').length;
      const generated = built.copyRows.filter(r => r.from === '本地生成').length;
      if (generated) logbus.info(`其中 ${fromReport} 条用报告里的标题/文案，${generated} 条报告里是空的、已本地生成`);

      // ★ 2026-10-03 用户口径：「报告里空着的货号 / 颜色，用叶子文件夹名（货号+颜色，以 + 号分隔）补上」。
      //   内存里已经补好（发布单 / 货号颜色校验 / 发布都用补出来的值），这里再把补出来的**空格子**写回文件，
      //   好让运营打开报告就能看到「货号 / 颜色」是齐的。
      //   写不进去（WPS 占着）绝不静默吞 —— 说清「没写回、但发布单里用的是补出来的值」。
      let fillWrite = { updated: 0, skipped: 0 };
      if (built.fills.length) {
        fillWrite = await report.fillGoods(file, built.fills, { sheetName: rep.sheetName });
        if (fillWrite.updated) {
          logbus.ok(`报告里空着的货号/颜色已按叶子文件夹名补写 ${fillWrite.updated} 条（只填空格，没动你已填的值）`);
        } else {
          logbus.warn(`报告里有 ${built.fills.length} 条货号/颜色是空的，补出来的值没能写回文件：`
            + `${fillWrite.busy ? '报告正被占用（关掉 WPS 再导入一次即可）' : (fillWrite.error || '原因未知')}`
            + ' —— 本次发布用的是补出来的值，不影响发布');
        }
      }
      if (built.fills.length) {
        logbus.info(`报告里 ${built.fills.length} 条空着的货号/颜色已按叶子文件夹名补上：`
          + `货号 ${built.filled.sku} 个 · 颜色 ${built.filled.color} 个`);
      }
      if (built.filled.mismatch.length) {
        logbus.warn(`有 ${built.filled.mismatch.length} 行的货号与叶子文件夹名对不上（颜色留空不补，请人工核）：`
          + built.filled.mismatch.slice(0, 3).map(m => `第 ${m.rowNo} 行 报告「${m.report}」vs 目录「${m.leaf}」`).join('；'));
      }
      if (built.filled.noParse.length) {
        logbus.warn(`有 ${built.filled.noParse.length} 行的文件夹名里没有「货号+颜色」（以 + 号分隔），解析不出货号/颜色：`
          + built.filled.noParse.slice(0, 3).map(m => `第 ${m.rowNo} 行「${m.name}」`).join('；'));
      }

      built.problems.forEach(p => logbus.warn(`第 ${p.rowNo} 行跳过：${p.why}`));
      const nVideo = built.publishRows.filter(r => r.kind === 'video').length;
      logbus.warn(`${built.blocked.length ? built.blocked.length + ' 条暂不发布（内容类型判不了 / 缺对应素材）' : '全部 ' + built.publishRows.length + ' 条可发布'}；发布结果会回写到报告的第 B（实际执行时间）/ C（执行结果）列`);
      if (nVideo) {
        const um = store.get('publish.uiMap') || {};
        const vn = (um.videoSteps || []).length;
        logbus.info(`其中 ${nVideo} 条按「视频」发布（封面用得物推荐的）：${vn
          ? `videoSteps 单独配了 ${vn} 步`
          : '视频复用图文的定位表（图文与视频位置一样，实测）'}`);
      }
      return {
        batch, total: built.publishRows.length, fromReport, generated,
        blocked: built.blocked.length, problems: built.problems, notes: built.notes,
        filled: built.filled, fillWrite,
        reportFile: file, reportSheet: rep.sheetName
      };
    }
    case 'publish.connect': {
      const r = await publisher.connect(args.device);
      project.patch({
        publish: Object.assign({}, st().publish, {
          connected: r.connected, mode: r.mode, device: r.device, probe: r.probe, hasMap: r.hasMap
        })
      });
      logbus.info(r.note);
      return r;
    }
    case 'publish.devices': {
      // ★ 两套一起回：devices = 用户加过的（逐台 probe 出详情），found = adb 现在认到的全部。
      //   界面靠 found 把「还没加进来」的设备直接列出来 —— 用户不用再去猜 emulator-5554 这种名字。
      return {
        devices: await publisher.listDevices(),
        found: await publisher.scanDevices(),
        selected: store.get('publish.device') || ''
      };
    }
    case 'publish.addDevice': {
      const d = publisher.addDevice({ name: args.name, serial: args.serial });
      logbus.ok(`已添加设备：${d.name}（${d.serial}）`);
      return d;
    }
    case 'publish.removeDevice': {
      const list = publisher.removeDevice(args.id);
      logbus.info('已删除设备，剩余 ' + list.length + ' 台');
      return { devices: list };
    }
    case 'publish.probe': {
      const r = await publisher.probe(args.device || (st().publish && st().publish.device) || store.get('publish.device'));
      return r;
    }
    // 一键把内置的中文输入法装到设备上（装 apk + ime enable + ime set 三步，缺一都打不进中文）
    case 'publish.installIme': {
      const serial = args.device || (st().publish && st().publish.device) || store.get('publish.device');
      if (!serial) throw new Error('还没选设备 —— 先在「设备管理」点「扫描设备」，再从列出来的设备里点「加入并使用」');
      const r = await publisher.installIme(serial);
      if (!r.ok) throw new Error(`中文输入法没装成（卡在 ${r.step} 这步）：${r.error}`);
      logbus.ok(`已装上中文输入法并设为当前输入法（${r.component}）—— 现在再点一次「检查能不能发布」`);
      return r;
    }
    /*
     * 把**内置的得物 App 安装包**装进模拟器 —— MuMu 自带的应用商店里搜不到得物，这是兜底路。
     * ★★ 已经装过就**一条 install 都不发**（得物里是登录状态 + 本地草稿）：
     *    这种情况返回 `already:true`，界面据此再给一个显式的「覆盖重装」按钮（args.force）。
     * ★ 装完必须回读 `pm list packages` 才算成功（dewuapk.install 里做）—— 不许假成功。
     */
    case 'publish.installDewuApk': {
      const serial = args.device || (st().publish && st().publish.device) || store.get('publish.device');
      if (!serial) throw new Error('还没选设备 —— 先在「模拟器发布」页点「扫描设备」，再从列出来的设备里点「加入并使用」');
      const r = await dewuapk.install(serial, { force: !!args.force });
      if (!r.ok) throw new Error(`得物安装包没能装进模拟器（卡在 ${r.step} 这步）：${r.error}${r.hint ? ' ' + r.hint : ''}`);
      if (r.already) {
        logbus.info(`模拟器里已经有得物${r.installedVersion ? ' ' + r.installedVersion : ''}（内置安装包是 ${r.apkVersion}）—— 我没有动它，登录状态和草稿都还在`);
        logbus.warn('确实需要覆盖重装（`-r`，应用数据与登录状态保留）时，点这一行刚出现的「覆盖重装」按钮');
      } else {
        logbus.ok(`已装进模拟器：得物${r.installedVersion ? ' ' + r.installedVersion : ''}`
          + `${r.replaced ? '（覆盖重装，应用数据与登录状态保留）' : ''}`);
      }
      return r;
    }
    case 'publish.dump': {
      const serial = args.device || (st().publish && st().publish.device) || store.get('publish.device');
      if (!serial) throw new Error('还没选设备 —— 先在「设备管理」点「扫描设备」，再从列出来的设备里点「加入并使用」');
      // ★ 抓之前先说清「你现在停在哪一屏」：dump 抓的就是当前这一屏，抓错页面 = 一份错坐标的表
      const d = await publisher.dumpForCapture(serial);
      if (!d.ok) {
        throw new Error(d.blocked ? `先看这一屏：${d.why}`
          : `抓不到界面结构：${d.why}。确认设备在线、没锁屏；`
            + `若卡在动画页（得物发布页首屏会这样），dumpsys 备用通道也没抓到，把上面这句原始输出发我`);
      }
      if (d.focusNote) logbus.warn(d.focusNote);
      else if (d.focus) logbus.info(`当前停在这一屏：${d.focus}`);
      if (d.animOff) logbus.warn('页面一直不 idle，已临时关掉系统动画抓到结构（抓完已还原）');
      if (d.viaNote) logbus.warn(d.viaNote);
      const xml = d.xml;
      const nodes = require('./services/uimap').parseNodes(xml);
      // ★ 把**抓取时的坐标系**传给 suggest，写进生成的表（screen 戳）：
      //   运行时拿它和当下的 adb.uiSize() 比 —— 对不上就拦下来，别让写死的 tapXY 静默点偏。
      const map = require('./services/uimap').suggest(nodes, undefined, { screen: d.screen });
      const outDir = path.join(store.get('paths.output'), 'dumps');
      await wp.mkdirp(outDir);
      const tag = wp.stamp();
      const xmlFile = path.join(outDir, `ui-dump-${tag}.xml`);
      const mapFile = path.join(outDir, `uiMap-${tag}.json`);
      await fs.promises.writeFile(wp.toLong(xmlFile), xml, 'utf8');
      await fs.promises.writeFile(wp.toLong(mapFile), JSON.stringify(map, null, 2), 'utf8');
      logbus.ok(`已抓取 ${nodes.length} 个节点 → ${path.basename(xmlFile)}`);
      // ★ 说清这张表是在哪个坐标系里量的：以后换了分辨率/方向，运行时就能据此拦住「整体点偏」。
      if (map.screen) logbus.info(`这张表记下了抓取时的坐标系：${map.screen.w}x${map.screen.h}`);
      else logbus.warn('★ 没读到当前屏幕尺寸（dumpsys 没给出 cur=），这张表不会带坐标系戳 —— '
        + '换了分辨率或方向之后，运行时就判不出「表是按另一个坐标系量的」，写死的坐标会静默点偏');
      logbus.warn(`已生成候选定位表 ${path.basename(mapFile)}：steps 是按关键词猜的，改对后再导入（视频默认复用这套，不用单独配）`);
      return { xmlFile, mapFile, nodeCount: nodes.length, steps: map.steps.length, videoSteps: (map.videoSteps || []).length, focus: d.focus, via: d.via, screen: map.screen || null, preview: nodes.filter(n => n.text).slice(0, 12).map(n => n.text) };
    }
    case 'publish.importMap': {
      const raw = await fs.promises.readFile(wp.toLong(args.file), 'utf8');
      const j = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const um = require('./services/uimap');
      // 写错的 action 在**导入时**就报出来（并列出可用值），别等发布跑一半才抛「未知步骤类型」
      const steps = um.normalizeSteps(j.steps, 'steps');
      const videoSteps = (Array.isArray(j.videoSteps) && j.videoSteps.length) ? um.normalizeSteps(j.videoSteps, 'videoSteps') : [];
      // ⚠️ store.set 是深合并：只给 steps 的话，上一份定位表里的 videoSteps 会被**原样留下**，
      // 结果「导入了新表、视频却在用旧坐标」。所以整表替换，缺的键显式置空。
      const prev = store.get('publish.uiMap') || {};
      const uiMap = {
        package: j.package || '',
        generatedAt: j.generatedAt || 0,
        // ★★ 2026-10-04 新增：**抓取时的坐标系**必须跟着表一起走 ——
        //   少了它，运行时就判不出「这张表是在另一个分辨率/方向下量的」，
        //   写死的 tapXY 会静默点偏（input tap 对越界坐标不报错，实测 rc=0）。
        //   老表没有这个键 ⇒ null ⇒ 运行时退到「逐点越界」那条兜底判据（不误拦）。
        screen: j.screen || null,
        steps,
        videoSteps,
        videoNote: j.videoNote || ''
      };
      // ★ 2026-10-03：「失败恢复动作」整块删除 ⇒ 这里不再把 prev.recover 捞回来合并。
      //   ★ 别误解成「老配置里那个键会被清掉」：store.set 走的是 mergeDeep，**没有删键能力**，
      //     所以它作为死键会一直躺在 config.json 里 —— 但**没人再读它**（uimap / publisher / 界面都删了）。
      store.set({ publish: { uiMap } });
      logbus.ok(`UI 定位表已导入：图文 ${steps.length} 步 · ${videoSteps.length
        ? `视频单独配了 ${videoSteps.length} 步`
        : '视频复用图文（默认，不用单独配）'}（来自 ${path.basename(args.file)}）`);
      return { steps: steps.length, videoSteps: videoSteps.length, file: args.file };
    }
    case 'publish.run': {
      const s = st();
      if (!s.publish.rows || !s.publish.rows.length) throw new Error('请先导出发布单');
      // ★★ 2026-10-04 用户口径：**AI 内容报告被 Excel 占着就禁止发布**（见 assertExcelClosed）。
      //   放在最前面：一条都不发就拦住，别等发完才发现结果写不进去（那是整批白跑）。
      //   两个要回写的文件都查：报告（B/C 列）+ 发布单（结果列）。
      const wr = await assertExcelClosed([s.publish.reportFile, s.sheet.file]);
      if (wr.checked) logbus.info(`发布前检查：要回写的 ${wr.checked} 个 Excel 都没被占用（可以直接发）`);
      // 批次名默认取发布单文件名（真机：选 AI内容报告_xxx.xlsx → 开始批次）
      const batch = args.batchId || s.publish.batch || (s.sheet.file ? path.basename(s.sheet.file, path.extname(s.sheet.file)) : '') || ('批' + wp.stamp());
      const r = await publisher.run(Object.assign({}, s, { publish: Object.assign({}, s.publish, { batch }) }), Object.assign({}, ctx, {
        onRow: row => send('publish:row', row)
      }));
      project.patch({ publish: Object.assign({}, s.publish, { rows: r.rows, batch: r.batch, running: false }) });
      if (s.sheet.file) {
        const m = await sheet.mergeResults(s.sheet.file, r.results);
        if (m.busy) {
          logbus.warn(`Excel 仍被占用，${m.pending} 条结果已暂存，下次再试（可只读打开但不建议编辑保存）`);
        } else if (m.error) {
          logbus.error(`回写发布单失败：${m.error}`);   // 不是「被占用」，别假装写进去了
        } else {
          logbus.ok(`已合并回写发布单：${m.updated} 行${m.flushed ? `（含补写上次的 ${m.flushed} 条）` : ''}`);
        }
      }
      // 从「AI 内容报告」导入的批次：回写它的 B（实际执行时间）/ C（执行结果）列
      if (s.publish.reportFile) {
        const mr = await report.mergeResults(s.publish.reportFile, r.results, { sheetName: s.publish.reportSheet });
        if (mr.busy) {
          logbus.warn(`报告仍被占用，${mr.pending} 条已暂存，下次导入/发布时先补写`);
        } else if (mr.error) {
          logbus.error(`回写报告失败：${mr.error}`);     // 例如报告表头缺列：不可恢复，必须直说
        } else if (mr.updated) {
          logbus.ok(`已回写报告：${mr.updated} 行${mr.flushed ? `（含补写上次的 ${mr.flushed} 条）` : ''} → ${path.basename(s.publish.reportFile)}`);
        } else if (mr.skipped) {
          // 这条以前会打成「已回写报告：0 行」——看着像成功，其实一条都没写
          logbus.info(`本次结果没有可回写的报告行（${mr.skipped} 条不是从这份报告导进来的），跳过回写`);
        }
      }
      notify('发布批次结束', `成功 ${r.okCount} / ${r.total} 条，记得回查审核状态`);
      // ★ 大结论（2026-10-05 用户要的格式）：一行说完「目标 / 成功 / 失败」。
      //   三种情况分开说，**既不许拿绿灯盖红字、也不许拿「成功 0」糊弄**：
      //     · 真机全成功 → 发布成功【目标 N 条，成功 N 条，失败 0 条】
      //     · 真机有失败 → 发布结束（有失败）【…】＋ 去哪看逐条原因
      //     · 模拟通道   → 模拟发布完成【…】：模拟本来就没真发出去，报「成功 K 条」会被当成发出去了
      const failCount = r.failCount || 0;
      if (failCount) {
        ctx.conclude(`发布结束（有失败）【目标 ${r.total} 条，成功 ${r.okCount} 条，失败 ${failCount} 条】`, 'warn');
        ctx.conclude(`这 ${failCount} 条为什么没发出去：逐条原因见「发布单」的结果列（失败截图在输出目录的 failures 文件夹）`, 'warn');
      } else if (r.mode === 'mock') {
        const mockOk = (r.rows || []).filter(x => x.result === '模拟成功').length;
        ctx.conclude(`模拟发布完成【目标 ${r.total} 条，模拟成功 ${mockOk} 条，失败 0 条】`
          + '· 模拟通道不接触设备，**不算真发布**（要真发请先「连接模拟器」并点「检查能不能发布」通过）', 'warn');
      } else {
        ctx.conclude(`发布成功【目标 ${r.total} 条，成功 ${r.okCount} 条，失败 0 条】`
          + '· 发完 ≠ 发出去了，记得回查审核状态', 'ok');
      }
      return { okCount: r.okCount, total: r.total, failCount: r.failCount, batch: r.batch };
    }
    case 'publish.exportLog': {
      // 「重导出日志」：按批次把 publish-log.jsonl 导成可读的 .log + .csv
      return await sheet.exportPublishLog({ batch: args.batch, dir: args.dir });
    }
    case 'publish.rerun': {
      const s = st();
      const row = (s.publish.rows || []).find(r => String(r.seq) === String(args.seq));
      if (!row) throw new Error('找不到该行');
      // ★ 「重跑」同样是发布 ⇒ 同样要挡住「报告被 Excel 占着」（不然重跑的结果照样写不回去）
      await assertExcelClosed([s.publish.reportFile, s.sheet.file]);
      row.result = ''; row.reason = '';
      const subset = Object.assign({}, s, { publish: Object.assign({}, s.publish, { rows: [row] }) });
      const r = await publisher.run(subset, Object.assign({}, ctx, { onRow: rw => send('publish:row', rw) }));
      project.patch({ publish: Object.assign({}, s.publish, { rows: s.publish.rows }) });
      if (s.sheet.file) await sheet.mergeResults(s.sheet.file, r.results);
      if (s.publish.reportFile) await report.mergeResults(s.publish.reportFile, r.results, { sheetName: s.publish.reportSheet });
      // 大结论（2026-10-05）：与整批发布同一个口径（重跑就是「只发这一条」的一批）
      ctx.conclude(r.okCount >= 1
        ? `重跑成功【目标 1 条，成功 1 条，失败 0 条】`
        : `重跑结束（失败）【目标 1 条，成功 0 条，失败 1 条】`, r.okCount >= 1 ? 'ok' : 'warn');
      return { okCount: r.okCount, total: 1 };
    }
    case 'pool.import': {
      const r = pool.importFile(args.file);
      logbus.ok(`商品池已导入：${Object.keys(r.skus).length} 个货号（来源 ${r.source}）`);
      return { count: Object.keys(r.skus).length, source: r.source };
    }
    case 'project.reset': {
      project.reset();
      return { ok: true };
    }
    default:
      throw new Error('未知任务：' + type);
  }
}

async function run(type, args = {}) {
  // 品牌归属与权限放在最前面：不通过就连任务都不起、日志也不写 ——
  // 否则「被拒绝」这件事会以一条正常任务日志的样子留在台账里，越查越乱
  const actor = auth.enabled() ? auth.current() : null;
  const picked = brands.resolveFor(actor, args.brandId, { required: BRAND_SCOPED.has(type) });
  if (!picked.ok) return { ok: false, error: picked.error, brandDenied: true };
  const brand = picked.brand || null;
  const actorInfo = actor
    ? { userId: actor.id, username: actor.username, displayName: actor.displayName || actor.username }
    : { userId: '', username: '', displayName: '' };
  const brandInfo = brand ? { brandId: brand.id, brandName: brand.name } : { brandId: '', brandName: '' };
  const who = brand ? brand.name : brands.UNKNOWN_NAME;

  // 文案生成必须有「这个品牌自己的」提示词。拦在这里（job 实例化之前）而不是生成中途：
  // 中途失败会在 runlog 里留下一条「开始 + 失败」，台账上多出一堆没跑成的批次更难查。
  // 没配提示词时**不回退到内置模板** —— 那样产出的文案看不出归属，比直接拦住更难发现。
  if (type === 'copy.generate' && brand && !brands.hasWritePrompt(brand)) {
    const lb = args.label || args.batchId || TYPE_LABEL[type] || type;
    const msg = `品牌「${brand.name}」还没配「文案生成提示词」——到「文案生成 → 提示词配置」里补上再跑`;
    logbus.error(`[${lb}] ${msg}`, Object.assign({ type, label: lb }, brandInfo, actorInfo));
    return { ok: false, error: msg, brandId: brandInfo.brandId, brandName: brandInfo.brandName };
  }

  const parallel = PARALLEL_TYPES.has(type);
  const ids = typeIds(type);
  // 起不来就直接回 {ok:false}（不抛异常）：渲染层拿得到原因能弹提示，不会变成未捕获的 Promise 报错
  if (parallel) {
    // 批次级任务：同一个批次不允许重复起，不同批次可以同时跑
    const dup = args.batchId && [...ids].some(id => running.get(id) && running.get(id).batch === args.batchId);
    if (dup) return { ok: false, error: `批次「${args.batchId}」正在处理中，先等它跑完或取消掉` };
  } else if (ids.size) {
    return { ok: false, error: '该任务正在运行中' };
  }

  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const label = args.label || args.batchId || TYPE_LABEL[type] || type;
  const job = { id, type, label, batch: args.batchId || '', token: { cancel: false }, progress: null, startedAt: Date.now(), brandId: brandInfo.brandId, brandName: brandInfo.brandName };
  running.set(id, job);
  if (!byType.has(type)) byType.set(type, new Set());
  byType.get(type).add(id);

  // ★ 2026-10-05 用户口径（「运行日志太细了…就给大结论」）：
  //   `ctx.log` 是**过程流水**通道（每步耗时 / 坐标 / 屏幕守卫 / 清相册 / 抽帧…）⇒ 一律标成明细，
  //   主界面（底部日志栏 + 「运行日志」页）不再刷屏；但它照样落 run-log.jsonl（管理员台账），
  //   任务行的「查看详情」也能按批次逐条回看 —— 只是不再往用户脸上刷。
  //   两条例外，它们本身就是结论，必须让用户看见：
  //     ① level === 'error'：真出错了。「太细」不是把错误藏起来的理由；
  //     ② ctx.conclude(...)：调用点显式声明的结论行（任务级「成功【目标/成功/失败】」这类）。
  const emit = (msg, level, opts) => {
    const fn = { ok: logbus.ok, warn: logbus.warn, error: logbus.error }[level] || logbus.info;
    const meta = Object.assign({ jobId: id, batch: job.batch, label, type }, brandInfo, actorInfo);
    // 该条算「大结论」还是「过程明细」的规则只在 logbus.tierOf 里写一次（error 与 opts.ui 例外）
    const detail = logbus.tierOf(level, opts) === 'detail';
    // 日志带上批次，界面「查看详情」能按批次把这一步的日志筛出来
    fn(`[${label}] ${msg}`, meta, detail ? logbus.DETAIL : null);
    // 同时落盘：logbus 只有内存 500 条，关了程序就没了，管理员事后查不到
    runlog.append(Object.assign({ kind: 'log', level: level || 'info', msg: String(msg), jobId: id, batch: job.batch, label, type }, brandInfo, actorInfo));
  };
  const ctx = {
    jobId: id,
    batch: job.batch,
    // 品牌与执行人跟着 ctx 走：发布侧要用它写进 publish-log（每一条都要能追到人）
    // brand 只放 id/name —— 它会整条 Object.assign 进每条日志的 meta，
    // 完整品牌对象带着上千字的提示词，塞进去等于每条日志都抄一遍模板
    brand: brandInfo,
    brandFull: brand,
    actor: actorInfo,
    cancelled: () => job.token.cancel,
    log: emit,
    // 大结论：只有这句会直接出现在用户眼前（其余 ctx.log 都沉到明细里）
    conclude: (msg, level) => emit(msg, level, { ui: true }),
    progress: p => {
      job.progress = Object.assign({ done: 0, total: 0 }, p);
      send('job:progress', Object.assign({ id, type, label, batch: job.batch }, p));
      if (p && p.total) taskbar(Math.min(1, (p.done || 0) / p.total));
    }
  };

  send('job:started', { id, type, label, batch: job.batch, startedAt: job.startedAt, brandId: brandInfo.brandId, brandName: brandInfo.brandName });
  runlog.append(Object.assign({ kind: 'start', jobId: id, label, type, batch: job.batch }, brandInfo, actorInfo));
  if (picked.auto) logbus.info(`[${label}] 你的品牌权限只有一个，本次归属「${who}」`, Object.assign({ jobId: id, type, label }, brandInfo, actorInfo));
  try {
    const res = await dispatch(type, args, ctx);
    const elapsedSec = +((Date.now() - job.startedAt) / 1000).toFixed(1);
    send('job:done', { id, type, label, batch: job.batch, ok: true, busy: false, elapsedSec, brandId: brandInfo.brandId, brandName: brandInfo.brandName });
    runlog.append(Object.assign({ kind: 'end', ok: true, jobId: id, label, type, batch: job.batch, elapsedSec }, brandInfo, actorInfo));
    if (!running.size) taskbar(-1);
    return { ok: true, result: res, jobId: id, batch: job.batch, brandId: brandInfo.brandId, brandName: brandInfo.brandName };
  } catch (e) {
    // 被取消的任务统一报「任务已取消」：否则各步骤自己的报错（如「没找到叶子目录」）会误导人
    const msg = job.token.cancel ? '任务已取消' : e.message;
    const elapsedSec = +((Date.now() - job.startedAt) / 1000).toFixed(1);
    if (job.token.cancel) logbus.warn(`[${label}] 任务已取消`, { jobId: id, batch: job.batch, label, type });
    else logbus.error(`[${label}] ${type} 失败：${e.message}`, Object.assign({ jobId: id, batch: job.batch, label, type }, brandInfo, actorInfo));
    send('job:done', { id, type, label, batch: job.batch, ok: false, cancelled: job.token.cancel, error: msg, elapsedSec, brandId: brandInfo.brandId, brandName: brandInfo.brandName });
    runlog.append(Object.assign({ kind: 'end', ok: false, error: msg, cancelled: !!job.token.cancel, jobId: id, label, type, batch: job.batch, elapsedSec }, brandInfo, actorInfo));
    if (!running.size) taskbar(-1);
    return { ok: false, error: msg, cancelled: job.token.cancel, jobId: id, batch: job.batch, brandId: brandInfo.brandId, brandName: brandInfo.brandName };
  } finally {
    running.delete(id);
    const s = byType.get(type);
    if (s) { s.delete(id); if (!s.size) byType.delete(type); }
    if (!running.size) taskbar(-1);
  }
}

/** 取消：传 job id 停单个（界面「取消任务」），传任务类型停该类型全部（界面「全部取消」） */
function cancel(ref) {
  if (!ref) return 0;
  const hit = [];
  if (running.has(ref)) hit.push(running.get(ref));
  else for (const id of typeIds(ref)) { const j = running.get(id); if (j) hit.push(j); }
  for (const j of hit) {
    j.token.cancel = true;
    // 带 meta：界面「查看详情」按批次筛日志时，这条停止记录也在
    logbus.warn(`[${j.label}] 已请求停止（在当前步骤后停下）`, { jobId: j.id, batch: j.batch, label: j.label, type: j.type });
  }
  return hit.length;
}

/** busy(type) → 该类型是否在跑；busy() 不传参 → 运行中的任务清单（界面启动时对齐状态用） */
function busy(type) {
  if (type) return typeIds(type).size > 0;
  return list();
}

/** 运行中的任务清单（「运行中的批次」） */
function list() {
  const now = Date.now();
  return [...running.values()].map(j => ({
    id: j.id, type: j.type, label: j.label, batch: j.batch,
    brandId: j.brandId || '', brandName: j.brandName || '',
    startedAt: j.startedAt, elapsedSec: +((now - j.startedAt) / 1000).toFixed(1),
    progress: j.progress
  }));
}

module.exports = { run, cancel, busy, list, TYPE_LABEL, itemsDir };
