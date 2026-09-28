#!/usr/bin/env node
/**
 * plans.json 数据完整性校验
 * 用法: node codingplan/scripts/validate.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'plans.json');
const raw = fs.readFileSync(FILE, 'utf8');

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error('[FAIL] JSON 解析失败:', e.message);
  process.exit(1);
}

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const data_ = data;
const billingKeys = new Set(data_.billing_types.map((b) => b.key));
const useCaseLabels = new Set(data_.use_cases.map((u) => u.label));
const vendorIds = new Set(data_.vendors.map((v) => v.id));

if (vendorIds.size !== data_.vendors.length) err('vendors 存在重复 id');

let tierTotal = 0;
let freeTotal = 0;
let listPriceTotal = 0;  // 记录了官网原价的档位数
let foreignTotal = 0;    // 外币定价的档位数
let purchaseTotal = 0;   // 已核实「可购买性」的套餐数
let purchaseOff = 0;     // 其中非「正常在售」的套餐数
const planIds = new Set();
const tierIds = new Set();

// purchase.status 的合法取值。与 migrate-add-purchase-status.js 的注释同源，改一处要改两处。
const PURCHASE_STATUSES = ['on_sale', 'limited', 'closed_new', 'login_only', 'unverifiable'];

for (const plan of data_.plans) {
  const tag = `plan(${plan.id})`;
  if (planIds.has(plan.id)) err(`${tag} 重复的 plan id`);
  planIds.add(plan.id);

  if (!vendorIds.has(plan.vendor_id)) err(`${tag} vendor_id "${plan.vendor_id}" 不存在`);
  if (!billingKeys.has(plan.billing_type)) err(`${tag} billing_type "${plan.billing_type}" 非法`);

  // ---- 可购买性（schema 1.2.0）----
  // 缺失 = 未核实，这是合法的（本库不猜）。一旦写了就必须自洽 —— 尤其是 as_of：
  // 没有日期，前端就会把「2026-07 停售」当成「今天停售」展示出去。
  if (plan.purchase != null) {
    const pu = plan.purchase;
    const pTag = `${tag} purchase`;
    if (!PURCHASE_STATUSES.includes(pu.status)) {
      err(`${pTag}.status "${pu.status}" 非法（应为 ${PURCHASE_STATUSES.join('/')}）`);
    }
    if (!['primary', 'secondary'].includes(pu.evidence)) {
      err(`${pTag}.evidence "${pu.evidence}" 非法（应为 primary 或 secondary）`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pu.as_of || ''))) {
      err(`${pTag}.as_of 缺失或格式非 YYYY-MM-DD`);
    } else if (pu.as_of > data_.meta.snapshot_date) {
      err(`${pTag}.as_of(${pu.as_of}) 晚于快照日期(${data_.meta.snapshot_date})，不可能成立`);
    } else if (pu.status !== 'on_sale' && !pu.as_of) {
      err(`${pTag} 非 on_sale 状态必须有 as_of，否则会把历史状态当成现状`);
    }
    if (!/^https?:\/\//.test(String(pu.source || ''))) {
      err(`${pTag}.source 必须是可回溯的 http(s) 链接`);
    }
    if (!pu.note || String(pu.note).trim().length < 10) {
      err(`${pTag}.note 缺失或过短，无法说明依据`);
    }
    if (pu.evidence === 'secondary') {
      warn(`${pTag} 依据为二手来源（媒体转引官方原文），引用时需注明、不得当作实测`);
    }
    purchaseTotal += 1;
    if (pu.status !== 'on_sale') purchaseOff += 1;
  }

  if (!Array.isArray(plan.tiers) || plan.tiers.length === 0) {
    err(`${tag} tiers 缺失或为空`);
    continue;
  }

  const prices = plan.tiers.map((t) => t.price_cny);
  const minPrice = Math.min(...prices);
  const hasFree = plan.tiers.some((t) => t.price_cny === 0);

  if (Math.abs(minPrice - plan.min_price_cny) > 1e-9) {
    err(`${tag} min_price_cny=${plan.min_price_cny} 与实际最低档 ${minPrice} 不符`);
  }
  if (Boolean(plan.has_free_tier) !== hasFree) {
    err(`${tag} has_free_tier=${plan.has_free_tier} 与档位数据(${hasFree})不符`);
  }
  if (hasFree) freeTotal += 1;

  for (const tier of plan.tiers) {
    tierTotal += 1;
    const tTag = `${plan.id}/${tier.id}`;
    if (tierIds.has(tier.id)) err(`${tTag} 重复的 tier id`);
    tierIds.add(tier.id);
    if (!tier.id.startsWith(plan.id)) warn(`${tTag} tier id 未以 plan id 为前缀`);

    if (typeof tier.price_cny !== 'number' || tier.price_cny < 0) err(`${tTag} price_cny 非法`);
    if (!tier.quota || !tier.quota.unit_key) err(`${tTag} quota.unit_key 缺失`);
    if (!tier.billing_period) err(`${tTag} billing_period 缺失`);

    // ---- 价格口径字段（schema 1.1.0）----
    // price_list_cny：官网标价（原价）。只有官网同时展示原价与优惠价时才该有。
    if (tier.price_list_cny != null) {
      if (typeof tier.price_list_cny !== 'number' || tier.price_list_cny <= 0) {
        err(`${tTag} price_list_cny 非法（应为正数）`);
      } else if (tier.price_list_cny < tier.price_cny - 1e-9) {
        err(`${tTag} price_list_cny(${tier.price_list_cny}) 低于实付价(${tier.price_cny})，原价不可能更便宜`);
      } else if (!tier.price_note) {
        warn(`${tTag} 有原价但未写 price_note，应说明折扣条件（如「连续包季 8 折」）`);
      }
      listPriceTotal += 1;
    }

    // price_currency / price_foreign：外币定价。此时 price_cny 是汇率估算值，不是官网数字。
    if (tier.price_currency != null) {
      if (!['CNY', 'USD'].includes(tier.price_currency)) {
        err(`${tTag} price_currency "${tier.price_currency}" 不是已知币种（CNY/USD）`);
      }
      if (tier.price_currency !== 'CNY') {
        foreignTotal += 1;
        if (typeof tier.price_foreign !== 'number' || tier.price_foreign <= 0) {
          err(`${tTag} 外币定价但 price_foreign 缺失或非法`);
        }
        if (!tier.price_note || !/汇率|估算|\$/.test(tier.price_note)) {
          err(`${tTag} 外币定价必须在 price_note 里说明汇率估算（否则用户会以为官网标的是人民币）`);
        }
        if (tier.derived && tier.derived.cost_per_1m_tokens_est != null) {
          err(`${tTag} 外币定价不应参与人民币归一化估算，derived 里的成本字段会误导`);
        }
      } else {
        warn(`${tTag} price_currency 为 CNY 属多余声明，可直接省略`);
      }
    }

    // 历史价格：末条必须等于当前价
    const h = tier.price_history;
    if (!Array.isArray(h) || h.length === 0) {
      err(`${tTag} price_history 缺失`);
    } else {
      const last = h[h.length - 1];
      if (Math.abs(last.price_cny - tier.price_cny) > 1e-9) {
        err(`${tTag} price_history 末条(${last.price_cny}) != 当前价(${tier.price_cny})`);
      }
    }

    // 归一化字段自洽性
    const d = tier.derived;
    if (d) {
      if (d.quota_month != null && d.cost_per_unit != null) {
        const expect = tier.price_cny / d.quota_month;
        if (Math.abs(expect - d.cost_per_unit) / d.cost_per_unit > 0.02) {
          err(`${tTag} cost_per_unit 不自洽: 期望≈${expect.toFixed(6)}, 实际=${d.cost_per_unit}`);
        }
      }
      if (d.est_tokens_month != null && d.cost_per_1m_tokens_est != null) {
        const expect = tier.price_cny / (d.est_tokens_month / 1e6);
        if (Math.abs(expect - d.cost_per_1m_tokens_est) / d.cost_per_1m_tokens_est > 0.02) {
          err(`${tTag} cost_per_1m_tokens_est 不自洽: 期望≈${expect.toFixed(4)}, 实际=${d.cost_per_1m_tokens_est}`);
        }
      }
      if (d.confidence && !['high', 'medium', 'low'].includes(d.confidence)) {
        err(`${tTag} derived.confidence "${d.confidence}" 非法`);
      }
    }

    // token 类型必须有确定的额度数值（否则无法归一化比较）
    if (plan.billing_type === 'token' && tier.quota.value == null && tier.quota.multiplier == null) {
      warn(`${tTag} 为 token 计费但未公开额度数值，跨厂商比较时需标注`);
    }

    if (!tier.use_case) warn(`${tTag} 缺少 use_case`);
    else if (!useCaseLabels.has(tier.use_case)) warn(`${tTag} use_case "${tier.use_case}" 不在 use_cases 字典中`);
  }
}

if (data_.meta.counts.vendors !== data_.vendors.length) {
  err(`meta.counts.vendors=${data_.meta.counts.vendors} 实际=${data_.vendors.length}`);
}
if (data_.meta.counts.plans !== data_.plans.length) {
  err(`meta.counts.plans=${data_.meta.counts.plans} 实际=${data_.plans.length}`);
}
if (data_.meta.counts.tiers !== tierTotal) {
  err(`meta.counts.tiers=${data_.meta.counts.tiers} 实际=${tierTotal}`);
}
if (data_.meta.counts.with_free_tier !== freeTotal) {
  err(`meta.counts.with_free_tier=${data_.meta.counts.with_free_tier} 实际=${freeTotal}`);
}

const byType = {};
for (const p of data_.plans) byType[p.billing_type] = (byType[p.billing_type] || 0) + p.tiers.length;

console.log('=== plans.json 校验报告 ===');
console.log(`文件      : ${path.relative(process.cwd(), FILE)}`);
console.log(`厂商      : ${data_.vendors.length}`);
console.log(`套餐      : ${data_.plans.length}`);
console.log(`档位      : ${tierTotal}  (含免费档套餐 ${freeTotal} 个)`);
console.log(`计费口径  : ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);
const prices = data_.plans.flatMap((p) => p.tiers.map((t) => t.price_cny));
console.log(`价格区间  : ¥${Math.min(...prices)} ~ ¥${Math.max(...prices)}`);
const withDerived = data_.plans.flatMap((p) => p.tiers).filter((t) => t.derived).length;
console.log(`可归一化  : ${withDerived}/${tierTotal} 档`);
console.log(`价格口径  : 记录官网原价 ${listPriceTotal} 档 | 外币定价 ${foreignTotal} 档（人民币值为汇率估算）`);
console.log(`可购买性  : 已核实 ${purchaseTotal}/${data_.plans.length} 个套餐（其中非正常在售 ${purchaseOff} 个）` +
  ` | 未核实 ${data_.plans.length - purchaseTotal} 个 —— 未核实不等于在售，前端须显示「未核实」`);

if (warns.length) {
  console.log(`\n--- 提示 (${warns.length}) ---`);
  warns.forEach((w) => console.log('  [warn] ' + w));
}
if (errors.length) {
  console.log(`\n--- 错误 (${errors.length}) ---`);
  errors.forEach((e) => console.log('  [FAIL] ' + e));
  process.exit(1);
}
console.log('\n[OK] 全部校验通过');
