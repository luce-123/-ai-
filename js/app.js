/* ==========================================================================
   CodePlan 比价 —— 前端逻辑
   数据来源：data/plans.js（由 data/plans.json 生成）
   无构建、无依赖，直接操作 DOM
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------- 数据加载 ---------------------------- */

  var DATA = window.__PLANS__ || null;
  if (!DATA) {
    document.body.innerHTML =
      '<div style="padding:60px;font:15px/1.8 system-ui;color:#333">' +
      '数据未加载。请先执行 <code>node codingplan/scripts/build-data-module.js</code> 生成 data/plans.js，' +
      '或在 codingplan 目录下起一个本地服务器（<code>python -m http.server</code>）后访问。</div>';
    return;
  }

  /* 共享层（可购买性判定 / 单位成本口径 / 字符串工具）由 js/shared.js 提供，
     移动版 app/app.js 用的是同一份。缺了它下面的每一行都会以 TypeError 的形式炸在
     很远的地方，所以在这里就停下并说清原因。 */
  var CP = window.__CP__ || null;
  if (!CP) {
    document.body.innerHTML =
      '<div style="padding:60px;font:15px/1.8 system-ui;color:#333">' +
      '共享层未加载：<code>js/shared.js</code> 必须在 <code>js/app.js</code> 之前引入。</div>';
    return;
  }

  var META = DATA.meta;
  var VENDORS = DATA.vendors;
  var PLANS = DATA.plans;
  var BILLINGS = DATA.billing_types;
  var USECASES = DATA.use_cases;

  var vMap = {}, bMap = {}, ucMap = {};
  VENDORS.forEach(function (v) { vMap[v.id] = v; });
  BILLINGS.forEach(function (b) { bMap[b.key] = b; });
  USECASES.forEach(function (u) { ucMap[u.label] = u; });

  /* ---------------------------- 工具函数 ---------------------------- */

  // 转义与量级缩放来自共享层，两套界面共用同一份实现
  var esc = CP.esc;
  var scaleFor = CP.scaleFor;

  function money(n) {
    if (n === 0) return '免费';
    return '¥' + (n % 1 === 0 ? n.toLocaleString('zh-CN') : n.toFixed(2));
  }

  /* 价格口径（schema 1.1.0）
   * 官网标价与优惠价不一定相同，外币定价的 ¥ 值还只是汇率估算。
   * 这里统一处理，避免各处自己拼字符串拼出"看起来像官网数字"的东西。 */
  function isForeign(t) {
    return !!t.price_currency && t.price_currency !== 'CNY' && t.price_foreign != null;
  }
  // 主价格：外币显示原币（那才是官网数字），人民币只在附注里以「≈」出现
  function priceMain(t) {
    if (isForeign(t)) {
      var v = t.price_foreign;
      return '$' + (v % 1 === 0 ? v : v.toFixed(2));
    }
    return money(t.price_cny);
  }
  // 官网原价（划线）。只在原价与实付价确实不同时出现，避免"划了个一样的价"
  function listPriceTag(t) {
    if (!t.price_list_cny || t.price_list_cny === t.price_cny) return '';
    return '<s class="pricelist" title="官网标价">' + esc(money(t.price_list_cny)) + '</s>';
  }
  // 矩阵/详情里的一格价格：主价 + 划线原价 + /月 + 外币换算说明
  function priceCellHtml(t) {
    if (t.price_cny === 0 && !isForeign(t)) return '<span class="price price--free">免费</span>';
    var extra = isForeign(t) ? '<span class="pricenote">≈' + esc(money(t.price_cny)) + '</span>' : '';
    return '<span class="price">' + esc(priceMain(t)) + listPriceTag(t) +
      '<span class="pricenote">/月</span>' + extra + '</span>';
  }

  // 把大数字写成中文万/亿
  function human(n) {
    if (n == null) return '—';
    if (n >= 1e8) return trim(n / 1e8) + ' 亿';
    if (n >= 1e4) return trim(n / 1e4) + ' 万';
    return n.toLocaleString('zh-CN');
  }
  function trim(n) {
    var s = n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    return Number(s).toLocaleString('zh-CN');
  }

  /**
   * 归一化单位成本。判定逻辑在共享层（__CP__.unitCost），两套界面共用；
   * 这里只做两件属于桌面版自己的事：
   *   1. 从 billing_types 取该口径的 unit_label 传进去（共享层不认识具体口径）
   *   2. 把估算值标进文案 —— 桌面版没有移动端那种「低置信」文字徽章，
   *      不在文字里写「（估）」的话，估算值会和实测值长得一模一样。
   */
  function unitCost(tier, plan) {
    var u = CP.unitCost(tier, plan, (bMap[plan.billing_type] || {}).unit_label);
    if (u && u.est) u.sub += '（估）';
    return u;
  }

  function confDot(c) {
    if (!c) return '';
    return '<i class="conf" data-c="' + c + '" title="' + esc(CP.confTitle(c)) + '"></i>';
  }

  function logoHtml(vendor, size) {
    var cls = size === 'big' ? 'card__logo' : (size === 'mini' ? 'logo' : 'logo');
    return '<span class="' + cls + '" style="background:' + vendor.color + '">' + esc(vendor.logo_text) + '</span>';
  }

  /* 生态数量（模型数 / 工具数）可能缺失 —— 官网也许没公布总数。
     按本库规矩「官网没公开的就留空，不推算填充」，所以这里必须容忍 undefined：
       取值 -> 数字或 null（null 表示"官网未公布"，不是 0）
       排序 -> null 一律排在最后（不能当成 0，那会让它显得"生态最差"） */
  function ecoCount(plan, kind) {
    var v = plan && plan[kind] && plan[kind].count;
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  function ecoRank(a, b) {          // 升序比较器：有数字的在前，null 垫底
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return b - a;
  }
  /** 详情页的「可调用模型 / 兼容工具」区块。官网未公布时给出明确说明，不画空区块、更不留 0。 */
  function ecoSection(plan, kind, title, unit) {
    var item = plan[kind];
    var n = ecoCount(plan, kind);
    var listed = (item && item.listed) ? item.listed : [];
    if (n == null && listed.length === 0) {
      return '<div class="dt__sec"><h3>' + esc(title) + ' · 官网未公布</h3>' +
        '<p class="dt__hint">该套餐官网没有公布' + esc(title) + '的清单与数量，本库不推算填充。</p></div>';
    }
    var head = (n == null ? esc(title) + ' · 官网未公布'
      : esc(title) + ' · ' + n + ' ' + esc(unit) + (item && item.partial ? '（官网仅展示部分）' : ''));
    var tail = listed.map(function (m) { return '<span class="tag">' + esc(m) + '</span>'; }).join('');
    if (n != null && n > listed.length) {
      tail += '<span class="tag" style="color:var(--text-3)">+' + (n - listed.length) +
        ' ' + esc(unit) + '未列出</span>';
    }
    return '<div class="dt__sec"><h3>' + head + '</h3><div class="dt__tags">' + tail + '</div></div>';
  }

  /* ---------------------------- 扁平化行数据 ---------------------------- */

  var ROWS = [];
  PLANS.forEach(function (plan) {
    var vendor = vMap[plan.vendor_id];
    plan.tiers.forEach(function (tier, i) {
      ROWS.push({
        plan: plan, tier: tier, vendor: vendor,
        tierIdx: i,
        uc: unitCost(tier, plan),
        search: [
          vendor.name, vendor.short, plan.name, tier.name,
          (plan.models && plan.models.listed ? plan.models.listed : []).join(' '),
          (plan.tools && plan.tools.listed ? plan.tools.listed : []).join(' '),
          plan.billing_type, tier.use_case || ''
        ].join(' ').toLowerCase()
      });
    });
  });

  var MAX_PRICE = Math.max.apply(null, ROWS.map(function (r) { return r.tier.price_cny; }));

  /* ---------------------------- 状态 ---------------------------- */

  var state = {
    q: '',
    billings: {},      // key -> true
    useCases: {},      // label -> true
    maxPrice: MAX_PRICE,
    freeOnly: false,
    sort: 'price-asc',
    view: 'table',
    tierIdx: {},       // planId -> 选中的档位下标
    compare: []        // [{planId, tierId}]
  };

  try {
    var savedCmp = JSON.parse(localStorage.getItem('codeplan-compare') || '[]');
    if (Array.isArray(savedCmp)) state.compare = savedCmp.slice(0, 4);
    var savedView = localStorage.getItem('codeplan-view');
    if (savedView === 'card' || savedView === 'table') state.view = savedView;
  } catch (e) { /* 隐私模式忽略 */ }

  PLANS.forEach(function (p) { state.tierIdx[p.id] = 0; });

  function persist() {
    try {
      localStorage.setItem('codeplan-compare', JSON.stringify(state.compare));
      localStorage.setItem('codeplan-view', state.view);
    } catch (e) { /* ignore */ }
  }

  /* ---------------------------- 筛选与排序 ---------------------------- */

  function activeBillings() { return Object.keys(state.billings).filter(function (k) { return state.billings[k]; }); }
  function activeUseCases() { return Object.keys(state.useCases).filter(function (k) { return state.useCases[k]; }); }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var bs = activeBillings();
    var us = activeUseCases();

    return ROWS.filter(function (r) {
      if (bs.length && bs.indexOf(r.plan.billing_type) === -1) return false;
      if (us.length && us.indexOf(r.tier.use_case || '') === -1) return false;
      if (state.freeOnly && !r.plan.has_free_tier) return false;
      if (r.tier.price_cny > state.maxPrice) return false;
      if (q && r.search.indexOf(q) === -1) return false;
      return true;
    });
  }

  function sorted(rows) {
    var s = state.sort;
    var out = rows.slice();
    if (s === 'price-asc') {
      out.sort(function (a, b) { return a.tier.price_cny - b.tier.price_cny; });
    } else if (s === 'cost-asc') {
      // 可跨口径比较的排前面，按单位成本升序；其余按价格升序垫底
      out.sort(function (a, b) {
        var av = a.uc && a.uc.cross ? a.uc.value : null;
        var bv = b.uc && b.uc.cross ? b.uc.value : null;
        if (av == null && bv == null) return a.tier.price_cny - b.tier.price_cny;
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
    } else if (s === 'tokens-desc') {
      out.sort(function (a, b) {
        var av = (a.tier.derived && a.tier.derived.est_tokens_month) || -1;
        var bv = (b.tier.derived && b.tier.derived.est_tokens_month) || -1;
        return bv - av;
      });
    } else if (s === 'models-desc') {
      out.sort(function (a, b) {
        return ecoRank(ecoCount(a.plan, 'models'), ecoCount(b.plan, 'models')) || a.tier.price_cny - b.tier.price_cny;
      });
    } else if (s === 'tools-desc') {
      out.sort(function (a, b) {
        return ecoRank(ecoCount(a.plan, 'tools'), ecoCount(b.plan, 'tools')) || a.tier.price_cny - b.tier.price_cny;
      });
    } else if (s === 'vendor') {
      out.sort(function (a, b) {
        return a.vendor.name.localeCompare(b.vendor.name, 'zh-Hans-CN') ||
               a.plan.name.localeCompare(b.plan.name, 'zh-Hans-CN') ||
               a.tier.price_cny - b.tier.price_cny;
      });
    }
    return out;
  }

  /* ---------------------------- 渲染：概览与筛选器 ---------------------------- */

  function renderStats() {
    var tierCount = ROWS.length;
    var freeCount = PLANS.filter(function (p) { return p.has_free_tier; }).length;
    var minPrice = Math.min.apply(null, ROWS.map(function (r) { return r.tier.price_cny; }));
    var maxModels = Math.max.apply(null, PLANS.map(function (p) { return ecoCount(p, 'models'); })
      .filter(function (n) { return n != null; }).concat([0]));

    var items = [
      { n: VENDORS.length, l: '家厂商覆盖' },
      { n: PLANS.length, l: '个编程套餐' },
      { n: tierCount, l: '个定价档位' },
      { n: money(minPrice), l: '最低起售价', raw: true },
      { n: maxModels, l: '最多模型数 / 单套餐' }
    ];
    document.getElementById('stats').innerHTML = items.map(function (it) {
      return '<li><b>' + esc(it.n) + '</b><span>' + esc(it.l) + '</span></li>';
    }).join('');

    document.getElementById('snapLabel').textContent = '快照 ' + META.snapshot_date;
    document.getElementById('footNote').innerHTML =
      '数据集 v' + esc(META.schema_version) + ' · 快照日期 ' + esc(META.snapshot_date) +
      ' · 共 ' + VENDORS.length + ' 家厂商 / ' + PLANS.length + ' 个套餐 / ' + tierCount + ' 个档位' +
      '（含免费档 ' + freeCount + ' 个）· 可归一化 ' +
      ROWS.filter(function (r) { return r.uc; }).length + ' / ' + tierCount + ' 档';
  }

  function renderChips() {
    var bCount = {};
    var uCount = {};
    ROWS.forEach(function (r) {
      bCount[r.plan.billing_type] = (bCount[r.plan.billing_type] || 0) + 1;
      var u = r.tier.use_case;
      if (u) uCount[u] = (uCount[u] || 0) + 1;
    });

    document.getElementById('billingChips').innerHTML = BILLINGS.map(function (b) {
      return '<button type="button" class="chip" data-b="' + esc(b.key) + '">' +
        esc(b.label) + '<small>' + (bCount[b.key] || 0) + '</small></button>';
    }).join('');

    document.getElementById('useCaseChips').innerHTML = USECASES.map(function (u) {
      return '<button type="button" class="chip" data-u="' + esc(u.label) + '">' +
        esc(u.label) + '<small>' + (uCount[u.label] || 0) + '</small></button>';
    }).join('');

    var pr = document.getElementById('priceRange');
    pr.max = MAX_PRICE;
    pr.value = MAX_PRICE;
    document.getElementById('priceVal').textContent = '不限';
  }

  function renderExplain() {
    var bCount = {};
    ROWS.forEach(function (r) { bCount[r.plan.billing_type] = (bCount[r.plan.billing_type] || 0) + 1; });
    document.getElementById('billingExplain').innerHTML = BILLINGS.map(function (b) {
      return '<div class="excard"><h4>' + esc(b.label) + '</h4><p>' + esc(b.note) + '</p>' +
        '<p class="excard__stat">' + (bCount[b.key] || 0) + ' 个档位 · ' +
        (b.comparable ? '可跨厂商比较' : '不可跨厂商比较') + '</p></div>';
    }).join('');

    var e = META.estimation_rules;
    document.getElementById('estNote').innerHTML =
      '<strong>折算假设</strong>（写在数据集 meta.estimation_rules 里，可调整）：每次请求约 ' +
      e.tokens_per_request.toLocaleString('zh-CN') + ' tokens、每日 ' + e.request_windows_per_day +
      ' 个限流窗口、每月 ' + e.days_per_month + ' 天。' + esc(e.note) +
      ' 圆点颜色表示置信度：<span class="conf" data-c="high"></span>厂商直接公开 ·' +
      '<span class="conf" data-c="medium"></span>按倍率折算 ·' +
      '<span class="conf" data-c="low"></span>依赖假设。';
  }

  /* ---------------------------- 渲染：矩阵视图 ---------------------------- */

  function isPicked(tierId) {
    return state.compare.some(function (c) { return c.tierId === tierId; });
  }

  function ecoCell(plan) {
    var m = ecoCount(plan, 'models'), t = ecoCount(plan, 'tools');
    if (m == null || t == null) {
      return '<span class="eco eco--unknown" title="官网未公布模型/工具总数，本库不推算填充">生态数官网未公布</span>';
    }
    return '<span class="eco"><span>' + m + '</span> 模型' +
      '<i>·</i><span>' + t + '</span> 工具</span>';
  }

  /* 可购买性：官网能不能买到。与价格无关，但缺了它，「¥29/月」可能出现在一个买不到的套餐旁边。
     三条规矩与 ecoCount 一致：
       缺失 -> 显示「未核实」，绝不默认按在售处理（未核实 ≠ 在售）
       非在售 -> **必须带日期**（as_of），否则会把「2026-07 停售」当成「今天停售」
       二手依据 -> 详情页标注「媒体转引」，不冒充实测 */
  // 五态标签与判定都在共享层：桌面与移动必须说同一句话，
  // 曾经两套各自写（「需登录购买」/「需登录」），同一个状态两种说法。
  var PURCHASE_LABEL = CP.PURCHASE_LABEL;

  function purchaseCell(plan) {
    var pu = CP.purchaseOf(plan);
    if (!pu) {
      return '<span class="eco eco--unknown" title="本库尚未核实该套餐当前能否购买；未核实不等于在售">未核实</span>';
    }
    var date = pu.status === 'on_sale' ? '' : '<i>（截至 ' + esc(pu.as_of) + '）</i>';
    return '<span class="pstate pstate--' + esc(pu.status) + '">' + esc(PURCHASE_LABEL[pu.status]) + date + '</span>';
  }
  /** 详情页的「可购买性」区块。缺失时明确写「未核实」，不画空区块、更不留白让人误以为可买。 */
  function purchaseSection(plan) {
    var pu = CP.purchaseOf(plan);
    if (!pu) {
      return '<div class="dt__sec"><h3>可购买性 · 未核实</h3>' +
        '<p class="dt__hint">本库尚未核实该套餐当前能否购买。<b>未核实不等于在售</b> —— 下单前请以官网为准。</p></div>';
    }
    var ev = pu.evidence === 'secondary'
      ? '<span class="tag tag--warn">依据：媒体转引官方原文</span>'
      : '<span class="tag">依据：厂商官网</span>';
    return '<div class="dt__sec"><h3>可购买性 · ' + esc(PURCHASE_LABEL[pu.status]) + '</h3>' +
      '<p class="dt__hint">' + esc(pu.note) + '</p>' +
      '<div class="dt__tags">' + ev + '<span class="tag">截至 ' + esc(pu.as_of) + '</span>' +
      '<a class="tag tag--link" href="' + esc(pu.source) + '" target="_blank" rel="noopener nofollow">查看出处</a>' +
      '</div></div>';
  }

  function unitCell(r) {
    if (!r.uc) return '<span class="unit unit--none">未公开额度</span>';
    return '<span class="unit">' + confDot(r.uc.conf) + '<b>' + esc(r.uc.main) + '</b>' +
      '<span>' + esc(r.uc.sub) + '</span></span>';
  }

  function quotaCell(r) {
    var q = r.tier.quota;
    var est = '';
    if (r.tier.derived && r.tier.derived.est_tokens_month != null && !r.uc) {
      est = '<span class="quota__est">≈ ' + human(r.tier.derived.est_tokens_month) + ' Token/月</span>';
    } else if (r.tier.derived && r.tier.derived.quota_month != null && r.plan.billing_type === 'credits') {
      var s = scaleFor(r.tier.derived.quota_month);
      est = '<span class="quota__est">折合 ' + human(r.tier.derived.quota_month) + ' ' + esc(bMap.credits.unit_label) + '/月</span>';
    } else if (q.value != null && q.multiplier && q.derived) {
      est = '<span class="quota__est">= ' + human(q.value) + ' ' + esc(q.unit_key === 'fuel' ? '燃料值' : bMap[r.plan.billing_type].unit_label) + '（按倍率折算）</span>';
    }
    return '<span class="quota"><span class="quota__raw">' + esc(q.raw) + '</span>' + est + '</span>';
  }

  function renderTable(rows) {
    var body = document.getElementById('matrixBody');
    document.getElementById('tableEmpty').hidden = rows.length > 0;

    body.innerHTML = rows.map(function (r) {
      var t = r.tier, p = r.plan, v = r.vendor;
      var picked = isPicked(t.id);
      return '<tr' + (picked ? ' class="is-picked"' : '') + '>' +
        '<td class="col-cmp"><input class="cmpbox" type="checkbox" data-tier="' + esc(t.id) + '"' +
          (picked ? ' checked' : '') + ' aria-label="加入对比"></td>' +
        '<td><div class="vendor">' + logoHtml(v) + '<span class="vendor__name">' + esc(v.short) + '</span></div></td>' +
        '<td><span class="planname">' + esc(p.name) + '</span><span class="tiername">' + esc(t.name) + '</span>' +
          (t.price_note ? '<span class="pricenote">' + esc(t.price_note) + '</span>' : '') + '</td>' +
        '<td>' + priceCellHtml(t) + '</td>' +
        '<td><span class="btype" data-k="' + esc(p.billing_type) + '">' + esc(bMap[p.billing_type].label) + '</span></td>' +
        '<td>' + quotaCell(r) + '</td>' +
        '<td>' + unitCell(r) + '</td>' +
        '<td>' + ecoCell(p) + '</td>' +
        '<td>' + (t.use_case ? '<span class="usecase" data-lv="' + ((ucMap[t.use_case] || {}).level || '') + '">' + esc(t.use_case) + '</span>' : '—') + '</td>' +
        '<td><div class="rowacts">' +
          '<button class="detailbtn" type="button" data-detail="' + esc(p.id) + '">详情</button>' +
          '<a class="gobtn" href="' + esc(p.buy_url) + '" target="_blank" rel="noopener nofollow">购买</a>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  /* ---------------------------- 渲染：卡片视图 ---------------------------- */

  function renderCards(rows) {
    var grid = document.getElementById('cardGrid');
    document.getElementById('cardEmpty').hidden = rows.length > 0;

    // 卡片以「套餐」为单位聚合
    var seen = {};
    var plans = [];
    rows.forEach(function (r) {
      if (seen[r.plan.id]) return;
      seen[r.plan.id] = true;
      plans.push(r.plan);
    });

    grid.innerHTML = plans.map(function (p) {
      var v = vMap[p.vendor_id];
      var idx = Math.min(state.tierIdx[p.id] || 0, p.tiers.length - 1);
      var t = p.tiers[idx];
      var uc = unitCost(t, p);
      var row = { plan: p, tier: t, uc: uc, vendor: v };

      var badges = (p.badges || []).map(function (b) {
        return '<span class="badge' + (b === '热门' ? ' badge--hot' : (b === '有免费版' ? ' badge--free' : '')) + '">' + esc(b) + '</span>';
      }).join('');

      var tabs = p.tiers.map(function (tt, i) {
        return '<button type="button" class="tiertab' + (i === idx ? ' is-on' : '') + '" data-plan="' + esc(p.id) + '" data-i="' + i + '">' +
          esc(tt.name) + '<b>' + esc(priceMain(tt)) + listPriceTag(tt) + '</b></button>';
      }).join('');

      var picked = isPicked(t.id);

      return '<article class="card" style="--vc:' + esc(v.color) + '">' +
        '<div class="card__head">' + logoHtml(v, 'big') +
          '<div class="card__title"><h3>' + esc(p.name) + '</h3><p>' + esc(v.name) + ' · ' + esc(bMap[p.billing_type].label) + '</p></div>' +
          '<div class="badges">' + badges + '</div>' +
        '</div>' +
        '<div class="tiertabs">' + tabs + '</div>' +
        '<div class="card__price"><b>' + esc(priceMain(t)) + '</b>' + listPriceTag(t) +
          '<small>' + (t.price_cny
            ? '/月' + (isForeign(t) ? ' · 约 ' + esc(money(t.price_cny)) : '') + (t.price_note ? ' · ' + esc(t.price_note) : '')
            : '零成本体验') + '</small></div>' +
        '<div class="card__rows">' +
          '<div class="crow"><span>额度</span><span>' + esc(t.quota.raw) + '</span></div>' +
          '<div class="crow"><span>单位成本</span><span>' +
            (uc ? confDot(uc.conf) + '<b>' + esc(uc.main) + '</b> ' + esc(uc.sub) : '<span style="color:var(--text-3)">未公开额度，无法折算</span>') +
          '</span></div>' +
          '<div class="crow"><span>生态</span><span>' + ecoCell(p) + '</span></div>' +
          '<div class="crow"><span>可购买性</span><span>' + purchaseCell(p) + '</span></div>' +
          (t.use_case ? '<div class="crow"><span>场景</span><span>' + esc(t.use_case) + '</span></div>' : '') +
        '</div>' +
        '<ul class="hl">' + (t.highlights || []).map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' +
        '<div class="card__foot">' +
          '<button class="btn btn--ghost btn--wide' + (picked ? ' is-on' : '') + '" type="button" data-tier="' + esc(t.id) + '">' +
            (picked ? '已加入对比' : '加入对比') + '</button>' +
          '<button class="btn btn--ghost" type="button" data-detail="' + esc(p.id) + '">详情</button>' +
          '<a class="btn btn--primary" href="' + esc(p.buy_url) + '" target="_blank" rel="noopener nofollow">购买</a>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  /* ---------------------------- 渲染：对比栏 ---------------------------- */

  function compareItems() {
    return state.compare.map(function (c) {
      var plan = PLANS.filter(function (p) { return p.id === c.planId; })[0];
      if (!plan) return null;
      var tier = plan.tiers.filter(function (t) { return t.id === c.tierId; })[0];
      if (!tier) return null;
      return { plan: plan, tier: tier, vendor: vMap[plan.vendor_id] };
    }).filter(Boolean);
  }

  function renderCompareBar() {
    var items = compareItems();
    var bar = document.getElementById('compareBar');
    bar.hidden = items.length === 0;
    document.getElementById('cmpCount').textContent = items.length;
    document.getElementById('cmpGo').disabled = items.length < 2;
    document.getElementById('cmpGo').style.opacity = items.length < 2 ? .5 : 1;

    document.getElementById('cmpList').innerHTML = items.map(function (it) {
      return '<li class="cmptag"><span class="cmptag__dot" style="background:' + esc(it.vendor.color) + '"></span>' +
        '<span class="cmptag__t">' + esc(it.plan.name) + ' ' + esc(it.tier.name) +
        '<em>' + esc(money(it.tier.price_cny)) + '</em>' +
          (isForeign(it.tier) ? '<small class="fxnote">官网 $' + esc(it.tier.price_foreign) + '</small>' : '') +
          listPriceTag(it.tier) + '</span>' +
        '<button class="cmptag__x" type="button" data-rm="' + esc(it.tier.id) + '" aria-label="移除">&times;</button></li>';
    }).join('');
  }

  /* ---------------------------- 渲染：对比面板 ---------------------------- */

  function renderCompare() {
    var items = compareItems();
    if (items.length < 2) return;

    // 找出可跨口径比较的单位成本最小者（仅在有 >=2 个可比项时标注）
    var crossVals = items.map(function (it) { var u = unitCost(it.tier, it.plan); return u && u.cross ? u.value : null; });
    var crossCount = crossVals.filter(function (v) { return v != null; }).length;
    var bestCostIdx = -1;
    if (crossCount >= 2) {
      var min = Infinity;
      crossVals.forEach(function (v, i) { if (v != null && v < min) { min = v; bestCostIdx = i; } });
    }
    var minPrice = Math.min.apply(null, items.map(function (it) { return it.tier.price_cny; }));
    var maxModels = Math.max.apply(null, items.map(function (it) { return ecoCount(it.plan, 'models'); })
      .filter(function (n) { return n != null; }).concat([0]));
    var maxTools = Math.max.apply(null, items.map(function (it) { return ecoCount(it.plan, 'tools'); })
      .filter(function (n) { return n != null; }).concat([0]));

    function row(label, fn) {
      var vals = items.map(fn);
      // 用于判断「各档位是否存在差异」的文本：带 html 的单元格直接比 html，
      // 否则比展示值。注意不能 String(对象)，否则永远相等，差异高亮会失效。
      function displayText(r) {
        if (!r) return '—';
        if (r.html != null) return r.html;
        return r.value == null ? '—' : String(r.value);
      }
      var plain = vals.map(displayText);
      var differ = plain.some(function (v) { return v !== plain[0]; });
      return '<tr>' + '<th>' + esc(label) + '</th>' + items.map(function (it, i) {
        var r = vals[i];
        var cls = 'cmpval' + (r && r.text ? ' cmpval--text' : '') +
          (r && r.best ? ' is-best' : '') + (differ ? ' cmpdiff' : '');
        var html = r ? (r.html || esc(r.value == null ? '—' : r.value)) : '—';
        return '<td class="' + cls + '">' + html + (r && r.best ? '<span class="bestbadge">最优</span>' : '') + '</td>';
      }).join('') + '</tr>';
    }

    var head = '<tr><th></th>' + items.map(function (it, i) {
      return '<td><div class="cmphead">' + logoHtml(it.vendor) + esc(it.vendor.short) + '</div>' +
        '<div class="cmpsub">' + esc(it.plan.name) + '</div>' +
        '<div class="cmpsub" style="color:var(--accent);font-weight:600">' + esc(it.tier.name) + '</div>' +
        (it.tier.price_note ? '<div class="cmpsub">' + esc(it.tier.price_note) + '</div>' : '') + '</td>';
    }).join('') + '</tr>';

    var body =
      row('月费', function (it) {
        return {
          // 对比要横向可比，所以统一用人民币；外币把原币带在括号里，避免被当成官网标价
          value: money(it.tier.price_cny) + (isForeign(it.tier) ? '（官网 $' + it.tier.price_foreign + ' 换算）' : ''),
          best: it.tier.price_cny === minPrice && items.length > 1,
        };
      }) +
      row('计费口径', function (it) { return { value: bMap[it.plan.billing_type].label, text: 1 }; }) +
      row('原始额度', function (it) { return { value: it.tier.quota.raw, text: 1 }; }) +
      row('折算月额度', function (it) {
        var d = it.tier.derived;
        if (!d || d.quota_month == null) return { value: '未公开', text: 1 };
        var u = it.plan.billing_type === 'token' ? 'Token' : (it.plan.billing_type === 'credits' ? bMap.credits.unit_label : bMap[it.plan.billing_type].unit_label);
        return { value: human(d.quota_month) + ' ' + u };
      }) +
      row('归一化单位成本', function (it, i) {
        var u = unitCost(it.tier, it.plan);
        if (!u) return { value: '无法折算', text: 1 };
        return { value: '', html: confDot(u.conf) + u.main + ' <span class="cmpfield">' + esc(u.sub) + '</span>', best: i === bestCostIdx };
      }) +
      row('估算月 Token', function (it) {
        var d = it.tier.derived;
        if (!d || d.est_tokens_month == null) return { value: '未公开', text: 1 };
        return { value: human(d.est_tokens_month) };
      }) +
      row('Agent 并发', function (it) {
        var c = it.tier.agent_concurrency;
        return { value: c ? c.min + '–' + c.max + ' 个' : '未公开', text: !c };
      }) +
      row('上下文窗口', function (it) {
        var c = it.tier.context_window;
        return { value: c ? human(c) + ' tokens' : '未公开', text: !c };
      }) +
      row('支持模型数', function (it) {
        var n = ecoCount(it.plan, 'models');
        return n == null ? { value: '官网未公布', text: true } : { value: String(n), best: n === maxModels };
      }) +
      row('兼容工具数', function (it) {
        var n = ecoCount(it.plan, 'tools');
        return n == null ? { value: '官网未公布', text: true } : { value: String(n), best: n === maxTools };
      }) +
      row('适用场景', function (it) { return { value: it.tier.use_case || '—', text: 1 }; }) +
      row('优惠条件', function (it) { return { value: it.tier.promo || it.tier.price_note || '无', text: 1 }; }) +
      row('价格追踪', function (it) {
        var n = (it.tier.price_history || []).length;
        return { value: n > 1 ? n + ' 次记录' : '首次记录 ' + META.snapshot_date, text: 1 };
      }) +
      row('官方购买', function (it) {
        return { value: '', html: '<a class="gobtn" href="' + esc(it.plan.buy_url) + '" target="_blank" rel="noopener nofollow">打开官网</a>', text: 1 };
      });

    document.getElementById('cmpBody').innerHTML =
      '<div class="tablewrap"><table class="cmptable"><tbody>' + head + body + '</tbody></table></div>' +
      '<p class="explain__note" style="margin-top:16px">' +
        '「最优」标记仅在同一个可比口径内计算：单位成本取可跨厂商比较的最小值' +
        (crossCount >= 2 ? '（本次对比中 ' + crossCount + ' 项可比）' : '（本次对比中不足 2 项可比，未标注）') +
        '，模型/工具数取最大值。高亮的灰底单元格表示各档位在该维度上存在差异。</p>';

    document.getElementById('cmpOverlay').hidden = false;
  }

  /* ---------------------------- 渲染：详情面板 ---------------------------- */

  function sparkline(history) {
    var w = 190, h = 40, pad = 6;
    if (!history || history.length === 0) return '';
    var prices = history.map(function (x) { return x.price_cny; });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices);
    var span = max - min || 1;

    if (history.length === 1) {
      return '<svg width="' + w + '" height="' + h + '" role="img" aria-label="价格历史">' +
        '<line x1="0" y1="' + (h / 2) + '" x2="' + w + '" y2="' + (h / 2) + '" stroke="var(--border-2)" stroke-width="1" stroke-dasharray="4 4"/>' +
        '<circle cx="' + (w - 8) + '" cy="' + (h / 2) + '" r="4" fill="var(--brand)"/>' +
        '<circle cx="' + (w - 8) + '" cy="' + (h / 2) + '" r="8" fill="var(--brand)" opacity="0.18"/></svg>';
    }
    var step = (w - pad * 2) / (history.length - 1);
    var pts = history.map(function (x, i) {
      var px = pad + i * step;
      var py = pad + (h - pad * 2) * (1 - (x.price_cny - min) / span);
      return px.toFixed(1) + ',' + py.toFixed(1);
    });
    return '<svg width="' + w + '" height="' + h + '" role="img" aria-label="价格历史">' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      pts.map(function (p) {
        var xy = p.split(',');
        return '<circle cx="' + xy[0] + '" cy="' + xy[1] + '" r="3" fill="var(--brand)"/>';
      }).join('') + '</svg>';
  }

  function renderDetail(planId) {
    var p = PLANS.filter(function (x) { return x.id === planId; })[0];
    if (!p) return;
    var v = vMap[p.vendor_id];

    document.getElementById('detailTitle').textContent = p.name;

    var html = '<div class="dt__top">' +
      '<span class="dt__logo" style="background:' + esc(v.color) + '">' + esc(v.logo_text) + '</span>' +
      '<div><h3 style="font-size:18px">' + esc(p.name) + '</h3>' +
      '<p style="font-size:12.5px;color:var(--text-3)">' + esc(v.name) + ' · ' + esc(bMap[p.billing_type].label) +
      ' · ' + p.tiers.length + ' 个档位 · ' + money(p.min_price_cny) + ' 起</p></div></div>' +
      '<p class="dt__pos">' + esc(p.positioning) + '</p>';

    if ((p.badges || []).length) {
      html += '<div class="dt__tags">' + p.badges.map(function (b) { return '<span class="badge">' + esc(b) + '</span>'; }).join('') + '</div>';
    }

    // 可购买性放在价格之前：能买到才算比价的前提
    html += purchaseSection(p);

    html += '<div class="dt__sec"><h3>档位与定价</h3><table class="tiersmini"><thead><tr>' +
      '<th>档位</th><th>月费</th><th>额度</th><th>单位成本</th></tr></thead><tbody>' +
      p.tiers.map(function (t) {
        var u = unitCost(t, p);
        return '<tr><td>' + esc(t.name) + (t.price_note ? '<br><span style="font-size:11px;color:var(--text-3)">' + esc(t.price_note) + '</span>' : '') + '</td>' +
          '<td class="mono">' + esc(priceMain(t)) + listPriceTag(t) + '</td>' +
          '<td>' + esc(t.quota.raw) + '</td>' +
          '<td class="mono">' + (u ? confDot(u.conf) + esc(u.main) + '<br><span style="font-size:11px;color:var(--text-3)">' + esc(u.sub) + '</span>' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    html += '<div class="dt__sec"><h3>价格追踪</h3>' +
      '<div class="spark">' + sparkline(p.tiers[0].price_history) +
      '<span>共 ' + p.tiers[0].price_history.length + ' 次记录，最近一次 ' + esc(p.tiers[0].price_history[p.tiers[0].price_history.length - 1].date) +
      (p.tiers[0].price_history.length === 1 ? '（首次记录，后续每次采集会追加新点位）' : '') + '</span></div></div>';

    // 生态清单：官网可能没公布总数，此时明确写「官网未公布」而不是画一个空区块
    html += ecoSection(p, 'models', '可调用模型', '个');
    html += ecoSection(p, 'tools', '兼容工具', '款');

    html += '<div class="dt__sec" style="display:flex;gap:8px">' +
      '<a class="btn btn--primary" href="' + esc(p.buy_url) + '" target="_blank" rel="noopener nofollow">前往官方购买页</a>' +
      '<button class="btn btn--ghost" type="button" data-addplan="' + esc(p.id) + '">把最低档加入对比</button>' +
      '</div>';

    document.getElementById('detailBody').innerHTML = html;
    document.getElementById('detailOverlay').hidden = false;
  }

  /* ---------------------------- 主渲染 ---------------------------- */

  function render() {
    var rows = sorted(filtered());

    var planCount = {};
    rows.forEach(function (r) { planCount[r.plan.id] = true; });
    var pickedInView = rows.filter(function (r) { return isPicked(r.tier.id); }).length;

    document.getElementById('resultCount').innerHTML =
      '共 <b>' + ROWS.length + '</b> 个档位 / <b>' + PLANS.length + '</b> 个套餐，' +
      '当前显示 <b>' + rows.length + '</b> 个档位（' + Object.keys(planCount).length + ' 个套餐）' +
      (pickedInView ? ' · 其中 ' + pickedInView + ' 个已加入对比' : '');

    // 单位成本排序时给出必要的口径提示，避免把估算值当成实测值
    var note = document.getElementById('sortNote');
    if (state.sort === 'cost-asc') {
      var crossN = rows.filter(function (r) { return r.uc && r.uc.cross; }).length;
      note.hidden = false;
      note.innerHTML = '<strong>按单位成本排序</strong>：Token 计费与按请求次数计费已统一折算为「¥/百万 Token」，' +
        '其中 <em>请求次数类是估算值</em>（低置信度，按每次请求 8,000 tokens 折算，实际受 5 小时限流窗口约束）。' +
        '积分 / Agent 额度 / 订阅类没有公开换算比例，不参与跨厂商比较，因此按价格排在末尾。' +
        '当前 ' + crossN + ' 个档位可跨口径比较。';
    } else {
      note.hidden = true;
    }

    if (state.view === 'table') {
      document.getElementById('tableView').hidden = false;
      document.getElementById('cardView').hidden = true;
      renderTable(rows);
    } else {
      document.getElementById('tableView').hidden = true;
      document.getElementById('cardView').hidden = false;
      renderCards(rows);
    }

    renderCompareBar();
  }

  /* ---------------------------- 事件绑定 ---------------------------- */

  // 筛选器
  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value; render();
  });

  document.getElementById('sort').addEventListener('change', function (e) {
    state.sort = e.target.value; render();
  });

  document.getElementById('freeOnly').addEventListener('change', function (e) {
    state.freeOnly = e.target.checked; render();
  });

  document.getElementById('billingChips').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-b]');
    if (!btn) return;
    var k = btn.dataset.b;
    state.billings[k] = !state.billings[k];
    btn.classList.toggle('is-on', state.billings[k]);
    render();
  });

  document.getElementById('useCaseChips').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-u]');
    if (!btn) return;
    var k = btn.dataset.u;
    state.useCases[k] = !state.useCases[k];
    btn.classList.toggle('is-on', state.useCases[k]);
    render();
  });

  var pr = document.getElementById('priceRange');
  pr.addEventListener('input', function (e) {
    state.maxPrice = Number(e.target.value);
    document.getElementById('priceVal').textContent =
      state.maxPrice >= MAX_PRICE ? '不限' : '≤ ' + money(state.maxPrice);
    render();
  });

  document.getElementById('resetBtn').addEventListener('click', function () {
    state.q = '';
    state.billings = {};
    state.useCases = {};
    state.maxPrice = MAX_PRICE;
    state.freeOnly = false;
    document.getElementById('q').value = '';
    document.getElementById('freeOnly').checked = false;
    pr.value = MAX_PRICE;
    document.getElementById('priceVal').textContent = '不限';
    Array.prototype.forEach.call(document.querySelectorAll('.chip.is-on'), function (c) { c.classList.remove('is-on'); });
    render();
  });

  // 视图切换
  document.getElementById('viewToggle').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.view = btn.dataset.view;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (b) {
      b.classList.toggle('is-active', b === btn);
    });
    persist(); render();
  });

  // 表格内的对比勾选 / 卡片按钮 / 卡片档位切换 / 详情按钮
  function addCompare(tierId) {
    var found = ROWS.filter(function (r) { return r.tier.id === tierId; })[0];
    if (!found) return;
    var exists = state.compare.some(function (c) { return c.tierId === tierId; });
    if (exists) {
      state.compare = state.compare.filter(function (c) { return c.tierId !== tierId; });
    } else {
      if (state.compare.length >= 4) {
        alert('最多同时对比 4 个档位，请先移除一个。');
        return;
      }
      state.compare.push({ planId: found.plan.id, tierId: tierId });
    }
    persist(); render();
  }

  document.addEventListener('change', function (e) {
    var box = e.target.closest('.cmpbox');
    if (box) addCompare(box.dataset.tier);
  });

  document.addEventListener('click', function (e) {
    var cmpBtn = e.target.closest('.btn[data-tier]');
    if (cmpBtn) { addCompare(cmpBtn.dataset.tier); return; }

    var tab = e.target.closest('.tiertab');
    if (tab) {
      state.tierIdx[tab.dataset.plan] = Number(tab.dataset.i);
      render();
      return;
    }

    var det = e.target.closest('[data-detail]');
    if (det) { renderDetail(det.dataset.detail); return; }

    var rm = e.target.closest('[data-rm]');
    if (rm) {
      state.compare = state.compare.filter(function (c) { return c.tierId !== rm.dataset.rm; });
      persist(); render();
      return;
    }

    var addPlan = e.target.closest('[data-addplan]');
    if (addPlan) {
      var p = PLANS.filter(function (x) { return x.id === addPlan.dataset.addplan; })[0];
      var cheapest = p.tiers.slice().sort(function (a, b) { return a.price_cny - b.price_cny; })[0];
      addCompare(cheapest.id);
      return;
    }

    if (e.target.closest('[data-close]')) {
      e.target.closest('.overlay').hidden = true;
      return;
    }
    // 点击遮罩关闭
    if (e.target.classList.contains('overlay')) e.target.hidden = true;
  });

  document.getElementById('cmpGo').addEventListener('click', renderCompare);
  document.getElementById('cmpClear').addEventListener('click', function () {
    state.compare = []; persist(); render();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.getElementById('cmpOverlay').hidden = true;
      document.getElementById('detailOverlay').hidden = true;
    }
  });

  // 主题
  var themeBtn = document.getElementById('themeBtn');
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('codeplan-theme'); } catch (e) {}
  document.documentElement.setAttribute('data-theme', savedTheme === 'dark' ? 'dark' : 'light');
  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('codeplan-theme', next); } catch (e) {}
  });

  /* ---------------------------- 启动 ---------------------------- */

  renderStats();
  renderChips();
  renderExplain();
  render();

  // 恢复已保存的对比项（校验数据是否仍存在）
  state.compare = state.compare.filter(function (c) {
    return ROWS.some(function (r) { return r.tier.id === c.tierId; });
  });
  renderCompareBar();

  console.log('[CodePlan] 数据已加载：' + VENDORS.length + ' 厂商 / ' + PLANS.length + ' 套餐 / ' + ROWS.length + ' 档位');
})();
