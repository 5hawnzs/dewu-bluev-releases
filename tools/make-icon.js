'use strict';
/**
 * 生成 Windows 打包图标：build/icon.png + build/icon.ico（多尺寸）。
 *
 * ★ 品牌标记只有**一个来源**：src/renderer/index.html 里 <span class="logo"> 的那个 SVG。
 *   为什么改成这样：这个标记一度有**三份来源**（标题栏 SVG / 登录卡 SVG / build/icon.ico），
 *   而换 logo 最容易「只改一处」—— 标题栏和登录卡不会同屏出现，少改一处肉眼根本看不出来。
 *   现在界面用它、打包图标也从它生成；uicheck 另有断言盯着「两处内联 SVG 逐字相同」。
 *
 * 用法：
 *   node tools/make-icon.js                  # 默认：从 index.html 的标记生成
 *   node tools/make-icon.js --source a.svg   # 换用外部源（试稿时用）
 *   node tools/make-icon.js --tight          # 先按透明边裁紧再缩放（源是大画布、标记只占中间时用）
 *   node tools/make-icon.js --out <目录>      # 换个输出目录（比对时用，不动 build/）
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

/** ICO 里要装的尺寸。256 排最前：Windows 优先挑最大的。 */
const SIZES = [256, 128, 64, 48, 32, 24, 16];

function parseArgs(argv) {
  const a = { source: '', tight: false, out: path.join(ROOT, 'build') };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--tight') a.tight = true;
    else if (s === '--source') a.source = argv[++i] || '';
    else if (s === '--out') a.out = argv[++i] || a.out;
  }
  return a;
}

/**
 * 从 index.html 抽出标题栏那个 logo 的 SVG，并把它变成一张可直接光栅化的独立文档：
 *   · 补 xmlns（HTML 内联的 SVG 没有命名空间，交给 librsvg 渲染必须补）
 *   · 把 width/height 换成 1024（原标签上是 17px 的显示尺寸，照它渲染只有 17px）
 *   · 保留原 viewBox —— 它已经是紧致框，不需要我们再算包围盒
 */
function svgFromIndex() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const m = html.match(/<span class="logo"[^>]*>\s*(<svg[\s\S]*?<\/svg>)/);
  if (!m) throw new Error('在 index.html 里找不到 <span class="logo"> 内的 <svg> —— 标记结构变了？');
  return m[1].replace(/<svg\b[^>]*>/, tag => {
    let t = tag.replace(/\s(?:width|height)="[^"]*"/g, '');
    if (!/xmlns=/.test(t)) t = t.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return t.replace('<svg', '<svg width="1024" height="1024"');
  });
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
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  let pipeline;
  if (args.source) {
    if (!fs.existsSync(args.source)) throw new Error(`找不到源文件：${args.source}`);
    console.log(`源        ${args.source}（外部指定）`);
    if (/\.svg$/i.test(args.source)) {
      const raw = fs.readFileSync(args.source, 'utf8')
        .replace(/<svg\b[^>]*>/, tag => tag.replace(/\s(?:width|height)="[^"]*"/g, '')
          .replace(/<svg/, '<svg width="1024" height="1024"'));
      pipeline = () => sharp(Buffer.from(raw)).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
    } else {
      pipeline = () => sharp(args.source).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
  } else {
    const svg = svgFromIndex();
    console.log(`源        src/renderer/index.html → <span class="logo"> 的 SVG（唯一来源）`);
    console.log(`viewBox   ${(svg.match(/viewBox="([^"]*)"/) || [, '（无）'])[1]}`);
    pipeline = () => sharp(Buffer.from(svg)).resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }

  let base = await pipeline().png().toBuffer();
  if (args.tight) {
    base = await sharp(base).trim({ threshold: 1 })
      .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    console.log('裁边      已按透明边裁紧');
  }
  console.log(`基准图    1024×1024, ${base.length} B`);

  const entries = [];
  for (const size of SIZES) {
    const png = await sharp(base).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer();
    entries.push({ size, png });
    console.log(`  ${String(size).padStart(3)}×${String(size).padEnd(3)}  ${String(png.length).padStart(6)} B`);
  }

  const outPng = path.join(outDir, 'icon.png');
  const outIco = path.join(outDir, 'icon.ico');
  fs.writeFileSync(outPng, await sharp(base).resize(512, 512).png({ compressionLevel: 9 }).toBuffer());
  const ico = buildIco(entries);
  fs.writeFileSync(outIco, ico);

  console.log(`写出      ${path.relative(ROOT, outPng)}  ${fs.statSync(outPng).size} B`);
  console.log(`写出      ${path.relative(ROOT, outIco)}  ${ico.length} B（${SIZES.length} 个尺寸）`);
}

main().catch(e => { console.error('失败：' + e.message); process.exit(1); });
