#!/usr/bin/env node
/* 临时量尺：榜单首屏垂直占用。只用于本轮核对，不留库。 */
'use strict';
var path = require('path');
var { createRenderer } = require('C:/Users/001/.workbuddy/skills/browser-render-cdp/render.js');
var FILE = 'file:///' + path.join(__dirname, '..', 'app', 'index.html').replace(/\\/g, '/');

var EXPR = "(function(){" +
  "function r(sel,n){var e=document.querySelectorAll(sel)[n||0];if(!e)return null;var b=e.getBoundingClientRect();return {t:Math.round(b.top),b:Math.round(b.bottom),h:Math.round(b.height)};}" +
  "var rows=document.querySelectorAll('#rankRows .row');" +
  "var nav=document.getElementById('appBody');" +
  "return {vh:window.innerHeight, tab:Math.round(document.getElementById('tabbar').getBoundingClientRect().height)," +
  " scrollTop:nav.scrollTop, scrollH:nav.scrollHeight," +
  " search:r('.searchbar'), chip1:r('#billingChips'), chip2:r('#useCaseChips'), bar:r('.toolbar'), notice:r('#rankNotice')," +
  " row0:rows[0]?{t:Math.round(rows[0].getBoundingClientRect().top),b:Math.round(rows[0].getBoundingClientRect().bottom),h:Math.round(rows[0].getBoundingClientRect().height)}:null," +
  " row1t:rows[1]?Math.round(rows[1].getBoundingClientRect().top):null, n:rows.length};" +
"})()";

(async function () {
  var rr = await createRenderer({ width: 390, height: 844 });
  var out = await rr.render(FILE + '#rank', { eval: EXPR, waitFor: 'CodePlan', waitForMax: 8000, hardTimeout: 30000 });
  console.log(JSON.stringify(out.extra, null, 1));
  await rr.close();
})().catch(function (e) { console.error('ERR', e.message); process.exit(1); });
