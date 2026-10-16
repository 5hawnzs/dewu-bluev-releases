'use strict';
// 复用入口检查已经解析的节点；这里不抓屏、不等待、不点击。
const PKG = 'com.shizhuang.duapp';
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

module.exports = { inspect };
