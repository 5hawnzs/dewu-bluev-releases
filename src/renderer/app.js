'use strict';
/* 渲染层：只做展示与交互，数据一律走 window.api（preload 暴露的白名单通道） */
const $ = s => document.querySelector(s);
const appApi = window.api;

const state = {
  tab: 1,
  project: null,
  config: null,
  info: null,
  plan: null,
  jobs: [],           // 运行中的任务：可同时有多个批次，每个实例独立 id / 进度 / 日志标签
  batchDetail: null,  // 「查看详情」正在展开哪个批次的日志
  publishRowTick: 0,
  auth: null,         // {requireLogin, user, isAdmin, defaultHint}
  users: null,        // 管理员可见的账号列表
  myId: null,
  brandsMeta: null,   // { isAdmin, brands:[{id,name,enabled}], mine:[id], defaultBrandId }
  brandId: '',        // 标题栏那个「当前品牌」的值；产出类任务都带上它，主进程还会再校验一次权限
  stats: null,        // 品牌统计查询结果
  statsOpts: { days: 30, brandId: '', userId: '' },
  statsBusy: false,
  statsPath: null,    // 输出目录可写性自检结果（{ ok, dir, checks[], error }）
  brandEdit: null,    // 正在改名的品牌 { id, name }
  // 账号操作弹窗：null=关着；{view:'perm'|'pwd', id} —— 配置某个账号的品牌权限 / 重置他的密码
  userModal: null,
  // 文案提示词弹窗：null=关着；{view:'list'} 品牌列表；{view:'edit', id} 编辑某个品牌（id 为空串 = 新增）
  brandModal: null,
  // 「说明书」弹窗：null=关着；'copy'=批次设置说明 / 'publish'=装置与节奏说明（2026-10-03 新增）
  helpModal: null,
  // 「模型配置」弹窗（2026-10-08）：null=关着；开着时是
  //   { eff, models, listErr, picked, busy } —— eff=当前生效值（llm:effective），
  //   models=拉回来的清单，picked=刚点中的那个模型 id（保存才落盘）。
  modelModal: null,
  upd: null,          // 应用更新状态（来自主进程）null=还没读到
  logs: [],           // ★ 运行日志只有这一份数据：底部日志栏与左侧「运行日志」页都读它
  logFilter: { level: '', q: '' },   // 「运行日志」页的筛选（只影响这一页，不动底部日志栏）
  logExport: null,    // 上一次导出结果 { file, jsonFile, count }，用来给「打开 / 定位」按钮指路
  logExportErr: '',   // 上一次导出的失败原因（失败要说出来，不能只在 toast 里一闪而过）
  devStatus: null,    // 「扫描设备」逐台结果 { serial: {...} }，null = 还没扫过
  devFound: null,     // 「扫描设备」时 adb 认到的**全部**设备（含还没加进列表的），null = 还没扫过
  lex: null,          // 热词库快照（主进程 hotwords:get 的返回）；null = 还没读到
  lexBusy: false,
  lexTried: false,    // 读失败过就不再自动重试（否则 render → load → render 会打转）
  lexDirty: false,    // 界面上改了但还没点「保存」
  // 得物安装包：点过「装进模拟器」且**设备上本来就有**时置 true ——
  // 只有这时才在设置页那一行多挂一枚「覆盖重装」按钮（用户没点过之前不给这个危险入口）
  dewuAlready: false
};

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function kb(b) { return b == null ? '—' : (b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB'); }
function n(v) { return v == null ? 0 : v; }
let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, kind === 'err' ? 5200 : 3000);
}
function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}
function badge(text, kind) { return `<span class="b b-${kind || 'wait'}">${esc(text)}</span>`; }

const STATUS_KIND = {
  // ★ '模拟成功' 必须显式列出来：kindOf 的兜底规则里有 /成功/ ⇒ 不写会被当成绿「ok」，
  //   于是模拟演练看起来跟真发出去一模一样（2026-10-03 同一起事故）
  '模拟成功': 'warn',
  '已生成': 'ok', '通过': 'ok', '发布成功': 'ok', '完成': 'ok', '已隔离': 'warn',
  '需人工处理': 'bad', '需人工确认': 'warn', '词表外，需人工确认': 'warn', '主色不符，需人工确认': 'warn',
  '货号不存在': 'bad', '漏填颜色': 'bad', '失败': 'bad', '校验未通过': 'bad',
  '待发布': 'wait', '排队': 'wait', '生成中': 'run', '上传图片…': 'run', '填标题正文': 'run',
  '填话题': 'run', '关联好物': 'run', '发布确认': 'run'
};
function kindOf(s) {
  if (STATUS_KIND[s]) return STATUS_KIND[s];
  if (/成功|完成|通过$/.test(s)) return 'ok';
  if (/失败|错误/.test(s)) return 'bad';
  if (/\.\.\.|…|中$/.test(s)) return 'run';
  return 'wait';
}

/* ---------------- 主题 ----------------
 * ★ 2026-10-03 用户拍板：app **默认浅色**，切换按钮放在「app 最上面、项目左边」，点一下就切。
 *   「跟随 Windows 设置」这一档同时取消。主进程 window.normTheme() 是同一个口径，
 *   老配置里的 'system' 一样按浅色算 —— 否则会出现「界面浅色、窗口底色深色」这种半深半浅。
 * ★★ 2026-10-08 用户要求：加第三档「玻璃」，**和 日间 / 夜间 同一级别**。
 *   三档：日间 / 夜间 / 玻璃。
 * ★ 判据只认主进程报回来的 `theme`（light / dark / glass）—— **不要**拿 shouldUseDarkColors 反推：
 *   玻璃在原生窗口层就是按深色走的（原生标题栏 / 滚动条 / 窗口底色），反推会把玻璃认成夜间。
 * ★★ 2026-10-08 二次需求：控件从「一个圆键循环三档」改成 **Dock**（三个图标常驻、
 *   指针靠近按距离弹簧放大）。所以这里**只点亮当前那一档**（.tdock.on），
 *   **不再**改某个单键的 title / aria-pressed —— 图标不换 innerHTML、也不加文字说明。
 */
