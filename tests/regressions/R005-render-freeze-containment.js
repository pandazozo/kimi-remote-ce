#!/usr/bin/env node
// R005-render-freeze-containment
// 现象: 会话视图冻结在旧内容(最后停在工具结果 9:46),刷新无效
// 根因: 渲染循环无容错,单条坏消息让整页渲染崩掉并冻结
// 出处: 2026-07-20 v0.3.3(逐条 try/catch;此处为纯逻辑复核:messageHtml 坏输入不得抛出)
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// md.js 环境
const sandbox = { window: {}, document: { getElementById: () => null, addEventListener: () => {} }, location: { hash: '' }, navigator: {}, fetch: () => Promise.reject(), setTimeout, setInterval, clearTimeout, clearInterval };
vm.createContext(sandbox);
vm.runInContext(readFileSync(__dirname + '/../../web/md.js', 'utf8'), sandbox);

const MD = sandbox.window.MD;
// 坏消息样本:undefined/null/嵌套畸形/超长/控制字符/未闭合围栏
const poison = [
  undefined, null, '', 0, NaN,
  '```\n未闭合代码块',
  '<system-reminder>' + 'x'.repeat(100000),
  'a'.repeat(200000),
  '控制字符',
  '| 非 | 表 |',
];
for (const p of poison) {
  try { MD.render(String(p)); }
  catch (e) { console.error('FAIL: 坏消息导致渲染抛出:', JSON.stringify(String(p).slice(0, 30)), e.message); process.exit(1); }
}
console.log('R005 OK');
