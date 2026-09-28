'use strict';
/**
 * 提取器：把 HTML 里的价格线索抠出来。
 *
 * 四种策略：
 *  - pair  ：页面把「标题 + 描述」成对塞在内联 JSON 里（如联通元景），
 *            可以一次拿到「价格 + 额度」，信息量最大。
 *  - blocks：**按「独占一行的档位名」分块**，块内取价与额度。
 *            默认在渲染后的可见文本上工作（`on:'text'`）；若配 `on:'html'`，
 *            则改在"静态 HTML 去标签后的文本"上工作，适用于官方文档站这类
 *            结构本来就在静态正文里的来源，可省掉一次浏览器渲染。
 *  - jsonld：页面内嵌的 schema.org 结构化报价（`@type: Offer`），
 *            字段规整、不受 tab 交互影响，常常静态 HTML 里就有。
 *  - regex ：页面上有价格文本，但结构不确定，只能按正则捞候选值。
 *
 * 无论哪种，返回的都是「候选」，一律不直接写库。
 */

const { flatten, objectsIn, numbersOf, strOf, markContainers } = require('./jsonwalk');

/** "1,200" / "1.2万" / "3.2亿" → 数字 */
function parseNumber(s) {
  if (s == null) return null;
  const t = String(s).replace(/[,\s]/g, '');
  const m = t.match(/^([0-9]+(?:\.[0-9]+)?)\s*(万|亿)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (m[2] === '万') n *= 1e4;
  if (m[2] === '亿') n *= 1e8;
  return Number.isFinite(n) ? n : null;
}

/**
 * 货币符号归一化。**这一步不是美化，是防漏判。**
 *
 * 页面上的货币常常写成符号（华为云的卡片里就是 `"currency":"¥"`），
 * 而比对器判断"是不是外币"用的是 `currency !== 'CNY'`：
 *   if (entry.currency !== 'CNY') { 只记录 currencyNotes，不做比对; return; }
 * 于是 `"¥"` 会被当成外币 → 四档人民币报价被整体归入"外币定价"、
 * 一条都不比对，报告上却安安静静，看起来像"这来源本来就没法比对"。
 * 实测就是这么发现的：改用 cards 策略后华为云从"4 档确认"变成了 4 条外币记录。
 */
function normalizeCurrency(v, fallback) {
  const fb = fallback || 'CNY';
  if (v == null || v === '') return fb;
  const s = String(v).trim();
  if (/^(?:¥|￥|cny|rmb|元|人民币|人民币元)$/i.test(s)) return 'CNY';
  if (/^(?:\$|usd|美元)$/i.test(s)) return 'USD';
  if (/^(?:€|eur)$/i.test(s)) return 'EUR';
  return s.toUpperCase();
}

function near(html, index, span = 90) {
  return html
    .slice(Math.max(0, index - span), index + span)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HTML → 纯文本，为 blocks 的 `on:'html'` 模式服务。
 *
 * 为什么需要它：`blocks` 原本只吃「浏览器渲染后的 innerText」，因为那个文本的
 * 换行边界天然对应视觉分行，拿来当「档位名独占一行」的锚点最可靠。
 * 但有些来源根本不需要渲染 —— 官方文档站/说明页把套餐表格直接写在静态 HTML 里
 * （百度千帆 Coding Plan 文档页就是：386KB 静态页，¥40/¥200 与额度梯队在正文表格中）。
 * 对这类来源，去标签后的文本同样有稳定的块边界，却省掉一次 3~8s 的浏览器渲染。
 *
 * 关键在换行：块锚点要求「档位名独占一行」，所以块级标签的闭合必须换成 \n
 * （表格尤其重要：`<td>Coding Plan Lite</td><td>¥ 40 / 月</td>` 要变成两行）。
 */
function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<\/?(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th|tr|table|div|p|li|ul|ol|h[1-6]|section|article|header|footer)>/gi, '\n')
    .replace(/<(?:td|th|tr|div|p|li|h[1-6]|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&yen;/gi, '¥')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** pair 策略：从 title/desc 成对结构里提取价格与额度 */
function extractPairs(html, spec) {
  const re = new RegExp(spec.pairRe, 'g');
  const priceRe = new RegExp(spec.priceRe);
  const quotaRe = spec.quotaRe ? new RegExp(spec.quotaRe) : null;
  const entries = [];
  const skipped = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    const title = m[1];
    const desc = m[2];
    if (spec.filter && title.indexOf(spec.filter) === -1) {
      skipped.push(title.slice(0, 30));
      continue;
    }
    const pm = desc.match(priceRe) || title.match(priceRe);
    if (!pm) {
      skipped.push(title.slice(0, 30) + '（无价格）');
      continue;
    }
    entries.push({
      label: title.slice(0, 40),
      price: parseNumber(pm[1]),
      quota: quotaRe ? (desc.match(quotaRe) || [])[1] || null : null,
      context: near(html, m.index),
    });
  }
  return { entries, skipped, strategy: 'pair' };
}

/** regex 策略：按配置的正则捞候选价格 */
function extractRegex(html, spec) {
  const entries = [];
  const skipped = [];
  (spec.patterns || []).forEach((p) => {
    const re = new RegExp(p.re, p.flags || 'g');
    let m;
    let hit = 0;
    while ((m = re.exec(html)) !== null) {
      hit++;
      if (hit > 40) break; // 防止病态页面里无限匹配
      entries.push({
        label: p.label || p.re,
        price: parseNumber(m[1] != null ? m[1] : m[0]),
        quota: null,
        context: near(html, m.index, 60),
      });
      if (m[0] === '') break; // 防空匹配死循环
    }
  });
  return { entries, skipped, strategy: 'regex' };
}

/**
 * jsonld 策略：读页面内嵌的 schema.org 结构化数据（Offer 数组）。
 *
 * 为什么值得单独做一种策略：不少 SaaS 定价页为了 SEO 会把价格写进
 * <script type="application/ld+json"> 的 offers 里，字段规整（name/price/priceCurrency），
 * 比从渲染文本里猜可靠得多。更关键的是它**不受 tab 交互影响**：
 * Cursor 的 Pro+（$60）与 Ultra（$200）在页面上要点 tab 才显示，
 * 但结构化数据里一直都在 —— 等于绕过了整类「价格要交互才出现」的问题。
 *
 * 两个坑（都在 lib/jsonwalk.js 里统一处理，别再退回手写正则）：
 *   1. Next.js 之类的框架会把同一份 JSON 再塞进 RSC 载荷，同一对象出现两次，
 *      一次干净、一次三层转义 → 先压平，靠 dedupe 收尾。
 *   2. **对象是嵌套的**。真实形态是 `"offers":[{Offer},{Offer}]`，
 *      用"不含嵌套花括号"的正则会：漏掉所有内层 Offer（假阴性），
 *      或只匹配到外层容器、拿产品名 + 第一个子报价的价格冒充一条报价（假阳性）。
 */
function extractJsonLd(html, spec) {
  const entries = [];
  const skipped = [];
  const seen = new Set();
  const flat = flatten(html);

  const offers = objectsIn(flat).filter((o) => /"@type"\s*:\s*"Offer"/.test(o.text));
  offers.forEach((o) => {
    o.name = strOf(o.text, ['name', 'planName', 'title']);
    o.price = numbersOf(o.text, ['price', 'amount', 'salePrice']);
    o.unit = !!(o.name && o.price);
  });
  // 排除"外壳"：包着一组真 Offer 的那个父对象（详见 jsonwalk 的 markContainers）
  markContainers(offers, (o) => o.unit);

  for (const o of offers) {
    if (o.container) continue;
    const name = o.name;
    const price = o.price;
    if (!name || !price) continue; // 名字或价格两者缺一，无法归属
    if (spec && spec.filter && name.indexOf(spec.filter) === -1) { skipped.push(name); continue; }
    if (spec && Array.isArray(spec.ignore) && spec.ignore.indexOf(name) !== -1) {
      // 明确知道、但不属于本套餐的档位（如 Cursor 的 Teams 是另一条产品线）。
      // 只忽略点名的那几个 —— 不认识的档位名必须留到报告里当「新增档位」提示，
      // 否则页面新增一档我们会毫不知情。
      skipped.push(name + '（已在 ignore 列表）');
      continue;
    }
    const key = name + '|' + price.value;
    if (seen.has(key)) continue; // RSC 载荷里的重复副本
    seen.add(key);
    entries.push({
      label: name,
      price: parseNumber(price.value),
      quota: null,
      currency: normalizeCurrency(strOf(o.text, ['priceCurrency', 'currency']), (spec && spec.currency) || 'CNY'),
      context: o.text.slice(0, 160),
    });
  }
  // skipped 也去重：同一份数据在页面上出现 3 次（两处 ld+json + 一处 RSC 转义副本），
  // 不去重会让报告写「跳过 3 组非目标条目」，实际只有 1 个档位被跳过。
  return { entries, skipped: Array.from(new Set(skipped)), strategy: 'jsonld' };
}

/** 去重：同一价格在页面里往往重复出现（meta 标签、JSON、可见文本各一次），
 *  不去重会让「按序号对齐」的匹配彻底错位。 */
function dedupe(entries) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  entries.forEach((e) => {
    const key = e.price + '|' + (e.label || '');
    if (seen.has(key)) { dropped.push(e); return; }
    seen.add(key);
    kept.push(e);
  });
  return { kept, dropped };
}

