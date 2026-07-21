// fleet federation routes:聚合 Mac fleet-agent(经隧道 127.0.0.1:58628)的五源会话
import http from 'node:http';

const FLEET_UP = process.env.FLEET_UPSTREAM || 'http://127.0.0.1:58628';

function forward(req, res, upstreamPath) {
  const base = new URL(FLEET_UP);
  const up = http.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path: upstreamPath,
      headers: {
        authorization: `Bearer ${process.env.FLEET_TOKEN}`,
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      },
      timeout: 250_000,
    },
    (ur) => {
      res.writeHead(ur.statusCode, { 'content-type': 'application/json; charset=utf-8' });
      ur.pipe(res);
      ur.on('error', () => res.destroy());
    }
  );
  up.on('timeout', () => { up.destroy(); });
  up.on('error', () => {
    if (!res.headersSent) {
      res.status(502).json({ code: 1, msg: 'fleet agent unreachable(联邦探针离线)', data: { items: [] } });
    } else res.destroy();
  });
  req.pipe(up);
}

export function fleetSessions(req, res) {
  const limit = new URL(req.url, 'http://localhost').searchParams.get('limit') || '50';
  forward(req, res, `/fleet/sessions?limit=${encodeURIComponent(limit)}`);
}

export function fleetMessages(req, res) {
  const q = new URL(req.url, 'http://localhost').search;
  forward(req, res, `/fleet/messages${q}`);
}

export function fleetTakeover(req, res) {
  forward(req, res, '/fleet/takeover');
}
