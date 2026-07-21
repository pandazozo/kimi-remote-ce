// users 单元测试:多账号(USERS_JSON)与单 owner 兼容模式、机器级授权
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';

function makeScrypt(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString('base64')}:${hash.toString('base64')}`;
}

let users;
async function freshImport() {
  return import('../src/users.js?x=' + Math.random());
}

beforeEach(() => {
  delete process.env.USERS_JSON;
  process.env.USERS_FILE = `/tmp/users-test-${Math.random().toString(36).slice(2)}.json`;
});

test('兼容模式:无 USERS_JSON 时走 LOGIN_PASSWORD_SCRYPT(owner/admin/全机器)', async () => {
  process.env.LOGIN_PASSWORD_SCRYPT = makeScrypt('pw-owner');
  users = await freshImport();
  const u = users.verifyUser('任意名字', 'pw-owner');
  assert.equal(u.role, 'admin');
  assert.deepEqual(u.machines, ['*']);
  assert.equal(users.verifyUser('x', 'wrong'), null);
});

test('多账号:正密码通过/错密码拒绝/未知用户拒绝', async () => {
  process.env.USERS_JSON = JSON.stringify({
    wangzuo: { scrypt: makeScrypt('pw-a'), role: 'admin', machines: ['*'] },
    member1: { scrypt: makeScrypt('pw-b'), role: 'member', machines: ['m5'] },
  });
  users = await freshImport();
  assert.equal(users.verifyUser('wangzuo', 'pw-a').role, 'admin');
  assert.equal(users.verifyUser('member1', 'pw-b').role, 'member');
  assert.equal(users.verifyUser('member1', 'bad'), null);
  assert.equal(users.verifyUser('ghost', 'pw-a'), null);
});

test('多账号:配置了 USERS_JSON 后不再走 LOGIN_PASSWORD_SCRYPT', async () => {
  process.env.LOGIN_PASSWORD_SCRYPT = makeScrypt('legacy-pw');
  process.env.USERS_JSON = JSON.stringify({
    wangzuo: { scrypt: makeScrypt('pw-a'), role: 'admin' },
  });
  users = await freshImport();
  assert.equal(users.verifyUser('owner', 'legacy-pw'), null, '多账号模式下旧单密码必须失效');
});

test('机器级授权:admin 全通;member 按列表;* 通配', async () => {
  users = await freshImport();
  const admin = { name: 'a', role: 'admin', machines: [] };
  const member = { name: 'm', role: 'member', machines: ['m5'] };
  const star = { name: 's', role: 'member', machines: ['*'] };
  assert.equal(users.canAccessMachine(admin, 'm1'), true);
  assert.equal(users.canAccessMachine(member, 'm5'), true);
  assert.equal(users.canAccessMachine(member, 'm1'), false);
  assert.equal(users.canAccessMachine(star, 'anything'), true);
  assert.equal(users.canAccessMachine(null, 'm5'), false);
});

test('USERS_JSON 畸形 JSON → 回退单 owner 模式不崩', async () => {
  process.env.LOGIN_PASSWORD_SCRYPT = makeScrypt('pw-owner');
  process.env.USERS_JSON = '{broken';
  users = await freshImport();
  assert.equal(users.verifyUser('x', 'pw-owner').role, 'admin');
});

test('文件用户与单 owner 密码并存(2026-07-20 生产回归)', async () => {
  process.env.LOGIN_PASSWORD_SCRYPT = makeScrypt('pw-owner');
  users = await freshImport();
  users.addMember('member1', 'pw-b', []);
  // 有文件用户后,owner 密码仍须可登录(生产事故:此场景曾 401)
  assert.equal(users.verifyUser('owner', 'pw-owner').role, 'admin');
  assert.equal(users.verifyUser('member1', 'pw-b').role, 'member');
});

test('member 缺省 machines 为空数组(不可访问任何机器)', async () => {
  process.env.USERS_JSON = JSON.stringify({
    m1: { scrypt: makeScrypt('pw'), role: 'member' },
  });
  users = await freshImport();
  const u = users.verifyUser('m1', 'pw');
  assert.deepEqual(u.machines, []);
  assert.equal(users.canAccessMachine(u, 'm5'), false);
});
