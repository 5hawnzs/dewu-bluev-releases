'use strict';
/**
 * 项目功能可视化文档 · 生成器
 * ------------------------------------------------------------------
 * 用法：
 *   node docs/visual/build.js              # 用现有数据重新生成 index.html
 *   node docs/visual/build.js --run        # 先真跑一次 tools/run-all.js 取回逐套断言数，再生成
 *   node docs/visual/build.js --snapshot <file>
 *                                          # 用一份已保存的 run-all 输出（txt）里的数字，不重跑
 *   node docs/visual/build.js --snapshot <file> --save-record
 *                                          # 顺手把这次读到的数字存成 regression.json（下次不带参数也用得上）
 *
 * 设计原则（与仓库的硬约束一致）：
 *   1. **能自动读的一律自动读**（版本号 / 页签 / IPC 通道 / 文件行数 / 套件清单 / git 版本线 / 内置二进制），
 *      人工只维护「口径说明」这类读不出来的东西（见下面 CURATED）。
 *   2. **读不到就写「—」，绝不编数字**。回归断言数只在真跑过或给了快照时才显示数字，
 *      并明确标出来源与时间（kind = live / snapshot / recorded / none）。
 *   3. 只读工程，不写工程里的任何既有文件；产物只有本目录下的 index.html 与 data.json。
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = __dirname;
const NOW = new Date();

// ==================================================================
// 一、人工维护的内容（源码里读不出来的「口径」）
//    改这部分不用碰渲染代码；每条数字都要能在仓库里找到出处。
// ==================================================================

/** 六段流水线：产物与关键口径 */
const PIPELINE = [
  {
    id: 'flatten', tab: 1, name: '素材整理', sub: '建扁平副本',
    out: '扁平副本目录（原素材不动）',
    key: [
      '先秒级出「待整理清单」（只读元数据），再后台建扁平副本',
      '扁平名用连接符把原层级接起来：<code>8124MT_UWG450159+灰色+达人昵称_1</code>',
      '原素材 <b>不改名、不移动</b>，只建副本',
      '同卷优先硬链接（实测 1692 个 &lt; 2 秒），跨卷自动退化为实体复制',
      '目录被占用（网盘/看图软件）指数退避重试；非法字符 <code>&lt; &gt; : " | ? *</code> 替换为 <code>_</code>'
    ]
  },
  {
    id: 'compliance', tab: 2, name: '合规检查', sub: '判定与处理分离',
    out: '合规报告 xlsx（汇总 + 明细）+ csv',
    key: [
      '图片必须 JPG；<b>边长与体积都只卡下限</b>（上限能力保留，开关 <code>enforceMaxSide</code> / <code>enforceMaxMB</code> 默认关）',
      '边长低于下限 ⇒ 判「需更换图片」交人工（<b>不会</b>标成「等比缩放」—— 缩放函数只缩不放）',
      '垃圾文件隔离到 <code>_rejected</code> 而<b>不是删除</b>；判定与处理分离，只处理可自动项',
      '视频必须 mp4 且 &lt; 600 秒；非 mp4 自动转（先无损转封装、再转码兜底，内置 ffmpeg）',
      '超时长<b>只标红不裁剪</b>（裁剪会改变内容，可能被判非原创）',
      '支持「检查父目录」：每个子文件夹独立出一份报告并分组展示'
    ]
  },
  {
    id: 'copy', tab: 3, name: '文案生成', sub: '看图写，成句不成标签',
    out: '<code>&lt;品牌&gt;_AI内容报告_&lt;时间戳&gt;.xlsx</code>',
    key: [
      '把这一条素材的前几张实拍图<b>真的发给模型</b>（缩到 imageMaxSide、JPEG base64、不落盘）',
      '标题＝产品词 + 热门词，<b>写成一句念得通的话</b>；<code>+</code> 一个字都不许出现',
      '10 种句式骨架 T01~T10 按行轮换，每条骨架自带连接字或收尾（结构性防病句）',
      '正文＝<b>4~5 行短句</b>（一行 8~16 字），全篇 1~3 个 emoji 放行尾',
      '话题＝必带话题 + 品牌提示词里的 <code>#话题</code>，逐行进正文末尾的格子',
      '连不上就停下报错，<b>绝不拿本地模板冒充 AI 文案</b>'
    ]
  },
  {
    id: 'verify', tab: 4, name: '货号颜色校验', sub: '只拦「多色漏填」',
    out: '逐行结论（一致 / 告警 / 拦截）',
    key: [
      '取色来源两种：本地商品池（CSV/TSV/JSON）或接口查询（endpoint + SKU APIKey）',
      '结论口径：颜色匹配 / 单色货号颜色可空 / 多色须指定 / 货号未查到颜色信息',
      '额外用图片实取主色反查目录里填的色名（目录写「冠军白」但图是黑的会被抓出来）',
      '★ 只有「<b>多色货号没填颜色</b>」会拦住发布；查不到、颜色不符都只告警、照常发布'
    ]
  },
  {
    id: 'sheet', tab: 0, name: '发布单 / 导入', sub: '26 列 xlsx 闭环',
    out: '发布单 xlsx（26 列，结果回写 B/C 列）',
    key: [
      '导出 26 列，校验未通过的整行标红；也能把「AI 内容报告」反向导入当发布单',
      '★ 独立的「发布单」页签已删除（与「模拟器发布」高度重复）⇒ 导出/导入入口都在<b>「模拟器发布」页</b>',
      '叶子文件夹名写 <code>货号+颜色</code> ⇒ 报告里空着的货号/颜色自动补齐并<b>写回报告文件</b>',
      '只补空格子；报告值与目录对不上时不补（宁缺勿错）；名字不合法时不猜、点名让人改',
      '回写时 Excel 被 WPS 占用 ⇒ 整批暂存 <code>pending-results.json</code>，下次先补写'
    ]
  },
  {
    id: 'publish', tab: 6, name: '模拟器发布', sub: '真实通道 / 模拟通道',
    out: 'publish-log.jsonl + 截图 + 结果回写',
    key: [
      '真实通道（adb + uiautomator）与模拟通道（mock）两条，界面顶部一眼可见当前走哪条',
      '发布前按 <b>MediaStore 判据</b>清空相册（得物相册是全盘聚合视图）',
      '中文/含空格文案走 <code>ADB_INPUT_B64</code> 精确通道，<b>input 后必回读</b>校验',
      '点完「提交发布」必须确认<b>真的离开发布流程</b>才算成功；失败先截图再 force-stop',
      '固定/随机间隔 + 倒计时；单条记耗时；失败自动回退到干净起点'
    ]
  }
];

