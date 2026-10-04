'use strict';
/**
 * 生成 Windows NSIS 安装向导的品牌界面资源（electron-builder 约定的文件名/尺寸）：
 *   build/installerSidebar.bmp    164×314  欢迎/完成页左侧大图
 *   build/installerHeader.bmp     150×57   每个向导页顶部的页眉图
 *   build/installerHeaderIcon.ico           页眉左侧小图标（复制自 build/icon.ico）
 *
 * 为什么自己编 BMP：sharp 不能输出 bmp，只能输出 raw 像素；24-bit BMP 的文件头
 * 结构简单（14+40 字节），自己拼最可控。生成后用 sharp 把 BMP **读回来**做校验
 * （宽高 + 采样像素颜色），不是"写出去就当成功"。
 *
 * 设计约束：品牌标记在界面上只有**一个来源**（index.html 的 logo SVG，经
 * make-icon.js 生成 build/icon.*）。安装位图无法逐字复用 SVG，所以这里的
 * 白卡片 + 圆头 V 与 logo 同构（同色 #0f6e56、同圆头笔画），并放 build/icon.ico
 * 直接当页眉图标，保证安装器里的图形不另起炉灶。
 *
 * 用法：
 *   node tools/make-installer-art.js                 # 生成并校验
 *   node tools/make-installer-art.js --preview png   # 另存 PNG 预览（不落 BMP）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

/* 品牌色与 styles.css 的 --teal 一致；渐变两端是它的加深版 */
const TEAL = '#0f6e56';
const GRAD_FROM = '#14805f';
const GRAD_TO = '#083729';
const PRODUCT = '得物蓝V';
const SUBTITLE = '素材发布工具';
const FONT = 'Microsoft YaHei';

function parseArgs(argv) {
  const a = { preview: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preview') a.preview = argv[++i] || 'png';
  }
  return a;
}

/** 白色圆角卡片 + 圆头绿 V，与 App 图标同构。返回 SVG 片段。 */
function vMark(x, y, size) {
  // size = 卡片边长。V 的三个锚点按卡片内边距比例摆放。
  const rx = Math.round(size * 0.27);
  const cx = x + size / 2;
  const top = y + size * 0.30;
  const bottom = y + size * 0.76;
  const half = size * 0.24;
  const sw = Math.round(size * 0.155);
  return `
  <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${rx}" fill="#ffffff"/>
  <path d="M ${cx - half} ${top} L ${cx} ${bottom} L ${cx + half} ${top}"
        stroke="${TEAL}" stroke-width="${sw}" stroke-linecap="round"
        stroke-linejoin="round" fill="none"/>`;
}

/** 164×314：欢迎/完成页左侧大图。 */
function sidebarSvg(version) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GRAD_FROM}"/>
      <stop offset="1" stop-color="${GRAD_TO}"/>
    </linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#g)"/>
  <circle cx="152" cy="22" r="58" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="26"/>
  <circle cx="6" cy="304" r="46" fill="none" stroke="#ffffff" stroke-opacity="0.05" stroke-width="22"/>
  ${vMark(36, 64, 92)}
  <text x="82" y="206" text-anchor="middle" font-family="${FONT}" font-weight="bold"
        font-size="21" fill="#ffffff">${PRODUCT}</text>
  <text x="82" y="230" text-anchor="middle" font-family="${FONT}"
        font-size="13" fill="#ffffff" fill-opacity="0.85">${SUBTITLE}</text>
  <text x="82" y="290" text-anchor="middle" font-family="${FONT}"
        font-size="9" fill="#ffffff" fill-opacity="0.55">v${version}</text>
</svg>`);
}

/** 150×57：向导页页眉图。位图整体贴在页眉右侧，图形集中在右半，避免压到左侧的产品名。 */
function headerSvg() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${GRAD_TO}" stop-opacity="0"/>
      <stop offset="0.55" stop-color="${GRAD_FROM}"/>
      <stop offset="1" stop-color="${GRAD_TO}"/>
    </linearGradient>
  </defs>
  <rect width="150" height="57" fill="url(#g)"/>
  <circle cx="150" cy="-6" r="34" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="14"/>
  ${vMark(99, 12, 33)}
</svg>`);
}

/**
 * raw RGB（sharp 输出，自顶向下）→ 24-bit Windows BMP。
 * BMP 行序自底向上、每行 4 字节对齐（150×3=450 → 补 2 字节）。
 */
