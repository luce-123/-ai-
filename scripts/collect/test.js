#!/usr/bin/env node
'use strict';
/**
 * 采集层自测：用 fixtures 离线验证「提取 → 去重 → 比对 → 报告 → 应用」全链路。
 * 用法: node codingplan/scripts/collect/test.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { extract, parseNumber } = require('./lib/extract');
const { diffPlan, buildReport } = require('./lib/diff');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const DATA_FILE = path.join(ROOT, 'data', 'plans.json');
const REPORT_FILE = path.join(ROOT, 'data', 'pending-changes.json');

const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
const planById = {};
dataset.plans.forEach((p) => { planById[p.id] = p; });
const sourceById = {};
sources.sources.forEach((s) => { sourceById[s.planId] = s; });

const fx = (n) => fs.readFileSync(path.join(FIXTURE_DIR, n), 'utf8');

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

/* ---------------- 1. 数值归一化 ---------------- */
ok('parseNumber "1,200" = 1200', parseNumber('1,200') === 1200);
ok('parseNumber "1.2万" = 12000', parseNumber('1.2万') === 12000);
ok('parseNumber "3.2亿" = 320000000', parseNumber('3.2亿') === 320000000);
ok('parseNumber "9.9" = 9.9', parseNumber('9.9') === 9.9);
ok('parseNumber "无价格" = null', parseNumber('无价格') === null);
ok('parseNumber null 安全', parseNumber(null) === null);

/* ---------------- 2. pair 策略提取 ---------------- */
const unicom = sourceById['unicom-yuanjing-token-plan'];
const exU = extract(fx('unicom-yuanjing.html'), unicom.extract);
ok('联通元景：提取到 3 条候选', exU.entries.length === 3, exU.entries.length);
ok('联通元景：策略识别为 pair', exU.strategy === 'pair');
ok('联通元景：价格 = [15, 30, 45]',
  JSON.stringify(exU.entries.map((e) => e.price)) === '[15,30,45]',
  JSON.stringify(exU.entries.map((e) => e.price)));
ok('联通元景：同时提取到额度',
  exU.entries.every((e) => e.quota && e.quota.length > 0),
  exU.entries.map((e) => e.quota).join(' | '));
ok('联通元景：额度内容正确（600万/1200万/1800万）',
  /600万/.test(exU.entries[0].quota) && /1,200万/.test(exU.entries[1].quota) && /1,800万/.test(exU.entries[2].quota),
  exU.entries.map((e) => e.quota).join(' | '));
ok('联通元景：跳过了非「个人版价格」条目', exU.skipped.length > 0, exU.skipped.length);
ok('联通元景：每条都带证据片段', exU.entries.every((e) => e.context && e.context.length > 10));

/* ---------------- 3. 去重 ---------------- */
// 动机：腾讯页的「39元/月起」在 meta 标签、内联 JSON、正文里各出现一次，
// 不去重会让「按序号对齐」整体错位（3 个 39 会把后面几档挤到错误位置）。
// 该来源后来升级成了 blocks 策略，所以这里直接用页面原文验证去重逻辑本身。
const rawTc = fx('tencent-tokenplan.html');
const dupHits = (rawTc.match(/[0-9][0-9,]*\s*元\/月起/g) || []).length;
ok('腾讯页原文里「39元/月起」确实重复出现 3 次', dupHits === 3, dupHits);
const exT = extract(rawTc, { type: 'regex', patterns: [{ re: '([0-9][0-9,]*)\\s*元/月起', flags: 'g', label: '起点价' }] });
ok('去重后只剩 1 条候选', exT.entries.length === 1, exT.entries.length);
ok('去重有记录', exT.warnings.some((w) => /去重/.test(w)), exT.warnings.join(' | '));
ok('去重后保留的值为 39', exT.entries[0] && exT.entries[0].price === 39, exT.entries[0] && exT.entries[0].price);

/* ---------------- 4. 空页面 / 未配置 ---------------- */
const exEmpty = extract('', unicom.extract);
ok('空页面：0 条候选且有告警', exEmpty.entries.length === 0 && exEmpty.warnings.length > 0);
const exManual = extract('<html></html>', { type: 'manual' });
ok('manual 策略：不产生候选', exManual.entries.length === 0 && exManual.strategy === 'manual');
const exUnknown = extract('<html>x</html>', { type: 'nonsense' });
ok('未知策略：不抛异常且有告警', exUnknown.entries.length === 0 && /未知/.test(exUnknown.warnings[0]));

/* ---------------- 5. positional 比对：完全一致时应为 0 变更 ---------------- */
const planU = planById['unicom-yuanjing-token-plan'];
const dU = diffPlan(planU, unicom, exU, { status: 'fixture' });
ok('联通元景：0 项变更', dU.changes.length === 0, JSON.stringify(dU.changes.map((c) => c.tierName)));
ok('联通元景：3 档全部一致性确认', dU.confirmed.length === 3, dU.confirmed.length);
ok('联通元景：无缺失档位', dU.missing.length === 0, dU.missing.join(','));
ok('联通元景：用 positional 模式', dU.mode === 'positional');
ok('联通元景：额度归一化后不再误报', dU.quotaNotes.length === 0,
  JSON.stringify(dU.quotaNotes.map((q) => q.current + ' vs ' + q.extracted)));

/* ---------------- 6. positional 比对：能检测涨价与降价 ---------------- */
function tweak(fixtureHtml, from, to) {
  return fixtureHtml.split('个人版价格：' + from + '元/月').join('个人版价格：' + to + '元/月');
}
const exUp = extract(tweak(fx('unicom-yuanjing.html'), 15, 18), unicom.extract);
const dUp = diffPlan(planU, unicom, exUp, { status: 'fixture' });
ok('涨价 15->18 被检出', dUp.changes.length === 1 && dUp.changes[0].to === 18,
  JSON.stringify(dUp.changes.map((c) => c.from + '->' + c.to)));
ok('19.8% 涨幅被判定为安全可应用', dUp.changes[0] && dUp.changes[0].safe === true, dUp.changes[0] && dUp.changes[0].ratio);
ok('其余两档仍为确认状态', dUp.confirmed.length === 2, dUp.confirmed.length);

const exBig = extract(tweak(fx('unicom-yuanjing.html'), 15, 500), unicom.extract);
const dBig = diffPlan(planU, unicom, exBig, { status: 'fixture' });
ok('异常大涨 15->500 被降级为人工复核', dBig.changes[0] && dBig.changes[0].safe === false,
  dBig.changes[0] && (dBig.changes[0].ratio * 100).toFixed(0) + '%');
ok('异常变动仍保留证据', dBig.changes[0] && String(dBig.changes[0].evidence).length > 10);

