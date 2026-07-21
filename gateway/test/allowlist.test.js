// allowlist 单元测试:白名单是公网暴露面核心,每条规则必须有断言
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed } from '../src/allowlist.js';

test('sessions 全子路径放行(任意方法)', () => {
  assert.equal(isAllowed('GET', '/api/v1/sessions'), true);
  assert.equal(isAllowed('POST', '/api/v1/sessions'), true);
  assert.equal(isAllowed('GET', '/api/v1/sessions/session_abc/messages?page_size=50'), true);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc/prompts'), true);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc/prompts:steer'), true);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc/approvals/ap_1'), true);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc:archive'), true);
  assert.equal(isAllowed('DELETE', '/api/v1/sessions/session_abc'), true);
});

test('sessions 下的 terminals 段永远拒绝', () => {
  assert.equal(isAllowed('GET', '/api/v1/sessions/session_abc/terminals'), false);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc/terminals'), false);
  assert.equal(isAllowed('GET', '/api/v1/sessions/session_abc/terminals/t_1'), false);
  assert.equal(isAllowed('POST', '/api/v1/sessions/session_abc/terminals/t_1/input'), false);
});

test('高危路径一律拒绝', () => {
  const blocked = [
    '/api/v1/shutdown',
    '/api/v1/gui/store/getItem',
    '/api/v1/gui/store/setItem',
    '/api/v1/oauth/login',
    '/api/v1/oauth/logout',
    '/api/v1/config',
    '/api/v1/providers',
    '/api/v1/providers/kimi-code',
    '/api/v1/mcp/servers',
    '/api/v1/debug/anything',
    '/api/v1/auth',
    '/api/v1/connections',
    '/api/v2/channels',
    '/api/v1/fs:browse/write',
    '/',
  ];
  for (const p of blocked) {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal(isAllowed(m, p), false, `${m} ${p} must be blocked`);
    }
  }
});

test('只读路径方法约束', () => {
  assert.equal(isAllowed('GET', '/api/v1/meta'), true);
  assert.equal(isAllowed('POST', '/api/v1/meta'), false);
  assert.equal(isAllowed('GET', '/api/v1/models'), true);
  assert.equal(isAllowed('POST', '/api/v1/models'), false);
  assert.equal(isAllowed('GET', '/api/v1/models/kimi-code/k3'), true);
  assert.equal(isAllowed('GET', '/api/v1/fs:browse?path=/tmp'), true);
  assert.equal(isAllowed('GET', '/api/v1/fs:home'), true);
  assert.equal(isAllowed('GET', '/api/v1/tools'), true);
  assert.equal(isAllowed('GET', '/api/v1/healthz'), true);
});

test('workspaces 只读且限定形状', () => {
  assert.equal(isAllowed('GET', '/api/v1/workspaces'), true);
  assert.equal(isAllowed('GET', '/api/v1/workspaces/wd_abc_123'), true);
  assert.equal(isAllowed('GET', '/api/v1/workspaces/wd_abc_123/skills'), true);
  assert.equal(isAllowed('POST', '/api/v1/workspaces'), false);
  assert.equal(isAllowed('GET', '/api/v1/workspaces/wd_abc_123/anything-else'), false);
  assert.equal(isAllowed('DELETE', '/api/v1/workspaces/wd_abc_123'), false);
});

test('files 规则', () => {
  assert.equal(isAllowed('POST', '/api/v1/files'), true);
  assert.equal(isAllowed('GET', '/api/v1/files'), false);
  assert.equal(isAllowed('GET', '/api/v1/files/f_123'), true);
  assert.equal(isAllowed('DELETE', '/api/v1/files/f_123'), true);
  assert.equal(isAllowed('POST', '/api/v1/files/f_123'), false);
  assert.equal(isAllowed('GET', '/api/v1/files/f_123/extra'), false);
});

test('路径规整:尾斜杠与 query 不影响判定', () => {
  assert.equal(isAllowed('GET', '/api/v1/meta/'), true);
  assert.equal(isAllowed('GET', '/api/v1/sessions/?page_size=10'), true);
  assert.equal(isAllowed('POST', '/api/v1/shutdown/?x=1'), false);
});

test('方法大小写不敏感', () => {
  assert.equal(isAllowed('get', '/api/v1/meta'), true);
  assert.equal(isAllowed('post', '/api/v1/shutdown'), false);
});
