'use strict';
/**
 * UI 定位表：得物 App 的页面结构不能靠猜，靠「抓一次 dump 配一次」。
 * 这里负责：dump → 节点解析 / 按文本或 resource-id 找节点 / 自动生成候选步骤。
 */
function parseNodes(xml) {
  const nodes = [];
  const re = /<node\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attr = {};
    const ar = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(m[1]))) attr[a[1]] = a[2];
    const b = (attr.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const box = b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null;
    nodes.push({
      text: attr.text || '',
      desc: attr['content-desc'] || '',
      id: attr['resource-id'] || '',
      cls: attr.class || '',
      pkg: attr.package || '',
      clickable: attr.clickable === 'true',
      bounds: attr.bounds || '',
      box,
      center: box ? { x: Math.round((box.x1 + box.x2) / 2), y: Math.round((box.y1 + box.y2) / 2) } : null
    });
  }
  return nodes;
}

function findNode(nodes, cond) {
  const { text, id, desc, contains } = cond || {};
  return nodes.find(n => {
    if (id && n.id === id) return true;
    if (desc && n.desc === desc) return true;
    if (text && n.text === text) return true;
    if (contains && (n.text.includes(contains) || n.desc.includes(contains))) return true;
    return false;
  }) || null;
}

/** 按关键词在 dump 里猜一套候选步骤，用户改改就能用 */
function suggest(nodes, pkg) {
  const hit = (...keys) => nodes.filter(n => keys.some(k => n.text === k || n.desc === k || (n.text || '').includes(k)));
  const steps = [];
  const pushStep = (name, action, value, hint) => steps.push({ name, action, value, hint, unverified: true });

  const pub = hit('发布', '发笔记', '创作')[0];
  if (pub) pushStep('打开发布入口', 'tapText', pub.text || pub.desc, '取自 dump 的匹配节点');
  else pushStep('打开发布入口', 'tapText', '发布', '⚠ dump 里没找到，需手动确认');

  pushStep('从相册选图', 'tapText', '相册', '选图入口，按实际页面改');
  pushStep('确认选图', 'tapText', '下一步', '部分版本叫 完成/确定');
  pushStep('填标题', 'input', '${title}', '占位符在运行时替换为生成好的标题');
  pushStep('填正文', 'input', '${body}', '占位符替换为正文');
  for (let i = 1; i <= 5; i++) {
    pushStep(`话题 ${i}（输入→等联想→点选）`, 'input', '${topic' + i + '}', '得物不认纯文本话题，必须走联想点选');
  }
  pushStep('关联好物', 'tapText', '关联好物', '');
  pushStep('搜索货号', 'input', '${sku}', '');
  pushStep('提交发布', 'tapText', '发布', '最后一步的发布按钮');

  // 视频是**另一条 UI 路径**（入口文案、相册里的「视频」页签、编辑页都可能不一样），
  // 所以单独给一套候选 —— 抓得物「发布视频」页的 dump 时，改这一套，别改 steps。
  const videoSteps = [];
  const vpush = (name, action, value, hint) => videoSteps.push({ name, action, value, hint, unverified: true });
  const ventry = hit('上传视频', '发视频', '视频号')[0];
  if (ventry) vpush('打开发布入口（视频）', 'tapText', ventry.text || ventry.desc, '取自 dump 的匹配节点');
  else vpush('打开发布入口（视频）', 'tapText', '上传视频', '⚠ dump 里没找到，需手动确认');
  vpush('切到视频页签', 'tapText', '视频', '相册页顶部的「视频」页签，部分版本叫 短片/全部，按实际页面改');
  vpush('选中要发的视频', 'tapText', '${videoName}', '${videoName} 是**推上去之后**的文件名（含中文的名字会被清洗成下划线）；相册里只有缩略图没有文字时，改成 tapId/tapDesc 或按实际页面改');
  vpush('确认选视频', 'tapText', '下一步', '部分版本叫 完成/确定');
  vpush('填标题', 'input', '${title}', '占位符在运行时替换为生成好的标题');
  vpush('填正文', 'input', '${body}', '占位符替换为正文');
  for (let i = 1; i <= 5; i++) {
    vpush(`话题 ${i}（输入→等联想→点选）`, 'input', '${topic' + i + '}', '得物不认纯文本话题，必须走联想点选');
  }
  vpush('关联好物', 'tapText', '关联好物', '');
  vpush('搜索货号', 'input', '${sku}', '');
  vpush('提交发布', 'tapText', '发布', '最后一步的发布按钮');

  return {
    package: pkg || (nodes[0] && nodes[0].pkg) || '',
    generatedAt: Date.now(),
    // 封面口径（已拍板）：用得物推荐的 —— 不点封面区、不上传封面图。
    // 但若真机版本封面区默认未选中、不点一下会卡住「下一步」，就得在 videoSteps 里补一步点它。
    videoNote: '视频封面用得物推荐的：不点封面区、不上传封面图。若真机版本封面区默认未选中挡住了「下一步」，'
      + '在 videoSteps 里补一步（value 填封面区上真实看到的文字），例如 '
      + '{"name":"选第一个封面候选","action":"tapText","value":"<封面区上真实文字>"} —— 这一条不能靠猜，必须真机看一眼。',
    steps,
    videoSteps
  };
}

