// audit:审计日志(v0.4)— JSONL 追加,按天轮转,只记元数据不记正文
// AUDIT_FILE 默认 ./audit.jsonl(容器 /data/audit.jsonl,与 overlay 同 volume)
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.AUDIT_FILE || path.join(process.cwd(), 'audit.jsonl');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB 触发轮转

function line(action, req, detail) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    ip: req.socket?.remoteAddress,
    user: req.user?.sub || null,
    action,
    detail: detail || {},
  });
}

export function audit(action, req, detail) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) {
        fs.renameSync(FILE, FILE + '.' + new Date().toISOString().slice(0, 10));
      }
    } catch {}
    fs.appendFileSync(FILE, line(action, req, detail) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('[audit] 写失败:', e.message);
  }
}
