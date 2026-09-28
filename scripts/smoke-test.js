#!/usr/bin/env node
/**
 * 前端渲染冒烟测试（jsdom）
 * 真实执行 index.html 里的脚本，验证渲染结果与交互链路
 * 用法: NODE_PATH=.../node/workspace/node_modules node codingplan/scripts/smoke-test.js
 */
const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('[SKIP] 未找到 jsdom。安装：cd <node-workspace> && npm install jsdom');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const html0 = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const plansJs = fs.readFileSync(path.join(ROOT, 'data', 'plans.js'), 'utf8');
const sharedJs = fs.readFileSync(path.join(ROOT, 'js', 'shared.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');

/* 结构性计数一律从数据推导，不写死。
 * 原因很实际：写死之后每加一个套餐/档位都会"红一片"，而失败项又都不是真故障 ——
 * 误报多了人就会习惯性忽略失败，测试也就废了。
 * 「数字本身对不对」交给 validate.js（它专管 meta.counts 与实际数据是否自洽），
 * 这里只管「渲染结果与数据是否一致」。 */
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'plans.json'), 'utf8'));
const BILLING = {};
DATA.billing_types.forEach((b) => { BILLING[b.key] = b; });
const ALL_TIERS = DATA.plans.reduce((a, p) => a.concat(p.tiers.map((t) => ({ plan: p, tier: t }))), []);
const PLAN_N = DATA.plans.length;
const TIER_N = ALL_TIERS.length;
// 与 app.js 的 unitCost() 同条件：能算出单位成本的档位
const hasUnitCost = (r) => {
  const d = r.tier.derived;
  if (!d) return false;
  const k = r.plan.billing_type;
  if ((k === 'token' || k === 'requests') && d.cost_per_1m_tokens_est != null) return true;
  return d.cost_per_unit != null && d.quota_month != null;
};
// 与 app.js 的 cross 标记同条件：可跨口径比较（每百万 Token）
const isCross = (r) => {
  const d = r.tier.derived;
  if (!d) return false;
  const k = r.plan.billing_type;
  return (k === 'token' || k === 'requests') && d.cost_per_1m_tokens_est != null;
};
const WITH_UNIT_N = ALL_TIERS.filter(hasUnitCost).length;
const CROSS_N = ALL_TIERS.filter(isCross).length;
const TOKEN_N = ALL_TIERS.filter((r) => r.plan.billing_type === 'token').length;
const REQUEST_N = ALL_TIERS.filter((r) => r.plan.billing_type === 'requests').length;

// 把外链脚本内联，避免 jsdom 的本地资源加载。
// 注意：替换参数必须用函数形式。字符串形式里 $' $$ $& 等是特殊模式，
// 而数据与代码里天然会有 "$20"、"$'" 这类内容 —— 用字符串会把 HTML 的其余部分
// 当成「匹配之后的文本」注入进来，产生莫名其妙的 SyntaxError。
// js/shared.js 同样必须内联。它一旦漏掉，window.__CP__ 就是 undefined，
// 而崩溃点会落在 app.js 里第一个用到它的地方 —— 离真正的原因（这行漏了）很远。
const html = html0
  .replace('<script src="data/plans.js"></script>', () => '<script>' + plansJs + '</script>')
  .replace('<script src="js/shared.js"></script>', () => '<script>' + sharedJs + '</script>')
  .replace('<script src="js/app.js"></script>', () => '<script>' + appJs + '</script>');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => errors.push('console.warn: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://127.0.0.1:8899/',
  pretendToBeVisual: true,
  virtualConsole: vc,
});

const { window } = dom;
window.alert = function () {}; // 超限提示用，避免 jsdom 的 not-implemented 报错
const doc = window.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => Array.from(doc.querySelectorAll(s));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

const checks = [];
const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

