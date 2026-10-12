'use strict';
// 轻量 Canvas：数字以文字蒙版采样生成等高线；仅可见时逐帧绘制。
window.releaseMotion = (() => {
  let stop = () => {};
  const stages = [
    ['素材整理', '一次整理，持续复用', '识别文件与目录，复用未变化的整理结果。'],
    ['合规检查', '先检查，再生成', '排查素材问题，将异常内容单独处理。'],
    ['文案生成', '各品牌，各自表达', '本机提示词与词库组合，保留独立口吻。'],
    ['设备发布', '真实入口，逐步验证', '等待屏幕稳定；兼容不同账号的发布入口。'],
    ['结果回流', '每次执行都有记录', '发布结果回写报告，执行摘要同步云端。']
  ];
  function render() {
    return `<div class="release-page"><div class="release-date">2026 年 10 月 12 日 <span>版本更新 · 1.1.1</span></div><article class="release-issue"><header class="release-hero"><div class="release-kicker">— 本次更新</div><div class="release-banner"><span class="release-brand">BLUE<span>V</span></span><canvas data-release-canvas aria-label="1.1 动态轮廓"></canvas><span class="release-fallback">1.1</span></div><h2>连接更稳定，发布入口更可靠。</h2><p>修复网络波动导致退出，补全品牌账号发布入口。<br>素材避免重复整理，本地词库支持撤销与重做。</p></header><section class="release-section"><h3><em>01</em>底层：从素材到结果，五个环节</h3><p class="release-muted">让每一步都有清晰的输入、检查和结果。</p><div class="release-pipeline"><svg viewBox="0 0 1000 80" preserveAspectRatio="none" aria-hidden="true"><path class="release-track" d="M20 40H980"/><path class="release-flow" d="M20 40H980"/></svg><ol>${stages.map((s, i) => `<li style="--stage:${i}"><span class="release-station">${i + 1}</span><h4>${s[0]}</h4><b>${s[1]}</b><p>${s[2]}</p></li>`).join('')}</ol></div></section><section class="release-section"><h3><em>02</em>发布入口：绕过账号页面差异</h3><p class="release-muted">本机 MuMu 实测；以下为不同路径的观测值，不代表整条发布提速。</p><div class="release-metrics"><div><span>旧入口 · 云端失败记录</span><strong>36.9<small>秒</small></strong><p>缺少「主页」按钮，最终失败</p></div><div><span>备用入口 · 3 次实测中位数</span><strong>7.60<small>秒</small></strong><p>3 / 3 进入选素材页</p></div><div><span>发布器自动切换 · 3 次实测</span><strong>3<small>/ 3</small></strong><p>缺失分支触发后均进入选素材页</p></div></div><div class="release-bars"><span style="--bar:100%"><i></i>旧入口失败等待 36.9 s</span><span style="--bar:21%"><i></i>备用入口 7.60 s</span></div><p class="release-footnote">测试停在素材选择阶段，未提交内容；本机账号与远端 USHI 账号不同。实际发布耗时还包含推图、文案与商品关联。</p></section><section class="release-section"><h3><em>03</em>这次还更新了什么</h3><ul class="release-changes"><li><b>登录与权限</b><span>断网保留有效会话；权限自动刷新；当前发布批次可完成。</span></li><li><b>本地创作</b><span>自由新增品牌提示词；词库撤销、重做；素材整理结果复用。</span></li><li><b>应用更新</b><span>GitHub 自动检查，手动下载与安装；任务运行中禁止安装。</span></li></ul></section></article></div>`;
  }
  function mount() {
    stop();
    const canvas = document.querySelector('[data-release-canvas]');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const mask = document.createElement('canvas');
    mask.width = 400; mask.height = 180;
    const m = mask.getContext('2d', { willReadFrequently: true });
    m.font = '900 172px Arial'; m.textAlign = 'center'; m.fillText('1.1', 200, 155);
    const pixels = m.getImageData(0, 0, 400, 180).data;
    let frame = 0, visible = true, dead = false, w = 0, h = 0;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const resize = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect(); w = rect.width; h = rect.height;
      const dpr = Math.min(devicePixelRatio, 2); canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); draw(performance.now(), true); schedule();
    });
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule(); });
    function schedule() { if (!dead && !frame && visible && !document.hidden && canvas.isConnected) frame = requestAnimationFrame(draw); }
    function draw(time, initial = false) {
      if (!initial) frame = 0;
      if (!canvas.isConnected || dead || (!initial && (!visible || document.hidden)) || w < 10 || h < 10) return;
      const color = getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, w, h); ctx.strokeStyle = color; ctx.lineWidth = .75;
      const t = time / (reduced.matches ? 2800 : 1100);
      for (let row = 0; row < 42; row++) {
        const sy = Math.floor(row / 41 * 179), baseline = 12 + row / 41 * (h - 22);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const sx = Math.floor((x / w - .2) / .68 * 400);
          const ink = sx >= 0 && sx < 400 && pixels[(sy * 400 + sx) * 4 + 3] > 50;
          const depth = ink ? 24 + 15 * Math.sin(row * .12 + t) : 0;
          const y = baseline - depth + Math.sin(x / 100 + row * .14 + t) * (ink ? 4 : 1.2);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.globalAlpha = .22 + .48 * (Math.sin(row * .16 - t) + 1) / 2; ctx.stroke();
      }
      ctx.globalAlpha = 1; canvas.dataset.ready = '1';
      canvas.dataset.frame = String((Number(canvas.dataset.frame) || 0) + 1);
      schedule();
    }
    const visibility = () => schedule();
    resize.observe(canvas); observer.observe(canvas); document.addEventListener('visibilitychange', visibility);
    stop = () => { dead = true; cancelAnimationFrame(frame); resize.disconnect(); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }
  return { render, mount };
})();