/* ---------------- 7. byValue 比对：只确认，不宣称变更 ---------------- */
// byValue 是给「页面只给一串价格、分不清属于哪一档」的来源用的兜底模式。
// 阿里云百炼就是这种：页面写「139元/月，超量88折」，但没说这是哪个档位。
const ali = sourceById['aliyun-bailian-token-plan'];
const exAli = extract(fx('aliyun-bailian.html'), ali.extract);
ok('百炼：提取到价格候选', exAli.entries.length > 0, exAli.entries.length);
const planAli = planById['aliyun-bailian-token-plan'];
const dAli = diffPlan(planAli, ali, exAli, { status: 'fixture' });
ok('百炼：用 byValue 模式', dAli.mode === 'byValue');
ok('百炼：¥139 确认到 Standard 档',
  dAli.confirmed.some((c) => c.tierName === 'Standard 版' && c.price === 139),
  JSON.stringify(dAli.confirmed.map((c) => c.tierName)));
ok('百炼：byValue 下不产生变更项', dAli.changes.length === 0);
ok('百炼：页面上找不到的档位列入 missing', dAli.missing.length >= 1, dAli.missing.length);

// byValue 遇到归属不明的值 → unassigned，不猜
const exStray = extract('限时 ¥888 元/月 抢购', { type: 'regex', patterns: [{ re: '([0-9]+)\\s*元/月', flags: 'g', label: '测试' }] });
const dStray = diffPlan(planAli, ali, exStray, { status: 'fixture' });
ok('归属不明的价格进 unassigned 而非变更', dStray.changes.length === 0 && dStray.unassigned.length === 1,
  dStray.changes.length + '/' + dStray.unassigned.length);
ok('unassigned 触发告警', dStray.warnings.some((w) => /无法归属/.test(w)));

/* ---------------- 8. 配置与数据集一致性 ---------------- */
const badPlan = sources.sources.filter((s) => !planById[s.planId]);
ok('sources.json 无悬空 planId', badPlan.length === 0, badPlan.map((s) => s.planId).join(','));
const badTier = [];
sources.sources.forEach((s) => {
  (s.tiers || []).forEach((tid) => {
    const p = planById[s.planId];
    if (p && !p.tiers.some((t) => t.id === tid)) badTier.push(s.planId + '/' + tid);
  });
});
ok('sources.json 无悬空 tierId', badTier.length === 0, badTier.join(','));
const uncovered = dataset.plans.filter((p) => !sourceById[p.id]);
ok('每个套餐都配了采集来源', uncovered.length === 0, uncovered.map((p) => p.id).join(','));
const dflt = sources.sources.filter((s) => !s.status || !s.extract);
ok('每条来源都声明了 status 与 extract', dflt.length === 0, dflt.map((s) => s.planId).join(','));

const allTiers = sources.sources.reduce((n, s) => n + (s.tiers || []).length, 0);
const allTierCount = dataset.plans.reduce((n, p) => n + p.tiers.length, 0);
ok('来源覆盖的档位数 = 数据集档位总数（' + allTierCount + '）', allTiers === allTierCount, allTiers);

/* ---------------- 9. 报告结构 ---------------- */
const results = [
  dU, dUp, dBig, dAli, dStray,
];
const rep = buildReport(results, { generated_at: 'test', dataset_snapshot: dataset.meta.snapshot_date });
ok('报告含 changes / needs_review 两个队列', Array.isArray(rep.changes) && Array.isArray(rep.needs_review));
ok('报告默认 decision 为 pending（不自动应用）',
  rep.changes.concat(rep.needs_review).every((c) => c.decision === 'pending'));
ok('安全变更进 changes 队列', rep.changes.some((c) => c.to === 18));
ok('异常变更进 needs_review 队列', rep.needs_review.some((c) => c.to === 500));
ok('报告条目带厂商名与官网地址', rep.changes.every((c) => c.planName && c.url));
ok('报告汇总数字自洽',
  rep.summary.pending_changes === rep.changes.length && rep.summary.needs_review === rep.needs_review.length,
  JSON.stringify(rep.summary));
ok('报告含 quota_notes 字段', Array.isArray(rep.quota_notes));

/* ---------------- 10. blocks 策略（浏览器渲染后的可见文本） ---------------- */
const R = (n) => fx(n);

// 华为云：2026-09-28 起改走 cards（页面把每档序列化成一张卡片对象）。
// 价格与额度都与数据集逐字吻合，是最干净的可自动比对来源。
const hw = sourceById['huawei-token-plan'];
const exH = extract(fx('cards-huawei.html'), hw.extract);
ok('华为云：策略为 cards', exH.strategy === 'cards', exH.strategy);
ok('华为云：提取到 4 档', exH.entries.length === 4, exH.entries.length);
ok('华为云：价格 = [59,149,399,799]',
  JSON.stringify(exH.entries.map((e) => e.price)) === '[59,149,399,799]',
  JSON.stringify(exH.entries.map((e) => e.price)));
ok('华为云：档位名 = [Lite,Standard,Pro,Max]',
  JSON.stringify(exH.entries.map((e) => e.label)) === '["Lite","Standard","Pro","Max"]',
  JSON.stringify(exH.entries.map((e) => e.label)));
ok('华为云：每档都提取到额度', exH.entries.every((e) => e.quota), JSON.stringify(exH.entries.map((e) => e.quota)));
ok('华为云：额度形态为「5000 万 Tokens」',
  /5000\s*万\s*Tokens/.test(exH.entries[0].quota || ''), exH.entries[0].quota);
ok('华为云：每条都带证据片段', exH.entries.every((e) => e.context && e.context.length > 10));
// 页面里 price.origin 常等于 price.current（同一个数填了两遍，不是在打折）：
// 直接采信会让前端凭空多出一条划线价，所以只在两者不同时才记 listPrice。
ok('华为云：原价与现价相同时不产出假划线价',
  exH.entries.every((e) => e.listPrice === null),
  JSON.stringify(exH.entries.map((e) => e.listPrice)));
// 卡片里的货币写作符号 `"currency":"¥"`；若原样透传，比对器会把它当外币整条跳过
// （判据是 currency !== 'CNY'），四档人民币报价会静默变成「外币定价」。
ok('华为云：货币符号归一为 CNY（否则会被误判成外币而不比对）',
  exH.entries.every((e) => e.currency === 'CNY'),
  JSON.stringify(exH.entries.map((e) => e.currency)));

// 交叉核对：旧的「渲染文本按行分块」配置已退役，但结论必须一字不差。
// 换策略本身不该顺带改动任何一条数据 —— 这才是"能被复现的才算修好"。
const hwBlocksRetired = {
  type: 'blocks',
  on: 'text',
  blockRe: '(?:^|\\n)[ \\t]*(Lite|Standard|Pro|Max)[ \\t]*(?=\\r?\\n)',
  priceRe: '[¥￥]\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)',
  quotaRe: '每订阅月[\\s\\S]{0,14}?([0-9.]+\\s*[万亿]\\s*Tokens?)',
  maxBlock: 420,
};
const exHOld = extract('', hwBlocksRetired, R('render-huawei.txt'));
ok('华为云：退役的 blocks 配置仍能跑通（样本保留，作为交叉核对基准）',
  exHOld.entries.length === 4, exHOld.entries.length);
