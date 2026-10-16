'use strict';
// 复用入口检查已经解析的节点；这里不抓屏、不等待、不点击。
const PKG = 'com.shizhuang.duapp';
const ownNodes = nodes => (nodes || []).filter(n => n.pkg === PKG || String(n.id || '').startsWith(PKG + ':id/'));
const label = n => String((n && (n.text || n.desc)) || '').trim();

/**
 * ★★ 发布页自己的「返回确认条」（2026-10-17 真机取证 / MuMu 12 / 得物 6.0.5）：
 *   在**有内容的发布页**上按返回，页面会在底部弹出这一条：
 *     tvTip「确定要返回编辑吗？」
 *     tvQuit「返回编辑」                          —— 不退出，回去继续编辑
 *     layoutSaveDraft 里 tvSaveDraft「保存并退出」   —— 内容存进「我-个人主页」的草稿，**不丢**
 *     tvCancel「取消」                            —— 关掉这条，留在发布页
 *
 * ★ 为什么单独认它、不复用入口那条「是否继续编辑」的规则：两条弹窗的 tvCancel **含义相反**
 *   （入口那条＝放弃旧内容；这一条＝取消退出）。按 id 复用会把「取消退出」当成「放弃」，
 *   方向完全错，最坏会把正在编辑的内容丢掉。
 * ★ 为什么只认「保存并退出」一个出口：它是**唯一**一个「内容不丢 + 又能离开发布流程」的按钮。
 *   另外两个（返回编辑／取消）都不解决卡点；绝不替用户选它们。
 * ★ 可点的是**容器**不是文字（真机 tvSaveDraft 的 clickable=false，clickable 的是
 *   layoutSaveDraft，两者同一片区域）：按文字找到它，再挑「中心点落在它身上的可点容器」。
 */
const SAVE_DRAFT_TEXT = /^(?:保存并退出|保存草稿)$/;
/**
 * 确认条自己的提示语。**必须先认出提示语**才允许去找里面的保存出口 —— 真机实测踩到：
 * 发布页底部本来就有一颗 `tvSaveExit`「存草稿」，只按文字找出口会把它当成"出口"，
 * 点下去只会存一次草稿、人还留在这一页（上面那个循环就是这么空转到超时的）。
 */
const EXIT_PROMPT_TEXT = /确定要返回编辑吗|返回编辑吗|是否保存草稿/;
/** 正在上传/发布的内容：一个键都不许碰（动了就是打断上传或误发） */
const UPLOAD_IN_FLIGHT = /正在上传|上传中|正在发布|发布中|取消上传|放弃发布/;

function rectOf(node) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String((node && node.bounds) || ''));
  return m ? { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] } : null;
}

/** 这一屏上有没有正在上传/发布的内容 */
function hasUploadInFlight(nodes) {
  return ownNodes(nodes).some(n => UPLOAD_IN_FLIGHT.test(label(n)));
}

/** 发布页返回确认条的「保存并退出」；认不出来 ⇒ null（不认识＝不许猜着点） */
function inspectPublishExit(nodes) {
  const all = ownNodes(nodes);
  const prompt = all.find(n => EXIT_PROMPT_TEXT.test(label(n)));
  if (!prompt) return null;
  const textNode = all.find(n => SAVE_DRAFT_TEXT.test(label(n)) && n.center);
  if (!textNode) return null;
  const rect = rectOf(textNode);
  let container = null;
  if (rect) {
    container = all.find(n => {
      if (n === textNode || !n.clickable || !n.center) return false;
      const r = rectOf(n);
      return !!r && r.x1 <= textNode.center.x && textNode.center.x <= r.x2
        && r.y1 <= textNode.center.y && textNode.center.y <= r.y2;
    }) || null;
  }
  return { kind: 'save-draft', name: label(textNode), button: container || textNode };
}

