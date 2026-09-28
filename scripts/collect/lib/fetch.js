'use strict';
/**
 * 抓取器：超时、重试、UA、体积上限、编码探测
 * 不做 HTML 解析，只负责拿到「能用的文本」。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_BYTES = 4 * 1024 * 1024; // 超过 4MB 认为不是定价页，直接截断

/**
 * @returns {Promise<{ok:boolean,status:number,body:string,bytes:number,ms:number,error?:string,notes:string[]}>}
 */
async function fetchPage(url, opts = {}) {
  const timeout = opts.timeout || 20000;
  const retries = opts.retries == null ? 1 : opts.retries;
  const notes = [];
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: {
          'User-Agent': opts.ua || DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      clearTimeout(timer);

      const buf = Buffer.from(await res.arrayBuffer());
      let bytes = buf.length;
      let slice = buf;
      if (bytes > MAX_BYTES) {
        slice = buf.subarray(0, MAX_BYTES);
        notes.push('响应 ' + (bytes / 1048576).toFixed(1) + 'MB，已截断到 4MB');
      }

      const head = slice.subarray(0, 4096).toString('latin1');
      const ctype = head.match(/charset=["']?([\w-]+)/i);
      const declared = ctype ? ctype[1].toLowerCase() : null;
      let body;
      if (declared && /^(gb2312|gbk|gb18030)$/.test(declared)) {
        // 国内站点偶有 GBK 页面，用 Node 内置解码
        try {
          body = new TextDecoder('gb18030').decode(slice);
          notes.push('按 ' + declared + ' 解码');
        } catch (e) {
          body = slice.toString('utf8');
          notes.push('声明 ' + declared + ' 但解码失败，回退 utf8');
        }
      } else {
        body = slice.toString('utf8');
      }

      if (res.url && res.url !== url) notes.push('跳转到 ' + res.url);

      return { ok: res.ok, status: res.status, body, bytes, ms: Date.now() - started, notes };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? '超时 ' + timeout + 'ms' : e.message;
      if (attempt < retries) notes.push('第 ' + (attempt + 1) + ' 次失败（' + lastErr + '），重试');
    }
  }
  return { ok: false, status: 0, body: '', bytes: 0, ms: 0, error: lastErr, notes };
}

/** 带并发上限的批量抓取 */
async function fetchAll(jobs, concurrency = 4) {
  const out = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}

module.exports = { fetchPage, fetchAll, DEFAULT_UA, MAX_BYTES };
