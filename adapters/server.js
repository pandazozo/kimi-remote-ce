#!/usr/bin/env node
// kimi-remote adapter server(设备侧,multi-harness)
// 监听 127.0.0.1:58629;入站 Bearer == MACHINE_TOKEN;按 /h/:harness/ 分发:
//   /h/kimi/*    → 代理本机 kimi server(58627,本地注入 kimi token)
//   /h/claude/*  → Agent SDK 引擎(claude/* 路由)
// 零信任边界:kimi token / claude OAuth 均不出机。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { ChatManager } from './claude/engine.js';

const MACHINE_TOKEN = process.env.MACHINE_TOKEN || '';
const FLEET_TOKEN = process.env.FLEET_TOKEN || process.env.MACHINE_TOKEN || '';
const FLEET_UPSTREAM = new URL(process.env.FLEET_UPSTREAM || 'http://127.0.0.1:58628');
const TOKEN_FILE = process.env.KIMI_TOKEN_FILE || path.join(os.homedir(), '.kimi-code', 'server.token');
const KIMI_UPSTREAM = new URL(process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627');
const PORT = Number(process.env.ADAPTER_PORT || 58629);
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
// kimi-code 0.24+ v2 引擎不回退 default_model,创建/prompt 必须显式带 model
const KIMI_DEFAULT_MODEL = process.env.KIMI_DEFAULT_MODEL || 'kimi-code/k3';

if (!MACHINE_TOKEN) { console.error('MACHINE_TOKEN 必填'); process.exit(1); }

const manager = new ChatManager({
  onSessionId: (chat) => {
    if (chat.pendingTitle) {
      const t = chat.pendingTitle;
      chat.pendingTitle = undefined;
      renameSession(chat.sessionId, t).catch(() => {});
    }
  },
});

function kimiToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return null; }
}

