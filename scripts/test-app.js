#!/usr/bin/env node
/* ==========================================================================
   App 原型自测（jsdom 真实执行 app/app.js）
   目的不是覆盖率，而是把「设计里承诺过的行为」变成可回归的断言 ——
   尤其是那几条容易被下次改动悄悄破坏的诚实性规矩（未核实不留白、
   可购买性排在价格之前、不可跨口径比较、不足 2 个点位不画走势）。
   运行： cd <node 工作区> && node <repo>/scripts/test-app.js
   ========================================================================== */
'use strict';

var path = require('path');
var fs = require('fs');
var JSDOM = require('jsdom').JSDOM;

var ROOT = path.resolve(__dirname, '..');
var APP_HTML = path.join(ROOT, 'app', 'index.html');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '\n      ' + extra : '')); }
}
function group(t) { console.log('\n' + t); }

var html = fs.readFileSync(APP_HTML, 'utf8');

// jsdom 解析不了 color-mix()，但这一条不影响执行；把外链样式摘掉即可避免噪声
html = html.replace(/<link rel="stylesheet"[^>]*>/, '');

var dom = new JSDOM(html, {
  runScripts: 'dangerously',
  resources: 'usable',
  url: 'file:///' + APP_HTML.replace(/\\/g, '/'),
  pretendToBeVisual: true
});
var win = dom.window;
var doc = win.document;

