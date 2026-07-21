// kimi-remote-gateway entry point.
// Route order matters: login/logout/healthz -> /api/* (JWT + allowlist +
// streaming proxy) -> static H5 from WEB_DIR -> /ws bridge (upgrade).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  issueToken,
  buildAuthCookie,
  buildClearCookie,
  requireAuth,
  loginRateLimited,
  recordLoginFailure,
  clearLoginFailures,
} from './auth.js';
import { verifyUser, canAccessMachine, addMember, findUser, grantMachine } from './users.js';
import { audit } from './audit.js';
import { getMachine, defaultMachineId, listMachines, registerMachine } from './machines.js';
import { createInvite, listInvites, getInvite, isUsable, markUsed } from './invites.js';
import { authorizeMachineKey } from './sshkeys.js';
import { allowlistMiddleware } from './allowlist.js';
import { proxyRequest } from './proxy.js';
import { setupWsBridge } from './ws.js';
import { getOverlay, patchSession } from './overlay.js';
import { fleetSessions, fleetMessages, fleetTakeover } from './fleet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev convenience: load gateway/.env if present (existing env vars win).
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const WEB_DIR = process.env.WEB_DIR
  ? path.resolve(__dirname, process.env.WEB_DIR)
  : path.resolve(__dirname, '../../web');

if (!process.env.JWT_SECRET || !process.env.LOGIN_PASSWORD_SCRYPT) {
  console.error('JWT_SECRET and LOGIN_PASSWORD_SCRYPT must be set');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

// --- auth ---
// express.json() is mounted ONLY on /login; the proxy path must never see a
// body parser.
app.post('/login', express.json({ limit: '16kb' }), (req, res) => {
  const ip = req.socket.remoteAddress;
  if (loginRateLimited(ip)) {
    audit('login.rate_limited', req, {});
    return res.status(429).json({ code: 1, msg: 'too many attempts' });
  }
  const body = req.body || {};
  const password = body.password;
  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : 'owner';
  if (typeof password !== 'string') {
    recordLoginFailure(ip);
    return res.status(401).json({ code: 1, msg: 'unauthorized' });
  }
  const user = verifyUser(username, password);
  if (!user) {
    recordLoginFailure(ip);
    audit('login.failed', req, { username });
    return res.status(401).json({ code: 1, msg: 'unauthorized' });
  }
  clearLoginFailures(ip);
  res.setHeader('Set-Cookie', buildAuthCookie(issueToken(user.name, user.role)));
  audit('login.ok', req, { username: user.name, role: user.role });
  res.status(204).end();
});

app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', buildClearCookie());
  res.status(204).end();
});

// --- gateway health (also probes upstream) ---
app.get('/healthz', (req, res) => {
  const base = new URL(process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627');
  const probe = http.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: 'GET',
      path: '/api/v1/healthz',
      headers: { authorization: `Bearer ${process.env.KIMI_TOKEN}` },
      timeout: 3000,
    },
    (up) => {
      up.resume();
      res.json({ ok: true, upstream: up.statusCode >= 200 && up.statusCode < 300 });
    }
  );
  probe.on('timeout', () => probe.destroy());
  probe.on('error', () => res.json({ ok: true, upstream: false }));
  probe.end();
});

// --- 机器注册(成员自助)与列表 ---
app.get('/machines', requireAuth, (req, res) => {
  const all = listMachines();
  const items = req.user.role === 'admin'
    ? all
    : all.filter((m) => canAccessMachine(
        { role: req.user.role, machines: findUser(req.user.sub)?.machines || [] }, m.id));
  res.json({ code: 0, msg: 'success', data: { items } });
});

app.post('/machines/register', requireAuth, express.json({ limit: '16kb' }), (req, res) => {
  const id = String(req.body?.machine_id || '').trim();
  const note = req.body?.note;
  const out = registerMachine(id, req.user.sub, note);
  if (out.error) {
    audit('machine.register_failed', req, { machine_id: id, error: out.error });
    return res.status(400).json({ code: 1, msg: out.error });
  }
  // 授权该用户访问这台机器
  grantMachine(req.user.sub, id);
  audit('machine.registered', req, { machine_id: id, remote_port: out.machine.remote_port, reused: !!out.reused });
  res.json({
    code: 0, msg: 'success',
    data: {
      machine_id: id,
      remote_port: out.machine.remote_port,
      machine_token: out.machine.token,
      reused: !!out.reused,
    },
  });
});