// ---------- kimi 内部调用(adapter → kimi server,JSON 小请求)----------
async function kimiFetch(p, { method = 'GET', body } = {}) {
  const kt = kimiToken();
  if (!kt) throw new Error('kimi token unavailable');
  const resp = await fetch(new URL(p, KIMI_UPSTREAM), {
    method,
    headers: { authorization: `Bearer ${kt}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return resp.json().catch(() => null);
}

// 会话 profile 内存缓存(TTL 60s),取 agent_config.model 用
const profileCache = new Map(); // sid -> { at, model }
async function kimiSessionModel(sid) {
  const hit = profileCache.get(sid);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.model;
  let model = '';
  try {
    const r = await kimiFetch(`/api/v1/sessions/${encodeURIComponent(sid)}/profile`);
    model = r?.data?.agent_config?.model || r?.data?.model || '';
  } catch { /* 失败回落默认 model */ }
  profileCache.set(sid, { at: Date.now(), model });
  return model;
}

function bearerOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function authed(req, res) {
  if (bearerOf(req) === MACHINE_TOKEN) return true;
  json(res, 401, { code: 1, msg: 'unauthorized' });
  return false;
}

function json(res, status, body) {
  const b = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// ---------- 通用透传(本地注入 token)----------
function proxyTo(req, res, base, token) {
  if (!token) return json(res, 502, { code: 1, msg: 'upstream token unavailable' });
  const headers = { ...req.headers, host: base.host, authorization: `Bearer ${token}` };
  const up = http.request({
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port,
    method: req.method,
    path: req.url,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });
  up.setTimeout(60 * 60 * 1000, () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => { if (!res.headersSent) json(res, 502, { code: 1, msg: 'upstream unreachable' }); else res.destroy(); });
  req.on('error', () => up.destroy());
  req.pipe(up);
}

// ---------- kimi 透传(本地注入 kimi token)----------
function proxyToKimi(req, res) {
  const kt = kimiToken();
  if (!kt) return json(res, 502, { code: 1, msg: 'kimi token unavailable' });
  const headers = { ...req.headers, host: KIMI_UPSTREAM.host, authorization: `Bearer ${kt}` };
  delete headers.connection; delete headers['keep-alive']; delete headers['proxy-connection']; // 逐跳连接头剥除(网关同款 400 根因预防)
  const up = http.request({
    protocol: KIMI_UPSTREAM.protocol,
    hostname: KIMI_UPSTREAM.hostname,
    port: KIMI_UPSTREAM.port,
    method: req.method,
    path: req.url.replace(/^\/h\/kimi/, ''),
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });
  up.setTimeout(60 * 60 * 1000, () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => { if (!res.headersSent) json(res, 502, { code: 1, msg: 'upstream unreachable' }); else res.destroy(); });
  req.on('error', () => up.destroy());
  req.pipe(up);
}

// ---------- kimi 控制类转发(缓冲 JSON 响应以便加工)----------
function callKimi(res, method, p, body, mutate) {
  const kt = kimiToken();
  if (!kt) return json(res, 502, { code: 1, msg: 'kimi token unavailable' });
  const hasBody = body !== undefined && body !== null;
  const payload = hasBody ? JSON.stringify(body) : '';
  const headers = { authorization: `Bearer ${kt}`, 'content-length': Buffer.byteLength(payload) };
  if (hasBody) headers['content-type'] = 'application/json';
  const up = http.request({
    protocol: KIMI_UPSTREAM.protocol,
    hostname: KIMI_UPSTREAM.hostname,
    port: KIMI_UPSTREAM.port,
    method,
    path: p,
    headers,
  }, (upRes) => {
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let out = raw;
      try {
        const parsed = JSON.parse(raw);
        out = JSON.stringify(mutate ? (mutate(parsed) ?? parsed) : parsed);
      } catch { /* 非 JSON 原样回传 */ }
      const outHeaders = { ...upRes.headers, 'content-length': Buffer.byteLength(out) };
      delete outHeaders['transfer-encoding'];
      res.writeHead(upRes.statusCode, outHeaders);
      res.end(out);
    });
    upRes.on('error', () => res.destroy());
  });
  up.setTimeout(60 * 1000, () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => { if (!res.headersSent) json(res, 502, { code: 1, msg: 'upstream unreachable' }); else res.destroy(); });
  up.end(payload);
}

// ---------- kimi 路由拦截(v2 引擎修复,其余落 proxyToKimi)----------
function handleKimi(req, res, url) {
  const p = url.pathname.replace(/^\/h\/kimi/, '') || '/';
  const qs = url.search || '';

  // POST /api/v1/sessions:创建补 agent_config.model(v2 不回退 default_model)
  if (req.method === 'POST' && p === '/api/v1/sessions') return kimiCreateSession(req, res);

  // POST /api/v1/sessions/:id/prompts:顶层 model 兜底(空 model 静默吞 prompt)
  const mPrompt = p.match(/^\/api\/v1\/sessions\/([^/]+)\/prompts$/);
  if (req.method === 'POST' && mPrompt) return kimiSubmitPrompt(req, res, decodeURIComponent(mPrompt[1]));

  // GET /api/v1/sessions/:id/status:附加 last_error,让 H5 看到真失败而非假空闲
  const mStatus = p.match(/^\/api\/v1\/sessions\/([^/]+)\/status$/);
  if (req.method === 'GET' && mStatus) {
    const sid = decodeURIComponent(mStatus[1]);
    return callKimi(res, 'GET', `/api/v1/sessions/${encodeURIComponent(sid)}/status${qs}`, null, (parsed) => {
      if (parsed?.data && typeof parsed.data === 'object') parsed.data.last_error = sessionLastError.get(sid) || null;
      return parsed;
    });
  }

  return proxyToKimi(req, res);
}

async function kimiCreateSession(req, res) {
  const body = await readBody(req);
  if (!body?.agent_config?.model) {
    body.agent_config = { ...(body?.agent_config || {}), model: KIMI_DEFAULT_MODEL };
  }
  return callKimi(res, 'POST', '/api/v1/sessions', body, (parsed) => {
    const sid = parsed?.data?.id;
    if (sid) {
      profileCache.set(sid, { at: Date.now(), model: body.agent_config.model });
      subscribeKimiSessions([sid], { force: true }); // 立即订阅,首个 prompt 才能被执行
    }
    return parsed;
  });
}

async function kimiSubmitPrompt(req, res, sid) {
  const body = await readBody(req);
  if (!body?.model) {
    body.model = (await kimiSessionModel(sid)) || KIMI_DEFAULT_MODEL;
  }
  // v2 惰性执行:先 force 订阅并等 ack 落地,再转发 prompt(杜绝"订阅未生效 prompt 被吞")
  await subscribeKimiSessions([sid], { force: true });
  return callKimi(res, 'POST', `/api/v1/sessions/${encodeURIComponent(sid)}/prompts`, body);
}

// ---------- kimi 常驻 WS 订阅器 ----------
// kimi-code 0.24+ v2 引擎:REST 提交的 prompt 需有 WS 连接订阅该会话,turn 才真正执行。
// 本进程维护一条常驻 WS,client_hello 覆盖全部未归档会话,新会话动态 subscribe,
// 断线指数退避重连;并从事件流捕获失败显式化(turn.ended failed / error)。
const kimiEvents = new EventEmitter();   // 流式事件钩子(本进程内消费,暂不桥接网关)
kimiEvents.setMaxListeners(0);
const sessionLastError = new Map();      // sid -> { code, message, at }
let kimiWs = null;
let kimiWsReady = false;
const wsSubscribed = new Set();          // 当前连接已 subscribe 的会话
let wsRetry = 0;
let wsReconnectTimer = null;
let wsPingTimer = null;

function kimiWsUrl() {
  const wsProto = KIMI_UPSTREAM.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${KIMI_UPSTREAM.host}/api/v1/ws`;
}

function wsSend(obj) {
  if (kimiWs && kimiWsReady && kimiWs.readyState === WebSocket.OPEN) {
    kimiWs.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// 列出未归档会话。busy 过滤参数语义不明,两种取值都拉再合并去重,避免漏订。
async function listActiveKimiSessions() {
  const ids = new Set();
  for (const busy of ['false', 'true']) {
    let before = '';
    for (let page = 0; page < 10; page++) { // 单侧上限 1000 条,防失控
      const q = new URLSearchParams({ page_size: '100', busy, include_archive: 'false', exclude_empty: 'false', archived_only: 'false' });
      if (before) q.set('before_id', before);
      try {
        const r = await kimiFetch(`/api/v1/sessions?${q}`);
        const items = r?.data?.items || [];
        for (const s of items) if (s.id && !s.archived) ids.add(s.id);
        if (!r?.data?.has_more || !items.length) break;
        before = items[items.length - 1].id;
      } catch { break; }
    }
  }
  return [...ids];
}

function subscribeKimiSessions(ids, { force = false } = {}) {
  const fresh = (ids || []).filter((id) => id && (force || !wsSubscribed.has(id)));
  if (!fresh.length || !kimiWsReady) return Promise.resolve(false);
  const ackId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (!wsSend({ type: 'subscribe', id: ackId, payload: { session_ids: fresh } })) return Promise.resolve(false);
  for (const id of fresh) wsSubscribed.add(id);
  console.log(`[kimi-ws] subscribe +${fresh.length}${force ? '(force)' : ''} (total ${wsSubscribed.size})`);
  // 服务端对 subscribe 不回 ack(协议实测:只有 client_hello 有 ack),
  // 同机 loopback 下等 150ms 让订阅帧先于 prompt HTTP 到达即可
  return new Promise((resolve) => setTimeout(() => resolve(true), 150));
}

async function refreshKimiSubscriptions() {
  try { subscribeKimiSessions(await listActiveKimiSessions()); } catch { /* 下轮再试 */ }
}

function handleKimiWsMessage(msg) {
  if (msg.type === 'ping') { // 服务端心跳 → pong(asyncapi 协议)
    wsSend({ type: 'pong', payload: { nonce: msg.payload?.nonce || '' } });
    return;
  }
  if (msg.type === 'error') {
    console.error(`[kimi-ws] server error: ${msg.payload?.code} ${msg.payload?.msg || ''}`.trim());
    return;
  }
  if (msg.type !== 'session_event') return;
  const sid = msg.session_id;
  const ev = msg.payload || {};
  kimiEvents.emit('event', { session_id: sid, seq: msg.seq, event: ev });
  if (ev.type === 'turn.ended') {
    if (ev.reason === 'failed' || ev.reason === 'blocked') {
      const code = ev.error?.code || `turn.${ev.reason}`;
      const message = ev.error?.message || `turn ${ev.reason}`;
      sessionLastError.set(sid, { code, message, at: new Date().toISOString() });
      console.error(`[kimi-ws] turn ${ev.reason} sid=${sid}: ${code} ${message}`);
    } else if (ev.reason === 'completed') {
      sessionLastError.delete(sid);
    }
  } else if (ev.type === 'error') {
    sessionLastError.set(sid, { code: String(ev.code || 'error'), message: ev.message || 'unknown error', at: new Date().toISOString() });
    console.error(`[kimi-ws] error sid=${sid}: ${ev.code} ${ev.message || ''}`);
  } else if (ev.type === 'prompt.submitted') {
    sessionLastError.delete(sid);
  } else if (ev.type === 'turn.started') {
    console.debug(`[kimi-ws] turn.started sid=${sid}`);
  }
}

function connectKimiWs() {
  const kt = kimiToken();
  if (!kt) return scheduleKimiWsReconnect();
  let ws;
  try {
    ws = new WebSocket(kimiWsUrl(), { headers: { authorization: `Bearer ${kt}` } });
  } catch { return scheduleKimiWsReconnect(); }
  kimiWs = ws;
  ws.on('open', async () => {
    kimiWsReady = true;
    wsRetry = 0;
    wsSubscribed.clear();
    const ids = await listActiveKimiSessions();
    wsSend({
      type: 'client_hello',
      id: 'hello-1',
      payload: { client_id: `kimi-remote-adapter-${os.hostname()}`, subscriptions: ids },
    });
    for (const id of ids) wsSubscribed.add(id);
    wsPingTimer = setInterval(() => {
      wsSend({ type: 'ping', id: `ping-${Date.now()}`, payload: { nonce: String(Date.now()) } });
    }, 30 * 1000);
    console.log(`[kimi-ws] connected, hello subscribed ${ids.length} sessions`);
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    try { handleKimiWsMessage(msg); } catch (e) { console.error('[kimi-ws] handle error:', e.message); }
  });
  ws.on('close', () => scheduleKimiWsReconnect());
  ws.on('error', () => { /* close 随后到,统一在 close 重连 */ });
}

function scheduleKimiWsReconnect() {
  kimiWsReady = false;
  clearInterval(wsPingTimer);
  if (wsReconnectTimer) return;
  const delay = Math.min(30 * 1000, 1000 * 2 ** wsRetry++);
  console.log(`[kimi-ws] reconnect in ${delay}ms`);
  wsReconnectTimer = setTimeout(() => { wsReconnectTimer = null; connectKimiWs(); }, delay);
}

// ---------- claude 归一化 ----------
function normalizeSession(s) {
  return {
    id: s.sessionId || s.id,
    title: s.title || s.summary || '',
    busy: manager.runningSessionIds().has(s.sessionId || s.id),
    archived: false,
    updated_at: s.lastModified ? new Date(s.lastModified).toISOString() : null,
    metadata: { cwd: s.cwd || '' },
  };
}

function normalizeMessages(sdkMsgs) {
  const items = [];
  for (const m of sdkMsgs || []) {
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    const blocks = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') blocks.push({ type: 'thinking', thinking: b.thinking });
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_use', tool_name: b.name, tool_call_id: b.id, input: b.input });
      else if (b.type === 'tool_result') blocks.push({ type: 'tool_result', tool_call_id: b.tool_use_id, output: b.content, is_error: b.is_error });
    }
    if (blocks.length) {
      items.push({ id: m.uuid || m.sessionId + '-' + items.length, role: m.message?.role || m.type, content: blocks, created_at: m.timestamp || null });
    }
  }
  return items;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/api/v1/meta') {
      if (!authed(req, res)) return;
      // 合并上游 kimi meta(capabilities 里 websocket 等是 H5 能力开关),叠加多 harness 表
      let upstream = null;
      try { upstream = await kimiFetch('/api/v1/meta'); } catch { /* 上游不可达时退化本地 meta */ }
      const data = upstream?.data && typeof upstream.data === 'object' ? { ...upstream.data } : {};
      data.server_version = data.server_version || '0.5.0';
      data.harnesses = [
        { id: 'kimi', conformance: 'L3', write: true },
        { id: 'claude', conformance: 'L3', write: true, streaming: 'native-delta' },
      ];
      return json(res, 200, { code: 0, msg: 'success', data });
    }

    if (p.startsWith('/h/kimi/')) {
      if (!authed(req, res)) return;
      return handleKimi(req, res, url);
    }

    // 读联邦透传:/fleet/* → fleet/agent.js(58628,并行线读面)
    if (p.startsWith('/fleet/')) {
      if (!authed(req, res)) return;
      return proxyTo(req, res, FLEET_UPSTREAM, FLEET_TOKEN);
    }

    // 默认门:非 /h/ 路径一律落 kimi(兼容现有 H5 与网关默认机路径)
    if (!p.startsWith('/h/')) {
      if (!authed(req, res)) return;
      return handleKimi(req, res, url);
    }

    if (p.startsWith('/h/claude/api/v1/')) {
      if (!authed(req, res)) return;
      const sub = p.slice('/h/claude/api/v1'.length);
      const seg = sub.split('/').filter(Boolean);

      // GET /sessions
      if (req.method === 'GET' && sub === '/sessions') {
        const sessions = await listSessions({ limit: 300 });
        return json(res, 200, { code: 0, msg: 'success', data: { items: sessions.map(normalizeSession), has_more: false } });
      }
      // POST /sessions  {cwd, title?}
      if (req.method === 'POST' && sub === '/sessions') {
        const body = await readBody(req);
        const chat = manager.ensure({ cwd: body.metadata?.cwd || body.cwd || DEFAULT_CWD });
        if (body.title) chat.pendingTitle = body.title;
        return json(res, 200, { code: 0, msg: 'success', data: { id: chat.sessionId || chat.key, draft: !chat.sessionId } });
      }
      // /sessions/:id/...
      if (seg[0] === 'sessions' && seg[1]) {
        const sid = decodeURIComponent(seg[1]);
        const tail = seg.slice(2).join('/');

        if (req.method === 'GET' && tail === 'messages') {
          const msgs = await getSessionMessages(sid);
          return json(res, 200, { code: 0, msg: 'success', data: { items: normalizeMessages(msgs), has_more: false } });
        }
        if (req.method === 'POST' && tail === 'prompts') {
          const body = await readBody(req);
          const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || body.text || '';
          const chat = manager.ensure({ sessionId: sid, cwd: body.cwd || DEFAULT_CWD, mode: body.permission_mode });
          chat.send(text, body.attachments || []);
          return json(res, 200, { code: 0, msg: 'success', data: { prompt_id: chat.sessionId || chat.key } });
        }
        if (req.method === 'GET' && tail === 'events') {
          const chat = manager.ensure({ sessionId: sid, cwd: DEFAULT_CWD });
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const lastSeq = Number(url.searchParams.get('last_seq') || 0);
          chat.addClient(res, lastSeq);
          return;
        }
        if (req.method === 'POST' && tail.startsWith('approvals/')) {
          const pid = decodeURIComponent(tail.split('/')[1] || '');
          const body = await readBody(req);
          const chat = manager.get(sid);
          const ok = chat && chat.resolvePermission(pid, body.decision !== 'rejected', !!body.always);
          return json(res, ok ? 200 : 404, { code: ok ? 0 : 1, msg: ok ? 'success' : 'no such pending permission' });
        }
        if (req.method === 'POST' && tail === 'interrupt') {
          const chat = manager.get(sid);
          if (chat) await chat.interrupt();
          return json(res, 200, { code: 0, msg: 'success' });
        }
        if (req.method === 'POST' && tail === 'mode') {
          const body = await readBody(req);
          const chat = manager.ensure({ sessionId: sid, cwd: DEFAULT_CWD });
          await chat.setMode(body.mode || 'default');
          return json(res, 200, { code: 0, msg: 'success' });
        }
      }
      return json(res, 404, { code: 1, msg: 'not found' });
    }

    json(res, 404, { code: 1, msg: 'not found' });
  } catch (e) {
    console.error('[adapter] error:', e);
    if (!res.headersSent) json(res, 500, { code: 1, msg: String(e.message || e) });
  }
});

server.on('clientError', (err, socket) => {
  console.error('[adapter clientError]', err.code, err.message, (err.rawPacket ? String(err.rawPacket).slice(0, 200) : ''));
  try { socket.destroy(); } catch {}
});
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.timeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`kimi-remote adapter server on 127.0.0.1:${PORT} (kimi→${KIMI_UPSTREAM}, claude→SDK)`);
});

// 常驻 WS 订阅器(v2 引擎 turn 执行前提)+ 定期补订新会话
connectKimiWs();
const listRefreshTimer = setInterval(refreshKimiSubscriptions, 60 * 1000);
listRefreshTimer.unref();
