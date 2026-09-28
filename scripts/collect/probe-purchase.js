'use strict';
/**
 * 可购买性探针：判断一个套餐「今天还能不能买到」。
 *
 * 为什么要单独写一个探针，而不是复用价格采集：
 *   价格与可购买性是**两条独立的通道**。价格靠页面上的数字，可购买性靠页面上的
 *   **状态**（按钮文案、售罄标记、库存开关、登录墙）。而状态信号有个特有的坑：
 *
 *   ⚠ 页面源码里的文案模板会伪装成状态。
 *   2026-09-28 实测华为 Token Plan 页：源码里出现「已结束」×4、「已售罄」×3、
 *   「抢购」×4 —— 全是 `${startTime}点开抢` / `秒杀已结束` / `已售罄，请次日来抢`
 *   这类**未渲染的按钮文案模板**（字段名就叫 afterFlashSaleMainBtnText），
 *   而真正的状态字段是 `"hasFlashSale":false` + 每档 `mainBtnText:"立即订阅"`。
 *   即：**「已售罄」四个字在源码里，但页面上永远不会显示。**
 *   纯关键词 grep 会因此把「在售」误报成「售罄」——方向恰好相反。
 *
 * 因此本探针把信号分三级，可信度递减、绝不混用：
 *   [A] STATE  —— 源码里的**状态字段**（值不含 `${`）。最硬：字段名即语义。
 *   [B] TEXT   —— **渲染后的可见文本**里的按钮/状态词。硬：用户真能看到。
 *   [C] TMPL   —— 源码里含 `${` 的文案模板。**不是状态**，只打印出来示众，
 *                 用来解释「为什么 grep 会误报」，不计入任何判定。
 *
 * 用法：
 *   node probe-purchase.js --url=https://example.com/pricing [--render] [--waitFor=立即订阅]
 *   node probe-purchase.js --list=targets.json
 *   node probe-purchase.js --self-test          # 只跑模板误报的分类逻辑自测
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/fetch');
const { createRenderer, findBrowser } = require('./lib/render');

// ── 可购买性词表 ──────────────────────────────────────────────
// 每条：[词, 倾向的判定]。倾向只是线索，最终判定要人看上下文后写进数据。
const BUY_POSITIVE = ['立即购买', '立即订阅', '马上抢购', '立即抢购', '开通套餐', '去购买', '现在购买', '订阅套餐', '立即开通'];
// 限量词里「限购 / 数量有限 / 先到先得 / 名额有限」是 2026-09-28 扫华为页时补的：
// 华为 Token Plan 的「在售」是真的，但同一屏写着「每个用户限购 1 个套餐，数量有限，先到先得」，
// 词表里没有这几个词，于是它被判成纯 on_sale —— 漏掉的是「限量」，不是「买不到」。
const BUY_LIMITED = ['限量抢购', '限时抢购', '售罄', '已售罄', '抢光', '抢购', '库存不足', '仅剩', '每日限量', '配额', '限购', '数量有限', '先到先得', '名额有限'];
const BUY_CLOSED = ['停止新购', '已停售', '停止购买', '暂停订阅', '暂停新购', '停止服务', '已下线', '结束', '下架', '不再提供', '无法购买', '暂停开放'];
const BUY_LOGIN = ['登录后', '请登录', '扫码登录', '立即注册'];
const BUY_WAIT = ['敬请期待', '即将上线', '即将开放', 'coming soon'];

const ALL_KW = [].concat(BUY_POSITIVE, BUY_LIMITED, BUY_CLOSED, BUY_LOGIN, BUY_WAIT);

/**
 * 购买 CTA 的**形态**，补词表补不出来的那一类。
 *
 * 为什么需要它：中文站点的 CTA 经常是「动词 + 档位名」，而档位名是英文的 ——
 *   opencode.ai/go 写「订阅 Go $10/月」、cursor.com/cn/pricing 写「获取 Pro」。
 *   词表能列出「立即订阅」，列不出「订阅 Go」：档位名每家都不同，穷举不完。
 *
 * 所以这里匹配**形态**而不是词：动词（购买/订阅/开通/获取）+ 紧随的英文词（Go/Pro/Plus…）。
 * 四条约束，**每一条都是踩出来的**（前两条是第一次写错之后，用 --file 离线回归撞出来的）：
 *   1) 只接英文，不接中文 —— 否则「订阅套餐」会被切成 kw='订阅'，反而丢掉原词表那条精确命中。
 *   2) 中间只允许空格/制表符，**不允许换行**。渲染后的可见文本是逐行拼接的，
 *      「立即购买\nHy 个人版–基础套餐」在文本里是连着的，但它在页面上根本不是一句话 ——
 *      用 \\s* 就会把下一行的标题当成档位名，凭空造出一堆假 CTA。
 *   3) 后面 40 字符里出现 API/Key/文档/帮助…就不算 —— 联通页真实存在「获取 API Key」，
 *      那是接入指引，不是购买按钮。
 *   4) 后面 40 字符里出现「吗 / 是否 / 如何 / ？」就不算 —— FAQ 里全是
 *      「购买 Cursor 吗？」「购买 Agent Plan 后，是否需要单独开通…」这种**问句**。
 */