const RULES = [
  { name: '版本更新邀请', titles: ['发现新版本', '版本更新'], buttons: ['取消', '暂不更新', '以后再说', '稍后再说', '关闭'] },
  { name: '通知开启邀请', titles: ['开启通知', '开启消息通知', '通知权限'], buttons: ['取消', '暂不开启', '以后再说', '稍后再说', '暂不', '关闭'] }
];

function inspect(nodes) {
  const own = nodes.filter(n => n.pkg === PKG || n.id.startsWith(PKG + ':id/'));
  const text = n => (n.text || n.desc || '').trim();
  const explicitClose = n => /^(关闭|×|✕|Close)$/i.test(text(n))
    || /:id\/(?:iv_?close|btn_?close|dialog_?close|close(?:_?button)?)$/i.test(n.id);
  const usable = n => n.enabled && n.clickable && n.center;
  // 优先明确关闭，其次按离弹窗标题的距离排序；同距离使用页面中靠后的节点。
  const pick = (buttons, title) => buttons.sort((a,b) => Number(explicitClose(b))-Number(explicitClose(a))
    || (title && title.center ? Math.hypot(a.center.x-title.center.x,a.center.y-title.center.y)-Math.hypot(b.center.x-title.center.x,b.center.y-title.center.y) : 0)
    || nodes.indexOf(b)-nodes.indexOf(a))[0];
  // ★ 备用入口起手会撞上「是否继续编辑」：这是上一轮中断留下的半成品。
  //   本次要发的是队列里的新内容 ⇒ 在这里点「放弃」是正确且安全的；
  //   它不能和下面「取消上传/取消发布」等同等待（那些涉及正在执行的内容）。
  const resumeTitle = own.find(n => /^是否继续编辑/.test(text(n)));
  const resumeCancel = own.find(n => usable(n) && /:id\/tvCancel$/.test(n.id) && /^(放弃|取消)$/.test(text(n)));
  if (resumeTitle && resumeCancel) {
    return { name: '未完成内容继续编辑提示', title: text(resumeTitle), button: resumeCancel, resume: true };
  }
  // ★★ 发布页自己的返回确认条（见 inspectPublishExit）：它的「保存并退出」是内容不丢的出口。
  //   放在这里是为了**不落到下面那条「未识别弹窗 / 继续观察」**——那条只会一直等，
  //   而这一屏其实有明确出路（点「保存并退出」就能把上一次残留的发布页收掉）。
  const publishExit = inspectPublishExit(own);
  if (publishExit) {
    return { name: '发布页返回确认 · ' + publishExit.name, button: publishExit.button, publishExit: true };
  }
  // 这些按钮涉及正在执行的内容，不能把“取消”当作普通弹窗关闭。
  const unsafe = own.find(n => /^(取消上传|取消发布|放弃发布|放弃编辑|保存草稿|是否继续编辑|确认支付|确认付款|退出登录)$/.test(text(n)));
  if (unsafe) return { waiting: true, name: text(unsafe) + '（等待内容操作结束，不取消上传或发布）' };
  for (const rule of RULES) {
    const title = own.find(n => rule.titles.includes(text(n))
      && /(?:^android:id\/alertTitle$|:id\/(?:tv_title|dialog_title)$)/.test(n.id));
    if (!title) continue;
    const buttons = own.filter(n => usable(n) && (rule.buttons.includes(text(n)) || explicitClose(n)));
    return buttons.length ? { name: rule.name, title: text(title), button: pick(buttons,title) }
      : { waiting: true, name: rule.name + '（等待明确关闭入口）' };
  }
  const dialog = nodes.find(n => /(?:^|\.)Dialog$/.test(n.cls) || n.id === 'android:id/alertTitle');
  const closes = own.filter(n => usable(n) && explicitClose(n));
  if (closes.length) return { name: '页面关闭提示', title: text(dialog || {}) || '页面关闭提示', button: pick(closes,dialog) };
  return dialog ? { waiting: true, name: (text(dialog) || '未识别弹窗') + '（暂无明确关闭入口，继续观察）' } : null;
}

module.exports = { inspect, inspectPublishExit, hasUploadInFlight };
