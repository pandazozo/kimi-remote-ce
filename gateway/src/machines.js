// machines:机器注册表(v0.4)— env MACHINES_JSON + 文件注册(成员自助)合并
// 文件存 /data/machines.json;env/legacy 条目 system:true 不可覆盖
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.MACHINES_FILE || path.join(process.cwd(), 'machines.json');
const PORT_RANGE_START = 58700;
const PORT_RANGE_END = 58899;

let fileMachines = null;

function loadFileMachines() {
  if (fileMachines) return fileMachines;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fileMachines = Array.isArray(parsed.machines) ? parsed.machines : [];
  } catch {
    fileMachines = [];
  }
  return fileMachines;
}

function saveFileMachines() {
  const tmp = FILE + '.tmp';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ machines: fileMachines }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

let envCache = null;

function loadEnvMachines() {
  if (envCache) return envCache;
  envCache = {};
  const raw = process.env.MACHINES_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      for (const [id, m] of Object.entries(parsed)) {
        if (m && m.upstream && m.token) envCache[id] = { upstream: m.upstream, token: m.token, system: true };
      }
    } catch (e) {
      console.error('[machines] MACHINES_JSON 解析失败,回退单机:', e.message);
    }
  }
  if (!Object.keys(envCache).length) {
    envCache = {
      m5: {
        // REST 走前门 adapter(58629:v2 修复层);WS 桥走 kimi server(58627,adapter 不接 upgrade)
        upstream: process.env.ADAPTER_UPSTREAM || 'http://127.0.0.1:58629',
        ws_upstream: process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627',
        token: process.env.KIMI_TOKEN,
        system: true,
        // harness 上游映射:kimi/claude 均经 m5 前门 adapter(58629,负责剥前缀+本地注入凭证)
        harnesses: {
          kimi: {
            upstream: process.env.ADAPTER_UPSTREAM || 'http://127.0.0.1:58629',
            token: process.env.ADAPTER_TOKEN || process.env.KIMI_TOKEN,
          },
          claude: {
            upstream: process.env.ADAPTER_UPSTREAM || 'http://127.0.0.1:58629',
            token: process.env.ADAPTER_TOKEN || process.env.KIMI_TOKEN,
          },
        },
      },
    };
  }
  return envCache;
}

export function loadMachines() {
  const all = { ...loadEnvMachines() };
  for (const m of loadFileMachines()) all[m.id] = m;
  return all;
}

export function getMachine(id) {
  return loadMachines()[id] || null;
}

export function defaultMachineId() {
  return Object.keys(loadEnvMachines())[0];
}

export function listMachines() {
  return Object.entries(loadMachines()).map(([id, m]) => ({
    id,
    upstream: m.upstream,
    system: !!m.system,
    owner_user: m.owner_user || null,
    note: m.note || '',
    created_at: m.created_at || null,
  }));
}

export function listMachineIds() {
  return Object.keys(loadMachines());
}

function portInUse(port) {
  return Object.values(loadMachines()).some((m) => m.upstream.endsWith(':' + port));
}

// 注册机器(成员自助):分配远端端口 + machine_token;幂等(同人同 id 返回原注册)
export function registerMachine(id, ownerUser, note = '') {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) return { error: 'machine_id: 小写字母数字-_ 2-32 位' };
  loadFileMachines();
  const existing = fileMachines.find((m) => m.id === id);
  if (existing) {
    if (existing.owner_user === ownerUser) return { machine: existing, reused: true };
    return { error: 'machine_id 已被占用' };
  }
  if (loadEnvMachines()[id]) return { error: 'machine_id 与系统机器冲突' };
  let port = null;
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!portInUse(p)) { port = p; break; }
  }
  if (!port) return { error: '端口池耗尽' };
  const m = {
    id,
    upstream: `http://127.0.0.1:${port}`,
    token: randomBytes(24).toString('base64url'),
    remote_port: port,
    owner_user: ownerUser,
    note: String(note || '').slice(0, 120),
    created_at: new Date().toISOString(),
  };
  fileMachines.push(m);
  saveFileMachines();
  return { machine: m, reused: false };
}
