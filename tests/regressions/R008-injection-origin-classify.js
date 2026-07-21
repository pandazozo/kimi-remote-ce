#!/usr/bin/env node
// R008-injection-origin-classify
// 现象: 系统注入消息(todo_list_reminder/任务通知/压缩摘要/STEER-PROBE 探针)被渲染成用户的蓝色气泡(owner 手机实测,v0.4.17)
// 根因: 旧实现只靠文本正则(<system-reminder>/<system>)识别注入,漏掉无标签注入与元数据可判的注入
// 修复: web/app.js isInjectedUserMsg —— 优先 metadata.origin.kind(≠user 即注入),无元数据退文本特征
// 出处: 2026-07-20(本用例为纯逻辑复核:分类器真值表 + messageHtml 渲染归属)
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

// 与 R005 同款 vm 沙箱;fetch 永不 resolve,避免 app.js 启动探测触发 DOM
const sandbox = {
  window: {}, console,
  document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [], createElement: () => ({}) },
  location: { hash: '', protocol: 'http:', host: 'local' },
  navigator: {}, fetch: () => new Promise(() => {}),
  setTimeout, setInterval, clearTimeout, clearInterval,
  WebSocket: function () { throw new Error('no ws in test'); },
};
sandbox.window.addEventListener = () => {};
sandbox.window.MD = undefined;
vm.createContext(sandbox);
vm.runInContext(readFileSync(__dirname + '/../../web/md.js', 'utf8'), sandbox);
vm.runInContext(readFileSync(__dirname + '/../../web/app.js', 'utf8'), sandbox);

const kr = sandbox.window.__kr;
assert.ok(kr && kr.isInjectedUserMsg, 'app.js 必须暴露 __kr 测试钩子');
const { isInjectedUserMsg, messageHtml } = kr;

// ---- 真值表:元数据优先 ----
const userMsg = (kind, text, variant) => ({
  role: 'user', created_at: '2026-07-20T12:00:00Z',
  content: [{ type: 'text', text }],
  metadata: kind ? { origin: variant ? { kind, variant } : { kind } } : undefined,
});

const cases = [
  // [消息, 期望 isInjected, 说明]
  [userMsg('user', '帮我看看这个项目'), false, 'origin.kind=user → 本人输入'],
  [userMsg('user', '<system-reminder>x</system-reminder> 我的真实指令'), false, 'kind=user 夹带 reminder 块 → 仍算本人(分离折叠由 messageHtml 内部处理)'],
  [userMsg('injection', '<system-reminder>\nThe TodoList tool...\n</system-reminder>', 'todo_list_reminder'), true, 'injection/todo_list_reminder(实测枚举)'],
  [userMsg('injection', '<system-reminder>\nImage compressed...</system-reminder>', 'image_compression'), true, 'injection/image_compression(实测枚举)'],
  [userMsg('task', '<notification id="task:bash-x:completed" category="task">...'), true, 'task 任务通知'],
  [userMsg('compaction_summary', '# 交接备忘\n\n## 当前正在做的事...'), true, 'compaction_summary 压缩摘要'],
  [userMsg('skill_activation', 'Skill tool loaded instructions...'), true, 'skill_activation 技能激活'],
  // ---- 无元数据(老消息)→ 文本特征兜底 ----
  [userMsg(null, '<system-reminder>老注入</system-reminder>'), true, '无元数据 + <system-reminder>'],
  [userMsg(null, '<system>老注入</system>'), true, '无元数据 + <system>'],
  [userMsg(null, 'STEER-PROBE revive-028 只回复:活'), true, '无元数据 + STEER-PROBE 探针前缀'],
  [userMsg(null, '<notification id="task:x:completed">'), true, '无元数据 + <notification> 前缀'],
  [userMsg(null, '只回复两个字:活着'), false, '无元数据普通文本 → 不误伤'],
  [userMsg(null, ''), false, '无元数据空文本 → 不误伤'],
  // role 非 user 永不算注入
  [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }, false, 'assistant 不走注入判定'],
];
for (const [m, want, why] of cases) {
  const rawText = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const got = isInjectedUserMsg(m, rawText);
  assert.equal(got, want, `分类错误(${why}): 期望 ${want} 实得 ${got}`);
}

// ---- 渲染归属:注入消息进折叠卡,不占蓝色气泡;本人消息占气泡 ----
const injHtml = messageHtml(userMsg('injection', '<system-reminder>todo</system-reminder>', 'todo_list_reminder'));
assert.ok(injHtml.includes('inject-card'), '注入消息必须渲染 inject-card');
assert.ok(!injHtml.includes('bubble'), '注入消息不得渲染用户气泡');
assert.ok(injHtml.includes('非我本人输入'), '注入卡必须标注非本人');

const mineHtml = messageHtml(userMsg('user', '赶紧修复这个 bug'));
assert.ok(mineHtml.includes('bubble'), '本人消息必须渲染气泡');
assert.ok(!mineHtml.includes('inject-card'), '本人消息不得渲染注入卡');

console.log('R008 OK');