ok('华为云：cards 与退役 blocks 的结论完全一致（零数据变更）',
  JSON.stringify(exH.entries.map((e) => e.label + '|' + e.price + '|' + e.quota)) ===
  JSON.stringify(exHOld.entries.map((e) => e.label + '|' + e.price + '|' + e.quota)),
  JSON.stringify(exHOld.entries.map((e) => e.label + '|' + e.price + '|' + e.quota)));

// 摩尔线程：页面季度价 ÷3 = 月均；必须用除法，否则 0.3333 会得到 39.9999
const mt = sourceById['mthreads-ai-coding-plan'];
const exM = extract('', mt.extract, R('render-mthreads.txt'));
ok('摩尔线程：提取到 4 档', exM.entries.length === 4, exM.entries.length);
ok('摩尔线程：季度价换算为月均 [0,40,200,400]（无浮点误差）',
  JSON.stringify(exM.entries.map((e) => e.price)) === '[0,40,200,400]',
  JSON.stringify(exM.entries.map((e) => e.price)));
ok('摩尔线程：保留换算前的季度原价 [120,600,1200]',
  JSON.stringify(exM.entries.slice(1).map((e) => e.rawPrice)) === '[120,600,1200]',
  JSON.stringify(exM.entries.slice(1).map((e) => e.rawPrice)));
ok('摩尔线程：换算动作有告警说明', exM.warnings.some((w) => /换算/.test(w)), exM.warnings.join(' | '));

// 智谱：页面同时显示 8 折实付价与原价，取第一个；正文里的「6倍 Lite 用量额度」不能当锚点
const zp = sourceById['zhipu-glm-coding-plan'];
const exZ = extract('', zp.extract, R('render-zhipu.txt'));
ok('智谱：提取到 3 档', exZ.entries.length === 3, exZ.entries.length);
ok('智谱：取 8 折实付价 [94.4,430.4,862.4]',
  JSON.stringify(exZ.entries.map((e) => e.price)) === '[94.4,430.4,862.4]',
  JSON.stringify(exZ.entries.map((e) => e.price)));
ok('智谱：同时记录月付原价 [118,538,1078]',
  JSON.stringify(exZ.entries.map((e) => e.listPrice)) === '[118,538,1078]',
  JSON.stringify(exZ.entries.map((e) => e.listPrice)));
ok('智谱：正文「6倍 Lite 用量额度」未被误判为新档位',
  exZ.entries.filter((e) => e.label === 'Lite').length === 1,
  JSON.stringify(exZ.entries.map((e) => e.label)));
ok('智谱：额度取到「每周 10,000 积分」', /10,000/.test(exZ.entries[0].quota || ''), exZ.entries[0].quota);

// MiniMax：只认「¥X / 月」，顶部年付价 ¥588/1490/5628 必须被跳过。
// 这里刻意不配任何换算系数 —— 页面上没有的数字不许用系数凑出来（历史上那个 0.9 已撤销）
const mm = sourceById['minimax-token-plan'];
const exMM = extract('', mm.extract, R('render-minimax.txt'));
ok('MiniMax：提取到 3 档', exMM.entries.length === 3, exMM.entries.length);
ok('MiniMax：价格就是官网标价 [49,119,469]',
  JSON.stringify(exMM.entries.map((e) => e.price)) === '[49,119,469]',
  JSON.stringify(exMM.entries.map((e) => e.price)));
ok('MiniMax：未做任何系数换算（rawPrice 为空）',
  exMM.entries.every((e) => e.rawPrice == null) && !exMM.warnings.some((w) => /换算/.test(w)),
  JSON.stringify(exMM.entries.map((e) => e.rawPrice)) + ' | ' + exMM.warnings.join(' | '));
ok('MiniMax：配置里没有 priceScale / priceDivisor',
  mm.extract.priceScale == null && mm.extract.priceDivisor == null,
  JSON.stringify({ scale: mm.extract.priceScale, divisor: mm.extract.priceDivisor }));
ok('MiniMax：跳过了顶部年付价（¥588/1490/5628）',
  exMM.entries.every((e) => e.price < 500), JSON.stringify(exMM.entries.map((e) => e.price)));

// 护栏：误用 priceScale 必须告警。这套机制曾经真的骗过我们一次 ——
// 0.9 让 11% 的真实价格差异静默消失了。所以它每次运行都得吱一声。
const exGuard = extract('', { type: 'blocks', on: 'text', blockRe: '(?:^|\\n)(Plus)', priceRe: '([0-9]+)', priceScale: 0.9 }, 'Plus\n49');
ok('误用 priceScale 会触发护栏告警',
  exGuard.warnings.some((w) => /priceScale/.test(w)), exGuard.warnings.join(' | '));
ok('护栏不阻止换算本身，但换算前原值必须留痕',
  exGuard.entries[0].price === 44.1 && exGuard.entries[0].rawPrice === 49,
  JSON.stringify(exGuard.entries[0]));

// run.js 必须把 render.actions 透传给渲染器。
// 这里查源码而不是跑真浏览器：曾经渲染器已经支持 actions，run.js 却忘了传，
// 结果配置写了等于没写，而且**不报任何错** —— 静默失效最难发现，值得一条廉价护栏。
const runSrc = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
ok('run.js 会把 render.actions 透传给渲染器',
  /opts\.actions\s*=\s*s\.render\.actions/.test(runSrc),
  (runSrc.match(/.*opts\.actions.*/) || ['(未找到)'])[0].trim());

// Kimi：四档价格与数据集一致
const km = sourceById['kimi-code-plan'];
const exK = extract('', km.extract, R('render-kimi.txt'));
ok('Kimi：提取到 4 档', exK.entries.length === 4, exK.entries.length);
ok('Kimi：价格 = [39,79,159,559]',
  JSON.stringify(exK.entries.map((e) => e.price)) === '[39,79,159,559]',
  JSON.stringify(exK.entries.map((e) => e.price)));

/* ---------------- 10b. 腾讯云活动页：同一页面上的两个套餐系列 ---------------- */
// Hy 系列默认渲染，价格写在「日常价：」后面（数字与「.00 元/月」被分成多行）
const tcHy = sourceById['tencent-hy-token-plan'];
const exTH = extract('', tcHy.extract, R('render-tencent-hy.txt'));
ok('腾讯云 Hy：提取到 4 档', exTH.entries.length === 4, exTH.entries.length);
ok('腾讯云 Hy：价格 = [28,78,238,468]',
  JSON.stringify(exTH.entries.map((e) => e.price)) === '[28,78,238,468]',
  JSON.stringify(exTH.entries.map((e) => e.price)));
ok('腾讯云 Hy：档位名带 Hy 前缀，逐行独占可定位',
  exTH.entries.every((e) => /^Hy 个人版–/.test(e.label)), JSON.stringify(exTH.entries.map((e) => e.label)));
ok('腾讯云 Hy：不提取额度（页面写的是「积分」，与数据集 Token 口径不同，不比对）',
  exTH.entries.every((e) => e.quota == null), JSON.stringify(exTH.entries.map((e) => e.quota)));

