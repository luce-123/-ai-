#!/usr/bin/env node
/* 布局体检：用真实 Chrome 量一遍各屏幕在窄屏下有没有横向溢出。
   用法： NODE_PATH=<node 工作区>/node_modules node scripts/probe-layout.js
   为什么需要它：jsdom 不做排版，「文字被裁掉」这类问题只有真引擎能看出来。 */
'use strict';
var path = require('path');
var { createRenderer } = require('C:/Users/001/.workbuddy/skills/browser-render-cdp/render.js');

var FILE = 'file:///' + path.join(__dirname, '..', 'app', 'index.html').replace(/\\/g, '/');

var EXPR = "(function(){" +
  "var d=document.documentElement;" +
  "var over=[];" +
  "document.querySelectorAll('*').forEach(function(el){" +
  "  var rr=el.getBoundingClientRect();" +
  "  if(rr.width>0 && rr.right > d.clientWidth+1) over.push(el.tagName+'.'+String(el.className||'').slice(0,50)+' right='+rr.right.toFixed(0)+' w='+rr.width.toFixed(0));" +
  "});" +
  "function rect(id){var e=document.getElementById(id);if(!e)return null;var r=e.getBoundingClientRect();return {w:Math.round(r.width),right:Math.round(r.right)};}" +
  "var worst=null;" +
  "document.querySelectorAll('.row__stat dd, .rmini__name, .evt__plan, .badge, .chip').forEach(function(e){" +
  "  if(e.scrollWidth > e.clientWidth+1 && !worst) worst=(e.className||'')+' | '+e.textContent.trim().slice(0,40)+' scroll='+e.scrollWidth+' client='+e.clientWidth;" +
  "});" +
  "return {innerW:window.innerWidth, clientW:d.clientWidth, scrollW:d.scrollWidth," +
  " app:rect('app'), tabbar:rect('tabbar'), body:rect('appBody')," +
  " clippedText:worst, overflow:over.slice(0,15)};" +
"})()";

(async function () {
  var r = await createRenderer({ width: 390, height: 844 });
  var screens = ['home', 'rank', 'wizard', 'pulse', 'favs', 'about'];
  var bad = 0;
  for (var i = 0; i < screens.length; i++) {
    var s = screens[i];
    var out = await r.render(FILE + '#' + s, { eval: EXPR, waitFor: 'CodePlan', waitForMax: 8000, hardTimeout: 30000 });
    var e = out.extra;
    console.log('\n[' + s + '] ok=' + out.ok);
    if (!e) { console.log('  取不到布局数据'); bad++; continue; }
    console.log('  视口 ' + e.innerW + ' / clientWidth ' + e.clientW + ' / scrollWidth ' + e.scrollW +
      ' | app ' + (e.app ? e.app.w : '?') + ' | tabbar 右边界 ' + (e.tabbar ? e.tabbar.right : '?') +
      ' | 内容区 ' + (e.body ? e.body.w : '?'));
    if (e.scrollW > e.clientW + 1) { console.log('  ✗ 存在横向溢出'); bad++; } else { console.log('  ✓ 无横向溢出'); }
    if (e.clippedText) console.log('  ! 文本被裁： ' + e.clippedText);
    if (e.overflow && e.overflow.length) console.log('  ! 越界元素： ' + e.overflow.join('\n              '));
  }
  await r.close();
  /* 注意：这里每屏都是「全新 profile」跑的，localStorage 是空的，
     所以 favs 屏量到的是**空态**。有内容的 favs 行复用 .row（和榜单同一套），
     榜单 68 行不溢出已经覆盖了那种布局。 */
  console.log('\n结论：' + (bad ? bad + ' 个屏幕有问题' : screens.length + ' 个屏幕布局都正常'));
  process.exit(bad ? 1 : 0);
})().catch(function (e) { console.error('ERR', e.stack); process.exit(1); });
