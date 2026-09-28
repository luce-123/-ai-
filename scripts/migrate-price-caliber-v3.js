#!/usr/bin/env node
'use strict';
/**
 * 数据迁移（第三轮）：补录 Cursor 的官方美元价。
 *
 * 背景：此前只有 Pro 一档有官方价（渲染实测 $20），Pro+ 与 Ultra 的 ¥420 / ¥1400
 *       在 price_note 里被标为「未核实」—— 它们是按 1:7 汇率从聚合站的人民币值反推的。
 *
 * 本轮实测发现：Cursor 定价页内嵌了 schema.org 结构化数据，全量报价一直在里面：
 *   Hobby $0 / Pro $20 / Pro+ $60 / Ultra $200 / Teams $40
 * 关键点是这些数字**不需要点 tab**——页面上 Pro+ / Ultra 是切换 tab，点了也不换价
 * （点击能命中元素，但卡片上的 $20 纹丝不动），而从结构化数据里可以直接读到。
 * 而且静态 HTML 里就有，连浏览器都不用开。
 *
 * 修正后的好消息：¥420 = 7 × $60、¥1400 = 7 × $200 —— 聚合站当年就是按 1:7 折的，
 * 所以人民币数值本身没错，只是「官网标价未核实」这个状态可以撤销了。
 *
 * 用法：
 *   node codingplan/scripts/migrate-price-caliber-v3.js --dry-run
 *   node codingplan/scripts/migrate-price-caliber-v3.js
 */

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'plans.json');

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const log = [];

const planById = {};
data.plans.forEach((p) => { planById[p.id] = p; });

function P(id) {
  const p = planById[id];
  if (!p) throw new Error('plan 不存在: ' + id);
  return p;
}
function T(planId, tierId) {
  const t = P(planId).tiers.find((x) => x.id === tierId);
  if (!t) throw new Error('tier 不存在: ' + planId + '/' + tierId);
  return t;
}
function set(obj, pathStr, val, label) {
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  const key = parts[parts.length - 1];
  const before = cur[key];
  if (JSON.stringify(before) === JSON.stringify(val)) return;
  if (!DRY) cur[key] = val;
  log.push('  ' + label + '  ' + JSON.stringify(before) + ' → ' + JSON.stringify(val));
}

/* ============================================================
 * 1. Cursor：Pro+ / Ultra 补上官方美元标价
 * ============================================================ */
log.push('【1】Cursor Pro+ / Ultra 补录官方美元标价（来源：页面内嵌 schema.org Offer）');
[['cursor-plan-pro-plus', 60], ['cursor-plan-ultra', 200]].forEach(([tierId, usd]) => {
  const t = T('cursor-plan', tierId);
  set(t, 'price_currency', 'USD', tierId + '.price_currency');
  set(t, 'price_foreign', usd, tierId + '.price_foreign');
  set(t, 'price_note', '官网 $' + usd + '/月；¥' + t.price_cny + ' 为按 1:7 的估算值',
    tierId + '.price_note');
});

log.push('【1b】Cursor 套餐说明：撤销「Pro+ / Ultra 未核实」的表述');
set(P('cursor-plan'), 'price_note',
  '官网以美元标价（Hobby 免费 / Pro $20 / Pro+ $60 / Ultra $200 每月）。' +
  '这些数字取自页面内嵌的 schema.org 结构化数据，无需点 tab 即可读到；' +
  '本库人民币值按 1:7 估算，仅供横向参考。另有 Teams 版 $40/user/月，属另一条产品线，本站未建模。',
  'cursor.price_note');

/* ============================================================
 * 2. 元信息
 * ============================================================ */
log.push('【2】元信息');
if (!data.meta.changelog) data.meta.changelog = [];
const entry = {
  date: '2026-09-28',
  version: '1.1.2',
  changes: [
    'Cursor Pro+ / Ultra 补录官方美元标价（$60 / $200），撤销「未核实」状态',
    '新增 jsonld 提取策略：读页面内嵌的 schema.org Offer 结构化报价（Cursor 是首个用户）',
  ],
  evidence: '2026-09-28 静态抓取 cursor.com/cn/pricing，页面内 schema.org Offer 数组：' +
    'Hobby $0 / Pro $20 / Pro+ $60 / Ultra $200 / Teams $40',
  note: '只改数据、不改结构，schema_version 仍为 1.1.0，故 changelog 记 1.1.2',
};
if (!data.meta.changelog.some((c) => c.version === entry.version)) {
  if (!DRY) data.meta.changelog.unshift(entry);
  log.push('  meta.changelog 追加 1.1.2 条目');
}

/* ---------------- 写回 ---------------- */
console.log('=== 数据迁移 v3：补录 Cursor 官方美元价 ===');
console.log(log.join('\n'));
console.log('');

if (DRY) {
  console.log('[DRY-RUN] 未写入任何文件。去掉 --dry-run 才会生效。');
} else {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bakDir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, 'plans-before-caliber-v3-' + stamp + '.json');
  fs.writeFileSync(bak, fs.readFileSync(FILE, 'utf8'), 'utf8');
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[OK] 已写入 data/plans.json');
  console.log('[OK] 备份 ' + path.relative(ROOT, bak));
  console.log('[OK] 下一步：node codingplan/scripts/validate.js');
}
