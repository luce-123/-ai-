#!/usr/bin/env node
'use strict';
/**
 * 数据迁移（第二轮）：把「从数据集反推出来的换算」改回官网原文。
 *
 * 起因：加上页面交互能力（能点 tab 了）之后，回头复核第一个渲染来源 MiniMax，
 *       发现当初为了让比对结果显示"一致"，给它配了一个 priceScale: 0.9 —— 但页面上
 *       根本没有 9 折这个数字。那是拟合，不是采集。
 *
 * 这里要立一条规矩，区分两种"换算"：
 *   ✓ 单位换算：页面上写着单位（「¥120/季」→ 月均 ÷3）。
 *     数字与单位都在页面上，换算是确定性的 —— 摩尔线程属于这类。
 *   ✗ 折扣推断：页面上没有那个数字，系数是从数据集反推出来的。
 *     这类一律不许进入采集配置，否则等于用自己的假设去证明自己的数据正确。
 *
 * 用法：
 *   node codingplan/scripts/migrate-price-caliber-v2.js --dry-run
 *   node codingplan/scripts/migrate-price-caliber-v2.js
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
/** 支持 'quota.raw' 这样的嵌套路径 —— 直接 obj['quota.raw'] 会写成一个扁平的怪键 */
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
/** 删除字段（字段本身不该存在时用，比如「没有原价就不该有原价字段」） */
function del(obj, key, label) {
  if (!(key in obj)) return;
  const before = obj[key];
  if (!DRY) delete obj[key];
  log.push('  ' + label + '  删除 ' + key + '=' + JSON.stringify(before));
}

/**
 * 往 field_convention 追加一条规矩 —— 只能追加，不能整段覆盖。
 *
 * 实测撞到过：本轮（1.1.1）原本是 `set(field_convention, 整串)`。于是 1.2.0 引入 purchase
 * 字段、把「purchase 缺失 = 未核实」追加进 field_convention 之后，**再重跑一遍本轮就把那条抹掉了**，
 * 而 changelog 里 1.2.0 的条目还在 —— 数据与 changelog 自相矛盾。
 * 改成像这样逐条追加后，执行顺序不再影响最终内容，重跑也安全。
 */
function appendConvention(rule) {
  const cur = String(data.meta.field_convention || '');
  if (cur.indexOf(rule) >= 0) return;
  const base = cur.replace(/\s*$/, '');
  const sep = /[；;。]$/.test(base) ? '' : '；';   // 前一条已用句号收尾时不要再多一个分号
  set(data.meta, 'field_convention', base + sep + rule, 'field_convention');
}

/* ============================================================
 * 1. MiniMax 价格回到官网标价
 *
 * 证据（2026-09-28 追加渲染实测，probe-actions.js 点「连续包月」tab）：
 *   页面在「连续包月」与「连续包年」两个 tab 下的月度价都是 ¥49 / ¥119 / ¥469，
 *   底部对比表同样写 ¥49 / ¥119 / ¥469，**全页没有任何 9 折字样**。
 *   年付侧：¥588→¥490（Plus）、¥1490→¥1190（Max）、¥5628→¥4690（Ultra），
 *   立省 2 个月，也没出现 44.1。
 * 结论：¥44.1 / ¥107.1 / ¥422.1 三个数在官网上找不到依据（它是聚合站的口径），
 *       价格统一改按官网标价，并撤掉 price_list_cny —— 没有原价就没有原价字段。
 * ============================================================ */
log.push('【1】MiniMax：撤销未经验证的「连续包月 9 折」换算，价格改回官网标价');
const mmPrices = [
  ['minimax-token-plan-plus', 49, 44.1],
  ['minimax-token-plan-max', 119, 107.1],
  ['minimax-token-plan-ultra', 469, 422.1],
];
mmPrices.forEach(([tierId, official, old]) => {
  const t = T('minimax-token-plan', tierId);
  set(t, 'price_cny', official, tierId + '.price_cny');
  set(t, 'price_display', '¥' + official + '/月', tierId + '.price_display');
  del(t, 'price_list_cny', tierId);
  set(t, 'price_note',
    '官网「连续包月」¥' + official + '/月（2026-09-28 实测，页面无折扣说明）' +
    '；曾按聚合站口径记过 ¥' + old + ' 的「9 折」，未能在官网找到依据，已修正',
    tierId + '.price_note');
  // price_history 末条必须等于当前价，否则 validate.js 会报错
  set(t, 'price_history', [{ date: data.meta.snapshot_date, price_cny: official }], tierId + '.price_history');
});
set(P('minimax-token-plan'), 'min_price_cny', 49, 'minimax.min_price_cny');
set(P('minimax-token-plan'), 'positioning',
  '官网月付 ¥49 起，MiniMax 全系模型（M3/M2.7/图像/语音），1M 长上下文，多模态能力最全；按年订阅立省 2 个月。',
  'minimax.positioning');

