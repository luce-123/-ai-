#!/usr/bin/env node
'use strict';
/**
 * 数据新增：百度千帆 Token Plan 个人版（独立套餐，不是 Coding Plan 的改版）。
 *
 * 背景（这一步很关键，写清楚免得以后有人再把两者混起来）：
 *   数据集里的 `baidu-qianfan-coding-plan` 一直是 ¥40/¥200、按**请求次数**限流，
 *   与官方文档页至今逐字一致。而 `https://cloud.baidu.com/product/codingplan.html`
 *   这个购买页今天售的是**另一个产品**——页内 <title> 就是「百度千帆 Token Plan 个人版」，
 *   4 档 Mini/Lite/Pro/Max，且每档有「积分制」「Token 制」两张卡。
 *   页面原话是「完全取消 Coding Plan 原有的三层限流体系」——它把 Coding Plan 当前辈引用。
 *
 *   所以两条产品线**并行在售**，不能互相替代。本条新增的是 Token Plan。
 *
 *   ⚠⚠ **2026-09-28 更正（同日晚些时候查到一手公告，上面这句是错的）**：
 *     百度智能云《Token Plan个人版上线及Coding Plan停售公告》（更新于 2026-07-10）写明
 *     「北京时间 2026 年 7 月 13 日 10:00:00 起，Token Plan 个人版全面开放购买，
 *       Coding Plan 全档位停止购买」。所以两者**不是并行在售，而是「停售 + 替代」**。
 *     本脚本当年的表述已过时，但**脚本内容与数据都不用改** ——
 *     新增 Token Plan 独立套餐这个动作本身仍然正确（价格、档位、口径都没错），
 *     只是它承接的是 Coding Plan 的位置，不是与之并列。
 *     这件事的教训值得留着：**价格对了，可购买性也可能已经变了。**
 *     为此已新增 `purchase` 字段，见 migrate-add-purchase-status.js。
 *     上面的原始注释刻意保留不改，作为当时判断的记录。
 *
 * ⚠ 价格梯子恰好撞车：Token Plan 的常规价也是 9.9/40/200/600，Lite/Pro 正好是 40/200，
 *   与 Coding Plan 完全同价。把两者混成一条会产生「看起来完全正确、实际什么都没验证」的
 *   假确认 —— 价格巧合比价格不符危险得多，因为它不报错。故必须独立建条目。
 *
 * 口径决定（都可回溯）：
 *   - `price_cny` 记**常规价** 9.9/40/200/600（页面上的 `deletePrice`），
 *     而不是首购五折后的 4.9/19.9/99.9/299.9。依据是同一厂商的先例：
 *     千帆 Coding Plan 记的是「续购 ¥40/月」而不是「首购 ¥7.9/月」。
 *     首购五折 / 续费 6 折写进 `price_note`，不写 price_list_cny ——
 *     因为 page 上的划线价恰好**就是**本库记的常规价，再记一遍会造出假划线。
 *   - `billing_type: 'token'`，额度取 **Token 制**那一张卡（积分制的积分与 Token 不成固定比例，
 *     跨档换算是 7143/6364/5111/4242，无法线性折算，所以不能拿来归一化比较）。
 *   - `models` / `tools` **故意留空**：官网只写「主流国产模型」「适配 Cursor、Windsurf、Cline 等」，
 *     没有公布总数。按本库规矩「官网没公开的就留空」，不推算填充。
 *
 * 用法：
 *   node codingplan/scripts/migrate-add-qianfan-token-plan.js --dry-run
 *   node codingplan/scripts/migrate-add-qianfan-token-plan.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'plans.json');

const PLAN_ID = 'baidu-qianfan-token-plan';
const ORIGINAL_RAW = fs.readFileSync(FILE, 'utf8');   // 先留底：备份必须是改动前的内容
const data = JSON.parse(ORIGINAL_RAW);
const log = [];

/* ---------------- 幂等：已存在就跳过 ---------------- */
if (data.plans.some((p) => p.id === PLAN_ID)) {
  console.log('=== 新增千帆 Token Plan ===');
  console.log('  该套餐已存在，无需重复新增（脚本可安全重复执行）。');
  process.exit(0);
}

