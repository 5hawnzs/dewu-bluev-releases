#!/usr/bin/env node
'use strict';
/**
 * ★ 配置搬运工具（换机 / 交接给别的代理用）：把 userData 里的配置拆成
 *   「可搬运」「必须在新机重置」「密钥」三类，一键导出 / 导入。
 *
 * 为什么需要它（2026-10-05 实测结论，别重走）：
 *   ★ 2026-10-08 起界面上那两个「导出配置 / 导入配置」按钮**已经删了**
 *     （用户要求：云端协作这块不给任何人看到）。它们当初也只导出云端协作的三个字段
 *   （cloud.url / cloud.anonKey / cloud.org，见 src/main/services/cloudsync.js 的导出实现）——
 *   模型密钥、品牌、话题池、**真机 UI 定位表**（publish.uiMap：38 步图文 + 41 步视频，最贵的资产）
 *   一个都不在里面。整份 config.json 只有一个办法：搬文件 —— 而它同时装着
 *     · 机器专属值：paths.*（绝对路径）、cloud.machineId / machineName、adbPath / ffmpegPath
 *     · 明文密钥：copy.llm.apiKey（真实模型密钥）、verify.api.apiKey
 *   照搬到新机会踩两个坑：路径**静默失效**（不报错、就是扫不到素材）；
 *   两台机器共用同一个 machineId ⇒ 云端看板把它们当成同一台。
 *   ⇒ 本工具把三类东西分开：能搬的原样带走，机器专属的**显式置空**，
 *     密钥默认剔除（新机重填），要带就显式 `--with-secrets`（那时这个文件就属敏感件）。
 *
 * 用法：
 *   node tools/config-portable.js inspect                                # 看本机现状（只读）
 *   node tools/config-portable.js export --out cfg.json                  # 导出（默认抹掉密钥）
 *   node tools/config-portable.js export --out cfg.json --with-secrets --with-project
 *   node tools/config-portable.js import cfg.json                        # 预演（默认不写盘）
 *   node tools/config-portable.js import cfg.json --yes                  # 真写（先备份 config.json）
 *   node tools/config-portable.js selftest                               # 往返自测（临时目录，不碰真配置）
 *
 * 通用可选参数：
 *   --userdata <dir>   指定 userData 目录。默认按平台算：
 *                      Windows %APPDATA%\<name> · macOS ~/Library/Application Support/<name> · Linux ~/.config/<name>
 *
 * ★ 导入前请把 App 关掉。config.json 是 App 启动时读进内存、之后整份写回的
 *   （store.scheduleSave 250ms 防抖）⇒ App 开着时导进去，很可能被内存里的旧值刷掉。
 *
 * 退出码：0 正常；1 参数 / IO 错；2 自测有 FAIL。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const wp = require(path.join(__dirname, '..', 'src', 'main', 'util', 'winpath'));
const pkg = require(path.join(__dirname, '..', 'package.json'));

const APP = pkg.productName || pkg.name;
const FORMAT = 1;

const ARGV = process.argv.slice(2);
const CMD = ARGV[0] || '';
function flag(name) { return ARGV.includes(name); }
function opt(name, def) {
  const i = ARGV.indexOf(name);
  if (i < 0) return def;
  const v = ARGV[i + 1];
  return (v === undefined || v.startsWith('--')) ? def : v;
}
function positional(i) { const a = ARGV[i]; return (a && !a.startsWith('--')) ? a : ''; }

/* ------------------------------------------------------------------ 路径 */

function defaultUserData() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP);
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP);
}
function userDataDir() {
  const u = opt('--userdata', '');
  return u ? path.resolve(u) : defaultUserData();
}

/* ------------------------------------------------------- 分类：三类字段 */

/**
 * 「必须在新机重置」的字段。第二项是重置后的值（一律是出厂态）。
 * ★ 判定为什么按**原值**而不是「路径长什么样」：这些都是设计上就带机器属性的键，
 *   一律清零最省事也最可解释；`paths.source` 在 store.js 里已降级为 legacy（不再被读）。
 */
