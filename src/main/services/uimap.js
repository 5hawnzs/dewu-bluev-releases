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

  return { package: pkg || (nodes[0] && nodes[0].pkg) || '', generatedAt: Date.now(), steps };
}

/** 把 ${title} / ${topic3} 之类占位符替换成本条的真实内容 */
function fill(step, data) {
  const t = String(step.value == null ? '' : step.value).replace(/\$\{(\w+)\}/g, (_, k) => (data[k] != null ? data[k] : ''));
  return Object.assign({}, step, { value: t });
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

module.exports = { parseNodes, findNode, suggest, fill, normalizeRecover, RECOVER_ACTIONS };