function applyTheme(t) {
  const skin = (t && t.theme) || ((t && t.shouldUseDarkColors) ? 'dark' : 'light');
  document.documentElement.classList.toggle('dark', skin === 'dark');
  document.documentElement.classList.toggle('glass', skin === 'glass');
  const dock = document.getElementById('themeDock');
  if (dock) {
    dock.querySelectorAll('.tdock').forEach(b => {
      const on = b.dataset.skin === skin;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
}

/* ---------------- 主题 Dock：按距离弹簧放大 ----------------
 * 用户要求把「日间 / 夜间 / 玻璃」的切换做成 Dock 那种「指针靠近 → 按距离放大」的效果。
 * 这是 React 组件里 useMotionValue / useSpring 的**原生等价物**，拆开就三件事：
 *   ① 指针到每个图标中心的水平距离 d
 *   ② distance → 目标缩放：target = 1 + (max-1) * cos²(π/2 · min(d/R, 1))   （余弦平方 = 平滑 1→0）
 *   ③ 一个真弹簧，每帧把当前值朝 target 推过去（**不是** CSS transition，所以有回弹/拖尾手感）
 * ★★ 性能红线：**绝不挂常驻 rAF**。桌面端一个永远在跑的 rAF 是实打实的耗电/掉帧源（本项目做过卡顿诊断）。
 *   做法：只在指针进 Dock 时启动；「全部收敛 且 指针已离开」就停（见 frame() 里那个三元的终态）。
 * ★ 为什么不量一次就完事：图标会因右侧 chips 的文字变化（runChip「空闲/运行中」）整体左右移位
 *   ⇒ 每次 pointerenter 重新量一遍中心。
 * ★ 缩放用 transform-origin 居中 ⇒ **缩放不改 rect 的中心**，所以拿 rect 中心当基准不会被自己的动画带偏
 *   （用 offsetLeft 也行，但那要求 .theme-dock 是 offsetParent，两个前提都是隐式的，rect 中心更省心）。
 */
const TDOCK = { max: 1.4, R: 52, k: 420, c: 30, lift: 0 };
/** Dock 的「距离 → 放大增益」：**纯函数**（0 表示不放大，1 表示放到最大）。
 *  单独抽出来是为了能被自检直接调用 —— 隐藏窗口的 rAF 会被节流（实测 2~170fps 都有），
 *  「等一会儿再看 --s」这种断言必然脆；映射本身不该被环境时序拖累。
 *  d=指针到图标中心的距离、R=影响半径；余弦平方 = 平滑的 1→0 衰减（d>=R 起完全不放大）。 */
function dockGain(d, R) {
  const t = Math.min(Math.abs(d) / R, 1);
  const f = Math.cos(t * Math.PI / 2);
  return f * f;
}
function bindThemeDock() {
  const dock = document.getElementById('themeDock');
  if (!dock) return;
  const items = [...dock.querySelectorAll('.tdock')];
  const st = items.map(() => ({ s: 1, ts: 1, vs: 0, l: 0, tl: 0, vl: 0 }));
  let cx = items.map((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; });
  let raf = 0, hot = false, prev = 0;
  const measure = () => { cx = items.map((el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; }); };

  const frame = (now) => {
    // ★ 必须按**真实经过的时间**推进，不能「每帧固定推 H 秒」——
    //   后者会把模拟时间绑死在帧率上：60fps 时每帧只推进 1/480s ⇒ 实际慢 8 倍、
    //   而在 240Hz 屏上又快 4 倍（同一份参数手感完全不同）。开头的 prev=0 是「刚启动/长暂停」的兜底。
    const H = 1 / 480;                        // 固定子步长：k 调大也不发散
    const dt = prev ? Math.min((now - prev) / 1000, 0.05) : H;
    prev = now;
    const n = Math.max(1, Math.min(Math.round(dt / H), 60));
    let moving = false;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < items.length; i++) {
        const a = st[i];
        a.vs += (-TDOCK.k * (a.s - a.ts) - TDOCK.c * a.vs) * H; a.s += a.vs * H;
        a.vl += (-TDOCK.k * (a.l - a.tl) - TDOCK.c * a.vl) * H; a.l += a.vl * H;
      }
    }
    items.forEach((el, i) => {
      const a = st[i];
      if (Math.abs(a.s - a.ts) < 1e-3 && Math.abs(a.vs) < 1e-3) { a.s = a.ts; a.vs = 0; } else { moving = true; }
      if (Math.abs(a.l - a.tl) < 1e-3 && Math.abs(a.vl) < 1e-3) { a.l = a.tl; a.vl = 0; } else { moving = true; }
      el.style.setProperty('--s', a.s.toFixed(4));
      el.style.setProperty('--lift', a.l.toFixed(2) + 'px');
    });
    if (moving || hot) { raf = requestAnimationFrame(frame); }
    else { raf = 0; prev = 0; }               // 收敛且指针已离开 ⇒ 停 rAF（不常驻）
  };
  const kick = () => { if (!raf) { prev = 0; raf = requestAnimationFrame(frame); } };
  const aim = (clientX) => {
    items.forEach((el, i) => {
      const g = dockGain(clientX - cx[i], TDOCK.R);
      st[i].ts = 1 + (TDOCK.max - 1) * g;
      st[i].tl = TDOCK.lift * g;
    });
  };

  dock.addEventListener('pointerenter', () => { measure(); hot = true; kick(); });
  dock.addEventListener('pointermove', (e) => { hot = true; aim(e.clientX); kick(); });
  dock.addEventListener('pointerleave', () => {
    hot = false;
    st.forEach((a) => { a.ts = 1; a.tl = 0; });   // 离开就回位（弹簧自己收尾，然后停 rAF）
    kick();
  });
  // chips 里的文字一变（如 runChip）dock 会整体移位 ⇒ 尺寸变化后重量基准
  window.addEventListener('resize', measure);
}

/* ---------------- 日志 ----------------
 * 日志**只有一份数据**（state.logs），两处显示：最下面的日志栏 + 左侧「运行日志」页。
 * ★ 这两处必须永远一致（用户要求「同步」）⇒ 推送 / 重绘 / 清空 三件事都只走下面这几个函数。
 *   别在别处直接碰 #log 或 #logPaneLines —— 那样迟早变成「一边更新、一边不更新」。
 * ★ 筛选只作用于「运行日志」页，底部日志栏永远是全量（它就是「刚才发生了什么」）。
 *
 * ★★ 2026-10-05 用户口径：「运行日志太细了…给用户没必要，就给大结论」。
 *   日志条目分两级（主进程 logbus 打的 `tier`）：
 *     tier === 'detail' → **过程明细**（每步耗时 / 坐标 / 屏幕守卫 / 清相册 / 抽帧…）
 *     其余（没有 tier）  → **大结论**（任务开始 / 结束 / 结果【目标/成功/失败】/ 真出错的告警）
 *   明细**不进界面**：底部日志栏与「运行日志」页都只画大结论（见 uiLogs()）。
 *   但 `state.logs` 里**原样留着**明细 —— 任务行「查看详情」还得靠它按批次逐条回看，
 *   `run-log.jsonl` 台账也一条不少。⇒ 「用户看着干净」与「事后查得清」两件事都要。
 */
const LOG_KEEP = 500;      // 内存里留多少条：与主进程 logbus 的环形缓冲 MAX 对齐
const LOG_BAR_MAX = 300;   // 底部日志栏最多渲染多少行（DOM 行数多了会拖慢整页重排）
const LOG_LEVEL_CLS = { ok: 'ok', error: 'er', warn: 'wn', info: 'inf' };
const LOG_LEVEL_TEXT = { info: '信息', ok: '成功', warn: '警告', error: '错误' };

function logCls(level) { return LOG_LEVEL_CLS[level] || 'inf'; }
function logLineHtml(e) {
  return `<span class="t">${hhmm(e.t)}</span><span class="${logCls(e.level)}">${esc(e.msg)}</span>`;
}
/** 过程明细：不进底部日志栏 / 运行日志页，只在「查看详情」和台账里出现 */
function isDetailLog(e) { return !!(e && e.tier === 'detail'); }
/** 面向用户的日志（大结论）：底部日志栏、运行日志页、导出、条数统计，一律以它为准 */
function uiLogs() { return (state.logs || []).filter(e => !isDetailLog(e)); }
function logFilterOn() {
  const f = state.logFilter || {};
  return !!(f.level || String(f.q || '').trim());
}
/** 当前筛选下该出现在「运行日志」页里的那些（无筛选 = 全部大结论） */
function filteredLogs() {
  const f = state.logFilter || { level: '', q: '' };
  const q = String(f.q || '').trim().toLowerCase();
  return uiLogs().filter(e => {
    if (f.level && e.level !== f.level) return false;
    if (q && !String(e.msg || '').toLowerCase().includes(q)) return false;
    return true;
  });
}
/** 命中条数文案。★ 筛选时两个数都要写出来 —— 只写「3 条」会让人以为日志丢了 */
function logCountText() {
  const hit = filteredLogs().length;
  const total = uiLogs().length;
  return logFilterOn() ? `显示 ${hit} / 共 ${total} 条` : `共 ${total} 条`;
}
/** 一条日志追加到「运行日志」页（只在该页开着时才动 DOM，且要过一遍当前筛选） */
function appendToLogPane(e) {
  if (isDetailLog(e)) return;
  const box = $('#logPaneLines');
  if (!box) return;
  const f = state.logFilter || { level: '', q: '' };
  const q = String(f.q || '').trim().toLowerCase();
  if (f.level && e.level !== f.level) return;
  if (q && !String(e.msg || '').toLowerCase().includes(q)) return;
  const div = document.createElement('div');
  div.innerHTML = logLineHtml(e);
  box.appendChild(div);
  while (box.children.length > LOG_KEEP) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
  const cnt = $('#logPaneCount');
  if (cnt) cnt.textContent = logCountText();
}
function pushLog(e) {
  state.logs.push(e);
  if (state.logs.length > LOG_KEEP) state.logs.shift();
  // ★ 明细只进 state.logs（供「查看详情」/台账），不往底部日志栏画
  const box = isDetailLog(e) ? null : $('#log');
  if (box) {
    const div = document.createElement('div');
    div.innerHTML = logLineHtml(e);
    box.appendChild(div);
    while (box.children.length > LOG_BAR_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  appendToLogPane(e);
  updateLogBadge();
}
function renderLogs() {
  const box = $('#log');
  if (box) {
    box.innerHTML = '';
    uiLogs().slice(-LOG_BAR_MAX).forEach(e => {
      const div = document.createElement('div');
      div.innerHTML = logLineHtml(e);
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  }
  renderLogPaneLines();
  updateLogBadge();
}
/** 「运行日志」页只重画行本身：整页重排会把筛选框里正在输入的光标顶掉 */
function renderLogPaneLines() {
  const box = $('#logPaneLines');
  if (!box) return;
  box.innerHTML = filteredLogs().map(e => `<div>${logLineHtml(e)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
  const cnt = $('#logPaneCount');
  if (cnt) cnt.textContent = logCountText();
}
/** 清空：底部与页面一起清（只清一边 = 「同步」当场破功） */
function clearLogs() {
  state.logs = [];
  const bar = $('#log');
  if (bar) bar.innerHTML = '';
  renderLogPaneLines();
  updateLogBadge();
}
/** 条数：只更新底部日志栏右上角那个 chip（★ 2026-10-05 用户：左侧「运行日志」模块上不要显示条数
 *  —— 侧栏那个角标（`[data-st="10"]`）已整个去掉，连元素都没了）。
 *  口径与「运行日志」页里那个 chip 一致：同一个 state.logs 缓冲区（上限 500），**都只数大结论**
 *  （明细不算进去，否则用户会看到「共 3 条」而屏幕上只有 1 行）。 */
function updateLogBadge() {
  const total = uiLogs().length;
  const errs = uiLogs().filter(e => e.level === 'error').length;
  const bar = $('#logBarCount');
  if (bar) {
    bar.textContent = total ? `共 ${total} 条${errs ? ` · ${errs} 错` : ''}` : '还没有日志';
    bar.className = 'chip' + (errs ? ' warn' : '');
  }
}
/** 需要导出给主进程的那些：**当前筛选下来的**，外加上下文（筛选条件 + 缓冲区总数 + 明细条数） */
function logExportPayload() {
  const ui = uiLogs();
  return {
    entries: filteredLogs(),
    filter: { level: state.logFilter.level, q: state.logFilter.q },
    bufferTotal: ui.length,
    // ★ 明细也要报个数：界面上看不见它们，导出文件里得说清「还有 N 条流水在 run-log.jsonl」
    bufferDetail: Math.max(0, (state.logs || []).length - ui.length)
  };
}

/* ---------------- 任务（实例化：同一时间可以有多个批次在跑） ---------------- */
/** 产出可发布内容的任务：必须带品牌归属。名单要和主进程 jobs.js 的 BRAND_SCOPED 保持一致 */
const BRAND_SCOPED_TYPES = new Set(['copy.generate', 'report.import', 'sheet.export', 'publish.run', 'publish.rerun']);

/**
 * 产出类任务统一带上标题栏选中的品牌。没选中就不带 —— 让主进程把「为什么不行」讲清楚，
 * 而不是在前端塞一个顶上：归属记错了比报错难查得多。
 * ★★ 凡是 BRAND_SCOPED_TYPES 里的任务，**所有**调用点都必须经过这里 ——
 *    包括绕过 runJob 直接调 appApi.run 的那些。漏一处，界面表现就是
 *    「标题栏明明选着品牌，一点却弹『请先选择品牌』」（2026-10-03「导入内容报告」就是这样漏的）。
 */
function brandArgs(type, args) {
  const a = Object.assign({}, args || {});
  if (BRAND_SCOPED_TYPES.has(type) && !a.brandId && state.brandId) a.brandId = state.brandId;
  return a;
}

async function runJob(type, args) {
  let res;
  const a = brandArgs(type, args);
  try {
    res = await appApi.run(type, a);
  } catch (e) {
    // IPC 层抛出来也要给人一句话，不能只在控制台里报错
    res = { ok: false, error: (e && e.message) || '任务调用失败' };
  }
  if (!res.ok) toast(res.error, res.cancelled || /已取消/.test(res.error || '') ? '' : 'err');
  renderAll();
  return res;
}
/**
 * 文案生成跑完的收尾：把「这批的 AI 内容报告落在哪、有没有要人工看的行」直接摆到人脸上。
 * 报告是这一步真正要交付的东西（用户 2026-10-02 要求：「在该文件夹生成一个全新的带时间戳的 ai 报告」），
 * 所以不能只在日志里留一句话就算了 —— 跑完自动打开它所在的位置，并说清有没有要人工复核的行。
 */
let lastCopyReport = null;
async function afterCopy(r) {
  const x = (r && r.result) || {};
  lastCopyReport = x.reportFile
    ? {
      file: x.reportFile, rows: x.reportRows || 0, flagged: x.reportFlagged || 0,
      byLevel: x.reportByLevel || {}, gen: x.genSource || '', brand: r.brandName || ''
    }
    : null;
  renderAll();
  if (!x.reportFile) return;
  const flag = x.reportFlagged || 0;
  const name = String(x.reportFile).split(/[\\/]/).pop();
  toast(`AI 内容报告已生成：${x.reportRows} 行 · ${flag ? `${flag} 行要人工看一眼` : '文案/货号/颜色核对一致'} → ${name}`,
    flag ? 'warn' : 'ok');
  await appApi.reveal(x.reportFile);
}

function jobOf(type) { const l = state.jobs.filter(j => j.type === type); return l.length ? l[l.length - 1] : null; }function running(type) { return !!jobOf(type); }
function progFor(type) { const j = jobOf(type); return j ? j.progress : null; }
function batchesOf(type) { return type ? state.jobs.filter(j => j.type === type) : state.jobs.slice(); }
function secText(s) { const v = Math.max(0, Number(s) || 0); return v < 60 ? v.toFixed(0) + 's' : Math.floor(v / 60) + 'm' + String(Math.round(v % 60)).padStart(2, '0') + 's'; }
/** 批次名：真机形如 7月第六批(已安排)_20260812_151245 */
function batchStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}


function progHtml(p) {
  const pct = p && p.total ? Math.round((p.done || 0) / p.total * 100) : 0;
  return `<div class="progwrap" id="prog">
    <div class="bar"><i style="width:${pct}%"></i></div>
    <span class="chip" id="progTxt">${p ? (p.done || 0) + ' / ' + p.total : ''}${p && p.label ? ' · ' + esc(p.label) : ''}</span>
  </div>`;
}
function updateProgress(p) {
  const bar = document.querySelector('#prog i');
  const txt = document.querySelector('#progTxt');
  if (bar && p && p.total) bar.style.width = Math.round((p.done || 0) / p.total * 100) + '%';
  if (txt && p) txt.textContent = (p.done || 0) + ' / ' + p.total + (p.label ? ' · ' + p.label : '');
}

/**
 * 运行中的批次/任务（真机：任务列表 → 批次名 → 查看详情 / 取消任务，另有「全部取消」）
 * type 传空表示看全部任务；传类型表示只看这一类。
 */
function batchesHtml(type, title) {
  const list = batchesOf(type);
  const rows = list.map(j => {
    const p = j.progress || {};
    const pct = p.total ? Math.round((p.done || 0) / p.total * 100) : 0;
    return `<tr>
      <td class="mono">${esc(j.label)}</td>
      <td>${p.total ? `${p.done || 0} / ${p.total}` : '准备中'}</td>
      <td><div class="bar" style="min-width:90px"><i style="width:${pct}%"></i></div></td>
      <td class="num">${secText(j.elapsedSec)}</td>
      <td><button class="btn sm" data-act="batch:detail" data-batch="${esc(j.label)}">查看详情</button>
          <button class="btn sm" data-act="batch:cancel" data-id="${esc(j.id)}">取消任务</button></td>
    </tr>`;
  }).join('');
  const t = type || 'all';
  return `<div class="box" data-batches="${esc(t)}" data-batches-title="${esc(title || '运行中的批次')}">
    <h3>${esc(title || '运行中的批次')}${list.length ? `（${list.length}）` : ''}</h3>
    ${list.length ? `<div class="tw"><table>
        <thead><tr><th>批次</th><th>进度</th><th></th><th>已用时</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="batch:cancelAll">全部取消</button>
        <span class="hint">多批次可同时「处理中」；取消是「当前步骤结束后停下」，不会把已产出的结果丢掉。</span></div>`
      : '<div class="empty">当前没有正在处理的批次。</div>'}
    ${batchDetailHtml()}
  </div>`;
}

/*
 * ★ 2026-10-03 用户要求：**「失败恢复动作」整块删除**（原来这里有一个 recoverHtml()：
 *   可编辑的恢复步骤 + 「编辑恢复动作」按钮；主进程对应 publish.setRecover + publisher.recover）。
 *   现在发布失败不回退、也不执行任何恢复步骤：失败就写「发布失败，原因xxx」交人工。
 *   代价如实说：上一条失败后界面可能停在半路，下一条的起点会被残留页面污染 —— 这是用户拍板接受的，
 *   所以「重跑」那个按钮（publish.rerun）依旧保留：那是**人点的新任务**，不会自己发生。
 */

/**
 * 「AI 内容报告」（真机流水线的中间产物）：导入后直接发布，结果回写它的 B/C 列
 */
function reportBoxHtml() {
  const pub = state.project.publish || {};
  if (!pub.reportFile) {
    return `<p class="hint">也可以直接点「<b>导入 AI 内容报告</b>」（真机那份 26 列 xlsx）：表里是
      <code>素材路径 / 标题 / 文案 / 内容类型 / 好物1~9_货号+颜色</code>，按<b>列名</b>识别、不认列位置。
      一个叶子文件夹 = 一条内容；报告里标题/文案空着就本地生成；发布完把「实际执行时间 / 执行结果」写回那两列。</p>`;
  }
  const rows = pub.rows || [];
  const blocked = rows.filter(r => r.result === '校验未通过').length;
  const done = rows.filter(r => r.result === '发布成功').length;
  return `<div class="box">
    <h3>当前批次来自 AI 内容报告</h3>
    <div class="row">
      <input class="inp mono" value="${esc(pub.reportFile)}" readonly>
      <span class="chip">表「${esc(pub.reportSheet || '')}」</span>
      ${pub.reportDir ? `<span class="chip" title="报告的「素材路径」是空的，用的是这次选的素材目录">素材目录 ${esc(pub.reportDir)}</span>` : ''}
      <span class="chip">${rows.length} 条</span>
      ${done ? `<span class="chip">已发 ${done}</span>` : ''}
      ${blocked ? `<span class="chip warn">${blocked} 条暂不发布</span>` : ''}
      <button class="btn sm" data-act="sheet:openReport">打开报告</button>
    </div>
    <p class="hint">发布完会回写报告的 <b>实际执行时间（B）/ 执行结果（C）</b> 两列；报告被 WPS 占用时整批暂存，
      下次导入或发布时先补写。含视频的叶子目前不发布（真实通道只推图片），该行会标成「校验未通过」并写明原因。</p>
  </div>`;
}

/** 只重绘批次面板：进度是按行推进的，整页重排会把大任务拖慢 */
function refreshBatches() {
  document.querySelectorAll('[data-batches]').forEach(el => {
    const t = el.dataset.batches;
    const box = document.createElement('div');
    box.innerHTML = batchesHtml(t === 'all' ? '' : t, el.dataset.batchesTitle);
    if (box.firstElementChild) el.replaceWith(box.firstElementChild);
  });
}

/** 「查看详情」：用日志总线里带 meta.batch 的记录，按批次把这一步的日志筛出来 */
function batchDetailHtml() {
  if (!state.batchDetail) return '';
  const es = (state.logs || []).filter(e => e.meta && e.meta.batch === state.batchDetail);
  const cls = { ok: 'ok', error: 'er', warn: 'wn', info: 'inf' };
  return `<div style="margin-top:10px">
    <div class="row" style="justify-content:space-between">
      <b>批次详情：${esc(state.batchDetail)}</b>
      <button class="btn sm" data-act="batch:detailClose">收起</button>
    </div>
    ${es.length
      // 复用底部日志条的样式（.logbar .lines 才有等宽字体与分级配色），这里只把边框和高度改掉
      ? `<div class="logbar" style="border-top:0;max-height:260px;margin-top:6px">
          <div class="lines">${es.map(e => `<div><span class="t">${hhmm(e.t)}</span><span class="${cls[e.level] || 'inf'}">${esc(e.msg)}</span></div>`).join('')}</div>
        </div>`
      : '<div class="empty">这个批次还没有日志。</div>'}
  </div>`;
}

/* ---------------- 侧栏 ---------------- */
function sideStatus() {
  const p = state.project || {};
  const set = (i, txt, cls) => {
    const el = document.querySelector(`[data-st="${i}"]`);
    if (!el) return;
    el.textContent = txt;
    el.className = 'st' + (cls ? ' ' + cls : '');
  };
  set(1, p.items && p.items.length ? String(p.items.length) : '待', p.items && p.items.length ? 'ok' : 'warn');
  const cs = p.compliance && p.compliance.stats;
  set(2, cs ? (cs.manual ? `${cs.todo + cs.manual} 待` : '通过') : '—', cs ? (cs.manual ? 'warn' : 'ok') : '');
  set(3, p.copyRows && p.copyRows.length ? `${p.copyRows.length}/${p.items.length}` : (p.items ? `0/${p.items.length}` : '—'),
    p.copyRows && p.copyRows.length ? 'ok' : '');
  const vs = p.verify && p.verify.stats;
  set(4, vs ? (vs.manual + vs.missing + vs.noColor ? `${vs.manual + vs.missing + vs.noColor}` : '通过') : '—', vs ? (vs.manual + vs.missing + vs.noColor ? 'warn' : 'ok') : '');
  set(5, p.sheet && p.sheet.rowCount ? String(p.sheet.rowCount) : '—', p.sheet && p.sheet.rowCount ? 'ok' : '');
  const rows = (p.publish && p.publish.rows) || [];
  const ok = rows.filter(r => r.result === '发布成功').length;
  set(6, rows.length ? `${ok}/${rows.length}` : '—', rows.length ? (ok === rows.length ? 'ok' : '') : '');
  // 8 品牌统计：显示「能用几个品牌」。一个都没有是黄灯 —— 那样什么产出任务都起不来，得先说清
  const mine = state.brandsMeta ? state.brandsMeta.mine : null;
  set(8, mine ? `${mine.length} 个` : '—', mine ? (mine.length ? 'ok' : 'warn') : '');
}

/* ---------------- 各页渲染 ---------------- */
const TABS = {};

TABS[1] = {
  title: '素材整理',
  desc: '多层级文件夹扁平化 · 不覆盖原文件夹 · 自动加日期时间后缀',
  actions: () => [
    { act: 'flatten:pick', label: '选择目录' },
    { act: 'flatten:plan', label: '生成清单', disabled: !state.project.sourceDir },
    { act: 'flatten:run', label: '开始整理', primary: true, disabled: !state.project.sourceDir }
  ],
  render() {
    const p = state.project;
    const dir = p.sourceDir || '';
    const plan = state.plan;
    const before = plan ? plan.rows.slice(0, 8).map(r => esc(r.from.replace(dir, '').replace(/^[/\\]/, '')) + ` <s>(${r.fileCount} 个文件)</s>`).join('<br>') : '点「生成清单」查看（秒级，只读元数据）';
    const after = plan ? plan.rows.slice(0, 8).map(r => `<b>${esc(r.name)}</b> <s>(${r.fileCount})</s>`).join('<br>') : '—';
    return `
      <div class="box">
        <h3>源目录</h3>
        <div class="row">
          <input class="inp mono" value="${esc(dir)}" readonly>
          <span class="chip">${plan ? plan.total + ' 个叶子目录 · ' + plan.fileTotal + ' 个文件' : '未生成清单'}</span>
        </div>
        <p class="hint">命名规范：<b>货号+颜色</b>（如 <code>26FW-YB160+冠军白</code>）。加号是零歧义分隔符，任何品牌都不会把 <code>+</code> 写进货号，所以颜色段不查词典也能准确取到。</p>
      </div>
      ${running('flatten.run') ? progHtml(progFor('flatten.run')) : ''}
      <div class="two">
        <div class="box"><h3>整理前（多层嵌套）</h3><div class="tree">${before}</div></div>
        <div class="box"><h3>整理后（扁平 + 时间戳）</h3><div class="tree">${esc(dir ? dir.split(/[\\/]/).slice(-1)[0] + '_时间戳（原目录保留）' : '')}<br>${after}</div></div>
      </div>
      ${p.flatDir ? `<div class="box"><h3>上次整理结果</h3>
        <div class="row"><input class="inp mono" value="${esc(p.flatDir)}" readonly>
        <button class="btn sm" data-act="flatten:openFlat">打开目录</button></div>
        <p class="hint">共 ${p.items.length} 个叶子目录${p.items[0] && p.items[0].absDir ? ' · ' + esc(p.items[0].absDir.split(/[\\/]/).slice(0, -1).join('/')) : ''}</p></div>` : ''}
      <p class="hint">扁平名用 <code>${esc((state.config.flatten || {}).connector || '_')}</code> 连接原来的层级路径（真机：<code>8124MT_UWG450159+灰色+达人昵称_1</code>）；<b>原素材完全不动</b> —— 只建扁平副本，原目录不改名不移动。同卷建硬链接（只改元数据，1692 个链接 &lt; 2 秒），跨卷才实体复制；长路径自动加 <code>\\\\?\\</code> 前缀。</p>`;
  }
};

TABS[2] = {
  title: '合规检查',
  desc: '图片转 JPG ≤10MB · 视频转 MP4 ≤600s · 不合规文件隔离而非删除',
  actions: () => [
    { act: 'comp:parent', label: '检查父目录' },
    { act: 'comp:scan', label: '开始检查' },
    { act: 'comp:export', label: '导出报告', disabled: !(n(state.project.compliance.stats && state.project.compliance.stats.total)) },
    { act: 'comp:fix', label: '处理可自动项', primary: true, disabled: !n(state.project.compliance.stats && state.project.compliance.stats.todo) && !n(state.project.compliance.stats && state.project.compliance.stats.isolate) }
  ],
  render() {
    const c = state.project.compliance || {};
    const s = c.stats;
    const cfg0 = state.config.compliance || {};
    if (!s) return `<div class="empty">还没有扫描记录。先做完「素材整理」，再点「开始检查」—— 只读取元数据，秒级出报告。也可以直接「检查父目录」，里面每个子文件夹独立出报告。</div>`;
    const rows = c.rows.filter(r => r.status !== 'ok').slice(0, 60);
    const okRows = c.rows.filter(r => r.status === 'ok').length;
    return `
      <div class="stats">
        <div class="stat good"><b>${n(s.ok)}</b><span>合格</span></div>
        <div class="stat"><b>${n(s.todo)}</b><span>可自动处理</span></div>
        <div class="stat bad"><b>${n(s.manual)}</b><span>需人工定夺</span></div>
        ${cfg0.enforceMaxSide ? `<div class="stat"><b>${n(s.scaled)}</b><span>等比缩放</span></div>` : ''}
        <div class="stat bad"><b>${n(s.tooSmall)}</b><span>尺寸不足</span></div>
        <div class="stat bad"><b>${n(s.notMp4)}</b><span>非 MP4</span></div>
        ${cfg0.enforceMaxMB ? `<div class="stat bad"><b>${n(s.oversize)}</b><span>超 ${cfg0.maxImageMB}MB 压缩</span></div>` : ''}
        <div class="stat"><b>${n(s.isolate)}</b><span>隔离到 _rejected</span></div>
      </div>
      <p class="hint">规则（按你的口径，2026-10-05 起）：图片<b>必须为 JPG</b>、≥<b>${cfg0.minPixels}</b> 像素²（约 42×42）、边长 <b>${cfg0.enforceMaxSide ? `${cfg0.minSide}~${cfg0.maxSide}` : `≥${cfg0.minSide}`}</b>${cfg0.enforceMaxSide ? (cfg0.autoScale ? '（超限自动等比缩放）' : '（超限需更换）') : '（<b>超出不限制、不缩放</b>）'}${cfg0.enforceMaxMB ? `、≤${cfg0.maxImageMB}MB` : '、<b>体积不限</b>（不压缩）'}；视频<b>必须 .mp4</b>（<code>.mov</code>/<code>.m4v</code> 等会自动转成 mp4）且 &lt;${cfg0.maxVideoSec} 秒（超时只标红不裁剪）。</p>
      ${(c.groups && c.groups.length) ? `<div class="box"><h3>按子文件夹（${c.groups.length} 个）</h3>
        <div class="tw"><table><thead><tr><th>子文件夹</th><th>合格</th><th>可自动</th><th>需人工</th></tr></thead><tbody>
        ${c.groups.map(g => `<tr class="${g.stats.manual ? 'warnrow' : ''}"><td class="mono">${esc(g.name)}</td><td class="num">${n(g.stats.ok)}</td><td class="num">${n(g.stats.todo)}</td><td class="num">${n(g.stats.manual)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="hint">「导出报告」会把这张分组表 + 全部明细写成 <code>合规报告_时间戳.xlsx</code>（汇总 / 明细两个工作表）和同名 <code>.csv</code>，落到输出目录。</p></div>` : ''}
      ${running('compliance.scan') || running('compliance.fix') ? progHtml(progFor(running('compliance.scan') ? 'compliance.scan' : 'compliance.fix')) : ''}
      ${rows.length ? `<div class="tw"><table>
        <thead><tr><th>文件</th><th>类型</th><th>问题</th><th>处置</th><th>状态</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.status === 'manual' ? 'flag' : (r.status === 'isolate' ? 'warnrow' : '')}">
          <td class="mono">${esc(r.file)}</td><td>${esc(r.type)}</td><td>${esc(r.issue)}</td><td>${esc(r.result || r.action)}</td>
          <td>${badge(r.status === 'done' ? (r.result || '完成') : (r.status === 'manual' ? (r.result || '需人工处理') : (r.status === 'isolate' ? '待隔离' : r.status)), kindOf(r.status === 'done' ? '完成' : (r.status === 'manual' ? '需人工处理' : '待处理')))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">全部 ${okRows} 个文件都合规，没有需要处理的项。</div>`}
      <p class="hint">超 ${state.config.compliance.maxVideoSec} 秒的视频<b>只标红不裁剪</b> —— 裁剪会改变内容，得物那边可能判非原创，交人工决定。</p>`;
  }
};

/**
 * 这一条到底带哪些话题（渲染「话题组合」那一列用）。
 * ★★ 2026-10-03 用户拍板「话题并进文案、一个话题一行」之后，`topics` 在生成的产物里是**空的**
 *   （话题在 `body` 末尾）⇒ 这一列必须**从正文末尾认回来**再显示。
 *   不认的话整列恒为「—」，看着就像「这条没带话题」—— 而「话题没带上」正是用户最在意的那件事。
 * ★ 只认**末尾**连续的话题行（与 copycheck.bodyWithoutTrailingTopics / copywriter 同一套字符口径）。
 */
const TOPIC_LINE_RE = /^\s*#[^\s#，。！？、：；,.;:!?()（）\[\]【】"'“”‘’…—\-]+\s*$/;
function topicsShown(r) {
  if (((r && r.topics) || []).length) return r.topics;
  const ls = String((r && r.body) || '').split(/\r?\n/);
  const out = [];
  while (ls.length && (!ls[ls.length - 1].trim() || TOPIC_LINE_RE.test(ls[ls.length - 1]))) {
    if (TOPIC_LINE_RE.test(ls[ls.length - 1])) out.unshift(ls[ls.length - 1].trim());
    ls.pop();
  }
  return out;
}

TABS[3] = {
  title: '文案生成',
  desc: '看图写标题正文 · 话题组合去重 · 跑完落一份带时间戳的 AI 内容报告',
  actions: () => [
    // ★ 2026-10-08 用户要求：模型配置搬到**这一页**，做成弹窗，并且是**唯一**入口
    //   （原来在「高级设置 → 文案模型」的折叠框已删）。位置按用户指定，放在「提示词配置」左边。
    // ★ 只给管理员看：它原来就住在**仅管理员可见**的「高级设置」里，搬过来不能顺手把它开放给所有人
    //   （改的是全公司共用的接口地址与 Key）。与「高级设置」那套 canAdmin() 是同一个口径。
    ...(canAdmin() ? [{ act: 'copy:model', label: '模型配置' }] : []),
    { act: 'copy:prompt', label: '提示词配置' },
    // ★ 2026-10-08 用户要求删掉「按当前素材生成」：用户原话「一般没点目录的时候不会有当前素材，
    //   所以这两个功能重复了」。文案生成只剩按批次这一条路（下面 ACTS 里的 'copy:run' 与
    //   主进程 jobs.js 里那条「拿当前工程 items 生成」的分支一并删除，不留死代码）。
    { act: 'copy:pickRun', label: '选择素材目录并启动任务', primary: true }
  ],
  render() {
    const p = state.project;
    const cfg = state.config.copy;
    const rows = p.copyRows || [];
    const planRows = rows.length ? rows : p.items.map((it, i) => ({ id: it.id, sku: it.sku, color: it.color, format: '', formatName: '', angle: '', topics: [], status: '' }));
    return `
      <div class="box">
        <h3>批次设置</h3>
        <div class="row">
          <span class="lbl">轮换策略</span>
          <select class="inp" data-cfg="copy.rotateStrategy">${['F01-F10 轮换', '随机'].map(v => `<option ${cfg.rotateStrategy === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="lbl">必带话题</span>
          <input class="inp" style="min-width:210px;flex:0 0 auto" value="${esc(cfg.requiredTopic)}" data-cfg="copy.requiredTopic"
            placeholder="如 #品牌话题，#品类词" title="要多个就用空格 / 逗号 / 顿号隔开，没写 # 会自动补上">
          <span class="lbl">额外话题</span>
          <select class="inp" data-cfg="copy.extraTopics">${[3, 4, 5].map(v => `<option value="${v}" ${cfg.extraTopics === v ? 'selected' : ''}>${v} 个</option>`).join('')}</select>
        </div>
        <!-- ★ 2026-10-03 用户要求：「批次设置」文字太多 ⇒ 规则明细收进「说明书」弹窗（HELP.copy），
             页面只留一行结论 + 一个按钮。原来那 4 段共 600 多字，第一次用的人读不完、老手每次被挡着。
             ★ 结论行里必须留住两条**会改变行为**的信息（不能只写「看说明书」）：
               ① 必带话题可写多个（这是用户真正要动手填的那个框）；② 标题看图写、连不上直接报错（原来的承诺）。
             ★ 详细文字**一字不改**地搬进 HELP.copy，不是删掉 —— 说明书里能逐句核对。 -->
        <p class="hint">规则在<b>说明书</b>里（话题怎么拼 · 正文怎么写 · 重复怎么算 · 标题怎么来）：
          必带话题可写多个（<b>空格</b> / <b>逗号</b>隔开，漏写 <code>#</code> 自动补）；正文写成 <b>4~5 行短句</b>；
          标题是<b>看图写</b>的（模型连不上会直接停下报错，不拿本地模板冒充）。
          <button class="btn sm" data-act="help:open" data-topic="copy" style="margin-left:6px">看说明书</button></p>
        ${running('copy.generate') ? progHtml(progFor('copy.generate')) : ''}
        <p class="hint">跑完会在<b>你选的那个素材文件夹</b>里生成一份 <code>&lt;品牌&gt;_AI内容报告_&lt;时间戳&gt;.xlsx</code>：
          逐行写清 标题 / 正文 / 货号 / 颜色 / 生成来源 / <b>文案核对</b>（自动查出「颜色对不上」「混进货号」「用了模板套话」这类问题）。
          格式与上游那份「KIDS_AI内容报告」一致 ⇒ <b>核对完可以直接把它当发布单导进来</b>。</p>
        ${lastCopyReport ? `<div class="hint" style="border:1px solid #E3E0D8;border-radius:6px;padding:8px 10px">
          最近一次：<b>${esc(lastCopyReport.file.split(/[\\/]/).pop())}</b> · ${n(lastCopyReport.rows)} 行
          ${lastCopyReport.gen ? ` · 生成来源 ${esc(lastCopyReport.gen)}` : ''}
          ${lastCopyReport.flagged
            ? ` · <b>${n(lastCopyReport.flagged)} 行要人工看一眼</b>（要人工看 ${n(lastCopyReport.byLevel.warn)} · 明显有问题 ${n(lastCopyReport.byLevel.bad)}）`
            : ' · 文案/货号/颜色自动核对<b>全部一致</b>'}
          <button class="btn sm" data-act="copy:openReport" style="margin-left:8px">打开报告</button>
        </div>` : ''}
      </div>
      ${batchesHtml('copy.generate', '运行中的批次（AI 文案生成）')}
      <!-- ★ 2026-10-04 用户要求：这张表**不摆「货号 / 颜色」两列** ——
           理由（原话）：「反正 AI 内容报告会显示具体货号和颜色，这里就不展示了」。
           报告那一列是逐行核对过的权威值；这里再摆一份只会让人对着两个来源猜哪个对
           （实测这一版就踩过：表里两者来自工程状态、报告来自同一处但出错时口径不一致）。
           少两列不影响任何动作 —— 发布走的是报告（导入那一步），不是这张预览表。 -->
      ${planRows.length ? `<div class="tw"><table>
        <thead><tr><th>叶子目录</th><th>叙事视角</th><th>话题组合</th><th>标题</th><th>生成来源</th><th>状态</th></tr></thead>
        <tbody>${planRows.slice(0, 40).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td>
          <td>${r.angle ? esc(r.angle) : '—'}</td>
          <td class="cut">${topicsShown(r).length ? esc(topicsShown(r).join(' ')) : '—'}</td>
          <td class="cut" title="${esc(r.title || '')}">${esc(r.title || '—')}</td>
          <td class="cut">${r.genSource
            ? badge(r.genSource, r.genSource === '本地模板' || r.genSource === '未生成' ? '需人工处理' : '完成')
            : '—'}</td>
          <td>${badge(r.status || '待生成', kindOf(r.status || '待生成'))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有素材，先做「素材整理」。</div>`}`;
  }
};

/* ---------------- 页签 4：货号颜色校验（仅管理员可见） ----------------
 * ★ 2026-10-05 用户要求：这一页「对除了管理员的用户隐藏」。
 *   两条线一起上，缺一条就漏：
 *     ① index.html 那个按钮带 data-admin="1" ⇒ syncAdminNav() 把按钮 hidden 掉；
 *     ② 这里 admin:true ⇒ 即使当前正停在这一页（老配置里存过 tab=4、或按了 Ctrl+4），
 *        renderAll 开头的 syncAdminNav() 也会把 state.tab 兜回第 1 页。
 *   ★ 与「高级设置」是同一个机制（canAdmin()：免登录/开发模式算有权限，否则看 role）。
 *   ★ 注意这是**界面隐藏**：主进程那道「只有管理员能做」的口径没跟着加 ——
 *     校验本身是只读比对、不写别人的数据，所以按用户这次的要求只做隐藏。
 */
TABS[4] = {
  title: '货号颜色校验',
  admin: true,
  desc: '比对得物商品池 · 多颜色货号必须填对应颜色 · 附图片取色反查（仅管理员可见）',
  actions: () => [
    { act: 'verify:pool', label: '同步商品池' },
    { act: 'verify:run', label: '开始校验', primary: true }
  ],
  render() {
    const v = state.project.verify || {};
    const s = v.stats;
    if (!s) return `<div class="empty">还没有校验记录。点「开始校验」会比对商品池，并用图片实际提出的主色反查目录里填的色名。</div>`;
    return `
      <div class="stats">
        <div class="stat good"><b>${n(s.pass)}</b><span>通过</span></div>
        <div class="stat bad"><b>${n(s.manual)}</b><span>需人工确认</span></div>
        <div class="stat bad"><b>${n(s.missing)}</b><span>货号不存在</span></div>
        <div class="stat bad"><b>${n(s.noColor)}</b><span>漏填颜色</span></div>
      </div>
      ${running('verify.check') ? progHtml(progFor('verify.check')) : ''}
      <div class="tw"><table>
        <thead><tr><th>货号</th><th>目录填的颜色</th><th>商品池颜色</th><th>图片实取主色</th><th>结论</th></tr></thead>
        <tbody>${(v.rows || []).map(r => `<tr class="${r.level === 'bad' ? 'flag' : (r.level === 'warn' ? 'warnrow' : '')}">
          <td class="mono">${esc(r.sku)}</td>
          <td>${r.swatch ? `<span class="sw" style="background:${esc(r.swatch)}"></span>` : ''}${esc(r.declared || '（空）')}</td>
          <td>${esc((r.poolColors || []).join(' / ') || '—')}</td>
          <td>${esc(r.imageColor)}</td>
          <td>${badge(r.conclusion, kindOf(r.conclusion))}${r.note ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(r.note)}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="hint">多了一道保险：<b>用图片实际提出的主色反查目录里填的色名</b>。目录写「冠军白」但图是黑的，立刻就能发现。商品池：${state.info ? state.info.pool.size : 0} 个货号（${esc(state.info ? state.info.pool.source : '')}）。</p>
      <p class="hint">★ 这一页<b>只提示、不拦发布</b>：颜色对不上时，发布端会按货号搜出来的<b>第一件商品</b>发（详见「模拟器发布」页）。</p>
      <p class="hint">用「AI 内容报告」那一批时：先在「<b>模拟器发布</b>」页点「导入 AI 内容报告」，再回本页点「开始校验」——
        报告里空着的货号/颜色会先按叶子文件夹名（「货号+颜色」）补齐，再拿去跟商品池比对。</p>`;
  }
};

// ★ 2026-10-03 用户要求：「发布单」页签删除（那一页与「模拟器发布」页重复）。
//   ★ 删功能要连**读取链**一起处理：那一页独有的三样都已经安置好了，不是藏起来 ——
//     · 「导出 xlsx」→ 挪到「模拟器发布」页右上角动作条（用户指定的落点）；
//     · 「打开文件 / 打开目录」→ 挪到「模拟器发布」页「装置与节奏」那一块（紧挨发布单路径）；
//     · reportBoxHtml() → 本来就被 TABS[6] 渲染，原地保留。
//   ★ 编号**不重排**（6~12 保持原样）：重排要把 Ctrl+1..9、跳页写法与一批测试断言全改，
//     为一个空白位不值当。代价是页签编号在 5 处留了个空位 ⇒ renderAll 与 Ctrl+数字 都加了兜底
//     （原来落到空位会读 undefined.title，整页白屏）。

TABS[6] = {
  title: '模拟器发布',
  desc: '导入 AI 内容报告 → 选发布间隔 → 开始发布（ADB 驱动得物 App · 失败可单独重跑）',
  actions: () => [
    // ★ 2026-10-03 用户给的流程：「从模拟器发布的入口导入，选择发布间隔时间，点击开始发布」
    //   ⇒ 导入入口放到这一页（原来「发布单」页那个随页签一起删了，现在只剩这一处）
    { act: 'sheet:importReport', label: '导入 AI 内容报告' },
    // ★ 2026-10-03：原「发布单」页的「导出 xlsx」挪到这一页（用户指定的落点）
    { act: 'sheet:export', label: '导出 xlsx' },
    { act: 'pub:connect', label: '连接模拟器' },
    { act: 'pub:exportLog', label: '重导出日志' },
    { act: 'pub:stop', label: '停止', disabled: !running('publish.run') && !running('publish.rerun') },
    { act: 'pub:run', label: '开始发布', primary: true, disabled: !(state.project.publish && state.project.publish.rows && state.project.publish.rows.length) }
  ],
  render() {
    const cfg = state.config.publish;
    const pub = state.project.publish || {};
    const sh = state.project.sheet || {};   // 发布单 xlsx（原「发布单」页那一行挪到这儿）
    const mode = pub.mode || 'mock';
    const rows = pub.rows || [];
    // ★★ 当前生效的发布间隔秒数。**0 是合法值**（连续发布：发完一条直接发下一条），
    //   所以这里不能写 `cfg.intervalSec || 60` —— 那样 0 会被兜成 60，
    //   用户明明选了「连续发布」，界面却按 60 秒算/显示（而主进程那边是按 0 跑的）。
    const ivRaw = Number(cfg.intervalSec);
    const ivNow = (cfg.intervalSec === '' || cfg.intervalSec === null || cfg.intervalSec === undefined
      || !Number.isFinite(ivRaw)) ? 60 : ivRaw;
    // ★ 与主进程 publisher.estimate 同一口径（gapSecFor）：图文「间隔+30s」、视频「间隔+60s」
    //   （视频推得久，还要等媒体库索引）。
    //   视频间隔只在 >0 时单独生效；0 的含义是「跟随主间隔」，与主间隔的 0 = 连续不是一回事。
    const vRaw = Number(cfg.videoIntervalSec);
    const vSec = Number.isFinite(vRaw) && vRaw > 0 ? vRaw : ivNow;
    const est = Math.round(rows.reduce((a, r) => {
      const isV = r.kind === 'video';
      return a + (isV ? vSec : ivNow) + (isV ? 60 : 30);
    }, 0) / 60);
    const okCount = rows.filter(r => r.result === '发布成功').length;
    return `
      <div class="box">
        <h3>装置与节奏</h3>
        <!-- ★ 2026-10-03：原「发布单」页的路径 / 行数 / 打开文件 / 打开目录挪到这儿。
             「导出 xlsx」在右上角动作条里。 -->
        <div class="row" style="margin-bottom:10px">
          <span class="lbl">发布单</span>
          <input class="inp mono" value="${esc(sh.file || '（还没导出过发布单）')}" readonly>
          <span class="chip">${sh.rowCount || 0} 行 · ${sh.colCount || 26} 列</span>
          <span class="chip">${sh.locked ? '被占用' : '未占用'}</span>
          <button class="btn sm" data-act="sheet:open" ${sh.file ? '' : 'disabled'}>打开文件</button>
          <button class="btn sm" data-act="sheet:dir">打开目录</button>
        </div>
        ${devicesHtml()}
        <div class="row" style="margin-top:10px">
          <span class="lbl">发布间隔</span>
          <select class="inp" data-cfg="publish.intervalSec">
            <option value="0" ${ivNow === 0 ? 'selected' : ''}>连续发布 · 发完一条直接发下一条</option>
            ${[30, 60, 90, 120].map(v => `<option value="${v}" ${ivNow === v ? 'selected' : ''}>固定 ${v} 秒</option>`).join('')}
          </select>
          <!-- ★ 2026-10-03 用户要求：发布失败不重试 ⇒「失败重试 N 次」这个下拉与 publish.retry 配置整项删除。
               失败只影响那一条（写「发布失败，原因xxx」），要再发一次就点行尾的「重跑」——那是人点的新任务。 -->
        </div>
        ${ivNow === 0 ? '<p class="hint" style="margin-top:6px">★ 已选 <b>连续发布</b>：上一条发完直接发下一条，中间<b>不再等待</b>。'
          + '注意单条本身仍要花 ≈30 秒（视频 ≈60 秒）—— 那是设备上的真实耗时（推素材 / 上传 / 填内容），不是间隔。</p>' : ''}
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-act="pub:probe">检查能不能发布</button>
          ${((cfg.uiMap || {}).steps ? '' : (canAdmin() ? '<button class="btn sm" data-act="go:advanced">去「高级设置」配 UI 定位表</button>' : ''))}
          <span class="chip">${mode === 'adb' ? '真实设备通道' : '模拟通道'}</span>
          <span class="chip ${(state.config.publish.uiMap || {}).steps ? '' : 'warn'}">${(state.config.publish.uiMap || {}).steps ? '定位表 ' + state.config.publish.uiMap.steps.length + ' 步' : '定位表未配'}</span>
          ${(() => { const m = state.config.publish.uiMap || {}; if (!m.steps) return ''; const vn = (m.videoSteps || []).length; return vn ? `<span class="chip">视频 ${vn} 步</span>` : '<span class="chip">视频复用图文</span>'; })()}
          <span class="chip">批次 ${esc(pub.batch || '（导出发布单后自动命名）')}</span>
        </div>
        ${running('publish.run') || running('publish.rerun') ? progHtml(progFor(running('publish.run') ? 'publish.run' : 'publish.rerun')) : ''}
        <p class="hint">预计 <b>${est} 分钟</b>：单条技术下限 ≈30 秒（视频 ≈60 秒，还要等媒体库索引）${ivNow === 0
          ? '。<b>当前是连续发布，两条之间不再叠加等待</b> —— 上面的预计就是设备真实耗时本身，不是"等待"堆出来的。'
          : ' + 人为间隔 —— <b>93% 的时间是在等间隔</b>，不是性能问题。间隔多长你自己拍板；视频想单独放宽，在配置里设 videoIntervalSec，不设就跟主间隔。'}</p>
        <p class="hint">★ 这一页就是流程的最后一步：<b>导入 AI 内容报告 → 选发布间隔 → 开始发布</b>。
          报告里空着的货号 / 颜色，导入时会按<b>叶子文件夹名</b>（「货号+颜色」，以 + 号分隔）自动补上，
          并写回报告文件（<b>只补空格子，不覆盖你已填的</b>）。</p>
      </div>
      ${reportBoxHtml()}
      ${probeHtml()}
      ${batchesHtml('', '运行中的批次 / 任务')}
      ${rows.length ? `<div class="tw"><table>
        <thead><tr><th>#</th><th>素材目录</th><th>好物</th><th>图片</th><th>开始时间</th><th>耗时</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.result === '失败' || r.result === '校验未通过' ? 'flag' : ''}">
          <td class="num">${r.seq}</td><td class="mono">${esc(r.dir)}</td><td class="num">${n(r.goods)}</td><td class="num">${n(r.images)}</td>
          <td>${esc(r.startAt || '—')}</td><td class="num">${r.elapsed ? r.elapsed + 's' : '—'}</td>
          <td>${badge(r.result || r.status || '排队', kindOf(r.result || r.status || '排队'))}${r.reason ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(r.reason)}</div>` : ''}</td>
          <td>${(r.result && r.result !== '发布成功') ? `<button class="btn sm" data-act="pub:rerun" data-seq="${r.seq}">重跑</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有发布队列，先点右上角「导出 xlsx」生成一份。</div>`}
      <p class="hint">★ <b>颜色校验不是必需项</b>：没做过校验、或目录里的颜色与商品池对不上，<b>都不会拦住发布</b> ——
      发布时按你填的<b>货号</b>在「关联好物」里搜出结果，<b>默认选第一件商品</b>发出去（这条做法已实测可行）。
      ${canAdmin()
        ? `要精确到某个颜色，就到「货号颜色校验」页把颜色核对准。要让机器真按这条做，需要在 UI 定位表里、
      「搜索货号」后面补一步「点第一件商品」（「设置 → 高级设置 → 抓取页面结构」生成的候选表里改）。`
        : `要精确到某个颜色，请联系管理员核对颜色校验（这一页只对管理员开放）。`}</p>
      <p class="hint"><b>内容主图</b>：默认用这个叶子里<b>排在最前面那张</b>（你实拍一般就是先拍的正面照）。
      想让某一张当主图，把它的文件名改成以 <code>1</code> 开头（如 <code>1_微信图片_2026-10-05_031033_240.jpg</code>）——
      程序会把那张排到相册第 1 格（<b>得物取相册第 1 格当内容主图</b>）；<code>10</code>/<code>12</code> 这种编号不会被误认。
      排不成就<b>不发这一条</b>（不会闷着头把主图放错）。</p>
      <p class="hint">已发 ${okCount} / ${rows.length}。发布完还要<b>回查审核状态</b>（创作中心 → 等级权益），发完 ≠ 发出去了。
      「重导出日志」会把 <code>publish-log.jsonl</code> 按批次导成可读的 <code>发布日志_批次_时间戳.log</code>（另有 .csv），
      内容对齐真机：<code>[V] 行 2 [图文] 发布完成，已回填时间 15:34:41（耗时 65.2s）</code>。</p>`;
  }
};

/**
 * ffmpeg 那一行照实说**现在到底用的是哪一个**（三段解析：手填 > 内置 > 系统 PATH）。
 * 不编：取不到状态就说取不到，走 PATH 的明确写「不一定能成」——别让界面骗人。
 */
function ffDesc(f) {
  if (!f) return '状态取不到';
  // ★ 手填的路径不存在时必须**说出来**（哪怕已经退回内置可用）：
  //   静默忽略一个拼错的路径，等于让用户以为配置生效了 —— 与 adb 那边
  //   「手填的路径不存在，已自动退回内置」的口径保持一致。
  if (f.configuredMissing) {
    return f.bundled
      ? `你填的那个不存在，已退回内置：${f.path}`
      : `你填的「${f.path}」不存在，且没有内置可用`;
  }
  if (f.source === 'configured') return `用你指定的：${f.path}`;
  if (f.source === 'bundled') return '程序内置（装完即用，不用自己找）';
  return '用系统 PATH 里的 ffmpeg（不确定有没有）';
}
function ffBadge(f) {
  if (!f) return ['warn', '未知'];
  if (f.configuredMissing) return ['warn', '路径不存在'];
  if (f.source === 'configured') return ['ok', '已指定'];
  if (f.source === 'bundled') return ['ok', '内置'];
  if (f.source === 'configured-missing') return ['warn', '不可用'];
  return ['warn', '走 PATH'];
}

/**
 * 「外部依赖」表里**得物 App 安装包**那一行的文案与按钮。
 *
 * ★ 为什么这一行要单独给按钮：MuMu 自带的应用商店里**搜不到得物**，用户拿到一台新模拟器
 *   就卡在这一步。这里给两个出口：① 把内置的 apk 另存到本机（好拖进 MuMu 窗口）；
 *   ② 直接用内置的 adb 装进去。
 * ★ 只写实际读到的事实：字节数按 info 里那份真实大小算，读不到就写「缺」——
 *   不许出现「127 MB」这种写死的数字（换了个版本的包就变成假信息了）。
 */
function apkDesc(a) {
  if (!a || !a.exists) return '没内置：要自己找安装包（模拟器自带的应用商店里搜不到得物）';
  const mb = a.bytes ? (a.bytes / 1048576).toFixed(1) : '';
  return `内置 dewu ${a.version}${mb ? `（${mb} MB` : '（'} · 只有 arm64 版）`;
}
function apkBadge(a) {
  if (!a || !a.exists) return ['warn', '缺'];
  if (!a.sizeOk) return ['warn', '不完整'];
  return ['ok', '内置'];
}
function apkBtns(a, already) {
  const dis = (a && a.exists && a.sizeOk) ? '' : ' disabled';
  return `<button class="btn sm" data-act="apk:save"${dis}>下载到本机</button>`
    + ` <button class="btn sm" data-act="apk:install"${dis}>装进模拟器</button>`
    // 「覆盖重装」只在"设备上已经装了"之后出现 —— 用户没点过之前不给他这个危险按钮
    + (already ? ` <button class="btn sm" data-act="apk:installForce"${dis}>覆盖重装</button>` : '');
}

TABS[7] = {
  title: '设置',
  // ★ desc 支持函数（renderAll 里求值）：非管理员这一页没有「应用更新」那块，
  //   副标题就不该提它 —— 界面文字得跟界面上真有的东西对得上。
  // ★ 2026-10-04：副标题里原来的「路径、」也一并去掉 —— 那一块已经从页面上撤掉，
  //   副标题再提它就是「界面文字跟界面上真有的东西对不上」（见下面那条注释的同一条原则）。
  desc: () => (canAdmin() ? '应用更新、外部依赖' : '外部依赖'),
  actions: () => [{ act: 'cfg:save', label: '保存', primary: true }],
  render() {
    const info = state.info || {};
    const dep = [
      // ★ 2026-10-08：这句原来写「（含 HEIC）」—— 和下一行「HEIC 解码 · 不可用」直接打架，
      //   而且不真：实测同一份 libvips 能读写 AVIF(av1)、但解码真 HEVC 必失败。
      //   「图片处理 / 取色」这行讲的是引擎本身，编码能力交给下一行单独交代，这里不再提具体格式。
      ['图片处理 / 取色', info.engine === 'sharp' ? 'sharp + libvips' : 'jpeg-js + pngjs（纯 JS 降级）', info.engine === 'sharp' ? ['ok', '内置'] : ['warn', '降级']],
      // ★★ 2026-10-08：**写死为「不可用」**。
      //   原来写的是 `info.hasHeif ? ['ok','可用'] : ...`，而 hasHeif() 只等于
      //   `engine === 'sharp'`（sharp 原生模块加载成功），**从没探测过能不能解 HEIC**。
      //   实测（sharp 0.33.5 预编译，包内那份 libvips-42.dll，sha256 92076cb1…）：
      //     真 HEVC 的 .heic → metadata() 能读（compression=hevc），真解码必报
      //     「heif: No decoding plugin installed for this compression format」；
      //     dll 里 libde265 符号命中 0（对照 aom 41 / vips 2387），只有 AV1 解码。
      //   ⇒ 面板原来那枚「可用」是**假绿**：装到哪台机器都一样解不开。
      //   因专利原因预编译 libvips 不带 HEVC 解码器，这不是配置问题，所以这里不给它「可能可用」的余地。
      ['HEIC 解码', '不可用 · HEIC 需先转 JPG', ['warn', '不可用']],
      ['发布单读写', 'exceljs', ['ok', '内置']],
      ['视频时长读取', '纯 JS MP4/MOV 解析（moov → mvhd）', ['ok', '内置']],
      ['视频转 MP4（得物只收 mp4）', ffDesc(info.ffmpeg), ffBadge(info.ffmpeg)],
      ['模拟器驱动 adb',
        (info.vendor && info.vendor.exists) ? '程序内置（装完即用，不用自己找）' : '没内置：要自己指定 adb.exe 的路径',
        (info.vendor && info.vendor.exists) ? ['ok', '内置'] : ['warn', '需指定']],
      ['中文输入法 ADBKeyboard',
        (info.vendor && info.vendor.apkExists)
          ? '程序内置（连接设备后自动安装并启用）'
          : '安装包缺少内置文件：请修复或重新安装本工具',
        (info.vendor && info.vendor.apkExists) ? ['ok', '内置'] : ['warn', '缺']],
      // ★★ 2026-10-08 用户要求新增：MuMu 自带的应用商店里**搜不到得物**，新模拟器就卡在这一步。
      //   这一行比别的行多两枚按钮（第 4 项，见下面 depRow 的注释）：
      //     · 下载到本机   —— 把内置的 apk 另存到用户选的位置（存完自动打开那个文件夹，好拖进 MuMu）
      //     · 装进模拟器   —— 用内置的 adb 直接装；**已经装过就不动它**（登录状态与草稿都在设备上）
      //   ★ 两个按钮都能点的时候才给，内置那份缺失/不完整时一律 disabled ——
      //     按钮点下去才发现装不了，比一开始就灰着更让人火大。
      ['得物 App 安装包（模拟器商店里搜不到得物时用）', apkDesc(info.dewuApk), apkBadge(info.dewuApk), apkBtns(info.dewuApk, state.dewuAlready)]
    ];
    return `
      <!-- ★★ 2026-10-04 用户要求：整块「路径」（输出目录 / 隔离目录 + 两个「修改」按钮）
           对所有人隐藏 —— 挂在设置页最上面纯属干扰。
           ★ 只撤界面入口，**底层读取链一条都没动**：两个目录的出厂默认值在 winpath.js，
             合规报告 / 运行日志 / 品牌统计 / 隔离被拒素材照旧读 paths.output / paths.rejected。
             （「隐藏」不等于「删功能」—— 删了读取链，导出报告和日志会直接报「没有配置输出目录」。）
           ★ 同时删掉的还有 data-act="cfg:path" 那个 action 处理器：入口没了还留着处理器就是死代码，
             将来有人会以为「这功能还在，只是没显示」。 -->
      <!-- ★ 原先这里有一整块「外观」（主题说明 + 运行环境）—— 2026-10-03 按用户要求撤掉：
           主题入口只留顶栏那一个，设置里再复述一遍纯属重复（两处状态迟早各说各话）；
           「运行环境」那行没丢，挪到下面「外部依赖」里了。 -->
      <!-- ★ 2026-10-03 用户要求：**非管理员**在设置页看不到「应用更新 / 版本信息」整块。
           这里只是不给人添乱；真正拦住的是主进程那道 guardAdmin（前端改一行不算数）。
           版本号没丢 —— 挪到标题栏 app 名字后面（#appVer），见 index.html / renderAll。 -->
      ${canAdmin() ? updateHtml() : ''}
      <div class="box">
        <h3>外部依赖</h3>
        <div class="tw"><table>
          <thead><tr><th>用途</th><th>依赖</th><th>状态</th></tr></thead>
          <!-- 第 4 项（可选）= 状态栏里额外那几枚按钮的 HTML；只有得物安装包那一行有它，
               其余行照旧只显示一枚 badge —— 与其为一行把整张表改宽，不如按行给。 -->
          <tbody>${dep.map(([a, b, s, act]) => `<tr><td>${esc(a)}</td><td class="mono">${esc(b)}</td><td>${badge(s[1], s[0])}${act || ''}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">模拟器自带的应用商店里搜不到得物时，用上面那一行：
          <b>①「下载到本机」</b> —— 把 apk 存到你选的位置（存完会自动打开那个文件夹），
          然后<b>把 apk 直接拖进 MuMu 窗口</b>（或拖进 MuMu 的共享文件夹），拖进去就会自动安装。
          <b>②「装进模拟器」</b> —— 本工具用内置的 adb 直接装，前提是：模拟器已启动、ADB 调试已打开，
          并且「模拟器发布」页已经选中了这台设备。
          <br>★ <b>已经装过得物就不会再动它</b>：动手前先读一遍设备，已经装了就把版本告诉你、一条安装命令都不发
          （得物里是登录状态和本地草稿）。确实要覆盖重装时，这一行会多出一个「覆盖重装」按钮
          （<code>-r</code> 安装：应用数据与登录状态保留）。</p>
        <div class="row"><span class="lbl">运行环境</span>
          <span class="chip">${info.isWin ? 'Windows' : esc(info.platform)} · Electron ${esc(info.electron || '')}</span>
        </div>
      </div>`;
  }
};

/* ---------------- 页签 11：高级设置（仅管理员可见） ----------------
 * ★ 为什么单开一页：这里全是「装一次、之后再也不动」的配置 —— UI 定位表、
 *   货号颜色接口、adb 与 ffmpeg 路径。把它们平铺在日常页面上只是干扰
 *   （用户原话：「为什么放了这么多实际根本不会点击使用的功能」）。
 * ★ 2026-10-08：「文案模型」这一块**已搬走** —— 用户要求模型配置成为**唯一入口**，
 *   放到日常真正会用的「文案生成」页（做成弹窗），这一页不再有它。
 * ★ 但**不许删**：真实通道必须先有 UI 定位表（publisher.run 会直接 throw），
 *   中文输入法不装则中文一个字都发不出去 —— 它们只是「不常点」，不是「没用」。
 * ★ 仅管理员可见：藏起来只是不给人添乱，真正拦住的是主进程那几道 guard。
 */
TABS[11] = {
  title: '高级设置',
  admin: true,
  desc: '装一次就不再动的配置：UI 定位表、并发路数、货号颜色接口、adb / ffmpeg 路径（仅管理员可见）',
  actions: () => [{ act: 'cfg:save', label: '保存', primary: true }],
  render() {
    const c = state.config;
    const info = state.info || {};
    const pub = c.publish || {};
    // ★★ 2026-10-08 用户要求：「云端协作」整块从**界面上删掉**，不给任何人看到
    //    （原话：「默认开，这个部分直接删了，不用给任何人看到」）。
    //    ★ 删的是**界面**，不是功能：「cloud」块的 enabled 键出厂默认 true（src/main/store.js），
    //      地址 / anon key / org 走 src/main/clouddefaults.js 的内置值，
    //      上行链路（src/main/services/cloudsync.js）**一个字节没动** —— 各台机器照样上行，
    //      只是没人能在界面上看见它、也没人能在界面上关掉它。
    //    ★ 同步失败不影响发布（发布核心不依赖它）；要停某台机器仍然只能改它自己的
    //      它自己 config.json 里那个「cloud」块的 enabled 键（界面不再提供入口，这是刻意的）。
    //    ★★ 别再往这一页加回任何 cloud.* 控件或导出/导入弹窗 —— 用户要的就是「看不见」。
    const map = pub.uiMap || {};
    const steps = map.steps || [];
    const vsteps = map.videoSteps || [];
    return `
      <div class="box">
        <h3>UI 定位表（真实发布必需）</h3>
        <div class="row">
          <span class="chip ${steps.length ? '' : 'warn'}">${steps.length ? '图文已配 ' + steps.length + ' 步' : '图文未配'}</span>
          <span class="chip">${vsteps.length ? '视频单独配了 ' + vsteps.length + ' 步' : '视频复用图文（默认）'}</span>
          <button class="btn sm" data-act="pub:dump">抓取页面结构</button>
          <button class="btn sm" data-act="pub:map">导入 UI 定位表</button>
        </div>
        <p class="hint">得物 App 的发布页结构会随版本变，所以「按钮 / 输入框在哪」做成了可抓取的定位表。
          <b>没配这张表，真实通道会直接拦下</b>（宁可不发，也不瞎点）。做法：设备连上并停在得物发布页 →
          点「抓取页面结构」→ 输出目录里生成一份候选 uiMap.json → 核对后点「导入 UI 定位表」导进来。</p>
        <p class="hint">★ <b>视频和图文用的是同一套位置</b>（2026-10-02 实测）⇒ 只要抓一次<b>图文</b>发布页就够了，
          视频会<b>自动复用</b>这套 steps，不用再抓一遍。哪天真机改版、视频那条路跟图文不一样了，
          再单独抓一次配 videoSteps 覆盖（配了就以它为准）。</p>
      </div>
      <!-- ★ 2026-10-08 用户要求：「模型配置」从这一页**直接删掉**，搬到「文案生成 → 模型配置」弹窗，
           并且成为**唯一**入口（原话：「后续模型调用都通过这个口子来，设置里的模型直接删了」）。
           ★ 删的是**入口**，不是功能：copy.llm.* 这些键、主进程 copywriter.cfgOf() 的读取口径一个字节没动，
             弹窗写的还是同一份配置 ⇒ 旧的部署不用担心迁移（留空＝跟随内置那套也照旧）。
           ★ 别在这里再放一份「模型」控件 —— 两处能改同一个键，改完谁生效就说不清了。 -->
      ${advBox('文案生成并发', false,
        `<div class="row">
          <span class="lbl">并发路数</span>
          <select class="inp" data-cfg="copy.concurrency">${[4, 5, 6, 7, 8].map(v => `<option value="${v}" ${c.copy.concurrency === v ? 'selected' : ''}>${v} 路</option>`).join('')}</select>
        </div>
        <p class="hint">同时发起几路模型请求。按<b>并发路数均分</b>（不是「15 条/批」切批，尾批会把整体拖慢）${
          ((state.project || {}).items || []).length
            ? ` —— 当前 ${state.project.items.length} 篇 → ${c.copy.concurrency} 路 × ${Math.ceil(state.project.items.length / (c.copy.concurrency || 6))} 篇`
            : ''
        }。路数越大越快，但<b>撞接口限流的概率也越高</b>；出厂 6 路，一般不用动。</p>`,
        '影响速度 · 出厂 6 路')}
      ${advBox('货号颜色查询方式', false,
        `<div class="row" style="margin-bottom:9px"><span class="lbl">方式</span>
          <select class="inp" data-cfg="verify.mode">
            <option value="local" ${c.verify.mode === 'local' ? 'selected' : ''}>本地商品池（导入 CSV）</option>
            <option value="api" ${c.verify.mode === 'api' ? 'selected' : ''}>接口查询（得物后台）</option>
          </select>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">SKU 接口</span><input class="inp mono" value="${esc(c.verify.api.endpoint)}" data-cfg="verify.api.endpoint" placeholder="https://…/sku-colors"></div>
        <div class="row"><span class="lbl">API Key</span><input class="inp mono" type="password" value="${esc(c.verify.api.apiKey)}" data-cfg="verify.api.apiKey"></div>`,
        '出厂 = 本地商品池')}
      ${advBox('外部依赖路径（一般留空）', false,
        `<div class="row" style="margin-bottom:9px"><span class="lbl">adb 路径</span>
          <input class="inp mono" value="${esc(pub.adbPath || '')}" data-cfg="publish.adbPath"
            placeholder="留空 = 自动（优先程序内置的，再退系统 PATH）"></div>
        <div class="row"><span class="lbl">ffmpeg 路径</span>
          <input class="inp mono" value="${esc(pub.ffmpegPath || '')}" data-cfg="publish.ffmpegPath"
            placeholder="留空 = 自动（优先程序内置的，再退系统 PATH）"></div>
        <p class="hint">两个都是<b>装完即用</b>，正常不用填。填了就以你填的为准；填的路径不存在会自动退回内置那份，
          并在「设置 → 外部依赖」表里如实标出<b>「路径不存在」</b>（不会静默忽略你拼错的路径）。
          改完<b>立刻生效、不用重启</b>。</p>
        <p class="hint">ffmpeg 用来把 <code>.mov</code> / <code>.m4v</code> 等转成 <code>.mp4</code>（得物只收 mp4）：
          优先<b>无损转封装</b>（秒级、画质零损失），转封装放不下（如 ProRes）才转码成 H.264/AAC，转完会校验产物确实是 mp4。</p>`,
        '内置即用 · 没特殊情况不要动')}
    `;
  }
};

/* ---------------- 应用更新（阶段 2：正式版 / 测试版两条通道，同一个包） ---------------- */
/** 状态 → [徽章样式, 文案]。键要和 src/main/updater.js 里的 status 一一对应 */
const UPD_KIND = {
  idle: ['wait', '未检查'], checking: ['run', '检查中'], available: ['warn', '有新版本'],
  downloading: ['run', '下载中'], ready: ['ok', '可以安装'], uptodate: ['ok', '已是最新'],
  error: ['bad', '出错']
};

function updateHtml() {
  const u = state.upd;
  if (!u) return `<div class="box" id="updBox"><h3>应用更新</h3><p class="hint">正在读取更新状态…</p></div>`;

  // 开发模式 / 便携版：不摆一堆点了没用的按钮，只把原因写清楚
  if (!u.supported) {
    return `<div class="box" id="updBox">
      <h3>应用更新</h3>
      <div class="row"><span class="lbl">当前版本</span><span class="chip mono">${esc(u.current || '—')}</span>${badge('不可用', 'wait')}</div>
      <!-- 主进程没给出原因时别编一个：说「原因没取到」比说「这个版本就是不支持」诚实 -->
      <p class="hint">${esc(u.message || '取不到不可用的原因（更新模块可能没初始化）')}</p>
    </div>`;
  }

  const [kind, label] = UPD_KIND[u.status] || ['wait', u.status || '—'];
  const pct = Math.max(0, Math.min(100, Math.round(u.percent || 0)));
  const dl = u.status === 'downloading';
  const mb = v => (v ? (v / 1024 / 1024).toFixed(1) + ' MB' : '—');
  const newer = u.latest && u.latest !== u.current;
  // 「谁能切测试版」跟主进程 guardAdmin 一个口径：登录校验关着（免登录 / 开发模式）也算有权限。
  // ★ 没权限的人不只是禁用按钮 —— 连「测试版」这三个字都不许出现在界面上。
  // 所以 isBeta 也跟着 canBeta 走：万一配置里还留着 beta（比如管理员切过之后换了账号），
  // 普通成员这一页也只会看到「正式版」，不会因为一个残留值露出通道字样。
  const canBeta = canAdmin();
  const isBeta = canBeta && u.channel === 'beta';   // 老快照没有 channel 字段 ⇒ 当作正式版

  return `<div class="box" id="updBox">
    <h3>应用更新</h3>
    <div class="row" style="margin-bottom:9px">
      <span class="lbl">当前版本</span><span class="chip mono">${esc(u.current || '—')}</span>
      ${newer ? `<span class="lbl">新版本</span><span class="chip mono">${esc(u.latest)}</span>` : ''}
      ${badge(label, kind)}
    </div>
    ${canBeta ? `<div class="row" style="margin-bottom:9px">
      <span class="lbl">更新通道</span>
      <button class="btn sm${isBeta ? '' : ' primary'}" data-act="upd:chan:stable" ${dl ? 'disabled' : ''}>正式版</button>
      <button class="btn sm${isBeta ? ' primary' : ''}" data-act="upd:chan:beta" ${dl ? 'disabled' : ''}>测试版</button>
      ${badge(u.channelLabel || (isBeta ? '测试版' : '正式版'), isBeta ? 'warn' : 'ok')}
    </div>` : ''}
    ${dl ? `<div class="progwrap"><div class="bar" id="updBar"><i style="width:${pct}%"></i></div>
      <span class="chip" id="updTxt">${pct}% · ${mb(u.transferred)} / ${mb(u.total)}${u.bytesPerSecond ? ' · ' + mb(u.bytesPerSecond) + '/s' : ''}</span></div>` : ''}
    <div class="row" style="margin-top:9px">
      <button class="btn sm" data-act="upd:check" ${dl ? 'disabled' : ''}>检查更新</button>
      <button class="btn sm${(u.status === 'available' || u.status === 'idle') ? ' primary' : ''}" data-act="upd:download" ${(dl || u.status === 'ready') ? 'disabled' : ''}>下载更新</button>
      <button class="btn sm${u.status === 'ready' ? ' primary' : ''}" data-act="upd:install" ${u.status === 'ready' ? '' : 'disabled'}>立即安装并重启</button>
    </div>
    ${u.message ? `<p class="hint">${esc(u.message)}</p>` : ''}
    <p class="hint">发现新版本<b>不会自动下载</b>，下载完<b>也不会自动重启</b> —— 两步都要你点。
    「立即安装」在有任务跑着的时候会被拦住（重启会把跑一半的发布掐断）。</p>
    ${canBeta ? `<p class="hint">${isBeta
      ? '<b>当前在测试版通道</b>：比正式版早拿到新功能，但没经过正式验收。随时可以切回正式版 —— 切回去时允许降级，不用重装。'
      : '测试版比正式版早拿到新功能，但<b>没经过正式验收</b>。切通道只是换个清单文件，不用重装、也不会失联。'}</p>` : ''}
  </div>`;
}

async function refreshUpdate() {
  try { state.upd = await appApi.updateStatus(); } catch (e) { /* 读不到就保持原样 */ }
  renderAll();
}

/**
 * 切更新通道（正式版 ↔ 测试版）。
 * ★ 这里**不动源地址**（源地址编译在包里，改不了也不许改），只换「读源上哪个清单文件」：
 *   正式版读 latest.yml、测试版读 beta.yml。所以切换不需要重装，也不会失联。
 */
async function switchUpdateChannel(next) {
  let r = null;
  try { r = await appApi.updateSetChannel(next); } catch (e) { r = null; }
  if (!r || r.ok === false) {
    toast((r && r.error) || '切换通道失败（取不到原因）', 'err');
    renderAll();
    return;
  }
  toast(r.unchanged ? `已经在${r.label}通道了` : `已切到${r.label}通道，点「检查更新」看看有没有新版本`, r.unchanged ? '' : 'ok');
  await refreshUpdate();
}

/** 下载进度每秒好几条，只动进度条那两处，别整页重画（会把正在输入的框重置掉） */
function updateUpdateBar(u) {
  const bar = document.querySelector('#updBar i');
  const txt = document.querySelector('#updTxt');
  if (!bar || !txt) return;
  const pct = Math.max(0, Math.min(100, Math.round(u.percent || 0)));
  const mb = v => (v ? (v / 1024 / 1024).toFixed(1) + ' MB' : '—');
  bar.style.width = pct + '%';
  txt.textContent = `${pct}% · ${mb(u.transferred)} / ${mb(u.total)}${u.bytesPerSecond ? ' · ' + mb(u.bytesPerSecond) + '/s' : ''}`;
}

/* ---------------- ⑧ 品牌统计 ---------------- */
function daysLabel(d) { return Number(d) > 0 ? `最近 ${d} 天` : '全部时间'; }

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadStats() {
  if (state.statsBusy) return;
  state.statsBusy = true;
  state.statsTried = true;
  try {
    const r = await appApi.statsQuery(state.statsOpts);
    state.stats = r && r.ok ? r : { error: (r && r.error) || '查询失败' };
  } catch (e) {
    state.stats = { error: (e && e.message) || '查询失败' };
  }
  state.statsBusy = false;
  renderAll();
}

/** 频次柱：一天一根，高度按最大值归一。0 的那天画成细灰线（表示「这天真的没有」，不是漏画） */
function sparkHtml(byDay, max) {
  const days = byDay || [];
  if (!days.length) return '<span style="opacity:.5">—</span>';
  const m = max || Math.max(1, ...days.map(d => d.rows));
  return `<span class="spark" title="${esc(days.map(d => `${d.date} ${d.rows} 条`).join('\n'))}">${days.map(d => {
    const h = d.rows ? Math.max(3, Math.round(d.rows / m * 22)) : 2;
    return `<i class="${d.rows ? '' : 'zero'}" style="height:${h}px"></i>`;
  }).join('')}</span>`;
}

TABS[8] = {
  title: '品牌统计',
  desc: '按品牌看发布频次、数量与执行日志 · 未标品牌的历史记录单独列出，不并入任何品牌',
  actions: () => [
    { act: 'stats:refresh', label: '查询', primary: true },
    // 「导出 xlsx」是整套统计（4 张表）；「导出执行日志」只要这一份日志，且**条数完整**
    // （xlsx 里那张执行日志表过去只导最近 100 条，界面上一句不提 → 对账会对不上）
    { act: 'stats:export', label: '导出 xlsx', disabled: !(state.stats && !state.stats.error) },
    { act: 'stats:exportLog', label: '导出执行日志', disabled: !(state.stats && !state.stats.error) },
    // 日志是「追加写、失败不报错」的：输出目录指向共享盘时，盘掉线会**静默少数据**，
    // 所以给一颗按钮让管理员当场问一句「这台机器现在写得进去吗」
    { act: 'stats:checkPath', label: '检测输出目录' }
  ],
  render() {
    const s = state.stats;
    const m = state.brandsMeta || { brands: [], mine: [], isAdmin: false };
    const usable = (m.brands || []).filter(b => (m.mine || []).includes(b.id));
    const head = `
      <div class="box">
        <div class="acct-toolbar" style="margin-top:0">
          <span class="lbl">时间范围</span>
          <select class="inp" id="stDays">${[[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天'], [0, '全部时间']].map(([v, t]) => `<option value="${v}" ${Number(state.statsOpts.days) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <span class="lbl">品牌</span>
          <select class="inp" id="stBrand">
            <option value="">全部品牌</option>
            ${usable.map(b => `<option value="${b.id}" ${state.statsOpts.brandId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            ${m.isAdmin ? '<option value="__none__" ' + (state.statsOpts.brandId === '__none__' ? 'selected' : '') + '>未标品牌</option>' : ''}
          </select>
          ${m.isAdmin ? `<span class="lbl">执行人</span>
          <select class="inp" id="stUser"><option value="">全部执行人</option>${((s && s.users) || []).map(u => `<option value="${esc(u.userId)}" ${state.statsOpts.userId === u.userId ? 'selected' : ''}>${esc(u.displayName || u.username || '未记录')}（${u.rows}）</option>`).join('')}</select>` : ''}
          <button class="btn sm primary" data-act="stats:refresh">查询</button>
          <span class="chip ${m.isAdmin ? 'chip-user' : ''}">${m.isAdmin ? '管理员：全部品牌' : `你名下 ${usable.length} 个品牌`}</span>
        </div>
      </div>`;
    if (!s) return head + '<div class="empty">正在读取发布日志…（若一直停在这里，说明输出目录不可读）</div>';
    if (s.error) return head + `<div class="empty">查询失败：${esc(s.error)}</div>`;

    const t = s.totals;
    const notes = (s.notes || []).length
      ? `<div class="box" style="border-color:var(--amber)"><h3>口径说明</h3>${s.notes.map(x => `<p class="hint" style="margin:4px 0">· ${esc(x)}</p>`).join('')}</div>`
      : '';

    const maxRows = Math.max(1, ...[...s.brands, s.untagged, ...s.orphans].map(b => b.rows));
    const rowOf = (b, cls, label) => `<tr class="${cls || ''}">
      <td>${label || `<b>${esc(b.name)}</b>`}</td>
      <td>${b.orphan ? badge('品牌已删除', 'bad') : (b.enabled === false ? badge('已停用', 'wait') : badge('启用', 'ok'))}</td>
      <td class="num">${b.rows}</td>
      <td class="num">${b.ok}</td>
      <td class="num">${b.fail}</td>
      <td class="num">${b.batches}</td>
      <td class="mono">${esc(b.lastDay || '—')}</td>
      <td>${sparkHtml(b.byDay, maxRows)}</td>
      <td class="cut">${b.users.length ? esc(b.users.map(u => `${u.displayName || u.username || '（未记录执行人）'} ${u.rows}`).join(' / ')) : '<span style="opacity:.6">（无记录）</span>'}</td>
    </tr>`;

    const summary = `<div class="tw"><table>
      <thead><tr><th>品牌</th><th>状态</th><th>条数</th><th>成功</th><th>失败</th><th>批次</th><th>最近发布</th><th>频次</th><th>执行人（条数）</th></tr></thead>
      <tbody>
        ${s.brands.map(b => rowOf(b)).join('')}
        ${rowOf(s.untagged, 'brandrow-flag', `<b>${esc(s.untagged.name)}</b><div style="font-size:11px;opacity:.75">历史记录 / 发布时没选品牌</div>`)}
        ${s.orphans.map(o => rowOf(o, 'brandrow-dead')).join('')}
      </tbody></table></div>
      <p class="hint">「频次」是按天画的柱：柱高 = 当天条数，细灰线 = 当天 0 条（是「真的没有」，不是没画）。
      条数按 <code>publish-log.jsonl</code> 逐条统计；「执行日志」按 <code>run-log.jsonl</code> 的<b>任务级</b>记录。</p>`;

    // 按天明细：只列「有数据的那些天」。时间范围=全部时没有密集序列，就从各品牌的 byDay 合并出来
    const dayMap = new Map();
    if (s.daily && s.daily.length) {
      for (const d of s.daily) dayMap.set(d.date, d);
    } else {
      for (const b of [...s.brands, s.untagged, ...s.orphans]) {
        for (const d of b.byDay) {
          const cur = dayMap.get(d.date) || { date: d.date, rows: 0, ok: 0, fail: 0, other: 0 };
          cur.rows += d.rows; cur.ok += d.ok; cur.fail += d.fail; cur.other += d.other;
          dayMap.set(d.date, cur);
        }
      }
    }
    const daysWith = [...dayMap.values()].filter(d => d.rows > 0).sort((a, b) => a.date < b.date ? 1 : -1);
    const dailyBox = `<div class="box">
      <h3>按天频次（${esc(s.range.label)}${state.statsOpts.brandId ? ' · 已按品牌筛选' : ''}）</h3>
      ${s.daily && s.daily.length ? `<div class="spark" style="height:64px;gap:3px">${(() => {
        const mx = Math.max(1, ...s.daily.map(d => d.rows));
        return s.daily.map(d => `<i class="${d.rows ? '' : 'zero'}" style="width:auto;flex:1;height:${d.rows ? Math.max(4, Math.round(d.rows / mx * 64)) : 2}px" title="${esc(d.date)}：${d.rows} 条"></i>`).join('');
      })()}</div>
      <p class="hint">${esc(s.daily[0] ? s.daily[0].date : '')} → ${esc(s.daily[s.daily.length - 1] ? s.daily[s.daily.length - 1].date : '')}</p>` : ''}
      ${daysWith.length ? `<div class="tw" style="margin-top:10px"><table>
        <thead><tr><th>日期</th><th>条数</th><th>成功</th><th>失败</th><th>其他</th></tr></thead>
        <tbody>${daysWith.slice(0, 60).map(d => `<tr><td class="mono">${esc(d.date)}</td><td class="num">${d.rows}</td><td class="num">${d.ok}</td><td class="num">${d.fail}</td><td class="num">${d.other}</td></tr>`).join('')}</tbody>
      </table></div>${daysWith.length > 60 ? `<p class="hint">只显示最近 60 天，完整数据请「导出 xlsx」。</p>` : ''}` : '<p class="hint">这个范围里还没有发布记录。</p>'}
    </div>`;

    const LOG_LEVEL = { ok: ['完成', 'ok'], error: ['失败', 'bad'], warn: ['告警', 'warn'], run: ['开始', 'run'], info: ['', 'wait'] };
    const logBadge = lv => {
      const [t, k] = LOG_LEVEL[lv] || LOG_LEVEL.info;
      return t ? badge(t, k) : '<span style="opacity:.4">·</span>';
    };
    const logs = (s.logs || []).length ? `<div class="tw"><table>
      <thead><tr><th>时间</th><th>品牌</th><th>执行人</th><th>任务</th><th>批次</th><th>级别</th><th>说明</th></tr></thead>
      <tbody>${s.logs.map(e => `<tr class="${e.level === 'error' ? 'flag' : (e.level === 'warn' ? 'warnrow' : '')}">
        <td class="mono">${esc(fmtTs(e.ts))}</td>
        <td>${esc(e.brandName || '未标品牌')}</td>
        <td>${esc(e.displayName || e.username || '—')}</td>
        <td class="cut">${esc(e.label || e.type || '')}</td>
        <td class="mono cut">${esc(e.batch || '')}</td>
        <td>${logBadge(e.level)}</td>
        <td class="cut">${esc(e.msg || '')}</td>
      </tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">这个范围里没有任务执行日志。</div>';
    // 「屏幕上列了几条」和「一共几条」分开说 —— 只写「最近 100 条」，会让人以为一共就 100 条
    const shownLogs = (s.logs || []).length;
    const totalLogs = Number(s.logsTotal == null ? shownLogs : s.logsTotal);
    const logHint = totalLogs > shownLogs
      ? `屏幕上只列最近 <b>${shownLogs}</b> 条（一屏放不下）；按当前筛选条件<b>一共 ${totalLogs} 条</b>。「导出执行日志」会把 <b>${totalLogs} 条全部</b>导出。`
      : `「导出执行日志」会把符合当前筛选条件的这 <b>${totalLogs}</b> 条导成 <code>.log</code>（给人看）+ <code>.csv</code>（给 Excel），条数与筛选条件会写进文件头。`;

    return head + `
      <div class="stats">
        <div class="stat good"><b>${t.rows}</b><span>发布条数</span></div>
        <div class="stat good"><b>${t.ok}</b><span>成功</span></div>
        <div class="stat bad"><b>${t.fail}</b><span>失败</span></div>
        <div class="stat"><b>${t.batches}</b><span>批次数</span></div>
        <div class="stat"><b>${t.runs}</b><span>任务次数</span></div>
        <div class="stat ${t.runFails ? 'bad' : ''}"><b>${t.runFails}</b><span>任务失败</span></div>
        <div class="stat"><b>${s.brands.length}</b><span>品牌数</span></div>
      </div>
      <div class="box">
        <div class="tagline">
          <span class="chip">范围：${esc(s.range.label)}（${esc(s.range.from)} → ${esc(s.range.to)}）</span>
          <span class="chip">发布日志 ${t.totalInLog} 条 / 命中 ${t.consideredInRange}</span>
          <span class="chip">运行日志 ${s.sources.runLog.entries} 条 · ${kb(s.sources.runLog.size)}</span>
          ${t.filtered ? '<span class="chip warn">已按条件筛选</span>' : ''}
        </div>
        <p class="hint" style="margin-top:8px">数据文件：<code>${esc((s.sources.publishLog.file || '').replace(/^\\\\\?\\/, ''))}</code> ·
          <code>${esc((s.sources.runLog.file || '').replace(/^\\\\\?\\/, ''))}</code> —— 只追加、不自动裁剪，要清理由你自己决定。</p>
        <p class="hint" style="margin-top:4px">⚠️ 这一页统计的是<b>本机这个输出目录</b>里的记录：别的电脑各写各的目录，这里看不到。
          要让管理员的统计收齐所有电脑，就得把各台的「输出目录」都指到<b>同一个共享位置</b>（局域网共享 / 映射盘）；
          但日志是「写失败也不报错」的，共享盘一掉就会悄悄少数据 —— 所以改完先点<b>「检测输出目录」</b>确认写得进去。</p>
        ${state.statsPath ? `<div class="tagline" style="margin-top:6px">
          <span class="chip ${state.statsPath.ok ? '' : 'warn'}">输出目录自检：${state.statsPath.ok ? '正常' : '有问题'}</span>
          ${(state.statsPath.checks || []).map(c => `<span class="chip ${c.ok ? '' : 'warn'}">${c.ok ? '✓' : '✗'} ${esc(c.name)}</span>`).join('')}
        </div>
        ${state.statsPath.ok ? '' : `<p class="hint" style="color:var(--red)">${esc(state.statsPath.error || '自检未通过')}</p>`}
        <p class="hint">目录：<code>${esc(state.statsPath.dir || '')}</code>${(state.statsPath.checks || []).map(c => ` · ${esc(c.name)}：${esc(c.detail || '')}`).join('')}</p>` : ''}
      </div>
      ${notes}
      <div class="box"><h3>按品牌汇总（${esc(daysLabel(state.statsOpts.days))}）</h3>${summary}</div>
      ${dailyBox}
      <div class="box"><h3>执行日志（显示最近 ${shownLogs} 条 / 共 ${totalLogs} 条）</h3>${logs}<p class="hint">${logHint}</p></div>`;
  }
};

/* ---------------- ⑫ 热词库（单开一屏） ----------------
 * ★ 为什么单开一屏：它是**低频维护**（想加几个词才来一次），而「生成文案」是**高频动作** ——
 *   混一屏既容易误触生成，跑生成时又被词表挡路。（这条口径 2026-10-03 之前就定了。）
 * ★ 可编辑的是 **7 组词**（风格 / 氛围 / 色感 / 场景 / 人群 / 季节 / 情绪）。
 *   「收尾」组这一版**锁定**（用户拍板：先不放开）；T01~T15 **句式骨架一律不可编辑** ——
 *   骨架是**语法**（连接字在第几位、收尾在末尾），改坏会直接产出病句，而判据只能事后告警、拦不住。
 * ★★ 「改了到底吃不吃得到」：词库的读法已经全部改成**现取**（`hotwords.currentGroups()` /
 *   `copycheck.prefixWords()`），所以**保存完下一次生成就用新词，不用重启**。
 *   ★ 但「关掉模型 / 离线」走的是本地模板 `FORMATS`（F01~F10），那条路**本来就不读词库** ——
 *     别把「本地模板没变」当成词库没生效。
 * ★ 红线只在**主进程**判（`hotwords.sanitizeWords`）—— 一份正则。渲染层不许多抄一份（抄了迟早两边不一样），
 *   所以「加一个词」是拿 `dryRun` 先去主进程预检、通过了才真的进界面列表。
 */
function lexStatusHtml() {
  const L = state.lex;
  if (!L) return '';
  const adm = !!(state.auth && state.auth.isAdmin);
  const win = L.updatedAt ? Date.parse(L.updatedAt) : 0;
  const src = L.isCustom ? `已自定义${win ? '（' + fmtDate(win) + '）' : ''}` : '内置出厂词库';
  return `<div class="row" id="lxStatusRow">
      <span class="chip ${L.isCustom ? 'warn' : 'run'}">${esc(src)}</span>
      <span class="chip">全库 ${L.wordTotal} 词 · ${L.groups.length} 组</span>
      ${state.lexDirty ? '<span class="chip warn">有未保存的改动</span>' : ''}
      ${adm ? '' : '<span class="chip warn">只读 —— 改词库要管理员（改的是全员的生成口径）</span>'}
    </div>`;
}

function lexGroupHtml(g) {
  const adm = !!(state.auth && state.auth.isAdmin);
  const chips = g.words.map(w =>
    `<span class="chip lxw">${esc(w)}${adm ? `<button class="lxx" data-lx-del="${esc(g.key)}" data-lx-w="${esc(w)}" title="删掉这个词">×</button>` : ''}</span>`
  ).join('');
  return `<div class="box" id="lxg-${esc(g.key)}">
    <h3>${esc(g.key)}（${g.words.length} 词）</h3>
    <div class="lxwords">${chips || '<span class="hint">（空的 —— 这一组不会给模型任何词）</span>'}</div>
    ${adm ? `<div class="row" style="margin-top:9px">
      <input class="inp" data-lx-in="${esc(g.key)}" maxlength="24" placeholder="加一个词，回车即可">
      <button class="btn sm" data-lx-add="${esc(g.key)}">添加</button>
    </div>` : ''}
  </div>`;
}

TABS[12] = {
  title: '热词库',
  desc: '标题「产品词 + 热门词」用的词库 · 改完下一次生成就生效（不用重启）· 材质与极限词有红线挡着',
  actions: () => {
    const adm = !!(state.auth && state.auth.isAdmin);
    return [
      { act: 'lex:reset', label: '恢复内置', disabled: !adm || !state.lex },
      { act: 'lex:save', label: '保存', primary: true, disabled: !adm || !state.lex }
    ];
  },
  render() {
    const L = state.lex;
    if (!L) return '<div class="box"><h3>热词库</h3><p class="hint">正在读取…</p></div>';
    const editables = L.groups.filter(g => !g.locked);
    const lockeds = L.groups.filter(g => g.locked);
    return `
      <div id="lxStatus">${lexStatusHtml()}</div>
      <div class="box">
        <h3>这个库是怎么被用到的</h3>
        <p class="hint">每生成一条标题，程序把下面这些词交给模型挑（提示词里那段「【标题热词库】」就是它），
          并按行轮换 15 种<b>句式骨架</b>（T01~T15）。所以<b>你在这里改的词，下一次生成就会用上，不用重启</b>。</p>
      </div>
      <div class="box">
        <h3>三条红线（进不去的词会当场告诉你原因）</h3>
        <p class="hint">${L.redlines.map(s => '· ' + esc(s)).join('<br>')}</p>
      </div>
      ${editables.map(lexGroupHtml).join('')}
      ${lockeds.map(g => `<div class="box lxlock">
        <h3>${esc(g.key)}（${g.words.length} 词）· 已锁定，不可编辑</h3>
        <div class="lxwords">${g.words.map(w => `<span class="chip lxw">${esc(w)}</span>`).join('')}</div>
        <p class="hint">它<b>照样参与生成</b>（词照给模型），只是不给编辑。</p>
      </div>`).join('')}
      <div class="box">
        <h3>15 种句式骨架（T01~T15）· 不可编辑</h3>
        <div class="tw"><table>
          <thead><tr><th>编号</th><th>名称</th><th>结构</th><th>形状示例</th></tr></thead>
          <tbody>${L.styles.map(s => `<tr><td class="mono">${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.formula)}</td><td class="mono">${esc(s.sample)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">骨架是<b>语法</b>（连接字在第几位、收尾在末尾）—— 改坏会直接产出病句 / 标签串，
          而判据只能事后告警、拦不住，所以锁死在程序里。上面那些<b>词</b>才是你可以随便换的。</p>
        <p class="hint">★ <b>T15</b> 那两个 emoji（爱心 / 圆圈）的<b>颜色跟着本行的颜色走</b>（黑🖤 白🤍 红❤️ 橙🧡 黄💛 绿💚 蓝💙 紫💜 棕🤎）。
          本行颜色是<b>灰 / 浅灰</b>时没有对应的灰色 emoji，这一行会自动退回 T13 的写法（不加 emoji 对）。</p>
        <p class="hint">点「<b>恢复内置</b>」＝丢弃你在这一页做的全部增删改，回到程序自带的那份词库。</p>
      </div>`;
  }
};

/** 进「热词库」页时读一次（`lexTried` 防读失败后在 render → load → render 里打转） */
async function loadLexicon() {
  if (state.lexBusy) return;
  state.lexBusy = true;
  const r = await appApi.hotwordsGet().catch(() => null);
  state.lexBusy = false;
  if (!r || !r.ok) {
    state.lexTried = true;
    toast('读不到词库：' + ((r && r.error) || '主进程没回应'), 'err');
  } else {
    state.lex = r;
  }
  if (state.tab === 12) renderAll();
}

/** 只重画某一组 —— 整页重画会把别的输入框（可能正在打字）重置回旧值（品牌弹窗踩过同一个坑） */
function paintLexGroup(key) {
  const L = state.lex;
  if (!L) return;
  const g = L.groups.find(x => x.key === key);
  const box = $('#lxg-' + key);
  if (!g || !box) { renderAll(); return; }
  box.outerHTML = lexGroupHtml(g);
  bindLexicon();
  const st = $('#lxStatus');
  if (st) st.innerHTML = lexStatusHtml();
}

function bindLexicon() {
  const adm = !!(state.auth && state.auth.isAdmin);
  if (!adm || !state.lex) return;
  const pane = $('#pane');
  pane.querySelectorAll('[data-lx-del]').forEach(b => {
    b.onclick = () => {
      const g = state.lex.groups.find(x => x.key === b.dataset.lxDel);
      if (!g) return;
      g.words = g.words.filter(w => w !== b.dataset.lxW);
      state.lexDirty = true;
      paintLexGroup(b.dataset.lxDel);
    };
  });
  pane.querySelectorAll('[data-lx-in]').forEach(inp => {
    const key = inp.dataset.lxIn;
    const go = () => addLexWord(key, inp);
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    const btn = pane.querySelector(`[data-lx-add="${key}"]`);
    if (btn) btn.onclick = go;
  });
}

async function addLexWord(key, inp) {
  const L = state.lex;
  if (!L) return;
  const w = String(inp.value || '').trim();
  if (!w) return;
  const g = L.groups.find(x => x.key === key);
  if (!g) return;
  if (g.words.indexOf(w) >= 0) { toast('「' + w + '」已经在库里了', 'err'); return; }
  // ★ 红线只在主进程判：拿整份库 + 这个词去 dryRun 预检，通过了才真的进界面列表
  const payload = L.groups.map(x => ({ key: x.key, words: x.key === key ? x.words.concat([w]) : x.words.slice() }));
  inp.disabled = true;
  const r = await appApi.hotwordsSave(payload, { dryRun: true }).catch(() => null);
  inp.disabled = false;
  if (!r || !r.ok) { toast('主进程没回应，这次没加进去', 'err'); return; }
  if (r.rejected.length) { toast('「' + r.rejected[0].word + '」不能进库：' + r.rejected[0].why, 'err'); return; }
  g.words.push(w);
  state.lexDirty = true;
  paintLexGroup(key);
  const ni = $('#pane').querySelector(`[data-lx-in="${key}"]`);
  if (ni) { ni.value = ''; ni.focus(); }
}


/* ---------------- ⑨ 品牌与权限 ---------------- */
/*
 * 为什么从「设置」里拆出来单独成页：
 * 设置页那些（路径 / 模型 / 外观 / 更新 / 依赖）讲的是「这台机器怎么跑」，
 * 而品牌和账号讲的是「谁能做什么」。混在一页里，找账号权限要滚过半屏，还容易误以为
 * 改路径会动到权限。拆开之后编辑号接在最后（9），不动已有页签的编号 ——
 * 插号要把设置从 7 改成 8，连快捷键和几处断言都要跟着动，不划算。
 */
TABS[9] = {
  title: '品牌与权限',
  admin: true,
  desc: '品牌清单 · 账号与密码 · 按账号分配品牌权限 · 默认品牌（新建品牌、分配权限只有管理员能做）',
  actions: () => [],
  render() {
    return `${brandsHtml()}${accountHtml()}`;
  }
};

/** 设备矩阵：真机里「一个设备 = 一个账号」（雷电模拟器多台并行） */
function devicesHtml() {
  const p = state.config.publish || {};
  const list = p.devices || [];
  const sel = p.device || '';
  // adb 现在认到的全部设备（含还没加进列表的）；null = 还没扫过
  const found = state.devFound;
  const rows = list.length ? `<div class="tw"><table>
    <thead><tr><th>设备（账号）</th><th>序列号</th><th>状态</th><th></th></tr></thead>
    <tbody>${list.map(d => `<tr class="${String(sel) === String(d.serial) ? 'warnrow' : ''}">
      <td>${esc(d.name)}</td><td class="mono">${esc(d.serial)}</td>
      <td>${(state.devStatus && state.devStatus[d.serial] && state.devStatus[d.serial].online)
        ? badge('在线', 'ok') : (state.devStatus ? badge('离线', 'wait') : badge('未检测', 'wait'))}</td>
      <td><button class="btn sm" data-act="pub:useDev" data-serial="${esc(d.serial)}">选用</button>
          <button class="btn sm" data-act="pub:delDev" data-id="${esc(d.id)}">删除</button></td>
    </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">还没有设备。点下面「扫描设备」—— 模拟器开着的话它会直接列出来，点一下「加入并使用」就行。</div>`;
  // 还没加进列表的那些：直接给「加入并使用」——用户不必知道 emulator-5554 这种名字
  // ★ 2026-10-03：同一个模拟器会被 adb 在多个端口上各报一次（16384 / 5555 / 7555）。
  //   重复的（dupOf 非空的）不再单列 —— 否则用户会以为自己开了两台、不知道该选哪个。
  const fresh = (found || []).filter(f => !f.configured && !f.dupOf);
  const freshBox = fresh.length ? `
    <div style="margin-top:10px">
      <div class="hint" style="margin:0 0 6px">adb 现在认到这些设备（还没加进来）：</div>
      <div class="tw"><table>
        <thead><tr><th>序列号</th><th>状态</th><th></th></tr></thead>
        <tbody>${fresh.map(f => `<tr>
          <td class="mono">${esc(f.serial)}${(f.aliases && f.aliases.length)
            ? `<div class="hint" style="margin:2px 0 0">这台还出现在 ${esc(f.aliases.join(' / '))} —— 同一个模拟器的其它端口，不用管</div>`
            : ''}</td>
          <td>${f.online ? badge('在线', 'ok') : badge(f.state || '离线', 'wait')}</td>
          <td><button class="btn sm primary" data-act="pub:useFound" data-serial="${esc(f.serial)}"${f.online ? '' : ' disabled'}>加入并使用</button></td>
        </tr>`).join('')}</tbody></table></div>
    </div>` : '';
  const noneBox = (found && !found.length)
    ? `<p class="hint" style="margin-top:9px">adb 现在一台设备都没认到：先把模拟器启动起来，并确认它开了「ADB 调试」，再点一次「扫描设备」。</p>`
    : '';
  return `<div class="box"><h3>设备管理（一个设备 = 一个账号）</h3>${rows}
    <div class="row" style="margin-top:10px">
      <button class="btn sm primary" data-act="pub:devScan">扫描设备</button>
      <span class="chip ${(state.project.publish || {}).connected ? 'run' : ''}">${(state.project.publish || {}).connected ? '已连接' : '未连接'}</span>
      <span class="hint" style="margin:0">扫描就是问一下 adb「现在都连着谁」，不用你填序列号</span>
    </div>
    ${freshBox}${noneBox}
    <details style="margin-top:9px">
      <summary style="cursor:pointer;font-size:11.5px;color:var(--tx3)">手动填序列号添加（一般用不到）</summary>
      <div class="row" style="margin-top:8px">
        <input class="inp mono" id="devName" placeholder="账号名，如 主号" style="flex:0 0 160px;min-width:0">
        <input class="inp mono" id="devSerial" placeholder="序列号（一般不用填，用上面的「扫描设备」）" style="flex:0 0 190px;min-width:0">
        <button class="btn sm" data-act="pub:addDev">添加设备</button>
      </div>
    </details>
  </div>`;
}

/** adb 从哪来 —— 与技术详情里那一列配套；unknown 的取值一律显示原文，不美化 */
const ADB_SRC_TXT = {
  configured: '你手填的',
  bundled: '程序内置',
  path: '系统 PATH 里找到的',
  'configured-missing': '你填的那个不存在'
};

/**
 * 设备检查结果。
 * ★ 目标只有一个：让**不懂 adb 的人**一眼看出「现在能不能发」和「不能的话下一步点哪里」。
 *   以前这里是把 7 行术语直接摆出来（adb / uiautomator / ADBKeyboard…），用户看到「不满足」
 *   根本不知道要干什么。现在改成：一句结论 + 每条一条明确的动作 + 技术详情收进折叠。
 *   （给用户看的那套说法由主进程 adb.probe() 的 `fix` 给，这里只负责显示。）
 */
function probeHtml() {
  const p = state.probe || (state.project.publish && state.project.publish.probe);
  if (!p) return '';
  const fix = Array.isArray(p.fix) ? p.fix : [];
  const bad = fix.filter(f => f.level === 'bad');
  const warn = fix.filter(f => f.level === 'warn');
  const headline = bad.length ? `还不能真机发布 —— ${bad.length} 项要先处理`
    : warn.length ? '能发布，但有一处会影响体验'
      : '一切就绪，可以真机发布了';
  const kind = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
  const accent = { bad: 'var(--red)', warn: 'var(--amber)' };
  const line = (k, v, pass) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v || '—')}</td><td>${badge(pass ? '可用' : '不满足', pass ? 'ok' : 'bad')}</td></tr>`;
  const items = bad.concat(warn);
  return `
    <div class="box">
      <h3>设备检查结果${p.ts ? `（${esc(new Date(p.ts).toLocaleTimeString())}）` : ''}</h3>
      <div class="row">${badge(headline, kind)}
        <span class="ts" style="color:var(--tx3)">点上面的「检查能不能发布」可随时重查</span></div>
      ${items.map(f => `
        <div style="border-left:3px solid ${accent[f.level]};background:var(--panel);border-radius:6px;padding:9px 12px;margin-top:9px">
          <div style="font-size:12.5px;font-weight:600;color:${accent[f.level]}">${esc(f.title)}</div>
          <div style="font-size:12px;color:var(--tx2);line-height:1.75;margin-top:3px">${esc(f.how)}</div>
          ${f.act ? `<button class="btn sm primary" style="margin-top:8px" data-act="${esc(f.act.act)}">${esc(f.act.label)}</button>` : ''}
        </div>`).join('') || '<p class="hint">7 项检查全部通过 —— 按上面的「开始发布」就是真机发布了。</p>'}
      <details style="margin-top:11px">
        <summary style="cursor:pointer;font-size:11.5px;color:var(--tx3)">技术详情（一般不用看，出问题给开发看）</summary>
        <div class="tw" style="margin-top:8px"><table>
          <thead><tr><th>检查项</th><th>结果</th><th>状态</th></tr></thead>
          <tbody>
            ${line('adb 路径', `${p.adbPath || '—'}${ADB_SRC_TXT[p.adbSource] ? '（' + ADB_SRC_TXT[p.adbSource] + '）' : ''}`, !!p.adb)}
            ${line('设备在线', p.device ? p.device.serial + '（' + p.device.state + '）' : '不在线', !!p.device)}
            ${line('分辨率', p.resolution, !!p.resolution)}
            ${line('得物包名', p.appPackage, !!p.appPackage)}
            ${line('界面抓取 uiautomator', (p.tools && p.tools.uiautomator) ? '可用' : '不可用', !!(p.tools && p.tools.uiautomator))}
            ${line('失败截图 screencap', (p.tools && p.tools.screencap) ? '可用' : '不可用', !!(p.tools && p.tools.screencap))}
            ${line('中文输入 ADBKeyboard',
              p.adbKeyboard ? (p.adbKeyboardActive ? '已装，且是当前输入法' : '已装，但没设成当前输入法（中文打不进去）') : '未安装',
              !!(p.adbKeyboard && p.adbKeyboardActive))}
          </tbody>
        </table></div>
        ${(p.notes && p.notes.length) ? `<p class="hint">${p.notes.map(n => '⚠ ' + esc(n)).join('<br>')}</p>` : ''}
      </details>
    </div>`;
}

/* ---------------- 页签 10：运行日志 ----------------
 * 内容与最下面那条日志栏是**同一份**（state.logs）—— 用户明确要求「同步」。
 * 单独开一页只为了两件日志栏做不了的事：**按级别/关键字筛**、**导出**。
 * ★ 筛选框输入时不重画整页（renderAll 会把光标顶掉），只重画行那一块 —— 见 renderLogPaneLines()。
 * ★ 行列表复用底部日志栏的 .logbar/.lines 样式（等宽字体 + 分级配色只有那套里有），只改边框与高度。
 */
function logPaneHtml() {
  const f = state.logFilter || { level: '', q: '' };
  const opts = [['', '全部级别'], ['info', '信息'], ['ok', '成功'], ['warn', '警告'], ['error', '错误']]
    .map(([v, t]) => `<option value="${v}"${f.level === v ? ' selected' : ''}>${t}</option>`).join('');
  const errs = uiLogs().filter(e => e.level === 'error').length;
  const warns = uiLogs().filter(e => e.level === 'warn').length;
  const ex = state.logExport;
  return `
  <div class="box">
    <div class="row" style="align-items:baseline">
      <h3 style="margin:0">运行日志</h3>
      <span class="grow"></span>
      <span class="chip" id="logPaneCount">${logCountText()}</span>
      ${errs ? `<span class="chip warn">${errs} 条错误</span>` : ''}
      ${warns ? `<span class="chip">${warns} 条警告</span>` : ''}
    </div>
    <p class="hint" style="margin:6px 0 0">与最下面的日志栏是同一份内容；这里筛完了再导出，导出的就是屏幕上这些。
      条数是<b>内存缓冲区里的</b>（上限 500 条），不是磁盘上历史日志的总数。
      ★ 只有「大结论」进这里（任务开始 / 结束 / 结果【目标·成功·失败】与真出错的告警）；
      每步耗时、坐标、清相册这类<b>过程明细</b>不在界面上刷，但一条不少地记在输出目录的
      <code>run-log.jsonl</code> 台账里，任务行的「查看详情」也能按批次回看。</p>
    <div class="row" style="margin-top:9px">
      <select class="inp" id="logLv">${opts}</select>
      <input class="inp" id="logQ" style="flex:1;min-width:180px" placeholder="按关键字筛（标题 / 批次 / 文件路径…）" value="${esc(f.q)}" spellcheck="false">
      <button class="btn sm" data-act="log:clear"${uiLogs().length ? '' : ' disabled'}>清空日志</button>
      <button class="btn sm primary" data-act="log:export"${uiLogs().length ? '' : ' disabled'}>导出日志</button>
    </div>
  </div>
  <div class="box">
    <div class="logbar" style="border-top:0;max-height:420px">
      <div class="lines" id="logPaneLines"></div>
    </div>
    ${logFilterOn() ? `<p class="hint">当前只显示筛选结果中的 <b>${filteredLogs().length}</b> 条。要点回全部日志，把级别选回「全部级别」、清空关键字即可。</p>` : ''}
  </div>
  <div class="box">
    <h3>导出</h3>
    <div class="row">
      <button class="btn sm" data-act="log:export">导出到输出目录</button>
      ${ex ? `<button class="btn sm" data-act="log:openFile">打开文件</button>
        <button class="btn sm" data-act="log:revealFile">打开所在文件夹</button>` : ''}
    </div>
    <p class="hint">导出会一次生成两个文件，落在<b>输出目录</b>（和合规报告、品牌统计同一个地方）：
      <code>运行日志_时间戳.log</code>（给人看的，每行带完整日期时间与等级）
      与 <code>运行日志_时间戳.jsonl</code>（一行一条 JSON，给脚本或同事再分析）。
      文件头会写清<b>本次导出了多少条</b>与<b>缓冲区一共多少条</b> —— 筛过之后这两个数不一样，免得事后误会成"日志丢了"。</p>
    ${ex ? `<p class="hint" style="margin-top:6px">上次导出：<b>${esc(String(ex.file || '').split(/[\\/]/).pop())}</b>（${n(ex.count)} 条）</p>` : ''}
    ${state.logExportErr ? `<p class="hint" style="margin-top:6px;color:var(--red)">上次导出失败：${esc(state.logExportErr)}</p>` : ''}
  </div>`;
}

TABS[10] = {
  title: '运行日志',
  desc: '与底部日志栏同一份内容 · 可按级别/关键字筛 · 可导出成 .log 与 .jsonl',
  actions: () => [
    { act: 'log:clear', label: '清空', disabled: !uiLogs().length },
    { act: 'log:export', label: '导出日志', primary: true, disabled: !uiLogs().length }
  ],
  render() {
    return logPaneHtml();
  }
};

/** 进「运行日志」页时把行铺开（renderAll 里 render() 只产出空容器，行交给这里画） */
function bindLogPane() {
  const lv = $('#logLv');
  const q = $('#logQ');
  if (lv) lv.onchange = () => { state.logFilter.level = lv.value; renderLogPaneLines(); };
  if (q) q.oninput = () => { state.logFilter.q = q.value; renderLogPaneLines(); };
  renderLogPaneLines();
}

/* ---------------- 渲染入口 ---------------- */
/**
 * ★★ 2026-10-04：`state.project` / `state.config` 会有两种「不是数据」的形状，而各页渲染是
 *    **直接读深层字段**的（`project.compliance.stats` / `config.copy.rotateStrategy` /
 *    `config.publish.intervalSec` / `project.items.length`）：
 *      · `null` —— 还没读到（只有绕过 enterApp 直接驱动渲染层的脚本会造出来）；
 *      · `{ok:false,error}` —— ★ 主进程的 guard() 在「没登录 / 会话失效 / 账号被停用」时
 *        **不抛异常，而是返回这个对象**；而 config:get / project:get 都走 guard ⇒
 *        渲染层那句 `state.config = await appApi.configGet()` 会把**拒绝对象当成配置存下来**。
 *    实测（tools/_rv-projectnull.js，11 个页签逐个 renderAll）：project=null ⇒ 6 页抛；
 *    config=null ⇒ 5 页抛；project=拒绝 ⇒ 2 页抛；config=拒绝 ⇒ 2 页抛。
 *    表现是**整页白屏、一句话都不给** —— 用户没法判断到底是「还没数据」还是「已经掉线」。
 *    ⇒ 入口先判这两个值能不能用：拒绝（＝掉线）就回登录页并原样说出原因；
 *      还没读到就只画一句人话。绝不让里层去读缺字段的深路径。
 */
const PROJ_KEYS = ['items', 'compliance', 'verify', 'sheet', 'publish'];      // 真值一定带（主进程 blank() 保证）
const CFG_KEYS = ['paths', 'flatten', 'compliance', 'copy', 'verify', 'publish']; // 真值一定带（store.defaults() 保证）

function stateGate() {
  const denyOf = v => (v && typeof v === 'object' && v.ok === false) ? (v.error || '读取被拒绝') : null;
  const shapeBad = (v, keys) => !v || typeof v !== 'object' || keys.some(k => v[k] === undefined);
  const dp = denyOf(state.project), dc = denyOf(state.config);
  if (dp || dc) {
    return { kind: 'denied', why: [dp && ('工程状态：' + dp), dc && ('配置：' + dc)].filter(Boolean).join('；') };
  }
  const mp = shapeBad(state.project, PROJ_KEYS), mc = shapeBad(state.config, CFG_KEYS);
  if (mp || mc) {
    return { kind: 'missing', why: [mp && '工程状态', mc && '配置'].filter(Boolean).join(' 与 ') + '还没读到' };
  }
  return null;
}

function renderAll() {
  syncAdminNav();   // 高级设置是管理员专属：先按权限把页签与当前页签都对齐，再渲染
  // ★ 页签 5「发布单」2026-10-03 已删 ⇒ 编号在 5 处留了空位。老配置里存过 tab=5、
  //   或按 Ctrl+5 按到空位时，必须兜回第 1 页 —— 否则 t 是 undefined，下面读 t.title 直接崩（整页白屏）。
  if (!TABS[state.tab]) state.tab = 1;
  const t = TABS[state.tab];
  const g = stateGate();
  // 掉线（拒绝对象）不是「这一页没数据」，是「你已经不在登录状态」⇒ 回登录页，把原因原样带过去。
  // 免登录模式（requireLogin=false）不会有拒绝对象，所以这里不会误踢人。
  if (g && g.kind === 'denied' && state.auth && state.auth.requireLogin) { showGate(g.why); return; }
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('on', Number(el.dataset.tab) === state.tab));
  if (g) {
    // 只画一句人话：各页的 desc/actions/render 全都要读 project/config 的深层字段，缺了就是白屏
    $('#head').innerHTML = `<div><h2>${esc(t.title)}</h2><p>${esc(g.why)}</p></div>`;
    $('#pane').innerHTML = `<div class="empty">${esc(g.why)} —— 这一页先不渲染。<br><br>
      各页都要读工程状态 / 配置里的深层字段（比如合规检查要读「扫描统计」、文案生成要读「并发路数」），
      缺字段时硬读会直接白屏、还不说明原因，所以这里先把原因写出来。<br>
      等这一步完成（重新登录 / 重启应用）后，这里会自动恢复。</div>`;
    sideStatus();
    return;
  }
  $('#head').innerHTML = `<div><h2>${esc(t.title)}</h2><p>${esc(typeof t.desc === 'function' ? t.desc() : t.desc)}</p></div>
    <div class="act">${(t.actions()).map(a => `<button class="btn${a.primary ? ' primary' : ''}" data-act="${a.act}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}</div>`;
  const scroll = $('#pane').scrollTop;
  $('#pane').innerHTML = t.render();
  $('#pane').scrollTop = scroll;
  sideStatus();
  const chip = $('#runChip');
  if (state.jobs.length) {
    chip.textContent = state.jobs.length > 1 ? `运行中 ${state.jobs.length}` : '运行中';
    chip.className = 'chip run';
  } else { chip.textContent = '空闲'; chip.className = 'chip'; }
  $('#chipProj').textContent = '项目：' + ((state.project && state.project.projectName) || '—');
  // 左上角 app 名字后面的版本号：app:info 不受 guardAdmin 限制，人人可读；
  // 取不到就显示 v—（未知 ≠ 0，绝不编一个版本号出来）
  const av = $('#appVer');
  if (av) av.textContent = 'v' + ((state.info && state.info.version) || '—');
  const me = state.auth && state.auth.user;
  const cu = $('#chipUser');
  if (cu) {
    cu.textContent = me ? (me.displayName || me.username) : '未登录';
    cu.title = me ? `账号 ${me.username} · ${me.role === 'admin' ? '管理员' : '普通成员'}` : '未登录';
  }
  const lo = $('#btnLogout');
  if (lo) lo.style.display = me ? '' : 'none';
  // 页内的设置项：任何页签都要能存（文案生成 / 模拟器发布页里也有）
  bindCfgInputs();
  // 设置页与「品牌与权限」页共用一套绑定：都按 id 找元素，找不到就跳过
  if (state.tab === 7 || state.tab === 9 || state.tab === 11) bindSettings();
  // 运行日志页：行是渲染后单独铺的（而且要保住筛选框的光标，不能整页重画）
  if (state.tab === 10) bindLogPane();
  // 热词库页：绑定增删改；第一次进这一页自动读一次
  if (state.tab === 12) {
    bindLexicon();
    if (!state.lex && !state.lexBusy && !state.lexTried) loadLexicon();
  }
  if (state.tab === 8) {
    bindStats();
    // 第一次进这个页签自动读一次；statsTried 防止查询失败时无限重试（那只会在 render→load→render 里打转）
    if (!state.stats && !state.statsBusy && !state.statsTried) loadStats();
  }
}

/* ---------------- 登录门 ---------------- */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 量出登录卡片的实际高度，让主进程把窗口收紧到「刚好装下卡片」 */
function fitGateWindow() {
  if (!appApi.fitGate) return;
  requestAnimationFrame(() => {
    const card = document.querySelector('.gate .gcard');
    if (!card) return;
    appApi.fitGate(Math.ceil(card.getBoundingClientRect().height));
  });
}

function showGate(msg) {
  document.body.classList.add('locked');
  $('#lgErr').textContent = msg || '';
  const f = $('#loginForm');
  if (!f.dataset.bound) {
    f.dataset.bound = '1';
    f.onsubmit = e => { e.preventDefault(); doLogin(); };
    $('#lgUser').oninput = $('#lgPwd').oninput = () => {
      if ($('#lgErr').textContent) { $('#lgErr').textContent = ''; fitGateWindow(); }
    };
    const gx = $('#gateClose');
    if (gx) gx.onclick = () => appApi.close();    // 无边框小窗必须自带一个关闭口
  }
  // ★ 出厂账号提示已删（2026-10-02 用户要求）：登录页不再回显 admin / 口令，
  //   连带 auth.status() 的 defaultHint 字段一起删掉（不留悬空字段）。
  fitGateWindow();                                // 量卡片实际高度，把窗口收紧
  setTimeout(() => {
    const u = $('#lgUser');
    if (u.value) $('#lgPwd').focus(); else u.focus();
  }, 30);
}

async function doLogin() {
  const u = $('#lgUser').value.trim();
  const p = $('#lgPwd').value;
  const remember = $('#lgRem').checked;
  if (!u || !p) { $('#lgErr').textContent = '请输入账号和密码'; return; }
  const btn = $('#lgGo');
  btn.disabled = true; btn.textContent = '登录中…';
  const r = await appApi.authLogin(u, p, remember);
  btn.disabled = false; btn.textContent = '登 录';
  if (!r.ok) {
    $('#lgErr').textContent = r.error || '登录失败';
    fitGateWindow();                     // 报错行会让卡片变高，窗口跟着收紧一次
    $('#lgPwd').select();
    return;
  }
  $('#lgPwd').value = '';
  state.auth = await appApi.authStatus();
  await enterApp();
}

async function enterApp() {
  document.body.classList.remove('locked');
  state.config = await appApi.configGet();
  state.project = await appApi.projectGet();
  state.logs = await appApi.logHistory();
  // 启动时对齐一次「运行中的批次」（job:busy 不传类型就是清单），免得刷新后看不见正在跑的任务
  const live = await appApi.busy();
  if (Array.isArray(live)) state.jobs = live.map(j => Object.assign({ progress: null, startedAt: j.startedAt || Date.now() }, j));
  await refreshBrands();
  await refreshUsers();
  // 更新状态读一次就够，之后靠主进程推 update:changed（下载进度很密，见 onUpdate 的处理）
  try { state.upd = await appApi.updateStatus(); } catch (e) { state.upd = null; }
  bindOnce();
  renderAll();
  renderLogs();
  const me = state.auth && state.auth.user;
  if (me && me.mustChange) toast('当前还是出厂口令，建议到「品牌与权限 → 账号与安全」改掉', 'err');
}

async function doLogout() {
  await appApi.authLogout();
  state.auth = await appApi.authStatus();
  state.users = null;
  state.jobs = [];
  state.batchDetail = null;
  // 品牌与统计是「这个账号看得见的东西」，退出必须清掉 ——
  // 不清的话换个人登录会先看到上一个人的品牌和统计，直到下一次刷新才纠正
  state.brandsMeta = null;
  state.brandId = '';
  state.stats = null;
  state.statsTried = false;
  state.brandEdit = null;
  // 弹窗里是上一个账号看得见的品牌、模板与账号清单，登录门一出来必须一起收掉
  closeBrandModal();
  closeUserModal();
  showGate('已退出登录');
}

async function refreshUsers() {
  if (state.auth && state.auth.isAdmin) {
    const r = await appApi.authUsers();
    state.users = r.ok ? r.users : [];
    state.myId = r.ok ? r.currentId : null;
  } else {
    state.users = null;
  }
}

/* ---------------- 品牌与权限 ---------------- */
/**
 * 拉一次「我能用哪些品牌」，顺带把标题栏下拉填上。
 * 这里只是把选项列出来方便操作，**说了算的是主进程** —— 前端改个值骗不了它
 * （jobs.js 起任务时会再按账号权限校验一遍）。
 */
async function refreshBrands() {
  let r = null;
  try { r = await appApi.brandList(); } catch (e) { r = null; }
  state.brandsMeta = (r && r.ok)
    ? r
    : { isAdmin: false, brands: [], mine: [], defaultBrandId: '', error: (r && r.error) || '读不到品牌列表' };
  paintBrandSelect();
}

function brandNameOf(id) {
  const m = state.brandsMeta;
  if (!m) return id || '';
  const b = (m.brands || []).find(x => x.id === id);
  if (b) return b.name;
  return id ? '已删除的品牌' : '未标品牌';
}

/** 标题栏下拉：只列「我有权限的」；一个都没有就显示一行提示并转黄 */
function paintBrandSelect() {
  const sel = $('#brandSel');
  if (!sel) return;
  const m = state.brandsMeta || { brands: [], mine: [], isAdmin: false };
  const mine = Array.isArray(m.mine) ? m.mine : [];
  const usable = (m.brands || []).filter(b => mine.includes(b.id) && b.enabled !== false);
  const prev = state.brandId;
  sel.innerHTML = usable.length
    ? usable.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')
    : '<option value="">（没有可用品牌）</option>';
  const keep = [prev, m.defaultBrandId].find(x => x && usable.some(b => b.id === x)) || (usable[0] ? usable[0].id : '');
  sel.value = keep;
  state.brandId = keep;
  sel.classList.toggle('warn', !usable.length);
  sel.title = usable.length
    ? `当前品牌：${brandNameOf(keep)} —— 文案生成 / 发布单 / 发布都会归属到它`
    : (m.isAdmin ? '还没有品牌：到「品牌与权限」页添加' : '你还没有被分配品牌：请管理员到「品牌与权限 → 账号管理」里分配');
}

/* ---------------- 文案提示词弹窗 ---------------- */
/*
 * 为什么不挂进 renderAll：弹窗里有几千字的 textarea，而 renderAll 会被后台任务的进度事件频繁触发，
 * 整块重画会把正在打字的模板重置回旧值 —— 用户看到的是「打了半天突然变回去」，还会以为存上了。
 * 所以只在开 / 关 / 切视图时构建一次 DOM，值在保存时直接从 DOM 读。
 */
function renderBrandModal() {
  const mask = $('#bmodal'), box = $('#bmBox');
  if (!mask || !box) return;
  const m = state.brandModal;
  if (!m) { mask.hidden = true; box.innerHTML = ''; return; }
  mask.hidden = false;
  box.innerHTML = m.view === 'edit' ? bmEditHtml(m.id || '') : bmListHtml();
}

function openBrandModal(view, id) {
  state.brandModal = { view: view || 'list', id: id || '' };
  renderBrandModal();
}
function closeBrandModal() {
  state.brandModal = null;
  renderBrandModal();
}

/* ---------------- 「说明书」弹窗 ----------------
 * ★ 为什么要有它（2026-10-03 用户要求）：「批次设置」把话题 / 正文 / 重复 / 看图写四套规则
 *   全铺在页面上（600 多字），第一次用的人读不完，老手每次又都被挡着。
 *   改成：页面只留**一行结论** + 一个「看说明书」，规则细节点开弹窗再看。
 * ★ 为什么用弹窗而不是折叠（details）：折叠会把页面往下顶很长，展开又把正在看的队列表挤走；
 *   弹窗盖在上面，看完关掉，页面滚动位置一点不动。
 * ★ 内容放注册表里（不是散在模板字符串里）：写断言时可以按 topic **逐条点名**，
 *   也能钉住「注册表里的每一条都有按钮能打开、每页的按钮都指向存在的条目」——
 *   光删按钮会留下打不开的死条目，光删条目会留下点了没反应的死按钮，两种都要能抓。
 */
const HELP = {
  copy: {
    title: '文案生成 · 批次设置说明书',
    html: () => `
      <p class="hint"><b>必带话题可以写多个</b>：用 <b>空格</b> 或 <b>逗号</b>（中英文都行，顿号 / 分号 / 竖线也可以）隔开，如
        <code>#品牌话题, #品类词</code>。每条笔记都会带上它们、并固定排在话题最前面；漏写 <code>#</code> 会自动补上。
        每条笔记最多带 <b>5 个话题</b>（原来发布单的「话题1~话题5」五个格子，上限没变）——
        「必带个数 + 额外话题」超过 5 时，多出来的会<b>少带并明确告警</b>（不会默默丢掉）。</p>
      <p class="hint"><b>额外话题从哪来</b>：优先抓<b>品牌提示词里写的 <code>#话题</code></b>（就是提示词里那段「话题列表」），
        品牌提示词里没有 <code>#</code> 话题才退回内置的通用词 —— 所以想让每条笔记都带上你们家的话题，
        直接在品牌提示词的「话题列表」里写就行，不用在这里再抄一遍。</p>
      <p class="hint"><b>正文写成 4~5 行短句</b>：一行一句（8~16 字），按「卖点 → 氛围感 → 上身体验 → 搭配」铺开，
        行尾少量 emoji（全篇 1~3 个）。<b>行与行之间是真的换行</b>，发到得物就是分行的样子；写成一大段会被「文案核对」列点出来。
        正文结尾由程序<b>追加</b>这条要带的话题：<b>一个话题单独一行、连 <code>#</code> 一起写</b>
        （原来「话题1~5」那几个，现在跟着文案一起走 —— AI内容报告里没有话题列，只留在格子里的话反向导入会丢）。
        想改话题就直接改文案末尾那几行。</p>
      <p class="hint"><b>重复口径</b>：只看<b>相邻两条</b> —— 标题或正文与<b>上一条完全一样</b>（含 emoji）才会提醒；
        换个 emoji、换个词就算不同；隔开几条再撞句、或换个品牌复用同一句，都没关系。</p>
      <p class="hint"><b>标题是看图写的</b>：每条素材把前几张实拍图缩到 768px 发给模型，标题里的品类 / 款式特征 / 颜色
        都来自图里真实看到的（如「雨伞熊高领毛衣灰色慵懒风🧸」），<b>不是拿货号颜色套模板</b>。
        <b>只有视频、没有实拍图的素材</b>会从视频里抽 <b>1 帧</b>当图发过去（抽帧在本机做，
        送出去的还是这 1 张、跟视频多长无关；抽到的帧是黑场/纯色就一张都不送）。
        模型连不上时会<b>直接停下来报错</b>，不会拿本地模板冒充 AI 文案；要先确认接口就点「文案生成 → 模型配置 → 接口自检」。</p>
    `
  }
};

function renderHelpModal() {
  const mask = $('#hmodal'), box = $('#hmBox');
  if (!mask || !box) return;
  const h = state.helpModal && HELP[state.helpModal];
  if (!h) { mask.hidden = true; box.innerHTML = ''; return; }
  mask.hidden = false;
  box.innerHTML = `<div class="mh"><h3>${esc(h.title)}</h3><span class="grow"></span>
      <button class="btn sm" data-act="help:close">关闭</button></div>
    <div class="mb">${h.html()}</div>`;
}
function openHelpModal(topic) { state.helpModal = topic || ''; renderHelpModal(); }
function closeHelpModal() { state.helpModal = null; renderHelpModal(); }

/* ---------------- 「模型配置」弹窗 ----------------
 * ★ 2026-10-08 用户要求：模型配置搬到「文案生成」页做成**弹窗**，并且是**所有模型调用的唯一口子**
 *   （原话：「后续模型调用都通过这个口子来，设置里的模型直接删了」）。原来在「高级设置 → 文案模型」
 *   的那个折叠框**已删**，别再在别处放第二份能改同一个键的控件（两处能改就说不清谁生效）。
 * ★ 「可设置默认模型，第一次填写后，后续默认选用这个」怎么落地：地址 / Key 填好 → 点「拉取模型清单」
 *   → 从接口**真认的**模型里点一个 → 存进 copy.llm.model。以后所有调用（生成 / 接口自检）都读它。
 * ★ 为什么非要有「拉取清单」这一步：用户容易填显示名（`deepseek v4.1 flash`），而接口只认自己的 id，
 *   实测直接 400（`The supported API model names are deepseek-flash, ...`）。点清单里的一项存的就是 id。
 *   ★ 清单拉不到（有些网关就没有 /models）不算死路：下面那个「默认模型」框可以直接手填 id。
 * ★★ 表单 DOM 只在**开弹窗**时构建一次；拉清单 / 点选只重画 `#lmList` 与 `#lmCur` ——
 *   整块重画会把用户刚粘进去、还没保存的地址 / Key 清空（他会以为没粘上）。
 * ★ 「实际在用」那行读主进程的 llm:effective（本地解析、无网络请求）：留空＝跟随内置这个语义
 *   必须有**唯一的可见出口**，否则用户只看到空框，不知道实际在用哪个模型 —— 那界面就是在骗人。
 */
function openModelModal() {
  if (!canAdmin()) { toast('模型配置只有管理员能改', 'warn'); return; }
  state.modelModal = { eff: null, models: [], listErr: '', busy: false };
  renderModelModal();
  refreshLmEff();
}
function closeModelModal() { state.modelModal = null; renderModelModal(); }

/** 读一次「当前实际在用」（本地解析，不联网）；只更新那一行，不碰表单 */
async function refreshLmEff() {
  const m = state.modelModal;
  if (!m) return;
  try { m.eff = await appApi.llmEffective(); } catch (e) { m.eff = null; }
  if (state.modelModal !== m) return;         // 期间被关掉/重开了，别往新弹窗里写旧值
  const el = $('#lmCur');
  if (el) el.innerHTML = lmEffHtml();
}

/** 「实际在用」那一行。★ 读真值：绝不把「框里空着」显示成「已配置」。 */
function lmEffHtml() {
  const m = state.modelModal || {};
  const eff = m.eff;
  if (!eff) return `<span class="chip">实际在用：读取中…</span>`;
  const how = eff.modelSource === '本机配置' ? '本机配置' : '跟随内置';
  const key = eff.apiKeySet ? (eff.apiKeySource === '本机配置' ? 'Key 本机配置' : 'Key 跟随内置') : 'Key 未配';
  return `<span class="chip">实际在用</span> <span class="chip mono">${esc(eff.model || '—')}</span>`
    + ` <span class="chip">${esc(how)}</span> <span class="chip">${esc(key)}</span>`;
}

function renderModelModal() {
  const mask = $('#lmmodal'), box = $('#lmBox');
  if (!mask || !box) return;
  const m = state.modelModal;
  if (!m) { mask.hidden = true; box.innerHTML = ''; return; }
  mask.hidden = false;
  box.innerHTML = lmHtml();
  renderLmList();
}

function lmHtml() {
  const c = ((state.config || {}).copy || {}).llm || {};
  const b = v => !(v === false || v === 'false' || v === 0 || v === '0' || v === '');
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return `
    <div class="mh"><h3>模型配置</h3><span class="grow"></span>
      <button class="btn sm" data-act="lm:close">关闭</button></div>
    <div class="mb">
      <p class="hint">「AI 文案」走哪个模型，就在这一份里配 —— <b>全程序只有这一个入口</b>
        （原「设置 → 高级设置 → 文案模型」那一块已删除）。<b>接口地址 / API Key 留空 = 跟随内置</b>
        （随包内置，换服务商发新包即可）。</p>
      <div class="mfld"><span>启用</span>
        <select class="inp" id="lmEnabled" style="width:100%">
          <option value="true" ${c.enabled ? 'selected' : ''}>调用模型（看图写）</option>
          <option value="false" ${!c.enabled ? 'selected' : ''}>本地模板（离线）</option>
        </select></div>
      <div class="mfld"><span>接口地址（留空 = 跟随内置）</span>
        <input class="inp mono" id="lmEndpoint" style="width:100%" value="${esc(c.endpoint || '')}" placeholder="留空 = 跟随内置"></div>
      <div class="mfld"><span>API Key（留空 = 跟随内置）</span>
        <input class="inp mono" id="lmKey" type="password" style="width:100%" value="${esc(c.apiKey || '')}" placeholder="留空 = 跟随内置"></div>
      <div class="mfld"><span>默认模型（所有调用都用它）</span>
        <input class="inp mono" id="lmModel" style="width:100%" value="${esc(c.model || '')}" placeholder="留空 = 跟随内置；也可以点下面清单里的一个">
        <div class="row" style="margin-top:8px;align-items:center">
          <button class="btn sm" data-act="lm:list">拉取模型清单</button>
          <button class="btn sm" data-act="lm:test">接口自检</button>
          <span class="grow"></span>
          <span id="lmCur" class="hint"></span>
        </div>
        <div id="lmList"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <span class="lbl">看图</span>
        <select class="inp" id="lmVision">
          <option value="true" ${b(c.vision === undefined ? true : c.vision) ? 'selected' : ''}>送实拍图</option>
          <option value="false" ${!b(c.vision === undefined ? true : c.vision) ? 'selected' : ''}>不送图</option>
        </select>
        <span class="lbl">每条送图</span>
        <select class="inp" id="lmCount">${[1, 2, 3, 4].map(v => `<option value="${v}" ${num(c.imageCount, 2) === v ? 'selected' : ''}>${v} 张</option>`).join('')}</select>
        <span class="lbl">单边缩到</span>
        <select class="inp" id="lmSide">${[512, 768, 1024, 1568].map(v => `<option value="${v}" ${num(c.imageMaxSide, 768) === v ? 'selected' : ''}>${v}px</option>`).join('')}</select>
      </div>
      <p class="hint" style="margin-top:12px"><b>标题是看图写的</b>：每条素材把前几张实拍图缩到上面那个尺寸发给模型，
        标题里的品类 / 款式特征 / 颜色都来自图里真实看到的，不是拿货号颜色套模板。
        <b>只有视频、没有实拍图的素材</b>会从视频里抽 1 帧当图（在本机抽，不往素材目录里落东西；
        抽到的帧是黑场/纯色就一张都不送，报告里「生成来源」会写明是「视频抽帧」还是「视频没抽出帧」）。
        ★ 模型连不上时<b>会直接停下来报错</b>，不会拿本地模板冒充 AI 文案
        （要用模板就把「启用」改成「本地模板（离线）」，那时报告里会逐行标出「本地模板」）。</p>
    </div>
    <div class="mf"><span class="grow"></span>
      <button class="btn sm" data-act="lm:close">取消</button>
      <button class="btn sm primary" data-act="lm:save">保存</button></div>`;
}

/** 只重画清单区（+「实际在用」那行）；表单里用户填的东西一个都不碰 */
function renderLmList() {
  const box = $('#lmList');
  const curEl = $('#lmCur');
  if (curEl) curEl.innerHTML = lmEffHtml();
  if (!box) return;
  const m = state.modelModal || {};
  const modelEl = $('#lmModel');
  const cur = modelEl ? modelEl.value.trim() : '';
  if (m.busy) { box.innerHTML = `<p class="hint">正在拉取模型清单…</p>`; return; }
  if (m.listErr) {
    box.innerHTML = `<p class="hint">拉不到清单：<b>${esc(m.listErr)}</b>。
      地址 / Key 对不对？有些网关就是不提供 <code>/models</code> —— 那样直接在「默认模型」框里手填 id 也行。</p>`;
    return;
  }
  if (!(m.models || []).length) { box.innerHTML = ''; return; }
  box.innerHTML = `<p class="hint">点一行 = 把它设为默认模型（存进「默认模型」框，点保存才落盘）：</p>
    <div class="blist">${m.models.map(x => `
    <div class="brow" data-act="lm:pick" data-id="${esc(x.id)}" title="设为默认模型">
      <span class="bn mono">${esc(x.id)}</span>
      <span class="grow snip">${esc(x.name)}</span>
      ${x.image === true ? badge('支持看图', 'ok') : (x.image === false ? badge('不看图', 'warn') : badge('没写收不收图', 'wait'))}
      ${x.id === cur ? badge('默认', 'ok') : ''}
    </div>`).join('')}</div>`;
}

/* ---------------- 账号操作弹窗（配置品牌权限 / 重置密码） ---------------- */
/*
 * ★ 为什么从「页面里那条工具栏」改成弹窗（2026-10-02 用户要求）：
 *   原来是「先在下拉框里选出账号 → 再勾品牌 → 保存」，用的人得先在一堆名字里找到那个人，
 *   勾完还得自己记住刚才选的是谁；重置密码更绕 —— 表格行里那个「重置密码」按钮本身不管用，
 *   它读的是下面工具栏里填的密码。改成从「那个人自己那一行」点进去，就不会对错人。
 * ★ 跟文案提示词弹窗同一个套路：挂在 .app 外面，只在开 / 关 / 切视图时构建一次 DOM。
 *   （renderAll 会被后台任务的进度事件频繁触发；挂在 #pane 里的话，正在勾的复选框会被重画回去。）
 */
function renderUserModal() {
  const mask = $('#umodal'), box = $('#umBox');
  if (!mask || !box) return;
  const m = state.userModal;
  if (!m) { mask.hidden = true; box.innerHTML = ''; return; }
  mask.hidden = false;
  box.innerHTML = m.view === 'pwd' ? upPwdHtml(m.id || '') : upPermHtml(m.id || '');
  // 重置密码那个输入框：开了就聚焦，回车直接提交。
  // ★ 回车只能在这儿绑 —— CSP 不许内联 onkeydown，而 bind() 只跑一次（那时弹窗还没建出来）
  const pwd = box.querySelector('#upPwd');
  if (pwd) {
    pwd.focus();
    pwd.onkeydown = e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const b = box.querySelector('[data-act="up:pwdSave"]');
      if (b) b.click();
    };
  }
}
function openUserModal(view, id) {
  state.userModal = { view: view || 'perm', id: id || '' };
  renderUserModal();
}
function closeUserModal() {
  state.userModal = null;
  renderUserModal();
}

/**
 * 「这个人能不能做管理员操作」——与主进程 ipc.js 的 guardAdmin **同一个口径**：
 * 登录校验关着（免登录 / 开发模式）算有权限，否则看 role。
 * ★ 界面上藏按钮只是不给人添乱，真正拦住的是主进程那道 guardAdmin —— 前端改一行不算数。
 */
function canAdmin() {
  const a = state.auth || {};
  return !a.requireLogin || !!a.isAdmin;
}

/**
 * 高级设置里的一个折叠块：默认收起，需要时展开。
 * （`<details>` 不会继承 .box 里 h3 的样式，所以标题自己给一份）
 */
function advBox(title, open, body, hint) {
  return `<details class="box"${open ? ' open' : ''}>
    <summary style="cursor:pointer;font-size:12.5px;font-weight:600;color:var(--tx2);letter-spacing:.03em">
      ${esc(title)}${hint ? `<span class="hint" style="font-weight:400;margin-left:8px">${esc(hint)}</span>` : ''}
    </summary>
    <div style="margin-top:10px">${body}</div>
  </details>`;
}

/**
 * 管理员专属页签（「高级设置」与「货号颜色校验」）：非管理员整个按钮都不显示。
 * ★ 这只是「不给人添乱」—— 真正拦住的是主进程那几道 guard。但这条不能省：
 *   否则普通成员能点进一个自己改不动、也不该动的页面，只会一头雾水。
 * ★ 两条线都在这里收口：① 按钮 hidden；② 当前 `state.tab` 若正落在一个自己看不到的页签上，
 *   兜回第 1 页（退出登录 / 换账号 / 老配置里存过 tab=4 或 tab=11 时会遇到）。
 */
function syncAdminNav() {
  const ok = canAdmin();
  document.querySelectorAll('.nav[data-admin]').forEach(el => { el.hidden = !ok; });
  if (!ok && TABS[state.tab] && TABS[state.tab].admin) state.tab = 1;
}

/** 这个人能编辑哪些品牌：管理员=全部；成员=名下的（含已停用的，否则停用一个他连看都看不到） */
function myBrands() {
  const m = state.brandsMeta || {};
  const mine = m.mine || [];
  return (m.brands || []).filter(b => canAdmin() || mine.includes(b.id));
}

function bmListHtml() {
  const isAdmin = canAdmin();
  const list = myBrands();
  const def = (state.brandsMeta && state.brandsMeta.defaultBrandId) || '';
  const rows = list.length ? list.map(b => {
    const ok = !!String(b.promptWrite || '').trim();
    const dead = b.enabled === false;
    // 「本次」= 内存里正在用的那个（state.brandId），点了立即生效、不落盘，重启回到默认
    // 「默认」= 落盘的 copy.defaultBrandId，重启后还是它
    const isPick = !!b.id && state.brandId === b.id;
    const isDefault = !!b.id && def === b.id;
    return `<div class="brow${dead ? ' dead' : ''}">
      <span class="bn">${esc(b.name)}</span>
      ${dead ? badge('已停用', 'wait') : badge('启用', 'ok')}
      ${ok ? '<span class="chip">已配文案</span>' : '<span class="chip warn">未配文案</span>'}
      ${isPick ? '<span class="chip run">本次</span>' : ''}
      ${isDefault ? '<span class="chip chip-user">默认</span>' : ''}
      <span class="grow snip">${esc(String(b.promptWrite || '').replace(/\s+/g, ' ').slice(0, 46) || '—')}</span>
      <button class="btn sm" data-act="bm:open" data-id="${b.id}">配置</button>
      <button class="btn sm${isPick ? ' primary' : ''}" data-act="bm:pick" data-id="${b.id}" data-name="${esc(b.name)}" ${dead ? 'disabled' : ''}>选择</button>
      <button class="btn sm${isDefault ? ' primary' : ''}" data-act="bm:default" data-id="${b.id}" data-name="${esc(b.name)}" ${dead ? 'disabled' : ''}>默认选择</button>
    </div>`;
  }).join('') : `<div class="empty">${isAdmin
    ? '还没有品牌。点左下角「新增品牌」建一个，再给它写文案提示词。'
    : '你名下还没有品牌 —— 请联系管理员在「品牌与权限 → 账号管理」里分配。'}</div>`;
  return `
    <div class="mh"><h3>文案提示词</h3><span class="grow"></span>
      <button class="btn sm" data-act="bm:close">关闭</button></div>
    <div class="mb">
      <p class="mnote" style="margin:0 0 11px">每个品牌一份自己的文案提示词 —— <b>点「配置」进去改</b>。
        没配的品牌<b>不允许生成</b>：会直接拦下并提示来这儿补，不会悄悄拿别的品牌的口吻顶替。</p>
      <p class="mnote" style="margin:0 0 11px">右边两个按钮别混：
        <b>「选择」只影响这一次</b>（本次的文案 / 发布单 / 发布都归它，切页签还在，<b>重启就回到默认</b>）；
        <b>「默认选择」会写进配置</b>，以后每次打开都是它。当前状态看行里的「本次」「默认」两个小标。</p>
      <div class="blist">${rows}</div>
    </div>
    <div class="mf">
      ${isAdmin ? '<button class="btn sm primary" data-act="bm:new">新增品牌</button>' : '<span class="mnote">品牌由管理员新建</span>'}
      <span class="grow"></span>
      <span class="mnote">共 ${list.length} 个</span>
    </div>`;
}

function bmEditHtml(id) {
  const isAdmin = canAdmin();
  const isNew = !id;
  const m = state.brandsMeta || {};
  const b = isNew
    ? { id: '', name: '', enabled: true, promptWrite: '' }
    : (m.brands || []).find(x => x.id === id);
  if (!b) {
    return `<div class="mh"><h3>品牌不见了</h3><span class="grow"></span>
        <button class="btn sm" data-act="bm:list">返回列表</button></div>
      <div class="mb"><div class="empty">这个品牌刚被删掉了（可能是在另一个窗口干的）。回列表看看。</div></div>`;
  }
  const picked = (m.defaultBrandId || '') === b.id;
  const meta = isAdmin;   // 改名 / 启停 / 选用只归管理员；提示词谁有权限谁都能改
  return `
    <div class="mh">
      <h3>${isNew ? '新增品牌' : '文案提示词 · ' + esc(b.name)}</h3>
      <span class="grow"></span>
      <button class="btn sm" data-act="bm:list">返回列表</button>
    </div>
    <div class="mb">
      <label class="mfld"><span>品牌名</span>
        <input class="inp" id="bmName" value="${esc(b.name)}" ${meta ? '' : 'readonly'}
          placeholder="品牌名" style="width:100%">
      </label>

      <label class="mfld"><span>文案生成提示词</span>
        <textarea class="mta tall" id="bmWrite" placeholder="写清这个品牌的口吻、面向谁、要写什么、别写什么……">${esc(b.promptWrite)}</textarea>
      </label>
      <p class="mnote">这段是「文案生成」发给模型的角色设定。<b>输出格式</b>（JSON 字段名、标题字数上限）由程序另外追加，不用写在这儿。</p>

      <label class="mchk" style="margin-top:13px" ${meta ? '' : 'data-off="1"'}>
        <input type="checkbox" id="bmEnabled" ${b.enabled === false ? '' : 'checked'} ${meta ? '' : 'disabled'}> 启用该品牌
      </label>
      <label class="mchk" ${meta ? '' : 'data-off="1"'}>
        <input type="checkbox" id="bmPick" ${picked ? 'checked' : ''} ${meta ? '' : 'disabled'}> 本次选用（生成 / 发布默认归属它）
      </label>
      <p class="mnote">「本次选用」同时只会有一个品牌 —— 勾上它，标题栏的「当前品牌」也跟着切过去。</p>
      ${meta ? '' : '<p class="mnote">品牌名 / 启用 / 选用由管理员维护，你能改的是上面两段提示词。</p>'}
    </div>
    <div class="mf">
      ${(isAdmin && !isNew) ? `<button class="btn sm" data-act="bm:del" data-id="${b.id}">删除品牌</button>` : ''}
      <span class="grow"></span>
      <button class="btn sm" data-act="bm:close">取消</button>
      <button class="btn sm primary" data-act="bm:save" data-id="${b.id}">保存</button>
    </div>`;
}

/* ---------------- 设置页：品牌管理 ---------------- */
function brandsHtml() {
  const m = state.brandsMeta;
  if (!canAdmin()) {
    // 普通成员：只看得见自己被分配的品牌，不给增删改
    const mine = m ? (m.brands || []).filter(b => (m.mine || []).includes(b.id)) : [];
    return `<div class="box">
      <h3>我的品牌权限</h3>
      ${mine.length
        ? `<div class="row">${mine.map(b => `<span class="chip${b.enabled === false ? ' warn' : ''}">${esc(b.name)}${b.enabled === false ? '（已停用）' : ''}</span>`).join('')}</div>`
        : '<p class="hint">你还没有被分配任何品牌 —— 请联系管理员到「品牌与权限 → 账号管理」里分配。没有品牌时，<b>文案生成 / 发布单 / 发布</b>这类任务会直接报错停下（不会悄悄发出去）。</p>'}
      <p class="hint">品牌清单、以及谁能用哪些品牌，都由管理员维护。</p>
    </div>`;
  }
  const all = (m && m.brands) || [];
  const rows = all.length ? `<div class="tw"><table>
    <thead><tr><th>品牌</th><th>状态</th><th>文案提示词</th><th>备注</th><th>有权限的账号</th><th>操作</th></tr></thead>
    <tbody>${all.map(b => {
    const us = (state.users || []).filter(u => (u.brands || []).includes(b.id));
    const editing = state.brandEdit && state.brandEdit.id === b.id;
    const hasP = !!String(b.promptWrite || '').trim();
    return `<tr class="${b.enabled === false ? 'warnrow' : ''}">
        <td>${editing
        ? `<input class="inp" id="brdName" value="${esc(b.name)}" style="min-width:130px">`
        : `<b>${esc(b.name)}</b>`}</td>
        <td>${badge(b.enabled === false ? '已停用' : '启用', b.enabled === false ? 'wait' : 'ok')}</td>
        <td>${hasP ? badge('已配', 'ok') : badge('未配', 'warn')}</td>
        <td class="cut">${esc(b.note || '—')}</td>
        <td class="cut">${us.length ? esc(us.map(u => u.displayName || u.username).join('、')) : '<span style="opacity:.6">（没有账号分配）</span>'}</td>
        <td>${editing
        ? `<button class="btn sm primary" data-act="brand:save" data-id="${b.id}">保存</button>
             <button class="btn sm" data-act="brand:cancel">取消</button>`
        : `<button class="btn sm" data-act="brand:edit" data-id="${b.id}">改名</button>
             <button class="btn sm" data-act="brand:toggle" data-id="${b.id}" data-next="${b.enabled === false ? '1' : '0'}">${b.enabled === false ? '启用' : '停用'}</button>
             <button class="btn sm" data-act="brand:del" data-id="${b.id}" data-name="${esc(b.name)}">删除</button>`}</td>
      </tr>`;
  }).join('')}</tbody></table></div>`
    : '<div class="empty">还没有品牌。添加一个之后，才能给账号分配权限，发布记录也才有归属可查。</div>';
  return `
    <div class="box">
      <h3>品牌管理（管理员）</h3>
      ${rows}
      <div class="acct-toolbar">
        <input class="inp" id="nbName" placeholder="品牌名" style="min-width:180px">
        <input class="inp" id="nbNote" placeholder="备注（可不填）" style="min-width:140px">
        <button class="btn sm primary" data-act="brand:add">新增品牌</button>
      </div>
      <div class="acct-toolbar">
        <span class="lbl">默认品牌</span>
        <select class="inp" id="brandDefault">
          <option value="">（不预选）</option>
          ${all.filter(b => b.enabled !== false).map(b => `<option value="${b.id}" ${m.defaultBrandId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
        </select>
        <button class="btn sm" data-act="brand:default">设为默认</button>
        <span class="chip">标题栏的「当前品牌」只列当前账号<b>有权限</b>的品牌</span>
      </div>
      <p class="hint">权限记的是品牌 <b>id</b>，所以<b>改名不会丢掉任何人的权限</b>（存名字就会丢）。删掉的品牌，历史发布记录仍按原样保留，
        在「品牌统计」里单列为「已删除的品牌」，不会被并进别的品牌里。</p>
      <p class="hint">这一页只管品牌本身：<b>文案提示词</b>不在这儿改（到「<b>文案生成 → 提示词配置</b>」的弹窗里配）；
        <b>谁能用哪些品牌</b>也不在这儿分配（到下面的「账号管理」里，点那一行右侧的「<b>配置权限</b>」）。</p>
    </div>`;
}

/* ---------------- 设置页：账号与安全 ---------------- */
function accountHtml() {
  const a = state.auth || {};
  const me = a.user;
  // 免登录模式下没有「当前账号」，但**账号管理表**跟登不登录无关（那是管别人的账号），照样要显示。
  // 原先这里直接 return ''，结果免登录时整块「账号与安全」都不见了 —— 看着像功能被砍了。
  if (!me) {
    return `<div class="box"><h3>账号与安全</h3>
      <p class="hint">免登录模式下没有「当前账号」，改密码请先正常登录。</p>
    </div>
    ${canAdmin() ? adminUsersHtml() : ''}`;
  }
  return `
    <div class="box">
      <h3>账号与安全</h3>
      <div class="row" style="margin-bottom:9px">
        <span class="lbl">当前账号</span>
        <span class="chip chip-user">${esc(me.displayName || me.username)}</span>
        <span class="chip">${esc(me.role === 'admin' ? '管理员' : '普通成员')}</span>
        <span class="chip">${me.lastLoginAt ? '上次登录 ' + esc(fmtDate(me.lastLoginAt)) : '首次登录'}</span>
      </div>
      <div class="row" style="margin-bottom:9px">
        <span class="lbl">当前密码</span>
        <input class="inp mono" id="myOld" type="password" placeholder="现在的密码" style="max-width:210px">
      </div>
      <div class="row">
        <span class="lbl">新密码</span>
        <input class="inp mono" id="myNew1" type="password" placeholder="至少 6 位" style="max-width:150px">
        <input class="inp mono" id="myNew2" type="password" placeholder="再输一次" style="max-width:150px">
        <button class="btn sm primary" data-act="auth:pwd">修改密码</button>
      </div>
      ${me.mustChange ? '<p class="hint">当前仍是<b>出厂口令</b>，请尽快修改。</p>' : ''}
    </div>
    ${canAdmin() ? adminUsersHtml() : '<div class="box"><h3>账号管理</h3><p class="hint">只有管理员能新增/停用账号。</p></div>'}`;
}

function adminUsersHtml() {
  const us = state.users || [];
  const myId = (state.auth && state.auth.user) ? state.auth.user.id : null;
  const all = (state.brandsMeta && state.brandsMeta.brands) || [];
  const brandTag = u => {
    if (u.role === 'admin') return '<span class="chip chip-user">全部品牌</span>';
    const ids = Array.isArray(u.brands) ? u.brands : [];
    if (!ids.length) return '<span class="chip warn">未分配</span>';
    return ids.map(id => {
      const b = all.find(x => x.id === id);
      // 品牌已被删除但授权还挂着（手改过 auth.json 才会出现）：明确标出来，别显示成正常品牌
      return b
        ? `<span class="chip${b.enabled === false ? ' warn' : ''}">${esc(b.name)}${b.enabled === false ? '（停用）' : ''}</span>`
        : '<span class="chip warn">已删除的品牌</span>';
    }).join(' ');
  };
  const rows = us.map(u => `<tr>
      <td>${esc(u.displayName)}</td>
      <td class="mono">${esc(u.username)}</td>
      <td>${badge(u.role === 'admin' ? '管理员' : '成员', u.role === 'admin' ? 'ok' : 'wait')}</td>
      <td>${badge(u.disabled ? '已停用' : '启用', u.disabled ? 'bad' : 'ok')}</td>
      <td class="brandcell">${brandTag(u)}</td>
      <td class="mono">${esc(u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—')}</td>
      <td>${u.id === myId ? '<span class="chip">本人</span>' : `
        <button class="btn sm" data-act="up:perm" data-id="${u.id}">配置权限</button>
        <button class="btn sm" data-act="up:pwd" data-id="${u.id}">重置密码</button>
        <button class="btn sm" data-act="auth:toggle" data-id="${u.id}" data-next="${u.disabled ? '0' : '1'}">${u.disabled ? '启用' : '停用'}</button>
        <button class="btn sm" data-act="auth:del" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>`}</td>
    </tr>`).join('');
  return `
    <div class="box">
      <h3>账号管理（管理员）</h3>
      <div class="tw"><table>
        <thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>品牌权限</th><th>上次登录</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="acct-toolbar">
        <input class="inp mono" id="nuUser" placeholder="新账号（3–32 位）" style="min-width:150px">
        <input class="inp" id="nuName" placeholder="姓名" style="min-width:110px">
        <select class="inp" id="nuRole"><option value="user">普通成员</option><option value="admin">管理员</option></select>
        <input class="inp mono" id="nuPwd" type="password" placeholder="初始密码 ≥6 位" style="min-width:150px">
        <button class="btn sm primary" data-act="auth:create">新建账号</button>
      </div>
      <p class="hint">行里的「<b>配置权限</b>」勾上的品牌，这个人才能在标题栏选到、才能起文案生成 / 发布单 / 发布这类产出任务；
        一个都没勾，他起任务会被直接拦下（不会悄悄发出去）。管理员那一行显示「全部品牌」—— 管理员本来就是全部，不必逐个分配。</p>
      <p class="hint">账号存在本机 <code>auth.json</code>（与 config.json 分开），口令只存 scrypt 哈希，不存明文。
        停用/删除账号<b>不影响</b>已产出的素材、发布单与商品池。连续输错 6 次会锁定 5 分钟。</p>
      <p class="hint"><b>关于这个权限的边界</b>：它是<b>本机离线</b>的，用来防误操作、让产出可归属，<b>不是安全隔离</b> ——
        能碰到这台机器的人可以直接改 <code>auth.json</code> / <code>config.json</code>。别把它当权限系统用。</p>
    </div>`;
}

/* ---------------- 账号操作弹窗的两个视图 ---------------- */

/** 「配置权限」：这个账号能用哪些品牌。管理员不用逐个勾（他就是全部品牌，含以后新增的） */
function upPermHtml(id) {
  const u = (state.users || []).find(x => x.id === id);
  const all = (state.brandsMeta && state.brandsMeta.brands) || [];
  if (!u) {
    return `<div class="mh"><h3>账号不见了</h3><span class="grow"></span>
        <button class="btn sm" data-act="up:close">关闭</button></div>
      <div class="mb"><div class="empty">这个账号刚被删掉了（可能是在另一个窗口干的）。关掉重看列表。</div></div>`;
  }
  const isAdminTarget = u.role === 'admin';
  const mine = Array.isArray(u.brands) ? u.brands : [];
  return `
    <div class="mh">
      <h3>配置权限 · ${esc(u.displayName)}</h3>
      <span class="grow"></span>
      <button class="btn sm" data-act="up:close">关闭</button>
    </div>
    <div class="mb">
      <p class="mnote" style="margin:0 0 11px">账号 <b>${esc(u.username)}</b> ·
        ${esc(u.role === 'admin' ? '管理员' : '普通成员')}${u.disabled ? ' · <b>已停用</b>' : ''}
        —— 勾上的品牌，他才能在标题栏选到、才能起产出任务。</p>
      ${isAdminTarget
      ? '<p class="mnote">管理员 = <b>全部品牌</b>（包括以后新增的），不必逐个分配。要限制他，先把角色改成普通成员。</p>'
      : (all.length
        ? `<div class="perm-list">${all.map(b => `<label class="perm"><input type="checkbox" data-brand="${b.id}" ${mine.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}${b.enabled === false ? '（停用）' : ''}</label>`).join('')}</div>`
        : '<div class="empty">还没有品牌。先到上面的「品牌管理」加一个，再回来分配。</div>')}
    </div>
    <div class="mf">
      <span class="mnote">共 ${all.length} 个品牌</span>
      <span class="grow"></span>
      <button class="btn sm" data-act="up:close">取消</button>
      ${isAdminTarget ? '' : `<button class="btn sm primary" data-act="up:permSave" data-id="${esc(u.id)}">保存权限</button>`}
    </div>`;
}

/** 「重置密码」：管理员给别的账号设一个新口令 */
function upPwdHtml(id) {
  const u = (state.users || []).find(x => x.id === id);
  if (!u) {
    return `<div class="mh"><h3>账号不见了</h3><span class="grow"></span>
        <button class="btn sm" data-act="up:close">关闭</button></div>
      <div class="mb"><div class="empty">这个账号刚被删掉了（可能是在另一个窗口干的）。关掉重看列表。</div></div>`;
  }
  return `
    <div class="mh">
      <h3>重置密码 · ${esc(u.displayName)}</h3>
      <span class="grow"></span>
      <button class="btn sm" data-act="up:close">关闭</button>
    </div>
    <div class="mb">
      <p class="mnote" style="margin:0 0 11px">给账号 <b>${esc(u.username)}</b> 设一个新口令。设完旧口令立刻失效，
        对方用新的登录（重置出来的口令自带「请尽快改掉」的提示）。</p>
      <label class="mfld" style="margin-bottom:0"><span>新密码（至少 6 位、不要用中文）</span>
        <input class="inp mono" id="upPwd" type="password" placeholder="新密码 ≥6 位" style="width:100%">
      </label>
      <p class="mnote" style="margin-top:8px">口令只存 scrypt 哈希 + 随机盐，不存明文 —— 你设完也看不到它。回车即可提交。</p>
    </div>
    <div class="mf">
      <span class="grow"></span>
      <button class="btn sm" data-act="up:close">取消</button>
      <button class="btn sm primary" data-act="up:pwdSave" data-id="${esc(u.id)}">确认重置</button>
    </div>`;
}

/* ---------------- 交互 ---------------- */
const ACTS = {
  'folderTool:open': async el => { await appApi.openExternal(el.dataset.url); },
  // ★ 顶栏主题 Dock（日间 / 夜间 / 玻璃，三个图标）。点哪个图标就直接切哪一档。
  //   落盘仍在主进程做（theme:set），所以下次启动还是这个。
  //   返回值是完整的主题对象 ⇒ 直接把 applyTheme 的结果喂给它，别自己再拼 { shouldUseDarkColors }。
  'theme:set': async (el) => {
    applyTheme(await appApi.themeSet(el.dataset.skin));
  },

  // ---- 热词库（左侧第 12 页）----
  // ★ 改的是**全员**的生成口径，真正拦住的是主进程那两个 guardAdmin（这里只是把话说清楚）。
  'lex:save': async () => {
    const L = state.lex;
    if (!L) return;
    const r = await appApi.hotwordsSave(L.groups.map(g => ({ key: g.key, words: g.words.slice() }))).catch(() => null);
    if (!r || !r.ok) { toast((r && r.error) || '保存失败', 'err'); return; }
    state.lex = r.library;
    state.lexDirty = false;
    if (r.rejected.length) {
      toast(`有 ${r.rejected.length} 个词没进库：` + r.rejected.map(x => `「${x.word}」${x.why}`).join('；'), 'err');
    } else if (r.warnings.length) {
      toast('已保存，但有要留意的地方：' + r.warnings.join('；'), 'err');
    } else {
      toast('词库已保存 —— 下一次生成标题就会用新词（不用重启）');
    }
    renderAll();
  },
  'lex:reset': async () => {
    if (!window.confirm('恢复内置词库？\n\n你在这一页做的增删改会全部丢弃，回到程序自带的那 8 组词。')) return;
    const r = await appApi.hotwordsReset().catch(() => null);
    if (!r || !r.ok) { toast((r && r.error) || '恢复失败', 'err'); return; }
    state.lex = r.library;
    state.lexDirty = false;
    toast('已恢复内置词库');
    renderAll();
  },

  // 「说明书」弹窗：topic 从按钮的 data-topic 上取（写错 topic ⇒ 弹窗打不开，测试点名抓）
  'help:open': (el) => openHelpModal(el.dataset.topic),
  'help:close': () => closeHelpModal(),
  // ---- 应用更新：三个动作都要用户点，主进程不会自己下载、更不会自己重启 ----
  'upd:check': async () => {
    const r = await appApi.updateCheck();
    toast(r.ok ? '正在检查更新…' : r.error, r.ok ? '' : 'err');
    await refreshUpdate();
  },
  'upd:download': async () => {
    const r = await appApi.updateDownload();
    toast(r.ok ? '开始下载更新…' : r.error, r.ok ? '' : 'err');
    await refreshUpdate();
  },
  'upd:install': async () => {
    const r = await appApi.updateInstall();
    if (!r.ok) { toast(r.error, 'err'); return; }
    toast('正在安装，应用马上重启…', 'ok');
  },
  // 切通道：只换「读源上哪个清单文件」，**不动源地址**。换完立刻刷新，别让界面显示旧通道
  'upd:chan:stable': async () => { await switchUpdateChannel('stable'); },
  'upd:chan:beta': async () => { await switchUpdateChannel('beta'); },
  'flatten:pick': async () => {
    const d = await appApi.pickDir({ title: '选择素材目录', defaultPath: state.project.sourceDir || '' });
    if (d) { state.project.sourceDir = d; state.plan = await appApi.run('flatten.plan', { sourceDir: d }).then(r => r.ok ? r.result : null); renderAll(); }
  },
  'flatten:plan': async () => {
    const r = await appApi.run('flatten.plan', { sourceDir: state.project.sourceDir });
    if (r.ok) { state.plan = r.result; toast(`清单已生成：${r.result.total} 个叶子目录`, 'ok'); }
    renderAll();
  },
  'flatten:run': async () => {
    const r = await runJob('flatten.run', { sourceDir: state.project.sourceDir });
    if (r.ok) { state.plan = null; toast(r.result.summary, 'ok'); }
  },
  'flatten:openFlat': async () => { if (state.project.flatDir) await appApi.openPath(state.project.flatDir); },

  'comp:scan': async () => { await runJob('compliance.scan'); },
  'comp:parent': async () => {
    const d = await appApi.pickDir({ title: '选择父目录（里面每个子文件夹独立检查）' });
    if (!d) return;
    await runJob('compliance.scanParent', { dir: d });
  },
  'comp:fix': async () => { await runJob('compliance.fix'); },
  'comp:export': async () => {
    const r = await runJob('compliance.exportReport', { format: 'both' });
    if (r.ok) {
      const n1 = r.result.rows;
      toast(`已导出报告：${n1} 行${r.result.groups ? ` · ${r.result.groups} 个子文件夹` : ''} → ${(r.result.file || r.result.csvFile || '').split(/[\\/]/).pop()}`, 'ok');
      if (r.result.file) await appApi.reveal(r.result.file);
    }
  },

  // ★ 2026-10-08 用户要求删除「按当前素材生成」⇒ 它唯一的处理器 'copy:run' 也随之删除。
  //   注意：'copy:run' 原来就是不带 sourceDir 直接调 copy.generate —— 删掉它是**真的删功能**，
  //   主进程那条对应分支（jobs.js）也一并删了，不是只把按钮藏起来。
  'copy:pickRun': async () => {
    const d = await appApi.pickDir({ title: '选择素材目录（一个目录 = 一个批次，可同时跑多个）', defaultPath: state.project.sourceDir || '' });
    if (!d) return;
    const name = d.split(/[\\/]/).filter(Boolean).pop() || '批次';
    const batchId = `${name}_${batchStamp()}`;
    const r = await runJob('copy.generate', { sourceDir: d, batchId, label: batchId });
    if (r.ok) await afterCopy(r);
  },
  // ---- 模型配置弹窗（唯一的模型入口）----
  // ★「接口自检」一次网络往返，把「地址通不通 / 模型名接口认不认 / 这个模型收不收图」说清楚。
  //   这些事以前只有跑生成时才暴露，而失败还被静默吞成「本地模板」⇒ 用户只看到模板货，
  //   看不到「其实是接口没连上」。有了这个入口，出事第一件事就是点它。
  'copy:model': () => openModelModal(),
  'lm:close': () => closeModelModal(),
  // 「拉取模型清单」：把表单里**当前填的**地址 / Key 带过去 ⇒ 不必先保存就能拉（填错也不会先被写进配置）
  'lm:list': async () => {
    const m = state.modelModal; if (!m) return;
    const val = sel => { const e = $(sel); return e ? e.value.trim() : ''; };
    m.busy = true; m.listErr = ''; m.models = [];
    renderLmList();
    const r = await runJob('copy.llmmodels', { endpoint: val('#lmEndpoint'), apiKey: val('#lmKey') });
    if (state.modelModal !== m) return;         // 拉的过程中弹窗被关掉了，别再往旧状态里写
    const x = (r && r.result) || {};
    m.busy = false;
    m.models = Array.isArray(x.models) ? x.models : [];
    m.listErr = (!r || !r.ok) ? ((r && r.error) || '拉取失败') : (x.listErr || '');
    renderLmList();
  },
  // 点清单里的一行 = 设成默认模型。★ 只写进「默认模型」框，**不落盘** —— 要点「保存」才生效
  'lm:pick': (el) => {
    const m = state.modelModal; if (!m) return;
    const box = $('#lmModel');
    if (box) box.value = el.dataset.id || '';
    renderLmList();
    toast(`已选「${el.dataset.id}」—— 点「保存」才生效`, 'ok');
  },
  // 「接口自检」：★ 测的是**表单里当前填的**地址 / Key / 启用，不是那份可能还没保存的旧配置
  //   （否则用户改完地址点自检，检的还是旧的，结论会骗人）。所以三个值都要带上。
  'lm:test': async () => {
    const val = sel => { const e = $(sel); return e ? e.value.trim() : ''; };
    const r = await runJob('copy.llmtest', {
      endpoint: val('#lmEndpoint'), apiKey: val('#lmKey'), enabled: val('#lmEnabled')
    });
    if (!r.ok) return;
    const x = r.result || {};
    if (x.enabled === false) { toast(x.note || '模型开关关着', 'warn'); return; }
    const img = x.image === true ? '支持看图' : (x.image === false ? '不支持看图' : '清单没写收不收图');
    toast(`接口可用：${x.modelId}（${img}）· ${x.endpointSource}`, x.image === false ? 'warn' : 'ok');
  },
  // 「保存」：表单 → copy.llm.*。★ 空串要**显式写下去**（＝回到「跟随内置」），
  //   不能靠「不写这个键」来留空 —— store.set 是 mergeDeep，不写就等于保留旧值，清不掉上一次填的。
  'lm:save': async () => {
    if (!canAdmin()) { toast('模型配置只有管理员能改', 'err'); return; }
    const val = sel => { const e = $(sel); return e ? e.value.trim() : ''; };
    const llm = {
      enabled: val('#lmEnabled') === 'true',
      endpoint: val('#lmEndpoint'),
      apiKey: val('#lmKey'),
      model: val('#lmModel'),
      vision: val('#lmVision') === 'true',
      imageCount: Number(val('#lmCount')) || 2,
      imageMaxSide: Number(val('#lmSide')) || 768
    };
    await appApi.configSet({ copy: { llm } });
    state.config = await appApi.configGet();
    toast(`模型配置已保存${llm.model ? `（默认模型：${llm.model}）` : '（模型留空 = 跟随内置）'}`, 'ok');
    closeModelModal();
  },
  // 「提示词配置」= 直接开弹窗，不再跳到设置页那两个没人看得懂的输入框
  'copy:prompt': () => {
    if (!state.brandsMeta) { toast('品牌列表还没加载好，稍等一下再点', 'err'); return; }
    openBrandModal('list');
  },
  // 打开最近一次那份 AI 内容报告（跑完已经自动弹过一次资源管理器，这里是回看入口）
  'copy:openReport': async () => {
    if (!lastCopyReport || !lastCopyReport.file) { toast('还没有生成过报告', 'warn'); return; }
    await appApi.reveal(lastCopyReport.file);
  },

  // ---- 文案提示词弹窗 ----
  'bm:list': () => openBrandModal('list'),
  'bm:open': (el) => openBrandModal('edit', el.dataset.id),
  // 「选择」= 本次用它。★ 只改内存里的 state.brandId，**不落盘** —— 这就是它和「默认选择」的全部区别。
  // 后续任务在 runJob 里会把这个 id 随 args 带给主进程（主进程还会再校验一次权限）。
  'bm:pick': (el) => {
    state.brandId = el.dataset.id;
    // 标题栏那个下拉要跟着变 —— 否则「本次」改了却看不见，用户会以为没生效
    // （paintBrandSelect 原先只在刷新品牌列表时调，这条路径得自己叫一次）
    paintBrandSelect();
    toast(`本次使用「${el.dataset.name}」—— 重启后回到默认品牌`, 'ok');
    renderBrandModal();
    renderAll();
  },
  // 「默认选择」= 写进配置（copy.defaultBrandId），重启后还是它
  'bm:default': async (el) => {
    const id = el.dataset.id;
    await appApi.configSet({ copy: { defaultBrandId: id } });
    state.brandId = id;
    state.config = await appApi.configGet();
    await refreshBrands();
    toast(`默认品牌已设为「${el.dataset.name}」`, 'ok');
    renderBrandModal();
    renderAll();
  },
  'bm:new': () => openBrandModal('edit', ''),
  'bm:close': () => closeBrandModal(),
  'bm:save': async (el) => {
    const id = el.dataset.id || '';
    const isAdmin = canAdmin();
    const val = sel => { const e = $(sel); return e ? e.value : ''; };
    const name = val('#bmName').trim();
    const promptWrite = val('#bmWrite');

    const enEl = $('#bmEnabled'), pkEl = $('#bmPick');

    if (!id) {
      // 新增：按钮本来就只给管理员看，主进程还会再校验一次
      if (!name) { toast('先给品牌起个名字', 'err'); return; }
      const r = await appApi.brandAdd({ name, promptWrite, enabled: enEl ? enEl.checked : true });
      if (!r.ok) { toast(r.error, 'err'); return; }
      if (pkEl && pkEl.checked) await appApi.configSet({ copy: { defaultBrandId: r.brand.id } });
      state.config = await appApi.configGet();
      await refreshBrands();
      toast(`已新增品牌「${r.brand.name}」${promptWrite.trim() ? '' : '（还没配文案提示词，生成会被拦下）'}`, 'ok');
      openBrandModal('list');
      renderAll();
      return;
    }

    // 提示词：有权限的人都能改（主进程会再校验一次归属，只认文案提示词这一个字段）
    const r1 = await appApi.brandPrompts(id, { promptWrite });
    if (!r1.ok) { toast(r1.error, 'err'); return; }

    // 品牌名 / 启停 / 选用：只归管理员
    if (isAdmin) {
      const cur = (state.brandsMeta.brands || []).find(x => x.id === id) || {};
      const patch = {};
      if (name && name !== cur.name) patch.name = name;
      if (enEl && enEl.checked !== (cur.enabled !== false)) patch.enabled = enEl.checked;
      if (Object.keys(patch).length) {
        const r2 = await appApi.brandUpdate(id, patch);
        if (!r2.ok) { toast(r2.error, 'err'); return; }
      }
      const wasPicked = (state.brandsMeta.defaultBrandId || '') === id;
      const wantPicked = !!(pkEl && pkEl.checked);
      if (wantPicked && !wasPicked) await appApi.configSet({ copy: { defaultBrandId: id } });
      else if (!wantPicked && wasPicked) await appApi.configSet({ copy: { defaultBrandId: '' } });
    }

    state.config = await appApi.configGet();
    await refreshBrands();
    closeBrandModal();
    renderAll();
    toast('已保存', 'ok');
  },
  'bm:del': async (el) => {
    const id = el.dataset.id;
    const b = (state.brandsMeta.brands || []).find(x => x.id === id) || {};
    const okDel = window.confirm(
      `确定删除品牌「${b.name || id}」？\n\n` +
      '· 已经发出去的历史记录会保留，在「品牌统计」里单列为「已删除的品牌」\n' +
      '· 各账号上这个品牌的权限会被一并清掉\n' +
      '· 该品牌下的批次归属会变成「未标品牌」'
    );
    if (!okDel) return;
    const r = await appApi.brandRemove(id);
    if (!r.ok) { toast(r.error, 'err'); return; }
    state.config = await appApi.configGet();
    await refreshBrands(); await refreshUsers();
    toast(`已删除品牌「${b.name || id}」${r.usersCleaned ? `，同时清了 ${r.usersCleaned} 个账号的授权` : ''}`, 'ok');
    openBrandModal('list');
    renderAll();
  },

  'batch:cancel': async (el) => {
    const nGone = await appApi.cancel(el.dataset.id);
    toast(nGone ? '已请求停止该批次，当前步骤结束后停下' : '这个任务已经结束了', nGone ? '' : 'err');
    renderAll();
  },
  'batch:cancelAll': async () => {
    const list = state.jobs;
    if (!list.length) { toast('当前没有运行中的批次'); return; }
    let nGone = 0;
    for (const j of list) nGone += await appApi.cancel(j.id) || 0;
    toast(`已请求停止 ${nGone} 个批次，当前步骤结束后停下`, '');
    renderAll();
  },
  'batch:detail': (el) => { state.batchDetail = el.dataset.batch; renderAll(); },
  'batch:detailClose': () => { state.batchDetail = null; renderAll(); },

  // ---- 运行日志（左侧「执行」组那一页）----
  // ★ 清空走统一的 clearLogs()：底部日志栏与页面必须一起清。
  //   说清「清的是什么」—— 主进程那份还在，重新登录会再拉回来；不写清就会被当成"清了个假的"。
  'log:clear': () => {
    // ★ 报「清了多少条」要按**界面上看的那些**（大结论）算：明细本来就不在界面上，
    //   把它算进去会报出一个用户从没见过的数字（屏幕上 12 行、提示「已清空 300 条」）。
    const before = uiLogs().length;
    clearLogs();
    toast(before
      ? `已清空 ${before} 条运行日志（清的是界面这份缓存；主进程还留着最近 500 条，重新登录会再拉回来）`
      : '本来就没有日志', '');
    renderAll();
  },
  'log:export': async () => {
    const r = await appApi.logExport(logExportPayload());
    if (!r || !r.ok) {
      // ★ 失败必须说出来，而且留在页面上（toast 三秒就没了，用户回头看不到）
      state.logExportErr = (r && r.error) || '导出失败';
      toast(state.logExportErr, 'err');
      renderAll();
      return;
    }
    state.logExportErr = '';
    state.logExport = { file: r.file, jsonFile: r.jsonFile, count: r.count };
    toast(`已导出 ${r.count} 条运行日志 → ${String(r.file || '').split(/[\\/]/).pop()}`, 'ok');
    renderAll();
  },
  'log:openFile': async () => { const f = (state.logExport || {}).file; if (f) await appApi.openPath(f); },
  'log:revealFile': async () => { const f = (state.logExport || {}).file; if (f) await appApi.reveal(f); },

  'verify:run': async () => { await runJob('verify.check'); },
  'verify:pool': async () => {
    const f = await appApi.pickFile({ title: '导入商品池（CSV/TSV/JSON：货号 + 颜色）' });
    if (!f) return;
    const r = await appApi.run('pool.import', { file: f });
    if (r.ok) { state.info = await appApi.info(); toast(`商品池已导入：${r.result.count} 个货号`, 'ok'); }
    renderAll();
  },

  'sheet:export': async () => {
    const r = await runJob('sheet.export', {});
    if (r.ok) toast(`已导出 ${r.result.rowCount} 行 × ${r.result.colCount} 列`, 'ok');
  },
  'sheet:open': async () => { if (state.project.sheet.file) await appApi.openPath(state.project.sheet.file); },
  'sheet:dir': async () => { await appApi.openPath(state.config.paths.output); },
  'sheet:openReport': async () => { const f = (state.project.publish || {}).reportFile; if (f) await appApi.openPath(f); },
  'sheet:importReport': async () => {
    const f = await appApi.pickFile({
      title: '选择「AI 内容报告」xlsx（一个叶子文件夹 = 一条内容）',
      filters: [{ name: 'Excel 报告', extensions: ['xlsx'] }]
    });
    if (!f) return;
    // 先静默试一次：报告里自带「素材路径」就直接用；没有的话再问一次这一批的素材目录
    let r = await appApi.run('report.import', brandArgs('report.import', { file: f }));
    if (!r.ok && /素材路径/.test(r.error || '')) {
      const d = await appApi.pickDir({
        title: '这份报告的「素材路径」是空的 —— 请选择这一批的素材目录（D:\\你的素材目录\\20260901 这种，里面每个叶子文件夹 = 一条内容）'
      });
      if (!d) { toast('已取消：报告里没有素材路径，也没有选素材目录', 'err'); return; }
      r = await appApi.run('report.import', brandArgs('report.import', { file: f, dir: d }));
    }
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    const x = r.result;
    // 货号/颜色是**补**过的：补了几条、有没有写回文件、有哪些对不上 —— 一条条如实说，别只报「导入成功」
    const fx = x.filled || {};
    const fw = x.fillWrite || {};
    const part = [];
    if (fw.updated) part.push(`已按叶子文件夹名补写 ${fw.updated} 条货号/颜色`);
    else if ((fx.sku || 0) + (fx.color || 0)) part.push(`补出货号/颜色但没能写回文件${fw.busy ? '（报告被占用，关掉 WPS 再导入一次即可）' : ''}`);
    if ((fx.mismatch || []).length) part.push(`${fx.mismatch.length} 条货号与文件夹名对不上，要人看`);
    if ((fx.noParse || []).length) part.push(`${fx.noParse.length} 条文件夹名里没有「货号+颜色」`);
    toast(`报告已导入：${x.total} 条待发布（用报告里的标题文案 ${x.fromReport} 条 · 本地生成 ${x.generated} 条${x.blocked ? ` · ${x.blocked} 条暂不发布` : ''}）`
      + (part.length ? ' · ' + part.join(' · ') : ''), x.blocked ? '' : 'ok');
    // ★ 不再强跳「发布单」页：从「模拟器发布」页点的导入，就该留在那一页接着选间隔、开始发布
    renderAll();
  },

  'pub:connect': async () => {
    const r = await appApi.run('publish.connect', {});
    if (r.ok) toast(r.result.note, r.result.connected ? 'ok' : '');
    renderAll();
  },
  'pub:probe': async () => {
    const r = await appApi.run('publish.probe', {});
    if (r.ok) {
      state.probe = r.result;
      const fx = r.result.fix || [];
      const bad = fx.filter(f => f.level === 'bad').length;
      const warn = fx.filter(f => f.level === 'warn').length;
      toast(bad ? `还不能真机发布：有 ${bad} 项要先处理，看下面的提示`
        : warn ? `可以真机发布，但有 ${warn} 处会影响体验`
          : '一切就绪，可以真机发布',
      bad ? 'err' : warn ? '' : 'ok');
    }
    renderAll();
  },
  'pub:dump': async () => {
    const r = await appApi.run('publish.dump', {});
    if (r.ok) {
      toast(`抓到 ${r.result.nodeCount} 个节点，候选定位表已生成：${r.result.mapFile.split(/[\\/]/).pop()}`, 'ok');
      const cfg = await appApi.configGet();
      state.config = cfg;
    }
    renderAll();
  },
  'pub:map': async () => {
    const f = await appApi.pickFile({ title: '导入 UI 定位表（uiMap.json）', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!f) return;
    const r = await appApi.run('publish.importMap', { file: f });
    if (r.ok) { state.config = await appApi.configGet(); toast(`定位表已导入：${r.result.steps} 步`, 'ok'); }
    renderAll();
  },
  'pub:addDev': async () => {
    const name = (document.getElementById('devName') || {}).value || '';
    const serial = (document.getElementById('devSerial') || {}).value || '';
    if (!serial.trim()) { toast('这里要先填序列号 —— 更省事的是上面点「扫描设备」，从列表里「加入并使用」', 'err'); return; }
    const r = await appApi.run('publish.addDevice', { name: name.trim(), serial: serial.trim() });
    if (r.ok) { state.config = await appApi.configGet(); toast('已添加设备', 'ok'); }
    renderAll();
  },
  'pub:delDev': async (el) => {
    await appApi.run('publish.removeDevice', { id: el.dataset.id });
    state.config = await appApi.configGet();
    renderAll();
  },
  'pub:useDev': async (el) => {
    await appApi.configSet({ publish: { device: el.dataset.serial } });
    state.config = await appApi.configGet();
    state.project.publish = state.project.publish || {};
    await appApi.run('publish.connect', { device: el.dataset.serial });
    state.project = await appApi.projectGet();
    renderAll();
  },
  // 扫描：问 adb「现在都连着谁」——连配置里没加过的设备也一并列出来（用户不用再自己抄序列号）
  'pub:devScan': async () => {
    const r = await appApi.run('publish.devices', {});
    if (r.ok) {
      const map = {};
      (r.result.devices || []).forEach(d => { map[d.serial] = d; });
      state.devStatus = map;
      state.devFound = r.result.found || [];
      // ★ 同一个模拟器在多个端口上会被 adb 各报一次，去重后才是「几台设备」
      const uniq = state.devFound.filter(d => !d.dupOf);
      const online = uniq.filter(d => d.online).length;
      const fresh = uniq.filter(d => !d.configured).length;
      const dupN = state.devFound.length - uniq.length;
      toast(uniq.length
        ? `adb 认到 ${uniq.length} 台设备，${online} 台在线${fresh ? `（其中 ${fresh} 台还没加进来，可直接「加入并使用」）` : ''}`
          + (dupN ? `；另有 ${dupN} 个序列号是同一台设备的其它端口，已合并` : '')
        : 'adb 现在一台设备都没认到：先把模拟器启动起来，并确认它开了「ADB 调试」',
      uniq.length ? (online ? 'ok' : '') : 'err');
    }
    renderAll();
  },
  // adb 认到、还没加进列表的设备：一键加入并选用。
  // ★ 有了这一步，用户永远不用知道 emulator-5554 是什么 —— 原来他得自己把那个名字抄进输入框。
  'pub:useFound': async (el) => {
    const serial = el.dataset.serial;
    const add = await appApi.run('publish.addDevice', { name: serial, serial });
    if (!add.ok && !/已存在/.test(add.error || '')) { toast(add.error || '加入失败', 'err'); renderAll(); return; }
    await appApi.configSet({ publish: { device: serial } });
    state.config = await appApi.configGet();
    state.project.publish = state.project.publish || {};
    const r = await appApi.run('publish.connect', { device: serial });
    state.project = await appApi.projectGet();
    toast(r.ok ? `${serial}：${r.result.note}` : `${serial} 已加入，但连接没成`, r.ok ? 'ok' : 'err');
    renderAll();
  },
  // 「去高级设置」：发布页/设置页只剩只读回显时，给管理员一条直达的路
  'go:advanced': () => { state.tab = 11; renderAll(); },
  'pub:run': async () => {
    // ★★ 不是真实设备通道就先问一句：模拟通道**不碰设备**，跑完只是演练节奏与回写。
    //   以前这里默默就跑，用户看到界面一路「发布成功」、模拟器里却毫无动静（2026-10-03 实际发生）。
    const pub = state.project.publish || {};
    if ((pub.mode || 'mock') !== 'adb') {
      const why = pub.connected ? '' : '（设备还没连上：先点上面的「连接模拟器」，再用「检查能不能发布」确认通过）';
      if (!window.confirm('当前是「模拟通道」—— 不会真的发到得物，只演练发布节奏与结果回写' + why + '。\n\n确定要演练吗？')) return;
    }
    await runJob('publish.run', {});
  },
  'pub:exportLog': async () => {
    const batch = (state.project.publish || {}).batch || '';
    const r = await runJob('publish.exportLog', { batch });
    if (r.ok) {
      toast(`已导出 ${r.result.entries} 条日志（成功 ${r.result.ok} / 失败 ${r.result.failed}）→ ${(r.result.file || '').split(/[\\/]/).pop()}`, 'ok');
      if (r.result.file) await appApi.reveal(r.result.file);
    }
  },
  'pub:stop': async () => { const nGone = await appApi.cancel('publish.run'); toast(nGone ? '已请求停止，当前步骤结束后停下' : '当前没有在跑的发布任务', nGone ? '' : 'err'); renderAll(); },
  'pub:rerun': async (el) => {
    const seq = el.dataset.seq;
    await runJob('publish.rerun', { seq });
  },

  'auth:pwd': async () => {
    const p1 = $('#myNew1').value, p2 = $('#myNew2').value;
    if (!p1) { toast('请填写新密码', 'err'); $('#myNew1').focus(); return; }
    if (p1 !== p2) { toast('两次新密码不一致', 'err'); return; }
    const r = await appApi.authChangePwd($('#myOld').value, p1);
    if (!r.ok) { toast(r.error, 'err'); return; }
    $('#myOld').value = ''; $('#myNew1').value = ''; $('#myNew2').value = '';
    state.auth = await appApi.authStatus();
    toast('密码已更新，下次登录用新密码', 'ok');
    renderAll();
  },
  'auth:create': async () => {
    const input = {
      username: $('#nuUser').value.trim(),
      displayName: $('#nuName').value.trim(),
      role: $('#nuRole').value,
      password: $('#nuPwd').value
    };
    const r = await appApi.authCreateUser(input);
    if (!r.ok) { toast(r.error, 'err'); return; }
    $('#nuUser').value = ''; $('#nuName').value = ''; $('#nuPwd').value = '';
    await refreshUsers();
    toast(`已创建账号 ${input.username}`, 'ok');
    renderAll();
  },
  'auth:toggle': async (el) => {
    const r = await appApi.authUpdateUser(el.dataset.id, { disabled: el.dataset.next === '1' });
    if (!r.ok) { toast(r.error, 'err'); return; }
    await refreshUsers();
    toast(el.dataset.next === '1' ? '已停用' : '已启用', 'ok');
    renderAll();
  },
  'auth:del': async (el) => {
    if (!window.confirm(`确定删除账号 ${el.dataset.name}？删除后对方无法登录（已产出的数据不受影响）。`)) return;
    const r = await appApi.authRemoveUser(el.dataset.id);
    if (!r.ok) { toast(r.error, 'err'); return; }
    await refreshUsers();
    toast('已删除', 'ok');
    renderAll();
  },

  // ---- 账号操作弹窗（配置品牌权限 / 重置密码）----
  // ★ 两个入口都在账号管理表**每一行右侧**：从人那一行点进去，不会像旧的下拉框那样对错人。
  'up:perm': (el) => openUserModal('perm', el.dataset.id),
  'up:pwd': (el) => openUserModal('pwd', el.dataset.id),
  'up:close': () => closeUserModal(),
  'up:permSave': async (el) => {
    const id = el.dataset.id;
    if (!id) { toast('没拿到账号，关掉重开一次', 'err'); return; }
    const boxes = [...document.querySelectorAll('#umBox [data-brand]')];
    if (!boxes.length) {
      // 管理员行的复选框本来就一个都没有（权限 = 全部品牌），这不是「还没建品牌」
      const u = (state.users || []).find(x => x.id === id);
      if (u && u.role === 'admin') { closeUserModal(); toast('管理员 = 全部品牌，不用单独分配'); return; }
      toast('还没有品牌：先到上面的「品牌管理」添加一个', 'err');
      return;
    }
    const ids = boxes.filter(b => b.checked).map(b => b.dataset.brand);
    const r = await appApi.authUpdateUser(id, { brands: ids });
    if (!r.ok) { toast(r.error, 'err'); return; }
    await refreshUsers();
    closeUserModal();
    toast(ids.length ? `已保存品牌权限：${ids.length} 个品牌` : '已清空品牌权限（该账号将无法起产出任务）', 'ok');
    renderAll();
  },
  'up:pwdSave': async (el) => {
    const id = el.dataset.id;
    const inp = document.getElementById('upPwd');
    const pwd = inp ? inp.value : '';
    if (!id) { toast('没拿到账号，关掉重开一次', 'err'); return; }
    if (!pwd) { toast('先填好新密码（≥6 位）', 'err'); if (inp) inp.focus(); return; }
    const r = await appApi.authResetPwd(id, pwd);
    if (!r.ok) { toast(r.error, 'err'); return; }
    closeUserModal();
    await refreshUsers();
    toast('密码已重置，对方首次登录后可自行修改', 'ok');
    renderAll();
  },

  // ---- 品牌管理（管理员）----
  'brand:add': async () => {
    const name = ($('#nbName') || {}).value || '';
    const note = ($('#nbNote') || {}).value || '';
    if (!name.trim()) { toast('先填品牌名', 'err'); return; }
    const r = await appApi.brandAdd({ name: name.trim(), note: note.trim() });
    if (!r.ok) { toast(r.error, 'err'); return; }
    $('#nbName').value = ''; $('#nbNote').value = '';
    await refreshBrands(); await refreshUsers();
    toast(`已新增品牌 ${r.brand.name}`, 'ok');
    renderAll();
  },
  'brand:edit': (el) => { state.brandEdit = { id: el.dataset.id }; renderAll(); },
  'brand:cancel': () => { state.brandEdit = null; renderAll(); },
  'brand:save': async (el) => {
    const box = document.getElementById('brdName');
    if (!box) return;
    const r = await appApi.brandUpdate(el.dataset.id, { name: box.value });
    if (!r.ok) { toast(r.error, 'err'); return; }
    state.brandEdit = null;
    await refreshBrands();
    toast('品牌已改名（已分配的权限不受影响，因为记的是 id）', 'ok');
    renderAll();
  },
  'brand:toggle': async (el) => {
    const on = el.dataset.next === '1';
    const r = await appApi.brandUpdate(el.dataset.id, { enabled: on });
    if (!r.ok) { toast(r.error, 'err'); return; }
    await refreshBrands();
    toast(on ? '品牌已启用' : '品牌已停用：只拿到这个品牌的账号将无法再起产出任务', on ? 'ok' : '');
    renderAll();
  },
  'brand:del': async (el) => {
    const name = el.dataset.name;
    const okDel = window.confirm(
      `确定删除品牌「${name}」？\n\n` +
      '· 已经发出去的历史记录会保留，在「品牌统计」里单列为「已删除的品牌」\n' +
      '· 各账号上这个品牌的权限会被一并清掉\n' +
      '· 该品牌下的批次归属会变成「未标品牌」'
    );
    if (!okDel) return;
    const r = await appApi.brandRemove(el.dataset.id);
    if (!r.ok) { toast(r.error, 'err'); return; }
    await refreshBrands(); await refreshUsers();
    toast(`已删除品牌「${name}」${r.usersCleaned ? `，同时清了 ${r.usersCleaned} 个账号的授权` : ''}`, 'ok');
    renderAll();
  },
  'brand:default': async () => {
    const sel = $('#brandDefault');
    const id = sel ? sel.value : '';
    await appApi.configSet({ copy: { defaultBrandId: id } });
    state.config = await appApi.configGet();
    await refreshBrands();
    toast(id ? `默认品牌已设为 ${brandNameOf(id)}` : '已取消默认品牌', 'ok');
    renderAll();
  },

  // ---- 品牌统计 ----
  'stats:refresh': async () => {
    state.stats = null;
    state.statsTried = false;
    await loadStats();
  },
  'stats:export': async () => {
    const r = await appApi.statsExport(state.statsOpts);
    if (!r.ok) { toast(r.error || '导出失败', 'err'); return; }
    toast(`已导出：${(r.file || '').split(/[\\/]/).pop()}（${r.brandCount} 个品牌 · ${r.totals.rows} 条记录）`, 'ok');
    if (r.file) await appApi.reveal(r.file);
  },
  'stats:exportLog': async () => {
    const r = await appApi.statsExportLog(state.statsOpts);
    if (!r.ok) { toast(r.error || '导出失败', 'err'); return; }
    // 两个条数都报：本次导了几条、日志文件里一共几条（差多少一眼看得出）
    toast(`执行日志已导出：${r.entries} 条${r.entriesInFile !== r.entries ? `（日志文件里共 ${r.entriesInFile} 条，其余被当前筛选排除）` : ''}`, 'ok');
    if (r.file) await appApi.reveal(r.file);
  },
  // 输出目录自检：只报事实（哪一项没通过、具体错在哪），不做任何自动"修复"
  'stats:checkPath': async () => {
    const r = await appApi.statsCheckPath();
    state.statsPath = r && r.ok !== undefined ? r : { ok: false, checks: [], error: '自检没有返回结果', dir: '' };
    toast(state.statsPath.ok ? '输出目录可写：日志能正常落盘' : `输出目录有问题：${state.statsPath.error || ''}`,
      state.statsPath.ok ? 'ok' : 'err');
    renderAll();
  },

  // ---- 得物安装包（模拟器自带的应用商店搜不到得物时的兜底）----
  // 「下载到本机」= 把**内置的** apk 另存到用户选的位置（主进程弹「另存为」），
  //   存完顺手替他打开所在文件夹 —— 下一步就是把它拖进 MuMu 窗口，不打开他还得自己找。
  'apk:save': async () => {
    const r = await appApi.apkSaveDewu();
    if (r && r.canceled) return;                       // 用户自己取消的，不弹"失败"
    if (!r || !r.ok) { toast((r && r.error) || '另存失败', 'err'); return; }
    toast(`得物安装包已存到：${r.path} —— 现在把它拖进 MuMu 窗口就会自动装上`, 'ok');
    await appApi.reveal(r.path);
  },
  // 「装进模拟器」：**先读设备再动手**。已经装了就不发任何安装命令，把版本如实报出来，
  //   并把「覆盖重装」按钮挂出来（state.dewuAlready）—— 覆盖重装必须由用户再点一次，不替他做决定。
  'apk:install': async () => {
    const r = await appApi.run('publish.installDewuApk', {});
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    const d = r.result || {};
    if (d.already) {
      state.dewuAlready = true;
      toast(`模拟器里已经有得物${d.installedVersion ? ' ' + d.installedVersion : ''} —— 我没有动它。`
        + '确实要覆盖重装，点这一行新出现的「覆盖重装」', '');
    } else {
      state.dewuAlready = false;
      toast(`已装进模拟器：得物${d.installedVersion ? ' ' + d.installedVersion : ''}`
        + `${d.replaced ? '（覆盖重装，应用数据与登录状态保留）' : ''}`, 'ok');
    }
    renderAll();
  },
  'apk:installForce': async () => {
    const r = await appApi.run('publish.installDewuApk', { force: true });
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    state.dewuAlready = false;
    toast(`覆盖重装完成：得物 ${(r.result && r.result.installedVersion) || ''}（应用数据与登录状态保留）`, 'ok');
    renderAll();
  },

  'cfg:save': async () => { await saveCfgFromDom(); toast('已保存', 'ok'); }
  // ★ 2026-10-04：「cfg:path」（选输出目录 / 隔离目录）随设置页那一块一起删 ——
  //   界面上已经没有任何 data-act="cfg:path" 的入口，留着处理器就是死代码。
  //   两个目录改走出厂默认值（winpath.js），主进程的读取点（合规报告 / 日志 / 统计 / 隔离）全都没动。
};

async function saveCfgFromDom() {
  const patch = {};
  document.querySelectorAll('#pane [data-cfg]').forEach(el => {
    const key = el.dataset.cfg;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.preset === 'interval') { const [a, b] = el.value.split('-'); patch.publish = Object.assign({}, patch.publish, { intervalMinSec: +a, intervalMaxSec: +b }); return; }
    else v = el.value;
    // ★ publish.intervalSec 必须在里面：它的值是字符串（"0" 也是 truthy），
    //   存成字符串再走到主进程，加法/比较的地方就会出怪事；而且 "0" 看起来"有值"、
    //   实际含义是「连续发布」，一定要落成数字 0。
    if (['copy.concurrency', 'copy.extraTopics', 'publish.intervalSec'].includes(key)) v = Number(v);
    if (key.endsWith('.enabled')) v = v === 'true' || v === true;
    // ★ 这一类是「送图 / 不送图」的开关，值是字符串 'true'/'false'。
    //   漏了这一步就会把 'false' 存成字符串，而主进程里 `'false' !== false` ⇒ 「不送图」白点。
    //   （主进程 copywriter.cfgOf 也做了真值兜底 —— 两头都兜，别只靠这一处。）
    if (key === 'copy.llm.vision') v = v === 'true' || v === true;
    const parts = key.split('.');
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = v;
  });
  await appApi.configSet(patch);
  state.config = await appApi.configGet();
  // ★ 外部工具的路径改完要**立刻**看得见「现在用的是哪一个」：adb / ffmpeg 的三段解析结果
  //   在主进程的 app:info 里，不刷新的话「外部依赖」表还写着旧状态，用户会以为没生效。
  //   只在真动了这两个键时刷新，且只在这两页重画 —— 别的页重画会打断正在输入的人。
  const p2 = patch.publish || {};
  if (Object.prototype.hasOwnProperty.call(p2, 'adbPath') || Object.prototype.hasOwnProperty.call(p2, 'ffmpegPath')) {
    state.info = await appApi.info();
    if (state.tab === 7 || state.tab === 11) renderAll();
  }
}

/**
 * 页内所有 data-cfg 控件：一改就存。
 * ★ 以前只在「设置」页绑这一段，可「文案生成」和「模拟器发布」页里也有设置项
 *   （并发路数 / 轮换策略 / 必带话题 / 额外话题 / 发布间隔 / 失败重试 / adb 路径）——
 *   那两页改了其实**从来没保存过**，而且界面上一点提示都没有，看着像生效了。
 *   所以改成每个页签渲染完都绑一次。
 */
function bindCfgInputs() {
  document.querySelectorAll('#pane [data-cfg]').forEach(el => {
    el.onchange = () => { saveCfgFromDom(); };
  });
}

/** 设置页 + 「品牌与权限」页的绑定。两页共用：按 id 找，找不到就跳过（原先有个 early return，会把另一页的绑定一起跳过） */
function bindSettings() {
  // 主题那个下拉已删（2026-10-03）：入口搬到顶栏的「主题 Dock」（#themeDock），不需要在这里绑。
  // data-cfg 的绑定不在这里了 —— 改成每个页签都绑（见 bindCfgInputs）
  // 「品牌权限」那条下拉工具栏已删（2026-10-02 用户要求）：现在从账号管理表每行右侧的
  // 「配置权限」进弹窗，弹窗自己带状态，不必在这里按「当前选中的账号」重画。
}

/** 品牌统计页：三个下拉改了就记进 state.statsOpts，点「查询」才真去读日志（避免每动一下就全量读盘） */
function bindStats() {
  const wire = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => { state.statsOpts[key] = el.value; };
  };
  wire('#stDays', 'days');
  wire('#stBrand', 'brandId');
  // 换了筛选条件，执行人下拉的候选也会变，所以清掉防止选到一个当前范围内不存在的人
  const ub = $('#stUser');
  if (ub) {
    ub.onchange = () => { state.statsOpts.userId = ub.value; };
  } else {
    state.statsOpts.userId = '';
  }
}

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
  bind();
}

function bind() {
  bindThemeDock();          // 顶栏主题 Dock 的「按距离弹簧放大」（点击走 data-act=theme:set）
  $('#btnLogout').onclick = () => doLogout();

  // 标题栏的「当前品牌」：改了就记住（下次进来还是它）。
  // 只是省事，不是权限 —— 主进程每次起任务都会再校验一遍
  const bsel = $('#brandSel');
  if (bsel) bsel.onchange = async () => {
    state.brandId = bsel.value;
    await appApi.configSet({ copy: { defaultBrandId: bsel.value } });
    state.config = await appApi.configGet();
    await refreshBrands();
    renderAll();
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTS[el.dataset.act];
    if (fn) fn(el);
  });

  // 点遮罩关弹窗；点弹窗本体不关（否则选字拖一下鼠标就没了）
  const bmask = $('#bmodal');
  if (bmask) bmask.addEventListener('click', e => { if (e.target === bmask) closeBrandModal(); });
  const umask = $('#umodal');
  if (umask) umask.addEventListener('click', e => { if (e.target === umask) closeUserModal(); });
  const hmask = $('#hmodal');
  if (hmask) hmask.addEventListener('click', e => { if (e.target === hmask) closeHelpModal(); });
  const lmmask = $('#lmmodal');
  if (lmmask) lmmask.addEventListener('click', e => { if (e.target === lmmask) closeModelModal(); });

  document.querySelectorAll('.nav').forEach(b => {
    b.onclick = () => { state.tab = Number(b.dataset.tab); renderAll(); };
  });

  $('#capMin').onclick = () => appApi.min();
  $('#capMax').onclick = () => appApi.toggleMax();
  $('#capClose').onclick = () => appApi.close();
  $('.titlebar').ondblclick = e => { if (!e.target.closest('.cap')) appApi.toggleMax(); };
  // 清空必须走 clearLogs()：底部日志栏与「运行日志」页要一起清（只清一边就不是「同步」了）
  $('#logClear').onclick = () => { clearLogs(); if (state.tab === 10) renderAll(); };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.brandModal) { closeBrandModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.userModal) { closeUserModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.helpModal) { closeHelpModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.modelModal) { closeModelModal(); e.preventDefault(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = Number(e.key);
      // ★ TABS[k] 必须存在：页签 5 已删，Ctrl+5 落到空位的话原来是整页崩（读 undefined.title）
      if (k >= 1 && k <= 9 && TABS[k]) { state.tab = k; renderAll(); e.preventDefault(); }
    }
  });

  appApi.onLog(pushLog);
  appApi.onProject(p => { state.project = p; renderAll(); });
  appApi.onTheme(applyTheme);
  appApi.onMaxChange(m => {
    $('#capMaxIcon').innerHTML = m
      ? '<rect x=".7" y="2.7" width="6.6" height="6.6" rx="1"/><path d="M2.7 2.7h-.7a1.3 1.3 0 0 0-1.3 1.3v.7"/>'
      : '<rect x=".7" y=".7" width="8.6" height="8.6" rx="1"/>';
  });
  appApi.onJobStart(j => {
    state.jobs = state.jobs.filter(x => x.id !== j.id);
    state.jobs.push({ id: j.id, type: j.type, label: j.label || j.type, batch: j.batch || '', progress: null, startedAt: j.startedAt || Date.now() });
    renderAll();
  });
  appApi.onJobProgress(p => {
    let j = state.jobs.find(x => x.id === p.id);
    if (!j) {
      j = { id: p.id, type: p.type, label: p.label || p.type, batch: p.batch || '', progress: null, startedAt: Date.now() };
      state.jobs.push(j);
    }
    j.progress = Object.assign({}, p);
    j.elapsedSec = j.startedAt ? (Date.now() - j.startedAt) / 1000 : 0;
    updateProgress(p);
    if (state.tab === 3 || state.tab === 6) refreshBatches();
  });
  appApi.onPublishRow(() => { state.publishRowTick++; if (state.tab === 6) renderAll(); });
  appApi.onJobDone(d => {
    state.jobs = state.jobs.filter(x => x.id !== d.id);
    if (!d.ok) toast(d.error || '任务失败', d.cancelled || /已取消/.test(d.error || '') ? '' : 'err');
    renderAll();
  });
  appApi.onUpdate(u => {
    const prev = state.upd;
    // 只有「状态真的变了」才整页重画；下载进度每秒好几条，只动进度条那两处 ——
    // 整页重画会把用户正在输入的框重置回旧值（品牌弹窗踩过同一个坑）
    const big = !prev || prev.status !== u.status || prev.supported !== u.supported || prev.latest !== u.latest;
    state.upd = u;
    if (state.tab !== 7) return;
    if (big) renderAll(); else updateUpdateBar(u);
  });
}

async function boot() {
  state.info = await appApi.info();
  applyTheme(await appApi.themeGet());
  state.auth = await appApi.authStatus();
  if (state.auth.requireLogin && !state.auth.user) { showGate(); return; }
  await enterApp();
}

boot();