const RESET = [
  ['paths.output', ''],
  ['paths.rejected', ''],
  ['paths.source', ''],
  ['publish.adbPath', ''],
  ['publish.ffmpegPath', ''],
  ['cloud.machineId', ''],
  ['cloud.machineName', ''],
  ['window.bounds', null],
  ['window.maximized', false]
];

/** 密钥类**叶子键名**。★ 故意不写裸 `key`：cloud.anonKey 是公开设计（靠 RLS 收口），不该被抹。 */
const SECRET_KEY = /^(apikey|secret|secretid|secretkey|secretaccesskey|token|password|passwd|credential)$/i;

/** project.json 里的机器专属项（--with-project 时用） */
const PROJECT_DROP = ['publish.probe'];
const PROJECT_RESET = ['sourceDir', 'flatDir', 'sheet.file', 'publish.reportFile'];

/* ------------------------------------------------------------ 小工具函数 */

function getAt(o, p) {
  return String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
}
function parentOf(o, p) {
  const ks = String(p).split('.');
  // ★ 顶层键（没有点）的「父」就是对象本身 —— 少了这一条，`sourceDir` 这类顶层键
  //   会被判成「父不存在」而被整条跳过（自测 ⑤ 就是这么红的：sourceDir/flatDir 没被置空）。
  if (ks.length === 1) return o;
  return getAt(o, ks.slice(0, -1).join('.'));
}
function setAt(o, p, v) {
  const ks = String(p).split('.');
  const last = ks.pop();
  let cur = o;
  for (const k of ks) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[last] = v;
}
function delAt(o, p) {
  const par = parentOf(o, p);
  if (par) delete par[String(p).split('.').pop()];
}
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
function short(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
/** 与 src/main/store.js 的 mergeDeep 同语义（对象深合、数组整体替换、只覆盖不删键） */
function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
function readJson(p) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(wp.toLong(p), 'utf8')) }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }; }
}
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(wp.toLong(path.dirname(p)), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(wp.toLong(tmp), JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(wp.toLong(tmp), wp.toLong(p));
}
function humanSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}
function statSize(p) { try { return fs.statSync(wp.toLong(p)).size; } catch (e) { return null; } }

/* ------------------------------------------------------------ 导出（清洗） */

/** 只扫纯对象里的叶子键（不进数组：密钥不会藏在数组元素里，少一层路径歧义） */
function walkLeaves(o, cb, prefix) {
  prefix = prefix || '';
  if (!o || typeof o !== 'object' || Array.isArray(o)) return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) walkLeaves(v, cb, p);
    else cb(p, k, v);
  }
}

/**
 * 把一份 config 洗成「可搬运」的形态。
 * 返回 { config, reset:[{path,from}], redacted:[{path,len}] } —— reset/redacted 会写进 _meta，供导入侧审计。
 * ★ 只改**已存在**的键：配置里没有的键不去造（免得凭空多出字段）。
 */
function scrubConfig(cfg, withSecrets) {
  const out = clone(cfg) || {};
  const reset = [];
  const redacted = [];
  for (const [p, v] of RESET) {
    if (!parentOf(out, p) || typeof parentOf(out, p) !== 'object') continue;
    const old = getAt(out, p);
    setAt(out, p, clone(v));
    reset.push({ path: p, from: short(old) });
  }
  if (!withSecrets) {
    walkLeaves(out, (p, k, v) => {
      if (!SECRET_KEY.test(k)) return;
      if (v === undefined || v === null || v === '') return;
      setAt(out, p, '');
      redacted.push({ path: p, len: String(v).length });
    });
  }
  return { config: out, reset, redacted };
}