// 通用系列：价格藏在 tab 后面。夹具里存的是「点过 tab 之后」的文本
const tcGen = sourceById['tencent-general-token-plan'];
const genText = R('render-tencent-general.txt');
const exTG = extract('', tcGen.extract, genText);
ok('腾讯云通用：提取到 4 档', exTG.entries.length === 4, exTG.entries.length);
ok('腾讯云通用：价格 = [39,99,299,599]',
  JSON.stringify(exTG.entries.map((e) => e.price)) === '[39,99,299,599]',
  JSON.stringify(exTG.entries.map((e) => e.price)));
// 这是本轮交互能力的核心断言：不点 tab，页面上根本没有这四档价格
const exTGnoClick = extract('', tcGen.extract, R('render-tencent-hy.txt'));
ok('腾讯云通用：不点 tab 时一档都取不到（证明必须点）',
  exTGnoClick.entries.length === 0, exTGnoClick.entries.length);
// 两个系列共用同一页面：通用版的锚点不能吃到 Hy 系列那四行，否则价格会整体串档
ok('腾讯云通用：未误吃 Hy 系列的卡片（点过 tab 后页面同时含两个系列）',
  exTG.entries.every((e) => !/^Hy /.test(e.label)), JSON.stringify(exTG.entries.map((e) => e.label)));
ok('腾讯云通用：配置里带了 tab 点击动作',
  !!(tcGen.render && tcGen.render.actions && tcGen.render.actions[0].click === 'text=通用 Token Plan'),
  JSON.stringify(tcGen.render && tcGen.render.actions));

/* ---------------- 10c. jsonld 策略：读页面内嵌的 schema.org 报价 ---------------- */
// Cursor 的 Pro+ / Ultra 在页面上是切换 tab，点了也不换价（点击能命中，卡片上的 $20 不变）。
// 但页面内嵌的结构化数据里全量报价一直都在 —— 等于绕开了整类「价格要交互才出现」的问题，
// 而且静态 HTML 里就有，连浏览器都不用开。
const cur = sourceById['cursor-plan'];
const exCur = extract(fx('cursor-pricing-offers.html'), cur.extract);
ok('Cursor：jsonld 提取到 4 档', exCur.entries.length === 4, exCur.entries.length);
ok('Cursor：价格 = [0,20,60,200]（Hobby/Pro/Pro+/Ultra）',
  JSON.stringify(exCur.entries.map((e) => e.price)) === '[0,20,60,200]',
  JSON.stringify(exCur.entries.map((e) => e.price)));
ok('Cursor：币种识别为 USD', exCur.entries.every((e) => e.currency === 'USD'),
  JSON.stringify(exCur.entries.map((e) => e.currency)));
ok('Cursor：Teams 被显式忽略，且只记一次',
  exCur.skipped.length === 1 && /Teams/.test(exCur.skipped[0]), JSON.stringify(exCur.skipped));
// 同一份数据在页面上出现 3 次（两处 ld+json + 一处 RSC 三层转义副本），必须收敛成 4 条
ok('Cursor：干净 ld+json 与三层转义的 RSC 副本被压平去重',
  exCur.entries.length === 4 && new Set(exCur.entries.map((e) => e.label + e.price)).size === 4,
  JSON.stringify(exCur.entries.map((e) => e.label)));
ok('Cursor：配置声明为 jsonld 且不依赖渲染', cur.extract.type === 'jsonld' && !cur.render,
  cur.extract.type + '/' + (cur.render ? '有 render' : '无 render'));
// 没配 ignore 时，Teams 必须浮出来 —— 页面新增档位不能被静默吞掉
const exCurNoIgnore = extract(fx('cursor-pricing-offers.html'), { type: 'jsonld' });
ok('Cursor：不配 ignore 时 Teams 会出现（新档位不会被静默吞掉）',
  exCurNoIgnore.entries.length === 5 && exCurNoIgnore.entries.some((e) => e.label === 'Teams'),
  exCurNoIgnore.entries.map((e) => e.label).join(','));

// 嵌套与「外壳对象」—— 两个形态都是实测踩过的，用内联 HTML 直接锁住，防止退回手写正则。
//   ① 真 Offer 嵌在父对象的 offers 数组里（schema.org 的标准写法）。
//      早期用「不含嵌套花括号」的正则，会漏掉所有内层 Offer；换成配平扫描但
//      「找到最外层就跳到结尾」的版本，又只剩外层 —— 表现为拿产品名 + 第一个子报价的
//      价格冒充一条报价（Cursor 就这样报出过 "Cursor / USD 0"）。
//   ② 价格放在嵌套的 priceSpecification 里时，外层 Offer **必须留下**：
//      它的子对象没有名字、不构成独立报价，所以「有子对象就丢」的判据会误杀它。
const nestedLd = '<script type="application/ld+json">' + JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Widget',
  description: 'x'.repeat(120),
  offers: [
    { '@type': 'Offer', name: 'Lite', price: '9', priceCurrency: 'CNY' },
    { '@type': 'Offer', name: 'Pro', price: '29', priceCurrency: 'CNY' },
  ],
}) + '</script>';
const exNested = extract(nestedLd, { type: 'jsonld' });
ok('jsonld：嵌套在 offers 数组里的 Offer 全部拿到（不漏内层）',
  exNested.entries.length === 2,
  JSON.stringify(exNested.entries.map((e) => e.label + '=' + e.price)));
ok('jsonld：外层容器不被当成报价（不会拿产品名冒充档位）',
  exNested.entries.every((e) => e.label !== 'Widget') &&
  JSON.stringify(exNested.entries.map((e) => e.label)) === '["Lite","Pro"]',
  JSON.stringify(exNested.entries.map((e) => e.label)));

const specLd = '<script type="application/ld+json">' + JSON.stringify({
  '@type': 'Offer',
  name: 'Solo',
  priceSpecification: { '@type': 'UnitPriceSpecification', price: 60, priceCurrency: 'USD' },
}) + '</script>';
const exSpec = extract(specLd, { type: 'jsonld' });
ok('jsonld：价格在嵌套 priceSpecification 里时，外层 Offer 必须留下',
  exSpec.entries.length === 1 && exSpec.entries[0].price === 60,
  JSON.stringify(exSpec.entries.map((e) => e.label + '=' + e.price)));

/* ---------------- 10d. cards 策略：页面把每档序列化成一张卡片对象 ---------------- */
// （华为云的 cards 断言在第 10 节，它同时是 tierKeyMap 与「零数据变更」的基准）

// ① 同一档位出现两张不同报价的卡片时，必须报警而不是默默取第一张。
//    "沉默地取第一个"会把「页面结构变了」伪装成「价格没变」—— 最坏的失败方式。
const dupCards = '<script type="application/json">' + JSON.stringify([
  { cardId: 'k', title: 'Lite', price: '19', unit: '/月', note: '首购价' },
  { cardId: 'k', title: 'Lite', price: '39', unit: '/月', note: '续费价' },
]) + '</script>';
const exDup = extract(dupCards, { type: 'cards', cardKeys: ['cardId'], nameKeys: ['title'], priceKeys: ['price'] });
ok('cards：同档位两个报价时发出告警', exDup.warnings.some((w) => /不同报价/.test(w)), JSON.stringify(exDup.warnings));
ok('cards：告警里带上两个具体数值，便于人工裁决',
  /19/.test(exDup.warnings.join(' ')) && /39/.test(exDup.warnings.join(' ')), JSON.stringify(exDup.warnings));

