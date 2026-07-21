// Allowlist of upstream API paths the gateway will proxy. Everything else is
// rejected with 403. Path is normalized (query stripped, trailing slash
// stripped) before matching.

function normalize(path) {
  let p = path.split('?')[0];
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

const EXACT_GET = new Set([
  '/api/v1/meta',
  '/api/v1/healthz',
  '/api/v1/models',
  '/api/v1/tools',
  '/api/v1/fs:browse',
  '/api/v1/fs:home',
  '/api/v1/workspaces',
]);

// h-命名空间的 harness 能力表(2026-07-20,R1-A 能力位落地):
// kimi/claude 全双工;其余 harness 一律只读
const HARNESS_CAPS = {
  kimi: { write: true },
  claude: { write: true },
};

export function isAllowed(method, rawPath) {
  const m = method.toUpperCase();
  let path = normalize(rawPath);

  // harness 命名空间:/h/:harness/api/... → 按能力表过滤后按 /api/... 常规判定
  const hm = path.match(/^\/h\/([a-z0-9_-]+)\/api(\/.*)?$/i);
  if (hm) {
    const harness = hm[1].toLowerCase();
    const caps = HARNESS_CAPS[harness];
    if (!caps) return m === 'GET'; // 未登记 harness:只读
    if (!caps.write && m !== 'GET') return false;
    path = '/api' + (hm[2] || '');
  }

  // /api/v1/sessions and everything below it, any method — but any path
  // containing a "terminals" segment is refused (terminal access stays local).
  if (path === '/api/v1/sessions' || path.startsWith('/api/v1/sessions/')) {
    return !path.split('/').includes('terminals');
  }

  // GET /api/v1/models/<anything> (e.g. provider-prefixed model ids)
  if (m === 'GET' && path.startsWith('/api/v1/models/')) return true;

  // GET /api/v1/workspaces/{id} and /api/v1/workspaces/{id}/skills
  if (m === 'GET' && path.startsWith('/api/v1/workspaces/')) {
    const rest = path.slice('/api/v1/workspaces/'.length);
    const segs = rest.split('/');
    return segs.length === 1 || (segs.length === 2 && segs[1] === 'skills');
  }

  // POST /api/v1/files, GET/DELETE /api/v1/files/{id}
  if (path === '/api/v1/files') return m === 'POST';
  if (path.startsWith('/api/v1/files/')) {
    const rest = path.slice('/api/v1/files/'.length);
    return rest.split('/').length === 1 && (m === 'GET' || m === 'DELETE');
  }

  if (m === 'GET' && EXACT_GET.has(path)) return true;

  return false;
}

// Express middleware enforcing the allowlist.
// 命名空间路由时按 req.proxyPath(剥离 /m/:machine 前缀后的 /api/... 路径)判定;
// 否则用 req.originalUrl(兼容 /api 挂载点)。
export function allowlistMiddleware(req, res, next) {
  if (!isAllowed(req.method, req.proxyPath || req.originalUrl)) {
    return res.status(403).json({ code: 1, msg: 'forbidden by gateway allowlist' });
  }
  next();
}