const BUY_CTA_SRC = '(?:立即|马上|现在)?(?:购买|订阅|开通|获取)[ \\t]*[A-Za-z][A-Za-z0-9+.]{0,9}';
const BUY_CTA_RE = new RegExp(BUY_CTA_SRC);         // 判定用（不带 g，避免 lastIndex 串味）
const BUY_CTA_RE_G = new RegExp(BUY_CTA_SRC, 'g');  // 扫描用
const CTA_NEGATIVE_RE = /(API|Key|密钥|token|文档|帮助|指南|链接|验证码|优惠券|发票|权限|资格)/i;
const CTA_QUESTION_RE = /(吗|呢|？|\?|如何|是否|为什么|哪里|怎么|能不能)/;

/** 命中词算不算「购买 CTA」：词表命中，或形态命中且不在排除语境里 */
function isPositiveCta(kw) {
  if (BUY_POSITIVE.includes(kw)) return true;
  return BUY_CTA_RE.test(kw) && !CTA_NEGATIVE_RE.test(kw);
}

/**
 * 状态字段名，分强弱两档：
 *   strong —— 字段名本身就只服务于「能不能买」，命中即可作证据；
 *   weak   —— 名字通用（status / stock / quota…），只有在值带购买语义时才值得看。
 * 分开的理由：weak 键名在页面配置里到处都是，混在一起会淹掉真正的信号。
 */
const STRONG_KEYS = 'hasFlashSale|soldOut|isSoldOut|sellOut|saleStatus|purchaseStatus|buyStatus|btStatus|canBuy|buyable|onSale|isOnSale|mainBtnText|btnText|buttonText|primaryBtnText|buyBtnText|subscribeText|cornerMark|saleTag|tagText|purchaseConfigMode|queryStockByRuleCode|unpaidOrderNoticeText';
const WEAK_KEYS = 'flashSale|status|enable|enabled|disabled|stock|inventory|remain|remainNum|quota|limitNum';
const STATE_KEY_RE = new RegExp('"(' + STRONG_KEYS + '|' + WEAK_KEYS + ')"\\s*:\\s*("?[^",{}\\[\\]]{0,60}"?|true|false)', 'g');

/** 是模板而不是状态：值里含插值占位符 */
function isTemplateValue(v) {
  return /\$\{|<\/?%|#\{|\{\{/.test(String(v));
}

/**
 * 键名是否表明「这是某个条件下的文案」，而不是当前状态。
 *
 * 这是本探针**最关键**的一条判据，也是最反直觉的一条。
 * 华为页源码：`"runoutFlashSaleMainBtnText":"已售罄，请次日来抢"`
 *   —— 注意「已售罄」这三个字所在的字符串**连一个 `${` 都没有**，
 *      它是一句写死的、完全合法的字面量。
 *   让它是「模板」的不是它的内容，而是它的**键名**：
 *   runout + FlashSale + MainBtn + Text = 「售罄时按钮该显示的字」。
 *   同族的还有 before…Text（开抢前显示）、after…Text（结束后显示）。
 *   同一页里真正的状态是 `"hasFlashSale":false` 与 `"mainBtnText":"立即订阅"`。
 *
 * 所以：只按值里有没有 `${` 去筛，会漏掉这一整类假信号。
 */
const CONDITIONAL_LABEL_RE = /(before|after|runout|soldout|sold_out|disabled|pending|expired|ended|sold|full|empty|fail|error)[A-Za-z0-9_-]*(template|text|label|tip|msg|message|placeholder)/i;
const TEMPLATE_KEY_RE = /(template|placeholder)$/i;

function keyIsConditionalLabel(key) {
  if (!key) return false;
  return CONDITIONAL_LABEL_RE.test(key) || TEMPLATE_KEY_RE.test(key);
}

/**
 * 找到命中点所处 JSON 值的键名（向左找最近一个「"key": "值还没闭合」的形态）。
 * 非 JSON 文本（如渲染后的可见文本）找不到键名，返回 null。
 */
function enclosingKey(text, at) {
  const seg = text.slice(Math.max(0, at - 400), at);
  const m = seg.match(/"([A-Za-z_][A-Za-z0-9_.-]*)"\s*:\s*"[^"]*$/);
  return m ? m[1] : null;
}

