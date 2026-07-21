#!/usr/bin/env node
// R009-assistant-tail-rerender
// 现象: turn 结束后聊天停在最后一个「工具结果」卡片,助手结论文本不显示(owner 手机实测,v0.4.17)
// 根因: ①kimi server 原地更新 assistant 消息(先建空占位,thinking/text/tool_use 逐步追加,id 不变);
//       ②前端 keyed 渲染按 id 复用 DOM 节点后从不因内容变化重渲染 → 后补的 text part 永不出现;
//       ③空占位消息渲染出 '' 还会缓存一个坏节点,永久占位。
// 修复: web/app.js —— msgSig 内容签名(变即重渲染)+ 空消息不落 DOM 不缓存 + busy→idle 强制全量重拉;
//       顺带 mergeMessages 保证 quiet 刷新只更新最新一页(不冲掉已加载更早消息,bug1 共用基建)。
// 出处: 2026-07-20(本用例为纯逻辑复核:签名稳定性/变化敏感性、text part 在工具卡后的渲染次序、合并语义)
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const sandbox = {
  window: {}, console,
  document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], createElement: () => ({}) },
  location: { hash: '', protocol: 'http:', host: 'local' },
  navigator: {}, fetch: () => new Promise(() => {}),
  setTimeout, setInterval, clearTimeout, clearInterval,
  WebSocket: function () { throw new Error('no ws in test'); },
};
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(__dirname + '/../../web/md.js', 'utf8'), sandbox);
vm.runInContext(readFileSync(__dirname + '/../../web/app.js', 'utf8'), sandbox);

const kr = sandbox.window.__kr;
assert.ok(kr && kr.msgSig && kr.mergeMessages && kr.messageHtml, 'app.js 必须暴露 __kr 测试钩子');
const { msgSig, mergeMessages, messageHtml, cmpMsg } = kr;

// ---- ① 签名:内容不变签名稳定;追加 text part(结论文本后补)签名必变 ----
const base = { id: 'm1', role: 'assistant', created_at: '2026-07-20T12:00:00Z',
  content: [{ type: 'thinking', thinking: '…' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] };
const same = JSON.parse(JSON.stringify(base));
assert.equal(msgSig(base), msgSig(same), '同内容签名必须稳定(否则每次刷新都重渲染,性能回归)');

const withTail = JSON.parse(JSON.stringify(base));
withTail.content.push({ type: 'text', text: '结论:已经修复完成。' });
assert.notEqual(msgSig(base), msgSig(withTail), '尾部追加 text part 后签名必须变化(否则结论文本永不重渲染)');

const emptyA = { id: 'm2', role: 'assistant', created_at: '2026-07-20T12:00:01Z', content: [] };
assert.notEqual(msgSig(emptyA), msgSig(base), '空占位与有内容签名必须不同');
assert.notEqual(msgSig(emptyA), msgSig(withTail), '空占位 → 最终内容 签名必须不同(占位变结论的必经之路)');

// ---- ② 渲染:text part 必须出现在工具卡之后;空内容不产出节点(html 为假值则不缓存) ----
const html = messageHtml(withTail);
assert.ok(html.includes('tool-card'), '工具调用必须渲染工具卡');
assert.ok(html.includes('结论:已经修复完成。'), '结论文本必须渲染');
assert.ok(html.indexOf('tool-card') < html.indexOf('结论:已经修复完成。'), '结论文本必须排在工具卡之后');
assert.equal(messageHtml(emptyA), '', '空 assistant 消息必须渲染为空串(前端据此不缓存占位节点)');

// ---- ③ mergeMessages:fresh 覆盖同 id;本地更早消息保留;排序稳定 ----
const old1 = { id: 'm0a', role: 'user', created_at: '2026-07-20T10:00:00Z', content: '更早一' };
const old2 = { id: 'm0b', role: 'assistant', created_at: '2026-07-20T10:05:00Z', content: '更早二' };
const m1local = { id: 'm1', role: 'assistant', created_at: '2026-07-20T12:00:00Z', content: [{ type: 'thinking', thinking: '…' }] };
const m1fresh = { id: 'm1', role: 'assistant', created_at: '2026-07-20T12:00:00Z', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '结论' }] };
const m3new = { id: 'm3', role: 'assistant', created_at: '2026-07-20T12:30:00Z', content: [{ type: 'text', text: '新消息' }] };

const merged = mergeMessages([old1, old2, m1local], [m1fresh, m3new]);
assert.equal(merged.map(m => m.id).join(','), 'm0a,m0b,m1,m3', '合并必须保序:更早消息在前,fresh 新增在后');
assert.equal(merged[2].content.length, 2, '同 id 消息必须被 fresh 版本覆盖(拿到后补的结论)');
assert.equal(merged.filter(m => m.id === 'm1').length, 1, '同 id 不得重复');

// 同毫秒决胜:created_at 相同按 id 排,渲染次序不抖
const tie1 = { id: 'msg_s_000010', created_at: '2026-07-20T12:00:00.500Z' };
const tie2 = { id: 'msg_s_000011', created_at: '2026-07-20T12:00:00.500Z' };
assert.ok(cmpMsg(tie1, tie2) < 0 && cmpMsg(tie2, tie1) > 0, '同毫秒必须按 id 决胜');

console.log('R009 OK');
