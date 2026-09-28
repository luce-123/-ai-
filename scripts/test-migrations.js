#!/usr/bin/env node
'use strict';
/**
 * 迁移脚本测试：幂等 + 轮次守卫 + 跑完仍能通过校验。
 *
 * 为什么需要单独测这个：
 *   迁移脚本最容易出的问题不是"改错值"，而是**重跑时的相互作用**。实测撞到过两次：
 *     1. 第一轮脚本靠"旧 tier id"定位 Kimi 档位 —— 跑过一遍后旧 id 就没了，
 *        重跑直接抛异常。迁移脚本本该可以随便重跑，那样就废了。
 *     2. 第一轮脚本写的是"当年应该是什么样"。在第二轮/第三轮之后再跑，
 *        它会把后两轮改进过的文案**倒回旧版本**，而 changelog 里新版本号还在，
 *        于是数据与 changelog 自相矛盾。
 *   这两类问题都不会在"只跑一次"的路径上暴露，所以必须专门测。
 *
 * 用法: node codingplan/scripts/test-migrations.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'plans.json');

// 顺序有意义：后一轮建立在上一轮之上
const MIGRATIONS = [
  'migrate-price-model.js',            // 1.1.0
  'migrate-price-caliber-v2.js',       // 1.1.1
  'migrate-price-caliber-v3.js',       // 1.1.2
  'migrate-add-qianfan-token-plan.js', // 1.1.3
  'migrate-add-purchase-status.js',    // 1.2.0
];
const N = MIGRATIONS.length;   // 计数一律动态取，别写死「三份」—— 加脚本时会漏改

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

function run(script) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    encoding: 'utf8', cwd: ROOT,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const original = fs.readFileSync(DATA, 'utf8');
const read = () => fs.readFileSync(DATA, 'utf8');
let summary = '';

try {
  /* ---------- 1. 各脚本都能跑通 ---------- */
  const failures = [];
  MIGRATIONS.forEach((m) => {
    const r = run(m);
    if (r.code !== 0) failures.push(m + ' → ' + r.out.trim().split('\n').slice(-2).join(' '));
  });
  ok(N + ' 份迁移脚本都能正常执行', failures.length === 0, failures.join(' | '));

  /* ---------- 2. 幂等：每个脚本连跑两次都不再改动数据 ---------- */
  const base = read();
  MIGRATIONS.forEach((m) => { run(m); run(m); });
  ok(N + ' 份脚本都是幂等的（重跑两次数据零变化）', read() === base,
    read() === base ? '一致' : '内容被改动了');

  /* ---------- 3. 轮次守卫：单独重跑第一轮也不许倒回旧文案 ---------- */
  run('migrate-price-model.js');
  ok('单独重跑第一轮不会覆盖后续轮次的字段（轮次守卫生效）', read() === base,
    read() === base ? '一致' : '被倒回旧版本了');

  /* ---------- 4. 乱序执行也应收敛到同一状态 ---------- */
  // 故意用倒序 + 正序各跑一遍，最终状态必须与 base 相同
  [...MIGRATIONS].reverse().forEach(run);
  MIGRATIONS.forEach(run);
  ok('乱序执行后仍收敛到同一状态', read() === base,
    read() === base ? '一致' : '乱序执行产生了不同的结果');

  /* ---------- 5. 迁移完仍能通过数据校验 ---------- */
  const v = spawnSync(process.execPath, [path.join(__dirname, 'validate.js')], {
    encoding: 'utf8', cwd: ROOT,
  });
  ok('迁移后 validate.js 依然通过', v.status === 0,
    v.status === 0 ? 'OK' : (v.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join(' | '));

  /* ---------- 6. 内容层面：关键修正项都在 ---------- */
  const d = JSON.parse(read());
  const versions = (d.meta.changelog || []).map((c) => c.version);
  ok('changelog 覆盖全部轮次且不重复',
    ['1.1.0', '1.1.1', '1.1.2', '1.1.3', '1.2.0'].every((x) => versions.includes(x)) &&
    new Set(versions).size === versions.length,
    versions.join(' , '));
  const mm = d.plans.find((p) => p.id === 'minimax-token-plan');
  ok('第二轮修正仍在位：MiniMax 为官网价且无原价字段',
    JSON.stringify(mm.tiers.map((t) => t.price_cny)) === '[49,119,469]' &&
    mm.tiers.every((t) => t.price_list_cny == null),
    mm.tiers.map((t) => t.price_cny + '/' + t.price_list_cny).join(' '));
  const cur = d.plans.find((p) => p.id === 'cursor-plan');
  ok('第三轮修正仍在位：Cursor Pro+ / Ultra 有官方美元价',
    cur.tiers.find((t) => t.id === 'cursor-plan-pro-plus').price_foreign === 60 &&
    cur.tiers.find((t) => t.id === 'cursor-plan-ultra').price_foreign === 200,
    cur.tiers.map((t) => t.name + '=' + t.price_foreign).join(' '));
  ok('第二轮补充的 field_convention 规矩仍在位', /单位换算/.test(d.meta.field_convention));

  /* ---------- 7. 后两轮迁移的产物也在 ---------- */
  const qfT = d.plans.find((p) => p.id === 'baidu-qianfan-token-plan');
  ok('第四轮（1.1.3）仍在位：千帆 Token Plan 作为独立套餐存在，价格 ¥9.9/40/200/600',
    !!qfT && JSON.stringify(qfT.tiers.map((t) => t.price_cny)) === '[9.9,40,200,600]',
    qfT ? qfT.tiers.map((t) => t.price_cny).join('/') : '(缺失)');
  const kwk = d.plans.find((p) => p.id === 'kwaikat-coding-plan');
  ok('第五轮（1.2.0）仍在位：快手的 buy_url 已离开那个 404 的营销页',
    !!kwk && kwk.buy_url === 'https://www.streamlake.com/product/wanqing',
    kwk ? kwk.buy_url : '(缺失)');
  // 这里刻意不写死「已核实 5 个」：那是个会随核实进度增长的数，
  // 写死就等于给自己埋一个「一加数据就红」的误报。
  const puN = d.plans.filter((p) => p.purchase).length;
  ok('第五轮（1.2.0）仍在位：可购买性字段已写入，且未覆盖全库（未核实的保持缺失）',
    puN >= 5 && puN < d.plans.length, puN + '/' + d.plans.length + ' 个套餐已核实');
  ok('1.2.0 把 purchase 规矩写进了 field_convention',
    /purchase 描述/.test(d.meta.field_convention));
  ok('schema_version 为 1.2.0（结构变更不能只记 changelog）',
    d.meta.schema_version === '1.2.0', d.meta.schema_version);

  summary = checks.filter((c) => c.pass).length + ' / ' + checks.length;
} finally {
  // 无论成败都还原，绝不让测试改动真实数据
  if (read() !== original) fs.writeFileSync(DATA, original, 'utf8');
}

console.log('=== 迁移脚本测试 ===\n');
checks.forEach((c) => {
  console.log('  [' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.name + (c.detail ? '  → ' + c.detail : ''));
});
console.log('\n通过 ' + summary);
if (checks.some((c) => !c.pass)) process.exit(1);
