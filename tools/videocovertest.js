'use strict';
const assert = require('assert'), { PNG } = require('pngjs');
const cover = require('../src/main/services/videocover');
const box = { x1: 0, y1: 0, x2: 100, y2: 100 };
function png(draw) {
  const p = new PNG({ width: 100, height: 100 });
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4, n = draw(x, y); p.data[i] = p.data[i + 1] = p.data[i + 2] = n; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}
assert(!cover.analyse(png(() => 0), box).ok);
assert(!cover.analyse(png(() => 255), box).ok);
assert(!cover.analyse(png((_x,y) => y > 70 ? 255 : 0), box, .68).ok);
assert(cover.analyse(png((x,y) => (x+y)%50), box).ok);
assert.throws(() => cover.analyse(null, box));
assert.throws(() => cover.analyse(png(() => 0), { ...box, x2: 200 }));
console.log('PASS 黑场、纯白、白字遮罩不能通过；有细节暗色素材可通过；截图缺失和越界明确失败');