/* ---------------- 来源数据（2026-09-28 抓自购买页的卡片 JSON） ----------------
 * 卡片原文（Token 制那一张）：
 *   {"title":"Mini","hotTags":[{"text":"1000 万 Tokens /月"}],
 *    "price":"4.9","unit":"/月","deletePrice":"9.9","paramsTable":[…]}
 * 四档 deletePrice / 额度：
 */
const SOURCE = [
  { key: 'mini', label: 'Mini', price: 9.9, quotaRaw: '1000 万 Tokens /月', quotaValue: 10000000, useCase: '个人开发者尝鲜' },
  { key: 'lite', label: 'Lite', price: 40, quotaRaw: '4200 万 Tokens /月', quotaValue: 42000000, useCase: '日常主力开发' },
  { key: 'pro', label: 'Pro', price: 200, quotaRaw: '2.3 亿 Tokens /月', quotaValue: 230000000, useCase: '复杂项目 / 代码重构' },
  { key: 'max', label: 'Max', price: 600, quotaRaw: '7 亿 Tokens /月', quotaValue: 700000000, useCase: '团队协作 / 企业级' },
];

// 首购五折后官网实际展示的价（只进 price_note，不进 price_cny）
const FIRST_BUY = { mini: 4.9, lite: 19.9, pro: 99.9, max: 299.9 };

/** 由 price 与 quota 现算 derived，杜绝手写算术错误，也保证与校验脚本自洽 */
function derivedOf(price, quotaMonth) {
  return {
    quota_month: quotaMonth,
    cost_per_unit: Number((price / quotaMonth).toPrecision(4)),
    est_tokens_month: quotaMonth,
    cost_per_1m_tokens_est: Number((price / (quotaMonth / 1e6)).toPrecision(4)),
    confidence: 'high', // 官网直接给了 Token 数，不是估算
  };
}

const tiers = SOURCE.map((s) => ({
  id: PLAN_ID + '-' + s.key,
  name: s.label,
  price_cny: s.price,
  price_display: '¥' + s.price + '/月',
  billing_period: 'monthly',
  quota: { raw: s.quotaRaw, unit_key: 'token', value: s.quotaValue, window: 'month' },
  derived: derivedOf(s.price, s.quotaValue),
  use_case: s.useCase,
  highlights: ['可切换 GLM / DeepSeek / Kimi 等主流国产模型'],
  price_note: '常规价 ¥' + s.price + '/月（页面划线价）；首购五折 ¥' + FIRST_BUY[s.key] + '/月，续费限时 6 折',
  price_history: [{ date: '2026-09-28', price_cny: s.price }],
}));

const plan = {
  id: PLAN_ID,
  vendor_id: 'baidu',
  name: '千帆 Token Plan 个人版',
  billing_type: 'token',
  buy_url: 'https://cloud.baidu.com/product/codingplan.html',
  badges: [],
  has_free_tier: false,
  min_price_cny: Math.min.apply(null, tiers.map((t) => t.price_cny)),
  positioning: '与千帆 Coding Plan 并列在售的另一条产品线：不按请求次数限流，而是按月给 Token/积分额度，' +
    '官网原文「完全取消 Coding Plan 原有的三层限流体系」。同档位有积分制与 Token 制两种计费口径，本库按 Token 制建模。',
  tiers,
};

tiers.forEach((t) => {
  log.push('  + ' + t.name.padEnd(6) + ' ¥' + String(t.price_cny).padEnd(6) +
    t.quota.raw.padEnd(18) + ' 每百万 Token ¥' + t.derived.cost_per_1m_tokens_est);
});

/* ---------------- 插入位置：紧跟同厂商的 Coding Plan ---------------- */
const at = data.plans.findIndex((p) => p.id === 'baidu-qianfan-coding-plan');
if (at < 0) throw new Error('找不到 baidu-qianfan-coding-plan，插入位置未知，拒绝继续');
if (!DRY) data.plans.splice(at + 1, 0, plan);

