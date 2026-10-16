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
  usageView: 'summary', usageAccount: '', usagePage: 0,
  statsOpts: { days: 30, brandId: '', userId: '', rangeMode: 'preset', fromAt: '', toAt: '' },
  statsQueryOpts: null,
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
  logs: [],           // ★ 运行日志只有这一份数据：底部日志栏与左侧「运行日志」页都读它
  logFilter: { days: 30, rangeMode: 'preset', fromAt: '', toAt: '' },   // 「运行日志」页的筛选（只影响这一页，不动底部日志栏）
  logExport: null,    // 上一次导出结果 { file, jsonFile, count }，用来给「打开 / 定位」按钮指路
  logExportErr: '',   // 上一次导出的失败原因（失败要说出来，不能只在 toast 里一闪而过）
  devStatus: null,    // 「扫描设备」逐台结果 { serial: {...} }，null = 还没扫过
  devFound: null,     // 「扫描设备」时 adb 认到的**全部**设备（含还没加进列表的），null = 还没扫过
  lex: null,          // 热词库快照（主进程 hotwords:get 的返回）；null = 还没读到
  lexBusy: false,
  lexTransferBusy: false,
  lexTried: false,    // 读失败过就不再自动重试（否则 render → load → render 会打转）
  lexDirty: false,    // 界面上改了但还没点「保存」
  lexUndo: [],
  lexRedo: [],
  lexSavedFingerprint: '',
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
function logTimeRange() {
  const f = state.logFilter || {};
  if (f.rangeMode === 'custom') {
    const from = Date.parse(f.fromAt), to = Date.parse(f.toAt);
    return { from, to, valid: Number.isFinite(from) && Number.isFinite(to) && from <= to };
  }
  return { from: Number(f.days) > 0 ? Date.now() - Number(f.days) * 86400000 : 0, to: Infinity, valid: true };
}
function filteredLogs() {
  const r = logTimeRange();
  return r.valid ? uiLogs().filter(e => Number(e.t) >= r.from && Number(e.t) <= r.to) : [];
}
/** 一条日志追加到「运行日志」页（只在该页开着时才动 DOM，且要过一遍当前筛选） */
function appendToLogPane(e) {
  if (isDetailLog(e) || !$('#logPaneLines')) return;
  renderLogPaneLines();
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
}
/** 「运行日志」页只重画行本身：整页重排会把筛选框里正在输入的光标顶掉 */
function renderLogPaneLines() {
  const box = $('#logPaneLines');
  if (!box) return;
  box.innerHTML = filteredLogs().map(e => `<div>${logLineHtml(e)}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}
/** 需要导出给主进程的那些：**当前筛选下来的**，外加上下文（筛选条件 + 缓冲区总数 + 明细条数） */
function logExportPayload() {
  const ui = uiLogs();
  return {
    entries: filteredLogs(),
    filter: { ...state.logFilter },
    bufferTotal: ui.length,
    // ★ 明细也要报个数：界面上看不见它们，导出文件里得说清「还有 N 条流水在 run-log.jsonl」
    bufferDetail: Math.max(0, (state.logs || []).length - ui.length)
  };
}

/* ---------------- 任务（实例化：同一时间可以有多个批次在跑） ---------------- */
/** 产出可发布内容的任务：必须带品牌归属。名单要和主进程 jobs.js 的 BRAND_SCOPED 保持一致 */
const BRAND_SCOPED_TYPES = new Set(['copy.generate', 'report.import', 'sheet.export', 'publish.run', 'publish.rerun', 'publish.fallbackTest']);

/**
 * 产出类任务统一带上标题栏选中的品牌。没选中就不带 —— 让主进程把「为什么不行」讲清楚，
 * 而不是在前端塞一个顶上：归属记错了比报错难查得多。
 * ★★ 凡是 BRAND_SCOPED_TYPES 里的任务，**所有**调用点都必须经过这里 ——
 *    包括绕过 runJob 直接调 appApi.run 的那些。漏一处，界面表现就是
 *    「标题栏明明选着品牌，一点却弹『请先选择品牌』」（2026-10-03「导入内容报告」就是这样漏的）。
 */
function brandArgs(type, args) {
  const a = Object.assign({}, args || {});
  if (!a.brandId && state.brandId) a.brandId = state.brandId;
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
 * 生成后保留本地报告入口，由用户点击打开文件。
 */
let lastCopyReport = null;
async function afterCopy(r) {
  const x = (r && r.result) || {};
  lastCopyReport = x.reportFile
    ? {
      file: x.reportFile, rows: x.reportRows || 0, flagged: x.reportFlagged || 0,
      problems: x.reportProblems || [], byLevel: x.reportByLevel || {}, gen: x.genSource || '', brand: r.brandName || ''
    }
    : null;
  renderAll();
  if (!x.reportFile) return;
  const flag = x.reportFlagged || 0;
  const name = String(x.reportFile).split(/[\\/]/).pop();
  toast(`AI 内容报告已生成：${x.reportRows} 行 · ${flag ? `${flag} 行要人工看一眼` : '文案/货号/颜色核对一致'} → ${name}`,
    flag ? 'warn' : 'ok');
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

/*
 * 单条「耗时」列。
 * 运行中：按 startedAtMs 现算（每秒刷新一次，见 refreshPublishElapsed）——它是**同一份事实**
 *   的连续显示，不是估算；跑完就换成主进程写入的实耗（row.elapsed，落台账/云端的那一个）。
 * ★ 2026-10-13 用户指出「计时器有时候跳秒、速度变快」：跳的原因是**刷新频率**（原来只在进度
 *   事件到达时更新，一条 60 多秒的内容要等下一次事件才跳一大格），不是数字本身算错。
 *   ⇒ 刷新改成每秒一次，数字连续走；口径不变（都是「这一条从开始到现在」）。
 */
function publishElapsedText(row) {
  const start = Number(row.startedAtMs);
  const elapsed = !row.result && Number.isFinite(start) && start > 0
    ? Math.max(0, (Date.now() - start) / 1000) : Number(row.elapsed);
  return Number.isFinite(elapsed) && elapsed >= 0 && (row.startAt || row.elapsed != null)
    ? elapsed.toFixed(1) + 's' : '—';
}

function publishRowElement(id) {
  return [...document.querySelectorAll('[data-publish-row]')].find(el => el.dataset.publishRow === String(id));
}

/**
 * 哪些页面在展示「发布队列逐行状态」。
 * ★★ 2026-10-16：新增页签 14「备用入口试发」之后，凡是原来只认 6 的地方都要一起认它 ——
 *   漏一处的表现是「那一页的耗时列不刷新 / 状态停在准备中」，看着像卡死，其实是没更新。
 */
const PUBLISH_ROW_TABS = new Set([6, 14]);

/**
 * 「发布类任务」——「模拟器发布」页与「备用入口试发」页共用同一批任务类型。
 * ★★ 加 `publish.fallbackTest` 必须要连这几处一起认它，否则试发那一页：
 *   设备状态不刷新 / 进度条不更新 / 每 10 秒的自动扫描不跑（看着像卡死，其实是没接线）。
 */
const PUBLISH_JOB_TYPES = ['publish.run', 'publish.rerun', 'publish.fallbackTest'];
function anyPublishRunning() {
  return (state.jobs || []).some(j => PUBLISH_JOB_TYPES.includes(j.type));
}

function updatePublishRow(update) {
  if (!update || update.id == null) return;
  const rows = state.project && state.project.publish && state.project.publish.rows || [];
  const row = rows.find(r => String(r.id) === String(update.id));
  if (!row) return;
  Object.assign(row, update);
  if (!PUBLISH_ROW_TABS.has(state.tab)) return;
  const el = publishRowElement(row.id);
  if (!el) return;
  el.querySelector('[data-publish-start]').textContent = row.startAt || '—';
  el.querySelector('[data-publish-elapsed]').textContent = publishElapsedText(row);
  el.querySelector('[data-publish-status]').innerHTML = badge(row.result || row.status || '排队', kindOf(row.result || row.status || '排队'))
    + (row.reason ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(row.reason)}</div>` : '');
  el.classList.toggle('flag', row.result === '失败' || row.result === '校验未通过');
  // 备用入口试发那一页**没有**「重跑」列（试发的失败原因要看日志，不该一键重发）——
  // 所以这里必须先判存在，否则空指针会把整个进度刷新打断。
  const action = el.querySelector('[data-publish-action]');
  if (action) action.innerHTML = row.result && row.result !== '发布成功'
    ? `<button class="btn sm" data-act="pub:rerun" data-seq="${esc(row.seq)}">重跑</button>` : '';
}

function refreshPublishElapsed() {
  if (!PUBLISH_ROW_TABS.has(state.tab) || document.hidden) return;
  const rows = state.project && state.project.publish && state.project.publish.rows || [];
  for (const row of rows) {
    if (row.result || !row.startedAtMs) continue;
    const el = publishRowElement(row.id);
    if (el) el.querySelector('[data-publish-elapsed]').textContent = publishElapsedText(row);
  }
}

/**
 * 「运行中的批次 / 任务」那张表的耗时，同样每秒刷新。
 * ★ 2026-10-13 用户指出「跳秒、速度变快」：它的 elapsedSec 原来只在 job:progress 事件里重算，
 *   而一条内容中途可能几十秒不发一次进度 ⇒ 数字从 5s 直接跳到 66s，看起来像突然变快。
 *   这里按 startedAt 每秒算一次（同一事实，只是显示连续）；没有 startedAt 的（历史/异常）不动。
 */
function refreshRunningElapsed() {
  if (document.hidden) return;
  let touched = false;
  for (const j of state.jobs || []) {
    if (!j || !j.startedAt) continue;
    const next = (Date.now() - j.startedAt) / 1000;
    if (!Number.isFinite(next)) continue;
    if (Math.abs(next - (Number(j.elapsedSec) || 0)) >= 0.5) { j.elapsedSec = next; touched = true; }
  }
  if (touched && (state.tab === 3 || PUBLISH_ROW_TABS.has(state.tab))) refreshBatches();
}