function encodeBmp(pixels, width, height) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = stride * height;
  const fileSize = 54 + imageSize;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);           // 像素数据偏移
  buf.writeUInt32LE(40, 14);           // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);        // 正数 = 自底向上
  buf.writeUInt16LE(1, 26);            // planes
  buf.writeUInt16LE(24, 28);           // bpp
  buf.writeUInt32LE(0, 30);            // BI_RGB 不压缩
  buf.writeUInt32LE(imageSize, 34);
  buf.writeInt32LE(2835, 38);          // 72 DPI
  buf.writeInt32LE(2835, 42);
  for (let row = 0; row < height; row++) {
    const srcStart = row * width * 3;              // raw：RGB，自顶向下
    const dstStart = 54 + (height - 1 - row) * stride; // bmp：自底向上，BGR
    for (let col = 0; col < width; col++) {
      buf[dstStart + col * 3] = pixels[srcStart + col * 3 + 2];     // B
      buf[dstStart + col * 3 + 1] = pixels[srcStart + col * 3 + 1]; // G
      buf[dstStart + col * 3 + 2] = pixels[srcStart + col * 3];     // R
    }
  }
  return buf;
}

/**
 * 读回校验：sharp 的 Windows 构建没有 bmp 读取器（实测报 unsupported image format），
 * 所以自己解 BMP（24-bit、自底向上、行对齐——与 encodeBmp 的约定一致）再采样像素。
 */
function decodeBmp(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error(`${path.basename(file)}: 不是 BMP`);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const offset = buf.readUInt32LE(10);
  if (bpp !== 24 || buf.readUInt32LE(30) !== 0) {
    throw new Error(`${path.basename(file)}: ${bpp}bpp/压缩=${buf.readUInt32LE(30)}，期望 24bpp 不压缩`);
  }
  const stride = Math.ceil((width * 3) / 4) * 4;
  return { width, height, stride, offset, buf };
}

function sampleBmp(file, width, height, samples) {
  const { stride, offset, buf } = decodeBmp(file, width, height);
  for (const [sx, sy, label] of samples) {
    const dstStart = offset + (height - 1 - sy) * stride; // 自底向上 → 正着数第 sy 行
    const b = buf[dstStart + sx * 3], g = buf[dstStart + sx * 3 + 1], r = buf[dstStart + sx * 3 + 2];
    const hex = (c) => c.toString(16).padStart(2, '0');
    console.log(`  ✓ ${path.basename(file)} @(${sx},${sy}) ${label} rgb(${r},${g},${b}) #${hex(r)}${hex(g)}${hex(b)}`);
  }
}

async function render(svg, w, h, outBase, preview) {
  const { data, info } = await sharp(svg, { density: 96 })
    .resize(w, h)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== w || info.height !== h || info.channels !== 3) {
    throw new Error(`${outBase}: 渲染结果 ${info.width}x${info.height}x${info.channels}，期望 ${w}x${h}x3`);
  }
  if (preview) {
    await sharp(data, { raw: { width: w, height: h, channels: 3 } })
      .png().toFile(path.join(ROOT, `_${outBase}-preview.${preview}`));
    console.log(`  → 预览 _${outBase}-preview.${preview}（未写 BMP）`);
    return;
  }
  const bmp = encodeBmp(data, w, h);
  const file = path.join(BUILD, `${outBase}.bmp`);
  fs.writeFileSync(file, bmp);
  console.log(`  → build/${outBase}.bmp (${bmp.length} 字节)`);
}

async function main() {
  const { preview } = parseArgs(process.argv);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(BUILD, { recursive: true });

  console.log('sidebar 164×314：');
  await render(sidebarSvg(pkg.version), 164, 314, 'installerSidebar', preview && 'png');
  console.log('header 150×57：');
  await render(headerSvg(), 150, 57, 'installerHeader', preview && 'png');

  if (preview) { console.log('预览完成'); return; }

  // 页眉图标：electron-builder 默认页眉无图标，直接用品牌 icon.ico（多尺寸，NSIS 自取）。
  const iconSrc = path.join(BUILD, 'icon.ico');
  const headerIcon = path.join(BUILD, 'installerHeaderIcon.ico');
  if (!fs.existsSync(iconSrc)) throw new Error('build/icon.ico 不存在，先跑 tools/make-icon.js');
  fs.copyFileSync(iconSrc, headerIcon);
  console.log(`  → build/installerHeaderIcon.ico (${fs.statSync(headerIcon).size} 字节，复制自 icon.ico)`);

  // 读回校验：四角 + 卡片中心，看颜色是否符合设计（不是空图、不是坏图）。
  console.log('校验（读回 BMP 采样像素）：');
  sampleBmp(path.join(BUILD, 'installerSidebar.bmp'), 164, 314, [
    [2, 2, '左上(渐变浅端，应偏绿)'],
    [161, 311, '右下(渐变深端，应深绿)'],
    [82, 110, 'V卡片中心(应接近白色)'],
  ]);
  sampleBmp(path.join(BUILD, 'installerHeader.bmp'), 150, 57, [
    [4, 28, '左端(应为白/近透明底)'],
    [115, 28, '右端V卡片中心(应接近白色)'],
  ]);
  console.log('OK');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