/* ---------------- 0. 共享层已加载 ---------------- */
// window.__CP__ 由 js/shared.js 提供，app.js 启动时就依赖它。
// 断言放在最前面：它要是 undefined，后面 100 多条断言会一起红，
// 而失败原因全都指向 app.js —— 真正的原因（script 标签漏了）会被淹没。
const CP = window.__CP__;
ok('window.__CP__ 已定义（js/shared.js 已加载）', !!CP);
['purchaseOf', 'purchaseStatus', 'isBuyable', 'isClosed', 'purchaseRank',
 'unitCost', 'priceDelta', 'hl', 'esc', 'md', 'confTitle'].forEach((fn) => {
  ok('共享层导出 ' + fn + '()', !!CP && typeof CP[fn] === 'function');
});
ok('共享层的可购买性五态标签齐全',
  !!CP && ['on_sale', 'limited', 'closed_new', 'login_only', 'unverifiable']
    .every((k) => CP.PURCHASE_LABEL[k]),
  CP ? Object.keys(CP.PURCHASE_LABEL).join(',') : '(无)');
ok('index.html 在 app.js 之前引入 js/shared.js',
  html0.indexOf('js/shared.js') !== -1 &&
  html0.indexOf('js/shared.js') < html0.indexOf('js/app.js'));
// 共享层判定的自检：拿数据集里真实的套餐跑一遍，确认判定没有反
if (CP) {
  const qfCoding = DATA.plans.find((p) => p.id === 'baidu-qianfan-coding-plan');
  const noPurchase = DATA.plans.find((p) => !p.purchase);
  ok('共享层判定：千帆 Coding Plan 买不到', !!qfCoding && CP.isClosed(qfCoding) && !CP.isBuyable(qfCoding));
  ok('共享层判定：未核实 ≠ 在售（isBuyable 为 false，且不是 closed）',
    !!noPurchase && !CP.isBuyable(noPurchase) && !CP.isClosed(noPurchase) && CP.isUnverified(noPurchase),
    noPurchase ? noPurchase.id : '(无未核实套餐)');
  ok('共享层判定：未核实排在在售之后、停止新购之前（权重 0<2<4）',
    CP.purchaseRank({ purchase: { status: 'on_sale' } }) < CP.purchaseRank({}) &&
    CP.purchaseRank({}) < CP.purchaseRank({ purchase: { status: 'closed_new' } }));
}

/* ---------------- 1. 静态渲染 ---------------- */
ok('概览统计渲染出 5 个卡片', $$('#stats li').length === 5, $$('#stats li').length);
ok('快照日期已写入顶栏', /2026-09-28/.test($('#snapLabel').textContent), $('#snapLabel').textContent);
ok('计费口径筛选器 = 5 个', $$('#billingChips .chip').length === 5);
ok('场景筛选器 = 5 个', $$('#useCaseChips .chip').length === 5);
ok('口径说明卡 = 5 张', $$('#billingExplain .excard').length === 5);
ok('折算假设说明已渲染', /8,000 tokens/.test($('#estNote').textContent));

const rowCount = $$('#matrixBody tr').length;
ok('矩阵渲染 ' + TIER_N + ' 个档位（与 plans.json 一致）', rowCount === TIER_N, rowCount);
const rcText = $('#resultCount').textContent;
ok('结果计数同时报出档位数与套餐数',
  rcText.indexOf(String(TIER_N)) !== -1 && rcText.indexOf(String(PLAN_N)) !== -1, rcText.trim());

// 首行应是最便宜的档位（默认按月费升序）
const firstPrice = $$('#matrixBody tr')[0].querySelector('.price').textContent;
ok('默认排序首行为最低价（免费）', /免费/.test(firstPrice), firstPrice);

// 单位成本列：可折算 / 未公开额度（.unit--none 也带 .unit 类，需排除）
const unitCells = $$('#matrixBody .unit:not(.unit--none)').length;
ok('单位成本列渲染 ' + WITH_UNIT_N + ' 项', unitCells === WITH_UNIT_N, unitCells);
const noneCells = $$('#matrixBody .unit--none').length;
ok('未公开额度档位标注 ' + (TIER_N - WITH_UNIT_N) + ' 项', noneCells === TIER_N - WITH_UNIT_N, noneCells);
ok('单位成本列 + 缺省列 = ' + TIER_N, unitCells + noneCells === TIER_N, unitCells + noneCells);

/* ---------------- 2. 搜索 ---------------- */
const q = $('#q');
q.value = 'claude code';
fire(q, 'input');
const afterSearch = $$('#matrixBody tr').length;
ok('搜索 "claude code" 能筛出结果', afterSearch > 0 && afterSearch < TIER_N, afterSearch);