/** 把 ${title} / ${topic3} 之类占位符替换成本条的真实内容 */
function fill(step, data) {
  const t = String(step.value == null ? '' : step.value).replace(/\$\{(\w+)\}/g, (_, k) => (data[k] != null ? data[k] : ''));
  return Object.assign({}, step, { value: t });
}

/**
 * 发布步骤（uiMap.steps / uiMap.videoSteps）的校验。
 * 与 normalizeRecover 一个思路：不认识的 action 直接报错并列出可用值。
 * 为什么要在**导入时**拦住：写错的步骤要跑到 publisher.runStep 才抛「未知步骤类型」，
 * 那时第一条已经推完素材、点了一半界面；导入时就报出来，能省掉一次半途失败。
 */
const STEP_ACTIONS = ['tapText', 'tapId', 'tapDesc', 'input', 'wait', 'back', 'screenshot'];

function normalizeSteps(input, label = 'steps') {
  if (!Array.isArray(input) || !input.length) {
    throw new Error(`${label} 必须是非空数组，例如 [{"action":"tapText","value":"发布"}]`);
  }
  return input.map((raw, i) => {
    const step = raw && typeof raw === 'object' ? raw : {};
    const action = String(step.action || '').trim();
    const at = `${label} 第 ${i + 1} 步`;
    if (!STEP_ACTIONS.includes(action)) {
      throw new Error(`${at}的 action 不认识「${action || '（空）'}」；可用：${STEP_ACTIONS.join(' / ')}`);
    }
    if (action === 'wait') {
      const ms = Number(step.value);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${at}（wait）的 value 要写毫秒数，例如 1500`);
      return Object.assign({}, step, { value: ms });
    }
    if (action === 'tapText' || action === 'tapId' || action === 'tapDesc') {
      const value = String(step.value == null ? '' : step.value);
      if (!value.trim()) throw new Error(`${at}（${action}）的 value 不能为空：要点的文字 / resource-id / 描述`);
      return Object.assign({}, step, { value });
    }
    // input：value 里的占位符（${title} 等）是运行时才替换的，这里看不出来，别误判成空
    // screenshot：value 只是截图文件名前缀，可以空；back 不需要 value
    return Object.assign({}, step);
  });
}

/**
 * 失败恢复动作（uiMap.recover）：发布失败时要退回干净起点，否则下一条的界面会被残留页面污染。
 * 真机日志里是「已回退转发页」「删除卡片」这类动作，每个账号/版本不一样，所以做成可编辑而不是写死。
 *
 * publisher.recover 真正支持的只有这几种：tapText / tapId / tapDesc / wait
 * （返回键是 recover 自己先按的，不用写进来；写了也没人执行，所以这里直接报错拦住）
 */
const RECOVER_ACTIONS = ['tapText', 'tapId', 'tapDesc', 'wait'];

function normalizeRecover(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('恢复动作必须是数组，例如 [{"action":"tapText","value":"删除"}]');
  return input.map((raw, i) => {
    const step = raw && typeof raw === 'object' ? raw : {};
    const action = String(step.action || '').trim();
    const at = `第 ${i + 1} 步`;
    if (!RECOVER_ACTIONS.includes(action)) {
      throw new Error(`${at}的 action 不认识「${action || '（空）'}」；可用：${RECOVER_ACTIONS.join(' / ')}`);
    }
    if (action === 'wait') {
      const ms = Number(step.value);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`${at}（wait）的 value 要写毫秒数，例如 800`);
      return { name: step.name || '等待', action, value: ms };
    }
    const value = String(step.value == null ? '' : step.value).trim();
    if (!value) throw new Error(`${at}（${action}）的 value 不能为空：要点的文字 / resource-id / 描述`);
    return { name: step.name || value, action, value };
  });
}

module.exports = {
  parseNodes, findNode, suggest, fill,
  normalizeSteps, STEP_ACTIONS, normalizeRecover, RECOVER_ACTIONS
};
