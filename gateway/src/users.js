// users:多账号(v0.4)— env USERS_JSON(系统账号,不可变)+ 文件用户(邀请创建,可写)
// 文件存 /data/users.json(容器)或 gateway/users.json(开发);env 用户优先,重名拒绝
import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.USERS_FILE || path.join(process.cwd(), 'users.json');

let fileUsers = null;

function loadFileUsers() {
  if (fileUsers) return fileUsers;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fileUsers = Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    fileUsers = [];
  }
  return fileUsers;
}

function saveFileUsers() {
  const tmp = FILE + '.tmp';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ users: fileUsers }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString('base64')}:${hash.toString('base64')}`;
}

let envCache = null;

function loadEnvUsers() {
  if (envCache) return envCache;
  envCache = [];
  const raw = process.env.USERS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      envCache = Object.entries(parsed).map(([name, u]) => ({
        name,
        scrypt: u.scrypt,
        role: u.role === 'admin' ? 'admin' : 'member',
        machines: Array.isArray(u.machines) && u.machines.length ? u.machines : [],
        system: true,
      }));
    } catch (e) {
      console.error('[users] USERS_JSON 解析失败:', e.message);
    }
  }
  return envCache;
}

export function loadUsers() {
  return [...loadEnvUsers(), ...loadFileUsers()];
}

export function findUser(name) {
  return loadUsers().find((u) => u.name === name) || null;
}

// 邀请创建成员(重名拒绝;永远 member)
export function addMember(name, password, machines = []) {
  if (findUser(name)) return null;
  const u = { name, scrypt: hashPassword(password), role: 'member', machines, invited: true, created_at: new Date().toISOString() };
  loadFileUsers();
  fileUsers.push(u);
  saveFileUsers();
  return u;
}

export function grantMachine(name, machine) {
  loadFileUsers();
  const u = fileUsers.find((x) => x.name === name);
  if (!u) return false;
  if (!u.machines.includes(machine) && !u.machines.includes('*')) u.machines.push(machine);
  saveFileUsers();
  return true;
}

function verifyScrypt(password, spec) {
  const parts = String(spec || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// 返回 { name, role, machines } | null
export function verifyUser(username, password) {
  if (!loadEnvUsers().length) {
    // 未配置 env 系统账号:兼容单 owner 密码(与邀请创建的文件用户并存;用户名不校验)
    if (verifyScrypt(password, process.env.LOGIN_PASSWORD_SCRYPT)) {
      return { name: 'owner', role: 'admin', machines: ['*'] };
    }
  }
  const u = findUser(username);
  if (!u || !verifyScrypt(password, u.scrypt)) return null;
  return { name: u.name, role: u.role, machines: u.machines };
}

// 机器级授权:用户可访问某机器?
export function canAccessMachine(user, machine) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.machines.includes('*') || user.machines.includes(machine);
}