q.value = 'GLM-5.3';
fire(q, 'input');
ok('搜索模型名 "GLM-5.3" 能命中', $$('#matrixBody tr').length > 0, $$('#matrixBody tr').length);

q.value = 'zzz-不存在';
fire(q, 'input');
ok('无结果时显示空状态', $$('#matrixBody tr').length === 0 && $('#tableEmpty').hidden === false);

q.value = '';
fire(q, 'input');
ok('清空搜索恢复 ' + TIER_N + ' 行', $$('#matrixBody tr').length === TIER_N, $$('#matrixBody tr').length);

/* ---------------- 3. 筛选器 ---------------- */
click($('#billingChips .chip[data-b="token"]'));
ok('只选 token 口径 -> ' + TOKEN_N + ' 行', $$('#matrixBody tr').length === TOKEN_N, $$('#matrixBody tr').length);
click($('#billingChips .chip[data-b="token"]'));

click($('#billingChips .chip[data-b="requests"]'));
ok('只选 requests 口径 -> ' + REQUEST_N + ' 行', $$('#matrixBody tr').length === REQUEST_N, $$('#matrixBody tr').length);
click($('#billingChips .chip[data-b="requests"]'));

click($('#useCaseChips .chip[data-u="个人开发者尝鲜"]'));
const tryCount = $$('#matrixBody tr').length;
ok('只看「个人开发者尝鲜」能生效', tryCount > 0 && tryCount < TIER_N, tryCount);
click($('#useCaseChips .chip[data-u="个人开发者尝鲜"]'));

const free = $('#freeOnly');
free.checked = true; fire(free, 'change');
// 摩尔线程 4 档 + Cursor 4 档 = 8 个档位
const freeRows = $$('#matrixBody tr').length;
ok('只看有免费档 -> 8 个档位（2 个套餐）', freeRows === 8, freeRows);
free.checked = false; fire(free, 'change');

const pr = $('#priceRange');
pr.value = '30'; fire(pr, 'input');
ok('月费上限 ¥30 生效', $('#priceVal').textContent === '≤ ¥30' && $$('#matrixBody tr').length > 0, $('#priceVal').textContent);
pr.value = '1400'; fire(pr, 'input');

click($('#resetBtn'));
ok('清空筛选后恢复 ' + TIER_N + ' 行', $$('#matrixBody tr').length === TIER_N, $$('#matrixBody tr').length);

/* ---------------- 4. 排序 ---------------- */
const sort = $('#sort');
sort.value = 'cost-asc'; fire(sort, 'change');
ok('单位成本排序时显示口径提示条', $('#sortNote').hidden === false);
ok('提示条说明了估算与不可比口径', /估算值/.test($('#sortNote').textContent) && /不参与跨厂商比较/.test($('#sortNote').textContent));

// 仅校验「可跨口径比较」的那一段是升序（其余口径按价格垫底，不参与单调性）
const crossCosts = $$('#matrixBody tr').map((tr) => {
  const cell = tr.querySelector('.unit:not(.unit--none)');
  if (!cell || !/每百万 Token/.test(cell.textContent)) return null;
  return parseFloat(cell.querySelector('b').textContent.replace(/[¥,]/g, ''));
}).filter((v) => v != null);
let mono = true;
for (let i = 1; i < crossCosts.length; i++) if (crossCosts[i] < crossCosts[i - 1] - 1e-9) mono = false;
ok('可比口径按单位成本升序排列', mono, crossCosts.slice(0, 4).join(' / '));
ok('最便宜的可比口径排首位（京东云 ¥0.138）', /0\.138/.test($$('#matrixBody tr')[0].querySelector('.unit b').textContent),
  $$('#matrixBody tr')[0].querySelector('.unit b').textContent);
ok('可比口径共 ' + CROSS_N + ' 个', crossCosts.length === CROSS_N, crossCosts.length);

sort.value = 'models-desc'; fire(sort, 'change');
const firstEco = $$('#matrixBody tr')[0].querySelector('.eco').textContent;
ok('模型数降序首行为 15 模型', /15/.test(firstEco), firstEco.trim());
// 官网未公布生态数的套餐必须垫底，不能当成 0。
// 当成 0 会让它显示成"生态最差"，而真相是"官网没说"—— 这是两个完全不同的结论。
const lastEco = $$('#matrixBody tr').slice(-1)[0].querySelector('.eco').textContent;
ok('生态数缺失的套餐在「模型数降序」里垫底（不当成 0）', /官网未公布/.test(lastEco), lastEco.trim());
ok('切回其他排序后提示条隐藏', $('#sortNote').hidden === true);

