#!/usr/bin/env node
'use strict';
/**
 * 把人工确认过的变更写入数据集。
 *
 * 安全设计：
 *  1. 只处理 pending-changes.json 里 decision === "apply" 的项，其余一律跳过
 *  2. needs_review 里的项即使标了 apply 也拒绝写入（除非显式 --force-review）
 *  3. 写入前自动备份 plans.json（带时间戳，可还原）
 *  4. 追加 price_history 而不是覆盖 —— 价格曲线靠这个长出来
 *  5. 写完自动重跑 validate.js，校验不过就回滚
 *
 * 用法：
 *   node codingplan/scripts/collect/apply.js                    # 正式写入
 *   node codingplan/scripts/collect/apply.js --dry-run          # 只看会改什么
 *   node codingplan/scripts/collect/apply.js --force-review     # 连 needs_review 也写（危险）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA_FILE = path.join(ROOT, 'data', 'plans.json');
const REPORT_FILE = path.join(ROOT, 'data', 'pending-changes.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');

const argv = process.argv.slice(2);
const has = (f) => argv.indexOf(f) !== -1;
const DRY = has('--dry-run');
const FORCE_REVIEW = has('--force-review');

if (!fs.existsSync(REPORT_FILE)) {
  console.error('[FAIL] 找不到 ' + path.relative(process.cwd(), REPORT_FILE) + '，先跑 run.js');
  process.exit(1);
}

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const planById = {};
dataset.plans.forEach((p) => { planById[p.id] = p; });

/* ---------------------- 挑选要应用的项 ---------------------- */
const picked = [];
report.changes.forEach((c) => {
  if (c.decision === 'apply') picked.push(Object.assign({ bucket: 'changes' }, c));
});
report.needs_review.forEach((c) => {
  if (c.decision === 'apply' && FORCE_REVIEW) picked.push(Object.assign({ bucket: 'needs_review' }, c));
  else if (c.decision === 'apply' && !FORCE_REVIEW) {
    console.log('[SKIP] ' + c.planName + ' / ' + c.tierName +
      ' 属于 needs_review，未加 --force-review 不写入');
  }
});

if (picked.length === 0) {
  console.log('没有 decision="apply" 的变更项，无需写入。');
  console.log('（打开 ' + path.relative(process.cwd(), REPORT_FILE) +
    '，把确认无误的项 decision 改成 "apply" 再运行）');
  process.exit(0);
}

/* ---------------------- 生成变更计划 ---------------------- */
const plan = [];
const problems = [];

picked.forEach((c) => {
  const p = planById[c.planId];
  if (!p) { problems.push('数据集里找不到套餐 ' + c.planId); return; }
  const t = p.tiers.find((x) => x.id === c.tierId);
  if (!t) { problems.push('套餐 ' + c.planId + ' 里找不到档位 ' + c.tierId); return; }
  if (Math.abs(t.price_cny - c.from) > 0.005) {
    problems.push(c.planName + ' / ' + c.tierName + ' 当前值(¥' + t.price_cny +
      ') 与报告里的 from(¥' + c.from + ') 不一致，报告可能已过期，请重跑 run.js');
    return;
  }
  plan.push({ c, plan: p, tier: t });
});

if (problems.length) {
  console.log('--- 无法应用 ---');
  problems.forEach((x) => console.log('  [FAIL] ' + x));
  process.exit(1);
}

console.log('=== 变更计划 ===');
plan.forEach(({ c, plan: p, tier }) => {
  console.log('  ' + p.name + ' / ' + tier.name + '：¥' + tier.price_cny + ' -> ¥' + c.to);
});

if (DRY) {
  console.log('\n[DRY-RUN] 未写入任何内容。');
  process.exit(0);
}

/* ---------------------- 备份 ---------------------- */
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(BACKUP_DIR, 'plans-' + stamp + '.json');
fs.copyFileSync(DATA_FILE, backup);
console.log('\n已备份到 ' + path.relative(process.cwd(), backup));

/* ---------------------- 应用 ---------------------- */
plan.forEach(({ c, plan: p, tier }) => {
  const old = tier.price_cny;
  tier.price_cny = c.to;

  // 金额展示同步
  tier.price_display = c.to === 0 ? '免费/月'
    : '¥' + (c.to % 1 === 0 ? c.to : c.to.toFixed(2)) + '/' +
      (tier.billing_period === 'quarterly' ? '月' : '月');

  // 追加历史点位；同一天已有记录则更新，避免重复打点
  if (!Array.isArray(tier.price_history)) tier.price_history = [];
  const same = tier.price_history.find((h) => h.date === today);
  if (same) same.price_cny = c.to;
  else tier.price_history.push({ date: today, price_cny: c.to });

  if (!same) {
    tier.price_history.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  console.log('  已更新 ' + p.name + ' / ' + tier.name + '（¥' + old + ' -> ¥' + c.to +
    '，历史 ' + tier.price_history.length + ' 个点位）');
});

// min_price_cny 与 has_free_tier 必须跟着变，否则校验会拦下来
dataset.plans.forEach((p) => {
  p.min_price_cny = Math.min.apply(null, p.tiers.map((t) => t.price_cny));
  p.has_free_tier = p.tiers.some((t) => t.price_cny === 0);
});

dataset.meta.snapshot_date = today;
dataset.meta.counts.with_free_tier = dataset.plans.filter((p) => p.has_free_tier).length;

fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2) + '\n', 'utf8');

/* ---------------------- 校验，不过就回滚 ---------------------- */
const nodeExe = process.execPath;
try {
  const out = execFileSync(nodeExe, [path.join(ROOT, 'scripts', 'validate.js')], { encoding: 'utf8' });
  console.log('\n' + out.split('\n').filter((l) => /\[OK\]|\[FAIL\]|错误/.test(l)).join('\n'));
} catch (e) {
  console.error('\n[FAIL] 写入后校验未通过，正在回滚…');
  fs.copyFileSync(backup, DATA_FILE);
  console.error((e.stdout || '') + (e.stderr || ''));
  console.error('已从 ' + path.relative(process.cwd(), backup) + ' 还原。');
  process.exit(1);
}

/* ---------------------- 重新生成前端数据模块 ---------------------- */
try {
  execFileSync(nodeExe, [path.join(ROOT, 'scripts', 'build-data-module.js')], { stdio: 'inherit' });
} catch (e) {
  console.error('[WARN] plans.js 重新生成失败，请手动执行 build-data-module.js');
}

console.log('\n完成。');