/**
 * 命中点算不算「模板/条件文案」。三条任一命中即算：
 *   1) 值里有 ${ 插值；
 *   2) 键名是条件文案（runout…Text / after…Text / …Template）；
 *   3) 落在反引号模板串里。
 */
function hitIsTemplate(text, at, kwLen) {
  const key = enclosingKey(text, at);
  if (keyIsConditionalLabel(key)) return true;
  const l = text.lastIndexOf('"', at - 1);
  const r = text.indexOf('"', at + kwLen);
  if (l >= 0 && r >= 0 && l < at && r > at) {
    const seg = text.slice(l + 1, r);
    if (seg.length < 400 && isTemplateValue(seg)) return true;
  }
  const near = text.slice(Math.max(0, at - 200), at + kwLen + 60);
  const bq = near.lastIndexOf('`');
  if (bq >= 0 && near.indexOf('${', bq) >= 0) return true;
  return false;
}

/**
 * 从一段文本里收集关键词命中。返回 [{kw, at, ctx, templated, key}]。
 * templated=true 表示这个命中是「模板/条件文案」—— 归类为 [C] TMPL，不计入判定。
 */
function scanKeywords(text, opts = {}) {
  const window = opts.window || 90;
  const out = [];
  const seen = new Set();
  for (const kw of ALL_KW) {
    let i = -1;
    while ((i = text.indexOf(kw, i + 1)) >= 0) {
      const ctx = text.slice(Math.max(0, i - window), Math.min(text.length, i + kw.length + window));
      const templated = hitIsTemplate(text, i, kw.length);
      const key = kw + '@' + ctx.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kw, at: i, key: enclosingKey(text, i), ctx: ctx.replace(/\s+/g, ' ').trim(), templated });
    }
  }

  // 再扫一遍「动词 + 英文档位名」形态（订阅 Go / 获取 Pro…）。
  // 放到关键词后面：两者都命中「立即购买」时，靠 seen 去重，不会变成两条。
  if (opts.cta !== false) {
    BUY_CTA_RE_G.lastIndex = 0;
    let m;
    while ((m = BUY_CTA_RE_G.exec(text)) !== null) {
      const kw = m[0];
      const after = text.slice(m.index, m.index + kw.length + 40);
      if (CTA_NEGATIVE_RE.test(after)) continue;      // 「获取 API Key」这类，不是购买按钮
      if (CTA_QUESTION_RE.test(after)) continue;      // FAQ 问句，不是购买按钮
      const ctx = text.slice(Math.max(0, m.index - window), Math.min(text.length, m.index + kw.length + window));
      const key = kw + '@' + ctx.slice(0, 50);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kw, at: m.index, key: enclosingKey(text, m.index), ctx: ctx.replace(/\s+/g, ' ').trim(), templated: hitIsTemplate(text, m.index, kw.length) });
    }
  }
  return out;
}

/**
 * 从源码里抽状态字段。
 * templated 只看**值本身**：值里带 `${` 就是模板（如 `"mainBtnText":"${x}点开抢"`）。
 * 不看去人肉猜上下文窗口 —— 窗口抖动会让同一个字段时真时假。
 */
function scanStateFields(html) {
  const out = [];
  const seen = new Set();
  let m;
  STATE_KEY_RE.lastIndex = 0;
  while ((m = STATE_KEY_RE.exec(html)) !== null) {
    const val = String(m[2]).replace(/^"|"$/g, '');
    const key = m[1] + '=' + val;
    if (seen.has(key)) continue;
    seen.add(key);
    const strong = new RegExp('^(' + STRONG_KEYS + ')$').test(m[1]);
    const around = html.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    out.push({ key: m[1], value: val, strong, templated: isTemplateValue(val), ctx: around.replace(/\s+/g, ' ').trim() });
  }
  return out.filter((f) => {
    if (f.strong) return true;                       // 强键名：一律保留
    if (/^(true|false|\d+)$/.test(f.value)) return false; // 弱键名 + 裸布尔/数字：噪声
    return /购买|订阅|售罄|抢购|停|soon|sale|buy/i.test(f.value);
  });
}

