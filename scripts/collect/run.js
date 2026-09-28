#!/usr/bin/env node
'use strict';
/**
 * 采集主流程：抓取 → 提取 → 比对 → 输出待确认报告
 * 只读数据，绝不改写 plans.json。
 *
 * 用法：
 *   node codingplan/scripts/collect/run.js                 # 真实抓取
 *   node codingplan/scripts/collect/run.js --offline       # 用 fixtures 跑，不联网
 *   node codingplan/scripts/collect/run.js --only unicom-yuanjing-token-plan
 *   node codingplan/scripts/collect/run.js --json          # 只输出 JSON
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, fetchAll } = require('./lib/fetch');
const { extract } = require('./lib/extract');
const { diffPlan, buildReport } = require('./lib/diff');
const { createRenderer } = require('./lib/render');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = path.join(ROOT, 'data', 'plans.json');
const OUT_FILE = path.join(ROOT, 'data', 'pending-changes.json');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

const argv = process.argv.slice(2);
const has = (f) => argv.indexOf(f) !== -1;
const valueOf = (f) => {
  const i = argv.indexOf(f);
  if (i >= 0) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(f + '=')); // 同时支持 --only=xxx
  return hit ? hit.slice(f.length + 1) : null;
};

const OFFLINE = has('--offline');
const JSON_ONLY = has('--json');
const PROBE = has('--probe');
const NO_RENDER = has('--no-render'); // 关掉浏览器渲染，只走静态抓取
const ONLY = valueOf('--only');
const CONCURRENCY = Number(valueOf('--concurrency') || 4);

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));

const planById = {};
dataset.plans.forEach((p) => { planById[p.id] = p; });

let jobs = sources.sources.filter((s) => (ONLY ? s.planId === ONLY : true));
const unknown = jobs.filter((s) => !planById[s.planId]);
if (unknown.length) {
  console.error('[FAIL] sources.json 引用了数据集里不存在的套餐: ' +
    unknown.map((s) => s.planId).join(', '));
  process.exit(1);
}
if (ONLY && jobs.length === 0) {
  console.error('[FAIL] --only ' + ONLY + ' 在 sources.json 里找不到');
  process.exit(1);
}

/** 需要自动提取的才去抓；manual 的直接跳过，省流量也省时间。
 *  --probe 例外：全部抓一遍，用来复核 sources.json 里「需渲染 / 链接失效」这类判断是否还成立。 */
function needFetch(s) {
  return PROBE || (s.extract && s.extract.type && s.extract.type !== 'manual');
}

