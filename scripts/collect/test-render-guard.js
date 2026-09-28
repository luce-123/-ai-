#!/usr/bin/env node
'use strict';
/**
 * 渲染器"卡死防护"回归测试。
 *
 * 起因：probe-jsonld.js 全量扫描跑了 18 分钟一个字没输出，进程活着但完全不推进。
 * 根因不是某个来源"慢"，而是渲染器里存在**没有超时的 await**：
 *   - cdp.send('Page.enable' / 'Runtime.enable' / 'Page.navigate' / 'Runtime.evaluate')
 *   - close() 里访问 Chrome 调试口的 fetch（Node 的 fetch 默认不超时）
 * 抓的是别人家的页面，"对方页面把渲染进程卡住"是常态。只要有一处没有超时，
 * 那个来源就会永久占住一个 fetchAll worker；闸门槽位也永不归还，
 * 于是整个扫描静默死掉 —— 不报错、不退出、不打日志。
 *
 * 这个测试用一个**主线程被死循环占住**的本地页面来复现那个状态：
 * 页面解析时进入 while(true)，渲染进程不再响应任何 CDP 指令。
 *
 * 断言：
 *   1. 正常页面能渲染成功（先证明后端本身可用，别把环境问题当成修好了）
 *   2. 卡死页面在硬上限内返回失败，而不是挂住 —— 这是核心
 *   3. 卡死那次之后，同一个浏览器实例仍能正常渲染别的页面（不会被连带毒死）
 *   4. close() 有耗时上限（它会在打印结果之前被调用，卡在这里等于结果全丢）
 */

const http = require('http');
const { createRenderer, findBrowser } = require('./lib/render');

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fails.push(label + (extra ? ' —— ' + extra : '')); console.log('  ✗ ' + label + (extra ? ' —— ' + extra : '')); }
}

const OK_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<title>正常页</title></head><body>'
  + '<h1>套餐</h1><div>体验版 日常价：28 元/月</div><div>专业版 日常价：468 元/月</div>'
  + '</body></html>';

// 解析阶段就进死循环：渲染进程的主线程再也不空闲，CDP 的 Runtime.evaluate 永远不回。
const HANG_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<title>卡死页</title></head><body><h1>加载中</h1>'
  + '<script>while(true){}</script>'
  + '</body></html>';

(async () => {
  if (!findBrowser()) {
    console.log('未找到本机 Chrome/Edge，跳过渲染器防护测试');
    process.exit(0);
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/hang' ? HANG_PAGE : OK_PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  let r = null;
  try {
    console.log('== 渲染器卡死防护 ==');
    r = await createRenderer();

    // 1. 基线：后端本身能用
    const good = await r.render(base + '/ok', { waitFor: '元/月', settle: 300, waitForMax: 5000, timeout: 15000 });
    ok(good.ok && /日常价/.test(good.text), '正常页面能渲染出内容', 'ok=' + good.ok + ' text=' + good.text.slice(0, 40));

    // 2. 核心：卡死页面必须"到点就失败"，不能挂住
    const HARD = 6000;
    const t0 = Date.now();
    const hung = await r.render(base + '/hang', {
      waitFor: '元/月', settle: 300, waitForMax: 1500, timeout: 3000, hardTimeout: HARD,
    });
    const hungMs = Date.now() - t0;
    ok(!hung.ok, '卡死页面返回失败而不是挂住');
    ok(/超时/.test(hung.error || ''), '失败原因说明了是超时', 'error=' + hung.error);
    ok(hungMs < HARD + 5000, '在硬上限附近返回（实测 ' + hungMs + 'ms，上限 ' + HARD + 'ms）');

    // 3. 卡死那次之后，实例还能继续干活 —— 一个坏页面不该毒死整轮采集
    const after = await r.render(base + '/ok', { waitFor: '元/月', settle: 300, waitForMax: 5000, timeout: 15000 });
    ok(after.ok && /468/.test(after.text), '卡死之后仍能正常渲染其他页面', 'ok=' + after.ok);

    // 4. close() 必须有上限：它在打印结果之前调用，卡住等于结果全丢
    const t1 = Date.now();
    await Promise.race([
      r.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('close 卡住')), 15000)),
    ]).then(() => ok(true, 'close() 未卡住（' + (Date.now() - t1) + 'ms）'))
      .catch((e) => ok(false, 'close() 未卡住', e.message));
    r = null;
  } catch (e) {
    ok(false, '测试整体执行未抛异常', e.message);
  } finally {
    if (r) { try { await r.close(); } catch (e) { /* ignore */ } }
    server.close();
  }

  console.log('\n通过 ' + pass + ' / ' + (pass + fails.length));
  if (fails.length) { fails.forEach((f) => console.log('  失败: ' + f)); process.exit(1); }
})();