// ② filter：同一档位有「积分制 / Token 制」双口径各一张卡片时，只认其中一张。
//    这是真实形态（百度千帆 Token Plan 就是），不能靠"取第一张"蒙。
const dualCards = '<script type="application/json">' + JSON.stringify([
  { cardId: 'k', title: 'Lite', price: '40', tag: '6,600 积分' },
  { cardId: 'k', title: 'Lite', price: '40', tag: '4200 万 Tokens' },
]) + '</script>';
const exDual = extract(dualCards, {
  type: 'cards', cardKeys: ['cardId'], nameKeys: ['title'], priceKeys: ['price'], filter: 'Tokens',
});
ok('cards：filter 只保留目标计费口径，另一口径进 skipped',
  exDual.entries.length === 1 && exDual.skipped.length === 1,
  exDual.entries.length + ' 保留 / ' + exDual.skipped.length + ' 跳过');

// ③ cards 天生带档位名，比对时必须按档位对齐。漏掉它**不会报错**，
//    只会静默退化成 byValue（只确认、不判涨价）—— 所以这里要单独钉一句。
const dCardsMode = diffPlan(planById['huawei-token-plan'], {},
  { strategy: 'cards', entries: [], skipped: [], warnings: [] }, { status: 'render' });
ok('cards：比对模式默认为 positional（diff.js 必须把 cards 算作可定位策略）',
  dCardsMode.mode === 'positional', dCardsMode.mode);

/* ---------------- 10e. blocks + on:'html'：官方文档站，不必渲染 ---------------- */
// 千帆 Coding Plan：386KB 静态文档页，套餐表格直接在正文里。
// 2026-09-28 还更正了来源地址 —— 原地址 /product/codingplan.html 今天售的是
// 另一个产品「Token Plan 个人版」，见第 11 节末尾的产品线说明。
const qf = sourceById['baidu-qianfan-coding-plan'];
const exQf = extract(fx('qianfan-codingplan-doc.html'), qf.extract);
ok('千帆 Coding Plan：策略为 blocks+on:html，且不依赖渲染',
  exQf.strategy === 'blocks' && qf.extract.on === 'html' && !qf.render, exQf.strategy);
ok('千帆 Coding Plan：提取到 2 档（静态 HTML 足够，无需浏览器）',
  exQf.entries.length === 2, exQf.entries.length);
ok('千帆 Coding Plan：价格 = [40,200]',
  JSON.stringify(exQf.entries.map((e) => e.price)) === '[40,200]',
  JSON.stringify(exQf.entries.map((e) => e.price)));
ok('千帆 Coding Plan：额度取到「每订阅月」那一档 [18,000 / 90,000]',
  JSON.stringify(exQf.entries.map((e) => e.quota)) === '["18,000","90,000"]',
  JSON.stringify(exQf.entries.map((e) => e.quota)));

/* ---------------- 10f. cards + filter：同一页两个计费口径 ---------------- */
// 千帆 Token Plan 个人版：该页面与 Coding Plan **并存但不同产品**（页内 title 即「Token Plan 个人版」）。
// 每档有「积分制」和「Token 制」两张卡，档位名一模一样（Mini/Lite/Pro/Max），
// 只能靠 filter:'Tokens' 区分 —— 这是 filter 这个配置项存在的唯一理由。
// 积分与 Token 不成固定比例（跨档 7143/6364/5111/4242），所以只能二选一建模。
const qfT = sourceById['baidu-qianfan-token-plan'];
const exQfT = extract(fx('cards-qianfan.html'), qfT.extract);
ok('千帆 Token Plan：策略为 cards', exQfT.strategy === 'cards', exQfT.strategy);
ok('千帆 Token Plan：只取 Token 制那一列，得到 4 档',
  exQfT.entries.length === 4, exQfT.entries.length);
ok('千帆 Token Plan：档位名 = [Mini,Lite,Pro,Max]',
  JSON.stringify(exQfT.entries.map((e) => e.label)) === '["Mini","Lite","Pro","Max"]',
  JSON.stringify(exQfT.entries.map((e) => e.label)));
ok('千帆 Token Plan：价格 = 常规价 [9.9,40,200,600]（不是首购五折价）',
  JSON.stringify(exQfT.entries.map((e) => e.price)) === '[9.9,40,200,600]',
  JSON.stringify(exQfT.entries.map((e) => e.price)));
ok('千帆 Token Plan：提取到 Token 额度 [1000万 / 4200万 / 2.3亿 / 7亿]',
  /1000\s*万/.test(exQfT.entries[0].quota || '') && /4200\s*万/.test(exQfT.entries[1].quota || '') &&
  /2\.3\s*亿/.test(exQfT.entries[2].quota || '') && /7\s*亿/.test(exQfT.entries[3].quota || ''),
  JSON.stringify(exQfT.entries.map((e) => e.quota)));
ok('千帆 Token Plan：积分制的 4 张卡被跳过（它们是另一个计费口径，不是"新档位"）',
  exQfT.skipped.length === 4, JSON.stringify(exQfT.skipped.slice(0, 2)));
ok('千帆 Token Plan：货币归一为 CNY', exQfT.entries.every((e) => e.currency === 'CNY'),
  JSON.stringify(exQfT.entries.map((e) => e.currency)));

// 口径守卫：Token Plan 的常规价与 Coding Plan **恰好同价**（Lite/Pro 都是 40/200）。
// 这正是必须独立建条目的原因 —— 混在一起会得到"漂亮的假确认"。
// 这条断言把那份巧合固化下来：以后若有人想"合并这两个来源"，它会先说话。
const qfCodingPrices = planById['baidu-qianfan-coding-plan'].tiers.map((t) => t.price_cny);
ok('⚠ 已知巧合：Token Plan 常规价与 Coding Plan 部分同价（所以二者绝不可互相替代）',
  qfCodingPrices.length === 2 && qfCodingPrices[0] === 40 && qfCodingPrices[1] === 200,
  JSON.stringify(qfCodingPrices));
const tokenPlanLower = planById['baidu-qianfan-token-plan'].tiers.map((t) => t.price_cny);
ok('千帆 Token Plan：Lite/Pro 与 Coding Plan 同价（40/200），但多了 Mini 与 Max 两档',
  tokenPlanLower[1] === 40 && tokenPlanLower[2] === 200 && tokenPlanLower.length === 4,
  JSON.stringify(tokenPlanLower));

const dCur = diffPlan(planById['cursor-plan'], cur, exCur, { status: 200 });ok('Cursor：jsonld 走 positional 模式（能按档位名对齐）', dCur.mode === 'positional', dCur.mode);ok('Cursor：外币定价不产生变更，只记录 4 条',
  dCur.changes.length === 0 && dCur.currencyNotes.length === 4,
  dCur.changes.length + ' 变更 / ' + dCur.currencyNotes.length + ' 记录');
