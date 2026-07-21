// WebSocket bridge: client <-> upstream kimi server /api/v1/ws.
//
// Upstream auth: the kimi server accepts the Bearer token either as an
// `Authorization: Bearer <token>` header or as a `?token=<token>` query
// parameter. We try the header first and fall back to the query form on a
// 401/403 handshake rejection.
//
//   >>> Live test result (2026-07-19, kimi server 127.0.0.1:58627):
//   Authorization header works on first attempt (query-token fallback unused).
//   server_hello: protocol_version 2, no heartbeat_ms — upstream does not
//   require app-level client ping; idle connections stay up. client_hello
//   is answered with type "ack" {accepted_subscriptions,resync_required,cursors}.
//
// Security filter: client->server frames whose first 200 chars declare a
// `"type":"terminal_*"` or `"type":"watch_fs_*"` frame are dropped, and the
// client gets an error frame back. Terminal/fs-watch never leaves the gateway.
import { WebSocketServer, WebSocket } from 'ws';
import { authCookieValue, parseToken } from './auth.js';
import { audit } from './audit.js';
import { getMachine } from './machines.js';
import { canAccessMachine, findUser } from './users.js';

const BLOCKED_PREFIXES = ['"type":"terminal_', '"type":"watch_fs_'];

function upstreamWsUrl(machine, withQueryToken) {
  const base = machine
    ? new URL(machine.ws_upstream || machine.upstream)
    : new URL(process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627');
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/api/v1/ws';
  base.search = '';
  if (withQueryToken) base.searchParams.set('token', machine ? machine.token : process.env.KIMI_TOKEN);
  return base.toString();
}

function isBlockedFrame(data) {
  const head = data.toString('utf8', 0, 200);
  // tolerate arbitrary JSON whitespace inside the first 200 chars
  const squashed = head.replace(/\s+/g, '');
  return BLOCKED_PREFIXES.some((p) => squashed.includes(p));
}

// 导出供单元测试使用(不改运行行为)
export { isBlockedFrame, sanitizeCloseCode };

function blockedFrameError() {
  return JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    payload: {
      code: 1,
      msg: 'frame type blocked by gateway (terminal_*/watch_fs_* are not allowed)',
      fatal: false,
    },
  });
}

// Connect to upstream; header auth first, query-token auth as fallback.
// machine 为空时回退单机 env(KIMI_UPSTREAM/KIMI_TOKEN)。
function connectUpstream(machine, onOpen, onGiveUp) {
  const token = machine ? machine.token : process.env.KIMI_TOKEN;
  let usedQueryToken = false;

  const attempt = () => {
    const ws = new WebSocket(upstreamWsUrl(machine, usedQueryToken), {
      headers: usedQueryToken ? {} : { Authorization: `Bearer ${token}` },
      maxPayload: 256 * 1024 * 1024,
    });
    ws.once('open', () => onOpen(ws, usedQueryToken));
    ws.once('unexpected-response', (req, res) => {
      const status = res.statusCode;
      res.resume(); // drain
      if (!usedQueryToken && (status === 401 || status === 403)) {
        usedQueryToken = true;
        attempt();
      } else {
        onGiveUp(new Error(`upstream ws handshake rejected: HTTP ${status}`));
      }
    });
    ws.once('error', (err) => {
      // connection-level failure before open (or after unexpected-response)
      onGiveUp(err);
    });
  };

  attempt();
}

// 1005/1006/1015 等保留码不能放进 close 帧,否则 ws 抛 TypeError 直接崩进程
function sanitizeCloseCode(code) {
  return (typeof code === 'number' && code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code))
    ? code
    : 1000;
}

export function setupWsBridge(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // 路由:/ws(默认机) 或 /m/:machine/ws(命名空间,含机器级授权)
    let machine = null;
    if (url.pathname === '/ws') {
      machine = null;
    } else {
      const m = url.pathname.match(/^\/m\/([^/]+)\/ws$/);
      if (!m) { socket.destroy(); return; }
      machine = getMachine(m[1]);
      if (!machine) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const payload = parseToken(authCookieValue(req));
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (machine) {
      const mid = url.pathname.split('/')[2];
      const effective = {
        role: payload.role,
        machines: payload.role === 'admin' ? ['*'] : (findUser(payload.sub)?.machines || []),
      };
      if (!canAccessMachine(effective, mid)) {
        audit('ws.forbidden', req, { machine: mid });
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    audit('ws.connect', req, machine ? { machine: url.pathname.split('/')[2] } : {});
    wss.handleUpgrade(req, socket, head, (client) => bridge(client, machine));
  });

  function bridge(client, machine) {
    let upstream = null;
    let clientGone = false;
    // Frames that arrive before the upstream socket is open.
    let pending = [];

    const closeClient = (code, reason) => {
      if (clientGone) return;
      clientGone = true;
      try {
        client.close(code, reason);
      } catch {}
    };

    const forward = ({ data, isBinary }) => {
      if (isBlockedFrame(data)) {
        client.send(blockedFrameError());
        return;
      }
      upstream.send(data, { binary: isBinary });
    };

    connectUpstream(
      machine,
      (ws, usedQueryToken) => {
        if (clientGone) {
          ws.close();
          return;
        }
        upstream = ws;
        console.log(
          `[ws] upstream connected (auth: ${usedQueryToken ? 'query token' : 'Authorization header'})`
        );

        // upstream -> client: pass through untouched
        upstream.on('message', (data, isBinary) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
          }
        });

        // Upstream went away: take the client down with it (1011).
        upstream.on('close', (code, reason) => closeClient(1011, reason));
        upstream.on('error', () => closeClient(1011));

        if (pending.length) {
          for (const f of pending) forward(f);
          pending = [];
        }
      },
      (err) => {
        console.error(`[ws] upstream connect failed: ${err.message}`);
        closeClient(1011);
      }
    );

    // client -> upstream: filtered
    client.on('message', (data, isBinary) => {
      if (!upstream || upstream.readyState !== WebSocket.OPEN) {
        pending.push({ data, isBinary });
        return;
      }
      forward({ data, isBinary });
    });

    client.on('close', (code, reason) => {
      clientGone = true;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close(sanitizeCloseCode(code), reason);
      }
    });
    client.on('error', () => {
      clientGone = true;
      if (upstream) upstream.terminate();
    });
  }
}
