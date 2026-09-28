'use strict';
/**
 * 浏览器渲染后端 —— 通过 Chrome DevTools Protocol 直连本机 Chrome/Edge。
 *
 * 为什么不用 puppeteer/playwright：
 *   - 它们要下载 ~500MB 自带 Chromium；本机已有 Chrome，CDP 直连零新增依赖
 *   - Node 22 内置全局 WebSocket，够用了
 *
 * 设计要点：
 *   1. 一个 Chrome 实例服务全部来源（启动一次约 1s，每个页面只是新开一个 target）
 *   2. 等「价格文本出现」而不是死等固定时长 —— 既快又稳
 *   3. 每个 target 用完即关，避免标签页堆积
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_HTML = 6 * 1024 * 1024;

/** 按优先级找本机浏览器：Chrome 优先，Edge 兜底 */
function findBrowser(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const env = process.env;
  const local = env.LOCALAPPDATA || '';
  const pf = env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  if (process.platform === 'win32') {
    candidates.push(
      path.join(local, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge'
    );
  }
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 生成「点击」的页面内代码。支持两种定位方式：
 *   'text=Hy 系列'  按可见文本完全匹配（tab 通常没有稳定 id，只能靠文本）
 *   '#tab-2'        普通 CSS 选择器
 *
 * 用 DOM 的 .click() 而不是合成鼠标事件：前端框架的 tab 基本都监听 click，
 * 而合成 PointerEvent 在部分框架上反而触发不了。
 * 文本匹配要求元素可见（宽高 > 2px），否则会点到隐藏的同名节点。
 */
function clickExpr(target) {
  return '(function(){'
    + 'var sel=' + JSON.stringify(String(target)) + ';'
    + 'var el=null,how="";'
    + 'if(sel.indexOf("text=")===0){'
    + '  var want=sel.slice(5).replace(/\\s+/g," ").trim();'
    + '  var all=document.querySelectorAll("button,a,[role=tab],[role=button],li,label,span,div,p");'
    + '  for(var i=0;i<all.length;i++){'
    + '    var t=(all[i].textContent||"").replace(/\\s+/g," ").trim();'
    + '    if(t!==want) continue;'
    + '    var r=all[i].getBoundingClientRect();'
    + '    if(r.width<2||r.height<2) continue;'
    + '    el=all[i];how="text";break;'
    + '  }'
    + '}else{ el=document.querySelector(sel); how="selector"; }'
    + 'if(!el) return {ok:false,reason:how==="text"?("找不到可见文本 ["+sel.slice(5)+"]"):"选择器无匹配"};'
    + 'var rr=el.getBoundingClientRect();'
    + 'if(rr.width<2||rr.height<2) return {ok:false,reason:"元素不可见"};'
    + 'try{ el.scrollIntoView({block:"center"}); }catch(e){}'
    + 'el.click();'
    + 'return {ok:true,text:(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,40)};'
    + '})()';
}

/**
 * 极简 CDP 客户端：一条 WebSocket，按 id 配对响应。
 *
 * 关键点：**每条指令都必须有超时**。CDP 是请求/响应式的，如果标签页那边不再回应
 * （页面里跑了死循环、渲染进程被 OOM kill、Chrome 被系统挂起），响应永远不来，
 * await 就会永久悬停。而渲染器是用来抓别人家页面的，「对方页面有问题」是常态而非异常，
 * 所以绝不能假设响应一定会到。
 *
 * 同理，连接断开/出错时要把所有等待中的 promise 一起拒掉 —— 否则调用方
 * 等的是一个再也不会被兑现的承诺。
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.dead = null;
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch (e) { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const ls = this.listeners.get(msg.method);
        if (ls) ls.forEach((fn) => fn(msg.params));
      }
    });

    // 断线联级拒绝：一次拒掉所有在飞的指令，别让它们各自等到自己的超时
    const die = (reason) => {
      if (this.dead) return;
      this.dead = reason;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      // 等事件的监听者也要唤醒（传 null），否则 once() 只能等自己的超时兜底
      this.listeners.forEach((ls) => ls.slice().forEach((fn) => fn(null)));
    };
    ws.addEventListener('close', () => die('CDP 连接已关闭'));
    ws.addEventListener('error', () => die('CDP 连接出错'));
  }
  send(method, params = {}, timeoutMs = 20000) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP ' + method + ' 超时 ' + timeoutMs + 'ms'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const arr = this.listeners.get(method) || [];
      let timer = null;
      const fn = (p) => {
        // 事件先到就必须撤掉兜底定时器。否则它会让 Node 的事件循环多活满一个 timeout，
        // 表现为"活干完了、进程却迟迟不退"，批量跑起来就会在收尾处被外部超时杀掉。
        if (timer) clearTimeout(timer);
        const cur = this.listeners.get(method) || [];
        this.listeners.set(method, cur.filter((x) => x !== fn));
        resolve(p);
      };
      arr.push(fn);
      this.listeners.set(method, arr);
      if (timeoutMs) {
        timer = setTimeout(() => {
          const cur = this.listeners.get(method) || [];
          this.listeners.set(method, cur.filter((x) => x !== fn));
          resolve(null);
        }, timeoutMs);
      }
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

/**
 * 启动一个可复用的浏览器实例。
 * @returns {Promise<{render:Function, close:Function, exe:string, port:number}>}
 */
async function createRenderer(opts = {}) {
  const exe = findBrowser(opts.exe);
  if (!exe) {
    const err = new Error('未找到本机 Chrome/Edge，无法启用渲染后端');
    err.code = 'NO_BROWSER';
    throw err;
  }
  // CDP 端口：显式指定，或让 Chrome 用 0 自选（读取 DevToolsActivePort）
  const port = opts.port || 0;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-collect-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1440,900',
    '--lang=zh-CN',
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  // 等 DevToolsActivePort 文件出现（Chrome 自己写下实际端口）
  const portFile = path.join(profile, 'DevToolsActivePort');
  let realPort = port;
  const deadline = Date.now() + (opts.startTimeout || 25000);
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const txt = fs.readFileSync(portFile, 'utf8').split('\n');
      if (txt[0] && Number(txt[0])) { realPort = Number(txt[0]); break; }
    }
    if (proc.exitCode != null) throw new Error('浏览器进程提前退出（code ' + proc.exitCode + '）');
    await sleep(120);
  }
  if (!realPort) throw new Error('浏览器未在超时内就绪');

  const base = 'http://127.0.0.1:' + realPort;

  /**
   * 访问 Chrome 的 DevTools HTTP 接口。
   * 这里的 fetch 也必须带超时：浏览器卡死时这个口是不响应的，
   * 而 Node 的 fetch 默认没有超时，会一直挂着（实测能把整个采集任务锁死十几分钟）。
   */
  async function httpJson(pathname, method = 'GET', timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(base + pathname, { method, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' (' + pathname + ')');
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 新版 Chrome 要求 PUT
  const jsonNew = () => httpJson('/json/new?about:blank', 'PUT', 8000);

  async function jsonClose(id) {
    try { await httpJson('/json/close/' + id, 'GET', 4000); } catch (e) { /* 关不掉不影响结果 */ }
  }

  /**
   * 渲染一个页面，返回渲染后的完整 HTML。
   *
   * 外层是「硬上限」护栏：内部每一步虽然都有自己的超时，但步骤是串起来的
   * （导航 + 交互 + 轮询 + 取值），串起来的代价就是耗时会累加，而且任何一处
   * 漏加超时都会把调用方永久挂住。所以这里再兜一层 —— 到点直接判失败返回，
   * 让上层能继续处理下一个来源。**抓取任务绝不能被一个坏页面拖死。**
   *
   * @param {string} url
   * @param {object} o
   *   o.timeout     导航超时 ms（默认 30s）
   *   o.settle      load 之后再等多久让前端把数据渲染出来（默认 2500ms）
   *   o.waitFor     正则字符串；body 文本命中即提前结束等待（如 '¥'）
   *   o.waitForMax  命中等待的上限 ms（默认 12s）
   *   o.actions     [{click:'text=…', wait:1500}|{scroll:'bottom'}]
   *   o.hardTimeout 硬上限 ms；默认按各阶段实测最坏值自动推算（再留 10s 余量）
   */
  async function render(url, o = {}) {
    const started = Date.now();
    const timeout = o.timeout || 30000;
    const actions = Array.isArray(o.actions) ? o.actions : [];
    const actWait = actions.reduce((a, x) => a + (x.wait == null ? 800 : x.wait), 0);
    const waitMax = o.waitForMax || 12000;
    const hard = o.hardTimeout || (timeout + actWait + waitMax + 10000);

    // 硬超时触发时，Promise.race 只是让调用方不再等待，被抛在后面的渲染并不会自己停下。
    // 所以顺手把 WebSocket 掐掉：连接一断，在飞的 CDP 指令会立刻被拒，
    // 那条后台的渲染流程就会顺着自己的 catch 正常收尾，不会变成泄漏。
    const holder = { cdp: null, target: null };
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (holder.cdp) holder.cdp.close();
        reject(new Error('渲染硬超时 ' + hard + 'ms（卡在页面加载或某条 CDP 指令上）'));
      }, hard);
    });
    try {
      return await Promise.race([
        renderOnce(url, o, { timeout, settle: o.settle == null ? 2500 : o.settle, waitMax, holder }),
        guard,
      ]);
    } catch (e) {
      return {
        ok: false, status: 0, html: '', text: '', ms: Date.now() - started,
        error: e.message, notes: ['⚠ ' + e.message], extra: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 真正的渲染流程（每一步都带超时，外层另有硬上限兜底） */
  async function renderOnce(url, o, cfg) {
    const started = Date.now();
    const notes = [];
    const { timeout, settle, waitMax, holder } = cfg;
    let target = null;
    let cdp = null;
    try {
      target = await jsonNew();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      try {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
          ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
          ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP 连接失败')); });
        });
      } catch (e) {
        // 连不上也要把套接字关掉：此时 cdp 还是 null，finally 里的 cdp.close() 兜不住它，
        // 一个悬着的 WebSocket 会一直钉住事件循环（进程干完活也不退）。
        try { ws.close(); } catch (e2) { /* ignore */ }
        throw e;
      }
      cdp = new Cdp(ws);
      holder.cdp = cdp;

      // 每条指令都显式给超时。这里给得比较短（8s）：对方页面把渲染进程拖住时，
      // 早失败比晚失败有用 —— 上层还有重试的机会。
      await cdp.send('Page.enable', {}, 8000);
      await cdp.send('Runtime.enable', {}, 8000);
      await cdp.send('Network.enable', {}, 5000).catch(() => {});

      const loaded = cdp.once('Page.loadEventFired', timeout);
      await cdp.send('Page.navigate', { url }, timeout);
      const gotLoad = await loaded;
      if (!gotLoad) notes.push('未等到 load 事件，继续尝试读取 DOM');

      // 页面级交互：定价 tab、「查看更多」、懒加载 —— 不点一下/滚一下，价格根本不在 DOM 里。
      // actions 在 waitFor 之前执行，所以「先切到目标 tab，再等价格出现」是天然支持的。
      if (Array.isArray(o.actions) && o.actions.length) {
        for (const act of o.actions) {
          if (act.click) {
            const r2 = await cdp.send('Runtime.evaluate', {
              expression: clickExpr(act.click),
              returnByValue: true,
            }, 8000).catch(() => null);
            const v = r2 && r2.result ? r2.result.value : null;
            if (v && v.ok) notes.push('点击「' + v.text + '」');
            else notes.push('点击未命中（' + (v ? v.reason : 'evaluate 失败') + '）：' + act.click);
          } else if (act.scroll) {
            await cdp.send('Runtime.evaluate', {
              expression: act.scroll === 'top'
                ? 'window.scrollTo(0,0)'
                : 'window.scrollTo(0,document.body.scrollHeight)',
              returnByValue: true,
            }, 8000).catch(() => {});
            notes.push('滚动到' + (act.scroll === 'top' ? '顶部' : '底部'));
          }
          await sleep(act.wait == null ? 800 : act.wait);
        }
      }

      // 先固定等一小会儿，再按 waitFor 轮询
      const waitForRe = o.waitFor ? new RegExp(o.waitFor) : null;
      const waitDeadline = Date.now() + waitMax;
      let hit = false;
      await sleep(Math.min(settle, 800));
      while (true) {
        const probe = await cdp.send('Runtime.evaluate', {
          expression: '(document.body?document.body.innerText:"")',
          returnByValue: true,
        }, 6000).catch(() => null);
        const text = probe && probe.result ? String(probe.result.value || '') : '';
        if (waitForRe && waitForRe.test(text)) { hit = true; notes.push('命中等待条件'); break; }
        if (Date.now() > waitDeadline) break;
        if (!waitForRe && Date.now() - started > settle) break;
        await sleep(400);
      }
      if (waitForRe && !hit) notes.push('等待条件未命中（可能价格未渲染）');

      const res = await cdp.send('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      }, 15000);
      let html = res && res.result ? String(res.result.value || '') : '';
      if (html.length > MAX_HTML) {
        notes.push('渲染后 HTML ' + (html.length / 1048576).toFixed(1) + 'MB，已截断');
        html = html.slice(0, MAX_HTML);
      }
      // 顺带把可见文本也带出来，便于按文本正则提取（很多 SPA 价格在文本节点里）
      const textRes = await cdp.send('Runtime.evaluate', {
        expression: '(document.body?document.body.innerText:"")',
        returnByValue: true,
      }, 6000).catch(() => null);
      const text = textRes && textRes.result ? String(textRes.result.value || '') : '';

      // 可选的任意取值脚本：用来读回页面结构（如"有哪些可点的 tab"），
      // 不必为了拿一点信息就在调用方再起一次渲染。
      let extra = null;
      if (o.eval) {
        const ex = await cdp.send('Runtime.evaluate', { expression: o.eval, returnByValue: true }, 8000).catch(() => null);
        extra = ex && ex.result ? ex.result.value : null;
      }

      return { ok: html.length > 0, status: 200, html, text, ms: Date.now() - started, notes, extra };
    } catch (e) {
      return { ok: false, status: 0, html: '', text: '', ms: Date.now() - started, error: e.message, notes, extra: null };
    } finally {
      holder.cdp = null;
      holder.target = null;
      if (cdp) cdp.close();
      if (target && target.id) await jsonClose(target.id);
    }
  }

  /** 跑个命令、只关心它结束（不关心输出） */
  function runQuiet(cmd, args) {
    return new Promise((resolve) => {
      try {
        const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
        c.on('close', resolve);
        c.on('error', resolve);
      } catch (e) { resolve(); }
    });
  }

  async function close() {
    // 「先关标签页、再关进程」是礼貌做法，但浏览器卡死时这一步会去等一个不会来的响应，
    // 而 close() 通常在打印结果之前调用 —— 那就变成了「活干完了、结果一个字没出」。
    // 采集结束没必要客气：直接杀进程树（含所有渲染子进程），再删临时 profile。
    try { proc.kill(); } catch (e) { /* ignore */ }
    // Windows 下子进程可能不随父进程退不了，/T 连整棵进程树一起收
    if (process.platform === 'win32' && proc.pid) {
      await runQuiet('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    }
    // 文件句柄释放有个时间差，删不掉就再试；实在删不掉也只是留个临时目录，不该让任务失败
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); return; }
      catch (e) { await sleep(300); }
    }
  }

  return { render, close, exe, port: realPort, base };
}

module.exports = { createRenderer, findBrowser, clickExpr };
