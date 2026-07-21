// Auth: scrypt password verification, hand-rolled HS256 JWT, cookie helpers,
// and in-memory login rate limiting. No external deps (node:crypto only).
import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

const JWT_TTL_SEC = 12 * 60 * 60; // 12 hours
const COOKIE_NAME = 'kr_token';

// ---------- scrypt ----------

// LOGIN_PASSWORD_SCRYPT format: scrypt:N:r:p:saltB64:hashB64
export function verifyPassword(password) {
  const spec = process.env.LOGIN_PASSWORD_SCRYPT || '';
  const parts = spec.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- HS256 JWT ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(data) {
  return createHmac('sha256', process.env.JWT_SECRET).update(data).digest();
}

export function issueToken(sub = 'owner', role = 'admin') {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub, role, iat: now, exp: now + JWT_TTL_SEC })
  );
  const body = `${header}.${payload}`;
  return `${body}.${b64url(sign(body))}`;
}

// 验签 + 有效期 + sub 非空(布尔,保持旧语义)
export function verifyToken(token) {
  return parseToken(token) !== null;
}

// 解析 JWT 载荷(验签失败/过期/畸形 → null);多账号 req.user 来源
export function parseToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = b64url(sign(body));
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) {
    return null;
  }
  return payload;
}

// ---------- cookies (hand-rolled parsing) ----------

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export function authCookieValue(req) {
  return parseCookies(req)[COOKIE_NAME];
}

export function buildAuthCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${JWT_TTL_SEC}`,
  ];
  if (process.env.DEV_INSECURE_COOKIE !== '1') parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie() {
  const parts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (process.env.DEV_INSECURE_COOKIE !== '1') parts.push('Secure');
  return parts.join('; ');
}

// Express middleware: require a valid JWT in the kr_token cookie.
// 通过后 req.user = { sub, role, iat, exp }(多账号授权判断的数据源)
export function requireAuth(req, res, next) {
  const payload = parseToken(authCookieValue(req));
  if (!payload) {
    return res.status(401).json({ code: 1, msg: 'unauthorized' });
  }
  req.user = payload;
  next();
}

// ---------- login rate limiting ----------

// Same source IP: 5 failed attempts within 10 minutes -> 429.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const failures = new Map(); // ip -> number[] (failure timestamps)

export function loginRateLimited(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  failures.set(ip, list);
  return list.length >= MAX_FAILS;
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  failures.set(ip, list);
}

export function clearLoginFailures(ip) {
  failures.delete(ip);
}