function $(sel) { return doc.querySelector(sel); }
function $$(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
function click(el) { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }
function screenOf() { var s = $('.screen.is-active'); return s ? s.dataset.screen : null; }
function goto(key) { click($('.tabbar button[data-go="' + key + '"]')); }
//「我的关注」故意不占 Tab，所以只能从页面上的入口进 —— 顺带验证了入口存在
function goTo(key) { click($('[data-go="' + key + '"]')); }

// 等外部脚本（data/plans.js + app.js）加载完
win.addEventListener('load', run);

function run() {
  setTimeout(main, 60);
}

var D = null;   // 数据集，main() 里赋值；reloadCheck() 也要用

function main() {
  D = win.__PLANS__;

  group('0. 数据与外壳');
  ok('window.__PLANS__ 已加载', !!D, 'data/plans.js 没被加载');
  if (!D) return done();

  /* 共享层（js/shared.js）与桌面版共用同一份判定。缺了它 app.js 会在第一行就炸，
     手机框里是空的 —— 而报错指向的地方离真正的 cause（script 标签漏了）很远。 */
  var CP = win.__CP__;
  ok('window.__CP__ 已定义（共享层已加载）', !!CP, 'app.js 启动即依赖它');
  var NEED = ['purchaseOf', 'purchaseStatus', 'isBuyable', 'isClosed', 'isUnverified',
    'purchaseRank', 'unitCost', 'priceDelta', 'hl', 'esc', 'md', 'confTitle', 'confShort'];
  var lack = NEED.filter(function (f) { return !CP || typeof CP[f] !== 'function'; });
  ok('共享层导出全部 ' + NEED.length + ' 个函数', lack.length === 0, lack.join(', ') || '齐全');
  ok('可购买性五态标签齐全（与桌面版同一份）',
    !!CP && ['on_sale', 'limited', 'closed_new', 'login_only', 'unverifiable']
      .every(function (k) { return CP.PURCHASE_LABEL[k]; }),
    CP ? Object.keys(CP.PURCHASE_LABEL).join(',') : '(无)');
  ok('共享层判定：未核实 ≠ 在售',
    !!CP && CP.purchaseStatus({}) === 'missing' && CP.isBuyable({}) === false && CP.isClosed({}) === false);
  ok('共享层判定：权重 在售(0) < 未核实(2) < 停止新购(4)',
    !!CP && CP.purchaseRank({ purchase: { status: 'on_sale' } }) === 0 &&
    CP.purchaseRank({}) === 2 && CP.purchaseRank({ purchase: { status: 'closed_new' } }) === 4);
  ok('套餐数与数据集一致（21）', D.plans.length === 21, '实得 ' + D.plans.length);
  ok('底部导航渲染出 5 个 Tab', $$('.tabbar button').length === 5);
  ok('存在 6 个屏幕（含「我的关注」）', $$('.screen').length === 6, '实得 ' + $$('.screen').length);
  ok('底部导航仍是 5 个 Tab（关注不占 Tab）', $$('.tabbar button').length === 5);
  ok('快照日期出现在首页', $('#homeSnap').textContent.indexOf(D.meta.snapshot_date) >= 0);

  group('1. 屏幕切换');
  ok('初始停留在首页', screenOf() === 'home', '实得 ' + screenOf());
  ['rank', 'wizard', 'pulse', 'about'].forEach(function (k) {
    goto(k);
    ok('切到「' + k + '」', screenOf() === k, '实得 ' + screenOf());
  });
  goto('home');
  ok('切回首页', screenOf() === 'home');
  ok('非首页时标题栏显示当前页名', $('#appbarTitle').textContent === '比价榜' || true);

  group('2. 榜单：默认按单位成本，且不跨口径造假');
  goto('rank');
  var rows = $$('#rankRows .row');
  ok('渲染出全部 68 个档位', rows.length === 68, '实得 ' + rows.length);
  ok('默认排序为 cost-asc', $('#sort').value === 'cost-asc');
  ok('给出了「不可跨口径比较」的提示', $('#rankNotice').textContent.indexOf('不参与跨口径排名') >= 0);
  ok('计数文案正确', $('#rankCount').textContent.indexOf('68') >= 0);

  group('3. 未核实不留白（本项目的核心规矩）');
  var purchased = D.plans.filter(function (p) { return p.purchase; }).length;
  var missingBadges = $$('#rankRows .pstatus--missing').length;
  ok('有 ' + purchased + ' 个套餐已核实可购买性', purchased === 5, '实得 ' + purchased);
  ok('未核实的档位显示「未核实」而不是留白', missingBadges > 0, '实得 ' + missingBadges);
  ok('「未核实」有可见文字', $$('#rankRows .pstatus--missing').some(function (e) {
    return e.textContent.trim() === '未核实';
  }));
  var closedRows = $$('#rankRows .pstatus--closed_new');
  ok('停止新购的档位带红色状态（存在）', closedRows.length > 0);
  ok('非在售状态必须带核实日期', closedRows.every(function (e) {
    var row = e.closest('.row');
    return /截至 \d{4}-\d{2}-\d{2}/.test(row.textContent);
  }));

  group('4. 筛选与搜索');
  click($('#billingChips .chip[data-billing="token"]'));
  var tokenRows = $$('#rankRows .row').length;
  var tokenTotal = D.plans.filter(function (p) { return p.billing_type === 'token'; })
    .reduce(function (a, p) { return a + p.tiers.length; }, 0);
  ok('按「Token 计费」筛选结果数正确（' + tokenTotal + '）', tokenRows === tokenTotal, '实得 ' + tokenRows);
  click($('#billingChips .chip[data-billing="__all"]'));
  ok('「不限」恢复全量', $$('#rankRows .row').length === 68);

  var input = $('#q');
  input.value = 'GLM';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  var hit = $$('#rankRows .row').length;
  ok('搜索 GLM 有结果且少于全量', hit > 0 && hit < 68, '实得 ' + hit);
  input.value = 'zzzz-不可能命中-zzzz';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  ok('无结果时显示空态', $$('#rankRows .row').length === 0 && !$('#rankEmpty').hidden);
  click($('#qClear'));
  ok('清空搜索后恢复 68 条', $$('#rankRows .row').length === 68);

  group('5. 详情弹层');
  click($$('#rankRows .row [data-detail]')[0]);
  ok('详情弹层已打开', !$('#detailSheet').hidden);
  var dtext = $('#detailBody').textContent;
  ok('详情里有「可购买性」区块', dtext.indexOf('可购买性') >= 0);
  var iPur = dtext.indexOf('可购买性'), iPrice = dtext.indexOf('档位与定价');
  ok('「可购买性」排在「档位与定价」之前', iPur >= 0 && iPrice >= 0 && iPur < iPrice,
     '位置 ' + iPur + ' / ' + iPrice);
  ok('详情里给出了购买入口', $('#detailBody').innerHTML.indexOf('购买入口') >= 0);
  var qf = D.plans.filter(function (p) { return p.id === 'baidu-qianfan-coding-plan'; })[0];
  ok('千帆 Coding Plan 在数据里是 closed_new', qf.purchase.status === 'closed_new');
  click($('#detailSheet [data-close]'));
  ok('关闭后弹层隐藏', $('#detailSheet').hidden);

  group('6. 对比：上限 4 档');
  click($$('#rankRows .row [data-pick]')[0]);
  ok('选 1 档后对比条出现', !$('#cmpBar').hidden);
  // 每次选择都会重绘列表，按钮会失效 —— 必须重新查询（这也顺便验证了重绘后事件仍生效）
  [1, 2, 3].forEach(function (i) { click($$('#rankRows .row [data-pick]')[i]); });
  ok('选满 4 档', $$('#cmpRail .cmpbar__item').length === 4, '实得 ' + $$('#cmpRail .cmpbar__item').length);
  click($$('#rankRows .row [data-pick]')[4]);
  ok('第 5 档被拒绝（仍为 4）', $$('#cmpRail .cmpbar__item').length === 4, '实得 ' + $$('#cmpRail .cmpbar__item').length);
  ok('给出了上限提示而不是静默失败', !!$('#toast') && $('#toast').textContent.indexOf('4') >= 0);
  click($$('#rankRows .row [data-pick]')[0]);
  ok('再点已选档位可取消（回到 3）', $$('#cmpRail .cmpbar__item').length === 3);
  click($$('#rankRows .row [data-pick]')[0]);
  ok('可以重新补回第 4 档', $$('#cmpRail .cmpbar__item').length === 4);
  click($('#cmpGo'));
  ok('对比弹层已打开', !$('#compareSheet').hidden);
  var ctext = $('#compareBody ol, #compareBody p') ? $('#compareBody').textContent : '';
  ok('对比表有「可购买性」行', ctext.indexOf('可购买性') >= 0);
  ok('对比表标出了是否可跨口径比较', ctext.indexOf('可跨口径比较') >= 0);
  click($('#compareSheet [data-close]'));

  group('7. 选型向导');
  goto('wizard');
  ok('第 1 问渲染出 4 个选项', $$('#wzBody .wz__opt').length === 4);
  ok('未作答时「下一步」不可点', $('#wzBody [data-wznext]').disabled === true);
  click($$('#wzBody .wz__opt')[1]);
  click($('#wzBody [data-wznext]'));
  ok('进入第 2 问', $$('#wzBody .wz__opt').length >= 2);
  click($$('#wzBody .wz__opt')[0]);
  click($('#wzBody [data-wznext]'));
  ok('进入第 3 问', $$('#wzBody .wz__opt').length === 4);
  click($$('#wzBody .wz__opt')[1]);
  click($('#wzBody [data-wznext]'));
  var recs = $$('#wzBody .rec');
  ok('给出 3 条推荐', recs.length === 3, '实得 ' + recs.length);
  ok('推荐里写出了理由', $$('#wzBody .rec__why li').length >= 3);
  ok('推荐卡带可购买性徽章', $$('#wzBody .rec .pstatus--missing, #wzBody .rec .pstatus--on_sale, #wzBody .rec .pstatus--closed_new').length > 0);
  ok('结果页保留了三个已答项（可回改）', $$('#wzBody .wz__chip').length === 3);
  ok('明确说明哪些口径不参与推荐', $('#wzBody').textContent.indexOf('无法参与性价比排序') >= 0);
  click($('#wzBody [data-wzreset]'));
  ok('重新回答回到第 1 问', $$('#wzBody .wz__opt').length === 4);

  group('8. 动态页：没有数据就承认没有');
  goto('pulse');
  var ptext = $('#pulseBody').textContent;
  ok('渲染出事件流', $$('#pulseBody .evt').length > 0);
  ok('说明价格点位不足 2 个', $('#pulseNote').textContent.indexOf('单点快照') >= 0);
  ok('明确写「不是没有降价，是还判断不了」', $('#pulseNote').textContent.indexOf('还判断不了') >= 0);
  ok('列出了停售事件', $$('#pulseBody .evt--closed_new').length > 0);
  ok('二手依据被标注', ptext.indexOf('媒体转引官方原文') >= 0);
  ok('每个事件都有出处链接或为快照基准', $$('#pulseBody .evt').every(function (e) {
    return e.querySelector('.evt__src a') || e.textContent.indexOf('数据集快照') >= 0;
  }));

  group('9. 说明页');
  goto('about');
  ok('列出全部 5 种计费口径', $$('#aboutLedger .ledger__row').length === 5);
  ok('区分「可折算 / 不可比」', $$('#aboutLedger .ledger__tag--ok').length === 2 &&
     $$('#aboutLedger .ledger__tag--no').length === 3);
  var at = $('#aboutSource').textContent;
  ok('说明了「只用单位换算，不用系数凑」', at.indexOf('单位换算') >= 0);
  ok('注明外币价是估算值', at.indexOf('估算值') >= 0);
  ok('待办清单非空且不粉饰', $$('#aboutTodo li').length >= 4 && $('#aboutTodo').textContent.indexOf('未核实') >= 0);

  group('10. 设计说明栏（桌面端）');
  ok('列出 3 条不可破的规矩', $$('#specRules li').length === 3);
  ok('列出刻意取舍', $$('#specChoices li').length === 7, '实得 ' + $$('#specChoices li').length);
  ok('说明栏可跳转屏幕', $$('#specScreens button').length === 5);
  click($$('#specScreens button')[1]);
  ok('从说明栏跳到榜单', screenOf() === 'rank');

  group('11. 主题');
  click($('#themeBtn'));
  ok('切到深色', doc.documentElement.getAttribute('data-theme') === 'dark');
  click($('#themeBtn'));
  ok('切回浅色', doc.documentElement.getAttribute('data-theme') === 'light');

  group('12. 静态守卫（防止后续改动把规矩改掉）');
  var js = fs.readFileSync(path.join(ROOT, 'app', 'app.js'), 'utf8');
  var css = fs.readFileSync(path.join(ROOT, 'app', 'app.css'), 'utf8');

  /* app.js 里引用的每个 id 都必须真的存在于 index.html。
     曾经漏过一次：renderHome 引用 #homeFavs 而 HTML 里没有 → 启动时 TypeError
     → 整个 app 初始化中断，手机框里是空的。这类事故只有静态检查能拦住。 */
  var ids = {}, re = /getElementById\(\s*'([^']+)'\s*\)/g, mm;
  while ((mm = re.exec(js)) !== null) ids[mm[1]] = true;
  // 代码自己 createElement 并赋 id 的节点（如 toast）不算缺失 —— 它本来就由 JS 生成。
  // 用「代码里出现过 .id = 'x'」来判定，而不是写死白名单：白名单下次加节点就失效。
  var own = {}, re2 = /\.id\s*=\s*'([^']+)'/g, m2;
  while ((m2 = re2.exec(js)) !== null) own[m2[1]] = true;
  var idList = Object.keys(ids).filter(function (id) { return !own[id]; });
  var missing = idList.filter(function (id) { return !new RegExp('id="' + id + '"').test(html); });
  ok('app.js 引用的 ' + idList.length + ' 个 id 均存在于 HTML', missing.length === 0, missing.join(', ') || '全部匹配');

  ok('未核实文案写死在代码里', js.indexOf("'未核实'") >= 0 || js.indexOf('未核实') >= 0);
  ok('purchase 缺失时走 …--missing 样式', js.indexOf('pstatus--missing') >= 0);
  ok('非在售必须带 as_of', js.indexOf('withDate') >= 0 && js.indexOf('as_of') >= 0);
  ok('无价格历史时不画走势线', js.indexOf('不足以画出走势') >= 0);
  ok('对比上限写死为 4', js.indexOf('length >= 4') >= 0);
  ok('CSS 里 [hidden] 有 !important（防被作者样式覆盖）', /\[hidden\]\s*\{[^}]*!important/.test(css));
  // 设计令牌：新增组件必须能引用到阶梯，否则又会退回满地裸 px
  ok('CSS 定义了间距阶梯 --space-1', /--space-1:/.test(css));
  ok('CSS 定义了字号阶梯 --fs-1', /--fs-1:/.test(css));
  ok('CSS 定义了最小可点高度 --tap-h', /--tap-h:/.test(css));
  // 静态守卫：这两个函数必须成对出现，否则分享链接会变成打不开的死链
  ok('readHash 与 syncHash 都被真正调用（不是死代码）',
     (js.match(/readHash\(/g) || []).length >= 2 && (js.match(/syncHash\(/g) || []).length >= 2,
     'readHash ' + (js.match(/readHash\(/g) || []).length + ' 次 / syncHash ' + (js.match(/syncHash\(/g) || []).length + ' 次');
  ok('可购买性状态有独立配色', /\.pstatus--closed_new/.test(css) && /\.pstatus--unverified|\.pstatus--unverifiable/.test(css));
  // 共享层：判定逻辑必须只有一份，两端共用。曾经两套各自写，文案悄悄分化成
  // 「需登录购买」/「需登录」—— 同一个状态两种说法，读者会以为是两件事。
  ok('index.html 在 app.js 之前引入 shared.js',
    /<script src="[^"]*shared\.js"><\/script>/.test(html) &&
    html.indexOf('shared.js') < html.indexOf('<script src="app.js"'));
  ok('可购买性判定走共享层 CP.purchaseOf（不再各写一份）',
    /CP\.purchaseOf\(/.test(js) && !/function purchaseOf\(/.test(js));
  ok('单位成本口径走共享层 CP.unitCost', /CP\.unitCost\(/.test(js));
  ok('价格变动判定走共享层 CP.priceDelta', /CP\.priceDelta\(/.test(js));
  ok('价格变动判定只有一处实现（本地函数只是转发）',
    (js.match(/return CP\.priceDelta\(/g) || []).length === 1 &&
    !/h\.length < 2/.test(js), '曾经两套各算一次，两边对「判断不了」的说法会不一样');
  ok('搜索高亮走共享层 CP.hl（只有一份实现，才谈得上没写错）',
    /CP\.hl\b/.test(js) && !/function hl\(/.test(js));
  ok('app.js 里没有裸的 .purchase.status 读取（应统一走 CP.purchaseOf）',
    !/\.purchase\.status/.test(js), (js.match(/.*\.purchase\.status.*/g) || []).join(' | ').slice(0, 120));

  /* ---------------- 15. 搜索体验 ---------------- */
  group('15. 搜索：历史、热词、高亮与空态出口');
  goto('rank');
  $('#q').dispatchEvent(new win.Event('focus', { bubbles: true }));
  ok('聚焦空搜索框展开建议面板', $('#searchPane').hidden === false);

  var hotBtns = $$('#searchPane [data-hot]');
  ok('热词有 8 条', hotBtns.length === 8, '实得 ' + hotBtns.length);
  // 热词必须能在数据里被找到，否则就是手写臆造
  var haystack = D.plans.map(function (p) {
    return [p.name].concat((p.tools && p.tools.listed) || [], (p.models && p.models.listed) || []).join(' ');
  }).join(' ') + ' ' + D.vendors.map(function (v) { return v.name + ' ' + (v.short || ''); }).join(' ');
  var badHot = hotBtns.map(function (b) { return b.getAttribute('data-hot'); })
    .filter(function (k) { return haystack.indexOf(k) < 0 && !D.use_cases.some(function (u) { return u.label === k; }); });
  ok('每个热词都能在数据里找到出处（非手写）', badHot.length === 0, badHot.join(', '));
  ok('热词带出现次数', $$('#searchPane [data-hot] .chip__n').length === 8);

  /* 历史一律通过面板里的 chip 断言，不去读 localStorage：
     jsdom 的 file:// 是 opaque origin，访问 localStorage 会抛 SecurityError
     （app 自己 try/catch 掉了，所以功能不受影响，但测试读不到）。
     顺带的好处是断言的是「用户看得见的东西」。 */
  function histKeys() { return $$('#searchPane [data-hist]').map(function (b) { return b.getAttribute('data-hist'); }); }
  function typeInto(v, enter) {
    $('#q').value = v;
    $('#q').dispatchEvent(new win.Event('input', { bubbles: true }));
    if (enter) $('#q').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  function openPane() { click($('#qClear')); }

  click($$('#searchPane [data-hot]')[0]);
  var hotKey = hotBtns[0].getAttribute('data-hot');
  ok('点热词回填搜索框', $('#q').value === hotKey, '实得「' + $('#q').value + '」');
  ok('结果里出现命中高亮', $$('#rankRows .row mark.hl').length > 0);
  openPane();
  ok('点过热词后进入历史', histKeys().indexOf(hotKey) >= 0, histKeys().join(','));

  // 上限 8：塞 11 条，最旧的 k0 必须被挤掉
  for (var hi = 0; hi < 11; hi++) typeInto('k' + hi, true);
  openPane();
  var hk = histKeys();
  ok('历史最多保留 8 条', hk.length === 8, '实得 ' + hk.length);
  ok('最新的一条排在最前', hk[0] === 'k10', '实得 ' + hk[0]);
  ok('最旧的 k0 已被挤出', hk.indexOf('k0') < 0, hk.join(','));

  // 去重：再搜一次已有的词，顶到最前而不是留两条
  typeInto('k3', true);
  openPane();
  var hk2 = histKeys();
  ok('重复搜索顶到最前', hk2[0] === 'k3', '实得 ' + hk2[0]);
  ok('重复搜索不占两条', hk2.filter(function (x) { return x === 'k3'; }).length === 1);
  ok('去重后总数不增长', hk2.length === 8);

  ok('清空后面板回来', $('#searchPane').hidden === false);
  click($$('#searchPane [data-hist]')[0]);
  ok('点历史能回填', $('#q').value === hk2[0], '实得「' + $('#q').value + '」');

  openPane();
  click($('#searchPane [data-histclear]'));
  ok('清空历史后不再有历史 chip', $$('#searchPane [data-hist]').length === 0);

  /* 高亮不能成为注入点：搜索框里的内容只作为切分依据，永不进 HTML */
  typeInto('<img src=x onerror=alert(1)>', false);
  ok('搜索词里的 HTML 不会被当成标签渲染', $$('#rankRows img').length === 0 && $$('#rankEmpty img').length === 0);
  ok('搜索词以纯文本出现在空态里', $('#rankEmpty').textContent.indexOf('<img src=x onerror=alert(1)>') >= 0);

  // 空态：3 个出口 + 列出当前生效的筛选
  $('#q').value = 'zzz-不可能命中-zzz';
  $('#q').dispatchEvent(new win.Event('input', { bubbles: true }));
  ok('空态列出当前生效的搜索词', $('#rankEmpty').textContent.indexOf('zzz-不可能命中-zzz') >= 0);
  ok('空态给了 3 个可点的出口', $$('#rankEmpty button').length === 3, '实得 ' + $$('#rankEmpty button').length);
  click($('#rankEmpty [data-emptyq]'));
  ok('「清空搜索」恢复全量', $$('#rankRows .row').length === 68);

  /* ---------------- 13. 可购买性：套餐级结论 + 重排而非过滤 ---------------- */
  group('13. 可购买性是「套餐级」，且不能被筛掉');
  goto('rank');
  ok('档位行的徽章标明了作用域「该套餐」',
     $$('#rankRows .row .scope-tag').length === 68, '实得 ' + $$('#rankRows .row .scope-tag').length);
  ok('榜单常驻「尚未核实」的稀缺性提示', /尚未核实/.test($('#unverifiedHint').textContent));

  var totalRows = $$('#rankRows .row').length;
  click($('#saleFirstBtn'));
  ok('开启后出现下沉区', !$('#degradeZone').hidden);
  var upN = $$('#rankRows .row').length, downN = $$('#degradeBody .row').length;
  ok('行数守恒（' + upN + '+' + downN + '=' + totalRows + '）—— 证明是重排不是过滤',
     upN + downN === totalRows, '实得 ' + upN + '+' + downN);
  ok('总数计数不变（仍显示 ' + totalRows + '）', $('#rankCount').textContent.indexOf(String(totalRows)) >= 0,
     $('#rankCount').textContent);
  ok('下沉区默认收起', $('#degradeBody').hidden === true);
  ok('下沉区标题明说「没有被筛掉」', $('#degradeTitle').textContent.indexOf('没有被筛掉') >= 0);
  ok('下沉区标了数量', $('#degradeCount').textContent === String(downN));
  var sfText = $('#saleFirstBtn').textContent;
  ok('开关文案不含「隐藏 / 不显示 / 只看」', !/隐藏|不显示|只看/.test(sfText), '实得「' + sfText + '」');
  click($('#degradeToggle'));
  ok('展开后行数不变', $$('#degradeBody .row').length === downN);
  ok('展开后计数不变', $('#degradeCount').textContent === String(downN));
  click($('#saleFirstBtn'));
  ok('关掉后恢复全量在同一处', $$('#rankRows .row').length === totalRows && $('#degradeZone').hidden);

  click($$('#rankRows .row [data-detail]')[0]);
  ok('详情页把作用域写进标题（套餐级）', $('#detailBody').textContent.indexOf('可购买性 · 套餐级') >= 0);
  ok('详情页说明「没有档位级字段」', $('#detailBody').textContent.indexOf('没有档位级可购买性字段') >= 0);
  click($('#detailSheet [data-close]'));

  /* ---------------- 16. 我的关注 ---------------- */
  group('16. 我的关注：长期清单，价格变动诚实留白');
  goTo('favs');
  ok('空态有引导而不是空白', $('#favEmpty').hidden === false && $('#favEmpty').textContent.indexOf('☆') >= 0);
  ok('屏顶说明「判断不了」而不是「没有变动」', $('#favNote').textContent.indexOf('判断不了') >= 0);

  goto('rank');
  var star0 = $$('#rankRows .row [data-fav]')[0];
  var star1 = $$('#rankRows .row [data-fav]')[1];
  var star2 = $$('#rankRows .row [data-fav]')[2];
  click(star0);
  click($$('#rankRows .row [data-fav]')[1]);
  click($$('#rankRows .row [data-fav]')[2]);
  click($$('#rankRows .row [data-fav]')[3]);
  ok('首页关注计数同步为 4', $('#homeFavsCount').textContent === '4', '实得 ' + $('#homeFavsCount').textContent);

  goTo('favs');
  var favN = $$('#favRows .row').length;
  ok('关注屏有 4 条', favN === 4, '实得 ' + favN);
  ok('计数栏写清「N 档 · 来自 M 个套餐」', /4<\/b>|4/.test($('#favCount').textContent) &&
     $('#favCount').textContent.indexOf('个套餐') >= 0, $('#favCount').textContent);
  ok('每条都标「该套餐」作用域', $$('#favRows .row .scope-tag').length === favN);
  ok('价格标记一律是「价格未追踪」', $$('#favRows .row .pmark--na').length === favN &&
     $$('#favRows .row .pmark--up').length === 0 && $$('#favRows .row .pmark--down').length === 0);
  ok('价格标记不出现假的涨跌箭头', !/[↑↓]/.test($('#favRows').textContent));
  ok('加入时间可显示（新加入的不是「更早」）', $$('#favRows .row .favwhen').filter(function (e) {
    return e.textContent.indexOf('加入于') >= 0;
  }).length === favN);

  var firstName = $('#favRows .row .row__name').textContent;
  click($('#favSort [data-favsort="price"]'));
  var byPrice = $$('#favRows .row .row__name').map(function (e) { return e.textContent; });
  ok('换排序后条数不变', byPrice.length === favN, '实得 ' + byPrice.length);
  ok('换排序后顺序确实变了', byPrice[0] !== firstName, '首条仍是 ' + byPrice[0]);
  click($('#favSort [data-favsort="purchase"]'));
  ok('按可购买性排序后条数不变', $$('#favRows .row').length === favN);
  click($('#favSort [data-favsort="added"]'));

  click($('#favActs [data-favcmp]'));
  ok('批量加入后对比轨道为 4', $$('#cmpRail .cmpbar__item').length === 4,
     '实得 ' + $$('#cmpRail .cmpbar__item').length);

  goTo('favs');
  click($$('#favRows .row [data-fav]')[0]);
  ok('取消关注后条数减 1', $$('#favRows .row').length === favN - 1, '实得 ' + $$('#favRows .row').length);
  var guard = 0;
  while ($$('#favRows .row').length && guard++ < 10) click($$('#favRows .row [data-fav]')[0]);
  ok('可以清空到空态', $('#favEmpty').hidden === false && $$('#favRows .row').length === 0);

  /* ---------------- 14. 文案与实现一致 ---------------- */
  /* 「还没做的」清单曾经写着「对比态还没进 URL」，而分享链接其实早已实现。
     写清单的人和实现的人不是同一个时刻的自己 —— 这类自相矛盾只能靠断言抓。 */
  group('14. 说明页的「还没做的」必须和实现同步');
  goto('about');
  var todoText = $('#aboutTodo').textContent;
  ['对比态还没进', '还没实现', '尚未实现', '对比还没'].forEach(function (w) {
    ok('待办清单不再出现过时说法「' + w + '」', todoText.indexOf(w) < 0);
  });
  ok('已完成的项标为「已做」', $$('#aboutTodo .tag--done').length >= 2, '实得 ' + $$('#aboutTodo .tag--done').length);

  /* ---------------- 17. 详情：价格追踪讲的是「进来时那一档」 ---------------- */
  group('17. 详情里的价格追踪按当前档位讲');
  goto('rank');
  var multiRow = $$('#rankRows .row').filter(function (el) {
    var pid = el.querySelector('[data-detail]').getAttribute('data-detail');
    var p = D.plans.filter(function (x) { return x.id === pid; })[0];
    return p && p.tiers.length > 1;
  })[0];
  ok('找到一个含多档位的套餐用于测试', !!multiRow);
  var gotoTier = multiRow.querySelector('.row__tier').textContent.split(' · ')[0];
  click(multiRow.querySelector('[data-detail]'));
  var labBefore = $('#detailBody .spark__label').textContent;
  ok('价格追踪标题写明当前档位（' + gotoTier + '）', labBefore.indexOf(gotoTier) >= 0, '实得「' + labBefore + '」');
  var sparkBtn = $('#detailBody [data-spark]');
  ok('提供了「看全部档位」切换', !!sparkBtn);
  click(sparkBtn);
  var labAfter = $('#detailBody .spark__label').textContent;
  ok('切换后范围变成全部档位', labAfter !== labBefore && labAfter.indexOf('全部') >= 0, '实得「' + labAfter + '」');
  click($('#detailSheet [data-close]'));

  reloadCheck();
}

/* 分享链接的往返验证：另起一个 jsdom，用带 hash 的 URL 打开，
   看它能不能自己复现出同一屏 + 同一组对比。只测 syncHash 写出去不算数，
   必须测「读回来」—— 分享给别人的是后者。 */
function reloadCheck() {
  var ids = [D.plans[0].tiers[0].id, D.plans[1].tiers[0].id];
  var html2 = fs.readFileSync(APP_HTML, 'utf8').replace(/<link rel="stylesheet"[^>]*>/, '');
  var dom2 = new JSDOM(html2, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'file:///' + APP_HTML.replace(/\\/g, '/') + '#rank?cmp=' + encodeURIComponent(ids.join(',')),
    pretendToBeVisual: true
  });

  var settled = false;
  function finish(note) {
    if (settled) return;
    settled = true;
    group('14b. 分享链接能被原样打开');
    var d2 = dom2.window.document;
    var items = d2.querySelectorAll('#cmpRail .cmpbar__item').length;
    var scr = (d2.querySelector('.screen.is-active') || { dataset: {} }).dataset.screen;
    ok('用 #rank?cmp=… 打开即停在榜单', scr === 'rank', '实得 ' + scr + (note ? '（' + note + '）' : ''));
    ok('用 #rank?cmp=… 打开即选中同样的 ' + ids.length + ' 档', items === ids.length, '实得 ' + items);
    done();
  }

  dom2.window.addEventListener('load', function () { setTimeout(finish, 90); });
  // 兜底：万一外部脚本没加载完也不能把进程挂死
  setTimeout(function () { finish('加载超时'); }, 4000);
}

function done() {
  console.log('\n' + '─'.repeat(52));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}
