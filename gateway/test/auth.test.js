// auth 单元测试:scrypt 校验 / HS256 JWT / cookie / 登录限流
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes, createHmac } from 'node:crypto';

before(() => {
  const salt = randomBytes(16);
  const hash = scryptSync('test-password-123', salt, 32, { N: 16384, r: 8, p: 1 });
  process.env.LOGIN_PASSWORD_SCRYPT =
    `scrypt:16384:8:1:${salt.toString('base64')}:${hash.toString('base64')}`;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.DEV_INSECURE_COOKIE = '1';
});

// 延迟加载,确保 env 已就位
let auth;
before(async () => {
  auth = await import('../src/auth.js');
});

test('scrypt:正确密码通过', () => {
  assert.equal(auth.verifyPassword('test-password-123'), true);
});
test('scrypt:错误密码拒绝', () => {
  assert.equal(auth.verifyPassword('wrong'), false);
  assert.equal(auth.verifyPassword(''), false);
});
test('scrypt:畸形哈希串不崩且拒绝', () => {
  const old = process.env.LOGIN_PASSWORD_SCRYPT;
  process.env.LOGIN_PASSWORD_SCRYPT = 'not-a-valid-spec';
  assert.equal(auth.verifyPassword('test-password-123'), false);
  process.env.LOGIN_PASSWORD_SCRYPT = 'scrypt:abc:8:1:!!:!!';
  assert.equal(auth.verifyPassword('x'), false);
  process.env.LOGIN_PASSWORD_SCRYPT = old;
});

test('JWT:签发后可验证,sub/exp 正确', () => {
  const token = auth.issueToken();
  assert.equal(auth.verifyToken(token), true);
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(payload.sub, 'owner');
  assert.ok(payload.exp - payload.iat === 12 * 3600);
});
test('JWT:篡改签名拒绝', () => {
  const token = auth.issueToken();
  const parts = token.split('.');
  parts[2] = Buffer.from('forged-forged-forged').toString('base64url');
  assert.equal(auth.verifyToken(parts.join('.')), false);
});
test('JWT:过期拒绝', () => {
  const now = Math.floor(Date.now() / 1000) - 100;
  const body = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'owner', iat: now - 100, exp: now - 1 })).toString('base64url'),
  ].join('.');
  const sig = createHmac('sha256', process.env.JWT_SECRET).update(body).digest();
  assert.equal(auth.verifyToken(`${body}.${Buffer.from(sig).toString('base64url')}`), false);
});
test('JWT:畸形输入拒绝', () => {
  assert.equal(auth.verifyToken(''), false);
  assert.equal(auth.verifyToken('a.b'), false);
  assert.equal(auth.verifyToken('a.b.c.d'), false);
  assert.equal(auth.verifyToken(undefined), false);
  assert.equal(auth.verifyToken('!!@@##.##.$$%%'), false);
});

test('cookie:解析与构造', () => {
  const req = { headers: { cookie: 'a=1; kr_token=tok123; b=x=y' } };
  assert.equal(auth.authCookieValue(req), 'tok123');
  assert.equal(auth.authCookieValue({ headers: {} }), undefined);
  const c = auth.buildAuthCookie('tok123');
  assert.ok(c.includes('kr_token=tok123'));
  assert.ok(c.includes('HttpOnly'));
  assert.ok(c.includes('SameSite=Lax'));
  assert.ok(!c.includes('Secure'), 'DEV_INSECURE_COOKIE=1 时不应带 Secure');
  process.env.DEV_INSECURE_COOKIE = '0';
  assert.ok(auth.buildAuthCookie('x').includes('Secure'), '生产必须带 Secure');
  process.env.DEV_INSECURE_COOKIE = '1';
  assert.ok(auth.buildClearCookie().includes('Max-Age=0'));
});

test('限流:同 IP 5 次失败后 429,成功后清零', () => {
  const ip = '1.2.3.4';
  for (let i = 0; i < 5; i++) auth.recordLoginFailure(ip);
  assert.equal(auth.loginRateLimited(ip), true);
  assert.equal(auth.loginRateLimited('5.6.7.8'), false, '其他 IP 不受限');
  auth.clearLoginFailures(ip);
  assert.equal(auth.loginRateLimited(ip), false);
});

test('requireAuth:无 cookie 401,有效 cookie 放行', () => {
  const token = auth.issueToken();
  const res401 = { status(c) { this.code = c; return this; }, json() { return this; } };
  let nexted = false;
  auth.requireAuth({ headers: {} }, res401, () => { nexted = true; });
  assert.equal(res401.code, 401);
  assert.equal(nexted, false);
  const res2 = { status(c) { this.code = c; return this; }, json() { return this; } };
  let nexted2 = false;
  auth.requireAuth({ headers: { cookie: `kr_token=${token}` } }, res2, () => { nexted2 = true; });
  assert.equal(nexted2, true);
});
