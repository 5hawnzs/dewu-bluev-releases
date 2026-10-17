'use strict';
// 按日期分组；左侧时间与类型，右侧一条标题 + 1~2 句说明（只说结论，不贴内部细节）。
window.releaseMotion = (() => {
  const days = [
    { date: "2026 年 10 月 17 日", week: "周六", entries: [
      { time: "本次修复", kind: "修复", title: "稳定性：图形环境异常时程序不再整体退出",
        desc: "图形进程出问题时只记录并恢复，不再把整个程序带走；正在发布的批次不会因此中断。" },
      { time: "本次修复", kind: "修复", title: "发布入口：上一次中断留下的发布页自动收掉",
        desc: "按页面自带的「保存并退出」退出，内容进草稿不丢，下一批能正常开始。" },
      { time: "本次修复", kind: "修复", title: "发布异常：单条失败自动收回现场，后续内容继续",
        desc: "一条出错会先退回重试一次，仍不行就只记这一条失败，后面的内容照常发。" },
      { time: "本次修复", kind: "修复", title: "图片编辑页：导出进行中先等待，不再卡在 1/5",
        desc: "选完多图会先导出，导出期间不点「下一步」；导出结束再继续。" },
      { time: "本次优化", kind: "调整", title: "页面读取：同一屏不再重复抓取",
        desc: "入口检查和点击复用同一次读屏结果，少一次等待，开始发布更快。" }
    ] },
    { date: "2026 年 10 月 16 日", week: "周五", entries: [
      { time: "本次修复", kind: "修复", title: "图文选图后的转场：确认标题页再继续",
        desc: "相册点完「下一步」先确认真的到了标题页，再填标题和提交。" },
      { time: "本次调整", kind: "调整", title: "入口遮挡：复用页面检查，按规则关闭已知邀请弹窗",
        desc: "已知的版本更新、通知邀请按规则关掉，页面检查结果复用，少抓一次屏。" }
    ] },
    { date: "2026 年 10 月 15 日", week: "周四", entries: [
      { time: "本次修复", kind: "修复", title: "相册清理：找到连续失败的真因",
        desc: "文件删不掉时原来会跳过删记录，下一轮又撞上同一批残留；现在按实际结果处理。" },
      { time: "本次修复", kind: "修复", title: "相册清理：命令超时被杀不再误判为清不掉",
        desc: "超时被杀不等于删除失败，会重新核对相册再决定。" },
      { time: "本次修复", kind: "修复", title: "相册清理：判不出结果时不再空等",
        desc: "不会收敛的等待尽快结束，失败不再比成功还慢。" },
      { time: "本次修复", kind: "修复", title: "相册清理：重开程序也记得回收上次的目录",
        desc: "上次隔离过的目录会被记住并自动回收，不用人工清理。" }
    ] },
    { date: "2026 年 10 月 14 日", week: "周三", entries: [
      { time: "本次修复", kind: "修复", title: "相册清理：上一条视频仍被占用时不再直接失败",
        desc: "占用释放后自动重试清理，不再让第二条卡住。" },
      { time: "本次修复", kind: "修复", title: "相册清理：异常回执后核实实际媒体状态",
        desc: "命令回执异常时以相册实际内容为准，不误报成功或失败。" },
      { time: "本次更新", kind: "修复", title: "相册清理：核对删除结果，恢复暂时残留",
        desc: "删除后回读核对，暂时删不掉的记下来稍后补删。" },
      { time: "本次更新", kind: "修复", title: "发布起点：从普通浏览页在 App 内返回入口",
        desc: "从浏览页也能在 App 内回到发布入口，不用重启得物。" },
      { time: "本次更新", kind: "修复", title: "连续发布：在得物内部接着发布下一条",
        desc: "一条发完直接在得物里接着发下一条，减少来回启动。" },
      { time: "本次更新", kind: "修复", title: "结果回写：整批发布和单条重跑使用同一处理",
        desc: "两种入口写回报告的方式一致，结果不会一边有一边没有。" },
      { time: "本次更新", kind: "修复", title: "前端状态：保留正在编辑的设置，准确显示错误",
        desc: "刷新时不再丢掉正在改的设置，错误按实际原因显示。" },
      { time: "实测记录", kind: "调整", title: "连续两条真实发布与回归验证",
        desc: "真实设备连续发布两条，并跑完整回归。" }
    ] },
    { date: "2026 年 10 月 13 日", week: "周二", entries: [
      { time: "本次更新", kind: "修复", title: "停止发布：区分已取消与真正失败",
        desc: "手动停止记「已取消」，只有真的出错才记失败。" },
      { time: "本次更新", kind: "修复", title: "相册清理：核实全盘素材，再开始下一条",
        desc: "清理后全盘核对一遍，确认没有残留再发下一条。" },
      { time: "本次更新", kind: "修复", title: "视频封面：选择画面，并在提交前检查",
        desc: "自动选封面并在提交前核对，避免封面放错。" },
      { time: "本次更新", kind: "调整", title: "运行记录：显示实际耗时，补齐远程诊断",
        desc: "每条显示真实耗时，日志带上设备与步骤信息。" }
    ] },
    { date: "2026 年 10 月 12 日", week: "周一", entries: [
      { time: "版本 1.1.1", kind: "更新", title: "连接与发布入口：兼容不同账号的页面",
        desc: "有主页按钮和没有主页按钮的账号都能进入发布入口。" }
    ] }
  ];
  function render() {
    return `<div class="release-journal">${days.map(day => `<section class="journal-day" aria-label="${day.date}">
      <header class="journal-date"><h2>${day.date}</h2><span>${day.week}</span></header>
      ${day.entries.map(entry => `<article class="journal-entry"><aside class="journal-meta"><time>${entry.time}</time>
      <span class="journal-kind" data-kind="${entry.kind}">${entry.kind}</span></aside>
      <div class="journal-body"><h3>${entry.title}</h3>${entry.desc ? `<p>${entry.desc}</p>` : ''}</div></article>`).join('')}
      </section>`).join('')}</div>`;
  }
  return { render, mount() {} };
})();
