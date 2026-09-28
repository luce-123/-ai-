'use strict';
/**
 * 比对器：把提取到的候选值与本数据集当前值做差异判定。
 *
 * 两种匹配模式，按来源的数据形状选择：
 *
 *  positional（用于 pair 类来源）
 *    页面的「标题+描述」对与该套餐档位一一对应（如联通元景），
 *    可以逐档对齐，因而**能检测涨价/降价**。
 *
 *  byValue（用于 regex 类来源）
 *    页面只给你一串价格，分不清哪个数字属于哪一档。
 *    此时只做「值是否仍能在当前数据集里找到」的确认，**不宣称发现变更**；
 *    找不到归属的候选值单独列出交给人工看。
 *    这是刻意的能力限制：拿不准就不猜。
 *
 * 安全底线：变动幅度超过 50% 一律降级为人工复核，不进自动应用队列。
 */

const SAFE_RATIO = 0.5; // 变动幅度超过 50% 视为可疑
const EPS = 0.005;      // 小于半分钱视为无变化

function diffPlan(plan, source, extracted, fetchInfo) {
  const tiersById = {};
  plan.tiers.forEach((t) => { tiersById[t.id] = t; });
  const declared = source.tiers || plan.tiers.map((t) => t.id);
  // pair / blocks / jsonld / cards 都能定位到「这一档对应的价格」，按档位名对齐；
  // regex 只给一串数字，分不清归属，只能做值确认。
  //
  // ⚠ cards 必须在这个名单里。它是"每档一张卡片对象"，天生带档位名，
  //   漏掉它不会报错、也不会告警 —— 只会静默退化成 byValue，
  //   于是"涨价"再也发现不了，页面上只剩"值仍能找到"的确认。
  //   这类落差最危险的地方正是它不说话，所以靠下面的自测锁住。
  const positionalByNature = extracted.strategy === 'pair' || extracted.strategy === 'blocks' ||
    extracted.strategy === 'jsonld' || extracted.strategy === 'cards';
  const mode = source.mode || (positionalByNature ? 'positional' : 'byValue');

  const out = {
    planId: plan.id,
    planName: plan.name,
    url: source.url,
    status: source.status,
    mode,
    httpStatus: fetchInfo ? fetchInfo.status : null,
    strategy: extracted.strategy,
    entryCount: extracted.entries.length,
    hasData: false,
    changes: [],
    confirmed: [],
    missing: [],
    unassigned: [],
    quotaNotes: [],
    currencyNotes: [],
    warnings: extracted.warnings.slice(),
  };

  if (extracted.skipped && extracted.skipped.length) {
    out.warnings.push('跳过 ' + extracted.skipped.length + ' 组非目标条目');
  }
  if (extracted.entries.length === 0) {
    out.warnings.push('未提取到任何价格候选');
    out.missing = declared.slice();
    return out;
  }
  out.hasData = true;

  if (mode === 'positional') {
    const covered = {};
    // 归一化额度字符串：忽略空白、千分位、大小写、英文复数、括号全半角
    const normQuota = (s) => String(s)
      .replace(/[\s,，]/g, '')
      .replace(/tokens/gi, 'token')
      .replace(/（/g, '(').replace(/）/g, ')')
      .toLowerCase();

    const compare = (tierId, entry) => {
      const tier = tiersById[tierId];
      if (!tier) { out.warnings.push('配置引用了不存在的档位 ' + tierId); return; }
      covered[tierId] = true;

      // 外币定价（如 Cursor $20/mo）：数据集里的 ¥ 值是汇率换算结果，不是官网标价。
      // 汇率每天都在动，拿它比对只会制造假变更 —— 只记录，不判定。
      if (entry.currency && entry.currency !== 'CNY') {
        out.currencyNotes.push({
          tierId, tierName: tier.name,
          currency: entry.currency, pagePrice: entry.rawPrice == null ? entry.price : entry.rawPrice,
          datasetCny: tier.price_cny,
          note: '页面为 ' + entry.currency + ' 标价，数据集 ¥' + tier.price_cny + ' 为汇率换算值，不做自动比对',
        });
        return;
      }

      const from = tier.price_cny;
      const to = entry.price;
      const delta = to - from;
      const ratio = from === 0 ? (to === 0 ? 0 : 1) : Math.abs(delta) / from;

      if (Math.abs(delta) < EPS) {
        out.confirmed.push({
          tierId, tierName: tier.name, price: from,
          pageLabel: entry.label || null,
          rawPrice: entry.rawPrice == null ? null : entry.rawPrice,
        });
      } else {
        out.changes.push({
          tierId, tierName: tier.name,
          from, to,
          rawPrice: entry.rawPrice == null ? null : entry.rawPrice,
          priceScale: entry.priceScale || null,
          delta: Number(delta.toFixed(4)),
          ratio: Number(ratio.toFixed(4)),
          safe: ratio <= SAFE_RATIO,
          evidence: entry.context,
        });
      }
      if (entry.quota && tier.quota && tier.quota.raw) {
        const a = normQuota(tier.quota.raw);
        const b = normQuota(entry.quota);
        // 页面常只写额度不带「/月」后缀，互相包含即视为一致
        if (!(a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) {
          out.quotaNotes.push({ tierId, tierName: tier.name, current: tier.quota.raw, extracted: entry.quota });
        }
      }
    };

    if (source.tierKeyMap) {
      // 按页面档位名对齐，不依赖顺序 —— 页面加档/换序也不会整体错位
      const map = source.tierKeyMap;
      extracted.entries.forEach((entry) => {
        const tierId = map[entry.label];
        if (!tierId) {
          out.unassigned.push({
            price: entry.price, rawPrice: entry.rawPrice == null ? null : entry.rawPrice,
            currency: entry.currency || 'CNY',
            label: entry.label || '(无标签)', context: entry.context,
          });
          return;
        }
        if (covered[tierId]) {
          out.unassigned.push({
            price: entry.price, rawPrice: entry.rawPrice == null ? null : entry.rawPrice,
            currency: entry.currency || 'CNY',
            label: entry.label + '(重复)', context: entry.context,
          });
          return;
        }
        compare(tierId, entry);
      });
      declared.forEach((id) => { if (!covered[id]) out.missing.push(id); });

      const unknownKeys = Array.from(new Set(extracted.entries
        .map((e) => e.label)
        .filter((l) => l && !map[l])));
      if (unknownKeys.length) {
        out.warnings.push('页面出现未映射的档位名：' + unknownKeys.join('、') + '（可能新增档位，需人工确认）');
      }
    } else {
      declared.forEach((tierId, i) => {
        const entry = extracted.entries[i];
        if (!entry || entry.price == null) { out.missing.push(tierId); return; }
        compare(tierId, entry);
      });

      if (extracted.entries.length > declared.length) {
        out.warnings.push('页面提取到 ' + extracted.entries.length + ' 条候选，多于配置的 ' +
          declared.length + ' 档，可能出现了新档位：' +
          extracted.entries.slice(declared.length, declared.length + 3)
            .map((e) => (e.label || '') + ' ¥' + e.price).join('；'));
      }
    }
  } else {
    // byValue：只确认，不宣称变更
    const used = {};
    extracted.entries.forEach((e) => {
      if (e.price == null) return;
      const hit = declared
        .filter((id) => tiersById[id])
        .find((id) => Math.abs(tiersById[id].price_cny - e.price) < EPS);
      if (hit && !used[hit]) {
        used[hit] = true;
        out.confirmed.push({ tierId: hit, tierName: tiersById[hit].name, price: e.price });
      } else {
        out.unassigned.push({ price: e.price, label: e.label, context: e.context });
      }
    });
    declared.forEach((id) => { if (!used[id]) out.missing.push(id); });

    if (out.unassigned.length) {
      out.warnings.push('有 ' + out.unassigned.length + ' 个候选值无法归属到任何档位（可能来自宣传语或其他产品），' +
        '本模式下不据此判定变更');
    }
  }

  return out;
}

/** 汇总成待确认报告 */
function buildReport(results, meta) {
  const changes = [];
  const reviews = [];
  const quotaNotes = [];
  const currencyNotes = [];

  results.forEach((r) => {
    r.changes.forEach((c) => {
      (c.safe ? changes : reviews).push(Object.assign({
        planId: r.planId, planName: r.planName, url: r.url,
      }, c));
    });
    r.quotaNotes.forEach((q) => quotaNotes.push(Object.assign({
      planId: r.planId, planName: r.planName,
    }, q)));
    (r.currencyNotes || []).forEach((c) => currencyNotes.push(Object.assign({
      planId: r.planId, planName: r.planName,
    }, c)));
  });

  const byStatus = {};
  results.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  return {
    generated_at: meta.generated_at,
    dataset_snapshot: meta.dataset_snapshot,
    summary: {
      sources_checked: results.length,
      sources_with_data: results.filter((r) => r.hasData).length,
      pending_changes: changes.length,
      needs_review: reviews.length,
      confirmed_tiers: results.reduce((s, r) => s + r.confirmed.length, 0),
      unassigned_candidates: results.reduce((s, r) => s + r.unassigned.length, 0),
      by_status: byStatus,
    },
    instruction:
      '本文件只是报告，不会自动改数据。changes 里确认无误的把 decision 改成 "apply"，' +
      '再运行 node codingplan/scripts/collect/apply.js；needs_review 必须人工比对官网。' +
      'confirmed 表示「页面上仍能找到与当前价格一致的数字」，属于一致性证据，不是变更。',
    changes: changes.map((c) => Object.assign({ decision: 'pending' }, c)),
    needs_review: reviews.map((c) => Object.assign({ decision: 'pending' }, c)),
    quota_notes: quotaNotes,
    currency_notes: currencyNotes,
    per_source: results,
  };
}

module.exports = { diffPlan, buildReport, SAFE_RATIO, EPS };