/**
 * 判定「疑似登录墙」的可见文本长度上限。
 *
 * 为什么加这个闸：2026-09-28 扫 16 家时，「疑似登录墙」报了 4 次**全是误报**
 * （腾讯 Hy / 腾讯通用 / 京东云 / MiniMax）—— 触发源是页面顶部导航栏那句
 * 「登录 / 免费注册」，被 ±90 字符的上下文窗口捎带进来了。
 * 真的登录墙是另一副样子：渲染完整个页面只剩一个登录框，可见文本 105~240 字符
 * （小米 MiMo 240 / 讯飞 128 / UCloud 105），而非墙的页面是 1390~4843 字符。
 *
 * 所以判据改成：可见文本**短到不像一个正常页面**时，登录词才算墙。
 * textLen < 0 表示未知（离线分析纯文本等），这时退回只看登录词。
 */
const LOGIN_WALL_MAX_TEXT = 800;

/**
 * 登录墙的**宽**词表：单字「登录 / 注册」这种。
 * 只在文本短到不像正常页面时才启用 —— 长页面上光是顶部导航就有一句「登录」，
 * 用宽词表会立刻回到 4 次误报的老路；短页面上则相反，不放宽就会漏：
 * 小米 MiMo 渲染出来 568 字节整页都是登录表单，却一个四字词组都没有
 * （只有「登录」「注册」两个单字），旧判据给的是「无（人工判定）」。
 */
const LOGIN_LOOSE_RE = /(登录|注册|扫码|验证码|密码)/;

function verdictFrom(stateFields, textHits, textLen = -1, text = '') {
  const s = stateFields.filter((f) => !f.templated);
  const t = textHits.filter((h) => !h.templated);
  const has = (arr, kws) => arr.some((x) => kws.includes(x.kw || x.value));
  const notes = [];

  // 只有「明确」的关停词才判停，避免「结束」这类词被活动倒计时误伤
  const hardClosed = ['停止新购', '已停售', '停止购买', '暂停订阅', '暂停新购', '无法购买', '下架'];
  if (has(t, hardClosed)) notes.push('TEXT 出现明确停售词');
  if (s.some((f) => f.key === 'hasFlashSale' && f.value === 'false')) notes.push('STATE hasFlashSale=false（无秒杀）');
  if (s.some((f) => f.key === 'soldOut' && f.value === 'true')) notes.push('STATE soldOut=true');
  if (s.some((f) => /mainBtnText|btnText|buttonText/.test(f.key) && /购买|订阅/.test(f.value))) {
    notes.push('STATE 按钮文案=' + s.filter((f) => /mainBtnText|btnText|buttonText/.test(f.key)).map((f) => f.value).join('/'));
  }
  if (s.some((f) => /cornerMark|saleTag|tagText/.test(f.key) && /购买|订阅/.test(f.value))) {
    notes.push('STATE 角标=' + s.filter((f) => /cornerMark|saleTag|tagText/.test(f.key)).map((f) => f.value).join('/'));
  }
  if (has(t, BUY_WAIT)) notes.push('TEXT 出现「' + t.find((h) => BUY_WAIT.includes(h.kw)).kw + '」');
  if (has(t, BUY_LIMITED)) notes.push('TEXT 出现限量/售罄词：' + [...new Set(t.filter((h) => BUY_LIMITED.includes(h.kw)).map((h) => h.kw))].join('/'));
  const ctaHits = t.filter((h) => isPositiveCta(h.kw));
  if (ctaHits.length) notes.push('TEXT 出现购买 CTA：' + [...new Set(ctaHits.map((h) => h.kw))].join('/'));
  const looksLikeWall = textLen < 0 || textLen < LOGIN_WALL_MAX_TEXT;
  if (looksLikeWall && (has(t, BUY_LOGIN)
    || LOGIN_LOOSE_RE.test(t.map((h) => h.ctx).join(''))
    || LOGIN_LOOSE_RE.test(text.slice(0, 1200)))) {
    notes.push('疑似登录墙（可见文本 ' + (textLen < 0 ? '未知' : textLen) + ' 字符）');
  }
  // 兜底：页面短得不像话却一个购买信号都没有 —— 别让「（无）」被读成「没限制、可以买」
  if (textLen >= 0 && textLen < LOGIN_WALL_MAX_TEXT && !ctaHits.length
    && !t.some((h) => BUY_LIMITED.includes(h.kw) || BUY_CLOSED.includes(h.kw))) {
    notes.push('⚠ 可见文本仅 ' + textLen + ' 字符且无任何购买信号 —— 可能是登录墙/空壳，需人工看原文');
  }
  const tmplCount = textHits.filter((h) => h.templated).length;
  if (tmplCount) notes.push('⚠ ' + tmplCount + ' 处命中是文案模板（已排除，不计入判定）');
  return notes;
}