// 登记成员机隧道公钥(仅机器属主;写服务器 tunnel 账号 authorized_keys 受限条目)
app.post('/machines/:id/pubkey', requireAuth, express.json({ limit: '16kb' }), (req, res) => {
  const id = req.params.id;
  const m = getMachine(id);
  if (!m) return res.status(404).json({ code: 1, msg: 'unknown machine' });
  const effective = {
    role: req.user.role,
    machines: req.user.role === 'admin' ? ['*'] : (findUser(req.user.sub)?.machines || []),
  };
  if (!canAccessMachine(effective, id)) {
    audit('machine.pubkey_forbidden', req, { machine: id });
    return res.status(403).json({ code: 1, msg: 'no access to this machine' });
  }
  const out = authorizeMachineKey(id, m.remote_port || Number(m.upstream.split(':').pop()), req.body?.pubkey);
  if (out.error) return res.status(400).json({ code: 1, msg: out.error });
  audit('machine.pubkey_registered', req, { machine: id });
  res.json({ code: 0, msg: 'success', data: { registered: true } });
});

// --- 邀请配对(v0.4c):admin 发邀请,成员凭 token 设密码入驻 ---
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    audit('admin.forbidden', req, {});
    return res.status(403).json({ code: 1, msg: 'admin only' });
  }
  next();
}

app.post('/invites', requireAuth, requireAdmin, express.json({ limit: '16kb' }), (req, res) => {
  const inv = createInvite(req.user.sub, {
    machines: Array.isArray(req.body?.machines) ? req.body.machines : [],
    expires_in_sec: req.body?.expires_in_sec,
    note: req.body?.note,
  });
  audit('invite.create', req, { token: inv.token.slice(0, 8) + '…', expires_at: inv.expires_at });
  res.json({ code: 0, msg: 'success', data: { token: inv.token, expires_at: inv.expires_at, url: `/#/invite/${inv.token}` } });
});

app.get('/invites', requireAuth, requireAdmin, (req, res) => {
  const items = listInvites().map((i) => ({
    token_head: i.token.slice(0, 8) + '…',
    created_by: i.created_by, created_at: i.created_at, expires_at: i.expires_at,
    machines: i.machines, note: i.note, used_by: i.used_by, used_at: i.used_at,
    usable: isUsable(i),
  }));
  res.json({ code: 0, msg: 'success', data: { items } });
});

// 邀请信息(公开,给邀请页预填;不含敏感字段)
app.get('/invites/:token', (req, res) => {
  const inv = getInvite(req.params.token);
  if (!inv || !isUsable(inv)) {
    return res.status(404).json({ code: 1, msg: 'invite not found or expired' });
  }
  res.json({ code: 0, msg: 'success', data: { note: inv.note, expires_at: inv.expires_at, machines: inv.machines } });
});

// 认领邀请(公开):设密码 → 建账号 → 自动登录
app.post('/invites/:token/claim', express.json({ limit: '16kb' }), (req, res) => {
  const inv = getInvite(req.params.token);
  if (!inv || !isUsable(inv)) {
    return res.status(404).json({ code: 1, msg: 'invite not found or expired' });
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{2,32}$/.test(username.trim())) {
    return res.status(400).json({ code: 1, msg: 'username: 2-32 位字母数字._-' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ code: 1, msg: 'password 至少 6 位' });
  }
  const name = username.trim();
  const user = addMember(name, password, inv.machines);
  if (!user) {
    audit('invite.claim_conflict', req, { username: name });
    return res.status(409).json({ code: 1, msg: '用户名已存在' });
  }
  markUsed(inv.token, name);
  res.setHeader('Set-Cookie', buildAuthCookie(issueToken(user.name, user.role)));
  audit('invite.claimed', req, { username: name, machines: inv.machines });
  res.json({ code: 0, msg: 'success', data: { username: name, role: user.role, machines: inv.machines } });
});

// --- overlay(网关侧会话元数据:重命名/置顶,上游无 PATCH 能力的补丁层)---
app.get('/overlay/session-meta', requireAuth, (req, res) => {
  res.json({ code: 0, msg: 'success', data: getOverlay() });
});

