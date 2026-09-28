#!/usr/bin/env node
'use strict';
/**
 * 结构化报价探针：扫一遍所有来源，看谁页面里内嵌了 schema.org / JS 对象形式的报价。
 *
 * 起因：Cursor 那单活本来是"要交互才拿得到价格"的难题，结果发现页面内嵌的
 *   schema.org 报价里全量都在（Hobby $0 / Pro $20 / Pro+ $60 / Ultra $200），
 *   而且静态 HTML 里就有 —— 比点 tab 又稳又省事。既然这条路这么好走，
 *   就该把它当成常规武器：**先问每个来源"有没有结构化数据"，而不是逐个去啃交互**。
 *
 * 用法：
 *   node probe-jsonld.js                 # 全部来源（该渲染的会渲染）
 *   node probe-jsonld.js --only=cursor   # 只扫 planId 含该片段的
 *   node probe-jsonld.js --no-render     # 只扫静态 HTML，不开浏览器（快）
 *   node probe-jsonld.js --keep          # 把命中来源的 HTML 落到 .render-out/
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, fetchAll } = require('./lib/fetch');
const { createRenderer } = require('./lib/render');
const { flatten, objectsIn, numbersOf, strOf, markContainers } = require('./lib/jsonwalk');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const hit = argv.find((a) => a.startsWith(f + '='));
  return hit ? hit.slice(f.length + 1) : null;
};

const ONLY = valueOf('--only');
const NO_RENDER = has('--no-render');
const KEEP = has('--keep');
const OUT_DIR = path.join(__dirname, '.render-out');

const ROOT = path.join(__dirname, '..', '..');
const SOURCES = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')).sources;
const DATASET = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'plans.json'), 'utf8'));
const planById = {};
DATASET.plans.forEach((p) => { planById[p.id] = p; });

/**
 * 常见的「价格」字段名。两个用途：
 *   ① 预筛：页面压根没有这类字段，就别费劲扫了（也让"0 条"这个结论有依据）
 *   ② 报告：页面用的是哪种命名，便于判断"没扫到"是页面没有还是我们的口径漏了
 */
const PRICE_KEYS = [
  'price', 'amount', 'salePrice', 'lowPrice', 'highPrice', 'listPrice',
  'unitAmount', 'discountPrice', 'originalPrice', 'currentPrice',
  'payPrice', 'offerPrice', 'priceValue', 'monthlyPrice', 'yearlyPrice',
];

/**
 * 「弱」价格字段名 —— 单看太通用，必须佐证才认。
 *
 * 起因：华为云的价格对象长这样（键名是 current / origin 这种通用词）：
 *   {"price":{"currency":"¥","origin":59,"current":59,"unit":"/月"}}
 * 不在表里 → 整个来源被误判成「没有结构化报价」（假阴性）。
 * 但直接放进来又会出事：`"current":59` 这种字段名在任意页面都可能出现，
 * 于是随便一个对象都会被当成报价。
 * 所以给它们加一道佐证：**同一个对象里必须同时出现 currency 或 unit**。
 */
const PRICE_KEYS_WEAK = ['current', 'origin', 'deletePrice'];
const PRICE_KEY_G = new RegExp('"(' + PRICE_KEYS.concat(PRICE_KEYS_WEAK).join('|') + ')"\\s*:', 'gi');

/** 从压平后的片段里取字段，并派生出"这像不像一条报价"的判断 */
function readObject(o) {
  o.pr = numbersOf(o.text, PRICE_KEYS)
    // 弱字段名要佐证：同一个对象里有 currency 或 unit 才认（见 PRICE_KEYS_WEAK 的注释）
    || (/"(?:currency|unit)"\s*:\s*"/.test(o.text) ? numbersOf(o.text, PRICE_KEYS_WEAK) : null);
  o.name = strOf(o.text, ['name', 'planName', 'title', 'productName']);
  o.currency = strOf(o.text, ['priceCurrency', 'currency']);
  o.isOffer = /"@type"\s*:\s*"Offer"/.test(o.text);
  // 「像一个档位报价」：既有名字又有数字价。容器过滤要用这个判据。
  o.unit = !!(o.pr && o.name);
  return o;
}

/**
 * 扫一个 HTML，收集所有像「档位报价」的对象。
 * 不只看 @type:Offer —— 很多站点只写成 {"name":"Pro","price":20}，
 * 这种没有 @type 的更常见，漏掉等于白扫。
 * @returns {{offers:Array, keys:string[], scanned:boolean}}
 */
function scanOffers(html) {
  const flat = flatten(html);

  // 预筛：这页到底用没用"价格"类字段名。没有就直接收工 ——
  // 这样报出来的 0 是"页面确实没有"，而不是"我们没找到"。
  const keys = new Set();
  let km;
  PRICE_KEY_G.lastIndex = 0;
  while ((km = PRICE_KEY_G.exec(flat)) !== null) keys.add(km[1]);
  const keyList = Array.from(keys);
  if (!keyList.length) return { offers: [], keys: [], scanned: false };

  // 扫出所有对象（含嵌套），派生字段，再把"外壳对象"标出来
  // （容器过滤的判据与实现见 lib/jsonwalk.js 的 markContainers）
  const objs = objectsIn(flat).map(readObject);
  markContainers(objs, (o) => o.unit);

  const out = [];
  const seen = new Set();
  for (const o of objs) {
    if (o.container || !o.pr) continue;
    // 有 @type:Offer 的收；没有 @type 的必须有名字才收
    // （否则会是页面上任意一个带 price 的杂项对象）
    if (!o.isOffer && !o.name) continue;
    const key = (o.name || '(无名字)') + '|' + o.pr.value + '|' + (o.currency || '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: o.name || '(无名字)',
      price: o.pr.value,
      priceKey: o.pr.key,
      currency: o.currency,
      isOffer: o.isOffer,
      raw: o.text.slice(0, 120),
    });
  }
  return { offers: out, keys: keyList, scanned: true };
}

