#!/usr/bin/env node
'use strict';
/**
 * 数据迁移：修正 2026-09-28 渲染实测中发现的价格口径问题。
 *
 * 为什么写成脚本而不是手改 JSON：
 *   1. 每一项改动都有出处（渲染实测到的官网原值），脚本里能留下证据
 *   2. 可重复执行（幂等），出问题能对着 backup 重新跑
 *   3. 改了什么会打印出来，不用事后 diff 猜
 *
 * 用法：
 *   node codingplan/scripts/migrate-price-model.js --dry-run   # 只看会改什么
 *   node codingplan/scripts/migrate-price-model.js             # 实际写入
 */

const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'plans.json');
const SRC_FILE = path.join(__dirname, 'collect', 'sources.json');

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const log = [];

/**
 * 轮次守卫：迁移脚本会互相覆盖。
 * 这个脚本是最早的一轮（1.1.0），它写的是"当年应该是什么样"；
 * 后来的轮次（v2 的 1.1.1、v3 的 1.1.2）改进了其中两处文案。
 * 如果只是简单重跑，就会把新版本文案倒回旧版本 —— 数据看起来退了回去，
 * 而 changelog 里 1.1.1 / 1.1.2 还在，成了自相矛盾的状态。
 *
 * 所以：某个字段若已被更晚的轮次接管，本轮直接跳过，并说明原因。
 * （改名那类"只有旧 id 存在才需要做"的操作另有一套幂等处理，见 renameTier。）
 */
function laterRoundOwns(version) {
  return (data.meta.changelog || []).some((c) => c.version === version);
}

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
/**
 * 改名是「幂等」里最麻烦的一类：跑过一次之后旧 id 就不存在了，
 * 再按旧 id 去 T() 查找会直接抛异常 —— 迁移脚本本该可以随便重跑，那样就废了。
 * 所以按「旧 id 在 → 改；旧 id 不在但新 id 在 → 已迁移过，跳过；都没有 → 真出问题了」处理。
 */
function renameTier(planId, oldId, newId, newName) {
  const p = P(planId);
  const oldT = p.tiers.find((x) => x.id === oldId);
  if (!oldT) {
    if (p.tiers.some((x) => x.id === newId)) {
      log.push('  ' + oldId + ' → ' + newId + '（已迁移过，跳过）');
      return;
    }
    throw new Error('tier 既没有旧 id 也没有新 id: ' + planId + '/' + oldId);
  }
  set(oldT, 'id', newId, oldId + '.id');
  set(oldT, 'name', newName, newId + '.name');
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

/**
 * schema_version 只能升、不能降。
 *
 * 实测撞到过：迁移脚本全部可重跑，但**重跑旧轮次会把后面新增的结构标记抹掉** ——
 * 1.2.0 引入 purchase 字段后，再跑一遍本轮（1.1.0）就把 schema_version 写回 1.1.0，
 * 于是「版本号说 1.1.0、数据里却有 1.2.0 才有的字段」。
 * 判据刻意用**数值比较**而不是「是否记得加新一轮的版本号」—— 后者迟早会漏。
 */
function setSchemaAtLeast(version, label) {
  const cur = String(data.meta.schema_version || '0.0.0');
  const cmp = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
    return 0;
  };
  if (cmp(cur, version) >= 0) {
    log.push('  ' + label + ' 已是 ' + cur + '（≥ ' + version + '），不降级');
    return;
  }
  set(data.meta, 'schema_version', version, label);
}

/**
 * 往 field_convention 追加一条规矩 —— 只能追加，不能整段覆盖。
 * 与 setSchemaAtLeast 同一类问题的另一半：重跑旧轮次会把后几轮补的规矩抹掉。
 * （原先用 laterRoundOwns 硬编码「1.1.1 会不会跑」来规避，但没法预知更后面的 1.2.0。）
 */
function appendConvention(rule) {
  const cur = String(data.meta.field_convention || '');
  if (cur.indexOf(rule) >= 0) return;
  const base = cur.replace(/\s*$/, '');
  const sep = /[；;。]$/.test(base) ? '' : '；';
  set(data.meta, 'field_convention', base + sep + rule, 'field_convention');
}

/* ============================================================
 * 1. Kimi：档位名改成官网实际名称（价格与描述词都是对的，只有名字错了）
 *    官网渲染实测：Go / Plus / Pro / Max，描述词「日常使用 / 效率升级 / 专业优选 / 全能尊享」
 *    与本库完全一致 —— 只有音乐速度术语那一层是错的。
 * ============================================================ */