function readFixture(s) {
  if (!s.fixture) return null;
  const p = path.join(FIXTURE_DIR, s.fixture);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/* ---------------- 渲染后端（惰性单例：整个进程共用一个浏览器实例）----------------
 * 缓存的是 Promise 而不是实例：并发抓取时多个来源会同时来要渲染器，
 * 若用「布尔标志 + await」，第二个调用会在浏览器还没启动完时就看到标志已置位、
 * 拿到 null 而错误地回退成静态抓取。
 */
let _rendererPromise = null;

function getRenderer() {
  if (!_rendererPromise) {
    _rendererPromise = createRenderer()
      .then((r) => {
        console.log('  [渲染后端] 已启动 ' + path.basename(r.exe) + '（端口 ' + r.port + '）');
        return r;
      })
      .catch((e) => {
        console.log('  [渲染后端] 不可用：' + e.message + ' —— 相关来源将回退为静态抓取');
        return null;
      });
  }
  return _rendererPromise;
}

async function closeRenderer() {
  const r = _rendererPromise ? await _rendererPromise : null;
  if (r) await r.close();
}

/* 渲染并发闸门：同一个浏览器同时渲染太多页面会互相拖慢，
 * 实测表现为 waitFor 等不到内容、拿到半渲染的 DOM。
 * 限制同时渲染 2 个，其余的排队，整体反而更快也更稳。 */
const RENDER_SLOTS = Number(process.env.CP_RENDER_SLOTS || 2);
let renderFree = RENDER_SLOTS;
const renderQueue = [];

async function withRenderSlot(fn) {
  if (renderFree <= 0) await new Promise((res) => renderQueue.push(res));
  renderFree--;
  try {
    return await fn();
  } finally {
    renderFree++;
    const next = renderQueue.shift();
    if (next) next();
  }
}

async function runOne(s) {
  const plan = planById[s.planId];
  let html = '';
  let text = '';
  let rendered = false;
  let info = { status: null, bytes: 0, ms: 0, notes: [], error: null };
  const warnings = [];

  if (OFFLINE) {
    const fx = readFixture(s);
    // 渲染类来源只固化了「渲染后的可见文本」（blocks 策略要的就是它），没有 HTML 属正常
    const txtPath = s.fixtureText ? path.join(FIXTURE_DIR, s.fixtureText) : null;
    const hasTxt = txtPath && fs.existsSync(txtPath);
    if (fx == null && !hasTxt) {
      warnings.push('离线模式：该来源未固化样本（' + (s.fixture || s.fixtureText || '无 fixture 配置') + '），跳过');
      info = { status: 'fixture-missing', bytes: 0, ms: 0, notes: [], error: null };
    } else {
      if (fx != null) html = fx;
      const notes = [];
      if (fx != null) notes.push('读取本地样本 ' + s.fixture);
      if (hasTxt) { text = fs.readFileSync(txtPath, 'utf8'); notes.push('读取渲染文本样本 ' + s.fixtureText); }
      info = { status: 'fixture', bytes: Buffer.byteLength(html || text), ms: 0, notes, error: null };
    }
  } else if (!needFetch(s)) {
    info = { status: 'skipped(manual)', bytes: 0, ms: 0, notes: [], error: null };
  } else if (s.render && !NO_RENDER) {
    const r = await getRenderer();
    if (r) {
      const opts = {
        waitFor: s.render.waitFor || '元|¥|￥',
        settle: s.render.settle == null ? 2000 : s.render.settle,
        waitForMax: s.render.waitForMax || 12000,
        timeout: s.render.timeout || 35000,
      };
      // 页面交互：有些价格不在首屏 —— 要先把套餐系列的 tab 点一下才会出现
      // （腾讯云活动页就是这样：Hy 系列默认可见，通用系列要点「通用 Token Plan」）。
      // actions 在渲染器内部先于 waitFor 执行，所以这里只要把配置透传过去。
      if (Array.isArray(s.render.actions) && s.render.actions.length) {
        opts.actions = s.render.actions;
      }
      let o = await withRenderSlot(() => r.render(s.url, opts));
      // 首次没等到目标文本（可能是首次加载慢或被限流）→ 重来一次。
      // 一次未命中就宣布"页面变了"会造成误报，这里多给一次机会。
      const missed = (o.notes || []).some((n) => /未命中/.test(n));
      if (o.ok && missed) {
        const o2 = await withRenderSlot(() => r.render(s.url, opts));
        if (o2.ok && !(o2.notes || []).some((n) => /未命中/.test(n))) {
          o = o2;
          o.notes.push('首次未命中等待条件，重试后成功');
        } else {
          o.notes.push('重试仍未命中等待条件，本次结果可能不完整');
        }
      }
      html = o.html;
      text = o.text || '';
      rendered = true;
      info = { status: o.ok ? 200 : 0, bytes: o.html.length, ms: o.ms, notes: o.notes || [], error: o.error || null };
      if (!o.ok) warnings.push('渲染失败：' + (o.error || '未取到内容'));
      else if (!o.text) warnings.push('渲染成功但页面无可见文本');
    } else {
      // 渲染后端不可用 → 退回静态抓取，并明确标注，避免把空壳当成「页面变了」
      const r2 = await fetchPage(s.url, { timeout: 20000, retries: 1 });
      html = r2.body;
      info = r2;
      info.notes = (info.notes || []).concat('渲染后端不可用，已回退静态抓取');
      warnings.push('该来源需要渲染，但渲染后端不可用，静态结果不可用于判定');
    }
  } else {
    const r = await fetchPage(s.url, { timeout: 20000, retries: 1 });
    html = r.body;
    info = r;
    if (!r.ok) warnings.push('抓取失败：' + (r.error || 'HTTP ' + r.status));
  }

  const ex = extract(html, s.extract, text);
  ex.warnings = warnings.concat(ex.warnings);

  const result = diffPlan(plan, s, ex, info);
  result.fetch = info;
  result.rendered = rendered;
  result.hasRender = !!s.render;

  // --probe：复核 status 判断本身是否还成立
  if (PROBE && html) {
    const hay = text || html;
    // 价格线索两种形态都要认：「¥94.4」和「94.4元」。只认后者会漏掉智谱/摩尔线程这类页面。
    const priceHits = (hay.match(/[¥￥]\s*[0-9]|[0-9][0-9,]*(?:\.[0-9]+)?\s*(?:元|¥|￥)|\$\s*[0-9]/g) || []).length;
    // 「空壳」的判定标准要看内容类型：静态空壳 HTML 是几百字节，
    // 而渲染后的可见文本天然只有 1~4KB，用同一个阈值会把正常页面误判成空壳。
    const minLen = text ? 300 : 2000;
    const observed = hay.length < minLen ? 'empty-shell'
      : priceHits > 0 ? 'has-price-text' : 'no-price-text';
    result.probe = { observed, priceHits, bytes: info.bytes, rendered, textLen: hay.length };
    const declared = s.status;
    // 渲染本身没跑完（等不到价格文本、或页面没加载完）时，不能把「这次没抓到」当成「页面变了」。
    const renderIncomplete = rendered &&
      (info.notes || []).concat(result.warnings || []).some((n) => /未命中|渲染失败|未取到|为空/.test(n));
    let drift = null;
    if (declared === 'broken' && info.status === 200) drift = '链接已恢复';
    else if (declared === 'verified' && observed !== 'has-price-text' && renderIncomplete) {
      drift = '本次渲染未完整取到内容（非页面变化），建议重跑确认';
    } else if (declared === 'verified' && observed !== 'has-price-text') {
      drift = '原先能解析，现在拿不到价格了';
    }
    else if (declared === 'spa' && !s.render && observed === 'has-price-text') {
      drift = '静态 HTML 里已有价格，不必再走渲染';
    } else if (declared === 'spa' && rendered && observed === 'has-price-text') {
      drift = '渲染后可取到价格（已在用渲染）';
    } else if (declared === 'login' && rendered && observed === 'has-price-text') {
      drift = '未登录也渲染出价格了，可改为自动提取';
    } else if (declared === 'login' && rendered && /登录|扫码|验证码/.test((text || '').slice(0, 400))) {
      drift = '确认是登录墙（需登录后人工录入）';
    }
    if (drift) result.probe.drift = drift;
  }

  return result;
}

(async () => {
  const started = Date.now();
  let results;
  try {
    results = await fetchAll(jobs.map((s) => () => runOne(s)), OFFLINE ? 2 : CONCURRENCY);
  } finally {
    await closeRenderer();
  }

  const report = buildReport(results, {
    generated_at: new Date().toISOString(),
    dataset_snapshot: dataset.meta.snapshot_date,
  });
  report.mode = OFFLINE ? 'offline(fixtures)' : 'online';

  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  /* ------------------------- 人类可读报告 ------------------------- */
  const pad = (s, n) => {
    let w = 0;
    for (const ch of String(s)) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
    return String(s) + ' '.repeat(Math.max(0, n - w));
  };
  const statusTag = {
    verified: '可解析',
    'headline-only': '仅宣传语',
    noisy: '噪声大',
    spa: '需渲染',
    login: '需登录',
    'usd-pricing': '美元定价',
    broken: '链接失效',
  };
  const renderTag = (r) => (!r.hasRender ? ''
    : r.rendered ? '[渲染]'
    : r.httpStatus === 'fixture' ? '[渲染样本]'
    : '[渲染失败]');

  console.log('=== 采集报告（' + (OFFLINE ? '离线 fixtures' : '在线抓取') + '）===');
  console.log('数据集快照 ' + dataset.meta.snapshot_date + ' | 检查来源 ' + results.length +
    ' 个 | 耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's\n');

  console.log(pad('套餐', 32) + pad('状态', 11) + pad('获取方式', 13) + pad('候选', 6) + pad('确认', 6) + pad('变更', 6) + '提示');
  results.forEach((r) => {
    const src = r.rendered
      ? '渲染 ' + ((r.fetch && r.fetch.ms ? r.fetch.ms / 1000 : 0).toFixed(1)) + 's'
      : r.httpStatus === 'fixture' ? '本地样本'
      : r.httpStatus === 'fixture-missing' ? '缺样本'
      : r.httpStatus === 'skipped(manual)' || r.httpStatus == null ? '未抓取'
      : '静态 HTTP ' + r.httpStatus;
    const tip = r.hasData ? renderTag(r) : (r.warnings[0] || '跳过');
    console.log(pad(r.planName, 32) + pad(statusTag[r.status] || r.status, 11) + pad(String(src), 13) +
      pad(String(r.entryCount), 6) + pad(String(r.confirmed.length), 6) +
      pad(String(r.changes.length), 6) + String(tip).slice(0, 34));
  });

  const s = report.summary;
  console.log('\n--- 汇总 ---');
  console.log('  成功取到数据 ' + s.sources_with_data + ' / ' + s.sources_checked + ' 个来源');
  console.log('  一致性确认档位 ' + s.confirmed_tiers + ' 个（页面上仍能找到与当前价格一致的数字）');
  console.log('  待确认变更 ' + s.pending_changes + ' 项  |  需人工复核 ' + s.needs_review + ' 项' +
    (s.unassigned_candidates ? '  |  无法归属的候选值 ' + s.unassigned_candidates + ' 个' : ''));

  if (report.changes.length) {
    console.log('\n--- 待确认变更（幅度正常，官网核对后可将 decision 改为 apply）---');
    report.changes.forEach((c) => {
      console.log('  ' + c.planName + ' / ' + c.tierName + '：¥' + c.from + ' -> ¥' + c.to +
        '（' + (c.ratio * 100).toFixed(1) + '%）');
    });
  }
  if (report.needs_review.length) {
    console.log('\n--- 需人工复核（变动幅度异常，可能是抓错了数字）---');
    report.needs_review.forEach((c) => {
      console.log('  ' + c.planName + ' / ' + c.tierName + '：¥' + c.from + ' -> ¥' + c.to +
        '（' + (c.ratio * 100).toFixed(0) + '%）');
      console.log('      证据: ' + String(c.evidence).slice(0, 100));
    });
  }

  const curSym = (c) => (!c || c === 'CNY' ? '¥' : c === 'USD' ? '$' : c + ' ');

  const unassigned = results.filter((r) => r.unassigned.length);
  if (unassigned.length) {
    console.log('\n--- 无法归属的候选值（可能来自宣传语或其他产品，不据此判定变更）---');
    unassigned.forEach((r) => {
      r.unassigned.forEach((u) => {
        console.log('  ' + r.planName + '：' + curSym(u.currency) + u.price + '  [' + u.label + ']');
        console.log('      ' + String(u.context).slice(0, 100));
      });
    });
  }

  const curNotes = results.filter((r) => (r.currencyNotes || []).length);
  if (curNotes.length) {
    console.log('\n--- 外币定价（不做自动比对：数据集里的 ¥ 值是汇率换算，不是官网标价）---');
    curNotes.forEach((r) => {
      r.currencyNotes.forEach((c) => {
        console.log('  ' + r.planName + ' / ' + c.tierName + '：官网 ' +
          curSym(c.currency) + c.pagePrice + '  |  数据集 ¥' + c.datasetCny);
      });
    });
  }

  if (report.quota_notes.length) {
    console.log('\n--- 额度描述有出入（仅供参考，不改数据）---');
    report.quota_notes.forEach((q) => {
      console.log('  ' + q.planName + ' / ' + q.tierName);
      console.log('      现: ' + q.current);
      console.log('      页: ' + q.extracted);
    });
  }

  const problems = results.filter((r) => r.status === 'broken' || (r.fetch && r.fetch.error));
  if (problems.length) {
    console.log('\n--- 来源问题 ---');
    problems.forEach((r) => {
      console.log('  ' + r.planName + '（' + (statusTag[r.status] || r.status) + '）：' +
        (r.fetch && r.fetch.error ? r.fetch.error : '') + ' ' + r.url);
    });
  }

  if (PROBE) {
    console.log('\n--- 配置复核（--probe）---');
    console.log(pad('套餐', 34) + pad('声明', 12) + pad('实测', 16) + pad('体积', 12) + '观察');
    results.forEach((r) => {
      const p = r.probe || {};
      const sizeTxt = p.rendered && p.textLen ? p.textLen + ' 字符' : (p.bytes || 0) + ' B';
      console.log(pad(r.planName, 34) + pad(statusTag[r.status] || r.status, 12) +
        pad(p.observed || '-', 16) + pad(sizeTxt, 12) +
        (p.drift ? '⚠ ' + p.drift : (p.priceHits ? '价格文本 ' + p.priceHits + ' 处' : '')));
    });
    const drifts = results.filter((r) => r.probe && r.probe.drift);
    console.log('\n  需更新配置的来源 ' + drifts.length + ' 个' +
      (drifts.length ? '：' + drifts.map((r) => r.planName).join('、') : ''));
  }

  console.log('\n报告已写入 ' + path.relative(process.cwd(), OUT_FILE));
  console.log('（该文件只是报告，不会自动改数据）');
})();
