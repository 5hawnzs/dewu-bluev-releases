'use strict';
// 按日期分组；时间与类型位于左栏，正文位于右栏。
window.releaseMotion = (() => {
  const days = [
    { date: '2026 年 10 月 13 日', week: '周二', entries: [
      { time: '本次更新', kind: '修复', title: '停止发布：区分已取消与真正失败',
        text: '停止批次时保留已完成结果，当前任务显示已取消，后续任务显示未执行。',
        points: [['状态提示', '取消相册清理不再显示为清理失败，结束提示与实际状态一致。'],
          ['文案生成', '没有图片时明确限制商品细节；品牌与词库示例不能充当图案、工艺的依据。同一电脑当天标题跨批次去重，仅换表情或标点也算重复。'],
          ['内容明细', '发布记录保存当时实际使用的标题与文案，网页点击标题可展开查看。'],
          ['AI用量', '汇总与任务明细点击切换，可按账号查看 token，不增加独立卡片。'],
          ['整理与发布', '整理结果区分本次与上次，打开目录按钮实际打开对应路径；当前 AI 内容报告移到发布页顶部。'],
          ['发布说明', '移除审核状态与等级权益关联的不准确提示。']] },
      { time: '本次更新', kind: '修复', title: '相册清理：核实全盘素材，再开始下一条',
        text: '沿用当前相机目录，清理后重新扫描并检查相册，避免上一条素材混入下一条。',
        points: [['素材清理', '补齐中文、空格等文件名的清理，并检查尚未进入相册索引的素材。'],
          ['设备忙碌', '媒体查询超时后给予一次额外恢复机会，取得明确结果后继续。'],
          ['并发保护', '同一模拟器通过不同连接端口运行时，也只允许一批任务操作相册。']] },
      { time: '本次更新', kind: '修复', title: '视频封面：选择画面，并在提交前检查',
        text: '自动选择视频中的可用画面作为封面，并检查发布编辑页的最终缩略图。',
        points: [['封面核验', '候选画面不可用时继续尝试其他位置；无法确认时给出具体原因。']] },
      { time: '本次更新', kind: '调整', title: '运行记录：显示实际耗时，补齐远程诊断',
        text: '移除不准确的固定耗时预估，计时显示随任务运行刷新。',
        points: [['阶段耗时', '云端记录清理、推送、界面操作等阶段的实际耗时。'],
          ['故障定位', '补充超时、权限、离线和进程异常的诊断信息，便于定位设备问题。']] }
    ] },
    { date: '2026 年 10 月 12 日', week: '周一', entries: [
      { time: '版本 1.1.1', kind: '更新', title: '连接与发布入口：兼容不同账号的页面',
        text: '修复网络波动导致退出的问题，补全品牌账号发布入口。',
        points: [['登录与权限', '断网时保留有效会话，权限自动刷新，当前批次可完成。'],
          ['素材整理', '复用没有变化的整理结果，减少重复处理。'],
          ['本地创作', '支持独立品牌提示词，以及词库撤销与重做。'],
          ['应用更新', '支持检查、下载与安装更新；发布任务运行期间禁止安装。']] }
    ] }
  ];
  function render() {
    return `<div class="release-journal">${days.map(day => `<section class="journal-day" aria-label="${day.date}">
      <header class="journal-date"><h2>${day.date}</h2><span>${day.week}</span></header>
      ${day.entries.map(entry => `<article class="journal-entry"><aside class="journal-meta"><time>${entry.time}</time>
      <span class="journal-kind" data-kind="${entry.kind}">${entry.kind}</span></aside>
      <div class="journal-body"><h3>${entry.title}</h3><p>${entry.text}</p>
      <ul>${entry.points.map(([title, text]) => `<li><strong>${title}：</strong>${text}</li>`).join('')}</ul></div></article>`).join('')}
      </section>`).join('')}</div>`;
  }
  return { render, mount() {} };
})();