function scrubProject(pj) {
  const out = clone(pj) || {};
  for (const p of PROJECT_DROP) delAt(out, p);
  const reset = [];
  for (const p of PROJECT_RESET) {
    if (!parentOf(out, p) || typeof parentOf(out, p) !== 'object') continue;
    const old = getAt(out, p);
    setAt(out, p, '');
    reset.push({ path: p, from: short(old) });
  }
  // 条目里的绝对路径：items[].dir / items[].absDir、publish.rows[].dir
  const rows = Array.isArray(out.items) ? out.items : [];
  for (const it of rows) { if (it && it.dir !== undefined) it.dir = ''; if (it && it.absDir !== undefined) it.absDir = ''; }
  const pr = (out.publish && Array.isArray(out.publish.rows)) ? out.publish.rows : [];
  for (const r of pr) if (r && r.dir !== undefined) r.dir = '';
  return { project: out, reset };
}

/* ----------------------------------------------------------------- 命令 */

function cmdInspect() {
  const UD = userDataDir();
  console.log('=== userData ===');
  console.log(UD);
  console.log('');
  const files = ['config.json', 'project.json', 'auth.json', 'pool.json', 'cloud-sync.json', '.updaterId'];
  console.log('=== 文件 ===');
  for (const f of files) {
    const s = statSize(path.join(UD, f));
    console.log('  ' + (s === null ? '  (无) ' : String(humanSize(s)).padStart(7) + ' ') + '  ' + f);
  }
  const cf = readJson(path.join(UD, 'config.json'));
  if (!cf.ok) { console.log('\nconfig.json 读不到：' + cf.error); return 0; }
  const c = cf.value;
  console.log('');
  console.log('=== 关键现状（密钥只报有无）===');
  const keys = [];
  walkLeaves(c, (p, k, v) => { if (SECRET_KEY.test(k)) keys.push(p + ' = ' + (v ? '有（' + String(v).length + ' 字符）' : '空')); });
  for (const k of keys) console.log('  密钥  ' + k);
  console.log('  projectName     ' + JSON.stringify(c.projectName));
  console.log('  publish.mock    ' + (c.publish ? JSON.stringify(c.publish.mock) : '（读不到）')
    + (c.publish && c.publish.mock === true ? '   ★ 干跑模式：不会真发' : ''));
  const um = (c.publish && c.publish.uiMap) || null;
  console.log('  uiMap           步骤 ' + (um && Array.isArray(um.steps) ? um.steps.length : 0) + ' 步图文 / '
    + (um && Array.isArray(um.videoSteps) ? um.videoSteps.length : 0) + ' 步视频'
    + (um && um.generatedAt ? '（' + new Date(um.generatedAt).toLocaleString() + '）' : '（无）'));
  console.log('  cloud.machineId ' + JSON.stringify(c.cloud && c.cloud.machineId));
  console.log('  品牌数          ' + ((c.brands && c.brands.length) || 0));
  console.log('  paths            ' + JSON.stringify(c.paths));
  console.log('  设备            device=' + JSON.stringify(c.publish && c.publish.device)
    + '  devices=' + ((c.publish && c.publish.devices && c.publish.devices.length) || 0) + ' 个');
  return 0;
}