const kimiRename = [
  ['kimi-code-plan-andante', 'kimi-code-plan-go', 'Andante 日常使用', 'Go 日常使用'],
  ['kimi-code-plan-moderato', 'kimi-code-plan-plus', 'Moderato 效率升级', 'Plus 效率升级'],
  ['kimi-code-plan-allegretto', 'kimi-code-plan-pro', 'Allegretto 专业优选', 'Pro 专业优选'],
  ['kimi-code-plan-allegro', 'kimi-code-plan-max', 'Allegro 全能尊享', 'Max 全能尊享'],
];
log.push('【1】Kimi 档位名对齐官网');
kimiRename.forEach(([oldId, newId, oldName, newName]) => {
  renameTier('kimi-code-plan', oldId, newId, newName);
});
set(P('kimi-code-plan'), 'positioning',
  '月之暗面 Kimi 会员，¥39 起，含 Kimi Code 调用权益；档位为 Go / Plus / Pro / Max 四档，Max 支持百万 Tokens 超长对话。',
  'kimi.positioning');

/* ============================================================
 * 2. 摩尔线程：quota.raw 原先是「固定月费订阅，预算可控」这类备注，
 *    不是额度。官网写的是与其它档的倍数关系。
 * ============================================================ */
log.push('【2】摩尔线程 额度描述改为官网口径');
set(T('mthreads-ai-coding-plan', 'mthreads-ai-coding-plan-free'), 'quota.raw',
  '每日限量 100 名开发者；与 Lite Plan 套餐用量相当', 'free.quota.raw');
set(T('mthreads-ai-coding-plan', 'mthreads-ai-coding-plan-lite'), 'quota.raw',
  'Claude Pro 套餐的 3 倍用量', 'lite.quota.raw');
set(T('mthreads-ai-coding-plan', 'mthreads-ai-coding-plan-pro'), 'quota.raw',
  'Lite Plan 的 5 倍用量', 'pro.quota.raw');
set(T('mthreads-ai-coding-plan', 'mthreads-ai-coding-plan-max'), 'quota.raw',
  'Pro Plan 的 4 倍用量', 'max.quota.raw');
// 季度价写明，避免用户以为是年付
log.push('【2b】摩尔线程 补记季度价原值');
[['mthreads-ai-coding-plan-lite', 120], ['mthreads-ai-coding-plan-pro', 600], ['mthreads-ai-coding-plan-max', 1200]]
  .forEach(([id, q]) => {
    set(T('mthreads-ai-coding-plan', id), 'price_note', '季付 ¥' + q + '/季（月均 ¥' + (q / 3) + '）', id + '.price_note');
  });

/* ============================================================
 * 3. 智谱：补录官网原价。
 *    智谱的原价此前从未进入数据集 —— 用户只看到 8 折后的价，
 *    会以为月付就是这个数。原价来自 2026-09-28 渲染实测。
 * ============================================================ */
log.push('【3】智谱 补录官网月付原价（渲染实测：¥118 / ¥538 / ¥1078）');
[[['zhipu-glm-coding-plan-lite'], 118], [['zhipu-glm-coding-plan-pro'], 538], [['zhipu-glm-coding-plan-max'], 1078]]
  .forEach(([ids, listPrice]) => {
    const t = T('zhipu-glm-coding-plan', ids[0]);
    set(t, 'price_list_cny', listPrice, t.id + '.price_list_cny');
    set(t, 'price_note', '连续包季 8 折（月付原价 ¥' + listPrice + '）', t.id + '.price_note');
  });
set(P('zhipu-glm-coding-plan'), 'positioning',
  '智谱 GLM 编程套餐，季付 8 折后 ¥94.4 起（月付原价 ¥118），含 GLM-5.3；支持 Claude Code 等 20+ 编程工具，是生态兼容最广的老牌选择。',
  'zhipu.positioning');

log.push('【3b】MiniMax：已改由 migrate-price-caliber-v2.js 处置，本脚本不再改动它');
// 原先这里补录了「月标价 ¥49」并把 price_note 写成「连续月 9 折」。
// 2026-09-28 追加实测（点开「连续包月」tab）证明页面上并没有 9 折，
// 那个折扣是为了让比对结果显示一致而反推出来的 —— 属于拟合，已撤销。
// 详见 migrate-price-caliber-v2.js。

/* ============================================================
 * 4. Cursor / OpenCode：官网是美元标价。
 *    ¥ 值是汇率估算，不是官网数字 —— 必须标出来，
 *    否则用户会以为官网标 ¥140，而实际是 $20。
 * ============================================================ */
log.push('【4】Cursor 标注美元定价（渲染实测：个人版 $20/mo、团队版 $40/user/mo）');
if (laterRoundOwns('1.1.2')) {
  log.push('  cursor.price_note 已由 1.1.2 轮次接管（补全了 Pro+ / Ultra 的官方价），本轮跳过，避免倒回旧文案');
} else {
  set(P('cursor-plan'), 'price_note',
    '官网以美元标价（Pro $20/月），本库人民币值按 1:7 估算，仅供横向参考；Pro+ 与 Ultra 的官网标价未核实',
    'cursor.price_note');
}
set(T('cursor-plan', 'cursor-plan-pro'), 'price_currency', 'USD', 'pro.price_currency');
set(T('cursor-plan', 'cursor-plan-pro'), 'price_foreign', 20, 'pro.price_foreign');
set(T('cursor-plan', 'cursor-plan-pro'), 'price_note', '官网 $20/月；¥140 为按 1:7 的估算值', 'pro.price_note');