/**
 * blocks 策略：在**渲染后的可见文本**上工作，按「独占一行的档位名」分块，块内取价与额度。
 *
 * 为什么必须要求档位名独占一行：
 *   智谱页面正文里也有「6倍 Lite 用量额度」这样的句子，若只按关键词分块，
 *   这个「Lite」会被误当成下一个档位的起点，把上一个块截断。
 *   而真正的档位名在 innerText 里是单独一行的，用「行边界」约束即可精确区分。
 *
 * @param {string} text 渲染后的可见文本
 */
function extractBlocks(text, spec) {
  if (!text) return { entries: [], skipped: [], strategy: 'blocks' };
  const blockRe = new RegExp(spec.blockRe, 'g');
  const priceReSrc = spec.priceRe || '[¥￥]\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)';
  const priceRe = new RegExp(priceReSrc);
  const priceReAll = new RegExp(priceReSrc, 'g');
  const quotaRe = spec.quotaRe ? new RegExp(spec.quotaRe) : null;
  const maxBlock = spec.maxBlock || 500;

  const anchors = [];
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    if (m[0] === '') { blockRe.lastIndex++; continue; }
    anchors.push({ key: m[1], index: m.index });
  }

  const entries = [];
  const skipped = [];
  const taken = new Set();

  anchors.forEach((a, i) => {
    const hardEnd = Math.min(text.length, a.index + maxBlock);
    const end = i + 1 < anchors.length ? Math.min(anchors[i + 1].index, hardEnd) : hardEnd;
    const block = text.slice(a.index, end);
    if (taken.has(a.key)) { skipped.push(a.key + '（重复锚点已跳过）'); return; }
    const pm = block.match(priceRe);
    if (!pm) { skipped.push(a.key + '（块内无价格）'); return; }
    taken.add(a.key);

    // 页面常同时展示「优惠价 / 原价」，按出现顺序取：第 1 个是当前实付价，第 2 个是原价
    let listPrice = null;
    if (spec.captureListPrice) {
      const all = [];
      let g;
      priceReAll.lastIndex = 0;
      while ((g = priceReAll.exec(block)) !== null && all.length < 4) {
        all.push(parseNumber(g[1]));
        if (g[0] === '') priceReAll.lastIndex++;
      }
      if (all.length > 1) listPrice = all[1];
    }

    const qm = quotaRe ? block.match(quotaRe) : null;
    entries.push({
      label: a.key,
      price: parseNumber(pm[1]),
      listPrice,
      currency: normalizeCurrency(spec.currency, 'CNY'),
      quota: qm ? String(qm[1]).replace(/\s+/g, ' ').trim() : null,
      context: block.replace(/\s+/g, ' ').trim().slice(0, 140),
    });
  });

  return { entries, skipped, strategy: 'blocks' };
}

