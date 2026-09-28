/* ==========================================================================
   CodePlan 比价 App —— 交互逻辑
   读取 ../data/plans.js 暴露的 window.__PLANS__（与 data/plans.json 同源）
   ========================================================================== */
(function () {
  'use strict';

  var D = window.__PLANS__;
  if (!D) {
    document.body.innerHTML = '<p style="padding:40px;font:14px/1.8 sans-serif">' +
      '数据没加载上：本页需要 <code>data/plans.js</code> 与 <code>app/</code> 的相对位置保持不变。</p>';
    return;
  }

  /* 共享层（可购买性判定 / 单位成本口径 / 字符串工具）与桌面版 js/app.js 共用同一份。
     缺了它下面每一行都会以 TypeError 炸在离原因很远的地方，所以这里就停下说清楚。 */
  var CP = window.__CP__;
  if (!CP) {
    document.body.innerHTML = '<p style="padding:40px;font:14px/1.8 sans-serif">' +
      '共享层没加载上：<code>shared.js</code> 必须在 <code>app.js</code> 之前引入。</p>';
    return;
  }

  /* ══════════════════════ 1. 数据整理 ══════════════════════ */

  var VENDOR = {};
  D.vendors.forEach(function (v) { VENDOR[v.id] = v; });

  var BILLING = {};
  D.billing_types.forEach(function (b) { BILLING[b.key] = b; });

  var USE_CASE_BY_LABEL = {};
  var USE_CASE = {};
  D.use_cases.forEach(function (u) { USE_CASE_BY_LABEL[u.label] = u; USE_CASE[u.key] = u; });

  /** 把 plans[].tiers[] 摊平成「档位行」，这是 App 里所有列表的最小单位 */
  var ROWS = [];
  D.plans.forEach(function (plan) {
    var vendor = VENDOR[plan.vendor_id] || { name: plan.vendor_id, short: plan.vendor_id, logo_text: '?', color: '#8b91a8' };
    plan.tiers.forEach(function (tier) {
      var uc = USE_CASE_BY_LABEL[tier.use_case] || null;
      ROWS.push({
        plan: plan,
        tier: tier,
        vendor: vendor,
        key: tier.id,
        billing: plan.billing_type,
        billingLabel: (BILLING[plan.billing_type] || {}).label || plan.billing_type,
        price: typeof tier.price_cny === 'number' ? tier.price_cny : null,
        useCaseLabel: tier.use_case || '',
        useCaseKey: uc ? uc.key : '',
        level: uc ? uc.level : 0,
        cost: unitCostOf(tier, plan),
        ecoModels: numOrNull(plan.models && plan.models.count),
        ecoTools: numOrNull(plan.tools && plan.tools.count)
      });
    });
  });

  function numOrNull(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  /**
   * 归一化单位成本。判定逻辑在共享层（__CP__.unitCost），桌面版用的是同一份；
   * 这里只负责把本口径的 unit_label 传进去 —— 共享层不认识具体口径，
   * 也就不会因为漏配一个口径而显示成 undefined。
   * token / requests 能折到「¥/百万 Token」，可跨厂商比；其余 cross=false。
   */
  function unitCostOf(tier, plan) {
    return CP.unitCost(tier, plan, (BILLING[plan.billing_type] || {}).unit_label);
  }

  /* ══════════════════════ 2. 格式化小工具 ══════════════════════ */

  // 转义 / Markdown 极简还原 / 搜索高亮：与桌面版共用同一份实现。
  // 尤其 hl() —— 高亮是最容易被写成注入点的地方，只该有一份实现。
  var esc = CP.esc;
  var md = CP.md;
  var hl = CP.hl;

  /** 通知条左侧图标：用 SVG 而不是 ⚠ / ℹ 字符 —— 后两者在中文字体里常落到缺字的回退字形 */
  function noticeIcon(kind) {
    if (kind === 'warn') {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M10.3 3.9 2.4 17.4A2 2 0 0 0 4.1 20.4h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
        '<path d="M12 9v4M12 16.5h.01"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.75h.01"/></svg>';
  }
  function money(n) {
    if (n == null) return '—';
    return '¥' + (Number.isInteger(n) ? n.toLocaleString('zh-CN') : n.toFixed(2));
  }
  function trim2(n) {
    var s = n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    return Number(s).toLocaleString('zh-CN');
  }
  function human(n) {
    if (n == null) return '—';
    if (n >= 1e8) return trim2(n / 1e8) + ' 亿';
    if (n >= 1e4) return trim2(n / 1e4) + ' 万';
    return n.toLocaleString('zh-CN');
  }
  function isForeign(t) { return !!t.price_currency; }

  function pushHistory(q) {
    var key = String(q || '').trim();
    if (!key) return;
    var i = state.history.indexOf(key);
    if (i >= 0) state.history.splice(i, 1);      // 去重：再搜一次要顶到最前，而不是留两条
    state.history.unshift(key);
    if (state.history.length > 8) state.history.length = 8;
    save();
  }
  /* 置信度：文案取自共享层，画法保留移动端自己的样式（桌面端是圆点 + hover，
     移动端没有 hover，所以必须写成文字徽章）。 */
  function conf(c) {
    if (!c) return '';
    return '<span class="conf conf--' + c + '" title="' + esc(CP.confTitle(c)) + '"><i></i>' +
      esc(CP.confShort(c)) + '</span>';
  }

  // 五态标签与判定都在共享层 —— 曾经两套各自写（桌面「需登录购买」/ 移动「需登录」），
  // 同一个状态两种说法，读者会以为是两件事。
  var PURCHASE_LABEL = CP.PURCHASE_LABEL;
  var PURCHASE_DESC = CP.PURCHASE_DESC;

  /**
   * 可购买性徽章。规矩：**缺失一律显示「未核实」，绝不留白**。
   * 留白会被读成「没限制、可以买」—— 这正是本数据集里最贵的一个错误。
   */
  function purchaseBadge(plan, opts) {
    opts = opts || {};
    // scopeTag：出现在一个「档位」行上时，必须说明这个结论是关于整个套餐的 ——
    // 数据集里没有档位级可购买性，不标注就等于把套餐级结论冒充成档位级结论。
    var scope = opts.scopeTag ? '<span class="scope-tag">· 该套餐</span>' : '';
    var pu = CP.purchaseOf(plan);
    if (!pu) return '<span class="badge pstatus--missing">未核实</span>' + scope;
    var html = '<span class="badge pstatus--' + esc(pu.status) + '">' + esc(PURCHASE_LABEL[pu.status]) + '</span>' + scope;
    if (opts.withDate !== false && pu.status !== 'on_sale' && pu.as_of) {
      html += '<span class="badge badge--muted">截至 ' + esc(pu.as_of) + '</span>';
    }
    return html;
  }
  function isBuyable(plan) { return CP.isBuyable(plan); }
  function isClosed(plan) { return CP.isClosed(plan); }
  /**
   * 可购买性的纯文本版本（给放不下徽章的小卡片用）。同样不给缺失留白。
   * withScope=true 时把「该套餐」放在**前面**而不是后面 —— 这行文字会被省略号截断，
   * 作用域标记放末尾就会第一个被切掉，等于没写。
   */
  function purchaseText(plan, withScope) {
    var st = CP.purchaseStatus(plan);
    var s = st === 'missing' ? '可购买性未核实' : PURCHASE_LABEL[st];
    return withScope ? '该套餐' + s : s;
  }
  /** 迷你卡右侧的价格格。外币仍按规矩显示原币，人民币只能以 ≈ 出现。 */
  function miniVal(r) {
    var t = r.tier;
    if (t.price_cny === 0) return '<b>免费</b><span>Free</span>';
    if (isForeign(t)) return '<b>' + esc(t.price_foreign) + ' ' + esc(t.price_currency) + '</b><span>≈' + money(t.price_cny) + '</span>';
    return '<b>' + money(t.price_cny) + '</b><span>' + (r.cost ? esc(r.cost.sub) : esc(shortPeriod(t))) + '</span>';
  }

  function vlogo(vendor, size) {
    var s = size || 34;
    return '<span class="vlogo" style="background:' + esc(vendor.color || '#8b91a8') +
      ';width:' + s + 'px;height:' + s + 'px;font-size:' + Math.round(s * 0.42) + 'px">' +
      esc(vendor.logo_text || '?') + '</span>';
  }
  function badgesOf(plan) {
    var out = '';
    (plan.badges || []).forEach(function (b) {
      var cls = b === '热门' ? 'badge--hot' : (b.indexOf('免费') >= 0 ? 'badge--free' : 'badge--brand');
      out += '<span class="badge ' + cls + '">' + esc(b) + '</span>';
    });
    return out;
  }

  /* ══════════════════════ 3. 状态 ══════════════════════ */

  var STORE_KEY = 'codeplan.app.v2';
  var FAV_KEY = 'codeplan.favs';
  var state = {
    screen: 'home',
    q: '',
    sort: 'cost-asc',
    billings: {},          // 空 = 不限
    useCases: {},          // 空 = 不限
    priceMax: null,        // null = 不限
    freeOnly: false,
    picked: [],            // 最多 4 个 tierId —— 「这次要比的」
    favs: [],              // 「想再看的」。和 picked 分开存：对比是当下的动作，清单是长期的意图
    theme: 'light',
    wizard: { step: 0, answers: {} },
    detailAllTiers: false, // 详情里价格追踪的范围：false = 只讲当前档，true = 全套餐
    saleFirst: false,      // 重排开关：把「买得到」的排前面。注意它是重排不是过滤
    degradeOpen: false,    // 被下沉的档位折叠区默认收起
    favSort: 'added',      // 我的关注排序：added / price / cost / purchase
    history: [],           // 搜索历史，最多 8 条，最新在前
    favMeta: {},           // tierId -> 加入时间戳。另存而不改 .favs 的结构，避免丢掉已有的收藏
    searchOpen: false      // 搜索建议面板：聚焦空搜索框时展开，一开始打字就让位给结果
  };

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        ['theme', 'sort', 'wizard', 'saleFirst', 'favSort', 'favMeta', 'history'].forEach(function (k) {
          if (saved[k] != null) state[k] = saved[k];
        });
        // 搜索历史可能有旧数据混进来，只留字符串并压缩到上限
        if (!Array.isArray(state.history)) state.history = [];
        if (saved.picked && saved.picked.length) {
          state.picked = saved.picked.filter(function (id) { return ROWS.some(function (r) { return r.key === id; }); }).slice(0, 4);
        }
      }
    } catch (e) { /* 隐私模式 / file:// 下静默降级 */ }
    loadFavs();
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        theme: state.theme, sort: state.sort, wizard: state.wizard, picked: state.picked,
        saleFirst: state.saleFirst, favSort: state.favSort,
        favMeta: state.favMeta || {}, history: state.history
      }));
    } catch (e) { /* 同上 */ }
  }

  /* 收藏单独存一个 key。
     和对比合用一个的话，「清空对比」会顺手把清单也清掉 —— 两件事的寿命不一样。 */
  function loadFavs() {
    try {
      var raw = localStorage.getItem(FAV_KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      // 收藏的是 tierId，数据集换了档位 id 之后就失效 —— 加载时过滤，不留幽灵条目
      if (Array.isArray(arr)) state.favs = arr.filter(function (id) { return ROWS.some(function (r) { return r.key === id; }); });
    } catch (e) { /* 同上 */ }
  }
  function saveFavs() {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(state.favs)); } catch (e) { /* 同上 */ }
  }
  function toggleFav(key) {
    var i = state.favs.indexOf(key);
    if (i >= 0) {
      state.favs.splice(i, 1);
      delete state.favMeta[key];
      toast('已从我的关注移除');
    } else {
      state.favs.push(key);
      // 时间戳另存在 favMeta 里，不改 .favs 的结构 —— 改结构会丢掉用户已有的收藏
      state.favMeta[key] = Date.now();
      toast('已加入我的关注 · 首页「我的关注」可看');
    }
    saveFavs(); save();
    renderRank(); renderHome(); renderFavs(); renderFavBtn();
  }

  /* ══════════════════════ 4. 筛选与排序 ══════════════════════ */

  function activeKeys(obj) { return Object.keys(obj).filter(function (k) { return obj[k]; }); }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var bills = activeKeys(state.billings);
    var ucs = activeKeys(state.useCases);

    return ROWS.filter(function (r) {
      if (bills.length && bills.indexOf(r.billing) < 0) return false;
      if (ucs.length && ucs.indexOf(r.useCaseKey) < 0) return false;
      if (state.priceMax != null && (r.price == null || r.price > state.priceMax)) return false;
      if (state.freeOnly && !r.plan.has_free_tier) return false;
      if (q) {
        var hay = [
          r.vendor.name, r.vendor.short, r.plan.name, r.tier.name,
          r.billingLabel, r.useCaseLabel, r.tier.quota && r.tier.quota.raw
        ].concat(r.plan.models && r.plan.models.listed || [], r.plan.tools && r.plan.tools.listed || [])
          .join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  /** 按单位成本升序：没有成本数据的一律垫底，绝不拿 null 当 0 排到最前。关注屏复用同一套口径。 */
  function byCostAsc(a, b) {
    var av = a.cost && a.cost.value != null ? a.cost.value : (a.cost ? parseFloat(a.cost.main.replace(/[^\d.]/g, '')) : null);
    var bv = b.cost && b.cost.value != null ? b.cost.value : (b.cost ? parseFloat(b.cost.main.replace(/[^\d.]/g, '')) : null);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return av - bv;
  }

  function sorted(rows) {
    var list = rows.slice();
    switch (state.sort) {
      case 'cost-asc':
        // 可跨口径比较的（value 有数）排前面；不可比的按自身单位成本也排一排，但界面会标注
        list.sort(byCostAsc);
        break;
      case 'price-asc':
        list.sort(function (a, b) { return (a.price == null ? 1e9 : a.price) - (b.price == null ? 1e9 : b.price); });
        break;
      case 'tokens-desc':
        list.sort(function (a, b) {
          var av = a.tier.derived && a.tier.derived.est_tokens_month, bv = b.tier.derived && b.tier.derived.est_tokens_month;
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return bv - av;
        });
        break;
      case 'eco-desc':
        list.sort(function (a, b) {
          var av = a.ecoModels == null ? -1 : a.ecoModels;
          var bv = b.ecoModels == null ? -1 : b.ecoModels;
          if (av !== bv) return bv - av;
          return (b.ecoTools == null ? -1 : b.ecoTools) - (a.ecoTools == null ? -1 : a.ecoTools);
        });
        break;
      case 'vendor':
        list.sort(function (a, b) {
          return a.vendor.name.localeCompare(b.vendor.name, 'zh-Hans-CN') || a.price - b.price;
        });
        break;
    }
    return list;
  }

  /* ══════════════════════ 5. 通用渲染块 ══════════════════════ */

  function tierPriceHtml(r) {
    var t = r.tier;
    if (t.price_cny === 0) return '<b>免费</b><span>Free</span>';
    var html = '<b>' + money(t.price_cny) + '</b><i>/月</i>';
    if (isForeign(t)) html = '<b>' + esc(t.price_foreign) + ' ' + esc(t.price_currency) + '</b><span>≈' + money(t.price_cny) + '（汇率估算）</span>';
    else if (t.price_list_cny && t.price_list_cny !== t.price_cny) html += '<span>标价 ' + money(t.price_list_cny) + '</span>';
    else html += '<span>' + esc(shortPeriod(t)) + '</span>';
    return html;
  }
  function shortPeriod(t) {
    if (t.price_note) return t.price_note.length > 22 ? t.price_note.slice(0, 21) + '…' : t.price_note;
    return t.billing_period === 'quarterly' ? '季付均价' : '按月';
  }

  /** 星标：实心 = 已在清单里 */
  var STAR_PATH = 'M12 3.7l2.6 5.3 5.8.85-4.2 4.1.99 5.8-5.2-2.73-5.2 2.73.99-5.8-4.2-4.1 5.8-.85z';
  function starBtn(r) {
    var on = state.favs.indexOf(r.key) >= 0;
    return '<button class="favbtn' + (on ? ' is-on' : '') + '" type="button" data-fav="' + esc(r.key) +
      '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + (on ? '从我的清单移除' : '加入我的清单') + '">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg></button>';
  }

  /** 档位行卡片：榜单的核心单元 */
  function rowHtml(r) {
    var t = r.tier, picked = state.picked.indexOf(r.key) >= 0;
    var q = t.quota || {};
    var tokenEst = t.derived && t.derived.est_tokens_month;
    var kw = state.q;   // 命中高亮只作用于名字类字段，不打进价格与额度（那些是数字）

    /* 搜索能命中模型名和工具名，但这两样在卡片上是看不到的 ——
       不解释的话，用户搜「Cline」会看到一堆卡，却不知道它们凭什么被选中。
       命中行把理由摊开：命中了哪个字段、具体哪些值。 */
    var hits = [];
    var kwKey = String(kw || '').trim().toLowerCase();
    if (kwKey) {
      function hitFrom(arr, label) {
        var m = ((arr || []).filter(function (x) { return String(x).toLowerCase().indexOf(kwKey) >= 0; }));
        if (m.length) hits.push({ label: label, text: m.slice(0, 3).join('、') + (m.length > 3 ? ' 等 ' + m.length + ' 项' : '') });
      }
      hitFrom(r.plan.models && r.plan.models.listed, '可调用模型');
      hitFrom(r.plan.tools && r.plan.tools.listed, '兼容工具');
      if (q.raw && String(q.raw).toLowerCase().indexOf(kwKey) >= 0) hits.push({ label: '额度', text: q.raw });
      if (r.useCaseLabel && String(r.useCaseLabel).toLowerCase().indexOf(kwKey) >= 0) hits.push({ label: '场景', text: r.useCaseLabel });
    }
    var hitHtml = hits.length ? '<div class="row__hit">' + hits.map(function (h) {
      return '<span class="row__hitrow"><span class="row__hitk">' + esc(h.label) + '</span>' + hl(h.text, kw) + '</span>';
    }).join('') + '</div>' : '';

    var stats = [
      ['额度', q.raw ? esc(q.raw) : '未公布', true],
      ['折算月额', tokenEst != null ? human(tokenEst) + '<small> Token</small>' : (t.derived && t.derived.quota_month != null ? human(t.derived.quota_month) + '<small> ' + esc((BILLING[r.billing] || {}).unit_label || '') + '</small>' : '—'), false],
      ['单位成本', r.cost ? esc(r.cost.main) + '<small> ' + esc(r.cost.sub) + '</small>' : '—', false]
    ];

    return '' +
      '<article class="row' + (picked ? ' is-picked' : '') + '" data-key="' + esc(r.key) + '">' +
        '<div class="row__head">' +
          vlogo(r.vendor, 36) +
          '<div class="row__title">' +
            '<div class="row__vendor">' + hl(r.vendor.name, kw) + '</div>' +
            '<div class="row__name">' + hl(r.plan.name, kw) + '</div>' +
            '<div class="row__tier">' + hl(t.name, kw) + ' · ' + esc(r.billingLabel) + '</div>' +
          '</div>' +
          '<div class="row__price">' + tierPriceHtml(r) + '</div>' +
        '</div>' +
        '<div class="row__meta">' + purchaseBadge(r.plan, { scopeTag: true }) + badgesOf(r.plan) +
          (t.is_free ? '<span class="badge badge--free">免费档</span>' : '') +
          (t.promo ? '<span class="badge badge--violet">' + esc(t.promo) + '</span>' : '') +
          starBtn(r) +
        '</div>' +
        hitHtml +
        '<dl class="row__stats">' + stats.map(function (s) {
          return '<div class="row__stat' + (s[2] ? ' row__stat--wide' : '') + '"><dt>' + s[0] + '</dt><dd>' + s[1] + '</dd></div>';
        }).join('') + '</dl>' +
        '<div class="row__foot">' +
          (r.cost ? conf(r.cost.conf) : '') +
          '<button class="linkbtn" type="button" data-detail="' + esc(r.plan.id) + '" data-tier="' + esc(r.key) + '">详情</button>' +
          '<button class="btn ' + (picked ? 'btn--ghost' : 'btn--primary') + ' btn--sm" type="button" data-pick="' + esc(r.key) + '">' +
            (picked ? '已选' : '加入对比') + '</button>' +
        '</div>' +
      '</article>';
  }

  function evtHtml(e) {
    var cls = e.kind === 'price' ? 'evt--price' : ('evt--' + (e.status || 'on_sale'));
    var long = e.note.replace(/<[^>]+>/g, '').length > 120;
    var body = '' +
      '<div class="evt__top">' +
        '<span class="evt__plan">' + esc(e.plan.name) + '</span>' +
        (e.badge || '') +
        '<span class="evt__date">' + esc(e.date) + '</span>' +
      '</div>' +
      '<p class="evt__note' + (long ? ' is-clamped' : '') + '">' + e.note + '</p>' +
      (long ? '<button class="evt__more" type="button" data-more>展开全文</button>' : '') +
      (e.source ? '<p class="evt__src"><a href="' + esc(e.source) + '" target="_blank" rel="noopener">查看出处 ↗</a></p>' : '');
    return '<article class="evt ' + cls + '"><span class="evt__bar"></span><div class="evt__main">' + body + '</div></article>';
  }

  /* ══════════════════════ 6. 首页 ══════════════════════ */

  function renderHome() {
    document.getElementById('homeSnap').innerHTML =
      '<span class="snap__dot"></span><span>数据快照 <b>' + esc(D.meta.snapshot_date) + '</b> · ' +
      D.meta.counts.vendors + ' 家厂商 / ' + D.meta.counts.plans + ' 个套餐 / ' + D.meta.counts.tiers + ' 个档位 · ' +
      '口径已统一，但<strong>并非每个字段都核实过</strong></span>';

    var closedCount = ROWS.filter(function (r) { return isClosed(r.plan); }).length;
    var verified = ROWS.filter(function (r) { return CP.purchaseOf(r.plan); }).length;

    document.getElementById('homeCta').innerHTML =
      '<h2>不知道该买哪个？</h2>' +
      '<p>别从价格看起 —— 起售价低不等于性价比高，而且有的套餐<b>已经买不到了</b>。' +
      '回答三个问题，直接给结论。</p>' +
      '<button class="btn btn--light" type="button" data-go="wizard">开始选型向导 →</button>' +
      '<p style="margin-top:10px;opacity:.85">已有 ' + closedCount + ' 个档位落在停止新购/需登录的套餐里 · ' +
      (D.meta.counts.tiers - verified) + ' 个档位的可购买性尚未核实</p>';

    // 榜单速览：只在「可跨口径比较」的档位里排，避免拿不可比的数骗人
    var crossable = ROWS.filter(function (r) { return r.cost && r.cost.cross && isBuyable(r.plan); });
    var top = crossable.slice().sort(function (a, b) { return a.cost.value - b.cost.value; }).slice(0, 3);
    document.getElementById('homeTop').innerHTML = top.length ? top.map(function (r, i) {
      return '<button class="rmini" type="button" data-detail="' + esc(r.plan.id) + '" data-tier="' + esc(r.key) + '">' +
        '<span class="rmini__no">' + (i + 1) + '</span>' +
        '<span class="rmini__main"><span class="rmini__name">' + esc(r.plan.name) + ' · ' + esc(r.tier.name) + '</span>' +
        '<span class="rmini__sub">' + esc(r.vendor.name) + ' · ' + esc(r.billingLabel) + ' · 已验证在售</span></span>' +
        '<span class="rmini__val"><b>' + esc(r.cost.main) + '</b><span>' + esc(r.cost.sub) + '</span></span>' +
      '</button>';
    }).join('') : '<p class="empty">暂无「已核实可购买 + 可跨口径比较」的档位。</p>';

    // 我的清单：收藏的是 tierId，按数据里的顺序回排，而不是按收藏时间 ——
    // 用户要的是「这些档位现在什么样」，不是「我什么时候点的星」。
    var favRows = ROWS.filter(function (r) { return state.favs.indexOf(r.key) >= 0; });
    // 空收藏列表占一整块是浪费首屏 —— 缩成一行引导，既教会功能又不挡路
    document.getElementById('homeFavsCount').textContent = favRows.length;
    document.getElementById('homeFavs').innerHTML = favRows.length ? favRows.slice(0, 3).map(function (r) {
      return '<button class="rmini" type="button" data-detail="' + esc(r.plan.id) + '" data-tier="' + esc(r.key) + '">' +
        '<span class="rmini__no rmini__no--star"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + STAR_PATH + '"/></svg></span>' +
        '<span class="rmini__main"><span class="rmini__name">' + esc(r.plan.name) + ' · ' + esc(r.tier.name) + '</span>' +
        '<span class="rmini__sub">' + esc(r.vendor.name) + ' · ' + esc(r.billingLabel) + ' · ' + esc(purchaseText(r.plan, true)) + '</span></span>' +
        '<span class="rmini__val">' + miniVal(r) + '</span>' +
      '</button>';
    }).join('') + (favRows.length > 3 ? '<p class="hintline">还有 ' + (favRows.length - 3) + ' 档，点右上角「全部」查看。</p>' : '')
      : '<p class="hintline">还没有收藏 —— 榜单里每张档位卡上的 ☆ 可以加进来，下次直接从这里看。</p>';

    document.getElementById('homePulse').innerHTML = events().slice(0, 3).map(evtHtml).join('');

    document.getElementById('homeLedger').innerHTML = D.billing_types.map(function (b) {
      return '<div class="ledger__row"><span class="ledger__k">' + esc(b.label) + '</span>' +
        '<span class="ledger__v">' + esc(b.note) + '</span>' +
        '<span class="ledger__tag ' + (b.comparable ? 'ledger__tag--ok' : 'ledger__tag--no') + '">' +
        (b.comparable ? '可折算' : '不可比') + '</span></div>';
    }).join('');
  }

  /* ══════════════════════ 7. 榜单 ══════════════════════ */

  function renderChips() {
    var bCount = {}, uCount = {};
    ROWS.forEach(function (r) {
      bCount[r.billing] = (bCount[r.billing] || 0) + 1;
      if (r.useCaseKey) uCount[r.useCaseKey] = (uCount[r.useCaseKey] || 0) + 1;
    });

    document.getElementById('billingChips').innerHTML =
      '<button class="chip' + (activeKeys(state.billings).length ? '' : ' is-on') + '" type="button" data-billing="__all">不限</button>' +
      D.billing_types.map(function (b) {
        return '<button class="chip' + (state.billings[b.key] ? ' is-on' : '') + '" type="button" data-billing="' + esc(b.key) + '">' +
          esc(b.label) + '<span class="chip__n">' + (bCount[b.key] || 0) + '</span></button>';
      }).join('');

    document.getElementById('useCaseChips').innerHTML =
      '<button class="chip' + (activeKeys(state.useCases).length ? '' : ' is-on') + '" type="button" data-usecase="__all">不限</button>' +
      D.use_cases.map(function (u) {
        return '<button class="chip' + (state.useCases[u.key] ? ' is-on' : '') + '" type="button" data-usecase="' + esc(u.key) + '">' +
          esc(u.label) + '<span class="chip__n">' + (uCount[u.key] || 0) + '</span></button>';
      }).join('');
  }

  function renderRank() {
    var rows = sorted(filtered());

    document.getElementById('rankCount').innerHTML = '共 <b>' + rows.length + '</b> 个档位';

    var dot = document.getElementById('filterDot');
    var extra = (state.priceMax != null || state.freeOnly) ? 1 : 0;
    dot.hidden = !extra;

    /* 提示条：默认只露一行，全文按需展开。
       理由不是「太长」，是首屏就那么高 —— 5 行说明的代价是
       「第一张档位卡的『加入对比』按钮被 Tab 栏压住」。 */
    var notice = document.getElementById('rankNotice');
    var msg = null;
    if (state.sort === 'cost-asc') {
      var crossN = rows.filter(function (r) { return r.cost && r.cost.cross; }).length;
      msg = ['单位成本只在<b>同一计费口径</b>内可比。当前 ' + crossN + ' 个档位可折成「¥/百万 Token」；' +
        '积分制、Agent 额度、席位制没有公开换算比例，<b>不参与跨口径排名</b>，仅按自身单位给出成本。'];
    } else if (state.sort === 'price-asc') {
      msg = ['按<b>月费</b>排序会把额度差几十倍的档位排在一起 —— 便宜的是它，够用的未必是它。'];
    }

    if (!msg) {
      notice.hidden = true;
    } else {
      notice.hidden = false;
      notice.innerHTML = noticeIcon('warn') +
        '<span class="notice__body">' +
          '<span class="notice__text is-clamped">' + msg[0] + '</span>' +
          '<button class="notice__more" type="button" data-more>展开全文</button>' +
        '</span>';
    }

    /* ── 可购买性的「优先展示在售」：重排，不是过滤 ──
       规矩是「不让买不到被筛掉」（见筛选弹层里的说明），所以这里一行都不能少：
       #rankCount 始终是总数，被下沉的档位进折叠区，展开后数量对得上。
       这是唯一能证明「它没有骗你」的方式 —— 计数守恒。 */
    var zone = document.getElementById('degradeZone');
    var btn = document.getElementById('saleFirstBtn');
    btn.classList.toggle('is-on', state.saleFirst);
    btn.setAttribute('aria-pressed', state.saleFirst ? 'true' : 'false');

    var unverified = ROWS.filter(function (r) { return !CP.purchaseOf(r.plan); }).length;
    document.getElementById('unverifiedHint').textContent =
      unverified + ' / ' + ROWS.length + ' 档所属套餐的可购买性尚未核实';

    if (state.saleFirst && rows.some(function (r) { return !isBuyable(r.plan); })) {
      var buyable = rows.filter(function (r) { return isBuyable(r.plan); });
      var rest = rows.filter(function (r) { return !isBuyable(r.plan); });
      zone.hidden = false;
      document.getElementById('rankRows').innerHTML = buyable.map(rowHtml).join('');
      document.getElementById('degradeBody').innerHTML = rest.map(rowHtml).join('');
      document.getElementById('degradeBody').hidden = !state.degradeOpen;
      document.getElementById('degradeCount').textContent = rest.length;
      document.getElementById('degradeCaret').textContent = state.degradeOpen ? '收起' : '展开';
      document.getElementById('degradeTitle').textContent =
        '以下 ' + rest.length + ' 个档位所属套餐未核实或不可新购 —— 它们没有被筛掉，只是排在后面';
    } else {
      zone.hidden = true;
      document.getElementById('rankRows').innerHTML = rows.map(rowHtml).join('');
    }

    /* 空结果：给出「怎么走出去」，而不是一句「没有符合条件的档位」。
       特别是要把**当前生效的筛选**列出来 —— 搜索和筛选是叠加的且互相不清零，
       用户看到的空结果往往是两个条件共同造成的，不点破就只能靠猜。 */
    var emptyEl = document.getElementById('rankEmpty');
    emptyEl.hidden = rows.length > 0;
    if (!rows.length) {
      var conds = [];
      if (state.q.trim()) conds.push('搜索「' + state.q.trim() + '」');
      var bs = activeKeys(state.billings);
      if (bs.length) conds.push('计费口径：' + bs.map(function (b) { return (BILLING[b] || {}).label || b; }).join('、'));
      var us = activeKeys(state.useCases);
      if (us.length) conds.push('场景：' + us.map(function (u) { return (USE_CASE[u] || {}).label || u; }).join('、'));
      if (state.priceMax != null) conds.push('月费 ≤ ¥' + state.priceMax);
      if (state.freeOnly) conds.push('只看有免费档');
      emptyEl.innerHTML = '<p class="empty__lead">没有符合条件的档位。</p>' +
        (conds.length ? '<p class="empty__cond">当前生效：' + conds.map(esc).join(' ＋ ') + '</p>' : '') +
        '<div class="empty__acts">' +
          (state.q.trim() ? '<button class="btn btn--ghost btn--sm" type="button" data-emptyq="1">清空搜索</button>' : '') +
          '<button class="btn btn--ghost btn--sm" type="button" data-emptybill="1">计费口径改「不限」</button>' +
          '<button class="btn btn--primary btn--sm" type="button" data-go="wizard">去选型向导</button>' +
        '</div>';
    }
    renderCmpBar();
  }

  /* ── 搜索建议 ──────────────────────────────────────────────
     热词全部**由数据推出来**，没有一条是手写的。手写的热词会随数据集变化而失效，
     而且会让「这个词有多少个套餐支持」变成一句假话 —— 计数必须来自真实统计。 */
  var HOT_CACHE = null;
  function hotWords() {
    if (HOT_CACHE) return HOT_CACHE;
    var freq = {};
    function bump(k) { if (k) freq[k] = (freq[k] || 0) + 1; }
    D.plans.forEach(function (p) { ((p.tools && p.tools.listed) || []).forEach(bump); });
    D.plans.forEach(function (p) {
      var v = VENDOR[p.vendor_id];
      if (v) bump(v.short || v.name);
    });
    (D.use_cases || []).forEach(function (u) { bump(u.label); });
    HOT_CACHE = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })
      .slice(0, 8).map(function (k) { return { key: k, n: freq[k] }; });
    return HOT_CACHE;
  }

  function renderSearchPane() {
    var pane = document.getElementById('searchPane');
    if (!pane) return;
    pane.hidden = !state.searchOpen;

    var hist = state.history.slice(0, 8);
    var html = '';
    if (hist.length) {
      html += '<div class="searchpane__sec">' +
        '<div class="searchpane__hd"><span>搜索历史</span>' +
          '<button class="searchpane__clr" type="button" data-histclear="1">清空</button></div>' +
        '<div class="chips">' + hist.map(function (h) {
          return '<button class="chip" type="button" data-hist="' + esc(h) + '">' + esc(h) + '</button>';
        }).join('') + '</div></div>';
    }
    html += '<div class="searchpane__sec">' +
      '<div class="searchpane__hd"><span>大家都在搜</span>' +
        '<span class="searchpane__note">按数据集里的出现次数排</span></div>' +
      '<div class="chips">' + hotWords().map(function (h) {
        return '<button class="chip" type="button" data-hot="' + esc(h.key) + '">' + esc(h.key) +
          '<span class="chip__n">' + h.n + '</span></button>';
      }).join('') + '</div></div>';
    pane.innerHTML = html;
  }

  function applyQuery(q) {
    state.q = q;
    document.getElementById('q').value = q;
    document.getElementById('qClear').hidden = !q;
    if (q) pushHistory(q);
    state.searchOpen = false;
    renderSearchPane();
    renderRank();
  }

  /* ══════════════════════ 8. 选型向导 ══════════════════════ */

  var Q_LEVEL = [
    { key: 'l1', icon: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
      title: '偶尔用用', desc: '一周几次，试试水或多一个备选', level: 1 },
    { key: 'l2', icon: 'M4 19h16M7 19V9M12 19V5M17 19v-7',
      title: '每天 1～2 小时', desc: '写点脚本、小工具、副业项目', level: 3 },
    { key: 'l3', icon: 'M13 2 4 14h6l-1 8 9-12h-6z',
      title: '全天主力', desc: '工作就把 AI 当主力，一天几小时以上', level: 4 },
    { key: 'l4', icon: 'M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 6.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6M21 20v-2a4 4 0 0 0-3-3.9M16.5 3.5a3 3 0 0 1 0 6',
      title: '团队一起用', desc: '要席位、要并发、要走公司预算', level: 5 }
  ];
  var Q_BUDGET = [
    { key: 'b1', title: '¥50 以内', desc: '先低成本上车，不够再说', max: 50 },
    { key: 'b2', title: '¥50 ~ ¥150', desc: '一杯咖啡到一顿饭的量级', max: 150 },
    { key: 'b3', title: '¥150 ~ ¥400', desc: '愿意为效率付费', max: 400 },
    { key: 'b4', title: '不限', desc: '效果好就行，公司报销', max: null }
  ];

  function toolOptions() {
    var freq = {};
    D.plans.forEach(function (p) {
      ((p.tools && p.tools.listed) || []).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    });
    return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })
      .slice(0, 6).map(function (t) { return { key: t, title: t, desc: (freq[t] >= 2 ? freq[t] + ' 个套餐支持' : '少数套餐支持') }; });
  }

  function renderWizard() {
    var w = state.wizard;
    var steps = document.getElementById('wzSteps');
    steps.innerHTML = [0, 1, 2].map(function (i) {
      return '<i class="' + (i < w.step ? 'is-done' : (i === w.step ? 'is-now' : '')) + '"></i>';
    }).join('');

    if (w.step === 3) return renderWizardResult();

    var q, opts, ansKey;
    if (w.step === 0) { q = '你大概会用多少？'; opts = Q_LEVEL; ansKey = 'level'; }
    else if (w.step === 1) { q = '主要在哪个工具里用？'; opts = toolOptions(); ansKey = 'tool'; }
    else { q = '月预算大概多少？'; opts = Q_BUDGET; ansKey = 'budget'; }

    var cur = w.answers[ansKey];
    var curKey = typeof cur === 'object' && cur ? cur.key : cur;

    document.getElementById('wzBody').innerHTML = '' +
      '<h2 class="wz__q">' + esc(q) + '</h2>' +
      '<p class="wz__hint">' + (w.step === 1
        ? '选一个你最常用的。选「都能接受」会把不兼容的档位排到后面而不是直接删掉 —— 不替你决定。'
        : '答案只用来排优先级，会把不满足的原因写出来，而不是悄悄过滤掉。') + '</p>' +
      '<div class="wz__opts">' +
        opts.map(function (o) {
          return '<button class="wz__opt' + (curKey === o.key ? ' is-on' : '') + '" type="button" data-wz="' + esc(o.key) + '">' +
            '<span class="wz__opt__ic">' + (o.icon
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + o.icon + '"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/></svg>') +
            '</span>' +
            '<span><strong>' + esc(o.title) + '</strong><span>' + esc(o.desc) + '</span></span>' +
          '</button>';
        }).join('') + '</div>' +
      // 禁用态写清原因。原先用 opacity:.45 表达禁用，白字落在半透明靛蓝上只有 2.32:1 ——
      // 既读不清，也看不出「为什么不能点」。
      (cur ? '' : '<p class="wz__why">先选一项 —— 你的用量直接决定哪一档不浪费，跳过这一步给不出负责任的推荐。</p>') +
      '<div class="wz__foot">' +
        (w.step > 0 ? '<button class="btn btn--ghost" type="button" data-wzback>上一步</button>' : '') +
        '<button class="btn btn--primary" type="button" data-wznext ' + (cur ? '' : 'disabled') + '>' +
          (w.step === 2 ? '看推荐' : '下一步') + '</button>' +
      '</div>';
  }

  function renderWizardResult() {
    var a = state.wizard.answers;
    var level = (a.level && a.level.level) || 0;
    var tool = a.tool && a.tool.key;
    var budget = a.budget || { max: null, title: '不限' };

    // 只在可跨口径比较的档位里推荐：不可比的档位给不出「性价比」这个理由
    var cands = ROWS.filter(function (r) { return r.cost && r.cost.cross && r.price != null; });

    var scored = cands.map(function (r) {
      var s = 0, why = [], warn = [];
      var diff = Math.abs((r.level || 0) - level);
      if (r.level && r.level === level) { s += 4; why.push('档位定位就是「' + r.useCaseLabel + '」'); }
      else if (diff === 1) { s += 2; why.push('定位「' + r.useCaseLabel + '」与你差一档，够用且不浪费'); }
      else if (diff >= 2) { s -= 1; warn.push('定位「' + r.useCaseLabel + '」与你相差 ' + diff + ' 档'); }

      var tools = (r.plan.tools && r.plan.tools.listed) || [];
      if (tool) {
        if (tools.indexOf(tool) >= 0) { s += 3; why.push('官方明确兼容 ' + tool); }
        else { s -= 2; warn.push('列出的兼容工具里没有 ' + tool + (r.plan.tools && r.plan.tools.partial ? '（且该列表本身不完整）' : '')); }
      }

      if (budget.max == null) { s += 1; }
      else if (r.price <= budget.max) { s += 2; why.push(money(r.price) + '/月 在你的「' + budget.title + '」预算内'); }
      else { s -= 3; warn.push(money(r.price) + '/月 超出预算'); }

      var pu = CP.purchaseOf(r.plan);   // 唯一入口：无效状态与缺失都会被统一挡掉
      if (isBuyable(r.plan)) { s += 3; why.push(pu.status === 'limited' ? '当前限量抢购中（' + pu.as_of + '）' : '已核实可正常购买'); }
      else if (isClosed(r.plan)) { s -= 5; warn.push('⚠ ' + PURCHASE_LABEL[pu.status] + '（截至 ' + pu.as_of + '）—— 价格再合适也买不到'); }
      else { warn.push('可购买性未核实，下单前请自行确认'); }

      if (r.cost.conf === 'high') { s += 1; why.push('额度折算置信度高（厂商直接公开 Token 数）'); }

      return { r: r, s: s, why: why, warn: warn };
    }).sort(function (a, b) { return b.s - a.s; });

    var top = scored.slice(0, 3);
    var a1 = state.wizard.answers.level, a2 = state.wizard.answers.tool, a3 = state.wizard.answers.budget;

    document.getElementById('wzBody').innerHTML = '' +
      '<h2 class="wz__q">推荐这三个</h2>' +
      '<p class="wz__hint">依据你的三个回答排序。每一条结论都标了出处字段，<b>不满足的地方直接写在卡片里</b>，不藏。</p>' +
      '<div class="wz__answer">' +
        '<span class="wz__chip">用量 <b>' + esc(a1 ? a1.title : '—') + '</b><button type="button" data-wzto="0">&times;</button></span>' +
        '<span class="wz__chip">工具 <b>' + esc(a2 ? a2.title : '都能接受') + '</b><button type="button" data-wzto="1">&times;</button></span>' +
        '<span class="wz__chip">预算 <b>' + esc(a3 ? a3.title : '不限') + '</b><button type="button" data-wzto="2">&times;</button></span>' +
      '</div>' +
      top.map(function (o, i) {
        var r = o.r;
        return '<article class="rec' + (i === 0 ? ' rec--first' : '') + '">' +
          '<div class="rec__rank">' + (i === 0 ? '最匹配' : '备选 ' + i) + ' · 匹配分 ' + o.s + '</div>' +
          '<div class="rec__body">' +
            '<div class="rec__head">' + vlogo(r.vendor, 38) +
              '<div class="row__title"><div class="row__vendor">' + esc(r.vendor.name) + '</div>' +
              '<div class="row__name">' + esc(r.plan.name) + ' · ' + esc(r.tier.name) + '</div>' +
              '<div class="row__tier">' + esc(r.billingLabel) + '</div></div>' +
              '<div class="row__price">' + tierPriceHtml(r) + '</div>' +
            '</div>' +
            '<div class="row__meta" style="margin-top:10px">' + purchaseBadge(r.plan, { scopeTag: true }) + '</div>' +
            '<ul class="rec__why">' +
              o.why.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') +
              o.warn.map(function (t) { return '<li class="is-warn">' + esc(t) + '</li>'; }).join('') +
            '</ul>' +
            '<div class="row__foot"><button class="linkbtn" type="button" data-detail="' + esc(r.plan.id) + '" data-tier="' + esc(r.key) + '">看详情</button>' +
              '<button class="btn btn--ghost btn--sm" type="button" data-pick="' + esc(r.key) + '">加入对比</button></div>' +
          '</div></article>';
      }).join('') +
      '<div class="wz__foot"><button class="btn btn--ghost btn--block" type="button" data-wzreset>重新回答</button></div>' +
      '<p class="wz__hint" style="margin-top:14px">只推荐「可折成 ¥/百万 Token」的档位（共 ' + cands.length +
      ' 个）。积分制、Agent 额度、席位制因为缺少公开换算比例，无法参与性价比排序，需要的话请直接去榜单按口径筛。</p>';
  }

  /* ══════════════ 8.5 我的关注 ══════════════ */

  var FAV_SORTS = [
    { key: 'added', label: '加入时间' },
    { key: 'price', label: '月费 ↑' },
    { key: 'cost', label: '单位成本 ↑' },
    { key: 'purchase', label: '可购买性' }
  ];

  /** 可购买性的排序权重：能买的在前，买不到的在后，未核实夹在中间。
      「未核实」不能和「在售」同权重 —— 那等于把没查过的当成能买的。
      权重定义在共享层，桌面版要排同一个序时不会排出另一种结果。 */
  function purchaseRank(plan) { return CP.purchaseRank(plan); }

  /** 价格变动同样来自共享层：点位不足 2 个时它返回 v=null（判断不了），
      而不是 0 —— 0 会被读成「价格没变」，真相是「还没得比」。 */
  function priceDelta(tier) { return CP.priceDelta(tier); }

  function pmDeltaHtml(d) {
    if (d.v == null) return '<span class="pmark pmark--na">价格未追踪</span>';
    if (d.v === 0) return '<span class="pmark pmark--flat">价格持平</span>';
    // 涨=红、跌=绿（跟国内行情一致）
    return '<span class="pmark pmark--' + (d.v < 0 ? 'down' : 'up') + '">' +
      (d.v < 0 ? '降价 ' : '涨价 ') + money(Math.abs(d.v)) + '</span>';
  }

  /** 旧收藏没有时间戳。显示「更早加入」而不是编一个日期 —— 编造的时间比缺失更糟。 */
  function favWhenText(key) {
    var ts = state.favMeta && state.favMeta[key];
    if (!ts) return '更早加入';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '更早加入';
    return '加入于 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function favRowsSorted() {
    var list = ROWS.filter(function (r) { return state.favs.indexOf(r.key) >= 0; });
    if (state.favSort === 'price') {
      list.sort(function (a, b) { return (a.price == null ? 1e9 : a.price) - (b.price == null ? 1e9 : b.price); });
    } else if (state.favSort === 'cost') {
      list.sort(byCostAsc);
    } else if (state.favSort === 'purchase') {
      list.sort(function (a, b) {
        return purchaseRank(a.plan) - purchaseRank(b.plan) || byCostAsc(a, b);
      });
    } else {
      list.sort(function (a, b) {
        return ((state.favMeta && state.favMeta[b.key]) || 0) - ((state.favMeta && state.favMeta[a.key]) || 0);
      });
    }
    return list;
  }

  function favRowHtml(r) {
    var picked = state.picked.indexOf(r.key) >= 0;
    return '<article class="row row--fav" data-key="' + esc(r.key) + '">' +
      '<div class="row__head">' + vlogo(r.vendor, 34) +
        '<div class="row__title">' +
          '<div class="row__vendor">' + esc(r.vendor.name) + '</div>' +
          '<div class="row__name">' + esc(r.plan.name) + ' · ' + esc(r.tier.name) + '</div>' +
          '<div class="row__tier">' + esc(r.billingLabel) + ' · ' + pmDeltaHtml(priceDelta(r.tier)) + '</div>' +
        '</div>' +
        '<div class="row__price">' + tierPriceHtml(r) + '</div>' +
      '</div>' +
      '<div class="row__meta">' + purchaseBadge(r.plan, { scopeTag: true }) +
        (r.cost ? ' ' + conf(r.cost.conf) + '<span class="favcost">' + esc(r.cost.main) +
          '<small> ' + esc(r.cost.sub) + '</small></span>' : '') +
        starBtn(r) +
      '</div>' +
      '<div class="row__foot"><span class="favwhen">' + esc(favWhenText(r.key)) + '</span>' +
        '<button class="linkbtn" type="button" data-detail="' + esc(r.plan.id) + '" data-tier="' + esc(r.key) + '">详情</button>' +
        '<button class="btn ' + (picked ? 'btn--ghost' : 'btn--primary') + ' btn--sm" type="button" data-pick="' + esc(r.key) + '">' +
          (picked ? '已选' : '加入对比') + '</button>' +
      '</div>' +
    '</article>';
  }

  function renderFavs() {
    var list = favRowsSorted();
    var planIds = {};
    list.forEach(function (r) { planIds[r.plan.id] = 1; });

    document.getElementById('favCount').innerHTML = '已关注 <b>' + list.length + '</b> 档 · 来自 ' +
      Object.keys(planIds).length + ' 个套餐';

    document.getElementById('favSort').innerHTML = FAV_SORTS.map(function (s) {
      return '<button class="chip' + (state.favSort === s.key ? ' is-on' : '') +
        '" type="button" data-favsort="' + s.key + '">' + esc(s.label) + '</button>';
    }).join('');

    /* 诚实留白：现在每个档位都只有 1 个快照，判定不了涨跌。
       与其画一个「暂无变动」（读起来像「没有变动」），不如直说「判断不了」。 */
    var single = ROWS.filter(function (r) { return (r.tier.price_history || []).length < 2; }).length;
    document.getElementById('favNote').innerHTML = noticeIcon('info') +
      '<span class="notice__body"><span class="notice__text">' +
      single + ' / ' + ROWS.length + ' 个档位只有 1 个价格快照，攒到 ≥2 个才判得出涨跌。' +
      '所以每条都标「<b>价格未追踪</b>」—— 是判断不了，不是没有变动。</span></span>';

    document.getElementById('favRows').innerHTML = list.map(favRowHtml).join('');
    var emptyEl = document.getElementById('favEmpty');
    emptyEl.hidden = list.length > 0;
    if (!list.length) {
      emptyEl.innerHTML = '还没有关注任何档位。<br>榜单里每张卡右上角的 ☆ 可以加进来 —— 加进来才会被追踪。';
    }
    document.getElementById('favActs').hidden = list.length === 0;
  }

  function renderFavBtn() {
    var el = document.getElementById('favBtn');
    if (!el) return;
    var n = document.getElementById('favBtnN');
    n.textContent = state.favs.length;
    n.hidden = state.favs.length === 0;
  }

  /* ══════════════════════ 9. 动态 ══════════════════════ */

  /** 事件流：只由数据推出来，没有数据就不编 */
  function events() {
    var list = [];
    D.plans.forEach(function (p) {
      var pu = CP.purchaseOf(p);
      if (pu) {
        list.push({
          kind: 'purchase', date: pu.as_of, plan: p, status: pu.status,
          badge: purchaseBadge(p, { withDate: false }),
          note: '<b>' + esc(PURCHASE_LABEL[pu.status] || pu.status) + '</b> —— ' + md(pu.note) +
                (pu.evidence === 'secondary' ? ' <span class="badge badge--muted">依据：媒体转引官方原文（二手）</span>' : ''),
          source: pu.source
        });
      }
      p.tiers.forEach(function (t) {
        var h = t.price_history || [];
        if (h.length >= 2) {
          var first = h[0], last = h[h.length - 1];
          if (last.price_cny !== first.price_cny) {
            var down = last.price_cny < first.price_cny;
            list.push({
              kind: 'price', date: last.date, plan: p, status: 'on_sale',
              badge: '<span class="badge ' + (down ? 'badge--free' : 'badge--danger') + '">' +
                     (down ? '降价' : '涨价') + ' ' + money(first.price_cny) + ' → ' + money(last.price_cny) + '</span>',
              note: '档位 <b>' + esc(t.name) + '</b> 的价格点位发生变化。', source: ''
            });
          }
        }
      });
    });
    list.push({
      kind: 'snapshot', date: D.meta.snapshot_date, status: 'on_sale',
      plan: { name: '数据集快照更新' },
      badge: '<span class="badge badge--brand">基准</span>',
      note: '本次快照共 ' + D.meta.counts.plans + ' 个套餐 / ' + D.meta.counts.tiers + ' 个档位。' +
            '价格来自各厂商公开定价页的人工转写，<b>可购买性只核实了 ' + D.plans.filter(function (p) { return CP.purchaseOf(p); }).length + ' 个套餐</b>，其余标的都是「未核实」。',
      source: ''
    });
    return list.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
  }

  function renderPulse() {
    var histPoints = 0;
    D.plans.forEach(function (p) { p.tiers.forEach(function (t) { histPoints += (t.price_history || []).length; }); });

    document.getElementById('pulseNote').innerHTML = noticeIcon('info') +
      '<span>价格变更需要 <b>同一档位 ≥2 个历史点位</b>才能判定。目前 ' + histPoints +
      ' 个点位<b>全是单点快照</b>（都是 ' + D.meta.snapshot_date + '），所以下面<b>没有降价事件</b> —— ' +
      '不是「没有降价」，是<b>还判断不了</b>。这条空白本身就是设计的一部分。</span>';

    document.getElementById('pulseBody').innerHTML = events().map(evtHtml).join('');
  }

  /* ══════════════════════ 10. 说明 ══════════════════════ */

  function renderAbout() {
    document.getElementById('aboutLedger').innerHTML = D.billing_types.map(function (b) {
      return '<div class="ledger__row"><span class="ledger__k">' + esc(b.label) + '</span>' +
        '<span class="ledger__v">' + esc(b.note) + '</span>' +
        '<span class="ledger__tag ' + (b.comparable ? 'ledger__tag--ok' : 'ledger__tag--no') + '">' +
        (b.comparable ? '可折算' : '不可比') + '</span></div>';
    }).join('');

    var total = D.meta.counts.tiers;
    var verifiedRows = ROWS.filter(function (r) { return CP.purchaseOf(r.plan); }).length;
    var verifiedPlans = D.plans.filter(function (p) { return CP.purchaseOf(p); }).length;
    var lowConf = ROWS.filter(function (r) { return r.cost && r.cost.conf === 'low'; }).length;
    var noCost = ROWS.filter(function (r) { return !r.cost; }).length;

    // 数字与说明分开传 —— 别用字符串 split 反推，那会把「每档 1 个」拆成「每档」
    document.getElementById('aboutTrust').innerHTML =
      stat('已验证可购买性', String(verifiedPlans), '其所在套餐已核实（共 ' + verifiedPlans + ' / ' + D.meta.counts.plans +
        ' 个套餐，覆盖 ' + verifiedRows + ' / ' + total + ' 个档位）；其余显式标「未核实」，不留白') +
      stat('低置信度折算', String(lowConf), '依赖估算假设，仅供排序参考') +
      stat('完全没有成本数据', String(noCost), '官网未公开额度或单位，不硬凑') +
      stat('价格历史点位', '1', '每档 1 个点位，不足 2 个无法判定涨跌');

    document.getElementById('aboutSource').innerHTML =
      '<p>数据来源：<a href="' + esc(D.meta.source.split('（')[0].trim()) + '" target="_blank" rel="noopener">' + esc(D.meta.source.split('（')[0].trim()) + '</a>' +
      '（人工整理转写，字段结构为自行设计）。基准货币 <b>' + esc(D.meta.currency) + '</b>，快照日期 <b>' + esc(D.meta.snapshot_date) + '</b>。</p>' +
      '<p><strong>换算只允许「单位换算」</strong>：页面上写明单位（例如季付价 ÷3）才能折成月费。' +
      '凡是页面上没有的数字，一律不用系数凑成一致 —— 那会把假设伪装成实测。</p>' +
      '<p>外币定价（Cursor、opencode）同时展示原币金额，人民币值是按 1:7 的<b>估算值</b>，不是官网数字。</p>' +
      '<p>本页仅做聚合对比，不参与销售。价格与优惠随时可能变动，<strong>请以厂商官网为准</strong>。</p>';

    /* 这份清单是给「下一个接手的人」看的，所以它必须和实现同步 ——
       曾经这里写着「对比态还没进 URL」，而真相更糟：readHash() 写好了却没人调用，
       启动只认不带 ?cmp= 的 hash，于是 syncHash 写出去的分享链接自己都打不开。
       现在两者都接上了（启动走 readHash，见第 16 节），这条才敢标成「已做」。
       文案比实现慢半拍，读的人会照着错的去做 —— 第 14 组测试专门守这条。 */
    document.getElementById('aboutTodo').innerHTML =
      '<p>这一版刻意留着没做的部分，写在这里而不是假装已经做完：</p>' +
      '<ul>' +
      '<li><span class="tag tag--open">未核实</span>' + (D.meta.counts.plans - verifiedPlans) + ' 个套餐的可购买性 —— 要一个一个去翻厂商的公告页</li>' +
      '<li><span class="tag tag--open">待定</span>积分 ↔ Token 的换算口径：各厂商积分定义不同，实测比例逐档递减，<b>不能线性折算</b></li>' +
      '<li><span class="tag tag--open">待定</span>讯飞 / UCloud / 小米 MiMo 渲染后是登录墙；火山方舟 / 京东云页面只有宣传语</li>' +
      '<li><span class="tag tag--open">待做</span>把 price_history 接上定时任务，攒到 ≥2 个点位后解锁降价提醒</li>' +
      '<li><span class="tag tag--done">已做</span>对比结果固化成可分享的 URL —— 地址栏形如 <code>#rank?cmp=档位A,档位B</code>，' +
        '打开就是同一屏、同一组对比（最多 4 档）</li>' +
      '<li><span class="tag tag--done">已做</span>可购买性<b>只到套餐级</b>，界面上一律标注「该套餐」；' +
        '档位级可购买性在数据里还没有，不做推测</li>' +
      '</ul>';

    function stat(label, num, note) {
      return '<div class="trust__row"><span class="trust__n">' + esc(num) + '</span>' +
        '<p><b>' + esc(label) + '</b>' + esc(note) + '</p></div>';
    }
  }

  /* ══════════════════════ 11. 详情 / 对比 / 筛选弹层 ══════════════════════ */

  function openSheet(id) {
    document.getElementById('scrim').hidden = false;
    document.getElementById(id).hidden = false;
    document.getElementById(id).querySelector('.sheet__body').scrollTop = 0;
  }
  function closeSheets() {
    document.getElementById('scrim').hidden = true;
    ['detailSheet', 'compareSheet', 'filterSheet'].forEach(function (id) { document.getElementById(id).hidden = true; });
  }

  function renderDetail(planId, tierId) {
    var plan = D.plans.filter(function (p) { return p.id === planId; })[0];
    if (!plan) return;
    var vendor = VENDOR[plan.vendor_id] || { name: plan.vendor_id, color: '#8b91a8', logo_text: '?' };
    var pu = CP.purchaseOf(plan);
    // 进来时带的是哪个档位，价格追踪就讲哪个档位 —— 不带就退回第一档并如实标注
    var curTier = (tierId && plan.tiers.filter(function (t) { return t.id === tierId; })[0]) || plan.tiers[0];

    document.getElementById('detailTitle').textContent = plan.name;

    var html = '' +
      '<div class="dhead">' + vlogo(vendor, 46) +
        '<div class="dhead__main">' +
          '<div class="dhead__vendor">' + esc(vendor.name) + ' · ' +
            '<a href="' + esc(vendor.official_url) + '" target="_blank" rel="noopener" style="color:var(--brand)">官网 ↗</a></div>' +
          '<div class="dhead__name">' + esc(plan.name) + '</div>' +
          '<p class="dhead__sub">' + md(plan.positioning || '') + '</p>' +
        '</div>' +
      '</div>' +

      /* 可购买性排在价格之前 —— 买不到的话价格无从谈起。
         这一页讲的就是整个套餐，所以不用「该套餐」后缀，而是把作用域写进标题。 */
      '<section class="dsec"><h3>可购买性 · 套餐级</h3>' +
        '<p class="scope-note">本状态针对<b>整个套餐</b>，不区分档位 —— 数据集目前没有档位级可购买性字段。</p>' +
        '<div class="dkv">' +
          kv('状态', purchaseBadge(plan, { withDate: false }) + ' ' + (pu ? esc(PURCHASE_DESC[pu.status] || '') : '<small>没有任何核实记录 —— 未核实不代表在售</small>')) +
          (pu ? kv('核实日期', '<code>' + esc(pu.as_of) + '</code> <small>' + (pu.evidence === 'secondary' ? '（二手依据）' : '（一手依据）') + '</small>') : '') +
          (pu ? kv('依据说明', md(pu.note)) : '') +
          (pu ? kv('出处', '<a href="' + esc(pu.source) + '" target="_blank" rel="noopener">' + esc(pu.source) + '</a>') : '') +
          kv('购买入口', '<a href="' + esc(plan.buy_url) + '" target="_blank" rel="noopener">' + esc(plan.buy_url) + '</a>') +
        '</div></section>' +

      '<section class="dsec"><h3>档位与定价</h3><div class="dtiers">' +
        plan.tiers.map(function (t) {
          var picked = state.picked.indexOf(t.id) >= 0;
          return '<div class="dtier' + (picked ? ' is-picked' : '') + '">' +
            '<div class="dtier__n"><b>' + esc(t.name) + '</b>' +
              '<span>' + esc(t.quota && t.quota.raw ? t.quota.raw : '额度未公布') + ' · ' + esc(t.use_case || '未标注场景') + '</span>' +
              (t.price_note ? '<span>' + esc(t.price_note) + '</span>' : '') +
            '</div>' +
            '<div class="dtier__p"><b>' + (t.price_cny === 0 ? '免费' : money(t.price_cny)) + '</b>' +
              '<span>' + (isForeign(t) ? '≈（原价 ' + esc(t.price_foreign) + ' ' + esc(t.price_currency) + '）' : (t.price_list_cny && t.price_list_cny !== t.price_cny ? '标价 ' + money(t.price_list_cny) : '每月')) + '</span></div>' +
            '<button class="btn ' + (picked ? 'btn--ghost' : 'btn--primary') + ' btn--sm" type="button" data-pick="' + esc(t.id) + '">' + (picked ? '已选' : '选') + '</button>' +
          '</div>';
        }).join('') + '</div></section>' +

      '<section class="dsec"><h3>折算口径</h3><div class="dkv">' +
        plan.tiers.map(function (t) { return tierDerivedRow(t, plan); }).join('') +
      '</div></section>' +

      '<section class="dsec"><h3>生态</h3><div class="dkv">' +
        ecoRow(plan.models, '可调用模型') + ecoRow(plan.tools, '兼容工具') +
        kv('Agent 并发', plan.tiers.map(function (t) {
          return t.agent_concurrency ? t.name + ' ' + t.agent_concurrency.min + '~' + t.agent_concurrency.max : null;
        }).filter(Boolean).join('，') || '<small>官网未公布</small>') +
        kv('上下文窗口', (function () {
          var v = plan.tiers.filter(function (t) { return t.context_window; })[0];
          return v ? human(v.context_window) + ' Token' : '<small>官网未公布</small>';
        })()) +
      '</div></section>' +

      '<section class="dsec"><h3>价格历史</h3>' + priceHistorySection(plan, curTier) + '</section>';

    document.getElementById('detailBody').innerHTML = html;

    function kv(k, v) {
      return '<div class="dkv__r"><span class="dkv__k">' + esc(k) + '</span><span class="dkv__v">' + v + '</span></div>';
    }
  }

  function tierDerivedRow(t, plan) {
    var d = t.derived;
    if (!d) return '';
    var uc = unitCostOf(t, plan);
    return '<div class="dkv__r"><span class="dkv__k">' + esc(t.name) + '</span><span class="dkv__v">' +
      (uc ? uc.main + ' <small>' + esc(uc.sub) + '</small>' : '<small>无成本数据</small>') +
      (d.est_tokens_month != null ? ' · 折算月额 ' + human(d.est_tokens_month) + ' Token' : '') +
      (d.quota_month != null && d.est_tokens_month == null ? ' · 月额度 ' + human(d.quota_month) : '') +
      ' ' + conf(d.confidence) +
      (uc && !uc.cross ? ' <span class="badge badge--muted">不可跨口径比较</span>' : '') +
      '</span></div>';
  }

  function ecoRow(obj, label) {
    if (!obj) return '<div class="dkv__r"><span class="dkv__k">' + label + '</span><span class="dkv__v"><small>官网未公布</small></span></div>';
    var listed = (obj.listed || []).join('、');
    return '<div class="dkv__r"><span class="dkv__k">' + label + '</span><span class="dkv__v">' +
      (obj.count != null ? obj.count + ' 个' : '<small>总数未公布</small>') +
      (listed ? '<br><small>' + esc(listed) + (obj.partial ? '（列表不完整）' : '') + '</small>' : '') +
      '</span></div>';
  }

  /** 价格历史区块：明确写清楚「这张图讲哪几档」，并提供单档 / 全部档位的切换 */
  function priceHistorySection(plan, tier) {
    var many = plan.tiers.length > 1;
    var all = state.detailAllTiers || !many;
    return '' +
      '<div class="spark__scope">' +
        '<span class="spark__label">价格追踪 · <b>' + esc(all ? '全部 ' + plan.tiers.length + ' 档' : tier.name) + '</b></span>' +
        (many ? '<button class="chip' + (all ? ' is-on' : '') + '" type="button" data-spark="1">' +
          (all ? '只看当前档' : '看全部档位') + '</button>' : '') +
      '</div>' +
      sparkline(plan, all ? null : tier) +
      '<p class="prose">涨跌判定需要同一档位<b>至少 2 个不同日期</b>的快照；' +
      '把不同档位的价格画成一条曲线，等于把「档位不同」伪装成「价格波动」。</p>';
  }

  /**
   * 价格历史：只有一个点位时明确写「单点」，不画假的走势。
   * scope === null 表示「全部档位」；传了 tier 就只看这一档 ——
   * 混着画会把不同档位的价位当成同一条曲线的涨跌，那是把结构差异伪装成价格波动。
   */
  function sparkline(plan, scope) {
    var src = scope ? [scope] : plan.tiers;
    var pts = [];
    src.forEach(function (t) {
      (t.price_history || []).forEach(function (h) { pts.push({ date: h.date, price: h.price_cny, tier: t.name }); });
    });
    if (!pts.length) return '<p class="prose">没有价格历史记录。</p>';

    var dates = pts.map(function (p) { return p.date; }).sort();
    var uniq = dates.filter(function (d, i) { return dates.indexOf(d) === i; });

    if (uniq.length < 2) {
      return '<p class="prose">' + (scope ? '「' + esc(scope.name) + '」' : '整个套餐') + '只有 <b>' + uniq.length + ' 个</b>价格点位（' + esc(uniq[0]) +
        '，共 ' + pts.length + ' 条记录）。<b>不足以画出走势，也不足以判定涨跌</b> —— 需要至少 2 个不同日期的快照。' +
        '在此之前，本页不会给你一条看起来很像那么回事的曲线。</p>';
    }

    var min = Math.min.apply(null, pts.map(function (p) { return p.price; }));
    var max = Math.max.apply(null, pts.map(function (p) { return p.price; }));
    var span = (max - min) || 1;
    var W = 320, H = 44, x = function (i) { return 4 + i * (W - 8) / Math.max(1, pts.length - 1); };
    var y = function (v) { return H - 6 - (v - min) / span * (H - 14); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.price).toFixed(1); }).join(' ');
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="价格走势">' +
      '<path class="spark__area" d="' + line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + H + ' L' + x(0).toFixed(1) + ' ' + H + ' Z"/>' +
      '<path class="spark__line" d="' + line + '"/>' +
      pts.map(function (p, i) { return '<circle class="spark__dot" cx="' + x(i).toFixed(1) + '" cy="' + y(p.price).toFixed(1) + '" r="2.6"/>'; }).join('') +
      '</svg>';
  }

  function renderCompare() {
    var items = state.picked.map(function (id) {
      return ROWS.filter(function (r) { return r.key === id; })[0];
    }).filter(Boolean);
    if (!items.length) return;

    var n = items.length;
    var rows = [
      ['厂商', function (r) { return esc(r.vendor.name); }],
      ['套餐', function (r) { return '<span class="ctable__plan">' + esc(r.plan.name) + '<small>' + esc(r.tier.name) + '</small></span>'; }],
      ['月费', function (r) { return '<b>' + (r.tier.price_cny === 0 ? '免费' : money(r.tier.price_cny)) + '</b>'; }, 'min-price'],
      ['计费口径', function (r) { return esc(r.billingLabel); }],
      ['额度', function (r) { return esc((r.tier.quota && r.tier.quota.raw) || '未公布'); }],
      ['折算月额', function (r) {
        var d = r.tier.derived;
        if (!d) return '—';
        return d.est_tokens_month != null ? human(d.est_tokens_month) + ' Token' : (d.quota_month != null ? human(d.quota_month) : '—');
      }],
      ['单位成本', function (r) { return r.cost ? r.cost.main + ' <small>' + esc(r.cost.sub) + '</small>' : '—'; }, 'min-cost'],
      ['可跨口径比较', function (r) { return r.cost && r.cost.cross ? '<span class="ctable__best">是</span>' : '否'; }],
      ['可购买性（套餐级）', function (r) { return purchaseBadge(r.plan, { scopeTag: true }); }],
      ['可调用模型', function (r) { return r.ecoModels == null ? '未公布' : r.ecoModels + ' 个'; }, 'max-eco'],
      ['兼容工具', function (r) { return r.ecoTools == null ? '未公布' : r.ecoTools + ' 个'; }, 'max-tools'],
      ['场景', function (r) { return esc(r.useCaseLabel || '—'); }],
      ['置信度', function (r) { return (r.cost && r.cost.conf) ? { high: '高', medium: '中', low: '低' }[r.cost.conf] : '—'; }],
      ['购买', function (r) { return '<a href="' + esc(r.plan.buy_url) + '" target="_blank" rel="noopener" style="color:var(--brand)">去官网 ↗</a>'; }]
    ];

    var html = '<div class="ctable" style="--cols:' + n + '">';
    html += '<div class="ctable__row ctable__head"><span class="ctable__k"></span>' +
      items.map(function (r) { return '<span>' + vlogo(r.vendor, 22) + ' <b style="font-size:11.5px">' + esc(r.tier.name) + '</b></span>'; }).join('') + '</div>';

    rows.forEach(function (row) {
      var key = row[2];
      var cells = items.map(function (r) { return row[1](r); });
      var bestIdx = -1;
      if (key) {
        var vals = items.map(function (r) {
          if (key === 'min-price') return r.price;
          if (key === 'min-cost') return r.cost && r.cost.cross ? r.cost.value : null;
          if (key === 'max-eco') return r.ecoModels;
          if (key === 'max-tools') return r.ecoTools;
          return null;
        });
        var nums = vals.filter(function (v) { return v != null; });
        if (nums.length > 1) {
          var target = key.indexOf('min') === 0 ? Math.min.apply(null, nums) : Math.max.apply(null, nums);
          bestIdx = vals.indexOf(target);
        }
      }
      html += '<div class="ctable__row"><span class="ctable__k">' + esc(row[0]) + '</span>' +
        cells.map(function (c, i) { return '<span class="' + (i === bestIdx ? 'is-hi ctable__best' : '') + '">' + c + '</span>'; }).join('') +
        '</div>';
    });
    html += '</div>';

    var pickable = items.filter(function (r) { return r.cost && r.cost.cross; });
    if (pickable.length > 1) {
      var cheapest = pickable.slice().sort(function (a, b) { return a.cost.value - b.cost.value; })[0];
      html += '<p class="prose" style="margin-top:16px">按可跨口径比较的 ' + pickable.length + ' 个档位算，' +
        '<b>' + esc(cheapest.plan.name + ' · ' + cheapest.tier.name) + '</b> 的单位成本最低（' + esc(cheapest.cost.main) + '）。' +
        '但单位成本低只说明<b>每百万 Token 更便宜</b>，不代表它够你用 —— 额度不够时你买的是「便宜的量」。</p>';
    } else {
      html += '<p class="prose" style="margin-top:16px">所选档位中不足 2 个可跨口径比较，' +
        '<b>不做「谁更便宜」的结论</b> —— 计费口径不同，硬比会把读者带偏。</p>';
    }

    document.getElementById('compareBody').innerHTML = html;
  }

  function renderFilterSheet() {
    document.getElementById('filterBody').innerHTML = '' +
      '<section class="dsec"><h3>月费上限</h3>' +
        '<div class="chips">' +
          [['不限', null], ['≤ ¥50', 50], ['≤ ¥150', 150], ['≤ ¥400', 400]].map(function (o) {
            return '<button class="chip' + (state.priceMax === o[1] ? ' is-on' : '') + '" type="button" data-pmax="' + (o[1] == null ? 'none' : o[1]) + '">' + esc(o[0]) + '</button>';
          }).join('') +
        '</div></section>' +
      '<section class="dsec"><h3>其他</h3>' +
        '<div class="chips">' +
          '<button class="chip' + (state.freeOnly ? ' is-on' : '') + '" type="button" data-free="1">只看有免费档</button>' +
          '<button class="chip" type="button" data-reset="1">清空全部筛选</button>' +
        '</div></section>' +
      '<p class="prose">可购买性不提供<b>筛选</b>开关 —— 让「买不到」的档位可以被筛掉，等于鼓励用户假装它们不存在。' +
      '榜单上的「优先展示在售」只做<b>重排</b>：它们下沉到列表末尾的折叠区，一个都不少，计数也对得上。' +
      '想让它们消失，得先去核实它们到底还能不能买。</p>';
  }

  /* ══════════════════════ 12. 对比条 ══════════════════════ */

  function renderCmpBar() {
    var bar = document.getElementById('cmpBar');
    if (!state.picked.length) { bar.hidden = true; return; }
    bar.hidden = false;
    var rail = state.picked.map(function (id) {
      var r = ROWS.filter(function (x) { return x.key === id; })[0];
      if (!r) return '';
      return '<span class="cmpbar__item">' + esc(r.vendor.short || r.vendor.name) + ' · ' + esc(r.tier.name) +
        '<button type="button" data-pick="' + esc(id) + '" aria-label="移除">&times;</button></span>';
    }).join('');
    for (var i = state.picked.length; i < 4; i++) rail += '<span class="cmpbar__slot">+</span>';
    document.getElementById('cmpRail').innerHTML = rail;
    document.getElementById('cmpGo').textContent = '对比 ' + state.picked.length;
  }

  function togglePick(key) {
    var i = state.picked.indexOf(key);
    if (i >= 0) state.picked.splice(i, 1);
    else {
      if (state.picked.length >= 4) { toast('最多同时对比 4 个档位 —— 再多在手机上看不清。'); return; }
      state.picked.push(key);
    }
    save();
    syncHash();
    renderRank();
    renderTabbar();
    if (window.__currentDetailPlan) renderDetail(window.__currentDetailPlan, window.__currentDetailTier);
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:absolute;left:50%;bottom:calc(var(--tab-h) + 74px);transform:translateX(-50%);z-index:200;' +
        'width:max-content;max-width:78%;padding:10px 14px;border-radius:12px;background:rgba(15,13,40,.94);color:#fff;' +
        'font-size:12px;line-height:1.6;text-align:center;box-shadow:0 12px 30px rgba(0,0,0,.3);transition:opacity .25s;pointer-events:none';
      document.getElementById('app').appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = '0'; }, 2200);
  }

  /* ══════════════════════ 13. 导航 ══════════════════════ */

  var TABS = [
    { key: 'home', label: '首页', icon: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
    { key: 'rank', label: '比价', icon: 'M4 19h16M4 5v14M8 16V9M12 16V6M16 16v-5' },
    { key: 'wizard', label: '选型', icon: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8.5 15.5 12 12 15.5 8.5 12z', hero: true },
    { key: 'pulse', label: '动态', icon: 'M3 12h4l3-7 4 14 3-7h4' },
    { key: 'about', label: '说明', icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5M12 8h.01' }
  ];
  // 关注是第 6 个「屏」，但**不是第 6 个 tab**：390px 下 6 个图标必然挤，
  // 而「动态」是整套诚实叙事的载体、不能砍。所以它走首页入口 + 顶栏入口。
  var TITLES = { home: '', rank: '比价榜', wizard: '选型向导', pulse: '变更动态', about: '口径说明', favs: '我的关注' };

  function renderTabbar() {
    document.getElementById('tabbar').innerHTML = TABS.map(function (t) {
      return '<button type="button" class="' + (t.hero ? 'tabbar__go ' : '') + (state.screen === t.key ? 'is-active' : '') +
        '" data-go="' + t.key + '" role="tab" aria-selected="' + (state.screen === t.key) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="' + t.icon + '"/></svg><span>' + t.label + '</span></button>';
    }).join('');
  }

  /* ── 地址栏 ↔ 状态 ──────────────────────────────────────────────
     形如 #rank?cmp=tier-a,tier-b —— 屏幕和对比选择都进 hash，
     于是「分享一组对比」是一个真链接，打开就是同一屏、同一组对比。
     只放对比，不放搜索/筛选：筛选是「我这次怎么翻」，对比是「我想给人看什么」。
     分隔符用逗号而不是 +：tierId 里本来就有连字符，+ 还得转义，不值。 */
  var HASH_RE = /^([a-z]+)(?:\?cmp=([^&]*))?$/;

  function readHash() {
    var m = HASH_RE.exec(String(location.hash || '').replace(/^#/, ''));
    if (!m) return { screen: null, cmp: null };
    return {
      screen: TITLES.hasOwnProperty(m[1]) ? m[1] : null,
      cmp: m[2] ? decodeURIComponent(m[2]).split(',').filter(Boolean) : null
    };
  }
  function validKeys(ids) {
    return (ids || []).filter(function (id) {
      return ROWS.some(function (r) { return r.key === id; });
    }).slice(0, 4);
  }
  function syncHash(screen) {
    try {
      var next = '#' + (screen || state.screen) + (state.picked.length ? '?cmp=' + state.picked.join(',') : '');
      if (String(location.hash || '') !== next) history.replaceState(null, '', next);
    } catch (e) { /* file:// 下可能受限，忽略 */ }
  }

  function go(screen, silent) {
    if (!TITLES.hasOwnProperty(screen)) return;
    state.screen = screen;
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('is-active', s.dataset.screen === screen);
    });
    document.getElementById('appbarLead').hidden = screen !== 'home';
    var title = document.getElementById('appbarTitle');
    title.hidden = screen === 'home';
    title.textContent = TITLES[screen];
    document.getElementById('searchBtn').hidden = screen !== 'rank';
    // 顶栏的关注入口只在「没有其他入口」的屏幕上出现：
    // 首页有「我的关注」区块，榜单的搜索框旁再塞一个会挤 —— 位置不重复才叫入口。
    document.getElementById('favBtn').hidden = (screen === 'rank' || screen === 'home');
    renderFavBtn();
    document.getElementById('appBody').scrollTop = 0;
    renderTabbar();
    renderSpecNav();
    if (screen === 'rank') renderRank();
    if (screen === 'wizard') renderWizard();
    if (screen === 'pulse') renderPulse();
    if (screen === 'about') renderAbout();
    if (screen === 'favs') renderFavs();
    if (screen === 'home') renderHome();
    // 地址栏同步 —— 既是分享链接，也让每个屏幕可以被直接打开（截图/联调都用得上）
    if (!silent) syncHash(screen);
  }

  /* ══════════════════════ 14. 设计说明栏 ══════════════════════ */

  var SPEC_RULES = [
    ['未核实 ≠ 在售', '任何缺失的维度都显式写「未核实」，绝不留白。留白会被读成「没限制、可以买」—— 这是本数据集里最贵的一个错误。'],
    ['买不到优先于价格', '详情页「可购买性」排在「档位与定价」之前；涨价会被采集器抓到，停售不会。'],
    ['起售价低 ≠ 性价比高', '默认按单位成本排序。不同计费口径的单位成本不并排排名 —— 积分制没有公开换算比例，硬比就是编。']
  ];
  var SPEC_CHOICES = [
    ['用列表而不是表格', '390px 宽度下表格必然横向滚动，而横向滚动等于看不见。每条档位是一张可点的卡。'],
    ['对比最多 4 档', '超过 4 列在手机上每列只剩 70px —— 与其做一个看不清的对比，不如设上限并给出提示。'],
    ['没有降价提醒', '价格历史目前每档只有 1 个点位，判定不了涨跌。这一版选择留出「动态」页并说明为什么它是空的。'],
    ['可购买性只「优先展示」，不做筛选', '让「买不到」可以被筛掉，等于鼓励用户假装它们不存在。它们下沉到末尾的折叠区，一个都不少、计数也对得上 —— 行数守恒就是它不是过滤器的证明。'],
    ['套餐级结论一律标「该套餐」', '数据集里没有档位级可购买性。不标作用域，等于把套餐级结论冒充成档位级结论。'],
    ['厂商色做头像，不用 logo 图片', '省掉一堆版权不明、尺寸不一的图，且深浅色下都清晰。'],
    ['搜索历史与清单都留在本地', '没有账号，也没有后端 —— 换来的是「你的搜索记录和关注列表不上传到任何地方」。']
  ];

  function renderSpecNav() {
    var host = document.getElementById('specScreens');
    if (!host) return;
    host.innerHTML = TABS.map(function (t, i) {
      return '<li><button type="button" class="' + (state.screen === t.key ? 'is-active' : '') + '" data-go="' + t.key + '">' +
        '<b>0' + (i + 1) + '</b><span>' + t.label + '</span></button></li>';
    }).join('');
  }

  function initSpec() {
    renderSpecNav();
    var rules = document.getElementById('specRules');
    var choices = document.getElementById('specChoices');
    if (rules) rules.innerHTML = SPEC_RULES.map(function (r) {
      return '<li><b>' + esc(r[0]) + '</b>' + esc(r[1]) + '</li>';
    }).join('');
    if (choices) choices.innerHTML = SPEC_CHOICES.map(function (c) {
      return '<li><b>' + esc(c[0]) + '</b> —— ' + esc(c[1]) + '</li>';
    }).join('');
    var meta = document.getElementById('specMeta');
    if (meta) meta.textContent = 'schema ' + D.meta.schema_version + ' · snapshot ' + D.meta.snapshot_date +
      ' · ' + D.meta.counts.vendors + ' vendors / ' + D.meta.counts.plans + ' plans / ' + D.meta.counts.tiers + ' tiers';
  }

  /* ══════════════════════ 15. 事件绑定 ══════════════════════ */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-go],[data-pick],[data-detail],[data-tier],[data-spark],[data-billing],[data-usecase],[data-fav],' +
      '[data-wz],[data-wznext],[data-wzback],[data-wzto],[data-wzreset],[data-pmax],[data-free],[data-reset],[data-close],[data-more],' +
      '[data-salefirst],[data-degrade],[data-hot],[data-hist],[data-histclear],[data-emptyq],[data-emptybill],' +
      '[data-favsort],[data-favcmp]');
    if (!t) return;

    if (t.hasAttribute('data-more')) {
      var note = t.previousElementSibling;
      var clamped = note.classList.toggle('is-clamped');
      t.textContent = clamped ? (t.getAttribute('data-more-shut') || '展开全文') : (t.getAttribute('data-more-open') || '收起');
      return;
    }

    if (t.hasAttribute('data-go')) { closeSheets(); go(t.getAttribute('data-go')); return; }
    if (t.hasAttribute('data-close')) { closeSheets(); return; }
    if (t.hasAttribute('data-pick')) { togglePick(t.getAttribute('data-pick')); return; }
    if (t.hasAttribute('data-fav')) { toggleFav(t.getAttribute('data-fav')); return; }
    if (t.hasAttribute('data-detail')) {
      window.__currentDetailPlan = t.getAttribute('data-detail');
      window.__currentDetailTier = t.getAttribute('data-tier') || null;
      closeSheets(); renderDetail(window.__currentDetailPlan, window.__currentDetailTier); openSheet('detailSheet'); return;
    }
    if (t.hasAttribute('data-spark')) {
      state.detailAllTiers = !state.detailAllTiers;
      renderDetail(window.__currentDetailPlan, window.__currentDetailTier); return;
    }
    if (t.hasAttribute('data-salefirst')) {
      state.saleFirst = !state.saleFirst; save(); renderRank(); return;
    }
    if (t.hasAttribute('data-degrade')) {
      state.degradeOpen = !state.degradeOpen; renderRank(); return;
    }
    if (t.hasAttribute('data-hot')) { applyQuery(t.getAttribute('data-hot')); return; }
    if (t.hasAttribute('data-hist')) { applyQuery(t.getAttribute('data-hist')); return; }
    if (t.hasAttribute('data-histclear')) {
      state.history = []; save(); renderSearchPane(); return;
    }
    if (t.hasAttribute('data-emptyq')) { applyQuery(''); return; }
    if (t.hasAttribute('data-emptybill')) {
      state.billings = {}; renderChips(); renderRank(); return;
    }
    if (t.hasAttribute('data-favsort')) {
      state.favSort = t.getAttribute('data-favsort'); save(); renderFavs(); return;
    }
    /* 批量加入对比：超出 4 档时明确提示，不静默截断 ——
       静默截断会让用户以为 6 档都进去了，然后对着 4 列找不到的那两档。 */
    if (t.hasAttribute('data-favcmp')) {
      var list = favRowsSorted().slice(0, 4);
      var added = 0;
      list.forEach(function (r) {
        if (state.picked.indexOf(r.key) < 0 && state.picked.length < 4) { state.picked.push(r.key); added++; }
      });
      if (added < list.length) toast('最多同时对比 4 个档位 —— 只加入了前 ' + added + ' 档。');
      else toast('已加入 ' + added + ' 档，去底部「对比」查看');
      save(); syncHash(); renderFavs(); renderCmpBar(); renderTabbar(); return;
    }

    if (t.hasAttribute('data-billing')) {
      var b = t.getAttribute('data-billing');
      if (b === '__all') state.billings = {};
      else { state.billings = {}; state.billings[b] = true; }
      renderChips(); renderRank(); return;
    }
    if (t.hasAttribute('data-usecase')) {
      var u = t.getAttribute('data-usecase');
      if (u === '__all') state.useCases = {};
      else { state.useCases = {}; state.useCases[u] = true; }
      renderChips(); renderRank(); return;
    }

    /* 向导：选项 —— 记住 key 与展示文案 */
    if (t.hasAttribute('data-wz')) {
      var key = t.getAttribute('data-wz');
      var step = state.wizard.step;
      if (step === 0) state.wizard.answers.level = Q_LEVEL.filter(function (o) { return o.key === key; })[0];
      if (step === 1) state.wizard.answers.tool = toolOptions().filter(function (o) { return o.key === key; })[0];
      if (step === 2) state.wizard.answers.budget = Q_BUDGET.filter(function (o) { return o.key === key; })[0];
      save(); renderWizard(); return;
    }
    if (t.hasAttribute('data-wznext')) {
      if (state.wizard.step < 2) state.wizard.step++; else state.wizard.step = 3;
      save(); renderWizard(); return;
    }
    if (t.hasAttribute('data-wzback')) { state.wizard.step = Math.max(0, state.wizard.step - 1); save(); renderWizard(); return; }
    if (t.hasAttribute('data-wzto')) { state.wizard.step = parseInt(t.getAttribute('data-wzto'), 10); save(); renderWizard(); return; }
    if (t.hasAttribute('data-wzreset')) {
      state.wizard = { step: 0, answers: {} }; save(); renderWizard(); return;
    }

    if (t.hasAttribute('data-pmax')) {
      var v = t.getAttribute('data-pmax');
      state.priceMax = v === 'none' ? null : parseInt(v, 10);
      renderFilterSheet(); renderRank(); return;
    }
    if (t.hasAttribute('data-free')) { state.freeOnly = !state.freeOnly; renderFilterSheet(); renderRank(); return; }
    if (t.hasAttribute('data-reset')) {
      state.billings = {}; state.useCases = {}; state.priceMax = null; state.freeOnly = false; state.q = '';
      document.getElementById('q').value = '';
      document.getElementById('qClear').hidden = true;
      renderChips(); renderFilterSheet(); renderRank(); return;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') {
      state.q = e.target.value;
      document.getElementById('qClear').hidden = !state.q;
      // 一开始打字就让位给结果；清空后又把建议面板还回来
      state.searchOpen = !state.q;
      renderSearchPane();
      renderRank();
    }
  });
  document.getElementById('q').addEventListener('focus', function () {
    state.searchOpen = true; renderSearchPane();
  });
  // 回车才算一次「搜索」，进历史 —— 边打字边记会把 "G" "GL" "GLM" 全记进去
  document.getElementById('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && state.q.trim()) {
      pushHistory(state.q.trim());
      state.searchOpen = false; renderSearchPane();
    }
  });
  document.getElementById('qClear').addEventListener('click', function () {
    state.q = ''; document.getElementById('q').value = ''; this.hidden = true;
    state.searchOpen = true; renderSearchPane(); renderRank();
  });
  document.getElementById('sort').addEventListener('change', function () {
    state.sort = this.value; save(); renderRank();
  });
  document.getElementById('filterBtn').addEventListener('click', function () {
    renderFilterSheet(); openSheet('filterSheet');
  });
  document.getElementById('cmpGo').addEventListener('click', function () {
    if (!state.picked.length) return;
    renderCompare(); openSheet('compareSheet');
  });
  document.getElementById('scrim').addEventListener('click', closeSheets);
  document.getElementById('themeBtn').addEventListener('click', function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(); save();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheets(); });

  /* ══════════════════════ 16. 启动 ══════════════════════ */

  load();
  applyTheme();
  document.getElementById('sort').value = state.sort;
  initSpec();
  renderChips();
  renderHome();
  renderTabbar();
  renderCmpBar();
  renderFavBtn();
  /* 支持 #rank?cmp=档位A,档位B 这类直达/分享链接。
     曾经这里写成 TITLES.hasOwnProperty(location.hash)，而 hash 里带 ?cmp= 就永远匹配不上；
     readHash() 明明写好了却没人调用 —— 于是 syncHash 写出去的链接自己都打不开。
     教训：**解析函数和写入函数必须成对出现在同一条路径上**，否则写出去的是个死链。 */
  var h = readHash();
  if (h.screen) {
    state.screen = h.screen;
    if (h.cmp) state.picked = validKeys(h.cmp);   // 分享意图优先于本地上次的选择
  }
  go(state.screen, true);
  renderCmpBar();

})();
