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
const publisher = require('./services/publisher');
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
  'copy.generate': 'AI 文案生成',
  'verify.check': '好物货号颜色预检',
  'sheet.export': '导出发布单', 'report.import': '导入 AI 内容报告',
  'publish.run': '自动发布', 'publish.rerun': '发布重跑',
  'publish.exportLog': '重导出日志', 'publish.setRecover': '编辑失败恢复动作', 'pool.import': '导入商品池'
};

/** 批次级产物目录：每个批次一个文件夹，互不覆盖 */
function batchDir(batchId) { return path.join(store.get('paths.output'), 'batches', String(batchId).replace(/[<>:"|?*\\/]/g, '_')); }

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
      return res;
    }
    case 'compliance.scan': {
      if (!st().items.length) throw new Error('请先做素材整理');
      const { rows, stats } = await compliance.scan(st().items, ctx);
      project.patch({ compliance: { rows, stats, scannedAt: Date.now() } });
      return { rows, stats };
    }
    case 'compliance.scanParent': {
      const dir = needSourceDir(args.dir || st().sourceDir);
      const r = await compliance.scanParent(dir, ctx);
      project.patch({ compliance: { rows: r.rows, stats: r.stats, groups: r.groups, scannedAt: Date.now() } });
      return { groups: r.groups.map(g => ({ name: g.name, stats: g.stats })), stats: r.stats };
    }
    case 'compliance.fix': {
      const s = st();
      const r = await compliance.fix(s.items, s.compliance.rows, ctx);
      project.patch({ compliance: { rows: r.rows, stats: s.compliance.stats, scannedAt: s.compliance.scannedAt } });
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
          items: items.map(i => ({ id: i.id, dir: i.dir, sku: i.sku, color: i.color, files: i.files.length })),
          rows: r.rows
        }, null, 2), 'utf8');
        logbus.ok(`[${batchId}] 批次完成：${r.rows.length} 篇 → ${wp.toDisplay(file)}`, { batch: batchId });
        return { batchId, count: r.rows.length, file, warning: r.warning, llm: r.llm };
      }
      if (!st().items.length) throw new Error('请先做素材整理');
      const r = await copywriter.generate(st().items, ctx);
      project.patch({ copyRows: r.rows });
      return { count: r.rows.length, warning: r.warning, llm: r.llm };
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
      return r;
    }
    case 'sheet.export': {
      const s = st();
      if (!s.items.length) throw new Error('没有可导出的素材');
      const pc = store.get('publish') || {};
      const intervalSec = pc.intervalSec || pc.intervalMinSec || 60;
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
          retries: 0, reason: row[21] || '',
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
        publish: {
          rows: built.publishRows,
          batch, connected: false, running: false, startedAt: 0,
          reportFile: file, reportSheet: rep.sheetName, reportDir: args.dir || (rep.hasDir ? '' : ''),
          // 批次归属定在「导入/导出」这一刻，发布时沿用 —— 中途换品牌不该把这一批的账改掉
          brandId: ctx.brand.brandId, brandName: ctx.brand.brandName
        }
      });

      logbus.ok(`报告已导入：${built.publishRows.length} 条待发布 · 批次「${batch}」`);
      const fromReport = built.copyRows.filter(r => r.from === '报告').length;
      const generated = built.copyRows.filter(r => r.from === '本地生成').length;
      if (generated) logbus.info(`其中 ${fromReport} 条用报告里的标题/文案，${generated} 条报告里是空的、已本地生成`);
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
    case 'publish.dump': {
      const serial = args.device || (st().publish && st().publish.device) || store.get('publish.device');
      if (!serial) throw new Error('还没选设备 —— 先在「设备管理」点「扫描设备」，再从列出来的设备里点「加入并使用」');
      // ★ 抓之前先说清「你现在停在哪一屏」：dump 抓的就是当前这一屏，抓错页面 = 一份错坐标的表
      const d = await publisher.dumpForCapture(serial);
      if (!d.ok) {
        throw new Error(d.blocked ? `先看这一屏：${d.why}`
          : d.idle ? `抓不到界面结构：当前页面一直不 idle（得物发布页会这样）—— 原始输出「${d.why}」`
          : `抓不到界面结构：${d.why}。确认设备在线、没锁屏`);
      }
      if (d.focusNote) logbus.warn(d.focusNote);
      else if (d.focus) logbus.info(`当前停在这一屏：${d.focus}`);
      if (d.animOff) logbus.warn('页面一直不 idle，已临时关掉系统动画抓到结构（抓完已还原）');
      const xml = d.xml;
      const nodes = require('./services/uimap').parseNodes(xml);
      const map = require('./services/uimap').suggest(nodes);
      const outDir = path.join(store.get('paths.output'), 'dumps');
      await wp.mkdirp(outDir);
      const tag = wp.stamp();
      const xmlFile = path.join(outDir, `ui-dump-${tag}.xml`);
      const mapFile = path.join(outDir, `uiMap-${tag}.json`);
      await fs.promises.writeFile(wp.toLong(xmlFile), xml, 'utf8');
      await fs.promises.writeFile(wp.toLong(mapFile), JSON.stringify(map, null, 2), 'utf8');
      logbus.ok(`已抓取 ${nodes.length} 个节点 → ${path.basename(xmlFile)}`);
      logbus.warn(`已生成候选定位表 ${path.basename(mapFile)}：steps 是按关键词猜的，改对后再导入（视频默认复用这套，不用单独配）`);
      return { xmlFile, mapFile, nodeCount: nodes.length, steps: map.steps.length, videoSteps: (map.videoSteps || []).length, focus: d.focus, preview: nodes.filter(n => n.text).slice(0, 12).map(n => n.text) };
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
        steps,
        videoSteps,
        videoNote: j.videoNote || ''
      };
      // 恢复动作是在界面上单独维护的（「失败恢复动作」），导入定位表不该把它清掉
      if (Array.isArray(prev.recover) && prev.recover.length) uiMap.recover = prev.recover;
      store.set({ publish: { uiMap } });
      logbus.ok(`UI 定位表已导入：图文 ${steps.length} 步 · ${videoSteps.length
        ? `视频单独配了 ${videoSteps.length} 步`
        : '视频复用图文（默认，不用单独配）'}（来自 ${path.basename(args.file)}）`);
      return { steps: steps.length, videoSteps: videoSteps.length, file: args.file };
    }
    case 'publish.setRecover': {
      // 失败恢复动作可编辑（真机每个账号/版本不同：「回退转发页」「删除卡片」…）
      const um = require('./services/uimap');
      const steps = um.normalizeRecover(args.steps);   // 不认识的动作直接报错，不静默吞掉
      const cur = store.get('publish.uiMap') || {};
      store.set({ publish: { uiMap: Object.assign({}, cur, { recover: steps }) } });
      logbus.ok(steps.length
        ? `失败恢复动作已保存：${steps.length} 步（${steps.map(s => s.action).join(' → ')}）`
        : '失败恢复动作已清空：失败后只按返回键回退');
      return { recover: steps };
    }
    case 'publish.run': {
      const s = st();
      if (!s.publish.rows || !s.publish.rows.length) throw new Error('请先导出发布单');
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
      row.result = ''; row.retries = 0; row.reason = '';
      const subset = Object.assign({}, s, { publish: Object.assign({}, s.publish, { rows: [row] }) });
      const r = await publisher.run(subset, Object.assign({}, ctx, { onRow: rw => send('publish:row', rw) }));
      project.patch({ publish: Object.assign({}, s.publish, { rows: s.publish.rows }) });
      if (s.sheet.file) await sheet.mergeResults(s.sheet.file, r.results);
      if (s.publish.reportFile) await report.mergeResults(s.publish.reportFile, r.results, { sheetName: s.publish.reportSheet });
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
    log: (msg, level) => {
      const fn = { ok: logbus.ok, warn: logbus.warn, error: logbus.error }[level] || logbus.info;
      const meta = Object.assign({ jobId: id, batch: job.batch, label, type }, brandInfo, actorInfo);
      // 日志带上批次，界面「查看详情」能按批次把这一步的日志筛出来
      fn(`[${label}] ${msg}`, meta);
      // 同时落盘：logbus 只有内存 500 条，关了程序就没了，管理员事后查不到
      runlog.append(Object.assign({ kind: 'log', level: level || 'info', msg: String(msg), jobId: id, batch: job.batch, label, type }, brandInfo, actorInfo));
    },
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

module.exports = { run, cancel, busy, list, TYPE_LABEL };