/* ============================================================
 * 2. MiniMax 额度：官网其实公开了，此前误记为「官网未公开」
 *
 * 证据：渲染后的套餐卡片写「月度约 6 亿+ token M3 用量」（Plus）、
 *       18 亿+（Max）、71 亿+（Ultra）。
 * 为什么不给 quota.value：官网原文带「约」和「+」，是区间下界的口头表述，
 *   侧边还有个「?」浮层藏着更精确的口径。若强行记成 6e8 再折算单位成本，
 *   会让 MiniMax 看起来比同行便宜十倍 —— 拿一个模糊数字去换个精确结论，
 *   正是这一轮要杜绝的做法。故只记录原文，数值留待「查看 Token 用量」页核对。
 * ============================================================ */
log.push('【2】MiniMax 额度：从「官网未公开」改为记录官网原文（不给精确数值）');
[['minimax-token-plan-plus', '6'], ['minimax-token-plan-max', '18'], ['minimax-token-plan-ultra', '71']]
  .forEach(([tierId, yi]) => {
    set(T('minimax-token-plan', tierId), 'quota.raw',
      '月度约 ' + yi + ' 亿+ Token（M3 用量，官网原文；含「约」「+」，未给精确值）',
      tierId + '.quota.raw');
  });

/* ============================================================
 * 3. 元信息
 * ============================================================ */
log.push('【3】元信息');
// 本轮只负责最后两句；前面那段属于 1.1.0 轮次。逐条追加，别整段覆盖（原因见 appendConvention 注释）。
appendConvention(
  '采集配置里的价格换算只允许「单位换算」（页面上写明单位，如季度价 ÷3）；' +
  '凡是页面上没有的数字，一律不得用系数凑成一致 —— 那会把假设伪装成实测。');

if (!data.meta.changelog) data.meta.changelog = [];
const entry = {
  date: '2026-09-28',
  version: '1.1.1',
  changes: [
    'MiniMax 价格由 ¥44.1/107.1/422.1 修正为官网标价 ¥49/119/469（撤销未经验证的「9 折」换算）',
    'MiniMax 取消 price_list_cny（官网无原价展示，也就没有原价字段）',
    'MiniMax quota.raw 由「官网未公开 Token 总量」改为官网原文「月度约 6/18/71 亿+ Token」',
  ],
  evidence: '2026-09-28 浏览器渲染实测 + 页面交互探测（scripts/collect/probe-actions.js --click）',
  note: '本次只改数据、不改结构，schema_version 仍为 1.1.0，故 changelog 记 1.1.1',
};
if (!data.meta.changelog.some((c) => c.version === entry.version)) {
  if (!DRY) data.meta.changelog.unshift(entry);
  log.push('  meta.changelog 追加 1.1.1 条目');
}

/* ---------------- 写回 ---------------- */
console.log('=== 数据迁移 v2：把反推的换算改回官网原文 ===');
console.log(log.join('\n'));
console.log('');

if (DRY) {
  console.log('[DRY-RUN] 未写入任何文件。去掉 --dry-run 才会生效。');
} else {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const bakDir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const bak = path.join(bakDir, 'plans-before-caliber-v2-' + stamp + '.json');
  fs.writeFileSync(bak, fs.readFileSync(FILE, 'utf8'), 'utf8');
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[OK] 已写入 data/plans.json');
  console.log('[OK] 备份 ' + path.relative(ROOT, bak));
  console.log('[OK] 下一步：node codingplan/scripts/validate.js');
}