/**
 * cards 策略：页面把每档套餐序列化成一张「卡片对象」，卡片里同时有档位名、价格、单位、额度。
 *
 * 两个实测形态（同一种结构，只是键名和嵌套层级不同）：
 *
 *   华为云（藏在 `<textarea class="activity-visible-data">` 里，JS 读它来渲染）
 *     {"header":{"titlePc":"Lite","subtitlePc":"轻量入门，低负荷开发者"},
 *      "description":{"specs":[{"name":"每订阅月","spec":"5000 万 Tokens"}]},
 *      "price":{"currency":"¥","origin":59,"current":59,"unit":"/月"}}
 *
 *   百度千帆
 *     {"title":"Mini","hotTags":[{"text":"1,400 积分 /月"}],
 *      "price":"4.9","unit":"/月","deletePrice":"9.9","paramsTable":[…]}
 *
 * 为什么不按 JSON 路径取值：字段散在不同层级（`header.titlePc` / `price.current`），
 * 但都在同一张卡片对象内、且这些键名在本站内不重复，所以在卡片文本上按键名取第一个匹配
 * 就够用，还少一层配置。真正需要配的只有三件事：
 *   cardKeys  怎么圈定"一张卡片"（必须同时出现的键名，用来把卡片和页面上其它带价格的杂项对象分开）
 *   filter    同一档位有多张卡片时认哪一张（如千帆有"积分制/Token制"双口径各一张）
 *   quotaRe   额度怎么写（形态太不规整，用一个带捕获组的正则比配键名可靠）
 *
 * ⚠ maxLen 要按实际卡片大小给：华为的卡片对象有 2.4KB，用默认的 1500 会把整张卡片丢掉 ——
 *   这正是它最初被误判成"没有结构化报价"的直接原因。
 */