sort.value = 'price-asc'; fire(sort, 'change');

/* ---------------- 5. 对比器 ---------------- */
// 每次重新查询：勾选后表格会重渲染，旧引用会失效
function pickBox(i) {
  const b = $$('#matrixBody .cmpbox')[i];
  b.checked = true;
  fire(b, 'change');
}
pickBox(0); pickBox(5); pickBox(12);
ok('勾选 3 个档位后对比栏出现', $('#compareBar').hidden === false);
ok('对比栏计数为 3', $('#cmpCount').textContent === '3', $('#cmpCount').textContent);
ok('对比栏列出 3 个条目', $$('#cmpList .cmptag').length === 3);
ok('未选满 2 个前按钮禁用逻辑（已满足）', $('#cmpGo').disabled === false);

click($('#cmpGo'));
ok('对比面板已打开', $('#cmpOverlay').hidden === false);
const cmpRows = $$('#cmpBody .cmptable tr').length;
ok('对比表渲染 > 12 行', cmpRows > 12, cmpRows);
ok('对比表含「归一化单位成本」行', /归一化单位成本/.test($('#cmpBody').textContent));
ok('对比表含「最优」标记', $$('#cmpBody .bestbadge').length > 0, $$('#cmpBody .bestbadge').length);
ok('对比表含差异高亮行', $$('#cmpBody .cmpdiff').length > 0, $$('#cmpBody .cmpdiff').length);
ok('对比结论脚注已渲染', /最优/.test($('#cmpBody .explain__note').textContent));

click($('#cmpOverlay [data-close]'));
ok('对比面板可关闭', $('#cmpOverlay').hidden === true);

click($('#cmpList .cmptag__x'));
ok('移除单个对比项生效', $('#cmpCount').textContent === '2', $('#cmpCount').textContent);

/* ---------------- 6. 超限保护 ---------------- */
pickBox(20); pickBox(30); pickBox(40);
ok('最多 4 个上限被强制', $('#cmpCount').textContent === '4', $('#cmpCount').textContent);
click($('#cmpClear'));
ok('清空对比后对比栏隐藏', $('#compareBar').hidden === true);

/* ---------------- 7. 卡片视图 + 档位切换 ---------------- */
click($('#viewToggle button[data-view="card"]'));
ok('切到卡片视图', $('#cardView').hidden === false && $('#tableView').hidden === true);
const cards = $$('#cardGrid .card');
ok('卡片数 = 套餐数 ' + PLAN_N, cards.length === PLAN_N, cards.length);
const tabs = cards[0].querySelectorAll('.tiertab');
ok('卡片内档位 tab 数 > 1', tabs.length > 1, tabs.length);
const priceBefore = cards[0].querySelector('.card__price b').textContent;
click(tabs[tabs.length - 1]);
const priceAfter = $$('#cardGrid .card')[0].querySelector('.card__price b').textContent;
ok('切换档位后价格随之变化', priceBefore !== priceAfter, priceBefore + ' -> ' + priceAfter);

/* ---------------- 8. 详情面板 ---------------- */
click($('#cardGrid .card [data-detail]'));
ok('详情面板已打开', $('#detailOverlay').hidden === false);
ok('详情含档位表', $$('#detailBody .tiersmini tr').length > 1, $$('#detailBody .tiersmini tr').length);
ok('详情含模型清单', $$('#detailBody .dt__sec').length >= 4);
ok('详情含价格追踪', /价格追踪/.test($('#detailBody').textContent));
ok('详情含购买链接', /target="_blank"/.test($('#detailBody').innerHTML));
click($('#detailOverlay [data-close]'));
ok('详情面板可关闭', $('#detailOverlay').hidden === true);

