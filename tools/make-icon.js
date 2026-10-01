'use strict';
/**
 * 生成 Windows 打包图标：build/icon.png + build/icon.ico（多尺寸）。
 *
 * 为什么要有这个脚本：
 *   build/icon.ico 是**二进制**，直接手改没法 review，也没法解释「它到底长什么样」。
 *   把「从源 SVG 到各尺寸 PNG/ICO」变成一条可重跑的命令，换 logo 时只改 SOURCE 一行。
 *
 * 用法：
 *   node tools/make-icon.js                      # 用下面的默认源
 *   node tools/make-icon.js <源.svg|源.png>      # 换一张
 *   node tools/make-icon.js --tight             # 打印紧致包围盒后退出（不写文件）
 *
 * ★ 小尺寸可读性：源字母标在 1024 画布里只占中间约一半，直接缩到 16px 会又小又细。
 *   所以先按 --pad 把紧致包围盒**裁出来**再缩放（V 在 16px 下也有 ~13px 宽）。
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const OUT_PNG = path.join(ROOT, 'build', 'icon.png');
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico');

const DEFAULT_SOURCE = 'E:/WORKBUDDY/2026-09-30-18-05-37/logo/letter/L2-深锚.svg';

/** ICO 里要装的尺寸。256 必须排在最前面：Windows 优先挑最大的。 */
const SIZES = [256, 128, 64, 48, 32, 24, 16];

/** 紧致包围盒四周留白比例（相对原画布）。0.08 是「小尺寸还能看清」和「不贴边」的折中。 */
const PAD = 0.08;

/**
 * 源 SVG 的紧致包围盒。
 * ★ 不是猜的：这是 L2-深锚.svg 里的 path 端点 ± stroke-width/2 算出来的 ——
 *   path 是 `M300 308 L512 728 L724 308`，stroke-width=96 且 linecap=round，
 *   所以左边界 = 300 - 48、右边界 = 724 + 48、上边界 = 308 - 48、下边界 = 728 + 48。
 *   圆头端点会超出线段端点，所以必须减这个 48，否则圆头会被切掉。
 */
const BBOX = { x: 252, y: 260, w: 520, h: 516 };

function parseArgs(argv) {
  const a = { source: DEFAULT_SOURCE, tight: false };
  for (const s of argv) {
    if (s === '--tight') a.tight = true;
    else if (!s.startsWith('--')) a.source = s;
  }
  return a;
}

/** 把 SVG 里的 viewBox 换成紧致框（只针对本项目的字母标；PNG 源走另一条路） */
function tightViewBox(svgText) {
  const p = PAD * 1024;
  const vb = [BBOX.x - p, BBOX.y - p, BBOX.w + p * 2, BBOX.h + p * 2].map(n => Math.round(n * 100) / 100);
  if (!/viewBox\s*=\s*"[^"]*"/.test(svgText)) throw new Error('源 SVG 里没有 viewBox，无法收紧');
  return { text: svgText.replace(/viewBox\s*=\s*"[^"]*"/, `viewBox="${vb.join(' ')}"`), viewBox: vb };
}

/** 手写 ICO：ICONDIR + N × ICONDIRENTRY + 各尺寸的 PNG 数据（Vista 起支持 PNG 压缩的 ICO） */
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);              // reserved
  head.writeUInt16LE(1, 2);              // type: 1 = icon
  head.writeUInt16LE(entries.length, 4); // count

  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b);      // 256 要写 0
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1);
    dir.writeUInt8(0, b + 2);                            // 调色板数
    dir.writeUInt8(0, b + 3);                            // reserved
    dir.writeUInt16LE(1, b + 4);                         // planes
    dir.writeUInt16LE(32, b + 6);                        // 位深
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });

  return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.source)) throw new Error(`找不到源文件：${args.source}`);

  const isSvg = /\.svg$/i.test(args.source);
  let pipeline;
  if (isSvg) {
    const raw = fs.readFileSync(args.source, 'utf8');
    const { text, viewBox } = tightViewBox(raw);
    console.log(`源        ${args.source}`);
    console.log(`紧致 viewBox  ${viewBox.join(' ')}`);
    if (args.tight) return;
    // density 192 ≈ 2 倍超采样：圆头端点的抗锯齿靠它，直接按 1024 光栅化会有毛边
    pipeline = () => sharp(Buffer.from(text), { density: 192 }).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  } else {
    console.log(`源        ${args.source}（位图，按 alpha 裁边）`);
    if (args.tight) return;
    pipeline = () => sharp(args.source).trim({ threshold: 1 }).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }

  const base = await pipeline().png().toBuffer();
  console.log(`基准图    1024×1024, ${base.length} B`);

  const entries = [];
  for (const size of SIZES) {
    const png = await sharp(base).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
    entries.push({ size, png });
    console.log(`  ${String(size).padStart(3)}×${String(size).padEnd(3)}  ${String(png.length).padStart(6)} B`);
  }

  fs.writeFileSync(OUT_PNG, await sharp(base).resize(512, 512).png({ compressionLevel: 9 }).toBuffer());
  const ico = buildIco(entries);
  fs.writeFileSync(OUT_ICO, ico);

  console.log(`写出      ${path.relative(ROOT, OUT_PNG)}  ${fs.statSync(OUT_PNG).size} B`);
  console.log(`写出      ${path.relative(ROOT, OUT_ICO)}  ${ico.length} B（${SIZES.length} 个尺寸）`);
}

main().catch(e => { console.error('失败：' + e.message); process.exit(1); });
