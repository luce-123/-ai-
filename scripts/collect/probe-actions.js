#!/usr/bin/env node
'use strict';
/**
 * 交互路径探测：自动找出「点哪个 tab / 滚到哪里才会出价格」。
 *
 * 起因：一批来源的价格不在首屏 DOM 里 —— 有的在定价 tab 后面（Cursor 的 Pro+/Ultra）、
 * 有的要切换套餐线才显示（腾讯云活动页）、有的要滚动懒加载。
 * 靠肉眼翻页面猜交互成本太高，所以让工具自己把候选点一遍再看结果。
 *
 * 用法：
 *   node probe-actions.js tencent-general-token-plan
 *   node probe-actions.js https://cursor.com/cn/pricing --max=6
 *   node probe-actions.js tencent-general-token-plan --keep
 *   node probe-actions.js tencent-general-token-plan --click="text=通用 Token Plan"
 *   node probe-actions.js tencent-hy-token-plan --dump
 *
 * --click 是「定点提问」：自动试探要靠碰运气（候选可能几十个，还受 --max 限制），
 * 一旦肉眼看出该点哪个 tab，直接点它、只看这一个结果最快。
 */

const fs = require('fs');
const path = require('path');
const { createRenderer, findBrowser } = require('./lib/render');

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const valueOf = (f) => {
  const hit = argv.find((a) => a.startsWith(f + '='));
  return hit ? hit.slice(f.length + 1) : null;
};
const TARGET = positional[0];
const MAX = Number(valueOf('--max') || 8);
const KEEP = argv.includes('--keep');
const CLICK = valueOf('--click');
const DUMP = argv.includes('--dump');

if (!TARGET) {
  console.error('用法: node probe-actions.js <planId 或 URL> [--max=8] [--keep] [--click=目标] [--dump]');
  process.exit(1);
}

const SOURCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')).sources;
const matched = SOURCES.find((s) => s.planId === TARGET);
const URL = matched ? matched.url : TARGET;
const OUT_DIR = path.join(__dirname, '.render-out');

/** 抽取页面里出现的所有金额（人民币与外币都算） */
function priceSet(text) {
  const out = new Set();
  const re = /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)|([0-9][0-9,]*(?:\.[0-9]+)?)\s*元|\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = m[1] || m[2] || m[3];
    if (v) out.add(v.replace(/,/g, ''));
  }
  return out;
}

/** 页面内脚本：收集可见的、像 tab / 切换按钮的元素文本 */
const COLLECT_CANDIDATES = [
  '(function(){',
  'var out=[],seen={};',
  'var all=document.querySelectorAll(\'button,[role="tab"],[role="button"],a,[class*="tab"],[class*="Tab"],[class*="switch"],[class*="segment"],[class*="toggle"]\');',
  'for(var i=0;i<all.length;i++){',
  '  var t=(all[i].textContent||"").replace(/\\s+/g," ").trim();',
  '  if(!t||t.length<2||t.length>14) continue;',
  '  var r=all[i].getBoundingClientRect();',
  '  if(r.width<2||r.height<2) continue;',
  '  if(seen[t]) continue; seen[t]=1; out.push(t);',
  '  if(out.length>=60) break;',
  '}',
  'return out;',
  '})()',
].join('');

const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