/* ---------------- 8b. 生态数缺失（官网未公布）必须扛得住 ---------------- */
// 新增千帆 Token Plan 时带出来的新情形：官网只写「主流国产模型」「适配 Cursor、Windsurf、Cline 等」，
// 既没清单也没总数。按本库规矩「官网没公开就留空，不推算填充」，于是 models/tools 字段整体缺失 ——
// 而早期代码是直接读 plan.models.count 的，缺了会抛 TypeError 把整个详情页打白。
const qfCard = $$('#cardGrid .card').find((c) => /千帆 Token Plan/.test(c.textContent));
ok('卡片视图含「千帆 Token Plan 个人版」（与 Coding Plan 并存的第二条百度产品线）', !!qfCard);
ok('生态数缺失时显示「官网未公布」，不是 0、也不是空白',
  !!qfCard && /生态数官网未公布/.test(qfCard.textContent),
  qfCard ? qfCard.querySelector('.eco').textContent.trim() : '(未找到卡片)');
ok('缺失态用了 .eco--unknown 弱化样式，避免看起来像"生态最差"',
  !!qfCard && !!qfCard.querySelector('.eco--unknown'));

click(qfCard.querySelector('[data-detail]'));
const qfDetail = $('#detailBody').textContent;
ok('详情面板为模型与工具各给一条「官网未公布」说明',
  (qfDetail.match(/官网未公布/g) || []).length >= 2, (qfDetail.match(/官网未公布/g) || []).length);
ok('详情面板说明了本库「不推算填充」的立场', /不推算填充/.test(qfDetail));
ok('详情面板未因缺字段而空白（档位表照常渲染）',
  $$('#detailBody .tiersmini tr').length > 1, $$('#detailBody .tiersmini tr').length);
click($('#detailOverlay [data-close]'));

/* ---------------- 8c. 可购买性：价格对、但买不到 ---------------- */
// 本轮新情形。最典型的是千帆 Coding Plan —— 它的 ¥40/¥200 至今与官方文档逐字一致，
// 但自 2026-07-13 起全档位停止新购。只看价格会以为还能买，所以「能不能买到」必须和价格一样被看见。
const withPurchase = DATA.plans.filter((p) => p.purchase);
ok('数据里已有已核实的可购买性（否则本节全是空断言）', withPurchase.length > 0, withPurchase.length + ' 个套餐');

const qfCodingCard = $$('#cardGrid .card').find((c) => /千帆 Coding Plan/.test(c.textContent));
ok('千帆 Coding Plan 卡片标出「停止新购」（价格正确但已不可新购）',
  !!qfCodingCard && /停止新购/.test(qfCodingCard.textContent));

const qfTokenCard = $$('#cardGrid .card').find((c) => /千帆 Token Plan/.test(c.textContent));
ok('千帆 Token Plan 卡片标出「在售」（同厂商另一条产品线状态相反）',
  !!qfTokenCard && /在售/.test(qfTokenCard.textContent));

ok('非「在售」状态一律附带日期，避免把历史状态当成现状',
  !!qfCodingCard && /截至\s*2026-07-13/.test(qfCodingCard.textContent),
  qfCodingCard ? (qfCodingCard.textContent.match(/截至[^）]*/) || ['(无)'])[0] : '(未找到卡片)');

ok('卡片上出现可购买性标记的数量 = 数据里带 purchase 的套餐数（不漏也不增）',
  $$('#cardGrid .card').filter((c) => c.querySelector('.pstate')).length === withPurchase.length,
  $$('#cardGrid .card').filter((c) => c.querySelector('.pstate')).length + ' / ' + withPurchase.length);

// 未核实必须写「未核实」而不是留白 —— 留白会被读成"没限制、可以买"
const unCard = $$('#cardGrid .card').find((c) => {
  const h = c.querySelector('h3');
  const p = DATA.plans.find((x) => x.name === (h ? h.textContent.trim() : ''));
  return p && !p.purchase;
});
ok('未核实可购买性的套餐显示「未核实」，而不是留白',
  !!unCard && /未核实/.test(unCard.textContent),
  unCard ? unCard.querySelector('h3').textContent + ' → ' + (unCard.textContent.match(/未核实/) ? '有' : '无') : '(未找到卡片)');

