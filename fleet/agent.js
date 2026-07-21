// fleet/agent.js — Mac 侧联邦会话探针服务(loopback only)
// 端口 58628,经 SSH 隧道暴露到网关;Bearer 鉴权(FLEET_TOKEN)。
// GET /healthz        → {ok:true}
// GET /fleet/sessions → {code:0, data:{items:[五源统一会话], generated_at}}
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { probeAll, getMessages } from './probe-core.js';

const PORT = Number(process.env.FLEET_PORT || 58628);
const HOST = process.env.FLEET_HOST || '127.0.0.1';
const TOKEN = process.env.FLEET_TOKEN || '';
const TAKEOVER_LOG = process.env.TAKEOVER_LOG || `${process.env.HOME}/.kimi-remote-takeover.log`;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/Users/essence/.local/node/bin/claude';
const CODEX_BIN = process.env.CODEX_BIN || '/Users/essence/.local/node/bin/codex';
// launchd 环境 PATH 极简,npm 包的 env-node shebang 会找不到 node;把 agent 自己的 node 目录补进 PATH
const NODE_DIR = path.dirname(process.execPath);
function withNodePath(env) {
  env.PATH = `${NODE_DIR}:${env.PATH || '/usr/bin:/bin'}`;
  return env;
}

function authorized(req) {
  return TOKEN && req.headers.authorization === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function audit(line) {
  try { fs.appendFileSync(TAKEOVER_LOG, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}

// Claude 接管:同会话 cwd 下 `claude -r <id> --model m3 -p <text>`(经 M2 litellm 国产网关)
function claudeTakeover({ id, text, cwd }) {
  return new Promise((resolve) => {
    const workdir = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME;
    const env = withNodePath({
      ...process.env,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_BASE_URL || '',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',
      ANTHROPIC_MODEL: 'm3',
    });
    execFile(CLAUDE_BIN, ['-r', id, '--model', 'm3', '-p', text, '--output-format', 'json'],
      { cwd: workdir, env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let out = null;
        try { out = JSON.parse(stdout); } catch { /* ignore */ }
        resolve({
          ok: !err && out && !out.is_error,
          result: out ? String(out.result ?? '').slice(0, 4000) : '',
          session_id: out?.session_id || id,
          error: err ? String(stderr || err.message).slice(0, 500) : (out && out.is_error ? String(out.result).slice(0, 500) : ''),
        });
      });
  });
}

// Codex 接管:`codex exec resume <id> <text>`(默认走本机 codex 登录态/OpenAI 订阅;
// CODEX_GW_FORCE=1 时走 M2 litellm m3 通道——responses 适配未完,暂为实验开关)
function codexTakeover({ id, text, cwd }) {
  return new Promise((resolve) => {
    const workdir = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME;
    const env = withNodePath({ ...process.env });
    const args = ['exec', 'resume', id, '--skip-git-repo-check'];
    if (process.env.CODEX_GW_FORCE === '1') {
      const gw = process.env.CODEX_GW_URL || process.env.CLAUDE_BASE_URL || '';
      env.ANTHROPIC_AUTH_TOKEN = process.env.CODEX_GW_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
      args.push(
        '-c', 'model_providers.litellm.name="litellm"',
        '-c', `model_providers.litellm.base_url="${gw}"`,
        '-c', 'model_providers.litellm.env_key="ANTHROPIC_AUTH_TOKEN"',
        '-c', 'model_providers.litellm.wire_api="responses"',
        '-c', 'model_provider="litellm"', '-c', 'model="m3"',
      );
    }
    args.push(text);
    execFile(CODEX_BIN, args, { cwd: workdir, env, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const lines = out.split('\n').map((l) => l.trimEnd()).filter(Boolean);
        const bad = lines.find((l) => /^ERROR:/.test(l));
        const reply = [...lines].reverse().find((l) => l && !/^(warning|ERROR|token|user$|--------|thinking)/.test(l));
        resolve({
          ok: !err && !bad && !!reply,
          result: (reply || '').slice(0, 4000),
          session_id: id,
          error: err ? String(stderr || err.message).slice(0, 500) : (bad || ''),
        });
      });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if (url.pathname === '/healthz') {
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (!authorized(req)) {
    res.statusCode = 401;
    res.end(JSON.stringify({ code: 1, msg: 'unauthorized' }));
    return;
  }
  if (url.pathname === '/fleet/sessions' && req.method === 'GET') {
    try {
      const items = probeAll({ limit: Number(url.searchParams.get('limit')) || 50 });
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { items, generated_at: new Date().toISOString() } }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 1, msg: String(e && e.message || e) }));
    }
    return;
  }
  if (url.pathname === '/fleet/messages' && req.method === 'GET') {
    const h = url.searchParams.get('h');
    const id = url.searchParams.get('id') || '';
    const file = url.searchParams.get('file') || '';
    if (!['codex', 'claude', 'zcode', 'workbuddy'].includes(h) || !id) {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: 1, msg: 'bad harness/id' }));
      return;
    }
    try {
      const items = getMessages(h, id, file, Number(url.searchParams.get('limit')) || 120);
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { items } }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 1, msg: String(e && e.message || e) }));
    }
    return;
  }
  if (url.pathname === '/fleet/takeover' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: 1, msg: 'bad json' }));
      return;
    }
    const { harness, id, text, cwd } = body || {};
    if (!['claude', 'codex'].includes(harness) || !id || typeof text !== 'string' || !text.trim()) {
      res.statusCode = 400;
      res.end(JSON.stringify({ code: 1, msg: 'takeover 目前支持 claude/codex;需 id 与 text' }));
      return;
    }
    audit(`takeover ${harness} ${id} cwd=${cwd || '-'} len=${text.length}`);
    const r = harness === 'claude'
      ? await claudeTakeover({ id, text: text.trim(), cwd })
      : await codexTakeover({ id, text: text.trim(), cwd });
    audit(`  -> ok=${r.ok} ${r.error ? 'err=' + r.error.slice(0, 120) : 'result_len=' + r.result.length}`);
    res.statusCode = r.ok ? 200 : 502;
    res.end(JSON.stringify({ code: r.ok ? 0 : 1, msg: r.ok ? 'success' : (r.error || 'takeover failed'), data: r }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 1, msg: 'not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`fleet-agent listening on http://${HOST}:${PORT}`);
});

