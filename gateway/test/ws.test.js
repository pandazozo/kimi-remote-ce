// ws 工具函数单元测试:close 码清洗(防 1006 崩进程回归)与 WS 帧过滤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedFrame, sanitizeCloseCode } from '../src/ws.js';

test('sanitizeCloseCode:合法码原样通过', () => {
  assert.equal(sanitizeCloseCode(1000), 1000);
  assert.equal(sanitizeCloseCode(1001), 1001);
  assert.equal(sanitizeCloseCode(1011), 1011);
  assert.equal(sanitizeCloseCode(4000), 4000);
});
test('sanitizeCloseCode:保留码/非法码归一到 1000', () => {
  assert.equal(sanitizeCloseCode(1005), 1000, '1005 不可发送');
  assert.equal(sanitizeCloseCode(1006), 1000, '1006 曾导致进程崩溃,必须归一');
  assert.equal(sanitizeCloseCode(1015), 1000);
  assert.equal(sanitizeCloseCode(1004), 1000);
  assert.equal(sanitizeCloseCode(999), 1000);
  assert.equal(sanitizeCloseCode(5000), 1000);
  assert.equal(sanitizeCloseCode(undefined), 1000);
  assert.equal(sanitizeCloseCode(NaN), 1000);
});

test('isBlockedFrame:terminal_*/watch_fs_* 拦截', () => {
  assert.equal(isBlockedFrame('{"type":"terminal_attach","id":"1","payload":{}}'), true);
  assert.equal(isBlockedFrame('{"type":"terminal_input","payload":{"data":"ls"}}'), true);
  assert.equal(isBlockedFrame('{"type":"watch_fs_add","payload":{}}'), true);
  assert.equal(isBlockedFrame('{ "type" : "terminal_close" }'), true, '容忍 JSON 空白');
});
test('isBlockedFrame:正常帧放行', () => {
  assert.equal(isBlockedFrame('{"type":"client_hello","payload":{"client_id":"x","subscriptions":[]}}'), false);
  assert.equal(isBlockedFrame('{"type":"subscribe","payload":{"session_ids":["s1"]}}'), false);
  assert.equal(isBlockedFrame('{"type":"ping"}'), false);
  assert.equal(isBlockedFrame('{"type":"unsubscribe","payload":{}}'), false);
  // 文本中提到 terminal 但 type 不是它,不拦
  assert.equal(isBlockedFrame('{"type":"subscribe","payload":{"note":"terminal_attach"}}'), false);
});