/** 「AI 内容报告」：导入后直接发布，结果回写它的 B/C 列。 */
function reportBoxHtml() {
  const pub = state.project.publish || {};
  if (!pub.reportFile) {
    return `<p class="hint">请先导入 AI 内容报告（Excel），发布结果会写回原报告。</p>`;
  }
  const rows = pub.rows || [];
  const blocked = rows.filter(r => r.result === '校验未通过').length;
  const done = rows.filter(r => r.result === '发布成功').length;
  return `<section class="publish-report">
    <h3>当前批次 AI 内容报告</h3>
    <div class="row">
      <input class="inp mono" value="${esc(pub.reportFile)}" readonly>
      <span class="chip">表「${esc(pub.reportSheet || '')}」</span>
      ${pub.reportDir ? `<span class="chip" title="报告的「素材路径」是空的，用的是这次选的素材目录">素材目录 ${esc(pub.reportDir)}</span>` : ''}
      <span class="chip">${rows.length} 条</span>
      ${done ? `<span class="chip">已提交 ${done}</span>` : ''}
      ${blocked ? `<span class="chip warn">${blocked} 条暂不发布</span>` : ''}
      <button class="btn sm" data-act="sheet:openReport">打开报告</button>
    </div>
    <p class="hint">发布完会回写报告的 <b>实际执行时间（B）/ 执行结果（C）</b> 两列；报告被 WPS 占用时整批暂存，
      下次导入或发布时先补写。</p>
  </section>`;
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

/* ---------------- 各页渲染 ---------------- */
const TABS = {};

TABS[1] = {
  title: '素材整理',
  desc: '多层级文件夹扁平化 · 不覆盖原文件夹 · 自动加日期时间后缀',
  actions: () => [
    { act: 'flatten:pick', label: '选择目录' },
    { act: 'flatten:plan', label: '生成清单', disabled: !state.project.sourceDir },
    { act: 'flatten:run', label: state.flattenSubmitting ? '整理中…' : '开始整理', primary: true, disabled: !state.project.sourceDir || state.flattenSubmitting || running('flatten.run') }
  ],
  render() {
    const p = state.project;
    const dir = p.sourceDir || '';
    const plan = state.plan;
    const before = plan ? plan.rows.slice(0, 8).map(r => esc(r.from.replace(dir, '').replace(/^[/\\]/, '')) + ` <s>(${r.fileCount} 个文件)</s>`).join('<br>') : '点「生成清单」查看（秒级，只读元数据）';
    const after = plan ? plan.rows.slice(0, 8).map(r => `<b>${esc(r.name)}</b> <s>(${r.fileCount})</s>`).join('<br>') : '—';
    const current = p.flattenResult && p.flattenResult.sourceDir === dir ? p.flattenResult : null;
    const previous = p.previousFlattenResult || (!current && p.flattenResult) || (!current && p.flatDir ? { dir: p.flatDir } : null);
    const resultHtml = (label, result) => `<div class="box"><h3>${label}</h3>${result && result.dir ? `<div class="row"><input class="inp mono" value="${esc(result.dir)}" readonly><button class="btn sm" data-act="flatten:openFlat" data-path="${esc(result.dir)}">打开目录</button></div><p class="hint">${Number.isFinite(result.count) ? '共 ' + result.count + ' 个叶子目录' : '旧记录未保存目录数量'}${result.sourceDir ? ' · 来源：' + esc(result.sourceDir) : ''}</p>` : '<p class="hint">本次尚未完成整理；完成后会显示实际输出目录。</p>'}</div>`;
    return `
      <div class="box">
        <h3>源目录</h3>
        <div class="row">
          <input class="inp mono" value="${esc(dir)}" readonly>
          <span class="chip">${plan ? plan.total + ' 个叶子目录 · ' + plan.fileTotal + ' 个文件' : '未生成清单'}</span>
        </div>
        <p class="hint">目录命名：<b>货号+颜色</b>（如 <code>26FW-YB160+象牙白</code>）。用加号分隔货号和颜色。</p>
      </div>
      ${running('flatten.run') ? progHtml(progFor('flatten.run')) : ''}
      <div class="two">
        <div class="box"><h3>整理前（多层嵌套）</h3><div class="tree">${before}</div></div>
        <div class="box"><h3>整理后（扁平 + 时间戳）</h3><div class="tree">${esc(dir ? dir.split(/[\\/]/).slice(-1)[0] + '_时间戳（原目录保留）' : '')}<br>${after}</div></div>
      </div>
      ${resultHtml('本次整理结果', current)}
      ${previous && (!current || previous.dir !== current.dir) ? resultHtml('上次整理结果', previous) : ''}
      <p class="hint">整理后保留原目录，只生成扁平副本。</p>`;
  }
};

TABS[2] = {
  title: '合规检查',
  desc: '检查图片尺寸、格式及视频时长，支持自动转换格式',
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
    const active = ['compliance.scanParent', 'compliance.scan', 'compliance.fix'].find(type => running(type));
    const progress = active ? `<div class="box"><h3>${active === 'compliance.scanParent' ? '正在检查父目录' : active === 'compliance.fix' ? '正在处理素材' : '正在检查素材'}</h3><p class="hint">${s ? '下方保留上次结果，本次检查完成后更新。' : '正在读取素材信息，请稍候。'}</p>${progHtml(progFor(active))}</div>` : '';
    if (!s) return progress || `<div class="empty">素材待检查。点击「开始检查」后才会读取视频时长和图片信息；也可选择「检查父目录」。</div>`;
    const rows = c.rows.filter(r => r.status !== 'ok')
      .sort((a, b) => Number(b.status === 'manual') - Number(a.status === 'manual'));
    const okRows = c.rows.filter(r => r.status === 'ok').length;
    return `
      <div class="stats">
        <div class="stat good"><b>${n(s.ok)}</b><span>合格</span></div>
        <div class="stat"><b>${n(s.todo)}</b><span>可自动处理</span></div>
        <div class="stat bad"><b>${n(s.manual)}</b><span>未自动处理</span></div>
        ${cfg0.enforceMaxSide ? `<div class="stat"><b>${n(s.scaled)}</b><span>等比缩放</span></div>` : ''}
        <div class="stat bad"><b>${n(s.tooSmall)}</b><span>尺寸不足</span></div>
        <div class="stat bad"><b>${n(s.notMp4)}</b><span>非 MP4</span></div>
        ${cfg0.enforceMaxMB ? `<div class="stat bad"><b>${n(s.oversize)}</b><span>超 ${cfg0.maxImageMB}MB 压缩</span></div>` : ''}
        ${n(s.isolate) ? `<div class="stat"><b>${n(s.isolate)}</b><span>待隔离的非素材文件</span></div>` : ''}
      </div>
      <p class="hint">规则（按你的口径，2026-10-05 起）：图片<b>必须为 JPG</b>、≥<b>${cfg0.minPixels}</b> 像素²（约 42×42）、边长 <b>${cfg0.enforceMaxSide ? `${cfg0.minSide}~${cfg0.maxSide}` : `≥${cfg0.minSide}`}</b>${cfg0.enforceMaxSide ? (cfg0.autoScale ? '（超限自动等比缩放）' : '（超限需更换）') : '（<b>超出不限制、不缩放</b>）'}${cfg0.enforceMaxMB ? `、≤${cfg0.maxImageMB}MB` : '、<b>体积不限</b>（不压缩）'}；视频<b>必须 .mp4</b>（<code>.mov</code>/<code>.m4v</code> 等会自动转成 mp4）且 &lt;${cfg0.maxVideoSec} 秒（超时只标红不裁剪）。</p>
      ${(c.groups && c.groups.length) ? `<div class="box"><h3>按子文件夹（${c.groups.length} 个）</h3>
        <div class="tw"><table><thead><tr><th>子文件夹</th><th>合格</th><th>可自动</th><th>未自动处理</th></tr></thead><tbody>
        ${c.groups.map(g => `<tr class="${g.stats.manual ? 'warnrow' : ''}"><td class="mono">${esc(g.name)}</td><td class="num">${n(g.stats.ok)}</td><td class="num">${n(g.stats.todo)}</td><td class="num">${n(g.stats.manual)}</td></tr>`).join('')}
        </tbody></table></div>
        <p class="hint">「导出报告」会把这张分组表 + 全部明细写成 <code>合规报告_时间戳.xlsx</code>（汇总 / 明细两个工作表）和同名 <code>.csv</code>，落到输出目录。</p></div>` : ''}
      ${progress}
      ${rows.length ? `<p class="hint">共 ${rows.length} 项检查结果，未自动处理项优先显示。</p><div class="tw"><table>
        <thead><tr><th>文件</th><th>类型</th><th>问题</th><th>处置</th><th>状态</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.status === 'manual' ? 'flag' : (r.status === 'isolate' ? 'warnrow' : '')}">
          <td class="mono">${esc(r.file)}</td><td>${esc(r.type)}</td><td>${esc(r.issue)}</td><td>${esc(r.result || r.action)}</td>
          <td>${badge(r.status === 'done' ? (r.result || '完成') : (r.status === 'manual' ? (r.result || '未自动处理') : (r.status === 'isolate' ? '待隔离' : r.status)), kindOf(r.status === 'done' ? '完成' : (r.status === 'manual' ? '需人工处理' : '待处理')))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">全部 ${okRows} 个文件都合规，没有需要处理的项。</div>`}
      <p class="hint">未自动处理项会保留原文件。视频超 ${state.config.compliance.maxVideoSec} 秒时只提示，不自动裁剪；此检查不拦截发布。</p>`;
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
  desc: () => {
    const copy = state.config?.copy || {};
    const profile = (copy.localPrompts || []).find(p => p.id === copy.promptProfileId);
    return profile ? `文案提示词：${profile.name} · 生成文案和本地 Excel 报告` : '选择素材，生成文案和本地 Excel 报告';
  },
  actions: () => [
    // ★ 2026-10-08 用户要求：模型配置搬到**这一页**，做成弹窗，并且是**唯一**入口
    //   （原来在「高级设置 → 文案模型」的折叠框已删）。位置按用户指定，放在「提示词配置」左边。
    // ★ 所有已登录账号都能修改本机模型配置；高级设置仍保持管理员专属。
    { act: 'copy:model', label: '模型配置' },
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
          <span class="lbl">必带话题</span>
          <input class="inp" style="min-width:210px;flex:0 0 auto" value="${esc(cfg.requiredTopic)}" data-cfg="copy.requiredTopic"
            placeholder="如 #品牌话题，#品类词" title="要多个就用空格 / 逗号 / 顿号隔开，没写 # 会自动补上">
          <span class="lbl">额外话题</span>
          <select class="inp" data-cfg="copy.extraTopics">${[3, 4, 5].map(v => `<option value="${v}" ${cfg.extraTopics === v ? 'selected' : ''}>${v} 个</option>`).join('')}</select>
        </div>
        <p class="hint">多个必带话题用空格或逗号分隔。
          <button class="btn sm" data-act="help:open" data-topic="copy" style="margin-left:6px">看说明书</button></p>
        ${running('copy.generate') ? progHtml(progFor('copy.generate')) : ''}
        <p class="hint">生成后核对报告，再导入「模拟器发布」。</p>
        ${lastCopyReport ? `<div class="hint" style="border:1px solid #E3E0D8;border-radius:6px;padding:8px 10px">
          <b>${esc(lastCopyReport.file.split(/[\\/]/).pop())}</b> · ${n(lastCopyReport.rows)} 行
          ${lastCopyReport.problems.length
            ? ` · <b>${lastCopyReport.problems.map(p => `${esc(p.text)} ${n(p.rows)} 行`).join('；')}</b>，请打开报告修改`
            : ' · 文案已生成'}
          <button class="btn sm" data-act="copy:openReport" title="打开本次生成的本地 AI 内容报告" aria-label="打开本次生成的本地 AI 内容报告" style="margin-left:8px;display:inline-flex;align-items:center;gap:4px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg>报告</button>
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

/* ---------------- 页签 4：货号颜色校验（对所有用户隐藏） ----------------
 * 用户要求该页面不向任何账号展示。保留编号与实现，避免扰动后续页签编号，但关闭导航和快捷键入口。
 */
TABS[4] = {
  title: '货号颜色校验',
  hidden: true,
  desc: '核对货号、目录颜色与图片主色',
  actions: () => [
    { act: 'verify:pool', label: '导入商品资料' },
    { act: 'verify:run', label: '开始校验', primary: true }
  ],
  render() {
    const v = state.project.verify || {};
    const s = v.stats;
    if (!s) return `<div class="empty">还没有校验记录。点「开始校验」会核对货号，并用图片实际提出的主色反查目录里填的色名。</div>`;
    return `
      <div class="stats">
        <div class="stat good"><b>${n(s.pass)}</b><span>通过</span></div>
        <div class="stat bad"><b>${n(s.manual)}</b><span>需人工确认</span></div>
        <div class="stat bad"><b>${n(s.missing)}</b><span>货号不存在</span></div>
        <div class="stat bad"><b>${n(s.noColor)}</b><span>漏填颜色</span></div>
      </div>
      ${running('verify.check') ? progHtml(progFor('verify.check')) : ''}
      <div class="tw"><table>
        <thead><tr><th>货号</th><th>目录填的颜色</th><th>参考颜色</th><th>图片实取主色</th><th>结论</th></tr></thead>
        <tbody>${(v.rows || []).map(r => `<tr class="${r.level === 'bad' ? 'flag' : (r.level === 'warn' ? 'warnrow' : '')}">
          <td class="mono">${esc(r.sku)}</td>
          <td>${r.swatch ? `<span class="sw" style="background:${esc(r.swatch)}"></span>` : ''}${esc(r.declared || '（空）')}</td>
          <td>${esc((r.poolColors || []).join(' / ') || '—')}</td>
          <td>${esc(r.imageColor)}</td>
          <td>${badge(r.conclusion, kindOf(r.conclusion))}${r.note ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(r.note)}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
      <p class="hint">多了一道保险：<b>用图片实际提出的主色反查目录里填的色名</b>。目录写「冠军白」但图是黑的，立刻就能发现。</p>
      <p class="hint">★ 这一页<b>只提示、不拦发布</b>：颜色对不上时，发布端会按货号搜出来的<b>第一件商品</b>发（详见「模拟器发布」页）。</p>
      <p class="hint">用「AI 内容报告」那一批时：先在「<b>模拟器发布</b>」页点「导入 AI 内容报告」，再回本页点「开始校验」——
        报告里空着的货号/颜色会先按叶子文件夹名（「货号+颜色」）补齐，再按可用商品资料核对。</p>`;
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

/**
 * 发布前的「得物设置提醒」。
 * ★★ 2026-10-16：抽成一个函数，「模拟器发布」与「备用入口试发」共用**同一份**。
 *   原来它只写在模拟器发布页里；试发那一页同样是真实提交，少了这段提醒，
 *   两处的前置要求就会各说各话 —— 复制一份迟早各自演化。
 */
function publishSetupHtml() {
  return `
      <details class="publish-setup">
        <summary><span class="publish-setup-icon" aria-hidden="true">!</span><span>得物设置提醒<span class="publish-setup-brief">关闭 2 项商品识别设置，并确保草稿箱为空</span></span></summary>
        <div class="publish-setup-items">
          <div><span class="publish-setup-path">得物 → 我 → 设置 → 隐私设置</span><strong>允许平台在我的内容动态关联商品</strong><span class="publish-setup-off">设为关闭</span></div>
          <div><span class="publish-setup-path">得物 → 我 → 设置 → 通用设置</span><strong>作品暂停时自动识别画面中商品</strong><span class="publish-setup-off">设为关闭</span></div>
          <div><span class="publish-setup-path">得物 → 当前账号 → 草稿箱</span><strong>确保目前账号草稿箱为空</strong><span class="publish-setup-off">发布前手动确认</span></div>
        </div>
        <p>每个账号均需手动检查，重装后请重新确认；本工具不检测开关状态。</p>
      </details>
  `;
}

TABS[6] = {
  title: '模拟器发布',
  desc: '导入 AI 内容报告 → 选择设备和发布间隔 → 开始发布',
  actions: () => [
    // ★ 2026-10-03 用户给的流程：「从模拟器发布的入口导入，选择发布间隔时间，点击开始发布」
    //   ⇒ 导入入口放到这一页（原来「发布单」页那个随页签一起删了，现在只剩这一处）
    { act: 'sheet:importReport', label: '导入 AI 内容报告' },
    { act: 'pub:stop', label: '停止', disabled: !running('publish.run') && !running('publish.rerun') },
    { act: 'pub:run', label: '开始发布', primary: true, disabled: !(state.project.publish && state.project.publish.rows && state.project.publish.rows.length) }
  ],
  render() {
    const cfg = state.config.publish;
    const pub = state.project.publish || {};
    const sh = state.project.sheet || {};   // 发布单 xlsx（原「发布单」页那一行挪到这儿）
    const rows = pub.rows || [];
    // ★★ 当前生效的发布间隔秒数。**0 是合法值**（连续发布：发完一条直接发下一条），
    //   所以这里不能写 `cfg.intervalSec || 60` —— 那样 0 会被兜成 60，
    //   用户明明选了「连续发布」，界面却按 60 秒算/显示（而主进程那边是按 0 跑的）。
    const ivRaw = Number(cfg.intervalSec);
    const ivNow = (cfg.intervalSec === '' || cfg.intervalSec === null || cfg.intervalSec === undefined
      || !Number.isFinite(ivRaw)) ? 0 : ivRaw;
    // ★★ 2026-10-13 用户口径：「你的预估耗时都不准，比如图文 30s 那些，直接删了吧。」
    //   为什么删而不是调系数：单条耗时由设备、网络、素材体积、好物识别等待共同决定 ——
    //   真机实测同一批图文 65–99s、视频 66–85s 全属正常 ⇒ 任何固定系数都会骗人。
    //   现在这一页只显示**已经发生的事实**（运行中计时 / 结束后写入的实耗），不再给数字承诺。
    const okCount = rows.filter(r => r.result === '发布成功').length;
    return `
      <div class="box">
        ${reportBoxHtml()}
        <h3>设备与发布间隔</h3>
        <details style="margin-bottom:10px"><summary>导出文件</summary><div class="row" style="margin-top:8px">
          <button class="btn sm" data-act="sheet:export">导出发布单</button>
          <button class="btn sm" data-act="pub:exportLog">导出发布日志</button>
          <button class="btn sm" data-act="sheet:open" ${sh.file ? '' : 'disabled'}>打开导出表</button>
          <button class="btn sm" data-act="sheet:dir">打开导出目录</button>
          ${sh.file ? `<span class="hint mono">${esc(sh.file)}</span>` : ''}
        </div></details>
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
          + '单条本身仍要花时间（推素材 / 上传 / 填内容），具体多少看下面每一行的实耗 —— 不给固定秒数，免得与实际差太多。</p>' : ''}
        ${running('publish.run') || running('publish.rerun') ? progHtml(progFor(running('publish.run') ? 'publish.run' : 'publish.rerun')) : ''}
        <p class="hint">★ 这一页就是流程的最后一步：<b>导入 AI 内容报告 → 选发布间隔 → 开始发布</b>。
          报告里空着的货号 / 颜色，导入时会按<b>叶子文件夹名</b>（「货号+颜色」，以 + 号分隔）自动补上，
          并写回报告文件（<b>只补空格子，不覆盖你已填的</b>）。</p>
${publishSetupHtml()}
      </div>
      ${batchesHtml('', '运行中的批次 / 任务')}
      ${rows.length ? `<div class="tw publish-rows"><table>
        <colgroup><col style="width:40px"><col style="width:260px"><col style="width:56px"><col style="width:56px"><col style="width:100px"><col style="width:80px"><col><col style="width:64px"></colgroup>
        <thead><tr><th>#</th><th>素材目录</th><th>好物</th><th>图片</th><th>开始时间</th><th>耗时</th><th>状态</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr data-publish-row="${esc(r.id)}" class="${r.result === '失败' || r.result === '校验未通过' ? 'flag' : ''}">
          <td class="num">${r.seq}</td><td class="mono" title="${esc(r.dir)}">${esc(r.dir)}</td><td class="num">${n(r.goods)}</td><td class="num">${n(r.images)}</td>
          <td data-publish-start>${esc(r.startAt || '—')}</td><td class="num" data-publish-elapsed>${publishElapsedText(r)}</td>
          <td data-publish-status>${badge(r.result || r.status || '排队', kindOf(r.result || r.status || '排队'))}${r.reason ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(r.reason)}</div>` : ''}</td>
          <td data-publish-action>${(r.result && r.result !== '发布成功') ? `<button class="btn sm" data-act="pub:rerun" data-seq="${r.seq}">重跑</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有发布队列，请先导入 AI 内容报告。</div>`}
      <p class="hint">★ <b>颜色校验不是必需项</b>：没做过校验、或目录里的颜色与参考资料对不上，<b>都不会拦住发布</b> ——
      发布时按货号搜索，<b>默认选第一件商品</b>。</p>
      <p class="hint"><b>内容主图</b>：默认用这个叶子里<b>排在最前面那张</b>（你实拍一般就是先拍的正面照）。
      想让某一张当主图，把它的文件名改成以 <code>1</code> 开头（如 <code>1_微信图片_2026-10-05_031033_240.jpg</code>）——
      程序会把那张排到相册第 1 格（<b>得物取相册第 1 格当内容主图</b>）；<code>10</code>/<code>12</code> 这种编号不会被误认。
      排不成就<b>不发这一条</b>（不会闷着头把主图放错）。</p>
      <p class="hint">已提交 ${okCount} / ${rows.length} 条。已提交内容的展示与审核结果请在得物查看。
      可在「导出文件」中导出发布日志。</p>`;
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

function updatePanelHtml() {
  const s = state.update || {};
  const busy = ['checking', 'downloading', 'verifying', 'installing'].includes(s.status);
  const progressing = ['downloading', 'downloaded', 'verifying', 'installing'].includes(s.status);
  const percent = Math.max(0, Math.min(100, Number(s.percent) || 0));
  const label = { downloading: '下载安装包', downloaded: '下载完成', verifying: '校验安装包', installing: '正在启动更新' }[s.status];
  const progress = progressing ? `<div class="update-progress"><div class="update-progress-heading"><span>${label}</span><span>${s.status === 'installing' ? '请稍候' : percent + '%'}</span></div><div class="update-progress-track ${s.status === 'installing' ? 'indeterminate' : ''}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" ${s.status === 'installing' ? '' : 'aria-valuenow="' + percent + '"'}><div style="width:${percent}%"></div></div></div>` : '';
  const buildLabel = s.build ? ` · 构建号 ${s.build}` : '';
  return `<div class="box" id="versionUpdate"><div class="row"><h3>应用更新</h3><span class="chip">v${esc(s.current || state.info?.version || '1.1.1')}${buildLabel}</span><span class="grow"></span><button class="btn sm" data-act="update:check" ${busy ? 'disabled' : ''}>检查更新</button>${s.status === 'available' ? '<button class="btn sm primary" data-act="update:download">下载新版本</button>' : ''}${s.status === 'downloaded' ? '<button class="btn sm primary" data-act="update:install">重启并更新</button>' : ''}</div>${progress}<p class="hint" role="status">${esc(s.message || '启动后自动检查，也可手动检查。')}</p><p class="hint">每小时自动检查新版本 · 下载后点击重启并更新 · 任务运行时禁止重启</p></div>`;
}

TABS[7] = {
  title: '设置',
  // ★ desc 支持函数（renderAll 里求值）：非管理员这一页没有「应用更新」那块，
  //   副标题就不该提它 —— 界面文字得跟界面上真有的东西对得上。
  // ★ 2026-10-04：副标题里原来的「路径、」也一并去掉 —— 那一块已经从页面上撤掉，
  //   副标题再提它就是「界面文字跟界面上真有的东西对不上」（见下面那条注释的同一条原则）。
  desc: '外部依赖与问题反馈',
  actions: () => [{ act: 'feedback:open', label: '反馈' }],
  render() {
    const info = state.info || {};
    const dep = [
      // ★ 2026-10-08：这句原来写「（含 HEIC）」—— 和下一行「HEIC 解码 · 不可用」直接打架，
      //   而且不真：实测同一份 libvips 能读写 AVIF(av1)、但解码真 HEVC 必失败。
      //   「图片处理 / 取色」这行讲的是引擎本身，编码能力交给下一行单独交代，这里不再提具体格式。
      ['图片处理 / 取色', info.engine === 'sharp' ? 'sharp + libvips' : 'jpeg-js + pngjs（纯 JS 降级）', info.engine === 'sharp' ? ['ok', '内置'] : ['warn', '降级']],
      ['HEIC 解码', info.hasHeif ? '内置 HEVC 解码器' : '解码器缺失', info.hasHeif ? ['ok', '可用'] : ['warn', '不可用']],
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
            <option value="local" ${c.verify.mode === 'local' ? 'selected' : ''}>本地资料（导入 CSV）</option>
            <option value="api" ${c.verify.mode === 'api' ? 'selected' : ''}>接口查询（得物后台）</option>
          </select>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">SKU 接口</span><input class="inp mono" value="${esc(c.verify.api.endpoint)}" data-cfg="verify.api.endpoint" placeholder="https://…/sku-colors"></div>
        <div class="row"><span class="lbl">API Key</span><input class="inp mono" type="password" value="${esc(c.verify.api.apiKey)}" data-cfg="verify.api.apiKey"></div>`,
        '默认使用本地资料')}
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

/* ---------------- ⑧ 品牌统计 ---------------- */
function daysLabel(d) { return Number(d) > 0 ? `最近 ${d} 天` : '全部时间'; }

function localDateTimeInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

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
  const profile = state.auth;
  // 筛选可在等待期间修改，结果归属必须保留发起时的快照。
  const queriedOpts = JSON.parse(JSON.stringify(state.statsOpts));
  try {
    const r = await appApi.statsQuery(queriedOpts);
    if (profile !== state.auth) { state.statsTried = false; return; }
    state.stats = r && r.ok ? r : { error: (r && r.error) || '查询失败' };
    state.statsQueryOpts = state.stats.error ? null : queriedOpts;
  } catch (e) {
    if (profile !== state.auth) { state.statsTried = false; return; }
    state.stats = { error: (e && e.message) || '查询失败' };
    state.statsQueryOpts = null;
  } finally {
    state.statsBusy = false;
    renderAll();
  }
}

