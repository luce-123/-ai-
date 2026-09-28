#!/usr/bin/env node
'use strict';
/**
 * 结构新增：为套餐加一维「可购买性」(`purchase`)，并修正快手的 buy_url。
 *
 * 为什么要有这一维（这是本轮最重要的结论）：
 *   本库此前只建模「官网标价」。2026-09-28 查一手公告时发现，2026 年 7 月前后
 *   有一轮集中的**可购买性**变动，而价格往往**没变** —— 最典型的是百度千帆：
 *   文档页的 ¥40/¥200 至今逐字准确，但公告写明 Coding Plan 自 2026-07-13 起
 *   **全档位停止接受新购订单**。也就是说，那一页描述的是**存量用户的价格**，
 *   不是新用户能买到的价格。
 *
 *   「价格没变、可购买性变了」比涨价难发现得多 —— 涨价会被采集器抓到并报警，
 *   而停售不会有任何数字变化，报告上依然是漂亮的「2 档确认、0 变更」。
 *
 * 字段设计（都进 validate.js 校验）：
 *   purchase = {
 *     status:   on_sale | limited | closed_new | login_only | unverifiable
 *     as_of:    YYYY-MM-DD —— 该状态所依据的公告生效日 / 核实日。
 *               非 on_sale 状态**必须**有它，否则会把历史状态当成现状展示。
 *     evidence: primary | secondary —— 一手（厂商官网原文）还是二手（媒体转引）。
 *               这不是洁癖：Kimi 那条只有媒体转引，性质不同就该标出来。
 *     source:   该事实的出处链接（必须是 http(s)，可回溯）
 *     note:     一句话说明
 *   }
 *
 *   ⚠ **`purchase` 缺失 = 未核实，不等于「在售」。** 与 `models`/`tools` 留空同一规矩：
 *     没查过就不写，绝不默认填一个乐观值。前端对缺失态显示「未核实」而非留白。
 *
 * 状态取值为什么是这五个：
 *   - on_sale       官网公开可购
 *   - limited       限量/抢购（能买，但不保证有货）—— 阿里 Pro 属此类
 *   - closed_new    停止新购、仅存量可用 —— 千帆 Coding Plan、Kimi 属此类
 *   - login_only    无公开购买页，须登录控制台（保留给已确认的此类来源）
 *   - unverifiable  **查过了但查不到** —— 与「没查过」必须区分开。
 *                   这正是本库早前记下的教训：'扫不到' 和 '扫了但被过滤掉' 必须能区分。
 *
 * 本轮只写已核实的 5 条，其余 16 个套餐**保持缺失**（= 未核实），不猜。
 *
 * 用法：
 *   node codingplan/scripts/migrate-add-purchase-status.js --dry-run
 *   node codingplan/scripts/migrate-add-purchase-status.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'data', 'plans.json');

const ORIGINAL_RAW = fs.readFileSync(FILE, 'utf8');   // 先留底：备份必须是改动前的内容
const data = JSON.parse(ORIGINAL_RAW);
const log = [];

/* ---------------------------- 已核实的事实 ---------------------------- */
/* 每条都必须能点开链接看到出处；写不准的就别写。 */
const PURCHASE = [
  {
    planId: 'baidu-qianfan-coding-plan',
    status: 'closed_new',
    as_of: '2026-07-13',
    evidence: 'primary',
    source: 'https://cloud.baidu.com/doc/qianfan/s/Fmrexuejc',
    note: '官方公告《Token Plan个人版上线及Coding Plan停售公告》：北京时间 2026-07-13 10:00 起 Coding Plan 全档位停止接受新购订单。' +
      '已购买且在有效期内的套餐功能与使用规则不变、可正常使用至服务周期结束，存量用户可通过一键迁移通道升级至 Token Plan。' +
      '⚠ 本页的 ¥40/¥200 仍然准确，但它描述的是**存量用户**的价格，不是新用户能买到的价格。',
  },
  {
    planId: 'baidu-qianfan-token-plan',
    status: 'on_sale',
    as_of: '2026-07-13',
    evidence: 'primary',
    source: 'https://cloud.baidu.com/doc/qianfan/s/Fmrexuejc',
    note: '同一公告：Token Plan 个人版自 2026-07-13 10:00 起全面开放购买，是 Coding Plan 停止新购后的承接产品（两者不可互相迁移比对）。',
  },
  {
    planId: 'aliyun-bailian-coding-plan',
    status: 'limited',
    as_of: '2026-09-22',
    evidence: 'primary',
    source: 'https://help.aliyun.com/zh/model-studio/token-plan-overview',
    note: '阿里云帮助中心（更新于 2026-09-22）「关于 Coding Plan」：「Coding Plan 和 Token Plan 是两个独立的订阅产品，两者之间无法迁移或升级。' +
      'Coding Plan Lite 已于 2026 年 3 月 20 日停止新购，2026 年 4 月 13 日停止续费和升级；Coding Plan Pro 为限量抢购，库存售罄后不再补充。」' +
      '本库只建模了 Pro，故记为限量抢购而非正常在售。',
  },
  {
    planId: 'kimi-code-plan',
    status: 'closed_new',
    as_of: '2026-07-19',
    evidence: 'secondary',
    source: 'https://www.cnfin.com/gs-lb/detail/20260720/4442734_1.html',
    note: '2026-07-19 官方《关于算力紧缺与会员暂停开放的说明》：即日起暂停 C 端新用户订阅，已有算力全部投入服务已订阅用户，' +
      '并将拆分 Kimi 主权益与 Kimi Code 权益；公告称「随着新算力陆续到位，将逐步开放更多订阅名额直至全面恢复正常订阅」。' +
      '⚠ 本条为**媒体转引官方原文**（二手），且距今已逾两个月，**当前是否已恢复未核实** —— 故本状态只代表 2026-07-19 时点。',
  },
  {
    planId: 'kwaikat-coding-plan',
    status: 'unverifiable',
    as_of: '2026-09-28',
    evidence: 'primary',
    source: 'https://www.streamlake.com/product/wanqing',
    note: '自核（2026-09-28）：官方营销页 /marketing/coding-plan 及其四种变体（无 www / 尾斜杠 / 首字母大写 / 带查询参数）实测全部 404，' +
      '且该路由已不在站点地图中（sitemap 426 条、lastmod 为当天）；官方万擎产品页的「热卖中」位至今仍链向这个死链。' +
      '当前不存在公开定价页 —— 控制台为纯客户端空壳且需登录，万擎 66 篇文档全文无定价信息。故**无法核实**其当前可购买性（不等于已停售）。',
  },
];

