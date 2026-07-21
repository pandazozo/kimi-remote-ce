// invites:一次性邀请(v0.4c)— token 24h 有效,claim 后失效
// 存 /data/invites.json(容器)或 gateway/invites.json(开发)
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.INVITES_FILE || path.join(process.cwd(), 'invites.json');
const DEFAULT_TTL_SEC = 24 * 3600;

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(store.invites)) store = { invites: [] };
  } catch {
    store = { invites: [] };
  }
  return store;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function createInvite(createdBy, opts = {}) {
  load();
  const token = randomBytes(24).toString('base64url');
  const inv = {
    token,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (opts.expires_in_sec || DEFAULT_TTL_SEC) * 1000).toISOString(),
    machines: Array.isArray(opts.machines) ? opts.machines : [],
    note: opts.note || '',
    used_by: null,
    used_at: null,
  };
  store.invites.push(inv);
  save();
  return inv;
}

export function listInvites() {
  load();
  return store.invites;
}

export function getInvite(token) {
  load();
  return store.invites.find((i) => i.token === token) || null;
}

export function isUsable(inv) {
  return inv && !inv.used_by && new Date(inv.expires_at).getTime() > Date.now();
}

export function markUsed(token, username) {
  load();
  const inv = getInvite(token);
  if (!inv) return null;
  inv.used_by = username;
  inv.used_at = new Date().toISOString();
  save();
  return inv;
}
