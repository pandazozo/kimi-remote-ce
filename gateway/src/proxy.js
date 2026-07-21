// Streaming reverse proxy to the upstream kimi server.
// The request body is piped straight through (no body-parser anywhere on this
// path), so multi-GB multipart uploads pass with zero buffering.
// v0.4b:支持按 req.machine 选机器(机器命名空间);缺省回退单机 env 配置。
import http from 'node:http';

const UPSTREAM_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

function upstreamFor(req) {
  if (req.harnessUpstream) {
    return { base: new URL(req.harnessUpstream.upstream), token: req.harnessUpstream.token };
  }
  if (req.machine) {
    return { base: new URL(req.machine.upstream), token: req.machine.token };
  }
  // 默认(单机)REST 一律走前门 adapter(58629):v2 引擎修复(model 注入/force 订阅)都在 adapter 上;
  // 直连 58627 会绕开修复层,导致静默吞 prompt(2026-07-21「诊断」事故)。WS 桥(ws.js)仍走 KIMI_UPSTREAM。
  return {
    base: new URL(process.env.ADAPTER_UPSTREAM || process.env.KIMI_UPSTREAM || 'http://127.0.0.1:58627'),
    token: process.env.KIMI_TOKEN,
  };
}

export function proxyRequest(req, res) {
  const { base, token } = upstreamFor(req);

  const headers = { ...req.headers };
  headers.host = base.host;
  headers.authorization = `Bearer ${token}`;
  // 逐跳连接头必须剥掉(2026-07-21 间歇 400 根因):客户端的 Connection: close 若原样转发,
  // 上游响应后关 socket,而本网关 agent 连接池会把将死 socket 复用于下一请求 →
  // 上游 HPE_CLOSED_CONNECTION → 空 body 400(约半数请求中招)。
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  // content-length / transfer-encoding 保持原样透传。

  // 命名空间挂载时转发剥离后的路径(/m/:machine/api/v1/... → /api/v1/...)
  const path = req.proxyPath || req.originalUrl;

  const upstreamReq = http.request(
    {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port,
      method: req.method,
      path,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    }
  );

  upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error('upstream timeout'));
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ code: 1, msg: 'upstream unreachable' });
    } else {
      res.destroy(err);
    }
  });

  req.on('error', () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}