/** 这些报价名能不能对上数据集里的档位名 */
function matchTiers(planId, offers) {
  const plan = planById[planId];
  if (!plan) return { hit: [], miss: offers.map((o) => o.name) };
  const names = plan.tiers.map((t) => t.name);
  const hit = [];
  const miss = [];
  offers.forEach((o) => {
    const n = String(o.name).toLowerCase();
    const found = names.some((x) => {
      const xl = String(x).toLowerCase();
      return xl === n || xl.indexOf(n) !== -1 || n.indexOf(xl) !== -1;
    }) || new RegExp('(^|[^a-z])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)', 'i')
      .test(names.join(' '));
    (found ? hit : miss).push(o.name);
  });
  return { hit, miss };
}

const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

(async () => {
  let targets = SOURCES;
  if (ONLY) targets = SOURCES.filter((s) => s.planId.includes(ONLY));
  if (NO_RENDER) targets = targets.filter((s) => !s.render);
  console.log('待扫描 ' + targets.length + ' 个来源' + (NO_RENDER ? '（--no-render，只走静态）' : '') + '\n');

  // 渲染单例：**必须缓存 Promise，不能缓存实例**。
  // 若写成「if (!renderer) renderer = await createRenderer()」，并发 4 个来源会同时看到
  // renderer 还是 null，于是各起一个 Chrome —— 实测确实起了 4 个，而只有最后一个被 close()，
  // 其余的把 Node 的事件循环钉住，表现为「活干完了、进程却不退」。
  // renderers 数组只是让收尾时"关掉全部"这件事显式可见。
  let rendererPromise = null;
  const renderers = [];
  const getRenderer = () => {
    if (!rendererPromise) {
      rendererPromise = createRenderer().then((r) => { renderers.push(r); return r; });
    }
    return rendererPromise;
  };
  // 渲染并发闸门：一个浏览器同时渲染太多页面会互相拖慢
  const gate = { free: 2, queue: [] };
  const withSlot = async (fn) => {
    if (gate.free <= 0) await new Promise((r) => gate.queue.push(r));
    gate.free--;
    try { return await fn(); } finally { gate.free++; const n = gate.queue.shift(); if (n) n(); }
  };
  // 熔断计数：偶发一次超时是正常的（对方页面抽风），连续多次就不是页面问题了
  const RENDER_FAIL_LIMIT = 3;
  let renderTimeouts = 0;
  let renderDisabled = false;
  let done = 0;

  const results = await fetchAll(targets.map((s) => async () => {
    const rec = { planId: s.planId, status: s.status, mode: '静态', offers: [], note: '', bytes: 0 };
    let html = '';
    try {
      if (s.render && !renderDisabled) {
        const r = await getRenderer();
        const o = await withSlot(() => r.render(s.url, {
          waitFor: s.render.waitFor || '元|¥|￥',
          settle: s.render.settle == null ? 2000 : s.render.settle,
          waitForMax: s.render.waitForMax || 12000,
          timeout: s.render.timeout || 35000,
          actions: s.render.actions,
        }));
        html = o.html || '';
        rec.mode = '渲染';
        rec.note = (o.notes || []).join('; ');
        // 渲染器现在每次调用都有硬上限，理论上不会挂；但如果连续多个来源都在超时上倒下，
        // 那就不是"某个页面慢"，而是浏览器本身出了问题 —— 别再耗在渲染上，
        // 剩下的来源退回静态扫描，至少把这轮清单跑完。
        if (!o.ok && /超时/.test(o.error || '')) {
          renderTimeouts++;
          if (renderTimeouts >= RENDER_FAIL_LIMIT && !renderDisabled) {
            renderDisabled = true;
            console.log('\n  ⚠ 渲染已连续超时 ' + renderTimeouts + ' 次，判定为浏览器侧问题，'
              + '剩余来源改用静态扫描（结果会注明）\n');
          }
        }
      } else {
        const f = await fetchPage(s.url, { timeout: 20000, retries: 1 });
        html = f.body || '';
        rec.note = f.ok ? '' : ('HTTP ' + f.status + ' ' + (f.error || ''));
        if (s.render && renderDisabled) rec.note = '渲染已熔断，改静态；' + rec.note;
      }
    } catch (e) {
      rec.note = '失败: ' + e.message;
    }
    rec.bytes = html.length;
    // scanOffers 现在返回 {offers, keys, scanned}：
    //   keys 是这一页实际用到的「价格」字段名 —— 用它区分"页面没有"和"我们没找到"
    const scan = scanOffers(html);
    rec.offers = scan.offers;
    rec.keys = scan.keys;
    rec.match = matchTiers(s.planId, rec.offers);
    // 存盘条件不能只看"扫到了报价"：**"有价格字段但没扫出报价"这种更该留证**，
    // 否则最值得复核的那几个页面反而留不下来。
    if (KEEP && (rec.offers.length || rec.keys.length) && html) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'jsonld-' + s.planId + '.html'), html);
    }
    // 逐个来源打印进度：万一将来又卡住，一眼就能看出停在哪一个上
    done++;
    console.log('  [' + String(done).padStart(2) + '/' + targets.length + '] ' + pad(s.planId, 30)
      + pad(rec.mode, 6) + pad((rec.bytes / 1024).toFixed(0) + 'KB', 8)
      + '报价 ' + pad(rec.offers.length, 4)
      + pad(rec.keys.length ? rec.keys.join('/').slice(0, 26) : '无价格字段', 28)
      + (rec.note ? '| ' + rec.note.slice(0, 40) : ''));
    return rec;
  }), NO_RENDER ? 6 : 4);

  // 关掉所有起过的浏览器实例（正常情况下只有 1 个）
  for (const r of renderers) { try { await r.close(); } catch (e) { /* ignore */ } }

  console.log(pad('套餐', 34) + pad('原状态', 14) + pad('方式', 7) + pad('体积', 10)
    + pad('报价数', 8) + '价格字段 / 命中档位');
  results.forEach((r) => {
    const hitTxt = r.match && r.match.hit.length
      ? '★ ' + r.match.hit.slice(0, 3).join(',') + (r.match.hit.length > 3 ? '…' : '')
      : (r.keys.length ? r.keys.join('/').slice(0, 34) : '（无价格字段）');
    console.log(pad(r.planId, 34) + pad(r.status, 14) + pad(r.mode, 7) +
      pad((r.bytes / 1024).toFixed(0) + 'KB', 10) + pad(r.offers.length, 8) + hitTxt);
  });

  const withOffers = results.filter((r) => r.offers.length);
  console.log('\n=== 找到结构化报价的来源：' + withOffers.length + ' / ' + results.length + ' ===');
  withOffers.forEach((r) => {
    console.log('\n· ' + r.planId + '（' + r.mode + '，' + r.offers.length + ' 条）');
    r.offers.slice(0, 10).forEach((o) => {
      const tierHit = r.match.hit.indexOf(o.name) !== -1;
      console.log('    ' + (tierHit ? '★' : ' ') + ' ' + pad(o.name, 22) +
        pad((o.currency || '?') + ' ' + o.price, 14) + pad('字段:' + o.priceKey, 18) +
        (o.isOffer ? '@type:Offer' : '(无 @type)'));
    });
    if (r.match.miss.length) console.log('    未对上档位名: ' + r.match.miss.slice(0, 6).join(', '));
    if (r.note) console.log('    注: ' + r.note.slice(0, 120));
  });

  const noOffers = results.filter((r) => !r.offers.length);
  if (noOffers.length) {
    // 把"0 条"拆成两种，这两种的可信度完全不同：
    //   连价格字段都没有 → 页面确实没内嵌报价，结论可靠
    //   有价格字段但没配成档位 → 可能是我们的口径漏了，值得人工看一眼
    const clean = noOffers.filter((r) => !r.keys.length);
    const maybe = noOffers.filter((r) => r.keys.length);
    console.log('\n=== 没有结构化报价的来源：' + noOffers.length + ' 个 ===');
    console.log('  ── 页面里连「价格」字段都没有（' + clean.length + ' 个，结论可靠）');
    clean.forEach((r) => console.log('    ' + pad(r.planId, 34) + (r.notes || r.note || '').slice(0, 40)));
    if (maybe.length) {
      console.log('  ── 有价格字段、但没扫成「档位报价」（' + maybe.length + ' 个，值得人工看一眼）');
      maybe.forEach((r) => console.log('    ' + pad(r.planId, 34) + r.keys.join('/').slice(0, 70)));
    }
  }

  console.log('\n★ = 报价名能对上数据集档位名，可直接接 jsonld 策略');

  // 诊断开关：任务干完了，进程却迟迟不退，就打开它看看是谁还在占着事件循环。
  // （正常情况下这个列表里应该只剩这个诊断定时器自己。）
  if (process.env.CP_DIAG) {
    setTimeout(() => {
      console.log('\n[diag] 仍活跃的句柄: ' + JSON.stringify(process.getActiveResourcesInfo()));
    }, 2000);
  }
})();
