#!/usr/bin/env node
/**
 * 基于 plans.json 生成比价排行（比价引擎的原型）
 * 用法: node codingplan/scripts/report.js [--json]
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'plans.json');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const vendorMap = Object.fromEntries(data.vendors.map((v) => [v.id, v]));
const billingMap = Object.fromEntries(data.billing_types.map((b) => [b.key, b]));

const rows = [];
for (const plan of data.plans) {
  for (const tier of plan.tiers) {
    rows.push({
      plan_id: plan.id,
      tier_id: tier.id,
      vendor: vendorMap[plan.vendor_id].name,
      plan: plan.name,
      tier: tier.name,
      billing_type: plan.billing_type,
      price: tier.price_cny,
      unit: billingMap[plan.billing_type].unit_label,
      quota: tier.quota.raw,
      use_case: tier.use_case || '-',
      cost_per_1m: tier.derived?.cost_per_1m_tokens_est ?? null,
      confidence: tier.derived?.confidence ?? null,
    });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ generated_from: data.meta.snapshot_date, rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
  const s2 = String(s);
  return s2 + ' '.repeat(Math.max(0, n - w));
};
const money = (n) => '¥' + n.toFixed(2);

console.log('=== 国内 AI Coding Plan 比价速览 ===');
console.log(`数据快照: ${data.meta.snapshot_date} | 共 ${data.plans.length} 个套餐 / ${rows.length} 个档位\n`);

console.log('【1】标准 Token 计费：单位成本排行（越高越便宜，仅同口径可比）');
const tokenRows = rows
  .filter((r) => r.billing_type === 'token' && r.cost_per_1m != null)
  .sort((a, b) => a.cost_per_1m - b.cost_per_1m);
console.log(pad('厂商', 14) + pad('档位', 30) + pad('月费', 11) + pad('月额度', 18) + '¥/百万Token');
tokenRows.forEach((r) => {
  console.log(pad(r.vendor, 14) + pad(r.plan.replace(' Token Plan', '') + ' · ' + r.tier, 30) + pad(money(r.price), 11) + pad(r.quota.replace(' / 订阅月', '').replace(' / 月', ''), 18) + r.cost_per_1m.toFixed(3));
});

console.log('\n【2】按请求次数计费：单位请求成本排行');
const reqRows = rows.filter((r) => r.billing_type === 'requests' && r.cost_per_1m != null).sort((a, b) => a.cost_per_1m - b.cost_per_1m);
console.log(pad('厂商', 14) + pad('档位', 30) + pad('月费', 11) + '请求单价');
reqRows.forEach((r) => {
  const unit = r.cost_per_1m / (8000 / 1e6);
  console.log(pad(r.vendor, 14) + pad(r.plan.replace(' Coding Plan', '').replace(' Agent Plan', '') + ' · ' + r.tier, 30) + pad(money(r.price), 11) + '¥' + (unit / 1000).toFixed(3) + '/千次');
});

console.log('\n【3】¥50 以内的入门档位（尝鲜预算）');
rows.filter((r) => r.price > 0 && r.price <= 50).sort((a, b) => a.price - b.price)
  .forEach((r) => console.log('  ' + pad(r.vendor + ' ' + r.plan.replace(/\s*(Coding|Token|Agent) Plan/, ' $1 Plan'), 40) + pad(r.tier, 20) + pad(money(r.price), 11) + r.use_case));

console.log('\n【4】有免费档的套餐');
data.plans.filter((p) => p.has_free_tier).forEach((p) => {
  const free = p.tiers.find((t) => t.price_cny === 0);
  console.log(`  ${p.name}（${vendorMap[p.vendor_id].name}）— ${free.name}：${free.quota.raw}`);
});

// 生态数可能整体缺失（官网没公布总数）—— 缺失时**排除**而不是当成 0，
// 并且明确说明"有几个套餐没公布"，否则这份 TOP5 会被静默当成完整榜单。
function ecoCount(p, kind) {
  const v = p && p[kind] && p[kind].count;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function printEcoTop(title, kind, unit) {
  const rated = data.plans.filter((p) => ecoCount(p, kind) != null)
    .sort((a, b) => ecoCount(b, kind) - ecoCount(a, kind));
  const missing = data.plans.length - rated.length;
  console.log('\n' + title);
  rated.slice(0, 5).forEach((p, i) =>
    console.log(`  ${i + 1}. ${p.name}（${vendorMap[p.vendor_id].name}）${ecoCount(p, kind)} ${unit}`));
  if (missing) console.log(`  （另有 ${missing} 个套餐官网未公布${unit.replace(/^[个款]/, '')}数，未参与排名）`);
}
printEcoTop('【5】模型覆盖 TOP5', 'models', '个模型');
printEcoTop('【6】工具兼容 TOP5', 'tools', '款工具');

console.log('\n注：请求次数→Token 的折算基于假设（每次请求 8000 tokens、每日 5 个限流窗口），');
console.log('    仅用于排序参考，实际可用量受 5 小时/周限流窗口约束，请以官网为准。');
