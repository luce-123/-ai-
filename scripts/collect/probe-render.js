'use strict';
/**
 * 渲染后端探针：实测哪些「spa」来源在浏览器渲染后真的能拿到价格。
 *
 * 用法：
 *   node probe-render.js                  # 探测 sources.json 里全部 spa 来源
 *   node probe-render.js --only=zhipu     # 只探某个 planId 片段
 *   node probe-render.js --keep           # 保留渲染后的 HTML 到 .render-out/ 便于排查
 */

const fs = require('fs');
const path = require('path');
const { createRenderer, findBrowser } = require('./lib/render');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const hit = argv.find((a) => a.startsWith(f + '='));
  return hit ? hit.slice(f.length + 1) : null;
};

const SOURCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')).sources;
const ONLY = valueOf('--only');
const KEEP = has('--keep');
const OUT_DIR = path.join(__dirname, '.render-out');

// 价格线索：¥123 / 123元 / 123 元/月
const PRICE_RE = /(?:[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]+)?)|(?:[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:元|块钱)(?:\s*\/\s*(?:月|年|季))?)/g;

function priceSnippets(text, limit = 8) {
  const out = [];
  const seen = new Set();
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text)) !== null && out.length < limit) {
    const at = m.index;
    const ctx = text.slice(Math.max(0, at - 26), Math.min(text.length, at + m[0].length + 20))
      .replace(/\s+/g, ' ').trim();
    if (seen.has(ctx)) continue;
    seen.add(ctx);
    out.push(ctx);
  }
  return out;
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

(async () => {
  const exe = findBrowser();
  console.log('浏览器: ' + (exe || '未找到'));
  if (!exe) process.exit(1);
  console.log('');

  let targets = SOURCES.filter((s) => s.status === 'spa' || s.status === 'noisy' || s.status === 'headline-only');
  if (ONLY) targets = SOURCES.filter((s) => s.planId.includes(ONLY));
  console.log('待探测 ' + targets.length + ' 个来源\n');

  const t0 = Date.now();
  const r = await createRenderer();
  console.log('浏览器就绪，端口 ' + r.port + '（耗时 ' + (Date.now() - t0) + 'ms）\n');

  if (KEEP) fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  for (const s of targets) {
    process.stdout.write('· 渲染 ' + s.planId + ' ... ');
    const res = await r.render(s.url, { waitFor: '元|¥|￥', settle: 2000, waitForMax: 10000, timeout: 35000 });
    const text = res.text || '';
    const snips = priceSnippets(text);
    const staticBytes = s.status === 'spa' ? '静态空壳' : '-';
    console.log(res.ok ? ('OK ' + res.ms + 'ms') : ('失败: ' + res.error));

    console.log('    HTML ' + (res.html.length / 1024).toFixed(1) + 'KB / 可见文本 ' +
      text.length + ' 字符' + (s.status === 'spa' ? '（' + staticBytes + '）' : ''));
    console.log('    价格候选 ' + snips.length + ' 条' +
      (res.notes.length ? '   [注: ' + res.notes.join('; ') + ']' : ''));
    snips.slice(0, 6).forEach((x) => console.log('      · ' + x));
    if (KEEP && res.html) {
      fs.writeFileSync(path.join(OUT_DIR, s.planId + '.html'), res.html);
      fs.writeFileSync(path.join(OUT_DIR, s.planId + '.txt'), text);
    }
    results.push({ planId: s.planId, status: s.status, ok: res.ok, ms: res.ms, htmlBytes: res.html.length, textLen: text.length, prices: snips.length, notes: res.notes, error: res.error });
    console.log('');
  }

  await r.close();

  console.log('=== 汇总 ===');
  console.log(pad('PLAN_ID', 34) + pad('原状态', 16) + pad('耗时', 8) + pad('HTML', 11) + pad('文本', 9) + '价格候选');
  results.forEach((x) => {
    console.log(pad(x.planId, 34) + pad(x.status, 16) + pad(x.ms + 'ms', 8) +
      pad((x.htmlBytes / 1024).toFixed(0) + 'KB', 11) + pad(x.textLen, 9) + x.prices);
  });

  const usable = results.filter((x) => x.prices > 0);
  console.log('\n渲染后能拿到价格文本的: ' + usable.length + ' / ' + results.length);
  if (KEEP) console.log('渲染产物已存到 ' + OUT_DIR);
})();