/**
 * 打印一份可购买性分析。
 *
 * 分四档，**每档都必须打印计数，即使为 0**。
 * 这条不是格式偏好：早先的版本只打印「模板命中」和「可见文本命中」，
 * 于是源码里 25 条真实命中（含 `"text":"立即订阅"`）一条都没显示，
 * 屏幕上只剩「（无）」—— 把「没有输出」读成「没有信号」正是本项目反复踩的坑。
 */
function report(label, url, html, text) {
  console.log('\n' + '='.repeat(72));
  console.log('【' + label + '】 ' + url);
  console.log('  HTML ' + html.length + ' B / 可见文本 ' + text.length + ' 字符');

  const stateFields = scanStateFields(html);
  const textHits = text ? scanKeywords(text) : [];
  const rawHits = scanKeywords(html);
  const rawReal = rawHits.filter((h) => !h.templated);
  const rawTmpl = rawHits.filter((h) => h.templated);
  const visHits = textHits.filter((h) => !h.templated);
  const stateReal = stateFields.filter((f) => !f.templated);

  console.log('\n  [A] STATE 状态字段（' + stateReal.length + ' 条，最硬：字段名即语义）');
  if (!stateReal.length) console.log('      （无）');
  stateReal.slice(0, 20).forEach((f) => console.log('      ' + (f.strong ? '★ ' : '  ') + f.key + ' = ' + JSON.stringify(f.value)));

  console.log('\n  [B] TEXT 渲染后可见文本命中（' + visHits.length + ' 条，硬：用户真能看到）');
  if (!text) console.log('      （未渲染，可见文本为空 —— 这不是「没有信号」）');
  else if (!visHits.length) console.log('      （无）');
  visHits.slice(0, 20).forEach((h) => console.log('      ' + h.kw + '  …' + h.ctx.slice(0, 150) + '…'));

  console.log('\n  [S] SRC 源码里的非模板命中（' + rawReal.length + ' 条，需人看上下文）');
  if (!rawReal.length) console.log('      （无）');
  rawReal.slice(0, 20).forEach((h) => console.log('      ' + h.kw + (h.key ? '  @' + h.key : '') + '  …' + h.ctx.slice(0, 150) + '…'));

  console.log('\n  [C] TMPL 模板 / 条件文案命中（' + rawTmpl.length + ' 条，**不是状态**，已排除）');
  if (!rawTmpl.length) console.log('      （无）');
  else {
    const byKw = {};
    rawTmpl.forEach((h) => { byKw[h.kw] = (byKw[h.kw] || 0) + 1; });
    console.log('      ' + Object.entries(byKw).map(([k, n]) => k + '×' + n).join('  '));
    rawTmpl.slice(0, 3).forEach((h) => console.log('      例：' + (h.key ? '@' + h.key + ' ' : '') + '…' + h.ctx.slice(0, 160) + '…'));
  }

  console.log('\n  → 线索：');
  const notes = verdictFrom(stateFields, textHits, text.length, text);
  if (!notes.length) console.log('      无（人工判定）');
  notes.forEach((n) => console.log('      · ' + n));
}

/** 解析 --actions='[{"scroll":"bottom","wait":2500}]'，给临时探针用 */
function parseActions(s) {
  if (!s) return undefined;
  try { const a = JSON.parse(s); return Array.isArray(a) && a.length ? a : undefined; }
  catch (e) { console.log('⚠ --actions 不是合法 JSON，忽略：' + e.message); return undefined; }
}

