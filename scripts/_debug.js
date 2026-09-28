const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const plansJs = fs.readFileSync(path.join(ROOT, 'data', 'plans.js'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
html = html.replace('<script src="data/plans.js"></script>', () => '<script>' + plansJs + '</script>')
  .replace('<script src="js/app.js"></script>', () => '<script>' + appJs + '</script>');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('JSDOM_ERR: ' + (e.stack || e.message).slice(0, 300)));
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1:8899/', pretendToBeVisual: true, virtualConsole: vc });
const doc = dom.window.document;
const $ = (s) => doc.querySelector(s);
const fire = (el, t) => el.dispatchEvent(new dom.window.Event(t, { bubbles: true }));

console.log('总行数 =', doc.querySelectorAll('#matrixBody tr').length);
const q = $('#q');
q.value = '智谱';
fire(q, 'input');
const rows = Array.from(doc.querySelectorAll('#matrixBody tr'));
console.log('搜索「智谱」行数 =', rows.length);
rows.forEach((r, i) => {
  const pc = r.querySelector('.price');
  const lp = r.querySelector('.pricelist');
  console.log('行' + i + ' tier=' + (r.querySelector('.cmpbox') || {}).getAttribute?.('data-tier') +
    ' | .price=' + (pc ? JSON.stringify(pc.textContent) : '(无)') +
    ' | .pricelist=' + (lp ? JSON.stringify(lp.textContent) : '(无)'));
});
console.log('--- 错误 ---', errors.length ? errors.join('\n') : '（无）');
// 全局统计
q.value = ''; fire(q, 'input');
console.log('全量 .pricelist 数量 =', doc.querySelectorAll('#matrixBody .pricelist').length);
console.log('数据里带原价的档位 =', dom.window.__PLANS__.plans.flatMap((p) => p.tiers).filter((t) => t.price_list_cny).length);