ok('Cursor：记录里带上了官网原币价与数据集人民币值',
  dCur.currencyNotes.some((c) => c.tierName === 'Ultra' && c.pagePrice === 200 && c.datasetCny === 1400),
  JSON.stringify(dCur.currencyNotes.map((c) => c.tierName + ' ' + c.pagePrice + '/' + c.datasetCny)));
ok('Cursor：4 档全部对齐，无 missing / unassigned',
  dCur.missing.length === 0 && dCur.unassigned.length === 0,
  JSON.stringify({ missing: dCur.missing.length, unassigned: dCur.unassigned.length }));

// blocks 缺渲染文本时，必须明确说「需要渲染」，不能静默当成 0 条价格
const exNoText = extract('<html></html>', hwBlocksRetired);
ok('blocks 缺渲染文本：给出「需要渲染后的文本」告警',
  exNoText.entries.length === 0 && /需要渲染后的文本/.test(exNoText.warnings[0]), exNoText.warnings[0]);
// on:'html' 模式压根不依赖渲染，缺内容时的说法必须与上面不同 ——
// 否则「页面空了」会被误报成「你没开渲染」，把人引去改一个根本没配错的配置。
const exNoHtml = extract('', { type: 'blocks', on: 'html', blockRe: '(?:^|\\n)(X)(?=\\n)' });
ok('blocks on:html 且页面为空：说是「页面内容为空」而不是「需要渲染」',
  exNoHtml.entries.length === 0 && exNoHtml.warnings[0] === '页面内容为空', exNoHtml.warnings[0]);

/* ---------------- 11. 按档位名对齐（tierKeyMap，不依赖顺序） ---------------- */
const dFor = (srcId, entries, planId, strategy) => diffPlan(
  planById[planId], sourceById[srcId],
  { strategy: strategy || 'blocks', entries, skipped: [], warnings: [] }, { status: 'render' });

const dH = dFor('huawei-token-plan', exH.entries, 'huawei-token-plan', 'cards');
ok('华为云：0 项变更', dH.changes.length === 0, JSON.stringify(dH.changes.map((c) => [c.tierName, c.from, c.to])));
ok('华为云：4 档全部一致性确认', dH.confirmed.length === 4, dH.confirmed.length);
ok('华为云：额度无出入', dH.quotaNotes.length === 0, JSON.stringify(dH.quotaNotes));
ok('华为云：cards 默认即 positional 模式（能发现涨价，而不是退化成只做值确认）', dH.mode === 'positional', dH.mode);
// 卡片里的 `"currency":"¥"` 若不归一，这四档会被整条丢进 currencyNotes：
// 报告上看着平静，实际一条都没比对。用"确认 4 条 + 外币 0 条"把这个坑钉死。
ok('华为云：没有被误判成外币定价（currencyNotes 必须为空）',
  dH.currencyNotes.length === 0, JSON.stringify(dH.currencyNotes.map((c) => c.tierName + ' ' + c.currency)));

const dM = dFor('mthreads-ai-coding-plan', exM.entries, 'mthreads-ai-coding-plan');
ok('摩尔线程：季度价换算后 0 变更', dM.changes.length === 0, JSON.stringify(dM.changes.map((c) => [c.tierName, c.from, c.to])));
ok('摩尔线程：4 档全部确认', dM.confirmed.length === 4, dM.confirmed.length);

const dZ = dFor('zhipu-glm-coding-plan', exZ.entries, 'zhipu-glm-coding-plan');
ok('智谱：8 折口径下 0 变更', dZ.changes.length === 0, JSON.stringify(dZ.changes.map((c) => [c.tierName, c.from, c.to])));

const dMM = dFor('minimax-token-plan', exMM.entries, 'minimax-token-plan');
ok('MiniMax：官网标价与数据集一致，0 变更', dMM.changes.length === 0, JSON.stringify(dMM.changes.map((c) => [c.tierName, c.from, c.to])));

// 百度千帆 Coding Plan：来源地址更正为官方文档页后，首次进入"可自动比对"。
// 注意它此前被判为「仅宣传语」—— 那个判断本身没错，错的是来源 URL 指向了别的产品。
const dQf = dFor('baidu-qianfan-coding-plan', exQf.entries, 'baidu-qianfan-coding-plan');
ok('千帆 Coding Plan：2 档全部确认且 0 变更',
  dQf.confirmed.length === 2 && dQf.changes.length === 0,
  dQf.confirmed.length + ' 确认 / ' + dQf.changes.length + ' 变更');
ok('千帆 Coding Plan：页面写「每订阅月」、数据集写「每月」，不算额度出入',
  dQf.quotaNotes.length === 0, JSON.stringify(dQf.quotaNotes));
ok('千帆 Coding Plan：按 tierKeyMap 对齐，无未归属候选',
  dQf.unassigned.length === 0 && dQf.missing.length === 0,
  JSON.stringify({ u: dQf.unassigned.length, m: dQf.missing.length }));
// 涨价必须能被发现 —— 守住"这份数据不是摆设"
const qfRaised = exQf.entries.map((e) => Object.assign({}, e, { price: e.price * 1.5 }));
const dQfUp = dFor('baidu-qianfan-coding-plan', qfRaised, 'baidu-qianfan-coding-plan');
ok('千帆 Coding Plan：涨价 50% 能被判定为变更',
  dQfUp.changes.length === 2 && dQfUp.confirmed.length === 0,
  JSON.stringify(dQfUp.changes.map((c) => [c.tierName, c.from, c.to])));

// 千帆 Token Plan：cards 策略 + tierKeyMap，逐档对齐
const dQfT = dFor('baidu-qianfan-token-plan', exQfT.entries, 'baidu-qianfan-token-plan', 'cards');
ok('千帆 Token Plan：4 档全部确认且 0 变更',
  dQfT.confirmed.length === 4 && dQfT.changes.length === 0,
  dQfT.confirmed.length + ' 确认 / ' + dQfT.changes.length + ' 变更');
ok('千帆 Token Plan：额度无出入（页写「1000 万 Tokens /月」，库内同字）',
  dQfT.quotaNotes.length === 0, JSON.stringify(dQfT.quotaNotes));
ok('千帆 Token Plan：cards 走 positional（能发现涨价）', dQfT.mode === 'positional', dQfT.mode);
ok('千帆 Token Plan：无未归属候选、无缺失档位',
  dQfT.unassigned.length === 0 && dQfT.missing.length === 0,
  JSON.stringify({ u: dQfT.unassigned.length, m: dQfT.missing.length }));
// 若有人把"首购五折价"当成常规价接进来，必须被判成变更而不是静默通过
const qfFirstBuy = exQfT.entries.map((e) => Object.assign({}, e, { price: e.price / 2 }));
const dQfTBad = dFor('baidu-qianfan-token-plan', qfFirstBuy, 'baidu-qianfan-token-plan', 'cards');
ok('千帆 Token Plan：误接首购五折价（半价）会被判定为变更，不会静默通过',
  dQfTBad.changes.length === 4 && dQfTBad.confirmed.length === 0,
  JSON.stringify(dQfTBad.changes.map((c) => c.tierName + ' ' + c.from + '→' + c.to)));


