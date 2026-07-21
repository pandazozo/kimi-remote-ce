// invites 单元测试:创建/查询/可用性/认领失效
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let invites;
beforeEach(async () => {
  process.env.INVITES_FILE = `/tmp/invites-test-${Math.random().toString(36).slice(2)}.json`;
  invites = await import('../src/invites.js?x=' + Math.random());
});

test('创建邀请:token/过期时间/未使用状态', () => {
  const inv = invites.createInvite('alice', { note: '给小明' });
  assert.ok(inv.token.length > 20);
  assert.equal(inv.created_by, 'alice');
  assert.equal(inv.used_by, null);
  assert.equal(invites.isUsable(inv), true);
  assert.ok(new Date(inv.expires_at).getTime() > Date.now());
});

test('列表包含创建的邀请且不落 token 全文检查由路由层做', () => {
  invites.createInvite('a', {});
  invites.createInvite('b', {});
  assert.equal(invites.listInvites().length, 2);
});

test('claim 后失效;过期失效', () => {
  const inv = invites.createInvite('a', {});
  assert.equal(invites.isUsable(inv), true);
  invites.markUsed(inv.token, 'member1');
  const after = invites.getInvite(inv.token);
  assert.equal(after.used_by, 'member1');
  assert.equal(invites.isUsable(after), false);

  const exp = invites.createInvite('a', { expires_in_sec: -1 });
  assert.equal(invites.isUsable(exp), false);
});

test('未知 token 返回 null', () => {
  assert.equal(invites.getInvite('nope'), null);
});