/** 10 个页签的功能地图（编号与 index.html 的 data-tab 一一对应） */
const PAGES = [
  { tab: 1, group: '生产', name: '素材整理', icon: 'folder', admin: false, act: ['选择目录', '生成清单', '开始整理'],
    brief: '秒级清单 + 后台扁平副本。原素材完全不动。' },
  { tab: 2, group: '生产', name: '合规检查', icon: 'shield', admin: false, act: ['检查父目录', '开始检查', '导出报告', '处理可自动项'],
    brief: '判定与处理分离：先出报告，只处理有问题的那批。' },
  { tab: 3, group: '生产', name: '文案生成', icon: 'pen', admin: false, act: ['提示词配置', '选择素材目录并启动任务', '按当前素材生成'],
    brief: '看图写文案；标题成句、正文 4~5 行；跑完落带时间戳的报告。' },
  { tab: 4, group: '生产', name: '货号颜色校验', icon: 'grid', admin: false, act: ['同步商品池', '开始校验'],
    brief: '商品池或接口取色，主色反查；只有「多色漏填」拦发布。' },
  { tab: 12, group: '生产', name: '热词库', icon: 'tag', admin: false, adminNote: '非管理员只读',
    act: ['恢复内置', '保存'], brief: '8 类分组 60+ 热词，带 <code>{色}</code> 占位；材质/参数词禁入（那是教模型造假）。' },
  { tab: 6, group: '执行', name: '模拟器发布', icon: 'play', admin: false, act: ['导入 AI 内容报告', '导出 xlsx', '连接模拟器', '重导出日志', '停止', '开始发布'],
    brief: '发布流程主入口：导入报告 → 选间隔 → 开始发布 → 结果回写。' },
  { tab: 10, group: '执行', name: '运行日志', icon: 'log', admin: false, act: ['清空', '导出日志'],
    brief: '与底部日志栏同一份数据；多出「按级别/关键字筛」与「导出 .log + .jsonl」。' },
  { tab: 7, group: '其他', name: '设置', icon: 'gear', admin: false, act: ['保存'],
    brief: '路径、外部依赖状态、外观（浅/深）、应用更新、账号与安全。' },
  { tab: 8, group: '其他', name: '品牌统计', icon: 'chart', admin: false, act: ['查询', '导出 xlsx', '导出执行日志', '检测输出目录'],
    brief: '按品牌条数/成败/按天频次/执行人；7/30/90 天；「未标品牌」独立成桶。' },
  { tab: 9, group: '其他', name: '品牌与权限', icon: 'key', admin: false, act: [],
    brief: '品牌注册表 + 账号管理 + 逐账号品牌权限 + 默认品牌。' },
  { tab: 11, group: '其他', name: '高级设置', icon: 'sliders', admin: true,
    act: ['保存'], brief: 'UI 定位表 / 失败恢复动作 / 文案模型 / 并发路数 / 货号颜色接口 / adb 与 ffmpeg 路径 / 云端协作。' }
];

/** 绝不许破的硬约束（源自 AGENTS.md §一） */
const REDLINES = [
  { t: '项目目录不许改名 / 移动', d: '配置与构建产物里存的是绝对路径。改名 ⇒ 素材扫不到、发布单回写落到别处。' },
  { t: 'app.js / store.js 不许整文件重写', d: '只许局部替换 —— 这两个文件可能同时有别的会话在改，整文件重写会覆盖别人的在制品。' },
  { t: '每改一处必须跑回归', d: 'node tools/run-all.js。全绿 ≠ 通过：还要答得出「我改掉了哪条判断、哪条断言会变红」。' },
  { t: '注释与界面文案一律中文', d: '含日志文案、错误提示、按钮名。' },
  { t: '不许造假成功', d: '取不到就写「取不到」/「—」，未知 ≠ 0；失败必须说清「缺什么」。' },
  { t: '发布前必须清空设备相册', d: '得物相册是全盘聚合视图 ⇒ 判据是 MediaStore 清空，不是「某个目录为空」。' },
  { t: '自动更新两条红线', d: '绝不自动重启安装（会掐断正在跑的发布）；不在运行时改源地址（地址编译进包）。' },
  { t: '凭据绝不入库', d: '.env 已忽略；service_role / secret key 绝不许写进任何前端文件。' },
  { t: '安装包不进 git', d: '二进制一旦进历史就删不干净 ⇒ 走 Releases / 网盘分发。' }
];

/** 真实通道 vs 模拟通道 */
const CHANNELS = {
  head: ['', '真实通道（adb）', '模拟通道（mock）'],
  rows: [
    ['触发条件', '找得到 adb（手填 &gt; 内置 &gt; PATH）、设备在线、得物包名识别到、uiautomator 可用', '上述任一不满足'],
    ['做什么', '推图到 <code>/sdcard/DCIM/Camera</code> + 触发媒体扫描 → uiautomator dump 抓界面 → 按定位表点击/输入', '只跑流程：节奏、重试、jsonl 追加、Excel 回写'],
    ['失败表现', '报真原因（找不到节点会列出当前可见文本）+ 自动存失败截图', '随机失败，仅用于演练']
  ]
};

/** 发版与更新通道 */
const UPDATE = [
  { k: '源', v: '腾讯云 COS 桶根目录（<code>build.publish</code>，<b>编译进包</b>）' },
  { k: '通道', v: '正式版读 <code>latest.yml</code>、测试版读 <code>beta.yml</code>；<b>共用同一个安装包</b>' },
  { k: '切通道', v: '设置页点一下即可，不用重装；只有管理员能切，普通成员登录时自动收回并落盘' },
  { k: '检查 / 下载 / 安装', v: '全部<b>由用户点</b>：无定时轮询、无自动下载、无自动重启' },
  { k: '安装闸门', v: '有任务在跑时拦住安装（重启会把跑一半的发布掐断，且没有回滚）' },
  { k: '老包清理', v: '每条通道留「当前 + 1 个可回滚历史版本」；清单与认不出的对象永不清' }
];

/** 各层模块的一句话职责（源码里读不出来，源于 README §目录） */
const LAYER_NOTE = {
  'src/main': '主进程：入口、窗口、IPC 白名单、账号、品牌、任务编排、日志总线、自动更新',
  'src/main/services': '业务服务：整理 / 合规 / 文案 / 校验 / 发布单 / 发布 / 设备 / 定位表 / 统计',
  'src/main/util': '工具：Windows 长路径与硬链接、主色反查',
  'src/preload': 'contextBridge（contextIsolation，渲染层无 node 权限）',
  'src/renderer': 'Windows 风格 UI（自绘标题栏 + 左侧页签 + 底部日志栏）'
};

// ==================================================================
// 二、自动采集（只读工程）
// ==================================================================

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function sh(cmd) { try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { return ''; } }
function walk(dir, filter, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p, filter, out); }
    else if (filter(p)) out.push(p);
  }
  return out;
}
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const loc = t => (t ? t.split('\n').length : 0);

/** package.json */
function collectPkg() {
  const j = JSON.parse(read(path.join(ROOT, 'package.json')) || '{}');
  return {
    name: j.name, version: j.version, productName: (j.build && j.build.productName) || j.name,
    description: j.description,
    deps: Object.keys(j.dependencies || {}),
    optionalDeps: Object.keys(j.optionalDependencies || {}),
    devDeps: Object.keys(j.devDependencies || {}),
    publish: ((j.build && j.build.publish) || []).map(p => ({ provider: p.provider, url: p.url, channel: p.channel })),
    targets: (((j.build || {}).win || {}).target || []).map(t => `${t.target}/${(t.arch || []).join(',')}`),
    extraResources: ((j.build || {}).extraResources || []).map(r => ({ from: r.from, to: r.to })),
    asar: !!(j.build && j.build.asar),
    scripts: j.scripts || {}
  };
}