// 腾讯云两版：4 + 4 档全部一致性确认（此前它们被判为「仅宣传语」，取不到任何数据）
const dTH = dFor('tencent-hy-token-plan', exTH.entries, 'tencent-hy-token-plan');
ok('腾讯云 Hy：4 档全部确认且 0 变更',
  dTH.confirmed.length === 4 && dTH.changes.length === 0,
  dTH.confirmed.length + ' 确认 / ' + dTH.changes.length + ' 变更');
const dTG = dFor('tencent-general-token-plan', exTG.entries, 'tencent-general-token-plan');
ok('腾讯云通用：4 档全部确认且 0 变更',
  dTG.confirmed.length === 4 && dTG.changes.length === 0,
  dTG.confirmed.length + ' 确认 / ' + dTG.changes.length + ' 变更');
ok('腾讯云通用：没有无法归属的候选值（说明逐行锚点没串档）',
  dTG.unassigned.length === 0 && dTG.missing.length === 0,
  JSON.stringify({ unassigned: dTG.unassigned.length, missing: dTG.missing.length }));
ok('腾讯云 Hy：没有无法归属的候选值',
  dTH.unassigned.length === 0 && dTH.missing.length === 0,
  JSON.stringify({ unassigned: dTH.unassigned.length, missing: dTH.missing.length }));

// 换个价格就应当被判定为变更（而不是被某个系数抹平）—— 守住"能发现涨价"的能力
const hyRaised = exTH.entries.map((e) => Object.assign({}, e, { price: e.price + 10 }));
const dRaise = dFor('tencent-hy-token-plan', hyRaised, 'tencent-hy-token-plan');
ok('腾讯云 Hy：涨价 10 元能被判定为变更',
  dRaise.changes.length === 4 && dRaise.confirmed.length === 0,
  JSON.stringify(dRaise.changes.map((c) => [c.tierName, c.from, c.to, c.safe])));

const dK = dFor('kimi-code-plan', exK.entries, 'kimi-code-plan');
ok('Kimi：4 档价格全部吻合', dK.confirmed.length === 4 && dK.changes.length === 0,
  dK.confirmed.length + ' 确认 / ' + dK.changes.length + ' 变更');

// 打乱顺序仍应对齐 —— 证明对齐靠档位名而不是数组位置
const shuffled = [exH.entries[3], exH.entries[0], exH.entries[2], exH.entries[1]];
const dShuf = dFor('huawei-token-plan', shuffled, 'huawei-token-plan', 'cards');
ok('tierKeyMap：打乱顺序后仍 4 档全对（不依赖顺序）',
  dShuf.confirmed.length === 4 && dShuf.changes.length === 0,
  dShuf.confirmed.length + ' 确认 / ' + dShuf.changes.length + ' 变更');

// 页面出现未映射的新档位名：要提示，且不能当成变更
const withNew = exH.entries.concat([{ label: 'Ultra', price: 1299, rawPrice: null, currency: 'CNY', context: 'Ultra 超值档' }]);
const dNew = dFor('huawei-token-plan', withNew, 'huawei-token-plan', 'cards');
ok('tierKeyMap：未映射的新档位名会被提示', dNew.warnings.some((w) => /未映射的档位名/.test(w)), dNew.warnings.join(' | '));
ok('tierKeyMap：未映射档位进 unassigned 而非 changes',
  dNew.changes.length === 0 && dNew.unassigned.length === 1, JSON.stringify({ u: dNew.unassigned.length, c: dNew.changes.length }));

// 外币定价：不判定变更，只记录
const dUsd = dFor('opencode-go', [{ label: 'Go', price: 10, rawPrice: 10, currency: 'USD', context: '订阅 Go $10/月' }], 'opencode-go');
ok('外币定价：不产生变更', dUsd.changes.length === 0, dUsd.changes.length);
ok('外币定价：记录到 currencyNotes 并带上数据集人民币值',
  dUsd.currencyNotes.length === 1 && dUsd.currencyNotes[0].currency === 'USD' && dUsd.currencyNotes[0].datasetCny === 70,
  JSON.stringify(dUsd.currencyNotes));

/* ---------------- 11.5 先离线跑一遍采集，刷新报告 ----------------
 * 下面的 apply 测试要读 data/pending-changes.json。以前这里假定"你之前跑过 run.js"，
 * 一旦报告是旧的/被别的 --only 覆盖过，整个测试就会以 TypeError 崩掉
 * （表现为 "Cannot read properties of undefined (reading 'url')"），
 * 看起来像代码坏了，其实只是前置文件过期。测试必须自给自足。
 */
let regen = '';
try {
  regen = execFileSync(process.execPath, [path.join(__dirname, 'run.js'), '--offline'], {
    encoding: 'utf8', cwd: ROOT,
  });
} catch (e) {
  regen = (e.stdout || '') + (e.stderr || '');
}
ok('离线采集能独立跑通并写出报告', fs.existsSync(REPORT_FILE), REPORT_FILE);

/* ---------------- 12. apply 安全闸门 ---------------- */
let out = '';
try {
  out = execFileSync(process.execPath, [path.join(__dirname, 'apply.js'), '--dry-run'], {
    encoding: 'utf8', cwd: ROOT,
  });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
}
ok('apply 在无 apply 决策时拒绝写入', /没有 decision="apply"/.test(out), out.trim().split('\n')[0]);