// 详情页：状态 + 说明 + 依据性质 + 出处
click(qfCodingCard.querySelector('[data-detail]'));
const puDetail = $('#detailBody').textContent;
ok('详情页给出「可购买性 · 停止新购」区块', /可购买性\s*·\s*停止新购/.test(puDetail));
ok('详情页标明依据性质（一手 = 厂商官网）', /依据：厂商官网/.test(puDetail));
const puLink = $('#detailBody a.tag--link');
ok('详情页给出可回溯的出处链接',
  !!puLink && /^https?:\/\//.test(puLink.getAttribute('href')),
  puLink ? puLink.getAttribute('href') : '(无链接)');
ok('详情页可购买性区块排在「档位与定价」之前（买不到的话，价格无从谈起）',
  $('#detailBody').innerHTML.indexOf('可购买性') < $('#detailBody').innerHTML.indexOf('档位与定价'));
click($('#detailOverlay [data-close]'));

// 二手依据（媒体转引）必须标出来，不能冒充实测
const kimiCard = $$('#cardGrid .card').find((c) => /Kimi Code Plan/.test(c.textContent));
click(kimiCard.querySelector('[data-detail]'));
ok('二手依据会标注「媒体转引官方原文」，不冒充实测',
  /媒体转引/.test($('#detailBody').textContent));
click($('#detailOverlay [data-close]'));

/* ---------------- 9. 主题切换 ---------------- */
const themeBtn = $('#themeBtn');
const themeBefore = doc.documentElement.getAttribute('data-theme');
click(themeBtn);
const themeAfter = doc.documentElement.getAttribute('data-theme');
ok('主题可切换', themeBefore !== themeAfter, themeBefore + ' -> ' + themeAfter);

/* ---------------- 10. 静态一致性检查 ---------------- */
// app.js 里引用的每个 id 都必须存在于 index.html，否则是拼写错误
const css = fs.readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');
const ids = new Set();
const re = /getElementById\(\s*'([^']+)'\s*\)/g;
let m;
while ((m = re.exec(appJs)) !== null) ids.add(m[1]);
const missing = [...ids].filter((id) => !new RegExp('id="' + id + '"').test(html0));
ok('app.js 引用的 ' + ids.size + ' 个 id 均存在于 HTML', missing.length === 0, missing.join(', ') || '全部匹配');

// 防御性 CSS 规则：保证 [hidden] 不会被作者样式的 display 覆盖
ok('style.css 含 [hidden] 防御性规则', /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css));

// 弹层初始状态必须是隐藏的
['cmpOverlay', 'detailOverlay', 'compareBar', 'sortNote'].forEach((id) => {
  ok('#' + id + ' 初始为 hidden', doc.getElementById(id).hidden === true);
});

/* ---------------- 11. 价格口径展示（schema 1.1.0） ---------------- */
// 第 7 节的卡片视图测试把视图切走了，而矩阵的 DOM 会停在切换前的状态，
// 此时再改搜索只会重新渲染卡片、矩阵行数仍是旧的 64 行。先切回来。
const tableViewBtn = $('[data-view="table"]');
if (tableViewBtn) click(tableViewBtn);

const qp = $('#q');
const allTiers = window.__PLANS__.plans.flatMap((p) => p.tiers);
const expectList = allTiers.filter((t) => t.price_list_cny && t.price_list_cny !== t.price_cny).length;
const expectForeign = allTiers.filter((t) => t.price_currency && t.price_currency !== 'CNY').length;

// 有官网原价的档位：主价旁出现划线原价
qp.value = '智谱';
fire(qp, 'input');
const zpRows = $$('#matrixBody tr');
ok('搜索「智谱」命中 3 档', zpRows.length === 3, zpRows.length);
const zpList = zpRows.map((tr) => {
  const e = tr.querySelector('.pricelist');
  return e ? e.textContent.replace(/[^\d.]/g, '') : '(缺)';
});
ok('智谱每档都展示划线原价', zpList.every((v) => v !== '(缺)'), zpList.join(' | '));
ok('智谱原价为 ¥118 / ¥538 / ¥1078', JSON.stringify(zpList) === '["118","538","1078"]', zpList.join(' | '));

// 外币定价：主价格必须显示原币，人民币只能以 ≈ 出现（否则会被当成官网标价）
qp.value = 'Cursor';
fire(qp, 'input');
const curTexts = $$('#matrixBody tr').map((tr) => {
  const e = tr.querySelector('.price');
  return e ? e.textContent : '(缺)';
});
ok('Cursor Pro 主价格显示原币 $20', curTexts.some((t) => /\$20/.test(t)), curTexts.join(' | '));
ok('Cursor Pro+ / Ultra 显示官方原币 $60 / $200',
  curTexts.some((t) => /\$60/.test(t)) && curTexts.some((t) => /\$200/.test(t)), curTexts.join(' | '));