/* ---------------------------- 幂等：全部已存在就跳过 ---------------------------- */
const pending = PURCHASE.filter((x) => {
  const p = data.plans.find((y) => y.id === x.planId);
  return p && !p.purchase;
});
const missingPlan = PURCHASE.filter((x) => !data.plans.some((y) => y.id === x.planId));
if (missingPlan.length) {
  console.error('[FAIL] 以下套餐在 plans.json 里找不到，拒绝继续：' + missingPlan.map((x) => x.planId).join(', '));
  process.exit(1);
}

const KWK = data.plans.find((p) => p.id === 'kwaikat-coding-plan');
const NEW_BUY_URL = 'https://www.streamlake.com/product/wanqing';
const needBuyUrlFix = KWK && KWK.buy_url !== NEW_BUY_URL;

/* field_convention 与 schema_version 也纳入「是否需要改动」——
   否则「全部已在位就早退」会让拼接符规范这类小修永远跑不到。 */
const CONV_ADD = 'purchase 描述「新用户能不能买到」，与价格无关，缺失即表示**未核实**（不等于在售）；' +
  'status 取 on_sale/limited/closed_new/login_only/unverifiable，非 on_sale 必须带 as_of（否则会把历史状态当现状），' +
  'evidence 区分一手（厂商官网原文）与二手（媒体转引）。';
const CONV_MARK = 'purchase 描述';
const convCur = String(data.meta.field_convention || '');
const convNext = (function () {
  let cur = convCur;
  if (cur.indexOf(CONV_MARK) < 0) {
    const base = cur.replace(/\s*$/, '');
    const sep = /[；;。]$/.test(base) ? '' : '；';
    cur = base + sep + CONV_ADD;
  }
  return cur.replace(/。 +/g, '。');   // 规范拼接符：此前有一条是用空格接上的
})();
const convNeedsWork = convNext !== convCur;

const prevSchema = String(data.meta.schema_version || '');
const NEXT_SCHEMA = '1.2.0';            // 新增可选字段属**结构变更**，minor 位 +1
const needSchemaBump = prevSchema !== NEXT_SCHEMA;

if (pending.length === 0 && !needBuyUrlFix && !convNeedsWork && !needSchemaBump) {
  console.log('=== 新增「可购买性」维度 + 修正快手 buy_url ===');
  console.log('  purchase 字段 / buy_url / schema_version / field_convention 均已是目标状态 —— 无需改动（可安全重复执行）。');
  process.exit(0);
}

/* ---------------------------- 写入 ---------------------------- */
pending.forEach((x) => {
  const p = data.plans.find((y) => y.id === x.planId);
  if (!DRY) p.purchase = {
    status: x.status,
    as_of: x.as_of,
    evidence: x.evidence,
    source: x.source,
    note: x.note,
  };
  log.push('  + ' + x.planId.padEnd(30) + x.status.padEnd(14) + 'as_of ' + x.as_of + '  (' + x.evidence + ')');
});

if (needBuyUrlFix) {
  log.push('  ~ kwaikat-coding-plan.buy_url');
  log.push('      ' + KWK.buy_url + '  →  ' + NEW_BUY_URL);
  log.push('      （原地址实测 404；官方万擎产品页可访问，且正是官方放「热卖中」入口的地方）');
  if (!DRY) KWK.buy_url = NEW_BUY_URL;
}