function cmdExport() {
  const UD = userDataDir();
  const src = path.join(UD, 'config.json');
  const cf = readJson(src);
  if (!cf.ok) {
    console.error('✖ 读不到 ' + src + '：' + cf.error);
    console.error('  （这台机器上 App 从没启动过？先跑一次 App 再导出。）');
    return 1;
  }
  const withSecrets = flag('--with-secrets');
  const withProject = flag('--with-project');

  const s = scrubConfig(cf.value, withSecrets);
  const bundle = {
    _meta: {
      tool: 'tools/config-portable.js',
      format: FORMAT,
      exportedAt: new Date().toISOString(),
      app: { name: APP, version: pkg.version },
      host: { hostname: os.hostname(), platform: process.platform, user: os.userInfo().username, userData: UD },
      withSecrets: withSecrets,
      reset: s.reset,
      redacted: s.redacted,
      note: withSecrets
        ? '⚠ 这份文件带着明文密钥，属于敏感件：走加密包 / U 盘，别走 git、别走聊天工具明文。'
        : '密钥已剔除（新机在「设置 → 文案」重填）。要连密钥一起搬就重新导出并加 --with-secrets。'
    },
    config: s.config
  };

  let pjInfo = null;
  if (withProject) {
    const pf = readJson(path.join(UD, 'project.json'));
    if (pf.ok) { const p = scrubProject(pf.value); bundle.project = p.project; pjInfo = p.reset; }
  }

  const out = path.resolve(opt('--out', path.join(process.cwd(), 'config-portable-' + wp.stamp() + '.json')));
  writeJsonAtomic(out, bundle);
  const size = statSize(out);

  console.log('=== 导出完成 ===');
  console.log('  文件：' + out + '  (' + humanSize(size) + ')');
  console.log('  来源：' + src);
  console.log('');
  console.log('▸ 已置空（新机会重新生成 / 重选）：' + s.reset.length + ' 项');
  for (const r of s.reset) console.log('    - ' + r.path + '  (原值 ' + r.from + ')');
  if (pjInfo) { console.log('▸ project.json 置空：' + pjInfo.length + ' 项'); for (const r of pjInfo) console.log('    - ' + r.path); }
  console.log('');
  if (withSecrets) {
    console.log('▸ 密钥：**已带上**（' + (s.redacted.length ? '原样保留' : '无') + '）—— 本文件属敏感件');
  } else {
    console.log('▸ 密钥：已剔除 ' + s.redacted.length + ' 项（新机需重填）');
    for (const r of s.redacted) console.log('    - ' + r.path + '  (' + r.len + ' 字符 → 空)');
  }
  const um = (s.config.publish && s.config.publish.uiMap) || null;
  console.log('');
  console.log('▸ 已带走的关键资产：uiMap ' + ((um && um.steps && um.steps.length) || 0) + ' 步图文 / '
    + ((um && um.videoSteps && um.videoSteps.length) || 0) + ' 步视频'
    + ' · 品牌 ' + ((s.config.brands && s.config.brands.length) || 0) + ' 个');
  return 0;
}

