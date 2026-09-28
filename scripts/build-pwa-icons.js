'use strict';
/**
 * PWA 图标生成器 —— 零依赖，用 Node 内置 zlib 手写 PNG。
 *
 * 为什么不装 sharp / 不装 Pillow：
 *   为了出几张纯色块图标去拉一个带原生二进制的包，不值当。
 *   图标本身就是「一个渐变底 + 三根柱子」，用 SDF（有向距离场）画
 *   圆角矩形，边缘天然是抗锯齿的 —— 比逐像素画完再降采样还干净。
 *
 * 用法：node build-pwa-icons.js [--out=app/icons]
 *
 * 产出：
 *   icon-192.png            Android / Chrome 常规尺寸
 *   icon-512.png            大尺寸，Chrome 安装弹窗用
 *   icon-maskable-512.png   可遮罩图标：图形缩到安全区，系统随便裁都不破
 *   apple-touch-icon.png    iOS「添加到主屏幕」180×180
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ───────────────── PNG 编码（最小实现：RGBA8 / 无隔行） ───────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, px) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter type 0 = None
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────── 画布 ───────────────── */

class Canvas {
  constructor(size) {
    this.w = size; this.h = size;
    this.px = Buffer.alloc(size * size * 4);   // 全透明起步
  }

  /** 在 bbox 内按 alpha 函数上色（source-over） */
  paint(x0, y0, x1, y1, color, alphaAt) {
    const [r, g, b, baseA] = color;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) {
        const a = alphaAt(x + 0.5, y + 0.5) * baseA;
        if (a <= 0) continue;
        const i = (y * this.w + x) * 4;
        const p = this.px;
        const ia = 1 - a;
        p[i] = p[i] * ia + r * a;
        p[i + 1] = p[i + 1] * ia + g * a;
        p[i + 2] = p[i + 2] * ia + b * a;
        p[i + 3] = p[i + 3] * ia + 255 * a;
      }
    }
  }

  /** 圆角矩形：SDF 判内外，0.5px 过渡即抗锯齿 */
  roundRect(x, y, w, h, r, color) {
    const rr = Math.min(r, w / 2, h / 2);
    this.paint(x, y, x + w, y + h, color, (px, py) => {
      const dx = Math.max(x + rr - px, 0, px - (x + w - rr));
      const dy = Math.max(y + rr - py, 0, py - (y + h - rr));
      const d = Math.hypot(dx, dy) - rr;
      return Math.max(0, Math.min(1, 0.5 - d));
    });
  }

  /** 垂直线性渐变铺满整块 */
  fillGradient(c1, c2) {
    for (let y = 0; y < this.h; y++) {
      const t = y / (this.h - 1);
      const r = c1[0] + (c2[0] - c1[0]) * t;
      const g = c1[1] + (c2[1] - c1[1]) * t;
      const b = c1[2] + (c2[2] - c1[2]) * t;
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 4;
        this.px[i] = r; this.px[i + 1] = g; this.px[i + 2] = b; this.px[i + 3] = 255;
      }
    }
  }

  toPNG() { return encodePNG(this.w, this.h, this.px); }
}

/* ───────────────── 图形 ───────────────── */

const BRAND = [0x4b, 0x3b, 0xff];
const BRAND_DEEP = [0x2f, 0x22, 0xd6];
const ACCENT = [0xff, 0x2d, 0x78];
const WHITE = [0xff, 0xff, 0xff];

/**
 * 三根柱子：矮 → 中 → 高，最高的那根用 accent 色。
 * 语义就是本 App 在做的事：把一堆套餐按性价比排开，标出赢的那个。
 *
 * @param {Canvas} c
 * @param {number} scale 图形整体占画布的比例（maskable 版要缩到安全区）
 */
function drawBars(c, scale) {
  const S = c.w;
  const box = S * scale;
  const off = (S - box) / 2;

  const barW = box * 0.155;
  const gap = box * 0.075;
  const totalW = barW * 3 + gap * 2;
  const x0 = off + (box - totalW) / 2;
  const baseline = off + box * 0.80;          // 柱子底线
  const heights = [box * 0.26, box * 0.40, box * 0.56];
  const colors = [
    [...WHITE, 0.72],
    [...WHITE, 0.88],
    [...ACCENT, 1],
  ];

  heights.forEach((hh, i) => {
    const x = x0 + i * (barW + gap);
    c.roundRect(x, baseline - hh, barW, hh, barW * 0.30, colors[i]);
  });

  // 基线：一条细横杠，把三根柱子"落地"
  c.roundRect(x0 - box * 0.02, baseline + box * 0.045, totalW + box * 0.04, box * 0.038, box * 0.019, [...WHITE, 0.95]);
}

function build(size, scale) {
  const c = new Canvas(size);
  c.fillGradient(BRAND, BRAND_DEEP);
  drawBars(c, scale);
  return c.toPNG();
}

/* ───────────────── 主流程 ───────────────── */

const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith('--out='));
const outDir = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(__dirname, '..', 'app', 'icons'));
fs.mkdirSync(outDir, { recursive: true });

// maskable 的安全区：系统可能裁掉边缘 10%，图形必须缩在中心 80% 圆内。
// 0.62 而不是 0.80 —— 圆内还要留余量，不然柱子顶角会被圆形遮罩啃掉。
const targets = [
  { name: 'icon-192.png', size: 192, scale: 0.72 },
  { name: 'icon-512.png', size: 512, scale: 0.72 },
  { name: 'icon-maskable-512.png', size: 512, scale: 0.62 },
  { name: 'apple-touch-icon.png', size: 180, scale: 0.72 },
];

for (const t of targets) {
  const buf = build(t.size, t.scale);
  fs.writeFileSync(path.join(outDir, t.name), buf);
  console.log('  ' + t.name.padEnd(24) + t.size + '×' + t.size + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
}
console.log('图标已生成 → ' + outDir);
