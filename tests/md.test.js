// web/md.js 单元测试(无浏览器,window stub 加载)
// 运行:node --test tests/md.test.js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

let MD;
before(() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/md.js');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(file, 'utf8'), sandbox);
  MD = sandbox.window.MD;
});

test('纯数字不被腐蚀(回归:占位符曾把 5 渲染成 undefined)', () => {
  assert.equal(MD.render('M5 白名单改造'), '<p>M5 白名单改造</p>');
  assert.equal(MD.render('2026 年 7 月 19 日'), '<p>2026 年 7 月 19 日</p>');
  assert.ok(!MD.render('版本 3.1.2 发布').includes('undefined'));
});

test('行内码与多个行内码', () => {
  assert.equal(MD.render('用 `npm start` 启动'), '<p>用 <code class="inline">npm start</code> 启动</p>');
  const out = MD.render('`M2` 和 `M1` 两台');
  assert.ok(out.includes('<code class="inline">M2</code>'));
  assert.ok(out.includes('<code class="inline">M1</code>'));
  assert.ok(!out.includes('undefined'));
});

test('行内码内的 markdown 不再被格式化', () => {
  const out = MD.render('`**不是粗体**`');
  assert.ok(out.includes('<code class="inline">**不是粗体**</code>'));
  assert.ok(!out.includes('<strong>'));
});

test('粗体/斜体/删除线', () => {
  assert.ok(MD.render('**重点**').includes('<strong>重点</strong>'));
  assert.ok(MD.render('这是 *强调* 文字').includes('<em>强调</em>'));
  assert.ok(MD.render('~~废弃~~').includes('<del>废弃</del>'));
});

test('链接:http/https 放行,危险协议掐死', () => {
  assert.ok(MD.render('[官网](https://your.domain)').includes('href="https://your.domain"'));
  const evil = MD.render('[点我](javascript:alert(1))');
  assert.ok(!evil.includes('javascript:'), 'javascript: 协议必须被移除');
  assert.ok(evil.includes('href="#"'));
});

test('XSS:原始 HTML 一律转义', () => {
  const out = MD.render('<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  const img = MD.render('<img src=x onerror=alert(1)>');
  assert.ok(!img.includes('<img'));
});

test('代码块:围栏提取 + 语言标签 + 复制按钮', () => {
  const out = MD.render('```js\nconst a = 1;\n```');
  assert.ok(out.includes('pre class="code"'));
  assert.ok(out.includes('>js<'));
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('copy-btn'));
});

test('代码块内的 HTML 也转义', () => {
  const out = MD.render('```\n<div>hi</div>\n```');
  assert.ok(out.includes('&lt;div&gt;'));
  assert.ok(!out.includes('<div>hi</div>'));
});

test('标题/列表/引用/分割线', () => {
  assert.ok(MD.render('## 标题').startsWith('<h2>'));
  assert.ok(MD.render('- 甲\n- 乙').includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(MD.render('1. 一\n2. 二').includes('<ol>'));
  assert.ok(MD.render('> 引用一句').includes('<blockquote>'));
  assert.ok(MD.render('---').includes('<hr>'));
});

test('表格', () => {
  const out = MD.render('| 名 | 值 |\n|---|---|\n| a | 1 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>名</th>'));
  assert.ok(out.includes('<td>a</td>'));
});

test('段落内单换行变 <br>,空行分段', () => {
  assert.ok(MD.render('第一行\n第二行').includes('<br>'));
  assert.equal(MD.render('甲\n\n乙'), '<p>甲</p><p>乙</p>');
});

test('空输入与异常输入不崩', () => {
  assert.equal(MD.render(''), '');
  assert.equal(MD.render(null), '');
  assert.equal(MD.render(undefined), '');
});
