'use strict';
/**
 * CodePlan 比价 App —— Service Worker
 *
 * 缓存策略只有两条，刻意简单：
 *   1. App 外壳（HTML/CSS/JS/图标/数据）：stale-while-revalidate
 *      —— 先回缓存（秒开、离线可用），后台再拉新版；下次启动就是新的。
 *   2. 其它请求（基本没有）：network-first，失败回缓存。
 *
 * 为什么不用 workbox：外壳总共 6 个文件，引一个库比这 60 行还重。
 *
 * 版本号要跟着数据/代码一起改 —— 改了 plans.json 而不改这里，
 * 用户拿到的还是旧价。CACHE 名里带版本，activate 时清掉旧版即可。
 */

const CACHE = 'codeplan-v1';

/** 外壳清单。相对本文件（/app/sw.js）解析，`../` 是数据与共享层。 */
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './app.css',
  './app.js',
  '../data/plans.js',
  '../js/shared.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll 是原子的：一个 404 全体失败。逐条放，缺一个不连累其它。
    await Promise.all(SHELL.map(async (u) => {
      try { await cache.add(new Request(u, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] 预缓存失败（离线时该项不可用）:', u, e.message); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // 只管读
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // 只管同源

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    // 外壳资源：缓存优先，后台静默更新
    const fetchAndUpdate = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);

    if (cached) {
      fetchAndUpdate.catch(() => {});
      return cached;
    }

    // 首次访问：等网络，失败给占位（外壳预缓存后基本走不到这）
    const net = await fetchAndUpdate;
    if (net) return net;
    return new Response('离线且未缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
