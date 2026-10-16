'use strict';
// 按日期分组；左侧时间与类型，右侧只给核心标题 —— 明细不对外展示。
window.releaseMotion = (() => {
  const days = [
    { date: "2026 年 10 月 17 日", week: "周六", entries: [
      { time: "本次修复", kind: "修复", title: "稳定性：图形环境异常时程序不再整体退出，发布不会中途中断" },
      { time: "本次修复", kind: "修复", title: "发布入口：上一次中断留下的发布页自动收掉，新任务不再卡住" },
      { time: "本次优化", kind: "调整", title: "页面读取：同一屏不再重复抓取，入口检查更快" }
    ] },
    { date: "2026 年 10 月 16 日", week: "周五", entries: [
      { time: "本次修复", kind: "修复", title: "图文选图后的转场：确认标题页再继续" },
      { time: "本次调整", kind: "调整", title: "入口遮挡：复用页面检查，按规则关闭已知邀请弹窗" }
    ] },
    { date: "2026 年 10 月 15 日", week: "周四", entries: [
      { time: "本次修复", kind: "修复", title: "相册清理：找到连续失败的真因（删不掉时跳过了删记录）" },
      { time: "本次修复", kind: "修复", title: "相册清理：命令被超时杀掉时不再误判为“清不掉”" },
      { time: "本次修复", kind: "修复", title: "相册清理：判不出结果时不再把时间耗在无效等待上" },
      { time: "本次修复", kind: "修复", title: "相册清理：关掉程序再打开，也记得把上次隔离的目录收回来" }
    ] },
    { date: "2026 年 10 月 14 日", week: "周三", entries: [
      { time: "本次修复", kind: "修复", title: "相册清理：上一条视频仍被占用时不再直接失败" },
      { time: "本次修复", kind: "修复", title: "相册清理：异常回执后核实实际媒体状态" },
      { time: "本次更新", kind: "修复", title: "相册清理：核对删除结果，恢复暂时残留" },
      { time: "本次更新", kind: "修复", title: "发布起点：从普通浏览页在App内返回入口" },
      { time: "本次更新", kind: "修复", title: "连续发布：在得物内部接着发布下一条" },
      { time: "本次更新", kind: "修复", title: "结果回写：整批发布和单条重跑使用同一处理" },
      { time: "本次更新", kind: "修复", title: "前端状态：保留正在编辑的设置，准确显示错误" },
      { time: "实测记录", kind: "调整", title: "连续两条真实发布与回归验证" }
    ] },
    { date: "2026 年 10 月 13 日", week: "周二", entries: [
      { time: "本次更新", kind: "修复", title: "停止发布：区分已取消与真正失败" },
      { time: "本次更新", kind: "修复", title: "相册清理：核实全盘素材，再开始下一条" },
      { time: "本次更新", kind: "修复", title: "视频封面：选择画面，并在提交前检查" },
      { time: "本次更新", kind: "调整", title: "运行记录：显示实际耗时，补齐远程诊断" }
    ] },
    { date: "2026 年 10 月 12 日", week: "周一", entries: [
      { time: "版本 1.1.1", kind: "更新", title: "连接与发布入口：兼容不同账号的页面" }
    ] }
  ];
  function render() {
    return `<div class="release-journal">${days.map(day => `<section class="journal-day" aria-label="${day.date}">
      <header class="journal-date"><h2>${day.date}</h2><span>${day.week}</span></header>
      ${day.entries.map(entry => `<article class="journal-entry"><aside class="journal-meta"><time>${entry.time}</time>
      <span class="journal-kind" data-kind="${entry.kind}">${entry.kind}</span></aside>
      <div class="journal-body"><h3>${entry.title}</h3></div></article>`).join('')}
      </section>`).join('')}</div>`;
  }
  return { render, mount() {} };
})();