// 临时注入一条 apply 决策（仅 dry-run，不改 plans.json），验证变更计划生成正确
let injected = null;
try {
  const original = fs.readFileSync(REPORT_FILE, 'utf8');
  const rep2 = JSON.parse(original);
  const target = rep2.per_source.find((r) => r.planId === 'unicom-yuanjing-token-plan');
  rep2.changes.push({
    decision: 'apply', bucket: 'injected',
    planId: 'unicom-yuanjing-token-plan', planName: '联通元景 Token Plan',
    url: target.url, tierId: 'unicom-yuanjing-token-plan-lite', tierName: 'Lite',
    from: 15, to: 18, delta: 3, ratio: 0.2, safe: true, evidence: '自测注入',
  });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep2, null, 2), 'utf8');
  injected = original;

  const out2 = execFileSync(process.execPath, [path.join(__dirname, 'apply.js'), '--dry-run'], {
    encoding: 'utf8', cwd: ROOT,
  });
  ok('apply 能生成变更计划（dry-run）', /联通元景[\s\S]*?¥15 -> ¥18/.test(out2), out2.split('\n').filter(Boolean)[1] || out2);
  ok('dry-run 明确声明未写入', /DRY-RUN/.test(out2));

  const before = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const lite = before.plans.find((p) => p.id === 'unicom-yuanjing-token-plan')
    .tiers.find((t) => t.id === 'unicom-yuanjing-token-plan-lite');
  ok('dry-run 确实没有改动 plans.json', lite.price_cny === 15, lite.price_cny);

  // from 与当前值不符时必须拒绝（防止用过期报告改库）
  const rep3 = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  rep3.changes[rep3.changes.length - 1].from = 999;
  fs.writeFileSync(REPORT_FILE, JSON.stringify(rep3, null, 2), 'utf8');
  let out3 = '';
  try {
    out3 = execFileSync(process.execPath, [path.join(__dirname, 'apply.js'), '--dry-run'], {
      encoding: 'utf8', cwd: ROOT,
    });
  } catch (e) { out3 = (e.stdout || '') + (e.stderr || ''); }
  ok('报告过期（from 与当前值不符）时拒绝应用', /报告可能已过期/.test(out3), out3.trim().split('\n').slice(-2)[0]);
} finally {
  if (injected != null) fs.writeFileSync(REPORT_FILE, injected, 'utf8');
}
ok('测试结束后已还原 pending-changes.json',
  JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')).changes.every((c) => c.bucket !== 'injected'));

/* ---------------- 12b. 可购买性：价格对 ≠ 买得到 ----------------
 * 本轮的核心发现：2026 年 7 月前后有一轮集中的**可购买性**变动，而价格往往没变。
 * 千帆 Coding Plan 的 ¥40/¥200 至今与官方文档逐字一致，但自 2026-07-13 起全档位停止新购。
 * 涨价会被采集器抓到并报警，停售不会 —— 报告上依然是漂亮的「2 档确认、0 变更」。
 * 所以「能不能买到」必须和价格一样有字段、有出处、有日期。 */
const withPurchase = dataset.plans.filter((p) => p.purchase);
const PURCHASE_STATUSES = ['on_sale', 'limited', 'closed_new', 'login_only', 'unverifiable'];

ok('可购买性只写在已核实的套餐上（未核实的保持缺失，不猜）',
  withPurchase.length > 0 && withPurchase.length < dataset.plans.length,
  withPurchase.length + '/' + dataset.plans.length + ' 个套餐已核实');

const puBad = withPurchase.filter((p) => {
  const u = p.purchase;
  return !PURCHASE_STATUSES.includes(u.status) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(u.as_of || '')) ||
    !['primary', 'secondary'].includes(u.evidence) ||
    !/^https?:\/\//.test(String(u.source || '')) ||
    !u.note || u.note.length < 10;
});
ok('每条 purchase 都凑齐 status / as_of / evidence / source / note（缺一项就无从回溯）',
  puBad.length === 0, puBad.map((p) => p.id).join(', '));

ok('非「在售」状态一律带 as_of（否则会把 2026-07 的停售当成今天停售）',
  withPurchase.filter((p) => p.purchase.status !== 'on_sale').every((p) => !!p.purchase.as_of));

const qfCodingPu = planById['baidu-qianfan-coding-plan'].purchase;
ok('千帆 Coding Plan 记为「停止新购」，生效日 2026-07-13',
  !!qfCodingPu && qfCodingPu.status === 'closed_new' && qfCodingPu.as_of === '2026-07-13',
  qfCodingPu ? qfCodingPu.status + ' @ ' + qfCodingPu.as_of : '(缺失)');
ok('千帆 Coding Plan 的出处是一手公告（不是二手转引）',
  !!qfCodingPu && qfCodingPu.evidence === 'primary' && /cloud\.baidu\.com/.test(qfCodingPu.source));
ok('千帆 Token Plan 记为「在售」—— 同厂商另一条产品线状态相反',
  planById['baidu-qianfan-token-plan'].purchase.status === 'on_sale');
ok('千帆 Coding Plan 的价格本身没动（¥40/¥200）—— 变的只是可购买性',
  JSON.stringify(planById['baidu-qianfan-coding-plan'].tiers.map((t) => t.price_cny)) === '[40,200]',
  planById['baidu-qianfan-coding-plan'].tiers.map((t) => t.price_cny).join('/'));
ok('阿里百炼 Coding Plan 记为「限量抢购」（Lite 已停新购、Pro 售罄不补）',
  planById['aliyun-bailian-coding-plan'].purchase.status === 'limited');

const kimiPu = planById['kimi-code-plan'].purchase;
ok('Kimi 的依据标为二手（媒体转引官方原文），并在 note 里保留「当前未核实」的交代',
  !!kimiPu && kimiPu.evidence === 'secondary' && /转引/.test(kimiPu.note),
  kimiPu ? kimiPu.evidence : '(缺失)');

const kwPu = planById['kwaikat-coding-plan'].purchase;
ok('快手记为「无法核实」—— 查了但查不到，与「没查过」必须区分',
  !!kwPu && kwPu.status === 'unverifiable', kwPu ? kwPu.status : '(缺失)');
ok('快手 buy_url 已不再是那个 404 的营销页',
  !/\/marketing\/coding-plan/.test(planById['kwaikat-coding-plan'].buy_url),
  planById['kwaikat-coding-plan'].buy_url);
ok('快手 buy_url 指向可访问的官方万擎产品页',
  planById['kwaikat-coding-plan'].buy_url === 'https://www.streamlake.com/product/wanqing',
  planById['kwaikat-coding-plan'].buy_url);

ok('schema_version 升到 1.2.0（新增字段属结构变更，不能只记 changelog）',
  dataset.meta.schema_version === '1.2.0', dataset.meta.schema_version);
ok('field_convention 写明了「purchase 缺失 = 未核实，不等于在售」',
  /purchase 描述/.test(dataset.meta.field_convention) && /未核实/.test(dataset.meta.field_convention));

/* ---------------- 13. 同级脚本「能不能跑起来」 ----------------
 * 为什么需要这一节：`report.js` 曾经在「模型覆盖 TOP5」处崩掉
 * （它直接读 plan.models.count，而新套餐的该字段按规矩留空），
 * 而它没有任何自动化覆盖 —— 只在人手动敲命令时才会暴露。
 * 一个只输出报表的脚本，崩了不会影响数据，但会让人以为"没消息就是好消息"。
 * 所以这里只做一件很便宜的事：把它跑一遍，要求退出码为 0。 */
[
  ['validate.js', []],
  ['report.js', []],
  ['report.js', ['--json']],
  ['build-data-module.js', []],
].forEach(([file, args]) => {
  let code = 0;
  let brief = '';
  try {
    brief = execFileSync(process.execPath, [path.join(ROOT, 'scripts', file)].concat(args), {
      encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status == null ? -1 : e.status;
    brief = (e.stdout || '') + (e.stderr || '');
  }
  ok('scripts/' + file + (args.length ? ' ' + args.join(' ') : '') + ' 能正常跑完（exit 0）',
    code === 0, code === 0 ? 'OK' : String(brief).trim().split('\n').slice(-2).join(' | '));
});

/* ---------------- 输出 ---------------- */
const pass = checks.filter((c) => c.pass).length;
console.log('=== 采集层自测 ===\n');
checks.forEach((c) => {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + (c.detail !== undefined && !c.pass ? '  → ' + c.detail : ''));
});
console.log('\n通过 ' + pass + ' / ' + checks.length);
process.exit(pass === checks.length ? 0 : 1);