/* ---------------- 元信息（dry-run 也按"插入后"计算，数字才可信） ---------------- */
const nextPlans = DRY ? data.plans.slice(0, at + 1).concat([plan], data.plans.slice(at + 1)) : data.plans;
const tierTotal = nextPlans.reduce((n, p) => n + p.tiers.length, 0);
const freeTotal = nextPlans.filter((p) => p.tiers.some((t) => t.price_cny === 0)).length;
log.push('  插入位置：第 ' + (at + 2) + ' 个套餐（紧跟千帆 Coding Plan）');
log.push('  meta.counts.plans ' + data.meta.counts.plans + ' → ' + nextPlans.length);
log.push('  meta.counts.tiers ' + data.meta.counts.tiers + ' → ' + tierTotal);
if (!DRY) {
  data.meta.counts.plans = nextPlans.length;
  data.meta.counts.tiers = tierTotal;
  data.meta.counts.with_free_tier = freeTotal;
}

if (!data.meta.changelog) data.meta.changelog = [];
const entry = {
  date: '2026-09-28',
  version: '1.1.3',
  changes: [
    '新增套餐「千帆 Token Plan 个人版」（4 档 Mini/Lite/Pro/Max，¥9.9/40/200/600）',
    '明确它与千帆 Coding Plan 是并行在售的两条产品线，不可互相替代或合并比对',
  ],
  evidence: '2026-09-28 静态抓取 https://cloud.baidu.com/product/codingplan.html 的卡片 JSON：' +
    'Token 制四档 deletePrice 9.9/40/200/600，额度 1000 万/4200 万/2.3 亿/7 亿 Tokens 每月；' +
    '页面 <title> 为「百度千帆Token Plan个人版」，页内自述「完全取消 Coding Plan 原有的三层限流体系」。' +
    'Coding Plan 另在官方文档页 https://cloud.baidu.com/doc/qianfan/s/imlg0beiu 保持 ¥40/¥200 原样。',
  note: '只新增数据、不改结构，schema_version 仍为 1.1.0，故 changelog 记 1.1.3。' +
    'models / tools 故意留空：官网未公布总数。',
};
if (!data.meta.changelog.some((c) => c.version === entry.version)) {
  if (!DRY) data.meta.changelog.unshift(entry);
  log.push('  meta.changelog 追加 1.1.3 条目');
}

/* ---------------- 输出 ---------------- */
console.log('=== 新增套餐：千帆 Token Plan 个人版 ===');
console.log(log.join('\n'));
console.log('');

if (DRY) {
  console.log('[DRY-RUN] 未写入任何文件。去掉 --dry-run 才会生效。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const bakDir = path.join(ROOT, 'data', 'backups');
fs.mkdirSync(bakDir, { recursive: true });
const bak = path.join(bakDir, 'plans-before-add-qianfan-token-plan-' + stamp + '.json');
fs.writeFileSync(bak, ORIGINAL_RAW, 'utf8');   // 改动前的原文，可原样还原

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('[OK] 已写入 data/plans.json');
console.log('[OK] 备份 ' + path.relative(ROOT, bak));

/* ---------------- 立即校验，不过就回滚 ---------------- */
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'validate.js')],
    { encoding: 'utf8', cwd: ROOT });
  console.log('\n' + out.split('\n').filter((l) => /\[OK\]|\[FAIL\]|厂商|套餐|档位|计费口径|价格/.test(l)).join('\n'));
} catch (e) {
  console.error('\n[FAIL] 写入后校验未通过，正在回滚…');
  fs.copyFileSync(bak, FILE);
  console.error((e.stdout || '') + (e.stderr || ''));
  console.error('已从 ' + path.relative(ROOT, bak) + ' 还原。');
  process.exit(1);
}

console.log('\n[OK] 下一步：node codingplan/scripts/build-data-module.js');