log.push('【4b】OpenCode 标注美元定价（渲染实测：$10/月）');
set(T('opencode-go', 'opencode-go-standard'), 'price_currency', 'USD', 'standard.price_currency');
set(T('opencode-go', 'opencode-go-standard'), 'price_foreign', 10, 'standard.price_foreign');
set(T('opencode-go', 'opencode-go-standard'), 'price_note', '官网 $10/月；¥70 为按 1:7 的估算值，首月半价', 'standard.price_note');
set(P('opencode-go'), 'price_note', '官网以美元标价（$10/月），本库人民币值为汇率估算', 'opencode.price_note');

/* ============================================================
 * 5. 元信息
 * ============================================================ */
log.push('【5】元信息');
setSchemaAtLeast('1.1.0', 'schema_version');
// 本轮只负责头三句；「只允许单位换算」那条属于 1.1.1 轮次，purchase 那条属于 1.2.0 轮次。
// 逐条追加而非整段覆盖，顺序与重跑都安全（原先的 laterRoundOwns 判断只能挡住它知道的下一轮）。
appendConvention(
  '可选维度（agent_concurrency / context_window / derived 等）缺失即表示该厂商未公开此信息，不要臆造默认值。' +
  'price_list_cny 表示官网标价（原价），仅在官网同时展示原价与优惠价时才有；' +
  'price_currency / price_foreign 仅在外币定价时出现，表示官网原币金额，此时 price_cny 是汇率估算值而非官网数字。');
if (!data.meta.changelog) data.meta.changelog = []; // DRY 模式下只在内存里准备，不会落盘
const entry = {
  date: '2026-09-28',
  version: '1.1.0',
  changes: [
    'Kimi 档位名由音乐术语（Andante/Moderato/Allegretto/Allegro）改回官网名称（Go/Plus/Pro/Max）',
    '摩尔线程 quota.raw 由备注修正为官网的倍数关系描述，并补记季度价原值',
    '智谱补录月付原价 ¥118/538/1078（此前仅记录折后价）',
    'Cursor / OpenCode 标注为美元定价（$20 / $10），人民币值注明为汇率估算',
  ],
  evidence: '来源为 2026-09-28 浏览器渲染实测（scripts/collect/probe-render.js 产物）',
};
if (!data.meta.changelog.some((c) => c.version === entry.version)) {
  if (!DRY) data.meta.changelog.unshift(entry);
  log.push('  meta.changelog 追加 1.1.0 条目');
}

/* ============================================================
 * 6. 同步 sources.json 里对 Kimi 档位 id 的引用
 * ============================================================ */
log.push('【6】同步采集配置里对 Kimi 档位 id 的引用');
const srcRaw = fs.readFileSync(SRC_FILE, 'utf8');
const sources = JSON.parse(srcRaw);
const kimiSrc = sources.sources.find((s) => s.planId === 'kimi-code-plan');
if (kimiSrc) {
  const mapOld = JSON.stringify(kimiSrc.tierKeyMap);
  const mapNew = {};
  Object.keys(kimiSrc.tierKeyMap).forEach((k) => { mapNew[k] = kimiSrc.tierKeyMap[k]; });
  // 页面档位名 Go/Plus/Pro/Max ↔ 新 tier id
  mapNew['Go'] = 'kimi-code-plan-go';
  mapNew['Plus'] = 'kimi-code-plan-plus';
  mapNew['Pro'] = 'kimi-code-plan-pro';
  mapNew['Max'] = 'kimi-code-plan-max';
  if (JSON.stringify(mapNew) !== mapOld) {
    if (!DRY) {
      kimiSrc.tierKeyMap = mapNew;
      kimiSrc.tiers = ['kimi-code-plan-go', 'kimi-code-plan-plus', 'kimi-code-plan-pro', 'kimi-code-plan-max'];
      kimiSrc.note = kimiSrc.note.replace(
        '但官网档位名是 Go/Plus/Pro/Max，数据集里用的 Andante/Moderato/Allegretto/Allegro（音乐术语）与之不符，档位名建议核对后统一。',
        '档位名已按官网（Go/Plus/Pro/Max）对齐。');
      fs.writeFileSync(SRC_FILE, JSON.stringify(sources, null, 2) + '\n', 'utf8');
    }
    log.push('  sources.json: tierKeyMap 与 tiers 已更新为新 id');
  } else {
    log.push('  sources.json: 无需变更');
  }
}

/* ---------------- 写回 ---------------- */
console.log('=== 数据迁移：价格口径修正 ===');
console.log(log.join('\n'));
console.log('');

if (DRY) {
  console.log('[DRY-RUN] 未写入任何文件。去掉 --dry-run 才会生效。');
} else {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('[OK] 已写入 data/plans.json（schema 1.1.0）');
  console.log('[OK] 下一步：node codingplan/scripts/validate.js 校验，再跑 build-data-module.js 重建前端数据');
}