async function main() {
  const argv = process.argv.slice(2);
  const valueOf = (f) => { const h = argv.find((a) => a.startsWith(f + '=')); return h ? h.slice(f.length + 1) : null; };
  const has = (f) => argv.includes(f);
  const listFile = valueOf('--list');
  const plansArg = valueOf('--plans');
  const fromSources = has('--from-sources');
  const fileArg = valueOf('--file');

  // 离线模式：直接分析已落盘的 HTML / 渲染文本，不再联网。
  // 用途：判据改过之后，用它确认「对同一批旧证据，新判据得出的结论没变」。
  // 放在最前面：它不需要解析目标 URL，也就没理由因为缺 --url 而退出。
  if (fileArg) {
    if (!selfTest()) { console.log('自测未通过，中止'); process.exit(1); }
    const p = path.resolve(fileArg);
    const raw = fs.readFileSync(p, 'utf8');
    const isText = /\.txt$/i.test(p);
    report(path.basename(p), p, isText ? '' : raw, isText ? raw : '');
    return;
  }

  let targets;
  if (listFile) {
    targets = JSON.parse(fs.readFileSync(path.resolve(listFile), 'utf8'));
  } else if (plansArg || fromSources) {
    // 直接按套餐 id 从 sources.json 取入口 —— 复审时不必手抄 URL，
    // 也就不会出现「探针查的地址和采集器用的地址不是一个」这种割裂。
    const srcs = JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8')).sources;
    const want = plansArg ? plansArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const picked = want ? srcs.filter((s) => want.some((w) => s.planId.indexOf(w) >= 0)) : srcs;
    if (want && !picked.length) { console.log('没匹配到任何套餐：' + plansArg); process.exit(1); }
    targets = picked.map((s) => ({
      planId: s.planId, url: s.url, render: !!(s.render || !s.extract || s.status === 'spa' || s.status === 'login' || s.status === 'headline-only'),
      waitFor: s.render && s.render.waitFor ? s.render.waitFor : null,
      actions: s.render && s.render.actions ? s.render.actions : undefined,
      status: s.status,
    }));
  } else {
    const u = valueOf('--url');
    if (!u) { console.log('用法: node probe-purchase.js --url=<URL> [--render] [--waitFor=x]'); console.log('      node probe-purchase.js --plans=zhipu,huawei,tencent'); console.log('      node probe-purchase.js --from-sources'); console.log('      node probe-purchase.js --list=targets.json'); console.log('      node probe-purchase.js --file=fixtures/cards-huawei.html（离线看已抓页面）'); process.exit(1); }
    targets = [{ planId: 'adhoc', url: u, render: has('--render'), waitFor: valueOf('--waitFor') || null, actions: parseActions(valueOf('--actions')) }];
  }

  // 前置自测：模板误报的分类逻辑必须先通过，否则后面看到的数字都不可信
  if (!selfTest()) { console.log('自测未通过，中止'); process.exit(1); }

  let renderer = null;
  const needRender = targets.some((t) => t.render);
  if (needRender && findBrowser(null)) {
    console.log('启动渲染后端…');
    renderer = await createRenderer({});
  } else if (needRender) {
    console.log('⚠ 未找到本机 Chrome/Edge，需要渲染的目标将被跳过');
  }

  // --save=dir：把抓到的 HTML 与渲染后的可见文本落盘。
  // 探针只打印「命中」，可购买性却常常要在**没命中**的地方下判断
  // （比如京东云那页渲染出来根本不是定价页），所以必须能回头看原文。
  const saveDir = valueOf('--save');
  if (saveDir) { fs.mkdirSync(path.resolve(saveDir), { recursive: true }); console.log('落盘目录：' + path.resolve(saveDir)); }

  try {
    for (const t of targets) {
      let html = '', text = '';
      const r = await fetchPage(t.url, { timeout: 20000 }).catch((e) => ({ ok: false, error: e.message, body: '', text: '' }));
      html = r.body || r.html || '';
      if (!r.ok) console.log('\n（静态抓取失败：' + (r.error || 'unknown') + '，将尝试渲染）');
      if (t.render && renderer) {
        process.stdout.write('  渲染中 ' + t.url + ' … ');
        // 参数与 run.js 对齐：waitFor 缺省值也用价格形态，避免「页面没有那个词就干等」
        const opts = {
          waitFor: t.waitFor || '元|¥|￥',
          settle: 2000,
          waitForMax: 12000,
          timeout: 35000,
        };
        if (Array.isArray(t.actions) && t.actions.length) opts.actions = t.actions;
        const rr = await renderer.render(t.url, opts);
        console.log(rr.ok ? rr.ms + 'ms' : '失败：' + rr.error);
        if (rr.ok) { html = rr.html || html; text = rr.text || ''; }
      }
      report(t.planId || t.label || t.url, t.url, html, text);

      if (saveDir) {
        const stem = (t.planId || 'adhoc').replace(/[^\w.-]+/g, '_');
        if (html) fs.writeFileSync(path.join(saveDir, stem + '.html'), html);
        if (text) fs.writeFileSync(path.join(saveDir, stem + '.txt'), text);
        console.log('  已落盘 ' + stem + '.html (' + html.length + ' B)' + (text ? ' + .txt (' + text.length + ' 字符)' : ''));
      }
    }
  } finally {
    if (renderer) await renderer.close();
  }
}

/**
 * 自测：模板误报规则必须真的能把华为那种「源码里有『已售罄』、页面上没有」区分出来。
 * 这个自测的存在理由：如果分类逻辑坏了，探针会安静地给出相反的结论 —— 比报错危险。
 */
