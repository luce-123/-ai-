/* ==========================================================================
   CodePlan 共享层 —— 桌面版（js/app.js）与移动版（app/app.js）共用
   挂在 window.__CP__ 上。

   边界（改动前请先读）：
     这里只放**纯函数与标签表**：不碰 DOM、不读 window.__PLANS__、不产生布局。
     凡是「长什么样」的部分（圆点还是文字、SVG 还是 div）留在各自的 UI 层，
     两套界面有意不同，硬合成一个反而会让两边都别扭。

   为什么必须抽这一层：
     可购买性与单位成本的判定是**对数据口径的解释**，不是界面。
     两套界面各自抄一份，就会像 PURCHASE_LABEL 那样悄悄分化
     （桌面写「需登录购买」、移动写「需登录」）—— 同一个状态两种说法，
     而读者会以为它们是两个不同的状态。这类分歧只能靠共用一份代码消除。

   零依赖、无构建：本文件必须能被 <script src> 直接加载，file:// 双击可开。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- 字符串工具 ---------------------------- */

  /**
   * HTML 转义。转义单引号是必要的：本项目的文案里大量出现中英文混排，
   * 一旦某段文本被拼进用单引号包裹的属性值，漏掉 `'` 就是一个注入点。
   */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 数据集里的 purchase.note / positioning 用 Markdown 的 ** 做强调。
   * 先转义、再还原 ** —— 只认这一种行内语法，不做完整 Markdown：
   * 少一个解析器就少一个被注入的地方。
   */
  function md(s) {
    return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  /**
   * 搜索命中高亮。
   * 顺序是硬要求：**先按命中切段，再逐段转义**。
   * 反过来（先转义再替换）时，查询词 "lt" 会插进 &lt; 中间把实体拆坏；
   * 而先替换再转义又会把 <mark> 一起转义掉。用户的输入只作切分依据，永不进 HTML。
   */
  function hl(s, q) {
    var raw = s == null ? '' : String(s);
    var key = (q || '').trim();
    if (!key) return esc(raw);
    var re = new RegExp('(' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return raw.split(re).map(function (p, i) {
      return i % 2 ? '<mark class="hl">' + esc(p) + '</mark>' : esc(p);
    }).join('');
  }

  /* ---------------------------- 置信度 ---------------------------- */

  /* 只共享「说什么」，不共享「怎么画」：
     桌面端是一个带 title 的小圆点，移动端是「高/中/低置信」的文字徽章。
     同一个语义两种呈现都是对的 —— 桌面有 hover，移动端没有。 */
  var CONF_TITLE = {
    high: '厂商直接公开 Token 数',
    medium: '按厂商公布的倍率关系折算',
    low: '依赖估算假设，仅供排序参考'
  };
  var CONF_SHORT = { high: '高置信', medium: '中置信', low: '低置信' };
  function confTitle(c) { return CONF_TITLE[c] || ''; }
  function confShort(c) { return CONF_SHORT[c] || ''; }

  /* ---------------------------- 可购买性 ---------------------------- */

  /**
   * 五个状态。**缺失不在其中** —— 缺失是第六种情况，叫「未核实」，
   * 绝不能落到 on_sale 里：未核实 ≠ 在售，这是本项目最贵的一条规矩。
   */
  var PURCHASE_LABEL = {
    on_sale: '在售',
    limited: '限量抢购',
    closed_new: '停止新购',
    login_only: '需登录购买',
    unverifiable: '无法核实'
  };
  var PURCHASE_DESC = {
    on_sale: '当前可以新购',
    limited: '限量抢购，售罄不补',
    closed_new: '停止接受新购订单（存量用户不受影响）',
    login_only: '价格在登录后才可见',
    unverifiable: '查了但查不到 —— 与「还没查」不是一回事'
  };

  /** 唯一允许读 purchase 的入口。返回 null 表示「本库还没核实」。 */
  function purchaseOf(plan) {
    var pu = plan && plan.purchase;
    if (!pu || !pu.status || !PURCHASE_LABEL[pu.status]) return null;
    return pu;
  }
  /** 状态字符串；未核实时返回 'missing'（一个刻意不在 PURCHASE_LABEL 里的值）。 */
  function purchaseStatus(plan) {
    var pu = purchaseOf(plan);
    return pu ? pu.status : 'missing';
  }
  function isBuyable(plan) {
    var s = purchaseStatus(plan);
    return s === 'on_sale' || s === 'limited';
  }
  function isClosed(plan) {
    var s = purchaseStatus(plan);
    return s === 'closed_new' || s === 'login_only';
  }
  function isUnverified(plan) {
    return purchaseStatus(plan) === 'missing';
  }

  /**
   * 排序权重：能买的在前，买不到的在后，**未核实夹在中间**。
   * 未核实绝不能与在售同权重 —— 那等于把没查过的当成能买的。
   */
  function purchaseRank(plan) {
    var s = purchaseStatus(plan);
    if (s === 'on_sale') return 0;
    if (s === 'limited') return 1;
    if (s === 'missing') return 2;
    if (s === 'unverifiable') return 3;
    return 4;   // closed_new / login_only
  }

  /* ---------------------------- 归一化单位成本 ---------------------------- */

  // 积分类额度量级差异极大（小米 41 亿 / 智谱 4 万），按量级自适应单位
  function scaleFor(v) {
    if (v >= 1e8) return { div: 1e8, label: '亿' };
    if (v >= 1e4) return { div: 1e4, label: '万' };
    return { div: 1, label: '' };
  }

  /**
   * token / requests 能折到「¥/百万 Token」，可跨厂商比（cross=true）。
   * credits / agent_quota / subscription 没有公开换算比例 —— 只能给自身单位下的成本，
   * cross=false，界面上必须写清「不可跨口径比较」，不能混进同一个榜单骗人。
   *
   * unitLabel 由调用方传入（各口径的 unit_label 写在数据集的 billing_types 里），
   * 共享层不认识具体口径，也就不会因为漏配一个口径而显示成 undefined。
   */
  function unitCost(tier, plan, unitLabel) {
    var d = tier && tier.derived;
    if (!d) return null;
    var k = plan.billing_type;

    if ((k === 'token' || k === 'requests') && d.cost_per_1m_tokens_est != null) {
      return {
        value: d.cost_per_1m_tokens_est,
        main: '¥' + d.cost_per_1m_tokens_est.toFixed(3),
        sub: '每百万 Token',
        est: k === 'requests',   // 请求次数类是估算值，读的人有权知道
        cross: true,
        conf: d.confidence
      };
    }
    if (d.cost_per_unit != null && d.quota_month != null) {
      var s = scaleFor(d.quota_month);
      return {
        value: null,
        main: '¥' + (d.cost_per_unit * s.div).toFixed(3),
        sub: '每' + s.label + (unitLabel || '单位'),
        est: false,
        cross: false,
        conf: d.confidence
      };
    }
    return null;
  }

  /* ---------------------------- 价格变动 ---------------------------- */

  /**
   * 首尾点位之差。点位不足 2 个时**明确返回「判断不了」**（v=null），
   * 而不是返回 0 —— 0 会被读成「价格没变」，而真相是「还没得比」。
   * 全库 68 档目前都只有 1 个快照，所以这个函数现在永远走 na 分支。
   */
  function priceDelta(tier) {
    var h = (tier && tier.price_history ? tier.price_history : []).slice().sort(function (a, b) {
      return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    });
    if (h.length < 2) return { v: null, n: h.length };
    return {
      v: h[h.length - 1].price_cny - h[0].price_cny,
      from: h[0].price_cny,
      to: h[h.length - 1].price_cny,
      n: h.length
    };
  }

  /* ---------------------------- 导出 ---------------------------- */

  global.__CP__ = {
    esc: esc,
    md: md,
    hl: hl,

    CONF_TITLE: CONF_TITLE,
    CONF_SHORT: CONF_SHORT,
    confTitle: confTitle,
    confShort: confShort,

    PURCHASE_LABEL: PURCHASE_LABEL,
    PURCHASE_DESC: PURCHASE_DESC,
    purchaseOf: purchaseOf,
    purchaseStatus: purchaseStatus,
    isBuyable: isBuyable,
    isClosed: isClosed,
    isUnverified: isUnverified,
    purchaseRank: purchaseRank,

    scaleFor: scaleFor,
    unitCost: unitCost,

    priceDelta: priceDelta
  };
})(typeof window !== 'undefined' ? window : this);