function extractCards(html, spec) {
  const flat = flatten(html);
  const maxLen = spec.maxLen == null ? 4000 : spec.maxLen;
  const must = spec.cardKeys || [];
  const nameKeys = spec.nameKeys || ['name', 'title'];
  const priceKeys = spec.priceKeys || ['price'];
  const unitKeys = spec.unitKeys || ['unit'];
  const listPriceKeys = spec.listPriceKeys || [];
  const quotaRe = spec.quotaRe ? new RegExp(spec.quotaRe) : null;

  const cards = objectsIn(flat, { maxLen })
    .filter((o) => must.every((k) => new RegExp('"' + k + '"\\s*:').test(o.text)));

  const skipped = [];
  const warnings = [];
  const byName = new Map();

  for (const o of cards) {
    const label = strOf(o.text, nameKeys);
    const price = numbersOf(o.text, priceKeys);
    if (!label || !price) continue;
    if (spec.filter && o.text.indexOf(spec.filter) === -1) {
      skipped.push(label + '（不含「' + spec.filter + '」，属另一计费口径或展示变体）');
      continue;
    }
    const list = listPriceKeys.length ? numbersOf(o.text, listPriceKeys) : null;
    const listVal = list ? parseNumber(list.value) : null;
    const curVal = parseNumber(price.value);
    const item = {
      label,
      price: curVal,
      rawPrice: null,
      // 原价只在**确实与现价不同**时才有意义 —— 华为的 origin 常等于 current，
      // 那不是"原价"，只是同一个数被填了两遍，记下来会让前端多出一条假的划线价。
      listPrice: listVal != null && listVal !== curVal ? listVal : null,
      quota: quotaRe ? ((o.text.match(quotaRe) || [])[1] || null) : null,
      currency: normalizeCurrency(strOf(o.text, ['currency', 'priceFlag']), spec.currency || 'CNY'),
      unit: strOf(o.text, unitKeys),
      context: o.text.slice(0, 160),
    };
    if (!byName.has(label)) byName.set(label, []);
    byName.get(label).push(item);
  }

  // 同一档位出现多张卡片时价格必须一致。不一致就**报警而不是随便挑一张** ——
  // 静默取第一个会把"页面结构调整了"伪装成"价格没变"。
  const entries = [];
  for (const [label, items] of byName) {
    const uniq = Array.from(new Set(items.map((x) => x.price + '|' + (x.unit || ''))));
    if (uniq.length > 1) {
      warnings.push('⚠ 「' + label + '」在页面上出现了 ' + uniq.length + ' 个不同报价（'
        + uniq.join(' / ') + '），已取第一个；请人工确认哪个才是该档位当前价');
    }
    entries.push(items[0]);
  }

  return { entries, skipped, strategy: 'cards', warnings };
}

/**
 * @param {string} html 页面 HTML（或渲染后的 HTML）
 * @param {object} spec 提取配置
 * @param {string} [text] 浏览器渲染后的可见文本（blocks 默认吃它）
 * @returns {{strategy:string, entries:Array, skipped:string[], warnings:string[]}}
 */