(async () => {
  const exe = findBrowser();
  if (!exe) { console.error('未找到本机 Chrome/Edge'); process.exit(1); }
  console.log('目标: ' + URL);
  console.log('浏览器: ' + path.basename(exe) + '\n');

  const r = await createRenderer();
  try {
    // 基线：不点任何东西
    const base = await r.render(URL, { waitFor: '元|¥|￥|\\$[0-9]', settle: 2000, waitForMax: 10000, eval: COLLECT_CANDIDATES });
    const basePrices = priceSet(base.text || '');
    const cands = Array.isArray(base.extra) ? base.extra : [];
    console.log('基线: 可见文本 ' + (base.text || '').length + ' 字符，金额 ' + basePrices.size + ' 个');
    console.log('候选可点元素 ' + cands.length + ' 个：' + cands.slice(0, 12).join(' / ') + (cands.length > 12 ? ' …' : ''));
    if (KEEP) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'actions-base.txt'), base.text || '');
    }
    console.log('');

    if (DUMP) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'actions-base.txt'), base.text || '');
      console.log('基线可见文本已写入 .render-out\\actions-base.txt（未点击任何元素）');
      return;
    }

    if (CLICK) {
      console.log('=== 定点点击：' + CLICK + ' ===');
      const res = await r.render(URL, {
        actions: [{ click: CLICK, wait: 1500 }],
        waitFor: '元|¥|￥|\\$[0-9]',
        settle: 1500,
        waitForMax: 8000,
      });
      const prices = priceSet(res.text || '');
      const added = [...prices].filter((p) => !basePrices.has(p));
      const removed = [...basePrices].filter((p) => !prices.has(p));
      console.log('点击日志: ' + ((res.notes || []).find((n) => /点击/.test(n)) || '(无)'));
      console.log('金额 ' + prices.size + ' 个（基线 ' + basePrices.size + ' 个）');
      console.log('新增: ' + (added.length ? added.join(', ') : '—'));
      console.log('消失: ' + (removed.length ? removed.join(', ') : '—'));
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const fn = 'actions-click-' + String(CLICK).replace(/[\\/:*?"<>|\s=]/g, '_').slice(0, 24) + '.txt';
      fs.writeFileSync(path.join(OUT_DIR, fn), res.text || '');
      console.log('点击后可见文本 → .render-out\\' + fn);
      return;
    }

    if (!cands.length) {
      console.log('页面上没找到可点的 tab —— 该来源的问题不在这里（可能是登录墙或纯静态）。');
      return;
    }

    console.log('=== 逐个点击试探（每个候选都是全新渲染，保证干净状态）===');
    console.log(pad('候选', 20) + pad('金额', 8) + pad('新增金额', 12) + '变化');
    const results = [];
    for (const c of cands.slice(0, MAX)) {
      const res = await r.render(URL, {
        actions: [{ click: 'text=' + c, wait: 1200 }],
        waitFor: '元|¥|￥|\\$[0-9]',
        settle: 1500,
        waitForMax: 8000,
      });
      const prices = priceSet(res.text || '');
      const added = [...prices].filter((p) => !basePrices.has(p));
      const removed = [...basePrices].filter((p) => !prices.has(p));
      const clickNote = (res.notes || []).find((n) => /点击/.test(n)) || '';
      const failed = /未命中/.test(clickNote);
      results.push({ c, count: prices.size, added, removed, failed, clickNote });
      console.log(pad(c, 20) + pad(failed ? '点击失败' : prices.size, 8) +
        pad(added.length ? '+' + added.slice(0, 4).join(',') : '—', 12) +
        (added.length ? '★ 出现新金额' : (removed.length ? '消失: ' + removed.slice(0, 3).join(',') : '')));
      if (KEEP && !failed) {
        fs.writeFileSync(path.join(OUT_DIR, 'actions-' + c.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 30) + '.txt'), res.text || '');
      }
    }

    const useful = results.filter((x) => x.added.length);
    console.log('');
    if (useful.length) {
      console.log('建议写进 sources.json 的交互：');
      useful.forEach((u) => {
        console.log('  "' + u.c + '" → 出现 ' + u.added.length + ' 个新金额: ' + u.added.join(', '));
      });
      console.log('\n配置写法： "render": { "actions": [{ "click": "text=' + useful[0].c + '", "wait": 1200 }], "waitFor": "..." }');
    } else {
      console.log('所有候选点完都没有新金额出现 —— 价格很可能不在这个页面上（需换定价页或登录后人工录入）。');
    }
  } finally {
    await r.close();
  }
})();
