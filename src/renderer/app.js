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
  myId: null
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
  '已生成': 'ok', '通过': 'ok', '发布成功': 'ok', '完成': 'ok', '已隔离': 'warn',
  '需人工处理': 'bad', '需人工确认': 'warn', '词表外，需人工确认': 'warn', '主色不符，需人工确认': 'warn',
  '货号不存在': 'bad', '漏填颜色': 'bad', '失败': 'bad', '校验未通过': 'bad',
  '待发布': 'wait', '排队': 'wait', '生成中': 'run', '上传图片…': 'run', '填标题正文': 'run',
  '话题联想点选': 'run', '关联好物': 'run', '发布确认': 'run'
};
function kindOf(s) {
  if (STATUS_KIND[s]) return STATUS_KIND[s];
  if (/成功|完成|通过$/.test(s)) return 'ok';
  if (/失败|错误/.test(s)) return 'bad';
  if (/\.\.\.|…|中$/.test(s)) return 'run';
  return 'wait';
}

/* ---------------- 主题 ---------------- */
function applyTheme(t) {
  document.documentElement.classList.toggle('dark', !!(t && t.shouldUseDarkColors));
}

/* ---------------- 日志 ---------------- */
function pushLog(e) {
  state.logs.push(e);
  if (state.logs.length > 300) state.logs.shift();
  const box = $('#log');
  if (!box) return;
  const cls = { ok: 'ok', error: 'er', warn: 'wn', info: 'inf' }[e.level] || 'inf';
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${hhmm(e.t)}</span><span class="${cls}">${esc(e.msg)}</span>`;
  box.appendChild(div);
  while (box.children.length > 300) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
function renderLogs() {
  const box = $('#log');
  box.innerHTML = '';
  state.logs.slice(-200).forEach(pushLogEntry);
}
function pushLogEntry(e) {
  const box = $('#log');
  const cls = { ok: 'ok', error: 'er', warn: 'wn', info: 'inf' }[e.level] || 'inf';
  const div = document.createElement('div');
  div.innerHTML = `<span class="t">${hhmm(e.t)}</span><span class="${cls}">${esc(e.msg)}</span>`;
  box.appendChild(div);
}

/* ---------------- 任务（实例化：同一时间可以有多个批次在跑） ---------------- */
async function runJob(type, args) {
  let res;
  try {
    res = await appApi.run(type, args);
  } catch (e) {
    // IPC 层抛出来也要给人一句话，不能只在控制台里报错
    res = { ok: false, error: (e && e.message) || '任务调用失败' };
  }
  if (!res.ok) toast(res.error, res.cancelled || /已取消/.test(res.error || '') ? '' : 'err');
  renderAll();
  return res;
}
function jobOf(type) { const l = state.jobs.filter(j => j.type === type); return l.length ? l[l.length - 1] : null; }
function running(type) { return !!jobOf(type); }
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
    const dir = p.sourceDir || (state.config.paths && state.config.paths.source) || '';
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
      <p class="hint">规则（对齐真机）：图片<b>必须为 JPG</b>、≥<b>${cfg0.minPixels}</b> 像素²（约 42×42）、边长 <b>${cfg0.minSide}~${cfg0.maxSide}</b>${cfg0.autoScale ? '（超限自动等比缩放）' : ''}、≤${cfg0.maxImageMB}MB；视频<b>按扩展名判 .mp4</b> 且 &lt;${cfg0.maxVideoSec} 秒（超时只标红不裁剪）。</p>
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
  desc: '标题 + 正文 + 5 个话题 · 话题组合去重 · 标题格式轮换',
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
    const total = p.items.length || 0;
    return `
      <div class="box">
        <h3>批次设置</h3>
        <div class="row">
          <span class="lbl">并发路数</span>
          <select class="inp" data-cfg="copy.concurrency">${[4, 5, 6, 7, 8].map(v => `<option value="${v}" ${cfg.concurrency === v ? 'selected' : ''}>${v} 路</option>`).join('')}</select>
          <span class="lbl">轮换策略</span>
          <select class="inp" data-cfg="copy.rotateStrategy">${['F01-F10 轮换', '随机'].map(v => `<option ${cfg.rotateStrategy === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="lbl">必带话题</span>
          <input class="inp" style="min-width:120px;flex:0 0 auto" value="${esc(cfg.requiredTopic)}" data-cfg="copy.requiredTopic">
          <span class="lbl">话题数</span>
          <select class="inp" data-cfg="copy.extraTopics">${[3, 4, 5].map(v => `<option value="${v}" ${cfg.extraTopics === v ? 'selected' : ''}>${v} 个</option>`).join('')}</select>
        </div>
        ${running('copy.generate') ? progHtml(progFor('copy.generate')) : ''}
        <p class="hint">按<b>并发路数均分</b>（不是「15 条/批」切批，尾批会把整体拖慢）：${total} 篇 → ${cfg.concurrency} 路 × ${Math.ceil(total / (cfg.concurrency || 6))} 篇。本地先定死标题格式 / 视角 / 话题组合（代码保证去重），模型只填空。</p>
      </div>
      ${batchesHtml('copy.generate', '运行中的批次（AI 文案生成）')}
      ${planRows.length ? `<div class="tw"><table>
        <thead><tr><th>叶子目录</th><th>货号</th><th>颜色</th><th>标题格式</th><th>叙事视角</th><th>话题组合</th><th>标题</th><th>状态</th></tr></thead>
        <tbody>${planRows.slice(0, 40).map(r => `<tr>
          <td class="mono">${esc(r.id)}</td><td class="mono">${esc(r.sku || '')}</td><td>${esc(r.color || '')}</td>
          <td>${r.format ? esc(r.format + ' ' + (r.formatName || '')) : '—'}</td>
          <td>${r.angle ? esc(r.angle) : '—'}</td>
          <td class="cut">${(r.topics || []).length ? esc(r.topics.join(' ')) : '—'}</td>
          <td class="cut">${esc(r.title || '—')}</td>
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
      <p class="hint">多了一道保险：<b>用图片实际提出的主色反查目录里填的色名</b>。目录写「冠军白」但图是黑的，立刻就能发现。商品池：${state.info ? state.info.pool.size : 0} 个货号（${esc(state.info ? state.info.pool.source : '')}）。</p>`;
  }
};

TABS[5] = {
  title: '发布单',
  desc: '26 列，与前司发布文件结构一致 · 运营确认后交发布端',
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
  desc: 'ADB + uiautomator2 驱动得物 App · 间隔可设 1-2 分钟 · 失败可单独重跑',
  actions: () => [
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
      const gap = cfg.mock ? (cfg.mockIntervalSec || 5)
        : (isV ? (cfg.videoIntervalSec || Math.round(((cfg.intervalMinSec + cfg.intervalMaxSec) / 2) * 1.5))
          : (cfg.intervalMinSec + cfg.intervalMaxSec) / 2);
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
          <label class="row" style="gap:6px;min-width:auto"><input type="checkbox" data-cfg="publish.mock" ${cfg.mock ? 'checked' : ''}> 演示节奏（${cfg.mockIntervalSec} 秒/条）</label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-act="pub:probe">驱动自检</button>
          <button class="btn sm" data-act="pub:dump">抓取页面结构</button>
          <button class="btn sm" data-act="pub:map">导入 UI 定位表</button>
          <button class="btn sm" data-act="pub:recoverEdit">失败恢复动作</button>
          <span class="chip">${mode === 'adb' ? '真实设备通道' : '模拟通道'}</span>
          <span class="chip ${(state.config.publish.uiMap || {}).steps ? '' : 'warn'}">${(state.config.publish.uiMap || {}).steps ? '定位表 ' + state.config.publish.uiMap.steps.length + ' 步' : '定位表未配'}</span>
          ${(() => { const m = state.config.publish.uiMap || {}; if (!m.steps) return ''; const vn = (m.videoSteps || []).length; return vn ? `<span class="chip">视频 ${vn} 步</span>` : '<span class="chip">视频未配</span>'; })()}
          <span class="chip">批次 ${esc(pub.batch || '（导出发布单后自动命名）')}</span>
        </div>
        ${recoverHtml()}
        ${running('publish.run') || running('publish.rerun') ? progHtml(progFor(running('publish.run') ? 'publish.run' : 'publish.rerun')) : ''}
        <p class="hint">预计 <b>${est} 分钟</b>：单条技术下限 ≈30 秒（视频 ≈60 秒，还要等媒体库索引）+ 人为间隔 —— <b>93% 的时间是在等间隔</b>，不是性能问题。缩短间隔要你自己拍板，默认值按实测给的是 60–120 秒（视频默认 90 秒）。</p>
      </div>
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
      <p class="hint">已发 ${okCount} / ${rows.length}。发布完还要<b>回查审核状态</b>（创作中心 → 等级权益），发完 ≠ 发出去了。
      「重导出日志」会把 <code>publish-log.jsonl</code> 按批次导成可读的 <code>发布日志_批次_时间戳.log</code>（另有 .csv），
      内容对齐真机：<code>[V] 行 2 [图文] 发布完成，已回填时间 15:34:41（耗时 65.2s）</code>。</p>`;
  }
};

TABS[7] = {
  title: '设置',
  desc: '路径、依赖、外部数据源',
  actions: () => [{ act: 'cfg:save', label: '保存', primary: true }],
  render() {
    const c = state.config;
    const info = state.info || {};
    const dep = [
      ['图片处理 / 取色', info.engine === 'sharp' ? 'sharp + libvips（含 HEIC）' : 'jpeg-js + pngjs（纯 JS 降级）', info.engine === 'sharp' ? ['ok', '内置'] : ['warn', '降级']],
      ['HEIC 解码', info.hasHeif ? 'libheif（sharp 预编译）' : '未内置，HEIC 需人工处理', info.hasHeif ? ['ok', '可用'] : ['warn', '不可用']],
      ['发布单读写', 'exceljs', ['ok', '内置']],
      ['视频时长读取', '纯 JS MP4/MOV 解析（moov → mvhd）', ['ok', '内置']],
      ['视频转码', 'ffmpeg（预留）', ['warn', '待接入']],
      ['模拟器驱动', 'adb / uiautomator2', ['warn', '待接入']],
      ['得物商品池', info.pool ? `${info.pool.size} 个货号 · ${info.pool.source}` : '—', info.pool && info.pool.size ? ['ok', '已导入'] : ['warn', '待同步']]
    ];
    return `
      <div class="box">
        <h3>路径</h3>
        <div class="row" style="margin-bottom:9px"><span class="lbl">素材根目录</span><input class="inp mono" value="${esc(c.paths.source)}" readonly><button class="btn sm" data-act="cfg:path" data-key="paths.source">修改</button></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">输出目录</span><input class="inp mono" value="${esc(c.paths.output)}" readonly><button class="btn sm" data-act="cfg:path" data-key="paths.output">修改</button></div>
        <div class="row"><span class="lbl">隔离目录</span><input class="inp mono" value="${esc(c.paths.rejected)}" readonly><button class="btn sm" data-act="cfg:path" data-key="paths.rejected">修改</button></div>
      </div>
      <div class="box">
        <h3>文案模型（可选）</h3>
        <div class="row" style="margin-bottom:9px">
          <span class="lbl">启用</span>
          <select class="inp" data-cfg="copy.llm.enabled"><option value="true" ${c.copy.llm.enabled ? 'selected' : ''}>调用模型</option><option value="false" ${!c.copy.llm.enabled ? 'selected' : ''}>本地模板（离线）</option></select>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">接口地址</span><input class="inp mono" value="${esc(c.copy.llm.endpoint)}" data-cfg="copy.llm.endpoint" placeholder="https://…/v1/chat/completions"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">API Key</span><input class="inp mono" type="password" value="${esc(c.copy.llm.apiKey)}" data-cfg="copy.llm.apiKey"></div>
        <div class="row"><span class="lbl">模型</span><input class="inp mono" value="${esc(c.copy.llm.model)}" data-cfg="copy.llm.model"></div>
        <p class="hint">不填也能用：本地模板会把「选择」（标题格式 / 视角 / 话题组合）定死，只让模型填空 —— 没模型时由模板填空，流程一致。</p>
      </div>
      <div class="box">
        <h3>内容与校验（对齐真机）</h3>
        <div class="row" style="margin-bottom:9px"><span class="lbl">品牌</span><input class="inp" value="${esc(c.copy.brand || '')}" data-cfg="copy.brand" placeholder="如 TW男装 / skechers"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">筛选排序提示词</span><input class="inp" value="${esc(c.copy.promptFilter || '')}" data-cfg="copy.promptFilter"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">文案生成提示词</span><input class="inp" value="${esc(c.copy.promptWrite || '')}" data-cfg="copy.promptWrite"></div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">货号颜色</span>
          <select class="inp" data-cfg="verify.mode">
            <option value="local" ${c.verify.mode === 'local' ? 'selected' : ''}>本地商品池（导入 CSV）</option>
            <option value="api" ${c.verify.mode === 'api' ? 'selected' : ''}>接口查询（得物后台）</option>
          </select>
        </div>
        <div class="row" style="margin-bottom:9px"><span class="lbl">SKU 接口</span><input class="inp mono" value="${esc(c.verify.api.endpoint)}" data-cfg="verify.api.endpoint" placeholder="https://…/sku-colors"></div>
        <div class="row"><span class="lbl">API Key</span><input class="inp mono" type="password" value="${esc(c.verify.api.apiKey)}" data-cfg="verify.api.apiKey"></div>
        <p class="hint">接口模式下查不到的货号<b>仅告警不阻断</b>（真机口径）；判定文案为「单色货号，颜色可空 / 多色货号须指定颜色 / 未查到颜色信息，请核对」。</p>
      </div>
      <div class="box">
        <h3>外观</h3>
        <div class="row"><span class="lbl">主题</span>
          <select class="inp" id="themeSel">
            <option value="system">跟随 Windows 设置</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
          <span class="chip">${info.isWin ? 'Windows' : esc(info.platform)} · Electron ${esc(info.electron || '')}</span>
        </div>
      </div>
      <div class="box">
        <h3>外部依赖</h3>
        <div class="tw"><table>
          <thead><tr><th>用途</th><th>依赖</th><th>状态</th></tr></thead>
          <tbody>${dep.map(([a, b, s]) => `<tr><td>${esc(a)}</td><td class="mono">${esc(b)}</td><td>${badge(s[1], s[0])}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">配置与工程数据存在 <code>${esc(info.userData || '')}</code>，卸载时保留。</p>
      </div>
      ${accountHtml()}`;
  }
};

/** 设备矩阵：真机里「一个设备 = 一个账号」（雷电模拟器多台并行） */
function devicesHtml() {
  const list = (state.config.publish && state.config.publish.devices) || [];
  const sel = (state.config.publish && state.config.publish.device) || '';
  const rows = list.length ? `<div class="tw"><table>
    <thead><tr><th>设备（账号）</th><th>序列号</th><th>状态</th><th></th></tr></thead>
    <tbody>${list.map(d => `<tr class="${String(sel) === String(d.serial) ? 'warnrow' : ''}">
      <td>${esc(d.name)}</td><td class="mono">${esc(d.serial)}</td>
      <td>${(state.devStatus && state.devStatus[d.serial] && state.devStatus[d.serial].online)
        ? badge('在线', 'ok') : (state.devStatus ? badge('离线', 'wait') : badge('未检测', 'wait'))}</td>
      <td><button class="btn sm" data-act="pub:useDev" data-serial="${esc(d.serial)}">选用</button>
          <button class="btn sm" data-act="pub:delDev" data-id="${esc(d.id)}">删除</button></td>
    </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">还没有设备。真机是一台模拟器对应一个账号（如 emulator-5554 = UR视频号），在下面添加。</div>`;
  return `<div class="box"><h3>设备管理（一个设备 = 一个账号）</h3>${rows}
    <div class="row" style="margin-top:10px">
      <input class="inp mono" id="devName" placeholder="账号名，如 UR视频号" style="flex:0 0 160px;min-width:0">
      <input class="inp mono" id="devSerial" placeholder="序列号，如 emulator-5554" style="flex:0 0 190px;min-width:0">
      <button class="btn sm" data-act="pub:addDev">添加设备</button>
      <button class="btn sm" data-act="pub:devStatus">检测在线</button>
      <span class="chip ${(state.project.publish || {}).connected ? 'run' : ''}">${(state.project.publish || {}).connected ? '已连接' : '未连接'}</span>
    </div></div>`;
}

/** 驱动自检结果：说清楚「现在到底能不能真发」 */
function probeHtml() {
  const p = state.probe || (state.project.publish && state.project.publish.probe);
  if (!p) return '';
  const line = (k, v, bad) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v || '—')}</td><td>${badge(bad ? '不满足' : '可用', bad ? 'bad' : 'ok')}</td></tr>`;
  return `
    <div class="box">
      <h3>驱动自检</h3>
      <div class="tw"><table>
        <thead><tr><th>检查项</th><th>结果</th><th>状态</th></tr></thead>
        <tbody>
          ${line('adb', p.adb, !p.adb)}
          ${line('设备在线', p.device ? p.device.serial + '（' + p.device.state + '）' : '不在线', !p.device)}
          ${line('分辨率', p.resolution, !p.resolution)}
          ${line('得物包名', p.appPackage, !p.appPackage)}
          ${line('界面抓取 uiautomator', (p.tools && p.tools.uiautomator) ? '可用' : '不可用', !(p.tools && p.tools.uiautomator))}
          ${line('失败截图 screencap', (p.tools && p.tools.screencap) ? '可用' : '不可用', !(p.tools && p.tools.screencap))}
          ${line('中文输入 ADBKeyboard', p.adbKeyboard ? '已安装' : '未安装', !p.adbKeyboard)}
        </tbody>
      </table></div>
      ${(p.notes && p.notes.length) ? `<p class="hint">${p.notes.map(n => '⚠ ' + esc(n)).join('<br>')}</p>` : '<p class="hint">全部检查通过。</p>'}
    </div>`;
}

/* ---------------- 渲染入口 ---------------- */
function renderAll() {
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
  if (state.tab === 7) bindSettings();
}

/* ---------------- 登录门 ---------------- */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function showGate(msg) {
  document.body.classList.add('locked');
  $('#lgErr').textContent = msg || '';
  const f = $('#loginForm');
  if (!f.dataset.bound) {
    f.dataset.bound = '1';
    f.onsubmit = e => { e.preventDefault(); doLogin(); };
    $('#lgUser').oninput = $('#lgPwd').oninput = () => { $('#lgErr').textContent = ''; };
  }
  const hint = state.auth && state.auth.defaultHint;
  const tip = $('#lgTip');
  if (hint) {
    tip.hidden = false;
    tip.innerHTML = `初始账号 <b>${esc(hint.username)}</b> / <b>${esc(hint.password)}</b>` +
      ` —— 进去后到「设置 → 账号与安全」改掉。`;
  } else {
    tip.hidden = true;
  }
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
  await refreshUsers();
  bindOnce();
  renderAll();
  renderLogs();
  const me = state.auth && state.auth.user;
  if (me && me.mustChange) toast('当前还是出厂口令，建议到「设置 → 账号与安全」改掉', 'err');
}

async function doLogout() {
  await appApi.authLogout();
  state.auth = await appApi.authStatus();
  state.users = null;
  state.jobs = [];
  state.batchDetail = null;
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

/* ---------------- 设置页：账号与安全 ---------------- */
function accountHtml() {
  const a = state.auth || {};
  const me = a.user;
  if (!me) return '';
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
    ${a.isAdmin ? adminUsersHtml() : '<div class="box"><h3>账号管理</h3><p class="hint">只有管理员能新增/停用账号。</p></div>'}`;
}

function adminUsersHtml() {
  const us = state.users || [];
  const myId = (state.auth && state.auth.user) ? state.auth.user.id : null;
  const rows = us.map(u => `<tr>
      <td>${esc(u.displayName)}</td>
      <td class="mono">${esc(u.username)}</td>
      <td>${badge(u.role === 'admin' ? '管理员' : '成员', u.role === 'admin' ? 'ok' : 'wait')}</td>
      <td>${badge(u.disabled ? '已停用' : '启用', u.disabled ? 'bad' : 'ok')}</td>
      <td class="mono">${esc(u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—')}</td>
      <td>${u.id === myId ? '<span class="chip">本人</span>' : `
        <button class="btn sm" data-act="auth:toggle" data-id="${u.id}" data-next="${u.disabled ? '0' : '1'}">${u.disabled ? '启用' : '停用'}</button>
        <button class="btn sm" data-act="auth:reset" data-id="${u.id}">重置密码</button>
        <button class="btn sm" data-act="auth:del" data-id="${u.id}" data-name="${esc(u.username)}">删除</button>`}</td>
    </tr>`).join('');
  const others = us.filter(u => u.id !== myId);
  return `
    <div class="box">
      <h3>账号管理（管理员）</h3>
      <div class="tw"><table>
        <thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>状态</th><th>上次登录</th><th>操作</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="acct-toolbar">
        <input class="inp mono" id="nuUser" placeholder="新账号（3–32 位）" style="min-width:150px">
        <input class="inp" id="nuName" placeholder="姓名" style="min-width:110px">
        <select class="inp" id="nuRole"><option value="user">普通成员</option><option value="admin">管理员</option></select>
        <input class="inp mono" id="nuPwd" type="password" placeholder="初始密码 ≥6 位" style="min-width:150px">
        <button class="btn sm primary" data-act="auth:create">新建账号</button>
      </div>
      <div class="acct-toolbar">
        <select class="inp" id="rsUser">${others.map(u => `<option value="${u.id}">重置：${esc(u.username)}</option>`).join('') || '<option value="">（没有其他账号）</option>'}</select>
        <input class="inp mono" id="rsPwd" type="password" placeholder="新密码 ≥6 位" style="min-width:150px">
        <button class="btn sm" data-act="auth:reset" data-id="">重置密码</button>
      </div>
      <p class="hint">账号存在本机 <code>auth.json</code>（与 config.json 分开），口令只存 scrypt 哈希，不存明文。
        停用/删除账号<b>不影响</b>已产出的素材、发布单与商品池。连续输错 6 次会锁定 5 分钟。</p>
    </div>`;
}

/* ---------------- 交互 ---------------- */
const ACTS = {
  'flatten:pick': async () => {
    const d = await appApi.pickDir({ title: '选择素材根目录' });
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

  'copy:run': async () => { await runJob('copy.generate'); },
  'copy:pickRun': async () => {
    const d = await appApi.pickDir({ title: '选择素材目录（一个目录 = 一个批次，可同时跑多个）', defaultPath: state.config.paths.source });
    if (!d) return;
    const name = d.split(/[\\/]/).filter(Boolean).pop() || '批次';
    const batchId = `${name}_${batchStamp()}`;
    await runJob('copy.generate', { sourceDir: d, batchId, label: batchId });
  },
  'copy:prompt': () => { state.tab = 7; renderAll(); toast('已跳到「设置 → 文案模型」'); },

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
        title: '这份报告的「素材路径」是空的 —— 请选择这一批的素材目录（D:\\卡宾\\20260901 这种，里面每个叶子文件夹 = 一条内容）'
      });
      if (!d) { toast('已取消：报告里没有素材路径，也没有选素材目录', 'err'); return; }
      r = await appApi.run('report.import', { file: f, dir: d });
    }
    if (!r.ok) { toast(r.error, 'err'); renderAll(); return; }
    const x = r.result;
    toast(`报告已导入：${x.total} 条待发布（用报告里的标题文案 ${x.fromReport} 条 · 本地生成 ${x.generated} 条${x.blocked ? ` · ${x.blocked} 条暂不发布` : ''}）`, x.blocked ? '' : 'ok');
    state.tab = 5;
    renderAll();
  },

  'pub:connect': async () => {
    const r = await appApi.run('publish.connect', {});
    if (r.ok) toast(r.result.note, r.result.connected ? 'ok' : '');
    renderAll();
  },
  'pub:probe': async () => {
    const r = await appApi.run('publish.probe', {});
    if (r.ok) { state.probe = r.result; toast(r.result.device ? '设备在线，自检完成' : '自检未通过，看下方明细', r.result.device ? 'ok' : ''); }
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
    if (!serial.trim()) { toast('请填设备序列号，如 emulator-5554', 'err'); return; }
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
  'pub:devStatus': async () => {
    const r = await appApi.run('publish.devices', {});
    if (r.ok) {
      const map = {};
      (r.result.devices || []).forEach(d => { map[d.serial] = d; });
      state.devStatus = map;
      const online = (r.result.devices || []).filter(d => d.online).length;
      toast(`已检测 ${r.result.devices.length} 台设备，${online} 台在线`, online ? 'ok' : '');
    }
    renderAll();
  },
  'pub:run': async () => { await runJob('publish.run', {}); },
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
  'auth:reset': async (el) => {
    const id = el.dataset.id || ($('#rsUser') ? $('#rsUser').value : '');
    const pwd = $('#rsPwd') ? $('#rsPwd').value : '';
    if (!id) { toast('先选一个账号', 'err'); return; }
    if (!pwd) { toast('先填好新密码（≥6 位）', 'err'); $('#rsPwd').focus(); return; }
    if (el.dataset.id && $('#rsUser')) $('#rsUser').value = id;
    const r = await appApi.authResetPwd(id, pwd);
    if (!r.ok) { toast(r.error, 'err'); return; }
    $('#rsPwd').value = '';
    await refreshUsers();
    toast('密码已重置，对方首次登录后可自行修改', 'ok');
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

  'cfg:save': async () => { await saveCfgFromDom(); toast('已保存', 'ok'); },
  'cfg:path': async (el) => {
    const key = el.dataset.key;
    const d = await appApi.pickDir({ title: '选择目录', defaultPath: state.config.paths.source });
    if (!d) return;
    await appApi.configSet({ paths: { [key.split('.')[1]]: d } });
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
    const parts = key.split('.');
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
    cur[parts[parts.length - 1]] = v;
  });
  await appApi.configSet(patch);
  state.config = await appApi.configGet();
}

function bindSettings() {
  const sel = $('#themeSel');
  if (!sel) return;
  appApi.themeGet().then(t => { sel.value = t.themeSource || 'system'; });
  sel.onchange = async () => { await appApi.themeSet(sel.value); };
  document.querySelectorAll('#pane [data-cfg]').forEach(el => {
    el.onchange = () => { saveCfgFromDom(); };
  });
}

function bindOnce() {
  if (bindOnce.done) return;
  bindOnce.done = true;
  bind();
}

function bind() {
  $('#btnLogout').onclick = () => doLogout();

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTS[el.dataset.act];
    if (fn) fn(el);
  });

  document.querySelectorAll('.nav').forEach(b => {
    b.onclick = () => { state.tab = Number(b.dataset.tab); renderAll(); };
  });

  $('#capMin').onclick = () => appApi.min();
  $('#capMax').onclick = () => appApi.toggleMax();
  $('#capClose').onclick = () => appApi.close();
  $('.titlebar').ondblclick = e => { if (!e.target.closest('.cap')) appApi.toggleMax(); };
  $('#logClear').onclick = () => { state.logs = []; $('#log').innerHTML = ''; };

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = Number(e.key);
      if (k >= 1 && k <= 7) { state.tab = k; renderAll(); e.preventDefault(); }
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
}

async function boot() {
  state.info = await appApi.info();
  applyTheme(await appApi.themeGet());
  state.auth = await appApi.authStatus();
  if (state.auth.requireLogin && !state.auth.user) { showGate(); return; }
  await enterApp();
}

boot();