function cmdImport() {
  const file = positional(1);
  if (!file) { console.error('✖ 用法：node tools/config-portable.js import <config-portable-*.json> [--yes] [--userdata <dir>]'); return 1; }
  const bf = readJson(path.resolve(file));
  if (!bf.ok) { console.error('✖ 读不到搬运包 ' + file + '：' + bf.error); return 1; }
  const bundle = bf.value;
  if (!bundle || !bundle._meta || bundle._meta.format !== FORMAT || !bundle.config || typeof bundle.config !== 'object') {
    console.error('✖ 这不像本工具导出的搬运包（_meta.format 必须 === ' + FORMAT + '）');
    return 1;
  }

  const UD = userDataDir();
  const target = path.join(UD, 'config.json');
  const found = readJson(target);
  const existing = found.ok ? found.value : null;
  const next = mergeDeep(existing || {}, bundle.config);

  // 密钥保护：搬运包里被标为已剔除的密钥，如果本机**已有**值，就保留本机的（别把能用的密钥抹成空）
  const keptSecrets = [];
  for (const r of (bundle._meta.redacted || [])) {
    const cur = existing ? getAt(existing, r.path) : undefined;
    if (cur !== undefined && cur !== null && cur !== '') {
      setAt(next, r.path, cur);
      keptSecrets.push(r.path);
    }
  }

  console.log('=== 导入计划 ===');
  console.log('  搬运包：' + path.resolve(file));
  console.log('  目标：  ' + target + '  （' + (found.ok ? '已存在 ' + humanSize(statSize(target)) + '，将合并' : '不存在，将新建') + '）');
  console.log('  包来源：' + (bundle._meta.host ? bundle._meta.host.hostname + ' · App ' + (bundle._meta.app && bundle._meta.app.version) : '未知')
    + ' · 导出时间 ' + bundle._meta.exportedAt);
  console.log('');
  console.log('▸ 将写入并置空：' + ((bundle._meta.reset || []).length) + ' 项（这些必须在新机重来）');
  for (const r of (bundle._meta.reset || [])) console.log('    - ' + r.path);
  console.log('▸ 密钥：' + (keptSecrets.length
    ? '保留本机已有的 ' + keptSecrets.join(' / ')
    : (bundle._meta.withSecrets ? '随包带入' : '包内为空 → 新机在「设置 → 文案」重填')));
  const um = (bundle.config.publish && bundle.config.publish.uiMap) || null;
  console.log('▸ 带入的关键资产：uiMap ' + ((um && um.steps && um.steps.length) || 0) + ' 步图文 / '
    + ((um && um.videoSteps && um.videoSteps.length) || 0) + ' 步视频'
    + ' · 品牌 ' + ((bundle.config.brands && bundle.config.brands.length) || 0) + ' 个');
  console.log('');

  const apply = flag('--yes');
  if (!apply) {
    console.log('★ 这是**预演**，一个字节都没写。确认无误后加 --yes 真写。');
    console.log('  node tools/config-portable.js import "' + file + '" --yes');
    return 0;
  }

  try {
    if (found.ok) {
      const bak = path.join(UD, 'config.json.bak-before-portable-' + wp.stampISO());
      fs.copyFileSync(wp.toLong(target), wp.toLong(bak));
      console.log('▸ 原文件已备份：' + bak);
    }
    writeJsonAtomic(target, next);
    console.log('▸ 已写入：' + target);

    if (bundle.project) {
      const pt = path.join(UD, 'project.json');
      const pf = readJson(pt);
      if (pf.ok) {
        const pbak = path.join(UD, 'project.json.bak-before-portable-' + wp.stampISO());
        fs.copyFileSync(wp.toLong(pt), wp.toLong(pbak));
        console.log('▸ project.json 原文件已备份：' + pbak);
      }
      writeJsonAtomic(pt, mergeDeep((pf.ok ? pf.value : {}), bundle.project));
      console.log('▸ 已写入：' + pt);
    }
  } catch (e) {
    console.error('✖ 写入失败：' + ((e && e.message) || e));
    return 1;
  }

  console.log('');
  console.log('=== 新机上还要做（这一步工具替代不了）===');
  console.log('  1) 打开 App，重选**素材目录 / 输出目录 / 隔离目录**（配置里已被清空）');
  console.log('  2) 若密钥被剔除：设置 → 文案，重新填模型 Key');
  console.log('  3) 核对设备：设置里重新「检测设备」（device / devices 是按原样带过来的）');
  console.log('  4) 看一眼 publish.mock —— 搬运过来的值照搬了，别以为在真发');
  console.log('  5) cloud.machineId 已置空 —— **别**手动填旧值：App 启动时会按**这台机器自己的指纹**（Windows MachineGuid）算出来。');
  console.log('     同一台机重算得到**同一个** id（清配置也认得回来）；换到新机得到的是新机自己的 id。');
  console.log('  6) pool.json（商品池）没在搬运范围内 —— 需要就重新导入');
  return 0;
}

/* ------------------------------------------------------------- 往返自测 */