function statsFiltersCurrent() {
  return !!(state.stats && !state.stats.error && state.statsQueryOpts
    && JSON.stringify(state.statsQueryOpts) === JSON.stringify(state.statsOpts));
}

function syncStatsExportButtons() {
  const disabled = !statsFiltersCurrent();
  document.querySelectorAll('.act [data-act="stats:export"], .act [data-act="stats:exportLog"]')
    .forEach(el => { el.disabled = disabled; });
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
  desc: '查看品牌发布情况，可筛选时间并导出',
  actions: () => [
    // 「导出 xlsx」是整套统计（4 张表）；「导出执行日志」只要这一份日志，且**条数完整**
    // （xlsx 里那张执行日志表过去只导最近 100 条，界面上一句不提 → 对账会对不上）
    { act: 'stats:export', label: '导出 xlsx', disabled: !statsFiltersCurrent() },
    ...((state.auth && state.auth.isAdmin) ? [{ act: 'stats:exportLog', label: '导出执行日志', disabled: !statsFiltersCurrent() }] : []),
  ],
  render() {
    const s = state.stats;
    const m = state.brandsMeta || { brands: [], mine: [], isAdmin: false };
    const usable = (m.brands || []).filter(b => (m.mine || []).includes(b.id));
    const head = `
      <div class="box">
        <div class="acct-toolbar" style="margin-top:0">
          <select class="inp" id="stDays" aria-label="时间范围">
            ${[[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天'], [0, '全部时间']].map(([v, t]) => `<option value="${v}" ${state.statsOpts.rangeMode !== 'custom' && Number(state.statsOpts.days) === v ? 'selected' : ''}>${t}</option>`).join('')}
            <option value="custom" ${state.statsOpts.rangeMode === 'custom' ? 'selected' : ''}>自定义时间</option>
          </select>
          ${state.statsOpts.rangeMode === 'custom' ? `<label class="lbl" for="stFrom">从</label>
          <input class="inp" id="stFrom" type="datetime-local" step="60" value="${esc(state.statsOpts.fromAt)}" aria-label="开始时间">
          <label class="lbl" for="stTo">到</label>
          <input class="inp" id="stTo" type="datetime-local" step="60" value="${esc(state.statsOpts.toAt)}" aria-label="结束时间">` : ''}
          <span class="lbl">品牌</span>
          <select class="inp" id="stBrand">
            <option value="">全部品牌</option>
            ${usable.map(b => `<option value="${esc(b.id)}" ${state.statsOpts.brandId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
            ${m.isAdmin && s && s.untagged && s.untagged.rows > 0 ? '<option value="__none__" ' + (state.statsOpts.brandId === '__none__' ? 'selected' : '') + '>历史无品牌记录</option>' : ''}
          </select>
          ${m.isAdmin ? `<span class="lbl">执行人</span>
          <select class="inp" id="stUser"><option value="">全部执行人</option>${((s && s.users) || []).map(u => `<option value="${esc(u.userId)}" ${state.statsOpts.userId === u.userId ? 'selected' : ''}>${esc(u.displayName || u.username || '未记录')}（${u.rows}）</option>`).join('')}</select>` : ''}
          <button class="btn sm primary" data-act="stats:refresh">查询</button>
          <span class="chip">${m.isAdmin ? '全部品牌' : `我的品牌 ${usable.length} 个`}</span>
          ${s && s.range ? `<span class="chip stats-range">${esc(s.range.from)} → ${esc(s.range.to)}</span>` : ''}
        </div>
        ${s && !s.error && (s.notes || []).length ? `<p class="hint" style="margin:6px 0 0">${s.notes.map(esc).join('；')}</p>` : ''}
        ${state.statsPath ? `<p class="hint" style="margin:6px 0 0;color:${state.statsPath.ok ? 'var(--tx3)' : 'var(--red)'}">输出目录：${state.statsPath.ok ? '可写' : esc(state.statsPath.error || '不可写')}</p>` : ''}
      </div>`;
    if (!s) return head + '<div class="empty">正在读取发布日志…（若一直停在这里，说明输出目录不可读）</div>';
    if (s.error) return head + `<div class="empty">查询失败：${esc(s.error)}</div>`;

    const t = s.totals;

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
      <td>${b.users.length > 2 ? `<button class="btn sm" data-act="stats:users" data-id="${esc(b.id)}">查看 ${b.users.length} 位执行人 →</button>` : (b.users.length ? esc(b.users.map(u => `${u.displayName || u.username || '（未记录执行人）'} ${u.rows}`).join(' / ')) : '<span style="opacity:.6">—</span>')}</td>
    </tr>`;

    const summary = `<div class="tw"><table>
      <thead><tr><th>品牌</th><th>状态</th><th>条数</th><th>成功</th><th>失败</th><th>批次</th><th>最近发布</th><th>频次</th><th>执行人（条数）</th></tr></thead>
      <tbody>
        ${s.brands.map(b => rowOf(b)).join('')}
        ${s.untagged.rows > 0 ? rowOf(s.untagged, 'brandrow-flag', `<b>${esc(s.untagged.name)}</b><div style="font-size:11px;opacity:.75">历史记录（旧版本未记录品牌）</div>`) : ''}
        ${s.orphans.map(o => rowOf(o, 'brandrow-dead')).join('')}
      </tbody></table></div>
      `;

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
      ${s.range.dailyTruncated ? '<p class="hint">图表仅显示该范围内最近 120 天。</p>' : ''}
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
      ? `共 ${totalLogs} 条，页面显示最近 ${shownLogs} 条；导出包含全部记录。`
      : `共 ${totalLogs} 条；导出包含全部记录。`;

    const own = s.account;
    const queriedOpts = state.statsQueryOpts || state.statsOpts;
    const brandLabel = queriedOpts.brandId === '__none__' ? '历史无品牌记录'
      : ((m.brands || []).find(b => b.id === queriedOpts.brandId) || {}).name;
    const selectedUser = (s.users || []).find(u => u.userId === queriedOpts.userId);
    const accountLabel = [selectedUser && (selectedUser.displayName || selectedUser.username), brandLabel, s.range.label]
      .filter(Boolean).join(' · ');
    const accountBox = `<div class="box"><h3>本账号汇总（跨设备） · ${esc(accountLabel)}</h3>${own && own.available
      ? `<div class="stats"><div class="stat good"><b>${own.ok}</b><span>已发布篇数</span></div><div class="stat"><b>${own.rows}</b><span>尝试发布</span></div><div class="stat bad"><b>${own.fail}</b><span>失败</span></div></div>`
      : `<p class="hint">${esc(own && own.error || '云端账号汇总暂不可用')}，请稍后查询。</p>`}</div>`;
    const api = s.apiUsage;
    const usageNumber = n => new Intl.NumberFormat('zh-CN').format(Number(n) || 0);
    const usageCost = u => u && Number.isFinite(Number(u.estimatedCostCny))
      ? (u.costKnown ? `¥${Number(u.estimatedCostCny).toFixed(4)}`
        : (Number(u.estimatedCostCny) > 0 ? `≈¥${Number(u.estimatedCostCny).toFixed(4)}（部分未计价）` : '未识别价格'))
      : '未识别价格';
    const accountKey = x => x.userId || x.username || '未标账号';
    const usageAccountLabel = x => [x.username, x.displayName].filter((v, i, a) => v && a.indexOf(v) === i).join(' / ') || '未标账号';
    const usageSummary = api && api.ok && api.rows && api.rows.length ? `<div class="tw"><table>
      <thead><tr><th>账号</th><th>品牌</th><th>图文请求</th><th>视频请求</th><th>纯文本</th><th>输入 token</th><th>输出 token</th><th>估算费用</th></tr></thead>
      <tbody>${api.rows.filter(x => !state.usageAccount || accountKey(x) === state.usageAccount).map(x => `<tr>
        <td><button class="btn sm" data-act="stats:usageAccount" data-id="${esc(accountKey(x))}">${esc(usageAccountLabel(x))}</button></td><td>${esc(x.brandName || '未标品牌')}</td>
        <td class="num">${usageNumber(x.media.image && x.media.image.requests)}</td>
        <td class="num">${usageNumber(x.media.video && x.media.video.requests)}</td>
        <td class="num">${usageNumber(x.media.text && x.media.text.requests)}</td>
        <td class="num">${usageNumber(x.usage.inputTokens)}</td><td class="num">${usageNumber(x.usage.outputTokens)}</td>
        <td class="num">${usageCost(x.usage)}</td></tr>`).join('')}</tbody></table></div>`
      : (api && api.ok ? '<p class="hint">当前筛选范围内还没有已记录的 AI 用量。</p>'
        : `<p class="hint">${esc(api && api.error || '云端 AI 用量暂不可用')}</p>`);
    const usageDetails = ((api && api.details) || []).filter(x => !state.usageAccount || accountKey(x) === state.usageAccount);
    state.usagePage = Math.max(0, Math.min(state.usagePage, Math.ceil(usageDetails.length / 100) - 1));
const usageDetailHtml = `<div class="tw"><table><thead><tr><th>时间</th><th>账号</th><th>品牌 / 任务</th><th>模型</th><th>请求</th><th>输入 token</th><th>输出 token</th><th>估算费用</th></tr></thead><tbody>${usageDetails.slice(state.usagePage * 100, (state.usagePage + 1) * 100).map(x => `<tr><td>${esc(fmtDate(x.ts))}</td><td>${esc(usageAccountLabel(x))}</td><td>${esc(x.brandName)}<div class="hint">${esc(x.label)}</div></td><td>${esc((x.usage.models || []).join(' / ') || '未记录')}</td><td>${usageNumber(x.usage.requests)}</td><td>${usageNumber(x.usage.inputTokens)}${x.usage.unreportedRequests ? '<div class="hint">部分用量未返回</div>' : ''}</td><td>${usageNumber(x.usage.outputTokens)}</td><td>${usageCost(x.usage)}</td></tr>`).join('') || '<tr><td colspan="8">当前筛选范围没有记录</td></tr>'}</tbody></table></div><div class="row"><button class="btn sm" data-act="stats:usagePrev" ${state.usagePage ? '' : 'disabled'}>上一页</button><span>第 ${state.usagePage + 1} 页 · ${usageDetails.length} 次任务</span><button class="btn sm" data-act="stats:usageNext" ${(state.usagePage + 1) * 100 < usageDetails.length ? '' : 'disabled'}>下一页</button></div>`;
    const usageRows = state.usageView === 'details' ? usageDetailHtml : usageSummary;
    const usageBox = `<div class="box"><h3>AI 用量与费用（${esc(s.range.label)}）</h3><div class="row"><button class="btn sm ${state.usageView === 'summary' ? 'primary' : ''}" data-act="stats:usageView" data-id="summary">汇总</button><button class="btn sm ${state.usageView === 'details' ? 'primary' : ''}" data-act="stats:usageView" data-id="details">明细</button>${state.usageAccount ? '<button class="btn sm" data-act="stats:usageAccount" data-id="">全部账号</button>' : ''}</div>${api && api.ok
      ? `<div class="stats">
        <div class="stat good"><b>${usageCost(api.total)}</b><span>估算费用</span></div>
        <div class="stat"><b>${usageNumber(api.total && api.total.requests)}</b><span>模型请求</span></div>
        <div class="stat"><b>${usageNumber(api.total && api.total.inputTokens)}</b><span>输入 token</span></div>
        <div class="stat"><b>${usageNumber(api.total && api.total.outputTokens)}</b><span>输出 token</span></div>
      </div>${usageRows}<p class="hint">按接口返回的 token 用量和当前 DeepSeek Flash 价格估算；图文默认送图、视频按抽帧计。未知模型或自定义接口只统计 token，不估价。${api.total && api.total.unreportedRequests ? `有 ${usageNumber(api.total.unreportedRequests)} 次请求未返回 token 用量，估算不完整。` : ''}节假日价格可能与时段估算不同。</p>`
      : usageRows}</div>`;
    return '<div class="stats-page">' + head + `
      <div class="stats">
        <div class="stat good"><b>${t.rows}</b><span>发布条数</span></div>
        <div class="stat good"><b>${t.ok}</b><span>成功</span></div>
        <div class="stat bad"><b>${t.fail}</b><span>失败</span></div>
        <div class="stat"><b>${t.batches}</b><span>批次数</span></div>
        ${m.isAdmin ? `<div class="stat"><b>${t.runs}</b><span>任务次数</span></div>
        <div class="stat ${t.runFails ? 'bad' : ''}"><b>${t.runFails}</b><span>任务失败</span></div>` : ''}
        <div class="stat"><b>${s.brands.length}</b><span>品牌数</span></div>
      </div>
      ${accountBox}
      ${usageBox}
      <div class="box"><h3>品牌汇总（${esc(s.range.label)}）</h3>${summary}</div>
      ${dailyBox}
      ${m.isAdmin ? `<div class="box"><h3>执行日志（显示最近 ${shownLogs} 条 / 共 ${totalLogs} 条）</h3>${logs}<p class="hint">${logHint}</p></div>` : ''}</div>`;
  }
};

/* ---------------- ⑫ 热词库（单开一屏） ----------------
 * ★ 为什么单开一屏：它是**低频维护**（想加几个词才来一次），而「生成文案」是**高频动作** ——
 *   混一屏既容易误触生成，跑生成时又被词表挡路。（这条口径 2026-10-03 之前就定了。）
 * ★ 八组词均可编辑，包括收尾。T01~T15 **句式骨架一律不可编辑** ——
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
  const win = L.updatedAt ? Date.parse(L.updatedAt) : 0;
  const src = L.isCustom ? `已自定义${win ? '（' + fmtDate(win) + '）' : ''}` : '内置出厂词库';
  return `<div class="row" id="lxStatusRow">
      <span class="chip ${L.isCustom ? 'warn' : 'run'}">${esc(src)}</span>
      <span class="chip">全库 ${L.wordTotal} 词 · ${L.groups.length} 组</span>
      ${state.lexDirty ? '<span class="chip warn">有未保存的改动</span>' : ''}
      <span class="chip">仅保存在本机 · 保存后下次生成生效</span>
    </div>
    <p class="hint">导入 / 导出使用 Excel（.xlsx），可编辑「分组」「热词」两列后重新导入。</p>`;
}

// 历史仅保留当前运行中的最近一百步；撤销恢复草稿，点保存后才写入本机。
function lexFingerprint(library) {
  return JSON.stringify(library.groups.map(g => [g.key, g.words]));
}
function lexCheckpoint() {
  state.lexUndo.push(JSON.parse(JSON.stringify(state.lex)));
  if (state.lexUndo.length > 100) state.lexUndo.shift();
  state.lexRedo = [];
}
function updateLexHistoryButtons() {
  for (const [action, history] of [['undo', state.lexUndo], ['redo', state.lexRedo]]) {
    const button = document.querySelector('[data-act="lex:' + action + '"]');
    if (button) button.disabled = !state.lex || state.lexTransferBusy || state.lexBusy || !history.length;
  }
}
function lexTravel(direction) {
  if (!state.lex || state.lexTransferBusy || state.lexBusy) return;
  const from = direction === 'undo' ? state.lexUndo : state.lexRedo;
  const to = direction === 'undo' ? state.lexRedo : state.lexUndo;
  if (!from.length) return;
  to.push(JSON.parse(JSON.stringify(state.lex)));
  state.lex = from.pop();
  state.lexDirty = lexFingerprint(state.lex) !== state.lexSavedFingerprint;
  renderAll();
}
function lexHistoryIcon(direction) {
  const path = direction === 'undo' ? 'M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3' : 'm15 5 5 5-5 5m5-5h-9a6 6 0 0 0-6 6v3';
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
}

function lexGroupHtml(g) {
  const chips = g.words.map(w =>
    `<span class="chip lxw">${esc(w)}<button class="lxx" data-lx-del="${esc(g.key)}" data-lx-w="${esc(w)}" title="删掉这个词">×</button></span>`
  ).join('');
  return `<div class="box" id="lxg-${esc(g.key)}">
    <h3>${esc(g.key)}（${g.words.length} 词）</h3>
    <div class="lxwords">${chips || '<span class="hint">（空的 —— 这一组不会给模型任何词）</span>'}</div>
    <div class="row" style="margin-top:9px">
      <input class="inp" data-lx-in="${esc(g.key)}" maxlength="24" placeholder="加一个词，回车即可">
      <button class="btn sm" data-lx-add="${esc(g.key)}">添加</button>
    </div>
  </div>`;
}

function lexTransferIcon(kind) {
  const path = kind === 'import' ? 'M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4' : 'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4';
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
  return '<span class="lx-transfer-icon" aria-hidden="true"><span class="lx-transfer-main">' + icon + '</span>'
    + (kind === 'export' ? '<span class="lx-transfer-clone">' + icon + '</span>' : '')
    + '<span class="lx-transfer-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg></span></span>';
}

function setLexTransferBusy(value) {
  state.lexTransferBusy = value;
  document.querySelectorAll('#head [data-act^="lex:"],#pane [data-lx-del],#pane [data-lx-in],#pane [data-lx-add]').forEach(el => { el.disabled = value || !state.lex; });
  updateLexHistoryButtons();
}

function markLexTransferDone(action) {
  const button = document.querySelector('#head [data-act="' + action + '"]');
  if (!button) return;
  button.dataset.done = '1';
  setTimeout(() => { if (button.isConnected) delete button.dataset.done; }, 1800);
}

TABS[12] = {
  title: '本地词库',
  desc: '所有成员可编辑 · 仅保存在本机',
  actions: () => {
    return [
      { act: 'lex:undo', label: '撤销', history: 'undo', disabled: !state.lex || state.lexTransferBusy || !state.lexUndo.length },
      { act: 'lex:redo', label: '重做', history: 'redo', disabled: !state.lex || state.lexTransferBusy || !state.lexRedo.length },
      { act: 'lex:export', label: '导出', transfer: 'export', disabled: !state.lex || state.lexTransferBusy },
      { act: 'lex:import', label: '导入', transfer: 'import', disabled: !state.lex || state.lexTransferBusy },
      { act: 'lex:reset', label: '恢复内置', disabled: !state.lex || state.lexTransferBusy },
      { act: 'lex:save', label: '保存', primary: true, disabled: !state.lex || state.lexTransferBusy }
    ];
  },
  render() {
    const L = state.lex;
    if (!L) return '<div class="box"><h3>本地词库</h3><p class="hint">正在读取…</p></div>';
    const editables = L.groups.filter(g => !g.locked);
    const lockeds = L.groups.filter(g => g.locked);
    return `
      <div id="lxStatus">${lexStatusHtml()}</div>
      <div class="box">
        <h3>三条红线</h3>
        <p class="hint">${L.redlines.map(s => '· ' + esc(s)).join('<br>')}</p>
      </div>
      ${editables.map(lexGroupHtml).join('')}
      ${lockeds.map(g => `<div class="box lxlock">
        <h3>${esc(g.key)}（${g.words.length} 词）· 已锁定，不可编辑</h3>
        <div class="lxwords">${g.words.map(w => `<span class="chip lxw">${esc(w)}</span>`).join('')}</div>
        <p class="hint">参与生成，不可编辑。</p>
      </div>`).join('')}
      <div class="box">
        <h3>15 种句式骨架（T01~T15）· 不可编辑 · 新增请找开发</h3>
        <div class="tw"><table class="skeleton-table">
          <colgroup><col style="width:60px"><col style="width:250px"><col><col style="width:270px"></colgroup>
          <thead><tr><th>编号</th><th>名称</th><th>结构</th><th>形状示例</th></tr></thead>
          <tbody>${L.styles.map(s => `<tr><td class="mono">${esc(s.code)}</td><td title="${esc(s.name)}">${esc(s.name)}</td><td title="${esc(s.formula)}">${esc(s.formula)}</td><td class="mono" title="${esc(s.sample)}">${esc(s.sample)}</td></tr>`).join('')}</tbody>
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
    state.lexSavedFingerprint = lexFingerprint(r);
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
  updateLexHistoryButtons();
}

function bindLexicon() {
  if (!state.lex) return;
  const pane = $('#pane');
  pane.querySelectorAll('[data-lx-del]').forEach(b => {
    b.onclick = () => {
      if (state.lexTransferBusy || state.lexBusy) return;
      const g = state.lex.groups.find(x => x.key === b.dataset.lxDel);
      if (!g) return;
      lexCheckpoint();
      g.words = g.words.filter(w => w !== b.dataset.lxW);
      state.lex.wordTotal = state.lex.groups.reduce((n, group) => n + group.words.length, 0);
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
  if (!L || state.lexTransferBusy || state.lexBusy) return;
  const w = String(inp.value || '').trim();
  if (!w) return;
  const g = L.groups.find(x => x.key === key);
  if (!g) return;
  if (g.words.indexOf(w) >= 0) { toast('「' + w + '」已经在库里了', 'err'); return; }
  // ★ 红线只在主进程判：拿整份库 + 这个词去 dryRun 预检，通过了才真的进界面列表
  const payload = L.groups.map(x => ({ key: x.key, words: x.key === key ? x.words.concat([w]) : x.words.slice() }));
  setLexTransferBusy(true);
  const r = await appApi.hotwordsSave(payload, { dryRun: true }).catch(() => null);
  setLexTransferBusy(false);
  if (!r || !r.ok) { toast('主进程没回应，这次没加进去', 'err'); return; }
  if (r.rejected.length) { toast('「' + r.rejected[0].word + '」不能进库：' + r.rejected[0].why, 'err'); return; }
  lexCheckpoint();
  g.words.push(w);
  L.wordTotal = L.groups.reduce((n, group) => n + group.words.length, 0);
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
function deviceStateText(f) {
  return f.online ? '已连接' : ({ starting: '启动中', offline: '离线', unauthorized: '等待授权', 'connect-failed': '连接失败', 'discovery-error': '发现异常' }[f.state] || f.state || '离线');
}
let deviceScanBusy = false;
let deviceScanAt = 0;
async function refreshDevices(manual = false) {
  if (!state.auth || (state.auth.requireLogin && !state.auth.user)) return;
  // 发布中不扫设备：试发（publish.fallbackTest）同样在真机上跑，判据要一起认
  if (deviceScanBusy || anyPublishRunning()) return;
  deviceScanBusy = true;
  deviceScanAt = Date.now();
  const button = document.querySelector('[data-act="pub:devScan"]');
  if (button) { button.disabled = true; button.textContent = '正在连接…'; }
  try {
    const r = await appApi.run('publish.devices', {});
    if (!r.ok) throw new Error(r.error || '设备发现失败');
    const map = {};
    (r.result.devices || []).forEach(d => { map[d.serial] = d; });
    const found = r.result.found || [];
    const changed = JSON.stringify(found) !== JSON.stringify(state.devFound) || JSON.stringify(map) !== JSON.stringify(state.devStatus);
    state.devFound = found;
    state.devStatus = map;
    state.devScanError = '';
    if (manual) {
      const count = found.filter(d => !d.dupOf && d.online).length;
      const failed = found.find(d => ['connect-failed', 'discovery-error', 'unauthorized'].includes(d.state));
      toast(count ? `已连接 ${count} 台设备，可直接加入并使用` : (failed ? '自动连接未完成，原因已显示在设备列表中' : (found.length ? '已发现模拟器，正在等待连接就绪，软件会自动重试' : '未发现运行中的模拟器，打开 MuMu 后软件会自动连接')), count ? 'ok' : '');
    }
    // 设备表格在「模拟器发布」和「备用入口试发」两页都会画，刷新判据要一起认
    if (PUBLISH_ROW_TABS.has(state.tab) && (changed || manual)) paintDevices();
  } catch (e) {
    state.devScanError = e.message;
    if (manual) toast('自动连接未完成：' + e.message, 'err');
    if (PUBLISH_ROW_TABS.has(state.tab)) paintDevices();
  } finally {
    deviceScanBusy = false;
    deviceScanAt = Date.now();
    const current = document.querySelector('[data-act="pub:devScan"]');
    if (current) { current.disabled = false; current.textContent = '扫描设备'; }
  }
}

function paintDevices() {
  const panel = document.getElementById('devicesPanel');
  if (!panel) return;
  // 自动刷新只更新设备区域。
  panel.outerHTML = devicesHtml();
}
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
    : `<div class="empty">打开 MuMu 后将自动发现并连接设备，连接成功后点「加入并使用」即可。</div>`;
  // 还没加进列表的那些：直接给「加入并使用」——用户不必知道 emulator-5554 这种名字
  // ★ 2026-10-03：同一个模拟器会被 adb 在多个端口上各报一次（16384 / 5555 / 7555）。
  //   重复的（dupOf 非空的）不再单列 —— 否则用户会以为自己开了两台、不知道该选哪个。
  const fresh = (found || []).filter(f => !f.configured && !f.dupOf);
  const freshBox = fresh.length ? `
    <div style="margin-top:10px">
      <div class="hint" style="margin:0 0 6px">已发现的设备（还没加进来）：</div>
      <div class="tw"><table>
        <thead><tr><th>序列号</th><th>状态</th><th></th></tr></thead>
        <tbody>${fresh.map(f => `<tr>
          <td class="mono">${esc(f.name || f.serial)}${f.name ? `<div class="hint">${esc(f.serial)}</div>` : ''}${f.detail ? `<div class="hint">${esc(f.detail)}</div>` : ''}${(f.aliases && f.aliases.length)
            ? `<div class="hint" style="margin:2px 0 0">这台还出现在 ${esc(f.aliases.join(' / '))} —— 同一个模拟器的其它端口，不用管</div>`
            : ''}</td>
          <td>${badge(deviceStateText(f), f.online ? 'ok' : 'wait')}</td>
          <td><button class="btn sm primary" data-act="pub:useFound" data-serial="${esc(f.serial)}"${f.online ? '' : ' disabled'}>加入并使用</button></td>
        </tr>`).join('')}</tbody></table></div>
    </div>` : '';
  const noneBox = (found && !found.length)
    ? `<p class="hint" style="margin-top:9px">未发现运行中的模拟器。打开 MuMu 后会自动连接，无需输入命令。</p>`
    : '';
  return `<div class="box" id="devicesPanel"><h3>设备管理（一个设备 = 一个账号）</h3>${rows}
    <div class="row" style="margin-top:10px">
      <button class="btn sm primary" data-act="pub:devScan">扫描设备</button>
      <button class="btn sm" data-act="pub:probe">检查能不能发布</button>
      <span class="chip">${anyPublishRunning() ? '发布中，暂停刷新' : '自动发现已开启'}</span>
      <span class="hint" style="margin:0">自动发现 · 自动连接 · 每 10 秒刷新</span>
    </div>
    ${freshBox}${noneBox}${state.devScanError ? `<p class="hint">自动连接未完成：${esc(state.devScanError)}</p>` : ''}
    ${probeHtml()}
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
  const rawFix = Array.isArray(p.fix) ? p.fix : [];
  // 没装得物时发布流程还没法开始；输入法等其他检查项此时只会叠加红色告警，
  // 先引导用户安装得物，安装后重新检查再展示其余可处理问题。
  const dewuMissing = !!p.device && !p.appPackage && rawFix.some(f => f.act && f.act.act === 'go:dewu');
  const fix = dewuMissing ? rawFix.filter(f => f.act && f.act.act === 'go:dewu') : rawFix;
  const bad = fix.filter(f => f.level === 'bad');
  const warn = fix.filter(f => f.level === 'warn');
  const headline = bad.length ? `还不能真机发布 —— ${bad.length} 项要先处理`
    : warn.length ? '能发布，但有一处会影响体验'
      : '一切就绪，可以真机发布了';
  const kind = bad.length ? 'bad' : warn.length ? 'warn' : 'ok';
  const accent = { bad: 'var(--red)', warn: 'var(--amber)' };
  const line = (k, v, pass) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v || '—')}</td><td>${badge(pass == null ? '未检查' : pass ? '可用' : '不满足', pass == null ? 'wait' : pass ? 'ok' : 'bad')}</td></tr>`;
  const items = bad.concat(warn);
  return `
    <div class="device-probe">
      <h3>设备检查结果${p.ts ? `（${esc(new Date(p.ts).toLocaleTimeString())}）` : ''}</h3>
      <div class="row">${badge(headline, kind)}
        <span class="ts" style="color:var(--tx3)">点上面的「检查能不能发布」可随时重查</span></div>
      ${items.map(f => `
        <div style="border-left:3px solid ${accent[f.level]};background:var(--panel);border-radius:6px;padding:9px 12px;margin-top:9px">
          <div style="font-size:12.5px;font-weight:600;color:${accent[f.level]}">${esc(f.title)}</div>
          <div style="font-size:12px;color:var(--tx2);line-height:1.75;margin-top:3px">${esc(f.how)}</div>
          ${f.act ? `<button class="btn sm primary" style="margin-top:8px" data-act="${esc(f.act.act)}">${esc(f.act.label)}</button>` : ''}
        </div>`).join('')}
      <details style="margin-top:11px">
        <summary style="cursor:pointer;font-size:11.5px;color:var(--tx3)">技术详情（一般不用看，出问题给开发看）</summary>
        <div class="tw" style="margin-top:8px"><table>
          <thead><tr><th>检查项</th><th>结果</th><th>状态</th></tr></thead>
          <tbody>
            ${line('adb 路径', `${p.adbPath || '—'}${ADB_SRC_TXT[p.adbSource] ? '（' + ADB_SRC_TXT[p.adbSource] + '）' : ''}`, !!p.adb)}
            ${line('设备在线', p.device ? p.device.serial + '（' + p.device.state + '）' : '不在线', !!p.device)}
            ${line('分辨率', p.resolution, p.device ? !!p.resolution : null)}
            ${line('得物包名', p.appPackage, p.device ? !!p.appPackage : null)}
            ${line('界面抓取 uiautomator', p.tools && p.tools.uiautomator == null ? '—' : ((p.tools && p.tools.uiautomator) ? '可用' : '不可用'), p.tools ? p.tools.uiautomator : null)}
            ${line('失败截图 screencap', (p.tools && p.tools.screencap) ? '可用' : '—', p.tools ? p.tools.screencap : null)}
            ${line('中文输入 ADBKeyboard',
              !p.appPackage ? '安装得物并连接设备后检查' : p.adbKeyboard ? (p.adbKeyboardActive ? '已装，且是当前输入法' : '已装，但没设成当前输入法（中文打不进去）') : '未安装',
              p.appPackage ? !!(p.adbKeyboard && p.adbKeyboardActive) : null)}
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
  const f = state.logFilter;
  const opts = [[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天'], [0, '全部时间'], ['custom', '自定义时间']]
    .map(([v, t]) => '<option value="' + v + '"' + ((f.rangeMode === 'custom' ? 'custom' : Number(f.days)) === v ? ' selected' : '') + '>' + t + '</option>').join('');
  const ex = state.logExport;
  return '<div class="box"><div class="row"><select class="inp" id="logDays">' + opts + '</select>'
    + (f.rangeMode === 'custom' ? '<input class="inp" id="logFrom" type="datetime-local" aria-label="开始时间" value="' + esc(f.fromAt) + '"><span>至</span><input class="inp" id="logTo" type="datetime-local" aria-label="结束时间" value="' + esc(f.toAt) + '">' : '')
    + '</div><p class="hint" id="logRangeError" style="color:var(--red)"' + (logTimeRange().valid ? ' hidden' : '') + '>请选择有效的开始和结束时间。</p></div>'
    + '<div class="box"><div class="logbar" style="border-top:0;max-height:420px"><div class="lines" id="logPaneLines"></div></div></div>'
    + (ex ? '<div class="box"><div class="row"><span class="grow">' + esc(String(ex.file || '').split(/[\\/]/).pop()) + '</span><button class="btn sm" data-act="log:openFile">打开文件</button><button class="btn sm" data-act="log:revealFile">打开所在文件夹</button></div></div>' : '')
    + (state.logExportErr ? '<p class="hint" style="color:var(--red)">' + esc(state.logExportErr) + '</p>' : '');
}

TABS[10] = {
  title: '运行日志',
  desc: '',
  actions: () => [
    { act: 'log:export', label: '导出日志', primary: true, disabled: !logTimeRange().valid || !filteredLogs().length }
  ],
  render() {
    return logPaneHtml();
  }
};

/** 进「运行日志」页时把行铺开（renderAll 里 render() 只产出空容器，行交给这里画） */
function bindLogPane() {
  const days = $('#logDays');
  if (days) days.onchange = () => {
    const f = state.logFilter;
    f.rangeMode = days.value === 'custom' ? 'custom' : 'preset';
    if (f.rangeMode === 'custom') {
      f.fromAt = f.fromAt || localDateTimeInput(Date.now() - 30 * 86400000);
      f.toAt = f.toAt || localDateTimeInput(Date.now());
    } else f.days = Number(days.value);
    renderAll();
  };
  for (const [id, key] of [['#logFrom', 'fromAt'], ['#logTo', 'toAt']]) {
    const input = $(id);
    if (input) input.onchange = () => { state.logFilter[key] = input.value; renderAll(); };
  }
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

// 更新日志按日期分组，左侧时间与类型，右侧标题及要点。
TABS[13] = {
  title: '更新日志', desc: '新功能、调整、修复，都写在这里。', actions: () => [],
  render: () => updatePanelHtml() + window.releaseMotion.render()
};

/* ---------------- ⑭ 备用入口试发（只给指定账号） ----------------
 * ★★ 2026-10-16 新增。为什么需要它：
 *   本机这台账号的个人页有「主页」按钮 ⇒ 主入口永远能走通，备用入口（动态流相机）
 *   在本机**没有真实触发条件**；而远端那些没有主页按钮的账号走的正是备用那一段。
 *   光靠「本机发布一遍」证明不了备用入口，只能给一个显式的强制开关把它跑出来。
 *
 * 与「模拟器发布」的关系：**同一个 publisher.run、同一条发布链路**，只多一个
 * `forceAlternateEntry`。不复制一份发布代码 —— 复制出来的一定会各自演化，
 * 测出来的结论就不可信了（本来要验的就是线上那条备用入口）。
 *
 * ★ 这个开关的语义是**「假装这台账号没有『主页』按钮」**，不是「另走一条备用路线」：
 *   导航那一段照常跑（先点「我」、停在个人页），到「主页」那一步无论按钮在不在都当找不到，
 *   于是**生产环境里无主页账号触发回退的那段代码**自己接管（回首页 → 点动态 → 等提示结束 → 点相机）。
 *   所以本页跑的整条命令序列，与真的没有主页按钮的账号逐条相同 —— 回归里有断言钉住这一点。
 *
 * 可见性有两层，缺一不可：
 *   ① 这里把按钮藏起来（不给人添乱）；
 *   ② 主进程 jobs.run 对 publish.fallbackTest 直接拒绝非指定账号 —— 改前端一行不算数。
 * 免登录开发模式（auth.service 没启用）照常可见，否则本机没法自测这条链路。
 */
const FALLBACK_TEST_USER = 'shuo';
function fallbackTestVisible() {
  const a = state.auth || {};
  if (!a.requireLogin) return true;                 // 免登录 / 开发模式
  const u = a.user || null;
  return !!u && String(u.username || '').trim().toLowerCase() === FALLBACK_TEST_USER;
}

TABS[14] = {
  title: '备用入口试发',
  fallbackTest: true,
  desc: '只走「动态流相机」这一条备用入口的真实发布（与远端无主页按钮账号同一路径）',
  actions: () => [
    { act: 'sheet:importReport', label: '导入 AI 内容报告' },
    { act: 'pub:stop', label: '停止', disabled: !running('publish.fallbackTest') },
    { act: 'pub:fallbackRun', label: '开始试发', primary: true,
      disabled: !(state.project.publish && state.project.publish.rows && state.project.publish.rows.length) }
  ],
  render() {
    const cfg = state.config.publish || {};
    const pub = state.project.publish || {};
    const rows = pub.rows || [];
    const okCount = rows.filter(r => r.result === '发布成功').length;
    const runningNow = running('publish.fallbackTest');
    return `
      <div class="box">
        <h3>这条模块做什么</h3>
        <p class="hint" style="margin-top:0">正常发布时，程序先试「我 → 主页 → 发布新动态」；
          这个账号没有「主页」按钮时，才退到动态流右上角的相机入口。
          <b>本机账号两者都有</b>，所以平时永远测不到备用那一段。</p>
        <p class="hint">这里的做法是<b>假装这个账号没有「主页」按钮</b>：照样先点「我」、停在个人页，
          到「主页」那一步当作找不到，于是由<b>正式发布里那段回退代码</b>接管（回首页 → 点动态 → 点相机）。
          素材清理、推送、索引、主图排序、选图、转场、填写、提交 <b>每一步都和正式发布一模一样</b>
          —— 所以在这里发的，就是远端账号会走的路径，逐条命令相同。</p>
        <!-- ★★ 试发也是真实提交 ⇒ 发布前的前置要求必须和「模拟器发布」页同一份
             （这里调的就是那个共用函数，不是复制一段文案）。 -->
        ${publishSetupHtml()}
      </div>
      <div class="box">
        ${reportBoxHtml()}
        ${devicesHtml()}
        ${runningNow ? progHtml(progFor('publish.fallbackTest')) : ''}
        ${batchesHtml('publish.fallbackTest', '正在试发的批次')}
      </div>
      ${rows.length ? `<div class="tw publish-rows"><table>
        <colgroup><col style="width:40px"><col style="width:260px"><col style="width:56px"><col style="width:56px"><col style="width:100px"><col style="width:80px"><col></colgroup>
        <thead><tr><th>#</th><th>素材目录</th><th>好物</th><th>图片</th><th>开始时间</th><th>耗时</th><th>状态</th></tr></thead>
        <tbody>${rows.map(r => `<tr data-publish-row="${esc(r.id)}" class="${r.result === '失败' || r.result === '校验未通过' ? 'flag' : ''}">
          <td class="num">${r.seq}</td><td class="mono" title="${esc(r.dir)}">${esc(r.dir)}</td><td class="num">${n(r.goods)}</td><td class="num">${n(r.images)}</td>
          <td data-publish-start>${esc(r.startAt || '—')}</td><td class="num" data-publish-elapsed>${publishElapsedText(r)}</td>
          <td data-publish-status>${badge(r.result || r.status || '排队', kindOf(r.result || r.status || '排队'))}${r.reason ? `<div style="font-size:11px;opacity:.8;margin-top:2px">${esc(r.reason)}</div>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有发布队列，请先导入 AI 内容报告。</div>`}
      <p class="hint">已提交 ${okCount} / ${rows.length} 条。这里是真实提交 —— 发出去的内容会出现在得物上，
        和正式发布没有区别，只是入口固定走备用那一条。</p>`;
  }
};

function syncUpdateNotice() {
  const available = ['available', 'downloading', 'downloaded'].includes(state.update?.status)
    || (state.update?.latestBuild > state.update?.build);
  const nav = document.querySelector('.nav[data-tab="13"]');
  if (nav) {
    nav.classList.toggle('has-update', !!available);
    nav.title = available ? '有新版本可下载' : '更新日志';
    nav.setAttribute('aria-label', available ? '更新日志，有新版本可下载' : '更新日志');
  }
}

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

function cfgDraftOwner() {
  const user = state.auth && state.auth.user;
  return JSON.stringify([state.tab, !!(state.auth && state.auth.requireLogin), user && user.id,
    user && user.role, user && user.brands]);
}

// 后台事件只保留当前页、当前账号未保存的普通设置；切页和鉴权变化不带入草稿。
function renderBackground() {
  const pane = $('#pane'), owner = cfgDraftOwner(), drafts = new Map();
  if (pane && pane.dataset.cfgOwner === owner) {
    pane.querySelectorAll('[data-cfg]').forEach(el => {
      if (el.type === 'password') return;
      const initial = el.tagName === 'SELECT'
        ? ((Array.from(el.options).find(option => option.defaultSelected) || el.options[0] || {}).value || '')
        : el.defaultValue;
      const dirty = el.type === 'checkbox' ? el.checked !== el.defaultChecked : el.value !== initial;
      if (dirty) drafts.set(el.dataset.cfg, { value: el.value, checked: el.checked, focused: document.activeElement === el,
        start: el.selectionStart, end: el.selectionEnd });
    });
  }
  renderAll();
  if (!pane || pane.dataset.cfgOwner !== owner || cfgDraftOwner() !== owner) return;
  pane.querySelectorAll('[data-cfg]').forEach(el => {
    const draft = drafts.get(el.dataset.cfg);
    if (!draft || el.type === 'password') return;
    if (el.type === 'checkbox') el.checked = draft.checked;
    else el.value = draft.value;
    if (draft.focused) {
      el.focus();
      if (typeof draft.start === 'number' && el.setSelectionRange) el.setSelectionRange(draft.start, draft.end);
    }
  });
}

function renderAll() {
  syncUpdateNotice();
  // 「备用入口试发」页也有设备表（试发必须真机），进页时同样要自动扫描一次
  if (PUBLISH_ROW_TABS.has(state.tab) && !deviceScanBusy && Date.now() - deviceScanAt > 10000) setTimeout(() => refreshDevices(), 0);
  syncAdminNav();   // 高级设置是管理员专属：先按权限把页签与当前页签都对齐，再渲染
  // ★ 页签 5「发布单」2026-10-03 已删 ⇒ 编号在 5 处留了空位。老配置里存过 tab=5、
  //   或按 Ctrl+5 按到空位时，必须兜回第 1 页 —— 否则 t 是 undefined，下面读 t.title 直接崩（整页白屏）。
  if (!TABS[state.tab] || TABS[state.tab].hidden) state.tab = 1;
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
    return;
  }
  $('#head').innerHTML = `<div><h2>${esc(t.title)}</h2><p>${esc(typeof t.desc === 'function' ? t.desc() : t.desc)}</p></div>
    <div class="act">${(t.actions()).map(a => `<button class="btn${a.primary ? ' primary' : ''}${a.transfer ? ' lx-transfer lx-' + a.transfer : ''}${a.history ? ' lx-history' : ''}" data-act="${a.act}" title="${esc(a.label)}" aria-label="${esc(a.label)}" ${a.disabled ? 'disabled' : ''}>${a.history ? lexHistoryIcon(a.history) : a.transfer ? lexTransferIcon(a.transfer) + '<span>' + esc(a.label) + '</span>' : esc(a.label)}</button>`).join('')}</div>`;
  const scroll = $('#pane').scrollTop;
  $('#pane').innerHTML = t.render();
  $('#pane').dataset.cfgOwner = cfgDraftOwner();
  if (window.releaseMotion) window.releaseMotion.mount();
  $('#pane').scrollTop = scroll;
  const chip = $('#runChip');
  if (state.jobs.length) {
    chip.textContent = state.jobs.length > 1 ? `运行中 ${state.jobs.length}` : '运行中';
    chip.className = 'chip run';
  } else { chip.textContent = '空闲'; chip.className = 'chip'; }
  // 左上角 app 名字后面的版本号：app:info 不受 guardAdmin 限制，人人可读；
  // 取不到就显示 v—（未知 ≠ 0，绝不编一个版本号出来）
  const av = $('#appVer');
  if (av) av.textContent = 'v' + ((state.info && state.info.version) || '—') + (['available', 'downloaded'].includes(state.update?.status) ? ' · 有更新' : '');
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
let gateFitVersion = 0;
function fitGateWindow() {
  if (!appApi.fitGate) return;
  const version = ++gateFitVersion;
  requestAnimationFrame(() => {
    if (version !== gateFitVersion || $('#gate').hidden || !document.body.classList.contains('locked')) return;
    const card = document.querySelector('.gate .gcard:not([hidden])');
    if (!card) return;
    const height = Math.ceil(card.getBoundingClientRect().height);
    if (height > 0) appApi.fitGate(height);
  });
}

function showGate(msg) {
  document.body.classList.add('locked');
  $('.app').hidden = true;
  $('.app').inert = true;
  $('#gate').hidden = false;
  const bootstrapMode = !!(state.auth && state.auth.bootstrapRequired);
  const loginForm = $('#loginForm'), bootstrapForm = $('#bootstrapForm');
  if (loginForm) loginForm.hidden = bootstrapMode;
  if (bootstrapForm) bootstrapForm.hidden = !bootstrapMode;
  $('#gateLoading').hidden = true;
  setGateLoading($('#lgGo'), false, '登 录');
  setGateLoading($('#lgSetupGo'), false, '创建云端管理员');
  const loginErr = $('#lgErr'), setupErr = $('#lgSetupErr');
  if (loginErr) loginErr.textContent = bootstrapMode ? '' : (msg || '');
  if (setupErr) setupErr.textContent = bootstrapMode ? (msg || '') : '';
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
  const bf = $('#bootstrapForm');
  if (bf && !bf.dataset.bound) {
    bf.dataset.bound = '1';
    bf.onsubmit = e => { e.preventDefault(); doBootstrap(); };
    const close = $('#bootstrapClose');
    if (close) close.onclick = () => appApi.close();
    ['#lgSetupCode','#lgSetupUser','#lgSetupPwd','#lgSetupName'].forEach(sel => {
      const el = $(sel); if (el) el.oninput = () => { if ($('#lgSetupErr').textContent) $('#lgSetupErr').textContent = ''; fitGateWindow(); };
    });
  }
  // ★ 出厂账号提示已删（2026-10-02 用户要求）：登录页不再回显 admin / 口令，
  //   连带 auth.status() 的 defaultHint 字段一起删掉（不留悬空字段）。
  fitGateWindow();                                // 量卡片实际高度，把窗口收紧
  // 异步读取本机加密凭据，不覆盖用户在等待期间输入的新内容。
  const beforeUser = $('#lgUser').value, beforePassword = $('#lgPwd').value;
  if (!bootstrapMode && appApi.authSavedLogin) appApi.authSavedLogin().then(saved => {
    if (!document.body.classList.contains('locked') || $('#gate').hidden) return;
    if ($('#lgUser').value !== beforeUser || $('#lgPwd').value !== beforePassword) return;
    if (saved && saved.username && (!beforeUser || beforeUser === saved.username)) {
      $('#lgUser').value = saved.username;
      if (!beforePassword) $('#lgPwd').value = saved.password || '';
    }
  }).catch(() => {});
  setTimeout(() => {
    const u = $('#lgUser');
    if (u.value) $('#lgPwd').focus(); else u.focus();
  }, 30);
}

/** 登录按钮始终保留文字；波形只放在独立加载页。 */
function setGateLoading(button, loading, label) {
  if (!button) return;
  button.disabled = !!loading;
  button.setAttribute('aria-busy', loading ? 'true' : 'false');
  button.textContent = label;
}

function showGateLoadingPage() {
  document.body.classList.add('locked');
  $('.app').hidden = true;
  $('.app').inert = true;
  $('#gate').hidden = false;
  $('#loginForm').hidden = true;
  $('#bootstrapForm').hidden = true;
  $('#gateLoading').hidden = false;
  $('#loadingClose').onclick = () => appApi.close();
  fitGateWindow();
}

async function doLogin() {
  const u = $('#lgUser').value.trim();
  const p = $('#lgPwd').value;
  const remember = $('#lgRem').checked;
  if (!u || !p) { $('#lgErr').textContent = '请输入账号和密码'; return; }
  const btn = $('#lgGo');
  if (btn.disabled) return;
  setGateLoading(btn, true, '登 录');
  try {
    const r = await appApi.authLogin(u, p, remember);
    if (!r.ok) {
      $('#lgErr').textContent = r.error || '登录失败';
      setGateLoading(btn, false, '登 录');
      fitGateWindow();                   // 报错行会让卡片变高，窗口跟着收紧一次
      $('#lgPwd').select();
      return;
    }
    showGateLoadingPage();
    $('#lgPwd').value = '';
    state.auth = await appApi.authStatus();
    await enterApp();
  } catch (error) {
    showGate('登录已确认，但主界面加载失败：' + (error.message || '请重试'));
  } finally {
    setGateLoading(btn, false, '登 录');
  }
}

async function doBootstrap() {
  const code = $('#lgSetupCode').value.trim();
  const user = $('#lgSetupUser').value.trim();
  const pass = $('#lgSetupPwd').value;
  const name = $('#lgSetupName').value.trim();
  if (!code || !user || !pass) { $('#lgSetupErr').textContent = '请填写初始化码、管理员账号和密码'; return; }
  const btn = $('#lgSetupGo');
  setGateLoading(btn, true, '创建云端管理员');
  try {
    const r = await appApi.authBootstrap(code, user, pass, name, $('#lgSetupRem').checked);
    if (!r.ok) { $('#lgSetupErr').textContent = r.error || '初始化失败'; fitGateWindow(); return; }
    showGateLoadingPage();
    $('#lgSetupCode').value = ''; $('#lgSetupPwd').value = '';
    state.auth = await appApi.authStatus();
    await enterApp();
    if (r.warning) toast(r.warning, 'err');
  } catch (error) {
    showGate('管理员已确认，但主界面加载失败：' + (error.message || '请重试'));
  } finally {
    setGateLoading(btn, false, '创建云端管理员');
  }
}

let enterAppPending = null;
function enterApp() {
  if (enterAppPending) return enterAppPending;
  enterAppPending = prepareApp().finally(() => { enterAppPending = null; });
  return enterAppPending;
}
async function prepareApp() {
  showGateLoadingPage();
  [state.config, state.project, state.logs] = await Promise.all([
    appApi.configGet(), appApi.projectGet(), appApi.logHistory()
  ]);
  const gate = stateGate();
  if (gate) throw new Error(gate.why);
  // 启动时对齐一次「运行中的批次」（job:busy 不传类型就是清单），免得刷新后看不见正在跑的任务
  const live = await appApi.busy();
  if (Array.isArray(live)) state.jobs = live.map(j => Object.assign({ progress: null, startedAt: j.startedAt || Date.now() }, j));
  await Promise.all([refreshBrands(), refreshUsers()]);
  bindOnce();
  renderAll();
  renderLogs();
  // 先准备好完整主界面，再切走登录页，避免登录确认后露出空白窗口。
  ++gateFitVersion;  // 作废尚未执行的登录卡片量高，避免主窗口恢复后又被旧回调缩小。
  if (appApi.authUiReady) {
    const ready = await appApi.authUiReady();
    if (!ready || !ready.ok) throw new Error((ready && ready.error) || '登录状态已失效，请重新登录');
  }
  $('#gate').hidden = true;
  document.body.classList.remove('locked');
  $('.app').hidden = false;
  $('.app').inert = false;
  const me = state.auth && state.auth.user;
  if (me && me.mustChange) toast('当前还是出厂口令，建议到「品牌与权限 → 账号与安全」改掉', 'err');
}

async function doLogout() {
  await appApi.authLogout();
  state.auth = await appApi.authStatus();
  state.users = null;
  state.logs = [];
  state.logFilter = { days: 30, rangeMode: 'preset', fromAt: '', toAt: '' };
  state.logExport = null;
  renderLogs();
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
      <p class="hint"><b>操作流程</b>：确认模型与品牌提示词，选择素材目录启动任务。标题句式由系统按行自动轮换 <b>T01–T15</b>，无需手动选择。</p>
      <p class="hint"><b>素材与报告位置</b>：当前批次已整理时，选择原目录 A 也会使用处理后的目录 B；B 不存在时停止生成。报告保存在本次实际使用的素材目录，文件名为 <code>&lt;品牌&gt;_AI内容报告_&lt;时间戳&gt;.xlsx</code>，发布引用报告中的素材路径。</p>
      <p class="hint"><b>打开与核对报告</b>：生成后点击带下载图标的「报告」按钮，直接用本机 Excel/WPS 打开原文件，不走云端、不新建目录。页面仅提示缺货号、空标题、空正文和货号混入文案等明确错误；颜色、字数、行数、emoji、套话和重复等建议保留在报告的「文案核对」列。修改后保存并关闭 Excel/WPS，再到「模拟器发布」导入报告。不要移动或重命名报告引用的素材目录。</p>
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
      <p class="hint">默认使用在线模型。使用内置服务时，接口地址、API Key 和模型均可留空。
        更换服务商时，请填写该服务商对应的三项配置。</p>
      <div class="mfld"><span>生成方式</span>
        <select class="inp" id="lmEnabled" style="width:100%" disabled>
          <option value="true" selected>在线模型</option>
        </select></div>
      <div class="mfld"><span>模型服务地址</span>
        <input class="inp mono" id="lmEndpoint" style="width:100%" value="${esc(c.endpoint || '')}" placeholder="服务商提供的 API 地址，通常以 /v1 结尾">
        <p class="hint">地址决定请求发到哪个服务商。只填 API Key 和模型、地址留空时，仍使用内置服务地址；切换服务商必须填写对应地址。</p></div>
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
        <select class="inp" id="lmVision" disabled>
          <option value="true" ${b(c.vision === undefined ? true : c.vision) ? 'selected' : ''}>送实拍图</option>
          <option value="false" ${!b(c.vision === undefined ? true : c.vision) ? 'selected' : ''}>不送图</option>
        </select>
        <span class="lbl">每条送图</span>
        <select class="inp" id="lmCount" disabled>${[1, 2, 3, 4].map(v => `<option value="${v}" ${num(c.imageCount, 2) === v ? 'selected' : ''}>${v} 张</option>`).join('')}</select>
        <span class="lbl">单边缩到</span>
        <select class="inp" id="lmSide" disabled>${[512, 768, 1024, 1568].map(v => `<option value="${v}" ${num(c.imageMaxSide, 768) === v ? 'selected' : ''}>${v}px</option>`).join('')}</select>
      </div>
      <p class="hint" style="margin-top:12px">看图参数暂不开放修改。只有视频时会尝试抽帧；模型连接失败会停止并提示原因。</p>
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
  if (m.view === 'statsUsers') {
    const s = state.stats;
    const b = s && [...s.brands, s.untagged, ...s.orphans].find(x => x.id === m.id);
    box.innerHTML = `<div class="mh"><h3>${esc(b ? b.name : '品牌')} · 执行人</h3><span class="grow"></span><button class="btn sm" data-act="up:close">关闭</button></div>
      <div class="mb"><div class="tw"><table class="stats-users"><thead><tr><th>账号</th><th>执行人</th><th>条数</th><th>成功</th><th>失败</th></tr></thead><tbody>${(b ? b.users : []).map(u => `<tr><td>${esc(u.username || '—')}</td><td>${esc(u.displayName || u.username || '—')}</td><td>${u.rows}</td><td>${u.ok}</td><td>${u.fail}</td></tr>`).join('')}</tbody></table></div></div>`;
    return;
  }
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
 * 管理员专属页签（「品牌与权限」「高级设置」）：非管理员整个按钮都不显示。
 * ★ 这只是「不给人添乱」—— 真正拦住的是主进程那几道 guard。但这条不能省：
 *   否则普通成员能点进一个自己改不动、也不该动的页面，只会一头雾水。
 * ★ 两条线都在这里收口：① 按钮 hidden；② 当前 `state.tab` 若正落在一个自己看不到的页签上，
 *   兜回第 1 页（退出登录 / 换账号 / 老配置里存过隐藏页签时会遇到）。
 */
function syncAdminNav() {
  const ok = canAdmin();
  document.querySelectorAll('.nav[data-admin]').forEach(el => { el.hidden = !ok; });
  // 「备用入口试发」与管理员无关，它只对指定账号可见 —— 单独一条线，别和管理员权限混在一起
  // （混在一起的话，哪天把那个账号设成管理员，普通成员反而看不到，理由也说不清）。
  const ft = fallbackTestVisible();
  document.querySelectorAll('.nav[data-fallback-test]').forEach(el => { el.hidden = !ft; });
  if (TABS[state.tab] && (TABS[state.tab].hidden || (!ok && TABS[state.tab].admin)
    || (TABS[state.tab].fallbackTest && !ft))) state.tab = 1;
}

/** 这个人能编辑哪些品牌：管理员=全部；成员=名下的（含已停用的，否则停用一个他连看都看不到） */
function myBrands() {
  const m = state.brandsMeta || {};
  const mine = m.mine || [];
  return (m.brands || []).filter(b => canAdmin() || mine.includes(b.id));
}

function bmListHtml() {
  const isAdmin = canAdmin();
  const list = [...myBrands(), ...((state.config.copy || {}).localPrompts || [])];
  const def = (state.brandsMeta && state.brandsMeta.defaultBrandId) || '';
  const rows = list.length ? list.map(b => {
    const ok = !!String(b.promptWrite || '').trim();
    const dead = b.enabled === false;
    // 「本次」= 内存里正在用的那个（state.brandId），点了立即生效、不落盘，重启回到默认
    // 「默认」= 落盘的 copy.defaultBrandId，重启后还是它
    const isPick = b.local ? (state.config.copy || {}).promptProfileId === b.id : !((state.config.copy || {}).promptProfileId) && !!b.id && state.brandId === b.id;
    const isDefault = !!b.id && def === b.id;
    return `<div class="brow${dead ? ' dead' : ''}">
      <span class="bn">${esc(b.name)}</span>
      ${dead ? badge('已停用', 'wait') : badge('启用', 'ok')}
      ${ok ? '<span class="chip">已配文案</span>' : '<span class="chip warn">未配文案</span>'}
      ${isPick ? '<span class="chip run">本次</span>' : ''}
      ${isDefault ? '<span class="chip chip-user">默认</span>' : ''}
      <span class="grow snip">${esc(String(b.promptWrite || '').replace(/\s+/g, ' ').slice(0, 46) || '—')}</span>
      <button class="btn sm" data-act="bm:open" data-id="${esc(b.id)}">配置</button>
      <button class="btn sm${isPick ? ' primary' : ''}" data-act="bm:pick" data-id="${esc(b.id)}" data-name="${esc(b.name)}" ${dead ? 'disabled' : ''}>选择</button>
      ${b.local ? '<span class="chip">本机提示词</span>' : `<button class="btn sm${isDefault ? ' primary' : ''}" data-act="bm:default" data-id="${esc(b.id)}" data-name="${esc(b.name)}" ${dead ? 'disabled' : ''}>默认选择</button>`}
    </div>`;
  }).join('') : `<div class="empty">${isAdmin
    ? '还没有品牌。点左下角「新增品牌」建一个，再给它写文案提示词。'
    : '你名下还没有品牌 —— 请联系管理员在「品牌与权限 → 账号管理」里分配。'}</div>`;
  return `
    <div class="mh"><h3>文案提示词</h3><span class="grow"></span>
      <button class="btn sm" data-act="bm:close">关闭</button></div>
    <div class="mb">
      <p class="mnote" style="margin:0 0 11px">提示词仅保存在当前设备，同一品牌在其他设备上可单独配置，互不覆盖。<b>点「配置」进去改</b>。
        没配的品牌<b>不允许生成</b>：会直接拦下并提示来这儿补，不会悄悄拿别的品牌的口吻顶替。</p>
      <p class="mnote" style="margin:0 0 11px">右边两个按钮别混：
        自定义品牌的「选择」用于文案提示词，保留到下次启动；发布品牌按标题栏的账号权限选择。</p>
      <div class="blist">${rows}</div>
    </div>
    <div class="mf">
      <button class="btn sm primary" data-act="bm:new">新增品牌提示词</button>
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
    : [...(m.brands || []), ...((state.config.copy || {}).localPrompts || [])].find(x => x.id === id);
  if (!b) {
    return `<div class="mh"><h3>品牌不见了</h3><span class="grow"></span>
        <button class="btn sm" data-act="bm:list">返回列表</button></div>
      <div class="mb"><div class="empty">这个品牌刚被删掉了（可能是在另一个窗口干的）。回列表看看。</div></div>`;
  }
  const picked = (m.defaultBrandId || '') === b.id;
  const local = isNew || b.local;
  const meta = isAdmin || local;
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

      <label class="mchk" style="margin-top:13px;${local ? 'display:none' : ''}" ${meta ? '' : 'data-off="1"'}>
        <input type="checkbox" id="bmEnabled" ${b.enabled === false ? '' : 'checked'} ${meta ? '' : 'disabled'}> 启用该品牌
      </label>
      <label class="mchk" style="${local ? 'display:none' : ''}" ${meta ? '' : 'data-off="1"'}>
        <input type="checkbox" id="bmPick" ${picked ? 'checked' : ''} ${meta ? '' : 'disabled'}> 本次选用（生成 / 发布默认归属它）
      </label>
      <p class="mnote">${local ? '保存于本机，可自由命名；点列表中的「选择」用于文案生成。发布品牌仍按账号权限选择。' : '「本次选用」同时只会有一个品牌。'}</p>
      ${meta ? '' : '<p class="mnote">品牌名 / 启用 / 选用由管理员维护，你能改的是上面两段提示词。</p>'}
    </div>
    <div class="mf">
      ${(isAdmin && !isNew && !b.local) ? `<button class="btn sm" data-act="bm:del" data-id="${esc(b.id)}">删除品牌</button>` : ''}
      <span class="grow"></span>
      <button class="btn sm" data-act="bm:close">取消</button>
      <button class="btn sm primary" data-act="bm:save" data-id="${esc(b.id)}">保存</button>
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
        ? `<button class="btn sm primary" data-act="brand:save" data-id="${esc(b.id)}">保存</button>
             <button class="btn sm" data-act="brand:cancel">取消</button>`
        : `<button class="btn sm" data-act="brand:edit" data-id="${esc(b.id)}">改名</button>
             <button class="btn sm" data-act="brand:toggle" data-id="${esc(b.id)}" data-next="${b.enabled === false ? '1' : '0'}">${b.enabled === false ? '启用' : '停用'}</button>
             <button class="btn sm" data-act="brand:del" data-id="${esc(b.id)}" data-name="${esc(b.name)}">删除</button>`}</td>
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
          ${all.filter(b => b.enabled !== false).map(b => `<option value="${esc(b.id)}" ${m.defaultBrandId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
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
        <button class="btn sm" data-act="up:perm" data-id="${esc(u.id)}">配置权限</button>
        <button class="btn sm" data-act="up:pwd" data-id="${esc(u.id)}">重置密码</button>
        <button class="btn sm" data-act="auth:toggle" data-id="${esc(u.id)}" data-next="${u.disabled ? '0' : '1'}">${u.disabled ? '启用' : '停用'}</button>
        <button class="btn sm" data-act="auth:del" data-id="${esc(u.id)}" data-name="${esc(u.username)}">删除</button>`}</td>
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
        <div class="perm-list" aria-label="新账号品牌权限">
          <b>分配品牌：</b>${all.filter(b => b.enabled !== false).length
            ? all.filter(b => b.enabled !== false).map(b => `<label class="perm"><input type="checkbox" data-new-brand="${esc(b.id)}"> ${esc(b.name)}</label>`).join('')
            : '<span class="hint">暂无启用品牌，请先到上方品牌管理新增或启用品牌。</span>'}
        </div>
      </div>
      <p class="hint">成员需至少分配一个启用品牌，可通过「配置权限」调整。管理员拥有全部品牌。</p>
      <p class="hint">账号和品牌权限跨设备同步，登录需要联网。连续输错 6 次会锁定 5 分钟。</p>
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
        ? `<div class="perm-list">${all.map(b => `<label class="perm"><input type="checkbox" data-brand="${esc(b.id)}" ${mine.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}${b.enabled === false ? '（停用）' : ''}</label>`).join('')}</div>`
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
  // 所有登录用户均可修改本机词库，保存不会影响其他电脑。
  'lex:undo': () => lexTravel('undo'),
  'lex:redo': () => lexTravel('redo'),
  'lex:export': async () => {
    if (!state.lex || state.lexTransferBusy) return;
    setLexTransferBusy(true);
    try {
      const result = await appApi.hotwordsExport(state.lex.groups.map(g => ({ key: g.key, words: g.words.slice() })));
      if (!result || !result.ok) { toast((result && result.error) || '导出失败', 'err'); return; }
      if (!result.canceled) { markLexTransferDone('lex:export'); toast('词库已导出，可在其他电脑导入'); }
    } catch (error) { toast('导出失败：' + error.message, 'err'); }
    finally { setLexTransferBusy(false); }
  },
  'lex:import': async () => {
    if (!state.lex || state.lexTransferBusy) return;
    setLexTransferBusy(true);
    try {
      const result = await appApi.hotwordsImport();
      if (!result || !result.ok) { toast((result && result.error) || '导入失败', 'err'); return; }
      if (result.canceled) return;
      if (!window.confirm('导入会替换本机的可编辑词库' + (state.lexDirty ? '，包括当前尚未保存的修改' : '') + '。内置锁定词组和句式骨架保持不变。\n\n确定导入并保存吗？')) return;
      const saved = await appApi.hotwordsSave(result.groups);
      if (!saved || !saved.ok) { toast((saved && saved.error) || '导入保存失败', 'err'); return; }
      lexCheckpoint();
      state.lex = saved.library;
      state.lexSavedFingerprint = lexFingerprint(state.lex);
      state.lexDirty = false;
      renderAll();
      markLexTransferDone('lex:import');
      toast(saved.warnings.length ? '已导入并保存：' + saved.warnings.join('；') : '词库已导入并保存，下次生成生效');
    } catch (error) { toast('导入失败：' + error.message, 'err'); }
    finally { setLexTransferBusy(false); }
  },
  'lex:save': async () => {
    const L = state.lex;
    if (!L || state.lexTransferBusy) return;
    setLexTransferBusy(true);
    try {
    const r = await appApi.hotwordsSave(L.groups.map(g => ({ key: g.key, words: g.words.slice() }))).catch(() => null);
    if (!r || !r.ok) { toast((r && r.error) || '保存失败', 'err'); return; }
    if (lexFingerprint(L) !== lexFingerprint(r.library)) lexCheckpoint();
    state.lex = r.library;
    state.lexSavedFingerprint = lexFingerprint(state.lex);
    state.lexDirty = false;
    if (r.rejected.length) {
      toast(`有 ${r.rejected.length} 个词没进库：` + r.rejected.map(x => `「${x.word}」${x.why}`).join('；'), 'err');
    } else if (r.warnings.length) {
      toast('已保存，但有要留意的地方：' + r.warnings.join('；'), 'err');
    } else {
      toast('本机词库已保存 —— 下一次生成就会使用，不影响其他电脑');
    }
    renderAll();
    } finally { setLexTransferBusy(false); }
  },
  'lex:reset': async () => {
    if (!state.lex || state.lexTransferBusy) return;
    if (!window.confirm('恢复内置词库？\n\n你在这一页做的增删改会全部丢弃，回到程序自带的那 8 组词。')) return;
    setLexTransferBusy(true);
    try {
    const r = await appApi.hotwordsReset().catch(() => null);
    if (!r || !r.ok) { toast((r && r.error) || '恢复失败', 'err'); return; }
    lexCheckpoint();
    state.lex = r.library;
    state.lexSavedFingerprint = lexFingerprint(state.lex);
    state.lexDirty = false;
    toast('已恢复内置词库');
    renderAll();
    } finally { setLexTransferBusy(false); }
  },

  // 「说明书」弹窗：topic 从按钮的 data-topic 上取（写错 topic ⇒ 弹窗打不开，测试点名抓）
  'help:open': (el) => openHelpModal(el.dataset.topic),
  'help:close': () => closeHelpModal(),
  'flatten:pick': async () => {
    const d = await appApi.pickDir({ title: '选择素材目录', defaultPath: state.project.sourceDir || '' });
    if (d) { state.project.sourceDir = d; state.plan = await appApi.run('flatten.plan', brandArgs('flatten.plan', { sourceDir: d })).then(r => r.ok ? r.result : null); renderAll(); }
  },
  'flatten:plan': async () => {
    const r = await appApi.run('flatten.plan', brandArgs('flatten.plan', { sourceDir: state.project.sourceDir }));
    if (r.ok) { state.plan = r.result; toast(`清单已生成：${r.result.total} 个叶子目录`, 'ok'); }
    renderAll();
  },
  'flatten:openFlat': async el => {
    const dir = el.dataset.path || '';
    if (!dir) { toast('没有可打开的整理结果目录', 'err'); return; }
    const result = await appApi.openPath(dir);
    if (result !== true) toast(typeof result === 'string' && result ? result : '无法打开整理结果：目录可能已被移动或删除，请核对路径', 'err');
  },
  'flatten:run': async () => {
    if (state.flattenSubmitting) return;
    state.flattenSubmitting = true;
    try {
    const r = await runJob('flatten.run', { sourceDir: state.project.sourceDir });
    if (r.ok) { state.plan = null; toast(r.result.summary, 'ok'); }
    } finally { state.flattenSubmitting = false; renderAll(); }
  },
  'update:check': async () => { await appApi.updateCheck(); },
  'update:open': () => { state.tab = 13; renderAll(); },
  'feedback:open': () => {
    let mask = $('#feedbackModal');
    if (!mask) { mask = document.createElement('div'); mask.id = 'feedbackModal'; mask.className = 'modal'; document.body.appendChild(mask); }
    mask.innerHTML = `<section class="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle"><header class="feedback-heading"><div><span class="feedback-eyebrow">我们在听</span><h3 id="feedbackTitle">问题与建议</h3></div><button class="feedback-dismiss" data-act="feedback:close" aria-label="关闭反馈">×</button></header><p class="feedback-description">反馈会同步至开发，帮助我们把工具做得更好。</p><label class="feedback-label" for="feedbackText">反馈内容</label><textarea id="feedbackText" class="inp" maxlength="1000" rows="6" placeholder="哪里遇到了问题？你希望如何改进？"></textarea><p class="feedback-note">请勿填写密码或密钥。</p><p id="feedbackMessage" class="hint" role="status"></p><footer class="feedback-footer"><button class="btn" data-act="feedback:close">取消</button><button class="btn primary" data-act="feedback:send">提交反馈</button></footer></section>`;
    mask.hidden = false; $('#feedbackText').focus();
  },
  'feedback:close': () => { if ($('#feedbackModal')) $('#feedbackModal').hidden = true; },
  'feedback:send': async el => {
    const input = $('#feedbackText'), message = $('#feedbackMessage');
    if (!input.value.trim()) { message.textContent = '请填写反馈内容'; return; }
    el.disabled = true; message.textContent = '正在提交…';
    try {
      const result = await appApi.feedbackSubmit(input.value);
      message.textContent = result.ok ? result.message : (result.error || '提交失败，请重试');
      if (result.ok) { input.value = ''; input.disabled = true; }
      else el.disabled = false;
    } catch (error) { message.textContent = '提交失败：' + error.message; el.disabled = false; }
  },
  'update:download': async () => { await appApi.updateDownload(); },
  'update:install': async () => {
    if (!window.confirm('将退出 App、自动完成更新并重新启动。请确认已保存编辑内容。')) return;
    const r = await appApi.updateInstall();
    if (!r.ok) toast(r.error, 'err');
  },

  'comp:scan': async () => { await runJob('compliance.scan'); },
  'comp:parent': async () => {
    const d = await appApi.pickDir({ title: '选择父目录（里面每个子文件夹独立检查）', parentOf: state.project.flatDir || state.project.sourceDir || '' });
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
    const d = await appApi.pickDir({ title: '选择素材目录', parentOf: state.project.flatDir || state.project.sourceDir || '' });
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
  // 所有已登录账号均可保存；config:set 主进程门禁负责要求有效登录。
  'lm:save': async () => {
    const val = sel => { const e = $(sel); return e ? e.value.trim() : ''; };
    const llm = {
      enabled: true,
      endpoint: val('#lmEndpoint'),
      apiKey: val('#lmKey'),
      model: val('#lmModel'),
    };
    await checkedConfigSet({ copy: { llm } });
    state.config = await appApi.configGet();
    toast(`模型配置已保存${llm.model ? `（默认模型：${llm.model}）` : '（模型留空 = 跟随内置）'}`, 'ok');
    closeModelModal();
  },
  // 「提示词配置」= 直接开弹窗，不再跳到设置页那两个没人看得懂的输入框
  'copy:prompt': () => {
    if (!state.brandsMeta) { toast('品牌列表还没加载好，稍等一下再点', 'err'); return; }
    openBrandModal('list');
  },
  // 直接打开生成的本地文件，不下载、不复制，也不创建目录。
  'copy:openReport': async () => {
    if (!lastCopyReport || !lastCopyReport.file) { toast('还没有生成过报告', 'warn'); return; }
    const opened = await appApi.openPath(lastCopyReport.file);
    if (opened !== true) toast(typeof opened === 'string' && opened ? `无法打开报告：${opened}` : '无法打开报告，请确认文件仍在原位置并已安装 Excel 或 WPS', 'err');
  },

  // ---- 文案提示词弹窗 ----
  'bm:list': () => openBrandModal('list'),
  'bm:open': (el) => openBrandModal('edit', el.dataset.id),
  // 「选择」= 本次用它。★ 只改内存里的 state.brandId，**不落盘** —— 这就是它和「默认选择」的全部区别。
  // 后续任务在 runJob 里会把这个 id 随 args 带给主进程（主进程还会再校验一次权限）。
  'bm:pick': async (el) => {
    const local = el.dataset.id.startsWith('local-');
    await checkedConfigSet({ copy: { promptProfileId: local ? el.dataset.id : '' } });
    state.config = await appApi.configGet();
    if (!local) state.brandId = el.dataset.id;
    // 标题栏那个下拉要跟着变 —— 否则「本次」改了却看不见，用户会以为没生效
    // （paintBrandSelect 原先只在刷新品牌列表时调，这条路径得自己叫一次）
    paintBrandSelect();
    toast(`已选择「${el.dataset.name}」${local ? '文案提示词' : ''}`, 'ok');
    renderBrandModal();
    renderAll();
  },
  // 「默认选择」= 写进配置（copy.defaultBrandId），重启后还是它
  'bm:default': async (el) => {
    const id = el.dataset.id;
    await checkedConfigSet({ copy: { defaultBrandId: id } });
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

    if (!id || id.startsWith('local-')) {
      // 新增：按钮本来就只给管理员看，主进程还会再校验一次
      if (!name) { toast('先给品牌起个名字', 'err'); return; }
      const r = await appApi.promptSave(id, { name, promptWrite });
      if (!r.ok) { toast(r.error, 'err'); return; }
      await checkedConfigSet({ copy: { promptProfileId: r.brand.id } });
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
      if (wantPicked && !wasPicked) await checkedConfigSet({ copy: { defaultBrandId: id } });
      else if (!wantPicked && wasPicked) await checkedConfigSet({ copy: { defaultBrandId: '' } });
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

  // ---- 运行日志：只允许筛选和导出，任何用户都没有清除入口 ----
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
    const f = await appApi.pickFile({ title: '导入商品资料（CSV/TSV/JSON：货号 + 颜色）' });
    if (!f) return;
    const r = await appApi.run('pool.import', brandArgs('pool.import', { file: f }));
    if (r.ok) { state.info = await appApi.info(); toast(`商品资料已导入：${r.result.count} 个货号`, 'ok'); }
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
      // 文件路径让系统打开报告所在文件夹并预选报告；没有报告时回到本批素材目录。
      defaultPath: (lastCopyReport && lastCopyReport.file) || (state.project.publish || {}).reportFile
        || state.project.flatDir || state.project.sourceDir || undefined,
      filters: [{ name: 'Excel 报告', extensions: ['xlsx'] }]
    });
    if (!f) return;
    // 先静默试一次：报告里自带「素材路径」就直接用；没有的话再问一次这一批的素材目录
    let r = await appApi.run('report.import', brandArgs('report.import', { file: f }));
    // 仅缺少可用路径时补选；路径不存在、表头损坏不能误说成空路径。
    if (!r.ok && /缺「素材路径」，也没有指定这一批的素材目录/.test(r.error || '')) {
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
    const r = await appApi.run('publish.connect', brandArgs('publish.connect', {}));
    if (r.ok) toast(r.result.note, r.result.connected ? 'ok' : '');
    renderAll();
  },
  'pub:probe': async () => {
    const r = await appApi.run('publish.probe', brandArgs('publish.probe', {}));
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
    const r = await appApi.run('publish.dump', brandArgs('publish.dump', {}));
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
    const r = await appApi.run('publish.importMap', brandArgs('publish.importMap', { file: f }));
    if (r.ok) { state.config = await appApi.configGet(); toast(`定位表已导入：${r.result.steps} 步`, 'ok'); }
    renderAll();
  },
  'pub:delDev': async (el) => {
    await appApi.run('publish.removeDevice', brandArgs('publish.removeDevice', { id: el.dataset.id }));
    state.config = await appApi.configGet();
    renderAll();
  },
  'pub:useDev': async (el) => {
    await checkedConfigSet({ publish: { device: el.dataset.serial } });
    state.config = await appApi.configGet();
    state.project.publish = state.project.publish || {};
    await appApi.run('publish.connect', brandArgs('publish.connect', { device: el.dataset.serial }));
    state.project = await appApi.projectGet();
    renderAll();
  },
  // 手动扫描与定时发现共用同一入口，避免重复连接。
  'pub:devScan': async () => {
    await refreshDevices(true);
  },
  // adb 认到、还没加进列表的设备：一键加入并选用。
  // ★ 有了这一步，用户永远不用知道 emulator-5554 是什么 —— 原来他得自己把那个名字抄进输入框。
  'pub:useFound': async (el) => {
    const serial = el.dataset.serial;
    const found = (state.devFound || []).find(d => d.serial === serial);
    const add = await appApi.run('publish.addDevice', brandArgs('publish.addDevice', { name: (found && found.name) || serial, serial }));
    if (!add.ok && !/已存在/.test(add.error || '')) { toast(add.error || '加入失败', 'err'); renderAll(); return; }
    await checkedConfigSet({ publish: { device: serial } });
    state.config = await appApi.configGet();
    state.project.publish = state.project.publish || {};
    const r = await appApi.run('publish.connect', brandArgs('publish.connect', { device: serial }));
    state.project = await appApi.projectGet();
    toast(r.ok ? `${serial}：${r.result.note}` : `${serial} 已加入，但连接没成`, r.ok ? 'ok' : 'err');
    renderAll();
  },
  // 「去高级设置」：发布页/设置页只剩只读回显时，给管理员一条直达的路
  'go:advanced': () => { state.tab = 11; renderAll(); },
  'go:dewu': () => {
    state.tab = 7; renderAll();
    const button = document.querySelector('[data-act="apk:save"]');
    if (button) button.closest('tr').scrollIntoView({ block: 'center' });
  },
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
  /**
   * 「备用入口试发」→ 同一条发布链路，只多一个 forceAlternateEntry。
   * ★ 这里**故意不弹**「模拟通道」确认框：试发要验的就是真实点击备用入口，
   *   模拟通道根本不碰设备，跑了等于没跑。所以模拟通道**直接拒绝**，并说清下一步。
   */
  'pub:fallbackRun': async () => {
    const pub = state.project.publish || {};
    if ((pub.mode || 'mock') !== 'adb') {
      toast('备用入口试发必须走真实设备：请先「连接模拟器」并点「检查能不能发布」通过', 'err');
      return;
    }
    await runJob('publish.fallbackTest', {});
  },
  'pub:exportLog': async () => {
    const batch = (state.project.publish || {}).batch || '';
    const r = await runJob('publish.exportLog', { batch });
    if (r.ok) {
      toast(`已导出 ${r.result.entries} 条日志（成功 ${r.result.ok} / 失败 ${r.result.failed}）→ ${(r.result.file || '').split(/[\\/]/).pop()}`, 'ok');
      if (r.result.file) await appApi.reveal(r.result.file);
    }
  },
  /**
   * ★★ 2026-10-16：新增「备用入口试发」页签之后，`pub:stop` 不能只盯着 `publish.run`。
   *   原来这一句写死了 `cancel('publish.run')` ⇒ 试发那一页按「停止」会提示「当前没有在跑的发布任务」，
   *   而任务其实还在跑（只能等它自己走完，或去「运行日志」页逐个取消）。这里改成：
   *   先把所有发布类型挨个请求一遍，再把实际停到的数量一起说清楚（0 个才是真的没在跑）。
   */
  'pub:stop': async () => {
    let nGone = 0;
    for (const t of PUBLISH_JOB_TYPES) nGone += await appApi.cancel(t) || 0;
    toast(nGone ? `已请求停止 ${nGone} 个发布任务，当前步骤结束后停下`
      : '当前没有在跑的发布任务', nGone ? '' : 'err');
    renderAll();
  },
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
    const role = $('#nuRole').value;
    const brands = [...document.querySelectorAll('[data-new-brand]:checked')].map(el => el.dataset.newBrand);
    if (role === 'user' && brands.length === 0) {
      toast('普通成员至少选择一个启用品牌', 'err');
      return;
    }
    const input = {
      username: $('#nuUser').value.trim(),
      displayName: $('#nuName').value.trim(),
      role,
      password: $('#nuPwd').value,
      brands: role === 'user' ? brands : []
    };
    const r = await appApi.authCreateUser(input);
    if (!r.ok) { toast(r.error, 'err'); return; }
    $('#nuUser').value = ''; $('#nuName').value = ''; $('#nuPwd').value = '';
    document.querySelectorAll('[data-new-brand]').forEach(el => { el.checked = false; });
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
    await checkedConfigSet({ copy: { defaultBrandId: id } });
    state.config = await appApi.configGet();
    await refreshBrands();
    toast(id ? `默认品牌已设为 ${brandNameOf(id)}` : '已取消默认品牌', 'ok');
    renderAll();
  },

  // ---- 品牌统计 ----
  'stats:users': el => {
    state.userModal = { view: 'statsUsers', id: el.dataset.id };
    renderUserModal();
  },
  'stats:usageView': el => { state.usageView = el.dataset.id === 'details' ? 'details' : 'summary'; state.usagePage = 0; renderAll(); },
  'stats:usageAccount': el => { state.usageAccount = el.dataset.id || ''; state.usagePage = 0; renderAll(); },
  'stats:usagePrev': () => { state.usagePage = Math.max(0, state.usagePage - 1); renderAll(); },
  'stats:usageNext': () => { state.usagePage++; renderAll(); },
  'stats:refresh': async () => {
    if (state.statsOpts.rangeMode === 'custom') {
      const from = new Date(state.statsOpts.fromAt || '').getTime();
      const to = new Date(state.statsOpts.toAt || '').getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to)) { toast('请选择开始时间和结束时间', 'err'); return; }
      if (to < from) { toast('结束时间不能早于开始时间', 'err'); return; }
    }
    state.stats = null;
    state.statsTried = false;
    await loadStats();
  },
  'stats:export': async () => {
    if (!statsFiltersCurrent()) { toast('筛选条件已更改，请先查询', 'err'); return; }
    const r = await appApi.statsExport(state.statsOpts);
    if (!r.ok) { toast(r.error || '导出失败', 'err'); return; }
    toast(`已导出：${(r.file || '').split(/[\\/]/).pop()}（${r.brandCount} 个品牌 · ${r.totals.rows} 条记录）`, 'ok');
    if (r.file) await appApi.reveal(r.file);
  },
  'stats:exportLog': async () => {
    if (!statsFiltersCurrent()) { toast('筛选条件已更改，请先查询', 'err'); return; }
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
    const r = await appApi.run('publish.installDewuApk', brandArgs('publish.installDewuApk', {}));
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
    const r = await appApi.run('publish.installDewuApk', brandArgs('publish.installDewuApk', { force: true }));
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    state.dewuAlready = false;
    toast(`覆盖重装完成：得物 ${(r.result && r.result.installedVersion) || ''}（应用数据与登录状态保留）`, 'ok');
    renderAll();
  },

  'cfg:save': async () => { if (await saveCfgFromDom()) toast('已保存', 'ok'); }
  // ★ 2026-10-04：「cfg:path」（选输出目录 / 隔离目录）随设置页那一块一起删 ——
  //   界面上已经没有任何 data-act="cfg:path" 的入口，留着处理器就是死代码。
  //   两个目录改走出厂默认值（winpath.js），主进程的读取点（合规报告 / 日志 / 统计 / 隔离）全都没动。
};

async function checkedConfigSet(patch) {
  const saved = await appApi.configSet(patch);
  if (!saved || saved.ok === false) throw new Error((saved && saved.error) || '设置保存失败，请重试');
  return saved;
}

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
  try { await checkedConfigSet(patch); }
  catch (error) { toast('设置未保存：' + (error.message || '连接失败，请重试'), 'err'); return false; }
  state.config = await appApi.configGet();
  // ★ 外部工具的路径改完要**立刻**看得见「现在用的是哪一个」：adb / ffmpeg 的三段解析结果
  //   在主进程的 app:info 里，不刷新的话「外部依赖」表还写着旧状态，用户会以为没生效。
  //   只在真动了这两个键时刷新，且只在这两页重画 —— 别的页重画会打断正在输入的人。
  const p2 = patch.publish || {};
  if (Object.prototype.hasOwnProperty.call(p2, 'adbPath') || Object.prototype.hasOwnProperty.call(p2, 'ffmpegPath')) {
    state.info = await appApi.info();
    if (state.tab === 7 || state.tab === 11) renderAll();
  }
  return true;
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
    el.onchange = () => { saveCfgFromDom().catch(error => toast('设置刷新失败：' + (error.message || '请重试'), 'err')); };
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
    el.onchange = () => { state.statsOpts[key] = el.value; syncStatsExportButtons(); };
  };
  const range = $('#stDays');
  if (range) range.onchange = () => {
    if (range.value === 'custom') {
      state.statsOpts.rangeMode = 'custom';
      const now = Date.now();
      if (!state.statsOpts.fromAt) state.statsOpts.fromAt = localDateTimeInput(now - 30 * 86400000);
      if (!state.statsOpts.toAt) state.statsOpts.toAt = localDateTimeInput(now);
    } else {
      state.statsOpts.rangeMode = 'preset';
      state.statsOpts.days = Number(range.value);
    }
    renderAll();
  };
  const from = $('#stFrom'), to = $('#stTo');
  if (from) from.onchange = () => { state.statsOpts.fromAt = from.value; syncStatsExportButtons(); };
  if (to) to.onchange = () => { state.statsOpts.toAt = to.value; syncStatsExportButtons(); };
  wire('#stBrand', 'brandId');
  // 换了筛选条件，执行人下拉的候选也会变，所以清掉防止选到一个当前范围内不存在的人
  const ub = $('#stUser');
  if (ub) {
    ub.onchange = () => { state.statsOpts.userId = ub.value; syncStatsExportButtons(); };
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
    try {
      await checkedConfigSet({ copy: { defaultBrandId: bsel.value } });
      state.brandId = bsel.value;
      state.config = await appApi.configGet();
      await refreshBrands();
      renderAll();
    } catch (error) { toast(error.message || '品牌选择未保存，请重试', 'err'); bsel.value = state.brandId || ''; }
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTS[el.dataset.act];
    if (fn) {
      try { Promise.resolve(fn(el)).catch(error => toast(error.message || '操作失败，请重试', 'err')); }
      catch (error) { toast(error.message || '操作失败，请重试', 'err'); }
    }
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
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.brandModal) { closeBrandModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.userModal) { closeUserModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.helpModal) { closeHelpModal(); e.preventDefault(); return; }
    if (e.key === 'Escape' && state.modelModal) { closeModelModal(); e.preventDefault(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = Number(e.key);
      // ★ TABS[k] 必须存在：页签 5 已删，Ctrl+5 落到空位的话原来是整页崩（读 undefined.title）
      if (k >= 1 && k <= 9 && TABS[k] && !TABS[k].hidden) { state.tab = k; renderAll(); e.preventDefault(); }
    }
  });

  appApi.onLog(pushLog);
  appApi.onProject(p => { state.project = p; renderBackground(); });
  appApi.onTheme(applyTheme);
  appApi.onMaxChange(m => {
    $('#capMaxIcon').innerHTML = m
      ? '<rect x=".7" y="2.7" width="6.6" height="6.6" rx="1"/><path d="M2.7 2.7h-.7a1.3 1.3 0 0 0-1.3 1.3v.7"/>'
      : '<rect x=".7" y=".7" width="8.6" height="8.6" rx="1"/>';
  });
  appApi.onJobStart(j => {
    state.jobs = state.jobs.filter(x => x.id !== j.id);
    state.jobs.push({ id: j.id, type: j.type, label: j.label || j.type, batch: j.batch || '', progress: null, startedAt: j.startedAt || Date.now() });
    renderBackground();
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
    if (state.tab === 3 || PUBLISH_ROW_TABS.has(state.tab)) refreshBatches();
  });
  appApi.onPublishRow(updatePublishRow);
  appApi.onJobDone(d => {
    state.jobs = state.jobs.filter(x => x.id !== d.id);
    if (!d.ok) toast(d.error || '任务失败', d.cancelled || /已取消/.test(d.error || '') ? '' : 'err');
    renderBackground();
  });

}

async function boot() {
  appApi.onUpdate(s => {
    state.update = s;
    syncUpdateNotice();
    const panel = $('#versionUpdate');
    if (panel) panel.outerHTML = updatePanelHtml();
    const av = $('#appVer');
    if (av) { av.title = s.message; av.textContent = 'v' + (state.info?.version || '1.1.1') + (['available', 'downloaded'].includes(s.status) ? ' · 有更新' : ''); av.classList.toggle('update-available', s.status === 'available' || s.status === 'downloaded'); }
  });
  state.update = await appApi.updateStatus();
  state.info = await appApi.info();
  applyTheme(await appApi.themeGet());
  state.auth = await appApi.authStatus();
  if (state.auth.requireLogin && !state.auth.user) { showGate(state.auth.error || ''); return; }
  if (state.auth.requireLogin) setGateLoading($('#lgGo'), true, '登 录');
  try { await enterApp(); }
  catch (error) {
    showGate('主界面加载失败：' + (error.message || '请重试'));
    setGateLoading($('#lgGo'), false, '登 录');
  }
}

setInterval(() => {
  refreshPublishElapsed();
  refreshRunningElapsed();
  if (PUBLISH_ROW_TABS.has(state.tab) && !document.hidden && Date.now() - deviceScanAt >= 10000) refreshDevices();
}, 1000);

let cloudAuthCheckBusy = false;
setInterval(async () => {
  if (cloudAuthCheckBusy || document.hidden || !state.auth || !state.auth.cloud || state.auth.bootstrapRequired
      || (!state.auth.user && !state.auth.error)) return;
  cloudAuthCheckBusy = true;
  try {
    const before = state.auth;
    const next = await appApi.authStatus();
    if (!before.user && next.user) {
      state.auth = next;
      await enterApp();
      return;
    }
    if (!next.user) {
      state.auth = next;
      if (before.user) {
        state.users = null;
        state.brandsMeta = null;
        showGate(next.error || '云端登录状态已失效，请重新登录');
      }
      return;
    }
    const changed = before.user.role !== next.user.role
      || JSON.stringify(before.user.brands || []) !== JSON.stringify(next.user.brands || [])
      || (!next.offline && before.brandsRevision !== next.brandsRevision);
    state.auth = next;
    if (changed) {
      state.stats = null;
      state.statsTried = false;
      state.statsQueryOpts = null;
      if (state.brandModal) closeBrandModal();
      await refreshBrands();
      await refreshUsers();
      renderAll();
    }
  } catch (_) {
    // Keep the current profile for this transient renderer error; the next 60-second check retries.
  } finally {
    cloudAuthCheckBusy = false;
  }
}, 60000);
boot().catch(error => {
  showGate('连接失败：' + (error.message || '请重试'));
  setGateLoading($('#lgGo'), false, '登 录');
});