/* ---------------------------- schema 版本 ---------------------------- */
if (needSchemaBump) {
  log.push('  schema_version ' + prevSchema + ' → ' + NEXT_SCHEMA + '（新增可选字段 purchase）');
  if (!DRY) data.meta.schema_version = NEXT_SCHEMA;
}

/* ---------------------------- 字段约定同步 ---------------------------- */
/* 追加式，不整段覆盖 —— 与 migrate-price-model.js / migrate-price-caliber-v2.js 同一套做法。
   原因很实际：这几轮都往同一个字段里加规矩，谁整段重写谁就会把别人补的那条抹掉。 */
if (convNeedsWork) {
  log.push('  meta.field_convention ' + (convCur.indexOf(CONV_MARK) < 0 ? '追加 purchase 规矩' : '规范拼接符'));
  if (!DRY) data.meta.field_convention = convNext;
}

/* ---------------------------- changelog ---------------------------- */
if (!data.meta.changelog) data.meta.changelog = [];
const VERSION = '1.2.0';
const entry = {
  date: '2026-09-28',
  version: VERSION,
  changes: [
    '结构新增：为套餐增加可选字段 purchase（可购买性），status 五态 + as_of + evidence + source + note',
    '已核实并写入 5 条：千帆 Coding Plan = 停止新购（2026-07-13 起，一手公告）、千帆 Token Plan = 在售（同日全面开放购买）、' +
      '阿里百炼 Coding Plan = 限量抢购（Coding Plan Lite 已于 2026-03-20 停止新购）、Kimi = 暂停 C 端新订阅（2026-07-19，二手转引）、' +
      '快手 KwaiKAT = 无法核实（官方营销页 404、无公开定价页）',
    'kwaikat-coding-plan.buy_url 由已 404 的 /marketing/coding-plan 改指官方万擎产品页 /product/wanqing',
    '修正上一版结论：千帆 Coding Plan 与 Token Plan **不是并行在售**，实为「停售 + 替代」',
  ],
  evidence: '一手：百度智能云《Token Plan个人版上线及Coding Plan停售公告》https://cloud.baidu.com/doc/qianfan/s/Fmrexuejc （更新于 2026-07-10）；' +
    '阿里云《Token Plan 概述》https://help.aliyun.com/zh/model-studio/token-plan-overview （更新于 2026-09-22）；' +
    '快手站点地图与页面实测（2026-09-28）。二手：Kimi 公告经新华财经等媒体转引 https://www.cnfin.com/gs-lb/detail/20260720/4442734_1.html 。',
  note: '新增可选字段，老读取端不受影响；缺失态必须由读取端显示为「未核实」，不许默认按在售处理。' +
    'schema_version 由 1.1.0 升至 1.2.0（结构变更）。其余 16 个套餐保持缺失，待逐一核实后再写。',
};
if (!data.meta.changelog.some((c) => c.version === VERSION)) {
  if (!DRY) data.meta.changelog.unshift(entry);
  log.push('  meta.changelog 追加 ' + VERSION + ' 条目');
}

/* ---------------------------- 输出 ---------------------------- */
console.log('=== 新增「可购买性」维度 + 修正快手 buy_url ===');
console.log(log.join('\n'));
console.log('');
const alreadyIn = data.plans.filter((p) => p.purchase).length;
const afterIn = alreadyIn + (DRY ? pending.length : 0);
console.log('  本次写入 ' + pending.length + ' 条；写入后已核实 ' + afterIn +
  ' 个，其余 ' + (data.plans.length - afterIn) + ' 个保持缺失（= 未核实，前端显示「未核实」，不按在售处理）');
console.log('');

if (DRY) {
  console.log('[DRY-RUN] 未写入任何文件。去掉 --dry-run 才会生效。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const bakDir = path.join(ROOT, 'data', 'backups');
fs.mkdirSync(bakDir, { recursive: true });
const bak = path.join(bakDir, 'plans-before-purchase-status-' + stamp + '.json');
fs.writeFileSync(bak, ORIGINAL_RAW, 'utf8');   // 改动前的原文，可原样还原

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('[OK] 已写入 data/plans.json');
console.log('[OK] 备份 ' + path.relative(ROOT, bak));

/* ---------------------------- 立即校验，不过就回滚 ---------------------------- */
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'validate.js')],
    { encoding: 'utf8', cwd: ROOT });
  console.log('\n' + out.split('\n').filter((l) => /\[OK\]|\[FAIL\]|厂商|套餐|档位|可购买/.test(l)).join('\n'));
} catch (e) {
  console.error('\n[FAIL] 写入后校验未通过，正在回滚…');
  fs.copyFileSync(bak, FILE);
  console.error((e.stdout || '') + (e.stderr || ''));
  console.error('已从 ' + path.relative(ROOT, bak) + ' 还原。');
  process.exit(1);
}

console.log('\n[OK] 下一步：node codingplan/scripts/build-data-module.js');