function cmdSelftest() {
  let pass = 0, fail = 0;
  const T = (name, cond, extra) => {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')); }
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-cfg-'));
  const A = path.join(root, 'old');      // 老机器
  const B = path.join(root, 'new');      // 新机器（已有一股配置 + 已有密钥）
  const C = path.join(root, 'bare');     // 新机器（全新）
  for (const d of [A, B, C]) fs.mkdirSync(d, { recursive: true });

  const src = {
    projectName: '蓝V 素材发布',
    paths: { output: 'C:\\Users\\Administrator\\输出\\得物', rejected: 'C:\\Users\\Administrator\\素材\\_rejected', source: 'C:\\Users\\Administrator\\素材' },
    brands: [{ id: 'brd_a', name: 'TW男装', enabled: true, note: '', promptFilter: '', promptWrite: '写文案' }],
    brandsSeeded: true,
    compliance: { requireJpg: true, minSide: 150, enforceMaxSide: false },
    copy: { requiredTopic: '#TW男装', extraTopics: 4, pool: { 品类: ['#OOTD'] }, hotwords: null, llm: { enabled: true, apiKey: 'sk-SECRET-abcdefghijklmnopqrstuvwxyz', model: 'deepseek-flash' } },
    verify: { mode: 'local', api: { endpoint: '', apiKey: '' } },
    publish: {
      adbPath: '', ffmpegPath: '', device: 'emulator-5554',
      devices: [{ id: 'd1', name: 'MuMu', serial: 'emulator-5554' }],
      mock: true,
      uiMap: { package: 'com.shizhuang.duapp', generatedAt: 1791011572378, note: 'x', steps: [{ name: 's1' }, { name: 's2' }], videoSteps: [{ name: 'v1' }] }
    },
    window: { bounds: { x: 312, y: 70, width: 996, height: 785 }, maximized: false },
    ui: { theme: 'dark' },
    update: { channel: 'stable' },
    cloud: { enabled: true, url: '', anonKey: '', org: '', machineId: 'm_fb6e1a86', machineName: '', intervalSec: 30 }
  };
  fs.writeFileSync(path.join(A, 'config.json'), JSON.stringify(src, null, 2), 'utf8');

  console.log('=== 自测（目录 ' + root + '）===');
  console.log('-- ① 导出（默认，抹密钥）--');
  const s = scrubConfig(src, false);
  T('machineId 被置空', s.config.cloud.machineId === '');
  T('paths.* 三个都被置空', s.config.paths.output === '' && s.config.paths.rejected === '' && s.config.paths.source === '');
  T('window.bounds 置为 null', s.config.window.bounds === null);
  T('apiKey 被抹掉', s.config.copy.llm.apiKey === '');
  T('redacted 记录了 copy.llm.apiKey', s.redacted.some(r => r.path === 'copy.llm.apiKey'));
  T('空的 verify.api.apiKey 不算「被抹」（没有值就不报）', !s.redacted.some(r => r.path === 'verify.api.apiKey'));
  T('uiMap 图文步骤原样保留（2）', s.config.publish.uiMap.steps.length === 2);
  T('uiMap 视频步骤原样保留（1）', s.config.publish.uiMap.videoSteps.length === 1);
  T('uiMap.generatedAt 原样保留', s.config.publish.uiMap.generatedAt === 1791011572378);
  T('品牌原样保留', s.config.brands.length === 1 && s.config.brands[0].name === 'TW男装');
  T('话题池原样保留', s.config.copy.pool.品类.length === 1);
  T('设备清单原样保留', s.config.publish.devices.length === 1);
  T('cloud.anonKey **不**被当密钥抹（公开设计）', getAt(s.config, 'cloud.anonKey') === '');
  T('原对象没被就地改动（src 里 machineId 还在）', src.cloud.machineId === 'm_fb6e1a86');

  console.log('-- ② 导出（--with-secrets）--');
  const sw = scrubConfig(src, true);
  T('带密钥时 apiKey 原样保留', sw.config.copy.llm.apiKey === src.copy.llm.apiKey);
  T('带密钥时 redacted 为空', sw.redacted.length === 0);
  T('带密钥时 machineId 仍然被置空（安全项与密钥是两回事）', sw.config.cloud.machineId === '');

  console.log('-- ③ 导入进「全新」目录 --');
  const bundle = {
    _meta: { tool: 'x', format: FORMAT, exportedAt: 't', app: { name: APP, version: '0' }, host: { hostname: 'h' }, withSecrets: false, reset: s.reset, redacted: s.redacted },
    config: s.config
  };
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf8');
  const nextNew = mergeDeep({}, bundle.config);
  writeJsonAtomic(path.join(C, 'config.json'), nextNew);
  const gotC = readJson(path.join(C, 'config.json')).value;
  T('新机配置已生成', !!gotC);
  T('新机 machineId 为空（App 会自己生成）', gotC.cloud.machineId === '');
  T('新机 paths 为空 → 必须重选', gotC.paths.output === '');
  T('新机 uiMap 完整（2+1 步）', gotC.publish.uiMap.steps.length === 2 && gotC.publish.uiMap.videoSteps.length === 1);
  T('新机 apiKey 为空 → 需重填', gotC.copy.llm.apiKey === '');

  console.log('-- ④ 导入进「本机已有一把能用的密钥」的目录：不许被抹空 --');
  fs.writeFileSync(path.join(B, 'config.json'), JSON.stringify({ copy: { llm: { apiKey: 'sk-MINE-working-key' }, concurrency: 6 }, ui: { theme: 'light' } }, null, 2), 'utf8');
  const ex = readJson(path.join(B, 'config.json')).value;
  const nx = mergeDeep(ex, bundle.config);
  const kept = [];
  for (const r of bundle._meta.redacted) {
    const cur = getAt(ex, r.path);
    if (cur !== undefined && cur !== null && cur !== '') { setAt(nx, r.path, cur); kept.push(r.path); }
  }
  T('本机已有密钥被保住', nx.copy.llm.apiKey === 'sk-MINE-working-key');
  T('kept 清单记下了这一项', kept.includes('copy.llm.apiKey'));
  T('同时带入了包里的业务配置（品牌）', nx.brands && nx.brands.length === 1);
  T('同时带入了包里的 uiMap', nx.publish.uiMap.steps.length === 2);
  T('包里的业务配置照常合并进本机（ui.theme 会被包里的 dark 覆盖，属预期）', nx.ui.theme === 'dark');

  console.log('-- ⑤ project.json 清洗 --');
  const pj = {
    sourceDir: 'C:\\Users\\Administrator\\Desktop\\1005',
    flatDir: 'C:\\x\\flat',
    items: [{ id: 'i1', dir: 'C:\\x\\a', absDir: 'C:\\x\\a', sku: 'S1' }],
    sheet: { file: 'C:\\out\\发布单.xlsx', rowCount: 3 },
    publish: { rows: [{ seq: 1, dir: 'C:\\x\\a', status: 'ok' }], reportFile: 'C:\\x\\r.xlsx', probe: { serial: 'emulator-5554', adbPath: 'D:\\bluevbeta\\adb.exe' } },
    copyRows: [{ id: 'c1', title: 'T', body: 'B' }]
  };
  const sp = scrubProject(pj);
  T('sourceDir/flatDir 置空', sp.project.sourceDir === '' && sp.project.flatDir === '');
  T('items[].dir/absDir 置空', sp.project.items[0].dir === '' && sp.project.items[0].absDir === '');
  T('publish.probe 被丢弃', sp.project.publish.probe === undefined);
  T('publish.rows[].dir 置空', sp.project.publish.rows[0].dir === '');
  T('文案行（copyRows）原样保留', sp.project.copyRows.length === 1 && sp.project.copyRows[0].body === 'B');
  T('sku 等业务字段保留', sp.project.items[0].sku === 'S1');

  console.log('');
  console.log('=== 自测结果：' + pass + ' PASS / ' + fail + ' FAIL ===');
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 临时目录，清不掉无妨 */ }
  return fail ? 2 : 0;
}

/* ------------------------------------------------------------------ 入口 */

function main() {
  switch (CMD) {
    case 'inspect': return cmdInspect();
    case 'export': return cmdExport();
    case 'import': return cmdImport();
    case 'selftest': return cmdSelftest();
    default:
      console.log('配置搬运工具（换机 / 交接用）');
      console.log('');
      console.log('  node tools/config-portable.js inspect                               看本机现状（只读）');
      console.log('  node tools/config-portable.js export --out cfg.json                 导出（默认抹掉密钥）');
      console.log('  node tools/config-portable.js export --out cfg.json --with-secrets --with-project');
      console.log('  node tools/config-portable.js import cfg.json                       预演（不写盘）');
      console.log('  node tools/config-portable.js import cfg.json --yes                 真写（先备份）');
      console.log('  node tools/config-portable.js selftest                              往返自测');
      console.log('');
      console.log('通用：--userdata <dir>  指定 userData 目录（默认 %APPDATA%\\' + APP + ' 之类）');
      return CMD ? 1 : 0;
  }
}

process.exit(main());
