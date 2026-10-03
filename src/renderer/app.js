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
  recoverEdit: null,  // 失败恢复动作编辑框里的文本（null = 没收起来）
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
  // 云端配置弹窗：null=关着；'export' | 'import'。cloudCfg 是导出时从主进程取回的那份（含 url/key）
  cloudModal: null,
  cloudCfg: null,
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
  lexDirty: false     // 界面上改了但还没点「保存」
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
 *   「跟随 Windows 设置」这一档同时取消（只有浅色/深色）。主进程 window.normTheme() 是同一个口径，
 *   老配置里的 'system' 一样按浅色算 —— 否则会出现「界面浅色、窗口底色深色」这种半深半浅。
 * ★ 图标不在这里换：两个图标都在 DOM 里（styles.css 按 html.dark 决定显哪个），
 *   这里只切 class + 同步提示语，就不会出现「图标和实际主题不一致」。
 */
function applyTheme(t) {
  const dark = !!(t && t.shouldUseDarkColors);
  document.documentElement.classList.toggle('dark', dark);
  const b = document.getElementById('themeBtn');
  if (b) {
    b.title = dark ? '当前：深色 —— 点一下切浅色' : '当前：浅色 —— 点一下切深色';
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
}

/* ---------------- 日志 ----------------
 * 日志**只有一份数据**（state.logs），两处显示：最下面的日志栏 + 左侧「运行日志」页。
 * ★ 这两处必须永远一致（用户要求「同步」）⇒ 推送 / 重绘 / 清空 三件事都只走下面这几个函数。
 *   别在别处直接碰 #log 或 #logPaneLines —— 那样迟早变成「一边更新、一边不更新」。
 * ★ 筛选只作用于「运行日志」页，底部日志栏永远是全量（它就是「刚才发生了什么」）。
 */
const LOG_KEEP = 500;      // 内存里留多少条：与主进程 logbus 的环形缓冲 MAX 对齐
const LOG_BAR_MAX = 300;   // 底部日志栏最多渲染多少行（DOM 行数多了会拖慢整页重排）
const LOG_LEVEL_CLS = { ok: 'ok', error: 'er', warn: 'wn', info: 'inf' };
const LOG_LEVEL_TEXT = { info: '信息', ok: '成功', warn: '警告', error: '错误' };

function logCls(level) { return LOG_LEVEL_CLS[level] || 'inf'; }
function logLineHtml(e) {
  return `<span class="t">${hhmm(e.t)}</span><span class="${logCls(e.level)}">${esc(e.msg)}</span>`;
}
function logFilterOn() {
  const f = state.logFilter || {};
  return !!(f.level || String(f.q || '').trim());
}
/** 当前筛选下该出现在「运行日志」页里的那些（无筛选 = 全部） */
function filteredLogs() {
  const f = state.logFilter || { level: '', q: '' };
  const q = String(f.q || '').trim().toLowerCase();
  return (state.logs || []).filter(e => {
    if (f.level && e.level !== f.level) return false;
    if (q && !String(e.msg || '').toLowerCase().includes(q)) return false;
    return true;
  });
}
/** 命中条数文案。★ 筛选时两个数都要写出来 —— 只写「3 条」会让人以为日志丢了 */
function logCountText() {
  const hit = filteredLogs().length;
  const total = (state.logs || []).length;
  return logFilterOn() ? `显示 ${hit} / 共 ${total} 条` : `共 ${total} 条`;
}
/** 一条日志追加到「运行日志」页（只在该页开着时才动 DOM，且要过一遍当前筛选） */
function appendToLogPane(e) {
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
  const box = $('#log');
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
    state.logs.slice(-LOG_BAR_MAX).forEach(e => {
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
/** 侧栏「运行日志」的角标：有错误先报错误数（那才是要去看的信号），否则给总条数 */
function updateLogBadge() {
  const el = document.querySelector('[data-st="10"]');
  if (!el) return;
  const total = (state.logs || []).length;
  const errs = (state.logs || []).filter(e => e.level === 'error').length;
  el.textContent = total ? (errs ? `${errs} 错` : `${total} 条`) : '—';
  el.className = 'st' + (total ? (errs ? ' warn' : ' ok') : '');
}
/** 需要导出给主进程的那些：**当前筛选下来的**，外加上下文（筛选条件 + 缓冲区总数） */
function logExportPayload() {
  return { entries: filteredLogs(), filter: { level: state.logFilter.level, q: state.logFilter.q }, bufferTotal: (state.logs || []).length };
}

/* ---------------- 任务（实例化：同一时间可以有多个批次在跑） ---------------- */
/** 产出可发布内容的任务：必须带品牌归属。名单要和主进程 jobs.js 的 BRAND_SCOPED 保持一致 */
const BRAND_SCOPED_TYPES = new Set(['copy.generate', 'report.import', 'sheet.export', 'publish.run', 'publish.rerun']);

async function runJob(type, args) {
  let res;
  const a = Object.assign({}, args || {});
  // 自动带上标题栏选中的品牌。没选中就不带 —— 让主进程把「为什么不行」讲清楚，
  // 而不是在前端塞一个顶上：归属记错了比报错难查得多
  if (BRAND_SCOPED_TYPES.has(type) && !a.brandId && state.brandId) a.brandId = state.brandId;
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

/**
 * 失败恢复动作（uiMap.recover）：发布失败后要退回干净起点，否则下一条的界面会被残留页面污染。
 * 真机是「回退转发页」「删除卡片」这类动作，每个账号/版本不一样，所以做成可编辑而不是写死。
 */
function recoverHtml() {
  const map = (state.config.publish && state.config.publish.uiMap) || {};
  const steps = map.recover || [];
  if (state.recoverEdit !== null) {
    return `<div style="margin-top:10px">
      <b>失败恢复动作（发布失败后自动执行）</b>
      <textarea class="inp mono" id="recoverBox" spellcheck="false" style="width:100%;height:132px;margin-top:6px;resize:vertical">${esc(state.recoverEdit)}</textarea>
      <div class="row" style="margin-top:6px">
        <button class="btn sm primary" data-act="pub:recoverSave">保存</button>
        <button class="btn sm" data-act="pub:recoverCancel">取消</button>
        <span class="hint">可用 action：<code>tapText</code> / <code>tapId</code> / <code>tapDesc</code>（value 是要点的文字、resource-id、描述）与
          <code>wait</code>（value 是毫秒）。返回键不用写进来 —— 回退时本来就会先按。</span>
      </div>
    </div>`;
  }
  return `<div class="row" style="margin-top:10px">
    <b>失败恢复动作</b>
    <span class="chip">${steps.length ? steps.length + ' 步' : '未配置'}</span>
    <span class="hint" style="margin:0">${steps.length
      ? steps.map(s => `${esc(s.action)}：${esc(String(s.value))}`).join(' → ')
      : '不配也行：失败后只按返回键回退。真机日志里是「已回退转发页」「删除卡片」这类动作。'}</span>
  </div>`;
}

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
        <div class="stat"><b>${n(s.scaled)}</b><span>等比缩放</span></div>
        <div class="stat bad"><b>${n(s.tooSmall)}</b><span>尺寸不足</span></div>
        <div class="stat bad"><b>${n(s.notMp4)}</b><span>非 MP4</span></div>
        <div class="stat bad"><b>${n(s.oversize)}</b><span>超 10MB 压缩</span></div>
        <div class="stat"><b>${n(s.isolate)}</b><span>隔离到 _rejected</span></div>
      </div>
      <p class="hint">规则（对齐真机）：图片<b>必须为 JPG</b>、≥<b>${cfg0.minPixels}</b> 像素²（约 42×42）、边长 <b>${cfg0.minSide}~${cfg0.maxSide}</b>${cfg0.autoScale ? '（超限自动等比缩放）' : ''}、≤${cfg0.maxImageMB}MB；视频<b>必须 .mp4</b>（<code>.mov</code>/<code>.m4v</code> 等会自动转成 mp4）且 &lt;${cfg0.maxVideoSec} 秒（超时只标红不裁剪）。</p>
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

TABS[3] = {
  title: '文案生成',
  desc: '看图写标题正文 · 话题组合去重 · 跑完落一份带时间戳的 AI 内容报告',
  actions: () => [
    { act: 'copy:prompt', label: '提示词配置' },
    { act: 'copy:pickRun', label: '选择素材目录并启动任务', primary: true },
    { act: 'copy:run', label: '按当前素材生成' }
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
        <p class="hint"><b>必带话题可以写多个</b>：用 <b>空格</b> 或 <b>逗号</b>（中英文都行，顿号 / 分号 / 竖线也可以）隔开，如
          <code>#品牌话题, #品类词</code>。每条笔记都会带上它们、并固定排在话题最前面；漏写 <code>#</code> 会自动补上。
          发布单只有 <b>话题1~话题5</b> 五个格子 —— 「必带个数 + 额外话题」超过 5 时，多出来的会<b>少带并明确告警</b>（不会默默丢掉）。
          <br><b>额外话题从哪来</b>：优先抓<b>品牌提示词里写的 <code>#话题</code></b>（就是提示词里那段「话题列表」），
          品牌提示词里没有 <code>#</code> 话题才退回内置的通用词 —— 所以想让每条笔记都带上你们家的话题，
          直接在品牌提示词的「话题列表」里写就行，不用在这里再抄一遍。</p>
        <p class="hint"><b>正文写成 4~5 行短句</b>：一行一句（8~16 字），按「卖点 → 氛围感 → 上身体验 → 搭配」铺开，
          行尾少量 emoji（全篇 1~3 个）。<b>行与行之间是真的换行</b>，发到得物就是分行的样子；写成一大段会被「文案核对」列点出来。
          话题走发布单的「话题1~5」独立格子，所以正文结尾不带 <code>#</code> —— 得物渲染出来的位置一样，
          但只有格子里的话题才点得动。</p>
        <p class="hint"><b>重复口径</b>：只看<b>相邻两条</b> —— 标题或正文与<b>上一条完全一样</b>（含 emoji）才会提醒；
          换个 emoji、换个词就算不同；隔开几条再撞句、或换个品牌复用同一句，都没关系。</p>
        ${running('copy.generate') ? progHtml(progFor('copy.generate')) : ''}
        <p class="hint"><b>标题是看图写的</b>：每条素材把前几张实拍图缩到 768px 发给模型，标题里的品类 / 款式特征 / 颜色
          都来自图里真实看到的（如「雨伞熊高领毛衣灰色慵懒风🧸」），<b>不是拿货号颜色套模板</b>。
          模型连不上时会<b>直接停下来报错</b>，不会拿本地模板冒充 AI 文案；要先确认接口就点「设置 → 高级设置 → 文案模型 → 接口自检」。
          （<b>并发路数</b>是「同时发几路请求」的旋钮，不是内容参数 —— 已收进「高级设置」，出厂 6 路，一般不用动。）</p>
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
      ${planRows.length ? `<div class="tw"><table>
        <thead><tr><th>叶子目录</th><th>货号</th><th>颜色</th><th>叙事视角</th><th>话题组合</th><th>标题</th><th>生成来源</th><th>状态</th></tr></thead>
        <tbody>${planRows.slice(0, 40).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.sku || '')}</td><td>${esc(r.color || '')}</td>
          <td>${r.angle ? esc(r.angle) : '—'}</td>
          <td class="cut">${(r.topics || []).length ? esc(r.topics.join(' ')) : '—'}</td>
          <td class="cut" title="${esc(r.title || '')}">${esc(r.title || '—')}</td>
          <td class="cut">${r.genSource
            ? badge(r.genSource, r.genSource === '本地模板' || r.genSource === '未生成' ? '需人工处理' : '完成')
            : '—'}</td>
          <td>${badge(r.status || '待生成', kindOf(r.status || '待生成'))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有素材，先做「素材整理」。</div>`}`;
  }
};

TABS[4] = {
  title: '货号颜色校验',
  desc: '比对得物商品池 · 多颜色货号必须填对应颜色 · 附图片取色反查',
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

TABS[5] = {
  title: '发布单',
  desc: '26 列 · 运营确认后交发布端',
  actions: () => [
    { act: 'sheet:importReport', label: '导入 AI 内容报告' },
    { act: 'sheet:open', label: '打开文件', disabled: !state.project.sheet.file },
    { act: 'sheet:dir', label: '打开目录' },
    { act: 'sheet:export', label: '导出 xlsx', primary: true }
  ],
  render() {
    const sh = state.project.sheet || {};
    const rows = (state.project.publish && state.project.publish.rows) || [];
    const preview = rows.slice(0, 12);
    return `
      <div class="box">
        <div class="row">
          <input class="inp mono" value="${esc(sh.file || '（尚未导出）')}" readonly>
          <span class="chip">${sh.rowCount || 0} 行 · ${sh.colCount || 26} 列</span>
          <span class="chip">${sh.locked ? '被占用' : '未占用'}</span>
        </div>
      </div>
      ${reportBoxHtml()}
      ${preview.length ? `<div class="tw"><table>
        <thead><tr><th>#</th><th>期待发布时间</th><th>素材路径</th><th>标题</th><th>好物1</th><th>执行结果</th></tr></thead>
        <tbody>${preview.map(r => `<tr class="${r.result === '校验未通过' ? 'flag' : ''}">
          <td class="num">${r.seq}</td><td>${esc(r.expect || '')}</td><td class="mono">${esc(r.dir)}</td>
          <td class="cut">${esc(r.title || '')}</td><td class="mono">${esc(r.goods1 || '')}</td>
          <td>${badge(r.result || '待发布', kindOf(r.result || '待发布'))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">还没有发布单。先做文案生成与校验，再点「导出 xlsx」。</div>`}
      <p class="hint">发布过程<b>不占用发布单文件</b>：任务读进内存后立即释放 → 结果追加写 <code>publish-log.jsonl</code> → 一批结束再一次性合并回写 Excel。</p>`;
  }
};

TABS[6] = {
  title: '模拟器发布',
  desc: '导入 AI 内容报告 → 选发布间隔 → 开始发布（ADB 驱动得物 App · 失败可单独重跑）',
  actions: () => [
    // ★ 2026-10-03 用户给的流程：「从模拟器发布的入口导入，选择发布间隔时间，点击开始发布」
    //   ⇒ 导入入口放到这一页（「发布单」页那个还在，两处都能进，导入的是同一份东西）
    { act: 'sheet:importReport', label: '导入 AI 内容报告' },
    { act: 'pub:connect', label: '连接模拟器' },
    { act: 'pub:exportLog', label: '重导出日志' },
    { act: 'pub:stop', label: '停止', disabled: !running('publish.run') && !running('publish.rerun') },
    { act: 'pub:run', label: '开始发布', primary: true, disabled: !(state.project.publish && state.project.publish.rows && state.project.publish.rows.length) }
  ],
  render() {
    const cfg = state.config.publish;
    const pub = state.project.publish || {};
    const mode = pub.mode || 'mock';
    const rows = pub.rows || [];
    // 与主进程 publisher.estimate 同一口径：图文「间隔+30s」、视频「间隔+60s」（视频推得久，还要等媒体库索引）
    const est = Math.round(rows.reduce((a, r) => {
      const isV = r.kind === 'video';
      // ★ 与主进程 publisher.estimate 同一口径（原先这里取的是 intervalMin/MaxSec 的平均，
      //   而真跑的是 intervalSec —— 两个数不一样，界面上的「预计」会偏）。
      const iv = cfg.intervalSec || cfg.intervalMinSec || 60;
      const gap = isV ? (cfg.videoIntervalSec || Math.round(iv * 1.5)) : iv;
      return a + gap + (isV ? 60 : 30);
    }, 0) / 60);
    const okCount = rows.filter(r => r.result === '发布成功').length;
    return `
      <div class="box">
        <h3>装置与节奏</h3>
        ${devicesHtml()}
        <div class="row" style="margin-top:10px">
          <span class="lbl">发布间隔</span>
          <select class="inp" data-cfg="publish.intervalSec">
            ${[30, 60, 90, 120].map(v => `<option value="${v}" ${Number(cfg.intervalSec || 60) === v ? 'selected' : ''}>固定 ${v} 秒</option>`).join('')}
          </select>
          <span class="lbl">失败重试</span>
          <select class="inp" data-cfg="publish.retry">${[0, 1, 2, 3].map(v => `<option value="${v}" ${cfg.retry === v ? 'selected' : ''}>${v} 次</option>`).join('')}</select>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-act="pub:probe">检查能不能发布</button>
          ${((cfg.uiMap || {}).steps ? '' : (canAdmin() ? '<button class="btn sm" data-act="go:advanced">去「高级设置」配 UI 定位表</button>' : ''))}
          <span class="chip">${mode === 'adb' ? '真实设备通道' : '模拟通道'}</span>
          <span class="chip ${(state.config.publish.uiMap || {}).steps ? '' : 'warn'}">${(state.config.publish.uiMap || {}).steps ? '定位表 ' + state.config.publish.uiMap.steps.length + ' 步' : '定位表未配'}</span>
          ${(() => { const m = state.config.publish.uiMap || {}; if (!m.steps) return ''; const vn = (m.videoSteps || []).length; return vn ? `<span class="chip">视频 ${vn} 步</span>` : '<span class="chip">视频复用图文</span>'; })()}
          <span class="chip">批次 ${esc(pub.batch || '（导出发布单后自动命名）')}</span>
        </div>
        ${running('publish.run') || running('publish.rerun') ? progHtml(progFor(running('publish.run') ? 'publish.run' : 'publish.rerun')) : ''}
        <p class="hint">预计 <b>${est} 分钟</b>：单条技术下限 ≈30 秒（视频 ≈60 秒，还要等媒体库索引）+ 人为间隔 —— <b>93% 的时间是在等间隔</b>，不是性能问题。缩短间隔要你自己拍板，默认值按实测给的是 60–120 秒（视频默认 90 秒）。</p>
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
        : `<div class="empty">还没有发布队列，先到「发布单」导出 xlsx。</div>`}
      <p class="hint">★ <b>颜色校验不是必需项</b>：没做过校验、或目录里的颜色与商品池对不上，<b>都不会拦住发布</b> ——
      发布时按你填的<b>货号</b>在「关联好物」里搜出结果，<b>默认选第一件商品</b>发出去（这条做法已实测可行）。
      要精确到某个颜色，就到「货号颜色校验」页把颜色核对准。要让机器真按这条做，需要在 UI 定位表里、
      「搜索货号」后面补一步「点第一件商品」（「设置 → 高级设置 → 抓取页面结构」生成的候选表里改）。</p>
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

TABS[7] = {
  title: '设置',
  desc: '路径、内容校验、应用更新、外部依赖（文案模型 / SKU 接口 / adb 与 ffmpeg 路径已挪进「高级设置」；主题切换在最上面标题栏）',
  actions: () => [{ act: 'cfg:save', label: '保存', primary: true }],
  render() {
    const c = state.config;
    const info = state.info || {};
    const dep = [
      ['图片处理 / 取色', info.engine === 'sharp' ? 'sharp + libvips（含 HEIC）' : 'jpeg-js + pngjs（纯 JS 降级）', info.engine === 'sharp' ? ['ok', '内置'] : ['warn', '降级']],
      ['HEIC 解码', info.hasHeif ? 'libheif（sharp 预编译）' : '未内置，HEIC 需人工处理', info.hasHeif ? ['ok', '可用'] : ['warn', '不可用']],
      ['发布单读写', 'exceljs', ['ok', '内置']],
      ['视频时长读取', '纯 JS MP4/MOV 解析（moov → mvhd）', ['ok', '内置']],
      ['视频转 MP4（得物只收 mp4）', ffDesc(info.ffmpeg), ffBadge(info.ffmpeg)],
      ['模拟器驱动 adb',
        (info.vendor && info.vendor.exists) ? '程序内置（装完即用，不用自己找）' : '没内置：要自己指定 adb.exe 的路径',
        (info.vendor && info.vendor.exists) ? ['ok', '内置'] : ['warn', '需指定']],
      ['中文输入法 ADBKeyboard',
        (info.vendor && info.vendor.apkExists)
          ? '程序内置（首次要在「模拟器发布」页点一次「一键装上中文输入法」把它装进模拟器并启用）'
          : '没内置：要自己给设备装',
        (info.vendor && info.vendor.apkExists) ? ['ok', '内置'] : ['warn', '缺']],
      ['得物商品池', info.pool ? `${info.pool.size} 个货号 · ${info.pool.source}` : '—', info.pool && info.pool.size ? ['ok', '已导入'] : ['warn', '待同步']]
    ];
    return `
      <div class="box">
        <h3>路径</h3>
        <div class="row" style="margin-bottom:9px"><span class="lbl">输出目录</span><input class="inp mono" value="${esc(c.paths.output)}" readonly><button class="btn sm" data-act="cfg:path" data-key="paths.output">修改</button></div>
        <div class="row"><span class="lbl">隔离目录</span><input class="inp mono" value="${esc(c.paths.rejected)}" readonly><button class="btn sm" data-act="cfg:path" data-key="paths.rejected">修改</button></div>
      </div>
      <!-- ★ 原先这里有一整块「外观」（主题说明 + 运行环境）—— 2026-10-03 按用户要求撤掉：
           主题入口只留顶栏那一个，设置里再复述一遍纯属重复（两处状态迟早各说各话）；
           「运行环境」那行没丢，挪到下面「外部依赖」里了。 -->
      ${updateHtml()}
      <div class="box">
        <h3>外部依赖</h3>
        <div class="tw"><table>
          <thead><tr><th>用途</th><th>依赖</th><th>状态</th></tr></thead>
          <tbody>${dep.map(([a, b, s]) => `<tr><td>${esc(a)}</td><td class="mono">${esc(b)}</td><td>${badge(s[1], s[0])}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="row"><span class="lbl">运行环境</span>
          <span class="chip">${info.isWin ? 'Windows' : esc(info.platform)} · Electron ${esc(info.electron || '')}</span>
        </div>
        <p class="hint">配置与工程数据存在 <code>${esc(info.userData || '')}</code>，卸载时保留。
          要手填外部工具的路径（adb / ffmpeg）去「<b>高级设置</b>」页 —— 那两个都是装完即用，正常不用填。</p>
      </div>
      <p class="hint">品牌、账号、以及「谁能用哪些品牌」原先挤在这一页最下面 —— 已经挪到左侧的「<b>品牌与权限</b>」页。</p>`;
  }
};

/* ---------------- 页签 11：高级设置（仅管理员可见） ----------------
 * ★ 为什么单开一页：这里全是「装一次、之后再也不动」的配置 —— UI 定位表、失败恢复动作、
 *   文案模型、货号颜色接口、adb 与 ffmpeg 路径。把它们平铺在日常页面上只是干扰
 *   （用户原话：「为什么放了这么多实际根本不会点击使用的功能」）。
 * ★ 但**不许删**：真实通道必须先有 UI 定位表（publisher.run 会直接 throw），
 *   中文输入法不装则中文一个字都发不出去 —— 它们只是「不常点」，不是「没用」。
 * ★ 仅管理员可见：藏起来只是不给人添乱，真正拦住的是主进程那几道 guard。
 */
TABS[11] = {
  title: '高级设置',
  admin: true,
  desc: '装一次就不再动的配置：UI 定位表、失败恢复动作、文案模型、并发路数、货号颜色接口、adb / ffmpeg 路径（仅管理员可见）',
  actions: () => [{ act: 'cfg:save', label: '保存', primary: true }],
  render() {
    const c = state.config;
    const info = state.info || {};
    const pub = c.publish || {};
    const cl = c.cloud || {};      // 老配置里没有这一项：取不到就当空，别让整页渲染挂掉
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
      <div class="box">
        <h3>失败恢复动作</h3>
        ${recoverHtml()}
        ${state.recoverEdit === null ? '<div class="row" style="margin-top:6px"><button class="btn sm" data-act="pub:recoverEdit">编辑恢复动作</button></div>' : ''}
      </div>
      ${advBox('文案模型', false,
        `<div class="row" style="margin-bottom:9px">
          <span class="lbl">启用</span>
          <select class="inp" data-cfg="copy.llm.enabled"><option value="true" ${c.copy.llm.enabled ? 'selected' : ''}>调用模型（看图写）</option><option value="false" ${!c.copy.llm.enabled ? 'selected' : ''}>本地模板（离线）</option></select>
          <span class="lbl">看图</span>
          <select class="inp" data-cfg="copy.llm.vision"><option value="true" ${c.copy.llm.vision !== false ? 'selected' : ''}>送实拍图</option><option value="false" ${c.copy.llm.vision === false ? 'selected' : ''}>不送图</option></select>
          <button class="btn sm" data-act="copy:llmtest">接口自检</button>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">接口地址</span><input class="inp mono" value="${esc(c.copy.llm.endpoint)}" data-cfg="copy.llm.endpoint" placeholder="留空 = 跟随内置"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">API Key</span><input class="inp mono" type="password" value="${esc(c.copy.llm.apiKey)}" data-cfg="copy.llm.apiKey"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">模型</span><input class="inp mono" value="${esc(c.copy.llm.model)}" data-cfg="copy.llm.model" placeholder="留空 = 跟随内置"></div>
        <div class="row">
          <span class="lbl">每条送图</span>
          <select class="inp" data-cfg="copy.llm.imageCount">${[1, 2, 3, 4].map(v => `<option value="${v}" ${Number(c.copy.llm.imageCount) === v ? 'selected' : ''}>${v} 张</option>`).join('')}</select>
          <span class="lbl">单边缩到</span>
          <select class="inp" data-cfg="copy.llm.imageMaxSide">${[512, 768, 1024, 1568].map(v => `<option value="${v}" ${Number(c.copy.llm.imageMaxSide) === v ? 'selected' : ''}>${v}px</option>`).join('')}</select>
        </div>
        <p class="hint"><b>留空 = 跟随内置</b>（地址与模型 id 都随包内置，换服务商发新包就行）—— 这一条只在你<b>填了</b>的时候才覆盖内置值。
          <b>标题是看图写的</b>：每条素材把前几张实拍图缩到上面那个尺寸发给模型，标题里的品类 / 款式特征 / 颜色都来自图里真实看到的，
          不是拿货号颜色套模板。★ 模型连不上时<b>会直接停下来报错</b>，不会拿本地模板冒充 AI 文案
          （要用模板就选「本地模板（离线）」，那时报告里会逐行标出「本地模板」）。</p>`,
        '默认关闭 · 离线模板就够用')}
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
          优先<b>无损转封装</b>（秒级、画质零损失），转封装放不下（如 ProRes）才转码成 H.264/AAC，转完会校验产物确实是 mp4。</p>
        <p class="hint">配置与工程数据存在 <code>${esc(info.userData || '')}</code>，卸载时保留。</p>`,
        '内置即用 · 没特殊情况不要动')}
      ${advBox('云端协作（可选 · 默认关）', false,
        `<div class="row" style="margin-bottom:9px">
          <span class="lbl">启用</span>
          <select class="inp" data-cfg="cloud.enabled">
            <option value="true" ${cl.enabled ? 'selected' : ''}>开启（把本机新增的发布结果推到云端）</option>
            <option value="false" ${!cl.enabled ? 'selected' : ''}>关闭（数据不出本机）</option>
          </select>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">项目地址</span><input class="inp mono" value="${esc(cl.url || '')}" data-cfg="cloud.url" placeholder="留空 = 跟随内置（见下方「实际在用」）"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">anon key</span><input class="inp mono" type="password" value="${esc(cl.anonKey || '')}" data-cfg="cloud.anonKey" placeholder="留空 = 跟随内置；只填 anon public key"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">本机名称</span><input class="inp mono" value="${esc(cl.machineName || '')}" data-cfg="cloud.machineName" placeholder="留空 = 用电脑名（看板上用来区分是谁在发）"></div>
        <div class="row">
          <span class="lbl">推送间隔</span>
          <select class="inp" data-cfg="cloud.intervalSec">${[30, 60, 120, 300].map(v => `<option value="${v}" ${Number(cl.intervalSec || 30) === v ? 'selected' : ''}>${v} 秒</option>`).join('')}</select>
          <button class="btn sm" data-act="cloud:test">测试连接</button>
          <button class="btn sm primary" data-act="cloud:sync">立即同步</button>
        </div>
        <div class="row"><span class="lbl">下发配置</span>
          <button class="btn sm" data-act="cloud:exp">导出配置</button>
          <button class="btn sm" data-act="cloud:imp">导入配置</button>
          <span class="hint">换项目、或给不方便重打包的机器下发凭据时用</span>
        </div>
        <div id="cloudEff" class="hint">读取中…</div>
        <div id="cloudState" class="hint">读取中…</div>
        <p class="hint"><b>上面两个框留空 = 跟随内置</b>（组织统一配置，已打进包里）：装完就能连，各台机器<b>不用填任何东西</b>，
          机器名默认用电脑名。★ 留空的状态下换项目<b>只要发新包</b>——各台一升级就自动跟随新地址
          （留空不会被写进本机配置，所以新包的内置值顶得住）。</p>
        <p class="hint">只有要把<b>这一台</b>单独指到别的库（或临时调试）时，才往那两个框里填 —— 填了以填的为准，
          且<b>只影响这一台</b>；想撤回就把框清空（又回到跟随内置）。做<b>组织级</b>的整体切换请走「发新包」，
          别逐台手填：各台指向不同项目时，看板上会「少一个人」而且不报错。</p>
        <p class="hint"><b>只上行「发布结果」这一张表</b>：时间 / 机器 / 执行人 / 品牌 / 批次 / 篇号 / 成功或失败 / 原因 / 耗时。
          <b>素材内容、绝对路径、日志原文一概不上行</b>（目录只取最后一段款名）。关着的时候<b>一次都不联网</b>。</p>
        <p class="hint">★ 这里只能填 <b>anon public key</b>（它本来就是设计成公开的，靠数据库的 RLS 策略收口）。
          <b>绝不要把 service_role key 填进来</b> —— 那个 key 能绕过策略读写整张表，泄了等于裸奔。</p>
        <p class="hint">★ 同步失败<b>不影响本机发布</b>：结果早就在本机 <code>publish-log.jsonl</code> 里落盘了，
          云上少几条只是看板不全，最多界面上如实标「同步失败」。发布核心也<b>不依赖</b>这个开关。</p>`,
        '只上行结果 · 不参与发布')}
      <p class="hint">这一页只有管理员看得到。日常操作在「模拟器发布」「设置」两页；
        <b>中文输入法</b>不在这里 —— 它按需出现在「检查能不能发布」的结果里（没装才会冒出来）。</p>`;
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
 * 云端同步状态（高级设置页那一块）。
 * ★ 取不到就如实说「取不到」，不许显示成一个看起来正常的 0 —— 那是假信息。
 * ★ 异步返回时页面可能已被重画过（renderAll 会整个换掉 #pane），所以填之前重新查一次元素。
 */
function cloudStateHtml(s) {
  if (!s) return `${badge('取不到', 'warn')} 云端状态读不出来（接口没连上）`;
  if (!s.enabled) return `${badge('未启用', 'wait')} 关着的时候一次都不联网，台账只留在本机。`;
  if (!s.configured) return `${badge('未配置', 'warn')} 还没填项目地址或 anon key —— 填完点「测试连接」。`;
  const bits = [
    `已上行 ${s.uploaded} 条`,
    `待上行 ${s.pending} 条`,
    s.lastSyncAt ? `上次同步 ${fmtDate(s.lastSyncAt)}` : '还没同步过',
    `本机 ${esc(s.machineName || s.machineId || '未命名')}`
  ];
  if (s.reset) bits.push(`游标已重置：${esc(s.reset)}`);
  if (s.lastError) bits.push(`上次失败：${esc(s.lastError)}`);
  return `${badge(s.lastError ? '同步失败' : '已连接', s.lastError ? 'bad' : 'ok')} ${bits.join(' · ')}`;
}

/**
 * 云端配置弹窗（导出 / 导入）。
 * ★ 跟品牌弹窗一个套路：挂在 .app 外面（塞进 #pane 会被 overflow 裁掉，底部按钮点不到），
 *   而且 renderAll 会被进度事件频繁触发 —— 挂在 #pane 里的话，正在粘贴的内容会被重画没。
 */
function openCloudModal(view) { state.cloudModal = view || 'export'; renderCloudModal(); }
function closeCloudModal() { state.cloudModal = null; renderCloudModal(); }

function renderCloudModal() {
  const mask = $('#cmodal'), box = $('#cmBox');
  if (!mask || !box) return;
  const v = state.cloudModal;
  if (!v) { mask.hidden = true; box.innerHTML = ''; return; }
  mask.hidden = false;
  if (v === 'export') {
    const c = state.cloudCfg || {};
    box.innerHTML = `
      <h3>导出云端配置</h3>
      <p class="hint">把这段发给别的机器：在那台机器的「导入配置」里粘进去就行，不用手填三个框。
        里面是 <b>anon key</b>（公开设计，靠数据库策略收口），<b>不是</b> service_role。</p>
      <p class="hint">★ 但如果对方那台是<b>「跟随内置」</b>（绝大多数情况），<b>不需要发这个</b>：
        发新包、让它升级一次就会自动跟随新地址，比粘配置更干净。粘了反而会把地址写死在那台机器上
        （日后换项目它就不跟着走了，界面上还看不出区别）。只有对方<b>升不了级</b>时才用这段。</p>
      <textarea id="cmText" rows="7" style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:7px">${esc(JSON.stringify({ url: c.url || '', anonKey: c.anonKey || '', org: c.org || '' }, null, 2))}</textarea>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="btn sm" data-act="cloud:close">关闭</button>
        <button class="btn sm primary" data-act="cloud:copy">复制</button>
      </div>`;
  } else {
    box.innerHTML = `
      <h3>导入云端配置</h3>
      <p class="hint">把别人给你的那段 JSON 粘进来。会先校验格式、再连一次确认能用，没问题才保存 ——
        粘错地址会让所有机器一起失联，而界面上只显示「同步失败」四个字。</p>
      <textarea id="cmText" rows="7" style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:8px;border:1px solid var(--line);border-radius:7px" placeholder='{"url":"https://xxxx.supabase.co","anonKey":"...","org":"bluev"}'></textarea>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button class="btn sm" data-act="cloud:close">取消</button>
        <button class="btn sm primary" data-act="cloud:impGo">导入并连接</button>
      </div>`;
  }
}

async function refreshCloudState() {
  if (!document.querySelector('#cloudState')) return;    // 只有高级设置页有这块
  let s = null;
  try { s = await appApi.cloudStatus(); } catch (e) { s = null; }
  state.cloud = s;
  const el = document.querySelector('#cloudState');
  if (el) el.innerHTML = cloudStateHtml(s);
  // ★★ 「当前实际在用哪个地址」必须**无条件**显示，且用主进程报上来的真值。
  //    这是删掉 applyCloudDefaults 之后，替代「把值写进配置」的那条不变量：
  //    界面显示的是真值，就不存在「框里空着、后台照推另一个地址」这种骗人。
  const eff = document.querySelector('#cloudEff');
  if (eff) eff.innerHTML = cloudEffHtml(s);
}

/**
 * 「实际在用」那一行。
 * ★ 无条件渲染（未启用 / 未配置也要说清楚在用什么），因为它是「留空＝跟随内置」
 *   这个语义**唯一的可见出口** —— 理由见 cloudStateHtml 上方与 src/main/store.js 的长注释。
 */
function cloudEffHtml(s) {
  if (!s || !s.url) return `${badge('读不到', 'warn')} 实际在用的云端地址读不出来（接口没连上）`;
  const how = s.urlSource === 'custom'
    ? '本机指定（只影响这一台）'
    : '跟随内置（换项目＝发新包，各台升级后自动跟随）';
  return `${badge(s.urlSource === 'custom' ? '本机指定' : '跟随内置', 'wait')} 当前实际在用：<code>${esc(s.url)}</code> · 来源：${esc(how)}`;
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
 *   「收尾」组这一版**锁定**（用户拍板：先不放开）；T01~T10 **句式骨架一律不可编辑** ——
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
          并按行轮换 10 种<b>句式骨架</b>（T01~T10）。所以<b>你在这里改的词，下一次生成就会用上，不用重启</b>。</p>
        <p class="hint">★ 例外：<b>关掉模型 / 离线</b>时走的是程序自带的本地模板（F01~F10），
          那条路<b>本来就不读词库</b> —— 那种情况下改了也不会变，别当成「没生效」。</p>
      </div>
      <div class="box">
        <h3>三条红线（进不去的词会当场告诉你原因）</h3>
        <p class="hint">${L.redlines.map(s => '· ' + esc(s)).join('<br>')}</p>
      </div>
      ${editables.map(lexGroupHtml).join('')}
      ${lockeds.map(g => `<div class="box lxlock">
        <h3>${esc(g.key)}（${g.words.length} 词）· 已锁定，不可编辑</h3>
        <div class="lxwords">${g.words.map(w => `<span class="chip lxw">${esc(w)}</span>`).join('')}</div>
        <p class="hint">「收尾」组这一版<b>锁定</b>（你要求先不放开）。它<b>照样参与生成</b>（词照给模型），
          只是不给编辑。要放开跟我说一声就行。</p>
      </div>`).join('')}
      <div class="box">
        <h3>10 种句式骨架（T01~T10）· 不可编辑</h3>
        <div class="tw"><table>
          <thead><tr><th>编号</th><th>名称</th><th>结构</th><th>形状示例</th></tr></thead>
          <tbody>${L.styles.map(s => `<tr><td class="mono">${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.formula)}</td><td class="mono">${esc(s.sample)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">骨架是<b>语法</b>（连接字在第几位、收尾在末尾）—— 改坏会直接产出病句 / 标签串，
          而判据只能事后告警、拦不住，所以锁死在程序里。上面那些<b>词</b>才是你可以随便换的。</p>
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
  const fresh = (found || []).filter(f => !f.configured);
  const freshBox = fresh.length ? `
    <div style="margin-top:10px">
      <div class="hint" style="margin:0 0 6px">adb 现在认到这些设备（还没加进来）：</div>
      <div class="tw"><table>
        <thead><tr><th>序列号</th><th>状态</th><th></th></tr></thead>
        <tbody>${fresh.map(f => `<tr>
          <td class="mono">${esc(f.serial)}</td>
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
  const errs = (state.logs || []).filter(e => e.level === 'error').length;
  const warns = (state.logs || []).filter(e => e.level === 'warn').length;
  const ex = state.logExport;
  return `
  <div class="box">
    <h3>运行日志</h3>
    <div class="row">
      <span class="chip" id="logPaneCount">${logCountText()}</span>
      ${errs ? `<span class="chip warn">${errs} 条错误</span>` : ''}
      ${warns ? `<span class="chip">${warns} 条警告</span>` : ''}
      <span class="hint" style="margin:0">与最下面的日志栏是同一份内容；这里筛完了再导出，导出的就是屏幕上这些。</span>
    </div>
    <div class="row" style="margin-top:9px">
      <select class="inp" id="logLv">${opts}</select>
      <input class="inp" id="logQ" style="flex:1;min-width:180px" placeholder="按关键字筛（标题 / 批次 / 文件路径…）" value="${esc(f.q)}" spellcheck="false">
      <button class="btn sm" data-act="log:clear"${(state.logs || []).length ? '' : ' disabled'}>清空日志</button>
      <button class="btn sm primary" data-act="log:export"${(state.logs || []).length ? '' : ' disabled'}>导出日志</button>
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
    { act: 'log:clear', label: '清空', disabled: !(state.logs || []).length },
    { act: 'log:export', label: '导出日志', primary: true, disabled: !(state.logs || []).length }
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
function renderAll() {
  syncAdminNav();   // 高级设置是管理员专属：先按权限把页签与当前页签都对齐，再渲染
  const t = TABS[state.tab];
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('on', Number(el.dataset.tab) === state.tab));
  $('#head').innerHTML = `<div><h2>${esc(t.title)}</h2><p>${esc(t.desc)}</p></div>
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
  // 云端状态是异步取的：只有高级设置页有那块，渲染完再填进去（不阻塞整页渲染）
  if (state.tab === 11) refreshCloudState();
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
 * 管理员专属页签（现在只有「高级设置」）：非管理员整个按钮都不显示。
 * ★ 这只是「不给人添乱」—— 真正拦住的是主进程那几道 guard。但这条不能省：
 *   否则普通成员能点进一个自己改不动、也不该动的页面，只会一头雾水。
 * 顺带把「当前正停在一个自己已经看不到的页签上」拉回来（退出登录 / 换账号时会遇到）。
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
    ? { id: '', name: '', enabled: true, promptWrite: '', promptFilter: '' }
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
        <textarea class="mta" id="bmWrite" placeholder="写清这个品牌的口吻、面向谁、要写什么、别写什么……">${esc(b.promptWrite)}</textarea>
      </label>
      <p class="mnote">这段是「文案生成」发给模型的角色设定。<b>输出格式</b>（JSON 字段名、标题字数上限）由程序另外追加，不用写在这儿。</p>

      <label class="mfld" style="margin-top:13px"><span>筛选排序提示词</span>
        <textarea class="mta" id="bmFilter" placeholder="留空即可">${esc(b.promptFilter)}</textarea>
      </label>
      <p class="mnote warn">「筛选排序提示词」这个版本<b>还没接进任何流程</b>（工具里没有素材筛选/排序这一步），先存着 —— 接上后按品牌生效。它现在不产生任何作用，别以为配了就有效果。</p>

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
  // ★ 顶栏那个主题按钮（浅色 ⇄ 深色）。落盘在主进程做，这样下次启动还是这个。
  'theme:toggle': async () => {
    const dark = await appApi.themeToggle();
    applyTheme({ shouldUseDarkColors: !!dark });
  },

  // ---- 云端协作：推一次 / 试一下 / 下发配置。发布本身不依赖这里的任何一个 ----
  'cloud:exp': async () => {
    const r = await appApi.cloudExport().catch(() => null);
    if (!r || !r.ok) { toast('取不到云端配置', 'err'); return; }
    state.cloudCfg = r;
    openCloudModal('export');
  },
  'cloud:imp': () => openCloudModal('import'),
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
  'cloud:close': () => closeCloudModal(),
  'cloud:copy': async () => {
    const t = document.querySelector('#cmText');
    if (!t) return;
    try { await navigator.clipboard.writeText(t.value); toast('已复制，发给对方粘进「导入配置」就行', 'ok'); }
    catch (e) { t.select(); toast('自动复制被拦下了：已选中，请按 Ctrl+C', 'err'); }
  },
  'cloud:impGo': async () => {
    const t = document.querySelector('#cmText');
    const raw = (t && t.value || '').trim();
    if (!raw) { toast('先粘贴一段配置', 'err'); return; }
    let cfg = null;
    try { cfg = JSON.parse(raw); } catch (e) { toast('这不是合法的 JSON：粘的时候可能少了开头或结尾', 'err'); return; }
    const r = await appApi.cloudImport(cfg).catch(e2 => ({ ok: false, error: String((e2 && e2.message) || e2) }));
    if (r && r.ok) {
      toast('已导入并连上：' + (r.org ? `组织「${r.org}」` : '新地址'), 'ok');
      closeCloudModal();
      state.config = await appApi.configGet();
      renderAll();
    } else {
      toast('导入没成：' + ((r && r.error) || '取不到原因'), 'err');
    }
  },
  'cloud:test': async () => {
    const r = await appApi.cloudTest().catch(e => ({ ok: false, error: String((e && e.message) || e) }));
    toast(r && r.ok ? '连上了：地址和 key 都能用' : `连不上：${(r && r.error) || '取不到原因'}`, r && r.ok ? 'ok' : 'err');
    await refreshCloudState();
  },
  'cloud:sync': async () => {
    const r = await appApi.cloudSync().catch(e => ({ ok: false, error: String((e && e.message) || e) }));
    if (r && r.ok) {
      const left = Number(r.pending) || 0;
      toast(`已推送 ${r.uploaded} 条${left ? `，还剩 ${left} 条（下一轮接着推）` : '，全部推完了'}`, 'ok');
    } else {
      toast(`同步没成：${(r && (r.error || r.skipped)) || '取不到原因'}`, 'err');
    }
    await refreshCloudState();
  },
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

  'copy:run': async () => {
    const r = await runJob('copy.generate');
    if (r.ok) await afterCopy(r);
  },
  'copy:pickRun': async () => {
    const d = await appApi.pickDir({ title: '选择素材目录（一个目录 = 一个批次，可同时跑多个）', defaultPath: state.project.sourceDir || '' });
    if (!d) return;
    const name = d.split(/[\\/]/).filter(Boolean).pop() || '批次';
    const batchId = `${name}_${batchStamp()}`;
    const r = await runJob('copy.generate', { sourceDir: d, batchId, label: batchId });
    if (r.ok) await afterCopy(r);
  },
  // 「接口自检」：一次网络往返，把「地址通不通 / 模型名接口认不认 / 这个模型收不收图」说清楚。
  // ★ 这些事以前只有跑生成时才暴露，而失败还被静默吞成「本地模板」⇒ 用户只看到模板货，
  //   看不到「其实是接口没连上」。有了这个按钮，出事第一件事就是点它。
  'copy:llmtest': async () => {
    const r = await runJob('copy.llmtest');
    if (!r.ok) return;
    const x = r.result || {};
    if (x.enabled === false) { toast(x.note || '模型开关关着', 'warn'); return; }
    const img = x.image === true ? '支持看图' : (x.image === false ? '不支持看图' : '清单没写收不收图');
    toast(`接口可用：${x.modelId}（${img}）· ${x.endpointSource}`, x.image === false ? 'warn' : 'ok');
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
    const promptFilter = val('#bmFilter');
    const enEl = $('#bmEnabled'), pkEl = $('#bmPick');

    if (!id) {
      // 新增：按钮本来就只给管理员看，主进程还会再校验一次
      if (!name) { toast('先给品牌起个名字', 'err'); return; }
      const r = await appApi.brandAdd({ name, promptWrite, promptFilter, enabled: enEl ? enEl.checked : true });
      if (!r.ok) { toast(r.error, 'err'); return; }
      if (pkEl && pkEl.checked) await appApi.configSet({ copy: { defaultBrandId: r.brand.id } });
      state.config = await appApi.configGet();
      await refreshBrands();
      toast(`已新增品牌「${r.brand.name}」${promptWrite.trim() ? '' : '（还没配文案提示词，生成会被拦下）'}`, 'ok');
      openBrandModal('list');
      renderAll();
      return;
    }

    // 提示词：有权限的人都能改（主进程会再校验一次归属，只认这两个字段）
    const r1 = await appApi.brandPrompts(id, { promptWrite, promptFilter });
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
    const before = (state.logs || []).length;
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
    let r = await appApi.run('report.import', { file: f });
    if (!r.ok && /素材路径/.test(r.error || '')) {
      const d = await appApi.pickDir({
        title: '这份报告的「素材路径」是空的 —— 请选择这一批的素材目录（D:\\你的素材目录\\20260901 这种，里面每个叶子文件夹 = 一条内容）'
      });
      if (!d) { toast('已取消：报告里没有素材路径，也没有选素材目录', 'err'); return; }
      r = await appApi.run('report.import', { file: f, dir: d });
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
  // 一键把内置的中文输入法装到设备上（装 apk + 启用 + 设为当前输入法）。
  // 装完自动重跑一次检查，省得用户再点一次 —— 结果面板会直接变成「已装，且是当前输入法」。
  'pub:installIme': async () => {
    const r = await appApi.run('publish.installIme', {});
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    toast('中文输入法已装好、并设成了当前输入法。★ 副作用：模拟器里手动打字不会弹键盘了（ADBKeyboard 本来就是这样）', 'ok');
    const again = await appApi.run('publish.probe', {});
    if (again.ok) state.probe = again.result;
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
  'pub:recoverEdit': () => {
    const cur = ((state.config.publish || {}).uiMap || {}).recover || [];
    // 没配过就给一条示例，省得从空白开始猜格式
    state.recoverEdit = JSON.stringify(cur.length ? cur : [{ name: '删除卡片', action: 'tapText', value: '删除' }], null, 2);
    renderAll();
  },
  'pub:recoverCancel': () => { state.recoverEdit = null; renderAll(); },
  'pub:recoverSave': async () => {
    const box = document.getElementById('recoverBox');
    let steps;
    try {
      steps = JSON.parse(box ? box.value : '[]');
    } catch (e) {
      toast('JSON 格式不对：' + e.message, 'err');
      return;
    }
    // 校验在主进程（uimap.normalizeRecover）：不认识的 action 会被挡下来并说清可用值
    const r = await runJob('publish.setRecover', { steps });
    if (r.ok) {
      state.recoverEdit = null;
      state.config = await appApi.configGet();
      toast(r.result.recover.length ? `已保存 ${r.result.recover.length} 步恢复动作` : '已清空恢复动作（失败后只按返回键）', 'ok');
    }
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
      const online = state.devFound.filter(d => d.online).length;
      const fresh = state.devFound.filter(d => !d.configured).length;
      toast(state.devFound.length
        ? `adb 认到 ${state.devFound.length} 台设备，${online} 台在线${fresh ? `（其中 ${fresh} 台还没加进来，可直接「加入并使用」）` : ''}`
        : 'adb 现在一台设备都没认到：先把模拟器启动起来，并确认它开了「ADB 调试」',
      state.devFound.length ? (online ? 'ok' : '') : 'err');
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

  'cfg:save': async () => { await saveCfgFromDom(); toast('已保存', 'ok'); },  'cfg:path': async (el) => {
    const key = el.dataset.key;
    const field = key.split('.')[1];
    // 起点用这个字段**自己的当前值**（原来一律拿「素材根目录」当起点，跟要改的字段没关系）
    const d = await appApi.pickDir({ title: '选择目录', defaultPath: (state.config.paths && state.config.paths[field]) || '' });
    if (!d) return;
    await appApi.configSet({ paths: { [field]: d } });
    state.config = await appApi.configGet();
    renderAll();
  }
};

async function saveCfgFromDom() {
  const patch = {};
  document.querySelectorAll('#pane [data-cfg]').forEach(el => {
    const key = el.dataset.cfg;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.dataset.preset === 'interval') { const [a, b] = el.value.split('-'); patch.publish = Object.assign({}, patch.publish, { intervalMinSec: +a, intervalMaxSec: +b }); return; }
    else v = el.value;
    if (['copy.concurrency', 'copy.extraTopics', 'publish.retry'].includes(key)) v = Number(v);
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
  // 主题那个下拉已删（2026-10-03）：入口搬到顶栏的「themeBtn」，不需要在这里绑。
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
  const cmask = $('#cmodal');
  if (cmask) cmask.addEventListener('click', e => { if (e.target === cmask) closeCloudModal(); });

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
    if (e.key === 'Escape' && state.cloudModal) { closeCloudModal(); e.preventDefault(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = Number(e.key);
      if (k >= 1 && k <= 9) { state.tab = k; renderAll(); e.preventDefault(); }
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