/** git：版本线 + 当前提交 */
function collectGit() {
  const head = sh('git log -1 --format=%h%x09%ad%x09%s --date=short');
  const [hash = '', date = '', subject = ''] = head.split('\t');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  // 未提交改动数：**排除 docs/visual 自身**。
  // ★ 否则这个指标会自指：文档一生成，产物就相对 HEAD 变成「已修改」，
  //   于是它永远显示「工作区有 1 个未提交改动」——而那 1 个就是它自己，纯噪声。ignored 单独记下来。
  const porcelain = sh('git status --porcelain').split('\n').filter(Boolean);
  const selfArtifacts = porcelain.filter(l => l.includes('docs/visual/')).length;
  const dirty = porcelain.length - selfArtifacts;
  const selfDirty = selfArtifacts;
  const raw = sh('git log -200 --format=%h%x09%ad%x09%s --date=short');
  const all = raw.split('\n').filter(Boolean).map(l => {
    const [h, d, s] = l.split('\t');
    return { hash: h, date: d, subject: s || '' };
  });
  // 版本线的**权威源 = package.json 里的 version 字段本身**，不是提交说明。
  // 做法：`git log -p -- package.json`，取每次提交里 version 的「+」行（新值）。
  //   谁把版本号改成了它，那一次就是该版本的落地点；同版本重复出现时保留最先遇到的那次（= 引入它的提交）。
  // ★ 为什么不信提交说明：实测会漏——1.0.12 的说明是 `fix(发布): …` 通篇没版本号；
  //   1.0.2 的版本号写在句尾括号里；1.0.0 / 1.0.1-beta.1 / -beta.2 说明里根本没有版本号。
  //   更糟的是 `docs: 同步 v1.0.2 口径…` 这类**补档**会被误当成发布。
  //   ⇒ 用「说明开头形状」猜出来的版本线，既漏真版本、又混进假版本，两头都不对。
  // ★ 兜底：浅克隆等读不到 package.json diff 时，退回「说明开头形状」的老办法，
  //   并在数据里标 src='subject-heuristic'，让文档能如实说明这份版本线是怎么来的。
  const vline = collectVersions();
  const timeline = vline.list;
  return { hash, date, subject, branch, dirty, selfDirty, timeline, vlineSrc: vline.src, recent: all.slice(0, 12) };
}

/** 版本线：优先读 package.json 的真实版本变更史；读不到才退回提交说明启发式 */
function collectVersions() {
  const raw = sh('git log -p --format=%x01%h%x09%ad%x09%s --date=short -- package.json');
  const seen = new Map();
  if (raw) {
    let cur = null;
    for (const line of raw.split('\n')) {
      if (line.charCodeAt(0) === 1) {
        const [h, d, s] = line.slice(1).split('\t');
        cur = { hash: h, date: d, subject: s || '' };
        continue;
      }
      const m = line.match(/^\+\s*"version":\s*"([^"]+)"/);
      if (m && cur && !seen.has(m[1])) {
        seen.set(m[1], {
          version: m[1], hash: cur.hash, date: cur.date, subject: cur.subject,
          prerelease: /-(alpha|beta|rc)/i.test(m[1])
        });
      }
    }
  }
  if (seen.size) {
    const list = [...seen.values()];
    list.sort((a, b) => cmpVersion(a.version, b.version));
    return { list, src: 'package.json' };
  }
  // 兜底：旧办法（按提交说明开头形状打分）。明确标注来源，文档里会说明。
  const all = sh('git log -200 --format=%h%x09%ad%x09%s --date=short').split('\n').filter(Boolean).map(l => {
    const [h, d, s] = l.split('\t');
    return { hash: h, date: d, subject: s || '' };
  });
  const rankOf = s => /^\s*(发\s*v?\d+\.\d+\.\d+|发版\s*v?\d)/.test(s) ? 4
    : /^\s*(release|chore\(发版\))/i.test(s) ? 3
      : /^\s*发版/.test(s) ? 2
        : /^\s*v\d+\.\d+\.\d+/.test(s) ? 1 : 0;
  const best = new Map();
  for (const c of all) {
    const r = rankOf(c.subject);
    if (!r) continue;
    const m = c.subject.match(/(\d+\.\d+\.\d+)/);
    if (!m) continue;
    if (!best.has(m[1])) best.set(m[1], { version: m[1], hash: c.hash, date: c.date, subject: c.subject, prerelease: false });
  }
  const list = [...best.values()];
  list.sort((a, b) => cmpVersion(a.version, b.version));
  return { list, src: 'subject-heuristic' };
}

