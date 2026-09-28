'use strict';
/**
 * 内嵌 JSON 的兜底扫描工具。
 *
 * 为什么需要它：为了 SEO，很多定价页会把价格写进内联 JSON（schema.org 的
 * `application/ld+json`、或前端框架的序列化载荷）。这类数据比"渲染后的可见文本"
 * 可靠得多 —— 字段规整、不受 tab 交互影响、常常静态 HTML 里就有。
 *
 * 但这个 haystack 有两个坑，两个都真实踩过：
 *
 * 1. **同一份数据会出现多次、且转义层数不同**。Next.js 之类会把 JSON 再塞进 RSC 载荷，
 *    于是同一对象既有干净的 `"name":"Pro"`，又有三层转义的 `\\\"name\\\":\\\"Pro\\\"`。
 *    做法是先把 haystack 压平，再靠去重收尾 —— 见 `flatten()`。
 *
 * 2. **对象是嵌套的，而正则数不了花括号**。真实形态长这样：
 *      {"@type":"Product","offers":[{"@type":"Offer","name":"Pro","price":"20"}]}
 *    用 `/\{[^{}]{0,900}\}/g` 之类的"不含嵌套"正则会：
 *      - 漏掉所有内层对象（假阴性：报成"这个来源没有结构化报价"）
 *      - 或者只匹配到外层那个"容器"，然后拿产品名 + 子报价的价格冒充一条报价（假阳性）
 *    所以老老实实做配平扫描 —— 见 `objectsIn()`，并用 `markContainers()` 排除外壳。
 */

/** 压平多层转义：`\\"name\\"` → `"name"`，让 RSC 载荷副本也能被普通正则匹配 */
function flatten(s) {
  return String(s || '').replace(/\\+"/g, '"');
}

/**
 * 扫出所有「花括号配平」的 JSON 对象片段 —— **包括嵌套的**。
 *
 * 用栈一次扫完（O(n)），并处理字符串里的引号与转义，
 * 否则文案里出现一个 `}` 就会把对象截断。
 *
 * @param {string} s 已 flatten 的文本
 * @param {object} [opts]
 *   opts.maxLen     单个对象的最大长度，超过视为"不是我们要找的小对象"（默认 1500）
 *   opts.maxObjects 收集上限，防止病态页面把内存吃满（默认 40000）
 * @returns {Array<{start:number,end:number,text:string}>} 按 start 升序
 */
function objectsIn(s, opts = {}) {
  const maxLen = opts.maxLen == null ? 1500 : opts.maxLen;
  const maxObjects = opts.maxObjects == null ? 40000 : opts.maxObjects;

  // 配平扫描假定"引号是成对的"。可这个假定不一定成立：
  //   - 调用方传进来的可能是一段截取片段，正好从某个字符串**中间**开始
  //     （实测：fixture 从 JSON 中途切开，第一个 " 就让奇偶性翻转，
  //      之后所有 { 都被当成"在字符串里"，结果 0 个对象 —— 静默的假阴性）
  //   - 页面 HTML 超过体积上限被截断时，同样可能断在字符串中间
  // 所以两种初始状态各扫一遍：只要引号是配对的，第一遍就对；
  // 只有当第一遍一个对象都没找到时，才用"起始就在字符串里"再试一次。
  // 这样对正常输入零影响，又不会因为一个截断而彻底失明。
  function scan(startInStr) {
    const out = [];
    const stack = [];
    let inStr = startInStr;
    let esc = false;
    for (let i = 0; i < s.length && out.length < maxObjects; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { stack.push(i); continue; }
      if (c !== '}') continue;
      const start = stack.pop();
      if (start == null || i - start >= maxLen) continue;
      out.push({ start, end: i + 1, text: s.slice(start, i + 1) });
    }
    return out;
  }

  let out = scan(false);
  if (!out.length) out = scan(true);
  // 按起点排序，让「包含关系」变成下标上的连续区间（容器过滤要用）
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  return out;
}

/**
 * 取第一个**取值是数字**的字段。
 * 只认纯数字，`"price":"面议"` 会自然落空；
 * `"price":{"value":60}` 也会落空，然后由嵌套层的 `"value"` / `"price"` 去命中。
 * @returns {{key:string, value:string}|null}
 */
function numbersOf(s, keys) {
  for (const k of keys) {
    const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"?(\\d+(?:\\.\\d+)?)"?'));
    if (m) return { key: k, value: m[1] };
  }
  return null;
}

/** 取第一个字符串字段（名字、币种这类） */
function strOf(s, keys) {
  for (const k of keys) {
    const m = s.match(new RegExp('"' + k + '"\\s*:\\s*"([^"]{1,40})"'));
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * 给「外壳对象」打上 `container` 标记。
 *
 * 如果一个对象**包含**另一个"像一个独立报价"的对象（由调用方的 `isUnit` 判定，
 * 一般是"既有名字又有数字价"），那它自己不是报价，而是把子报价包起来的壳 ——
 * schema.org 的 `"offers":[…]` 就是这个形状。不标记的话，外层会以
 * 产品名 + 第一个子报价的价格冒充一条报价（Cursor 就这样报出过 "Cursor / USD 0"）。
 *
 * 判据不能只是"有没有子对象"：那会误杀
 *   {"name":"Pro","priceSpecification":{"price":60}}
 * —— 它的子对象没有名字，不构成独立报价，外层必须留下。
 *
 * 要求入参按 start 升序（`objectsIn` 已保证）：被包含的对象在数组里是连续的一段，
 * 内层循环能早停，整体接近线性。
 *
 * @param {Array} objs objectsIn 的结果（会被就地加上 container 标记）
 * @param {(o:object)=>boolean} isUnit
 * @returns {Array} 同一个数组
 */
function markContainers(objs, isUnit) {
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.container || !isUnit(o)) continue;
    for (let k = i + 1; k < objs.length && objs[k].start < o.end; k++) {
      if (isUnit(objs[k]) && objs[k].end <= o.end) { o.container = true; break; }
    }
  }
  return objs;
}

module.exports = { flatten, objectsIn, numbersOf, strOf, markContainers };