ok('Cursor Pro 的人民币值以 ≈ 标注', curTexts.some((t) => /≈\s*¥140/.test(t)), curTexts.join(' | '));
ok('Cursor 免费档仍显示「免费」', curTexts.some((t) => /免费/.test(t)), curTexts.join(' | '));

qp.value = '';
fire(qp, 'input');

// 划线原价的数量必须与数据一致 —— 多一个就是把实付价划掉了，少一个是漏渲染
const listTotal = $$('#matrixBody .pricelist').length;
ok('划线原价数量与数据一致（' + expectList + ' 档）', listTotal === expectList, listTotal);
// 3 档 = 智谱三档月付原价。原先还有 MiniMax 的三档，但 2026-09-28 实测官网并无 9 折，
// 换算依据撤销后 price_list_cny 一并不存在了 —— 没有原价就不该有原价字段。
ok('数据里确实记录了 3 档官网原价（智谱）', expectList === 3, expectList);
// 4 档 = Cursor Pro/Pro+/Ultra（$20/$60/$200）+ OpenCode 标准版（$10）
ok('数据里确实标注了 4 档外币定价', expectForeign === 4, expectForeign);

// Cursor 曾把 Pro+/Ultra 的官网标价标为「未核实」，现在已从页面内嵌的结构化数据补全
const curPlan = window.__PLANS__.plans.find((p) => p.id === 'cursor-plan');
ok('Cursor 的说明里不再出现「未核实」', !/未核实/.test(curPlan.price_note || ''), curPlan.price_note);
ok('Cursor 四档的外币标价齐全（Pro+ $60 / Ultra $200）',
  (() => {
    const f = {};
    curPlan.tiers.forEach((t) => { f[t.id] = t.price_foreign; });
    return f['cursor-plan-pro'] === 20 && f['cursor-plan-pro-plus'] === 60 && f['cursor-plan-ultra'] === 200;
  })(),
  curPlan.tiers.map((t) => t.name + '=' + t.price_foreign).join(' '));

// MiniMax：官网标价 49/119/469，且不应再出现「9 折」或 44.1 这类反推值
const mmTiers = allTiers.filter((t) => /^minimax-token-plan-/.test(t.id));
ok('MiniMax 三档价格等于官网标价 49/119/469',
  JSON.stringify(mmTiers.map((t) => t.price_cny)) === '[49,119,469]',
  JSON.stringify(mmTiers.map((t) => t.price_cny)));
ok('MiniMax 不再有反推出来的原价字段',
  mmTiers.every((t) => t.price_list_cny == null),
  mmTiers.map((t) => t.price_list_cny).join(' | '));
// 说明里可以「提到」9 折（那是被撤销的历史，要留痕），但必须讲清楚它已被推翻：
// 只留「连续包月 9 折」而不说明撤销，等于继续把假设当事实展示。
ok('MiniMax 的说明把「9 折」标注为已撤销的旧口径',
  mmTiers.every((t) => /无折扣说明/.test(t.price_note || '') && /未能在官网找到依据/.test(t.price_note || '') && /已修正/.test(t.price_note || '')),
  mmTiers.map((t) => t.price_note).join(' | '));
ok('MiniMax 的差异化说明（positioning）不再宣称 9 折',
  !/9\s?折|44\.1/.test(window.__PLANS__.plans.find((p) => p.id === 'minimax-token-plan').positioning),
  window.__PLANS__.plans.find((p) => p.id === 'minimax-token-plan').positioning);

// 腾讯云两版：应从「仅宣传语」变成可自动解析的来源（sources.json 不在数据模块里，直接读文件）
const srcJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'collect', 'sources.json'), 'utf8'));
const tcHy = srcJson.sources.find((s) => s.planId === 'tencent-hy-token-plan');
const tcGen = srcJson.sources.find((s) => s.planId === 'tencent-general-token-plan');
ok('腾讯云 Hy 来源已改为 verified + blocks',
  tcHy && tcHy.status === 'verified' && tcHy.extract.type === 'blocks',
  tcHy && (tcHy.status + '/' + tcHy.extract.type));