// --- fleet 联邦:五源会话聚合(kimi API 之外的 codex/claude/zcode/workbuddy)---
app.get('/fleet/sessions', requireAuth, fleetSessions);
app.get('/fleet/messages', requireAuth, fleetMessages);
app.post('/fleet/takeover', requireAuth, fleetTakeover);
app.put('/overlay/sessions/:id', requireAuth, express.json({ limit: '16kb' }), async (req, res, next) => {
  try {
    const { title, pinned } = req.body || {};
    if (title !== undefined && title !== null && typeof title !== 'string') {
      return res.status(400).json({ code: 1, msg: 'title must be string|null' });
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      return res.status(400).json({ code: 1, msg: 'pinned must be boolean' });
    }
    // 只传递调用方真正给了的键;undefined 键绝不能进补丁层(否则被 String() 成 "undefined" 落库)
    const patch = {};
    if (title !== undefined) patch.title = title;
    if (pinned !== undefined) patch.pinned = pinned;

    // D-17 对齐:写新 title 时记录落笔瞬间的上游 title(后续上游再改名,H5 以最新者胜)
    if (typeof title === 'string' && title !== '') {
      const upBase = new URL(process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627');
      try {
        const up = await fetch(`${upBase.origin}/api/v1/sessions/${encodeURIComponent(req.params.id)}`, {
          headers: { authorization: `Bearer ${process.env.KIMI_TOKEN}` },
          signal: AbortSignal.timeout(3000),
        });
        if (up.ok) {
          const j = await up.json();
          if (j && j.data && typeof j.data.title === 'string') patch.base_title = j.data.title;
        }
      } catch {
        // 上游不可达:base_title 缺省,合并端按"未知"处理(沿用 overlay)
      }
      patch.at = new Date().toISOString();
    }

    const entry = patchSession(req.params.id, patch);
    audit('overlay.patch', req, { sid: req.params.id, title: title !== undefined, pinned });
    res.json({ code: 0, msg: 'success', data: entry });
  } catch (e) {
    next(e);
  }
});

// --- 机器命名空间代理(机器级授权 → 白名单 → 审计 → 流式代理)---
function machineMiddleware(req, res, next) {
  const id = req.params.machine;
  const machine = getMachine(id);
  if (!machine) {
    return res.status(404).json({ code: 1, msg: 'unknown machine' });
  }
  // JWT 只带 sub/role;机器授权以用户表实时值为准(授权变更即生效,且兼容旧 token 无 machines 字段)
  const effective = {
    role: req.user.role,
    machines: req.user.role === 'admin' ? ['*'] : (findUser(req.user.sub)?.machines || []),
  };
  if (!canAccessMachine(effective, id)) {
    audit('proxy.forbidden', req, { machine: id });
    return res.status(403).json({ code: 1, msg: 'no access to this machine' });
  }
  req.machine = machine;
  // harness 上游解析:/m/:machine/h/:harness/* → 该 harness 的上游(未登记 404)
  if (req.params.harness) {
    const h = req.params.harness.toLowerCase();
    const hu = machine.harnesses && machine.harnesses[h];
    if (!hu) {
      audit('proxy.unknown_harness', req, { machine: id, harness: h });
      return res.status(404).json({ code: 1, msg: `unknown harness on this machine: ${h}` });
    }
    req.harnessUpstream = { upstream: hu.upstream, token: hu.token || machine.token };
    req.proxyPath = '/h/' + h + '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  } else {
    req.proxyPath = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  next();
}

app.use('/m/:machine/h/:harness/api', requireAuth, machineMiddleware, allowlistMiddleware, (req, res, next) => {
  audit('proxy', req, { method: req.method, machine: req.params.machine, harness: req.params.harness, path: req.proxyPath.slice(0, 120) });
  next();
}, proxyRequest);

app.use('/m/:machine/api', requireAuth, machineMiddleware, allowlistMiddleware, (req, res, next) => {
  audit('proxy', req, { method: req.method, machine: req.params.machine, path: req.proxyPath.slice(0, 120) });
  next();
}, proxyRequest);
function defaultMachineMiddleware(req, res, next) {
  req.params.machine = defaultMachineId();
  machineMiddleware(req, res, next);
}

app.use('/api', requireAuth, defaultMachineMiddleware, allowlistMiddleware, (req, res, next) => {
  audit('proxy', req, { method: req.method, path: req.originalUrl.slice(0, 120) });
  next();
}, proxyRequest);

// --- static H5 + agent 资产(安装脚本/本地 adapter)---
app.use(express.static(WEB_DIR, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // html 永不缓存;带 ?v= 的资产走默认协商缓存(版本号即缓存键,2026-07-20 缓存事故防线)
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/agent', express.static(process.env.AGENT_DIR || path.resolve(__dirname, '../../agent')));

const server = http.createServer(app);
// Long-lived streaming responses (SSE-ish prompts, huge uploads) must not be
// cut by Node's default request/socket timeouts.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.timeout = 0;

setupWsBridge(server);

server.listen(PORT, HOST, () => {
  console.log(`kimi-remote-gateway listening on http://${HOST}:${PORT}`);
  console.log(`upstream: ${process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627'}`);
  console.log(`web dir: ${WEB_DIR} (${fs.existsSync(WEB_DIR) ? 'found' : 'MISSING'})`);
});