function selfTest() {
  const ok = (c, m) => { if (!c) { console.log('  ✗ ' + m); return false; } console.log('  ✓ ' + m); return true; };
  let all = true;
  console.log('自测：模板 / 条件文案 vs 状态');
  const huaweiLike = '{"afterFlashSaleMainBtnText":"秒杀已结束","runoutFlashSaleMainBtnText":"已售罄，请次日来抢",'
    + '"beforeFlashSaleMainBtnText":"${startTime}点开抢","flashSaleProgressTemplate":"已抢购${progress}%",'
    + '"hasFlashSale":false,"button":{"mainBtnText":"立即订阅"}}';
  const hits = scanKeywords(huaweiLike);
  const soldoutHit = hits.find((h) => h.kw === '已售罄');
  all = ok(!!soldoutHit && soldoutHit.templated === true, '「已售罄」被判为条件文案（不靠 ${，靠键名 runout…Text）') && all;
  all = ok(!!soldoutHit && soldoutHit.key === 'runoutFlashSaleMainBtnText', '抽出该命中的键名作为依据') && all;
  const endedHit = hits.find((h) => h.kw === '结束');
  all = ok(!!endedHit && endedHit.templated === true, '「秒杀已结束」同为条件文案（after…Text）') && all;
  const interp = hits.find((h) => h.kw === '抢购' && h.templated === true);
  all = ok(!!interp, '含 ${ 的「已抢购${progress}%」被判为模板') && all;

  const fields = scanStateFields(huaweiLike);
  const fs2 = fields.find((f) => f.key === 'hasFlashSale');
  all = ok(!!fs2 && fs2.value === 'false' && fs2.templated === false && fs2.strong === true, 'hasFlashSale=false 是可信强状态') && all;
  const mb = fields.find((f) => f.key === 'mainBtnText');
  all = ok(!!mb && mb.value === '立即订阅' && mb.templated === false, 'mainBtnText=立即订阅 被抽出且不是模板') && all;

  const notes = verdictFrom(fields, hits);
  all = ok(!!notes.find((n) => n.includes('hasFlashSale=false')), '判定线索引用真实状态字段') && all;
  all = ok(!notes.find((n) => n.includes('限量/售罄词')), '模板里的售罄词没有进「限量/售罄」线索') && all;

  const clean = scanKeywords('已售罄\n立即购买');
  all = ok(clean.every((h) => h.templated === false), '渲染后的纯文本不被误判为模板') && all;

  // 反例守卫：若有人把判据改回「只看值里有没有 ${」，这一条会挂
  const plain = scanKeywords('{"runoutFlashSaleMainBtnText":"已售罄"}');
  all = ok(plain.find((h) => h.kw === '已售罄').templated === true, '守卫：无 ${ 但键名是条件文案，仍须判为模板') && all;

  // ── CTA 形态（2026-09-28 扫 opencode / cursor 时补的）─────────────
  // 这两家页面明写着可以订阅，词表里却没有对应的词，探针给出 0 命中。
  // 守卫用**真实页面上的原句**，不是我编的样例。
  const opencodeLike = scanKeywords('订阅 Go $10/月\n可配合任何代理使用。每月 $10。随时取消。');
  all = ok(opencodeLike.some((h) => h.kw === '订阅 Go' && !h.templated), '「订阅 Go」按形态判为购买 CTA（opencode.ai/go 原句）') && all;
  all = ok(verdictFrom([], opencodeLike, 1036).some((n) => n.includes('购买 CTA')), 'opencode 的线索里出现购买 CTA') && all;

  const cursorLike = scanKeywords('$20 / mo. Pro Pro+ Ultra 获取 Pro 团队版 $40 / user / mo.');
  all = ok(cursorLike.some((h) => h.kw === '获取 Pro' && !h.templated), '「获取 Pro」按形态判为购买 CTA（cursor.com/cn/pricing 原句）') && all;

  // 反例守卫：「获取 API Key」是接入指引，不是购买按钮 —— 联通页真实存在这句话
  const apiKey = scanKeywords('3步开启 AI 编程之旅 订阅套餐 选择Lite/Pro/Max套餐 获取 API Key 和 Base URL 控制台一键获取');
  all = ok(!apiKey.some((h) => h.kw === '获取 API'), '守卫：「获取 API Key」不算购买 CTA（联通页原句）') && all;
  all = ok(!verdictFrom([], apiKey, 2242).some((n) => n.includes('购买 CTA') && n.includes('API')), '守卫：API 语境不进 CTA 线索') && all;

  // 「订阅套餐」不能被形态匹配切成「订阅」而丢掉精确命中
  const subCn = scanKeywords('订阅套餐 选择Lite/Pro/Max套餐');
  all = ok(subCn.every((h) => h.kw !== '订阅'), '守卫：中文档位名不触发形态匹配（仍走词表「订阅套餐」）') && all;

  // 守卫：CTA 不得跨行。渲染文本逐行拼接，「立即购买\nHy 个人版」在文本里连着、
  // 在页面上却是两句话。写成 \\s* 就会凭空造出「立即购买\nHy」这种假 CTA（腾讯页原句）。
  const acrossLines = scanKeywords('立即购买\nHy 个人版–基础套餐（Standard） 每订阅月 1560 积分');
  all = ok(!acrossLines.some((h) => /\n/.test(h.kw)), '守卫：CTA 形态不跨行匹配（腾讯页「立即购买\\nHy 个人版」）') && all;
  all = ok(acrossLines.some((h) => h.kw === '立即购买'), '同一句仍保留词表的精确命中') && all;

  // 守卫：FAQ 问句不算 CTA
  const faq1 = scanKeywords('购买 Cursor 吗？\n↓\n我可以在哪里提出更多疑问？');
  all = ok(!faq1.some((h) => isPositiveCta(h.kw) && /Cursor/.test(h.kw)), '守卫：FAQ「购买 Cursor 吗？」不算 CTA（cursor 页原句）') && all;
  const faq2 = scanKeywords('购买 Agent Plan 后，是否需要单独开通模型和创意服务？');
  all = ok(!faq2.some((h) => isPositiveCta(h.kw) && /Agent/.test(h.kw)), '守卫：FAQ「购买 Agent Plan 后，是否需要…」不算 CTA（火山页原句）') && all;

  // ── 限量词（华为页补的）────────────────────────────────────────
  const huaweiLimit = scanKeywords('Token Plan 个人版 限个人用户购买，每个用户限购1个套餐，数量有限，先到先得');
  all = ok(huaweiLimit.some((h) => h.kw === '限购'), '「限购」进限量词命中（华为页原句）') && all;
  all = ok(huaweiLimit.some((h) => h.kw === '数量有限') && huaweiLimit.some((h) => h.kw === '先到先得'), '「数量有限」「先到先得」进限量词命中') && all;
  const volcanoLimit = scanKeywords('Small 和 Medium 套餐限时折扣，名额有限，先到先得');
  all = ok(volcanoLimit.some((h) => h.kw === '名额有限'), '「名额有限」进限量词命中（火山 Agent Plan 原句）') && all;

  // ── 登录墙判据（扫 16 家时 4 次误报后收紧的）───────────────────
  // 真墙：渲染完只剩登录框，可见文本极短。非墙：整页营销内容 + 顶部导航里的「登录」。
  const realWall = scanKeywords('短信登录 账号登录 未注册手机号验证通过后将自动注册 立即注册 找回密码');
  all = ok(verdictFrom([], realWall, 105).some((n) => n.includes('疑似登录墙')), '短文本 + 登录词 = 疑似登录墙（UCloud 105 字符）') && all;
  const navLogin = '腾讯云大模型 Token Plan 控制台 登录 免费注册 立即购买 日常价：28.00 元/月 立即购买';
  all = ok(!verdictFrom([], scanKeywords(navLogin), 4010, navLogin).some((n) => n.includes('疑似登录墙')), '守卫：4010 字符的正常页面，顶部导航「登录」不再误报登录墙（腾讯页）') && all;
  all = ok(verdictFrom([], scanKeywords(navLogin), 4010, navLogin).some((n) => n.includes('购买 CTA')), '同一页仍正常报出购买 CTA') && all;

  // 小米 MiMo：整页就是登录表单，但只有「登录」「注册」两个单字，四字词组一个都没有。
  // 旧判据在这里给的是「无（人工判定）」—— 把登录页读成了「没信号」。
  const xiaomiWall = '小米账号\n用户协议隐私政策帮助中心\n登录\n注册\n邮箱/手机号码/小米ID\n密码\n已阅读并同意小米账号使用协议\n登录\n忘记密码？\n手机号登录\n其他方式登录';
  all = ok(verdictFrom([], scanKeywords(xiaomiWall), xiaomiWall.length, xiaomiWall).some((n) => n.includes('疑似登录墙')), '单字「登录/注册」在短页面上也判为登录墙（小米 MiMo 渲染原文）') && all;
  return all;
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) { process.exit(selfTest() ? 0 : 1); }
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  scanKeywords, scanStateFields, verdictFrom, selfTest,
  isTemplateValue, keyIsConditionalLabel, enclosingKey, hitIsTemplate,
  isPositiveCta, LOGIN_WALL_MAX_TEXT,
  BUY_POSITIVE, BUY_LIMITED, BUY_CLOSED, BUY_LOGIN, BUY_WAIT,
};