function extract(html, spec, text) {
  const warnings = [];
  if (!spec || spec.type === 'manual') {
    return { strategy: 'manual', entries: [], skipped: [], warnings: ['该来源未配置自动提取，需人工核对'] };
  }
  // blocks 默认吃「渲染后的可见文本」；显式写 on:'html' 时改吃「静态 HTML 去标签后的文本」
  const blocksOnHtml = spec.type === 'blocks' && spec.on === 'html';
  const blockText = blocksOnHtml ? (html ? stripHtml(html) : '') : text;
  const payload = spec.type === 'blocks' ? blockText : html;
  if (!payload || !payload.length) {
    return {
      strategy: spec.type, entries: [], skipped: [],
      warnings: [spec.type === 'blocks' && !blocksOnHtml && !text
        ? '需要渲染后的文本，但本次没有取得（来源可能未开启 render）'
        : '页面内容为空'],
    };
  }

  let res;
  if (spec.type === 'pair') res = extractPairs(html, spec);
  else if (spec.type === 'regex') res = extractRegex(html, spec);
  else if (spec.type === 'blocks') res = extractBlocks(blockText, spec);
  else if (spec.type === 'jsonld') res = extractJsonLd(html, spec);
  else if (spec.type === 'cards') res = extractCards(html, spec);
  else return { strategy: String(spec.type), entries: [], skipped: [], warnings: ['未知的提取策略: ' + spec.type] };

  // 价格口径换算：页面标价 → 与数据集同口径
  //   摩尔线程：页面给季度价，数据集按月均（priceDivisor = 3，用除法避免 0.3333 的浮点误差）
  //
  // ⚠ priceScale 只允许承载「页面上找得到的数字」的换算（如货币单位的确定性折算）。
  //   绝不要用它做「折扣推断」：如果页面没有那个数字，就不许用系数把差异抹平。
  //   曾经的 MiniMax 就配过 priceScale: 0.9（"数据集记的是 9 折价"），而页面上根本没有
  //   9 折 —— 结果是一个真实存在的 11% 价格差异被永久掩盖成"0 变更"。已撤销。
  //   分辨标准很简单：把系数拿出来，问一句"这个数在页面上吗？" 不在就是拟合。
  // 保留 rawPrice，报告里能看出换算前是多少，不制造"凭空出现的数字"。
  const scale = spec.priceDivisor ? 1 / spec.priceDivisor : (spec.priceScale == null ? 1 : spec.priceScale);
  if (spec.priceScale != null) {
    // 护栏：priceScale 天然是"乘法系数"，最容易被用来把数据集里已有的数字反推成"页面值"。
    // 真要用，必须能在页面上指出那个数字；否则就是拿假设证明假设。让它每次运行都吱一声。
    warnings.push('⚠ 该来源用了 priceScale=' + spec.priceScale +
      '（折扣推断系数）。请确认这个数在页面上确实存在；若只是为了让比对结果显示一致，就删掉它。');
  }
  if (scale !== 1) {
    res.entries.forEach((e) => {
      if (e.price == null) return;
      e.rawPrice = e.price;
      e.priceScale = spec.priceDivisor ? '1/' + spec.priceDivisor : scale;
      e.price = Number((e.price * scale).toFixed(4));
    });
    if (res.entries.length) {
      const sample = res.entries[0];
      warnings.push('价格已换算（页面 ' + sample.rawPrice + ' → 口径 ' + sample.price +
        '，系数 ' + sample.priceScale + '）' + (spec.scaleNote ? '：' + spec.scaleNote : ''));
    }
  }

  const d = dedupe(res.entries);
  if (d.dropped.length) {
    warnings.push('去重丢弃 ' + d.dropped.length + ' 条重复候选（同一价格在 meta/JSON/正文里重复出现）');
  }
  res.entries = d.kept;
  // 合并而不是覆盖：策略自己也会产生告警（如 cards 策略发现"同一档位有两个报价"），
  // 以前这里是直接赋值，会把那些告警整段吞掉 —— 而那恰恰是最该被看到的一类。
  res.warnings = (res.warnings || []).concat(warnings);
  return res;
}

module.exports = { extract, extractBlocks, stripHtml, normalizeCurrency, parseNumber, near };