/** semver 比较：正式版 > 预览版；数字段逐位比 */
function cmpVersion(a, b) {
  const sp = v => { const [n, pre = ''] = v.split('-'); return { n: n.split('.').map(Number), pre }; };
  const A = sp(a), B = sp(b);
  for (let i = 0; i < 3; i++) { const x = A.n[i] || 0, y = B.n[i] || 0; if (x !== y) return x - y; }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/** 源码：按层统计行数 */
function collectSrc() {
  const files = walk(path.join(ROOT, 'src'), p => /\.(js|html|css)$/.test(p));
  const list = files.map(p => {
    const t = read(p) || '';
    return { path: rel(p), loc: loc(t), bytes: Buffer.byteLength(t, 'utf8'), layer: layerOf(rel(p)) };
  }).sort((a, b) => b.loc - a.loc);
  const byLayer = {};
  for (const f of list) {
    byLayer[f.layer] = byLayer[f.layer] || { files: 0, loc: 0 };
    byLayer[f.layer].files++; byLayer[f.layer].loc += f.loc;
  }
  return { list, byLayer, totalLoc: list.reduce((s, f) => s + f.loc, 0), totalFiles: list.length };
}
function layerOf(p) {
  if (p.startsWith('src/main/services/')) return 'src/main/services';
  if (p.startsWith('src/main/util/')) return 'src/main/util';
  if (p.startsWith('src/main/')) return 'src/main';
  if (p.startsWith('src/preload/')) return 'src/preload';
  if (p.startsWith('src/renderer/')) return 'src/renderer';
  return '其他';
}

/** 页签（渲染层 index.html 的 nav） */
function collectTabs() {
  const html = read(path.join(ROOT, 'src/renderer/index.html')) || '';
  const nav = html.slice(html.indexOf('<nav class="side"'), html.indexOf('</nav>'));
  const out = [];
  let group = '';
  const re = /<div class="grp">([^<]+)<\/div>|<button class="nav" data-tab="(\d+)"([^>]*)>\s*<span class="ic">[\s\S]*?<\/span>\s*<span>([^<]+)<\/span>/g;
  let m;
  while ((m = re.exec(nav))) {
    if (m[1]) { group = m[1].trim(); continue; }
    out.push({ tab: Number(m[2]), group, name: m[4].trim(), admin: /data-admin="1"/.test(m[3] || '') });
  }
  return out;
}

/** IPC 通道（自动判定门禁档位） */
function collectIpc() {
  const src = read(path.join(ROOT, 'src/main/ipc.js')) || '';
  const out = [];
  // ★ 第三段必须用**前瞻**（`(?=…)`）而不是吃掉字符：早先写成 `[\s\S]{0,40}` 直接把紧跟着的
  //   下一条 `ipcMain.handle(...)` 开头吃进了上一条的匹配里，实测少解析 2 条
  //   （auth:create-user / log:history）—— 而且是静默少算。下面用 total 与简单正则互校，不许再静默。
  const re = /ipcMain\.(handle|on)\(\s*'([^']+)'\s*,\s*(?=([\s\S]{0,40}))/g;
  let m;
  while ((m = re.exec(src))) {
    const kind = m[1], channel = m[2], after = m[3] || '';
    let guard = 'open';
    if (/guardAdmin\s*\(/.test(after)) guard = 'admin';
    else if (/guard\s*\(/.test(after)) guard = 'login';
    out.push({ channel, kind, guard, prefix: channel.split(':')[0] });
  }
  const declared = (src.match(/ipcMain\.(handle|on)\(\s*'[^']+'/g) || []).length;
  if (declared !== out.length) {
    process.stderr.write(`⚠️ IPC 解析数目对不上：源码里声明 ${declared} 条，解析出 ${out.length} 条 —— 文档里的接口面数字不可信，请修 build.js\n`);
  }
  const byPrefix = {};
  for (const c of out) {
    byPrefix[c.prefix] = byPrefix[c.prefix] || { count: 0, guards: {} };
    byPrefix[c.prefix].count++;
    byPrefix[c.prefix].guards[c.guard] = (byPrefix[c.prefix].guards[c.guard] || 0) + 1;
  }
  return { list: out, byPrefix, total: out.length, declared };
}

/** 回归套件（列表来自 run-all.js，说明来自它的文件头注释） */
function collectSuites() {
  const src = read(path.join(ROOT, 'tools/run-all.js')) || '';
  const list = [];
  const reg = /\[\s*'([a-z0-9]+)'\s*,\s*'(node|electron)'\s*,\s*\[([^\]]+)\]\s*\]/g;
  let m;
  while ((m = reg.exec(src))) list.push({ name: m[1], kind: m[2], file: (m[3].match(/tools\/[a-z0-9]+\.js/) || [''])[0] });
  const head = src.slice(0, src.indexOf('const { spawnSync }'));
  for (const s of list) {
    const d = new RegExp('\\*\\s+' + s.name + '\\s+(.+)').exec(head);
    s.desc = d ? d[1].trim() : '';
  }
  return list;
}

/** 回归结果：--run 真跑 / --snapshot 读文件 / regression.json 里已核实的记录 */
function collectRegression(argv, suites) {
  const runFlag = argv.includes('--run');
  const sIdx = argv.indexOf('--snapshot');
  const snapFile = sIdx >= 0 ? argv[sIdx + 1] : null;

  if (runFlag) {
    process.stderr.write('▶ 正在真跑 node tools/run-all.js（这会花几分钟）…\n');
    const r = spawnSync(process.execPath, ['tools/run-all.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const parsed = parseRunAll(out);
    if (parsed.total > 0) return { ...parsed, kind: 'live', when: fmtDate(NOW) + ' ' + fmtTime(NOW), note: '由本生成器现场执行 tools/run-all.js 取得' };
    return { suites: {}, total: 0, failedSuites: [], kind: 'none', when: '—', note: '现场执行了 run-all，但没解析到任何 PASS 行' };
  }

  if (snapFile) {
    const t = read(path.resolve(ROOT, snapFile));
    if (t) {
      // ★ 用**本机时区**渲染快照时间：直接写 toISOString() 会显示成 UTC，与本机差 8 小时，
      //   看起来像「凌晨测的」，对不上。
      const st = fs.statSync(path.resolve(ROOT, snapFile));
      const p = parseRunAll(t);
      return { ...p, kind: 'snapshot', when: `${fmtDate(st.mtime)} ${fmtTime(st.mtime)}`, note: '来自快照文件 ' + snapFile };
    }
    return { suites: {}, total: 0, failedSuites: [], kind: 'none', when: '—', note: '快照文件读不到：' + snapFile };
  }

  const jf = path.join(OUT_DIR, 'regression.json');
  const t = read(jf);
  if (t) {
    try {
      const j = JSON.parse(t);
      return {
        suites: j.suites || {}, total: j.total || 0, failedSuites: j.failedSuites || [],
        kind: 'recorded', when: j.when || '—', note: j.note || '来自 docs/visual/regression.json'
      };
    } catch (e) { /* fallthrough */ }
  }
  return { suites: {}, total: 0, failedSuites: [], kind: 'none', when: '—', note: '还没有逐套数字：跑 node docs/visual/build.js --run 或给 --snapshot <file>' };
}

/** 解析 tools/run-all.js 的输出（✅ name PASS n / ❌ name PASS n FAIL m） */
function parseRunAll(text) {
  const suites = {};
  const failedSuites = [];
  const re = /^\s*(✅|❌)\s+([a-z0-9]+)\s+PASS\s+(\d+)(?:\s+FAIL\s+(\d+))?/gm;
  let m;
  let maxTotal = 0;
  while ((m = re.exec(text))) {
    const name = m[2], pass = Number(m[3]), fail = Number(m[4] || 0);
    suites[name] = { pass, fail, ok: m[1] === '✅' && fail === 0 };
    if (fail > 0) failedSuites.push(name);
  }
  const t = /全部通过，共\s+(\d+)\s+项断言/.exec(text) || /通过\s+(\d+)\s+项/.exec(text);
  if (t) maxTotal = Number(t[1]);
  if (!maxTotal) maxTotal = Object.values(suites).reduce((s, v) => s + v.pass, 0);
  return {
    suites, total: maxTotal, failedSuites,
    allGreen: failedSuites.length === 0 && Object.keys(suites).length > 0
  };
}

/** 随包内置的第三方二进制 */
function collectVendor() {
  const map = { adb: 'vendor/adb', adbkeyboard: 'vendor/adbkeyboard', ffmpeg: 'vendor/ffmpeg' };
  const out = [];
  for (const [name, dir] of Object.entries(map)) {
    const abs = path.join(ROOT, dir);
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.isFile()); } catch (e) { continue; }
    let bytes = 0;
    const files = ents.map(e => {
      const sz = fs.statSync(path.join(abs, e.name)).size;
      bytes += sz;
      return { name: e.name, bytes: sz };
    }).sort((a, b) => b.bytes - a.bytes);
    out.push({ name, dir: rel(abs), bytes, files });
  }
  return out;
}

/** 测试套件与源码里出现的关键常量（抓手：只读、失败不算数） */
function collectFacts() {
  const f = {};
  const store = read(path.join(ROOT, 'src/main/store.js')) || '';
  const grab = (key) => { const m = new RegExp(key + '\\s*:\\s*([^,\\n]+)').exec(store); return m ? m[1].trim() : ''; };
  f.maxImageMB = grab('maxImageMB');
  f.imageCount = grab('imageCount');
  f.imageMaxSide = grab('imageMaxSide');
  f.minSide = grab('minSide');
  f.intervalSec = grab('intervalSec');
  f.enforceMaxSide = grab('enforceMaxSide');
  f.logBuffer = /LOG_MAX\s*=\s*(\d+)/.exec(read(path.join(ROOT, 'src/main/logbus.js')) || '');
  f.hotwordGroups = (read(path.join(ROOT, 'src/main/services/hotwords.js')) || '').match(/风格|氛围|色感|场景|人群|季节|情绪|收尾/g) || [];
  return f;
}

// ==================================================================
// 三、渲染
// ==================================================================

const esc = s => String(s == null ? '' : s).replace(/&(?!lt;|gt;|amp;|quot;|#)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';
const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtTime = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** 口径漂移自检：PAGES 里写的页面名 / 按钮名，必须真的还在渲染层里。
 *  改了界面却忘了改这份文档 ⇒ 这里会吵出来（而不是让文档静静地过期）。 */
function checkDrift(tabs, rendererSrc) {
  const warn = [];
  const live = new Set(tabs.map(t => t.name));
  for (const p of PAGES) {
    if (!tabs.some(t => t.tab === p.tab)) warn.push(`页签 ${p.tab}（${p.name}）在渲染层导航里不存在了`);
    for (const a of p.act) if (!rendererSrc.includes(`label: '${a}'`)) warn.push(`页签 ${p.tab}（${p.name}）的按钮「${a}」在 app.js 里找不到了`);
  }
  for (const t of tabs) if (!PAGES.some(p => p.tab === t.tab)) warn.push(`渲染层新页签「${t.name}」(tab ${t.tab}) 还没写进 PAGES`);
  return { warn, liveCount: live.size };
}

function pageByTab(tabs) {
  const m = {};
  for (const t of tabs) m[t.tab] = t;
  return m;
}

function renderKpis(d) {
  const items = [
    { n: 'v' + d.pkg.version, l: '当前版本', s: `${d.git.branch} @ ${d.git.hash}${d.git.dirty ? ' · 工作区有未提交改动 ' + d.git.dirty + ' 个文件' : ' · 工作区干净'}${d.git.selfDirty ? '（文档产物自身未提交，不计入）' : ''}` },
    { n: d.tabs.length, l: '功能页签', s: d.tabs.filter(t => t.admin).length + ' 个仅管理员可见' },
    { n: d.ipc.total, l: 'IPC 通道', s: `${Object.keys(d.ipc.byPrefix).length} 个域 · ${d.ipc.list.filter(c => c.guard === 'admin').length} 条仅管理员` },
    { n: d.src.totalFiles, l: '源码文件', s: `${d.src.totalLoc.toLocaleString('en-US')} 行（js/html/css）` },
    { n: d.suites.length, l: '回归套件', s: d.reg.kind === 'none' ? '断言数：—（未测）' : `${d.reg.total} 项断言（${regKindText(d.reg.kind)}）` },
    { n: fmtBytes(d.vendorBytes), l: '随包内置依赖', s: d.vendor.map(v => v.name).join(' / ') }
  ];
  return items.map(i => `<div class="kpi"><div class="kv">${esc(i.n)}</div><div class="kl">${esc(i.l)}</div><div class="ks">${esc(i.s)}</div></div>`).join('');
}
function regKindText(k) { return { live: '现场实测', snapshot: '快照', recorded: '已核实记录', none: '未测' }[k] || k; }

function renderPipeline(d) {
  const pm = pageByTab(d.tabs);
  const steps = PIPELINE.map((s, i) => {
    const t = pm[s.tab];
    return `<div class="step">
      <div class="snum">${i + 1}</div>
      <div class="sbody">
        <div class="shead"><b>${esc(s.name)}</b><span class="stag">${esc(s.sub)}</span>${t ? `<span class="stab">页签 ${t.tab}</span>` : ''}</div>
        <div class="sout">产物：${s.out}</div>
        <ul>${s.key.map(k => `<li>${k}</li>`).join('')}</ul>
      </div>
    </div>`;
  }).join('<div class="sarrow">→</div>');
  return `<div class="flow">${steps}</div>`;
}

function renderPages(d) {
  const live = pageByTab(d.tabs);
  return PAGES.map(p => {
    const t = live[p.tab];
    const admin = (t && t.admin) || p.admin;
    return `<div class="card page ${admin ? 'adm' : ''}">
      <div class="phead">
        <span class="pico">${icon(p.icon)}</span>
        <span class="pname">${esc(p.name)}</span>
        <span class="pgroup">${esc(t ? t.group : p.group)}</span>
        ${admin ? '<span class="badge adm">仅管理员</span>' : ''}
        ${p.adminNote ? `<span class="badge">${esc(p.adminNote)}</span>` : ''}
        <span class="ptab">tab ${p.tab}</span>
      </div>
      <div class="pbrief">${p.brief}</div>
      ${p.act.length ? `<div class="pact">${p.act.map(a => `<span>${esc(a)}</span>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
}

function renderLayers(d) {
  const order = ['src/main', 'src/main/services', 'src/main/util', 'src/preload', 'src/renderer'];
  const max = Math.max(...order.map(l => (d.src.byLayer[l] || { loc: 0 }).loc));
  return order.filter(l => d.src.byLayer[l]).map(l => {
    const v = d.src.byLayer[l];
    const files = d.src.list.filter(f => f.layer === l);
    return `<div class="layer">
      <div class="lhead"><code>${esc(l)}/</code><span class="lmeta">${v.files} 个文件 · ${v.loc.toLocaleString('en-US')} 行</span></div>
      <div class="lnote">${esc(LAYER_NOTE[l] || '')}</div>
      <div class="lbar"><i style="width:${Math.round(v.loc / max * 100)}%"></i></div>
      <div class="lfiles">${files.slice(0, 12).map(f => `<span title="${esc(f.path)}">${esc(path.basename(f.path))}<b>${f.loc}</b></span>`).join('')}${files.length > 12 ? `<span class="more">+${files.length - 12}</span>` : ''}</div>
    </div>`;
  }).join('');
}

function renderIpc(d) {
  const guards = ['admin', 'login', 'open'];
  const label = { admin: '仅管理员', login: '需登录', open: '免登录（静态/外观/窗口）' };
  const sorted = Object.entries(d.ipc.byPrefix).sort((a, b) => b[1].count - a[1].count);
  const rows = sorted.map(([pfx, v]) => {
    const chans = d.ipc.list.filter(c => c.prefix === pfx);
    return `<div class="ipcrow">
      <div class="ipcl"><code>${esc(pfx)}:*</code><span class="ipcc">${v.count}</span></div>
      <div class="ipcg">${guards.filter(g => v.guards[g]).map(g => `<span class="badge g-${g}">${label[g]} × ${v.guards[g]}</span>`).join('')}</div>
      <div class="ipchn">${chans.map(c => `<span class="chip-i ${c.guard}">${esc(c.channel.split(':').slice(1).join(':'))}</span>`).join('')}</div>
    </div>`;
  }).join('');
  const cnt = g => d.ipc.list.filter(c => c.guard === g).length;
  return `<div class="ipcsum">
      <span class="badge g-admin">仅管理员 ${cnt('admin')}</span>
      <span class="badge g-login">需登录 ${cnt('login')}</span>
      <span class="badge g-open">免登录 ${cnt('open')}</span>
      <span class="dim">门禁在<b>主进程</b>判定，不是前端藏按钮</span>
    </div>${rows}`;
}

function renderRegression(d) {
  const has = d.reg.kind !== 'none' && Object.keys(d.reg.suites).length > 0;
  const max = has ? Math.max(...Object.values(d.reg.suites).map(s => s.pass)) : 1;
  const rows = d.suites.map(s => {
    const r = has ? d.reg.suites[s.name] : null;
    const pass = r ? r.pass : null;
    const pct = pass == null ? 0 : Math.round(pass / max * 100);
    return `<tr class="${r && !r.ok ? 'bad' : ''}">
      <td><code>${esc(s.name)}</code></td>
      <td class="kind">${s.kind === 'electron' ? 'Electron 窗口' : '纯 Node'}</td>
      <td class="desc">${esc(s.desc)}</td>
      <td class="num">${pass == null ? '—' : pass}</td>
      <td class="bar"><i style="width:${pct}%"></i></td>
    </tr>`;
  }).join('');
  const head = has
    ? `<div class="regnum"><b>${d.reg.total}</b> 项断言 · ${d.suites.length} 套 · <span class="${d.reg.allGreen ? 'ok' : 'bad'}">${d.reg.allGreen ? '全绿' : '有 ' + d.reg.failedSuites.length + ' 套没过：' + d.reg.failedSuites.join(' / ')}</span></div>
       <div class="dim">来源：${esc(regKindText(d.reg.kind))} · ${esc(d.reg.when)} · ${esc(d.reg.note)}</div>`
    : `<div class="regnum warn"><b>—</b> 还没有逐套断言数</div><div class="dim">${esc(d.reg.note)}</div>`;
  return `<div class="reghead">${head}
      <div class="regtip">刷新：<code>node docs/visual/build.js --run</code>（真跑一遍，几分钟）</div></div>
    <table class="regtable"><thead><tr><th>套件</th><th>类型</th><th>覆盖</th><th>断言</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTimeline(d) {
  const items = d.git.timeline.slice().reverse();
  if (!items.length) return '<div class="dim">未从 git 历史里识别到版本线。</div>';
  const curV = d.pkg.version;
  return `<div class="tl">${items.map((t, i) => `
    <div class="tli ${t.version === curV ? 'cur' : ''}">
      <div class="tldot"></div>
      <div class="tlv">v${esc(t.version)}${t.version === curV ? '<span class="badge cur">当前</span>' : ''}${t.prerelease ? '<span class="badge">预览版</span>' : ''}</div>
      <div class="tld">${esc(t.date)}</div>
      <div class="tls"><code>${esc(t.hash)}</code> ${esc(t.subject)}</div>
    </div>`).join('')}</div>`;
}

function renderChannels() {
  const [h0, h1, h2] = CHANNELS.head;
  return `<table class="tbl"><thead><tr><th></th><th>${h1}</th><th>${h2}</th></tr></thead><tbody>
    ${CHANNELS.rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}
  </tbody></table>`;
}

function renderVendor(d) {
  return d.vendor.map(v => `<div class="ven">
    <div class="vhead"><b>${esc(v.name)}</b><span class="vbytes">${fmtBytes(v.bytes)}</span></div>
    <div class="vdir"><code>${esc(v.dir)}</code> → <code>resources/${esc(v.name)}/</code></div>
    <div class="vfiles">${v.files.slice(0, 4).map(f => `<span>${esc(f.name)}<b>${fmtBytes(f.bytes)}</b></span>`).join('')}</div>
  </div>`).join('');
}

function icon(name) {
  const m = {
    folder: '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
    shield: '<path d="M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6l7-3z"/>',
    pen: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
    grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
    tag: '<path d="M20 12.5l-7.5 7.5L4 11.5V4h7.5L20 12.5z"/><circle cx="8.6" cy="8.6" r="1.5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10.5 8.8l5 3.2-5 3.2V8.8z"/>',
    log: '<path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.6M12 17.9v2.6M4.9 7.8l2.2 1.3M16.9 14.9l2.2 1.3M4.9 16.2l2.2-1.3M16.9 9.1l2.2-1.3"/>',
    chart: '<path d="M3 21h18"/><rect x="5" y="12" width="3.4" height="6" rx="1"/><rect x="10.3" y="7" width="3.4" height="11" rx="1"/>',
    key: '<circle cx="8.2" cy="12" r="4"/><path d="M12.2 12h8.4M17.6 12v3.2"/>',
    sliders: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.2M12 18.2v2.2M5.4 7.4l1.9 1.1M16.7 15.5l1.9 1.1"/>'
  };
  return `<svg viewBox="0 0 24 24">${m[name] || m.gear}</svg>`;
}

function renderHTML(d) {
  const genTime = fmtDate(NOW) + ' ' + fmtTime(NOW);
  const pkg = d.pkg;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-gen="${genTime}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pkg.productName)} · 功能全景</title>
<style>${CSS}</style>
</head>
<body>
<div class="bg"></div>
<header class="top">
  <div class="brand">
    <span class="logo"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f6e56"/><path d="M9.5 10l6.5 13 6.5-13" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <div><div class="bn">${esc(pkg.productName)}</div><div class="bs">项目功能全景 · 可视化文档</div></div>
  </div>
  <div class="tmeta">
    <span class="pill v">v${esc(pkg.version)}</span>
    <span class="pill">${esc(d.git.branch)} @ ${esc(d.git.hash)}</span>
    <span class="pill">生成于 ${esc(genTime)}</span>
    <span class="pill ${d.git.dirty ? 'warn' : 'ok'}">${d.git.dirty ? '工作区有 ' + d.git.dirty + ' 个未提交改动' : '工作区干净'}</span>
  </div>
</header>

<main>
  <section class="hero">
    <h1>从一堆素材，到一条发出去的动态</h1>
    <p class="lede">${esc(pkg.description || '')}</p>
    <div class="kpis">${renderKpis(d)}</div>
  </section>

  <section id="flow">
    <h2>六段流水线</h2>
    <p class="sub">一个人当天能跑完的一条链路：每一步的产物就是下一步的输入。</p>
    ${renderPipeline(d)}
  </section>

  <section id="pages">
    <h2>功能地图</h2>
    <p class="sub">左侧 ${d.tabs.length} 个页签（数字取自渲染层 index.html 的导航，与实际界面一致）。</p>
    ${d.drift && d.drift.length ? `<div class="drift"><b>⚠️ 口径自检：这份文档可能已经过期</b><ul>${d.drift.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="pages">${renderPages(d)}</div>
  </section>

  <section id="arch">
    <h2>代码结构</h2>
    <p class="sub">共 ${d.src.totalFiles} 个文件 / ${d.src.totalLoc.toLocaleString('en-US')} 行。条长＝该层代码量占比。</p>
    <div class="layers">${renderLayers(d)}</div>
  </section>

  <section id="ipc">
    <h2>接口面 &amp; 权限门禁</h2>
    <p class="sub">通道清单与门禁档位由 src/main/ipc.js 自动解析（共 ${d.ipc.total} 条）。</p>
    <div class="ipc">${renderIpc(d)}</div>
  </section>

  <section id="pub">
    <h2>发布通道：真机 vs 演练</h2>
    <p class="sub">同一条流程代码，两种执行后端；界面顶部一眼可见当前走哪条。</p>
    ${renderChannels()}
    <div class="grid2">
      <div class="card">
        <div class="cardh">更新 &amp; 发版</div>
        <div class="kvlist">${UPDATE.map(u => `<div class="kvrow"><span>${u.k}</span><div>${u.v}</div></div>`).join('')}</div>
        <div class="dim">源：<code>${esc((pkg.publish[0] || {}).url || '—')}</code>（${esc((pkg.publish[0] || {}).provider || '—')}）</div>
      </div>
      <div class="card">
        <div class="cardh">随包内置的外部依赖</div>
        <p class="dim">这些二进制故意进 git：每次打包都必须有，走「构建时下载」会让没网的机器打不出包。</p>
        <div class="vendor">${renderVendor(d)}</div>
      </div>
    </div>
  </section>

  <section id="qa">
    <h2>质量护栏</h2>
    <p class="sub">${d.suites.length} 套回归，入口 <code>node tools/run-all.js</code>。</p>
    ${renderRegression(d)}
  </section>

  <section id="redline">
    <h2>绝不许破的约束</h2>
    <p class="sub">这些不是建议，是踩过坑之后写下来的红线（出处：AGENTS.md §一）。</p>
    <div class="reds">${REDLINES.map((r, i) => `<div class="red"><span class="rn">${i + 1}</span><div><b>${esc(r.t)}</b><p>${esc(r.d)}</p></div></div>`).join('')}</div>
  </section>

  <section id="tl">
    <h2>版本线</h2>
    <p class="sub">权威源：<code>package.json</code> 的 <code>version</code> 字段变更史（共 ${d.git.timeline.length} 个版本）。
      <b>谁把版本号改成它，就是哪一次提交</b> —— 不按提交说明猜，所以不会漏（说明里常不写版本号）也不会把「补档文档」当成发布。
      ${d.git.vlineSrc === 'package.json' ? '' : '<b>⚠ 本次退回「提交说明启发式」，可能不准。</b>'}</p>
    ${renderTimeline(d)}
  </section>

  <footer>
    <h2>这份文档怎么更新</h2>
    <div class="kvlist">
      <div class="kvrow"><span>重新生成</span><div><code>node docs/visual/build.js</code> —— 版本号 / 页签 / 通道 / 行数 / 版本线 全部自动重读</div></div>
      <div class="kvrow"><span>刷新测试数字</span><div><code>node docs/visual/build.js --run</code> 真跑一遍回归；或用 <code>--snapshot &lt;run-all 输出.txt&gt;</code> 读已有结果</div></div>
      <div class="kvrow"><span>改口径说明</span><div>编辑 <code>docs/visual/build.js</code> 顶部的 PIPELINE / PAGES / REDLINES / UPDATE</div></div>
      <div class="kvrow"><span>数据快照</span><div><code>docs/visual/data.json</code> —— 每次生成同时落一份，便于 diff「这次变了什么」</div></div>
    </div>
    <p class="dim">文档里的数字分两类：<b>自动读</b>（版本、页签、通道、行数、套件、版本线、二进制体积）与
    <b>人工核对</b>（流水线口径、红线、页面职责，出处见 README.md / AGENTS.md / docs/HANDOFF.md）。
    读不到的写「—」，不编数字。</p>
  </footer>
</main>
</body>
</html>`;
}

const CSS = `
:root{
  --bg:#080c11; --bg2:#0b1118; --panel:rgba(255,255,255,.035); --panel2:rgba(255,255,255,.055);
  --line:rgba(255,255,255,.09); --line2:rgba(255,255,255,.16);
  --tx:#e8eef4; --tx2:#9fb0c0; --tx3:#6d8194;
  --ac:#22d3a5; --ac2:#38bdf8; --brand:#0f6e56;
  --warn:#f5a524; --bad:#f26d6d; --ok:#3ddc97;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--tx);
  font-family:"Microsoft YaHei UI","微软雅黑",-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--ac2)}
code{font-family:var(--mono);font-size:.86em;background:rgba(255,255,255,.06);border:1px solid var(--line);
  border-radius:4px;padding:.1em .38em;color:#bfe9dc}
b{color:#fff;font-weight:600}
.bg{position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(900px 500px at 12% -5%,rgba(34,211,165,.16),transparent 60%),
    radial-gradient(800px 480px at 88% 0%,rgba(56,189,248,.13),transparent 62%),
    radial-gradient(700px 600px at 50% 110%,rgba(15,110,86,.18),transparent 60%),
    linear-gradient(180deg,#080c11,#070a0e)}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:24px;flex-wrap:wrap;
  padding:14px 30px;backdrop-filter:blur(14px);background:rgba(8,12,17,.78);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:12px}
.logo svg{width:32px;height:32px;border-radius:8px;box-shadow:0 4px 18px rgba(34,211,165,.28)}
.bn{font-size:15px;font-weight:700;letter-spacing:.3px}
.bs{font-size:11.5px;color:var(--tx3);letter-spacing:1.4px}
.tmeta{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.pill{font-size:11.5px;padding:4px 10px;border-radius:999px;border:1px solid var(--line2);color:var(--tx2);background:var(--panel)}
.pill.v{color:#04231b;background:linear-gradient(135deg,var(--ac),#6ee7c0);border-color:transparent;font-weight:700}
.pill.ok{color:var(--ok);border-color:rgba(61,220,151,.3)}
.pill.warn{color:var(--warn);border-color:rgba(245,165,36,.35)}
main{position:relative;z-index:1;max-width:1240px;margin:0 auto;padding:0 30px 90px}
section{margin:56px 0 0;padding-top:8px}
h1{font-size:38px;line-height:1.22;margin:52px 0 10px;font-weight:800;letter-spacing:-.5px;
  background:linear-gradient(100deg,#fff 10%,#8ff0d2 55%,#7dd3fc 95%);-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:19px;margin:0 0 6px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:10px}
h2:before{content:"";width:4px;height:16px;border-radius:2px;background:linear-gradient(180deg,var(--ac),var(--ac2))}
.sub{color:var(--tx3);font-size:12.5px;margin:0 0 20px}
.lede{color:var(--tx2);font-size:14.5px;margin:0 0 26px;max-width:900px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:12px}
.kpi{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:linear-gradient(160deg,var(--panel2),var(--panel));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.kv{font-size:25px;font-weight:800;letter-spacing:-.5px;font-family:var(--mono);
  background:linear-gradient(120deg,#fff,#8ff0d2);-webkit-background-clip:text;background-clip:text;color:transparent}
.kl{font-size:12px;color:var(--tx2);margin-top:4px}
.ks{font-size:11px;color:var(--tx3);margin-top:6px;line-height:1.5}
.flow{display:flex;flex-direction:column;gap:0}
.step{display:flex;gap:16px;border:1px solid var(--line);border-radius:14px;padding:15px 18px;background:var(--panel)}
.sarrow{text-align:center;color:var(--tx3);font-size:14px;padding:5px 0;letter-spacing:6px}
.snum{flex:none;width:28px;height:28px;border-radius:9px;display:grid;place-items:center;font-family:var(--mono);font-weight:700;font-size:13px;
  color:#04231b;background:linear-gradient(135deg,var(--ac),#7ee7c4)}
.sbody{flex:1;min-width:0}
.shead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.shead b{font-size:15px}
.stag{font-size:11.5px;color:var(--tx3)}
.stab{font-size:10.5px;font-family:var(--mono);color:var(--tx2);border:1px solid var(--line2);border-radius:5px;padding:1px 6px}
.sout{font-size:12px;color:var(--tx2);margin:3px 0 8px}
.step ul{margin:0;padding-left:18px;color:var(--tx2);font-size:12.8px}
.step li{margin:3px 0}
.pages{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--panel)}
.page.adm{border-color:rgba(245,165,36,.3);background:linear-gradient(160deg,rgba(245,165,36,.06),var(--panel))}
.phead{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.pico svg{width:16px;height:16px;fill:none;stroke:var(--ac);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;display:block}
.pname{font-weight:700;font-size:14.5px}
.pgroup{font-size:10.5px;color:var(--tx3);border:1px solid var(--line2);border-radius:5px;padding:1px 6px}
.ptab{font-size:10.5px;font-family:var(--mono);color:var(--tx3);margin-left:auto}
.badge{font-size:10.5px;padding:2px 7px;border-radius:999px;border:1px solid var(--line2);color:var(--tx2);background:rgba(255,255,255,.04)}
.badge.adm{color:var(--warn);border-color:rgba(245,165,36,.4)}
.badge.cur{color:var(--ac);border-color:rgba(34,211,165,.4)}
.badge.g-admin{color:var(--warn);border-color:rgba(245,165,36,.35)}
.badge.g-login{color:#7dd3fc;border-color:rgba(56,189,248,.3)}
.badge.g-open{color:var(--tx3)}
.pbrief{color:var(--tx2);font-size:12.5px;margin:9px 0 0}
.pact{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.pact span{font-size:11px;color:var(--tx2);border:1px solid var(--line);border-radius:7px;padding:2px 8px;background:rgba(255,255,255,.03)}
.layers{display:flex;flex-direction:column;gap:14px}
.layer{border:1px solid var(--line);border-radius:14px;padding:14px 18px;background:var(--panel)}
.lhead{display:flex;align-items:baseline;gap:12px}
.lhead code{background:none;border:none;color:var(--ac);font-size:13.5px;padding:0}
.lmeta{font-size:11.5px;color:var(--tx3);margin-left:auto}
.lnote{font-size:12.3px;color:var(--tx2);margin:4px 0 9px}
.lbar{height:5px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden}
.lbar i{display:block;height:100%;background:linear-gradient(90deg,var(--ac),var(--ac2));border-radius:3px}
.lfiles{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.lfiles span{font-size:11px;font-family:var(--mono);color:var(--tx2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;display:inline-flex;gap:6px;align-items:center}
.lfiles b{color:var(--tx3);font-weight:400;font-size:10.5px}
.lfiles .more{color:var(--tx3)}
.ipcsum{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.dim{color:var(--tx3);font-size:11.5px}
.ipcrow{display:grid;grid-template-columns:150px 210px 1fr;gap:12px;align-items:start;
  border-top:1px solid var(--line);padding:11px 0}
.ipcrow:first-of-type{border-top:none}
.ipcl code{background:none;border:none;color:var(--ac);padding:0;font-size:13px}
.ipcc{font-size:11px;color:var(--tx3);margin-left:8px;font-family:var(--mono)}
.ipcg{display:flex;flex-wrap:wrap;gap:5px}
.ipchn{display:flex;flex-wrap:wrap;gap:5px}
.chip-i{font-family:var(--mono);font-size:10.8px;color:var(--tx2);border:1px solid var(--line);border-radius:5px;padding:1px 6px;background:rgba(255,255,255,.03)}
.chip-i.admin{border-color:rgba(245,165,36,.3);color:#f7c977}
.chip-i.login{border-color:rgba(56,189,248,.22)}
table.tbl{width:100%;border-collapse:collapse;border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:12.6px}
table.tbl th,table.tbl td{padding:11px 14px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
table.tbl thead th{background:rgba(255,255,255,.05);color:var(--tx);font-size:12px;font-weight:600}
table.tbl tbody th{color:var(--tx2);font-weight:500;width:130px;background:rgba(255,255,255,.02)}
table.tbl tbody tr:last-child th,table.tbl tbody tr:last-child td{border-bottom:none}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.cardh{font-weight:700;font-size:14px;margin-bottom:10px}
.kvlist{display:flex;flex-direction:column;gap:9px}
.kvrow{display:grid;grid-template-columns:120px 1fr;gap:10px;font-size:12.4px;color:var(--tx2)}
.kvrow>span{color:var(--tx3);font-size:12px}
.vendor{display:flex;flex-direction:column;gap:11px;margin-top:10px}
.ven{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:rgba(255,255,255,.02)}
.vhead{display:flex;align-items:center;gap:10px}
.vbytes{margin-left:auto;font-family:var(--mono);font-size:11.5px;color:var(--ac)}
.vdir{font-size:11.4px;color:var(--tx3);margin:5px 0 7px}
.vdir code{font-size:11px}
.vfiles{display:flex;flex-wrap:wrap;gap:6px}
.vfiles span{font-size:10.8px;font-family:var(--mono);color:var(--tx2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;display:inline-flex;gap:6px}
.vfiles b{color:var(--tx3);font-weight:400}
.reghead{margin-bottom:12px}
.regnum{font-size:15px;color:var(--tx2)}
.regnum b{font-size:22px;font-family:var(--mono);color:#fff;margin-right:6px}
.regnum .ok{color:var(--ok)}.regnum .bad{color:var(--bad)}.regnum.warn b{color:var(--warn)}
.regtip{margin-top:6px;font-size:11.5px;color:var(--tx3)}
table.regtable{width:100%;border-collapse:collapse;font-size:12.3px}
table.regtable th{text-align:left;font-size:11px;color:var(--tx3);font-weight:500;padding:6px 10px;border-bottom:1px solid var(--line2)}
table.regtable td{padding:8px 10px;border-bottom:1px solid var(--line);color:var(--tx2);vertical-align:middle}
table.regtable tr.bad td{background:rgba(242,109,109,.07)}
table.regtable code{background:none;border:none;color:var(--ac);padding:0}
td.kind{color:var(--tx3);font-size:11.5px;white-space:nowrap}
td.num{font-family:var(--mono);color:#fff;text-align:right;width:70px}
td.bar{width:180px}
td.bar i{display:block;height:5px;border-radius:3px;background:linear-gradient(90deg,var(--ac),var(--ac2))}
.reds{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:11px}
.red{display:flex;gap:12px;border:1px solid rgba(242,109,109,.2);border-radius:13px;padding:13px 16px;
  background:linear-gradient(160deg,rgba(242,109,109,.05),var(--panel))}
.rn{flex:none;width:22px;height:22px;border-radius:7px;display:grid;place-items:center;font-family:var(--mono);font-size:11.5px;
  color:#2a0d0d;background:linear-gradient(135deg,#f7a0a0,#f26d6d);font-weight:700}
.red b{font-size:13px}
.red p{margin:3px 0 0;font-size:12.2px;color:var(--tx2)}
.drift{border:1px solid rgba(245,165,36,.35);background:rgba(245,165,36,.07);border-radius:12px;padding:12px 16px;margin:0 0 14px}
.drift b{color:var(--warn);font-size:12.5px}
.drift ul{margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--tx2)}
.tl{position:relative;padding-left:22px}
.tl:before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:1px;background:var(--line2)}
.tli{position:relative;padding:9px 0;display:grid;grid-template-columns:124px 92px 1fr;gap:12px;align-items:baseline}
.tldot{position:absolute;left:-21px;top:15px;width:9px;height:9px;border-radius:50%;background:var(--tx3)}
.tli.cur .tldot{background:var(--ac);box-shadow:0 0 0 4px rgba(34,211,165,.16)}
.tlv{font-family:var(--mono);font-weight:700;color:#fff}
.tld{font-size:11.5px;color:var(--tx3);font-family:var(--mono)}
.tls{font-size:12px;color:var(--tx2)}
footer{margin-top:64px;border-top:1px solid var(--line);padding-top:26px}
footer .dim{margin-top:16px;line-height:1.7;max-width:900px}
@media(max-width:900px){
  .grid2{grid-template-columns:1fr}
  .ipcrow{grid-template-columns:1fr;gap:6px}
  h1{font-size:29px}
}
`;

// ==================================================================
// 四、主流程
// ==================================================================

function main() {
  const argv = process.argv.slice(2);
  const pkg = collectPkg();
  const git = collectGit();
  const src = collectSrc();
  const tabs = collectTabs();
  const ipc = collectIpc();
  const suites = collectSuites();
  const reg = collectRegression(argv, suites);
  const vendor = collectVendor();
  const facts = collectFacts();
  const drift = checkDrift(tabs, read(path.join(ROOT, 'src/renderer/app.js')) || '');
  for (const w of drift.warn) process.stderr.write(`⚠️ 文档口径可能过期：${w}\n`);

  const d = {
    generatedAt: NOW.toISOString(),
    pkg, git, src, tabs, ipc, suites, reg, vendor, facts,
    drift: drift.warn,
    vendorBytes: vendor.reduce((s, v) => s + v.bytes, 0)
  };

  const html = renderHTML(d);
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  // --save-record：把这次读到的回归数字落成 regression.json（下次不带任何参数也用它）
  if (argv.includes('--save-record') && reg.kind !== 'none') {
    fs.writeFileSync(path.join(OUT_DIR, 'regression.json'), JSON.stringify({
      when: reg.when,
      total: reg.total,
      failedSuites: reg.failedSuites || [],
      note: reg.note + '（由 build.js --save-record 写入）',
      suites: reg.suites
    }, null, 2), 'utf8');
    console.log(`📌 已记录回归数字到 docs/visual/regression.json（${reg.total} 项 / ${reg.when}）`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'data.json'), JSON.stringify({
    generatedAt: d.generatedAt, version: pkg.version, commit: git.hash, branch: git.branch, dirty: git.dirty,
    tabs: tabs.map(t => ({ tab: t.tab, name: t.name, group: t.group, admin: t.admin })),
    ipcTotal: ipc.total, ipcByGuard: {
      admin: ipc.list.filter(c => c.guard === 'admin').length,
      login: ipc.list.filter(c => c.guard === 'login').length,
      open: ipc.list.filter(c => c.guard === 'open').length
    },
    src: { files: src.totalFiles, loc: src.totalLoc, byLayer: src.byLayer },
    suites: suites.map(s => s.name),
    regression: { kind: reg.kind, when: reg.when, total: reg.total, allGreen: reg.allGreen, suites: reg.suites },
    vendor: vendor.map(v => ({ name: v.name, bytes: v.bytes })),
    vendorBytes: vendor.reduce((s, v) => s + v.bytes, 0),
    timelineSrc: git.vlineSrc,
    timeline: git.timeline
  }, null, 2), 'utf8');

  console.log(`✅ 已生成 docs/visual/index.html`);
  console.log(`   ${pkg.productName} v${pkg.version} · ${git.branch}@${git.hash}${git.dirty ? ` · 工作区有 ${git.dirty} 个未提交改动` : ' · 工作区干净'}`);
  console.log(`   页签 ${tabs.length} · IPC ${ipc.total}（仅管理员 ${d.ipc.list.filter(c => c.guard === 'admin').length}） · 源码 ${src.totalFiles} 文件/${src.totalLoc} 行 · 套件 ${suites.length}`);
  console.log(`   回归数字：${reg.kind} ${reg.total || '—'} 项（${reg.when}）`);
  console.log(`   内置依赖 ${fmtBytes(d.vendorBytes)} · 版本线 ${git.timeline.length} 个`);
}

main();
