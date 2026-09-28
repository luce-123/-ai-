#!/usr/bin/env node
/**
 * 从 data/plans.json 生成 data/plans.js（window.__PLANS__）
 * 目的：让前端页面用 file:// 直接双击打开时也能拿到数据（fetch 在 file:// 下会被 CORS 拦截）
 * 用法: node codingplan/scripts/build-data-module.js
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'data', 'plans.json');
const OUT = path.join(__dirname, '..', 'data', 'plans.js');

const raw = fs.readFileSync(SRC, 'utf8');
const data = JSON.parse(raw); // 先解析，确保源文件合法

const out = `/* 自动生成，请勿手工编辑 —— 源文件: codingplan/data/plans.json
 * 生成命令: node codingplan/scripts/build-data-module.js
 * 生成时间: ${new Date().toISOString()}
 */
window.__PLANS__ = ${JSON.stringify(data, null, 2)};
`;

fs.writeFileSync(OUT, out, 'utf8');

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('[OK] 已生成 ' + path.relative(process.cwd(), OUT));
console.log('     plans.json ' + kb(Buffer.byteLength(raw)) + ' -> plans.js ' + kb(Buffer.byteLength(out)));
console.log('     ' + data.vendors.length + ' 厂商 / ' + data.plans.length + ' 套餐 / ' +
  data.plans.reduce((s, p) => s + p.tiers.length, 0) + ' 档位');