ok('腾讯云通用版来源配了 tab 点击交互',
  !!(tcGen && tcGen.render && Array.isArray(tcGen.render.actions) &&
     tcGen.render.actions.some((a) => /通用 Token Plan/.test(a.click || ''))),
  JSON.stringify(tcGen && tcGen.render));
ok('采集配置里不再有用于折扣推断的 priceScale',
  !srcJson.sources.some((s) => s.extract && s.extract.priceScale != null),
  srcJson.sources.filter((s) => s.extract && s.extract.priceScale != null).map((s) => s.planId).join(', '));
ok('Cursor 来源改用 jsonld 结构化数据（无需浏览器渲染）',
  (() => {
    const c = srcJson.sources.find((s) => s.planId === 'cursor-plan');
    return c && c.extract.type === 'jsonld' && !c.render;
  })(),
  JSON.stringify(srcJson.sources.find((s) => s.planId === 'cursor-plan') && srcJson.sources.find((s) => s.planId === 'cursor-plan').extract));

// 防御性 CSS：划线样式必须存在，否则原价和实付价看起来一样
ok('style.css 含 .pricelist 划线样式', /\.pricelist\s*\{[^}]*line-through/.test(css));

// 生态数（模型/工具）可能整体缺失：取值、排序、渲染都必须走同一套守卫
ok('app.js 用 ecoCount / ecoRank / ecoSection 统一处理可能缺失的生态数',
  /function ecoCount\(/.test(appJs) && /function ecoRank\(/.test(appJs) && /function ecoSection\(/.test(appJs));
ok('app.js 里不再有裸的 .models.count / .tools.count 读取（缺字段会抛 TypeError）',
  !/\.(?:models|tools)\.count/.test(appJs),
  (appJs.match(/.*\.(?:models|tools)\.count.*/g) || []).join(' | ').slice(0, 120));
ok('style.css 含 .eco--unknown 与 .dt__hint（缺失态需要专门样式，只是"能用"不够）',
  /\.eco--unknown\s*\{/.test(css) && /\.dt__hint\s*\{/.test(css));
ok('可购买性判定统一走共享层 CP.purchaseOf（桌面/移动同一套口径）',
  /\bCP\.purchaseOf\(/.test(appJs) && /function purchaseOf\(/.test(sharedJs));
ok('app.js 保留 purchaseCell / purchaseSection 两个渲染入口（判定共用，画法各写）',
  /function purchaseCell\(/.test(appJs) && /function purchaseSection\(/.test(appJs));
ok('单位成本口径统一走共享层 CP.unitCost',
  /\bCP\.unitCost\(/.test(appJs) && /function unitCost\(/.test(sharedJs));
ok('app.js 与 shared.js 都没有裸的 .purchase.status 读取（未核实套餐会抛 TypeError）',
  !/\.purchase\.status/.test(appJs) && !/\.purchase\.status/.test(sharedJs),
  ((appJs + sharedJs).match(/.*\.purchase\.status.*/g) || []).join(' | ').slice(0, 120));
ok('style.css 含「在售/停止新购/未核实」三态样式（状态靠颜色区分，缺一态就会看着一样）',
  /\.pstate--on_sale\s*\{/.test(css) && /\.pstate--closed_new\s*\{/.test(css) && /\.pstate--unverifiable\s*\{/.test(css));

/* ---------------- 12. 无运行期报错 ---------------- */
ok('无 JS 运行期报错', errors.length === 0, errors.slice(0, 3).join(' | '));

/* ---------------- 输出 ---------------- */
const pass = checks.filter((c) => c.pass).length;
console.log('=== 前端渲染冒烟测试 ===\n');
checks.forEach((c) => {
  console.log((c.pass ? '  [PASS] ' : '  [FAIL] ') + c.name + (c.detail !== undefined ? '  → ' + c.detail : ''));
});
console.log('\n通过 ' + pass + ' / ' + checks.length);
if (errors.length) {
  console.log('\n--- 运行期错误 ---');
  errors.forEach((e) => console.log('  ' + e));
}
window.close();
process.exit(pass === checks.length ? 0 : 1);
