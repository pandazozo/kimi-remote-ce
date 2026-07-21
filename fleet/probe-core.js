#!/usr/bin/env node
// harness-sessions.js — 跨 harness 会话只读探针(联邦输入,五源)
// 输出统一 JSON:[{harness,id,title,cwd,updated_at,message_count,file}]
// 用法: node harness-sessions.js [--harness codex|claude|zcode|workbuddy] [--limit 20]
// 只读,不写任何文件。存储实证见 docs/HARNESS-FLEET.md §7。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
const args = process.argv.slice(2);
const opt = { harness: 'all', limit: 20 };
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, '')] = args[i + 1];
opt.limit = Number(opt.limit) || 20;

function* walk(dir, depth = 4) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* walk(p, depth - 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function readLines(file, max = 40) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(fs.statSync(file).size, 256 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(0, max);
  } catch { return []; }
}

function parseJsonLines(lines) {
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

function probeCodex() {
  const roots = [path.join(HOME, '.codex/sessions'), path.join(HOME, '.codex/archived_sessions')];
  const sessions = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const recs = parseJsonLines(readLines(file, 12));
      if (!recs.length) continue;
      const meta = recs.find((r) => r.type === 'session_meta')?.payload;
      if (!meta?.id) continue;
      // title:首个「真人」用户消息文本(跳过 <recommended_plugins> 等系统注入)
      let title = '';
      for (const r of recs) {
        const p = r.payload || {};
        const role = p.role || (p.type === 'user_message' ? 'user' : null);
        if (role === 'user') {
          const c = p.content || p.message || p.text;
          const t = (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : '')).trim();
          if (t) {
            const isInject = t.startsWith('<') || t.startsWith('# AGENTS.md') || t.slice(0, 300).includes('<INSTRUCTIONS>');
            if (!isInject) { title = t; break; }
          }
        }
      }
      // 真实驱动模型
      let model = '';
      for (const l of readLines(file, 400)) {
        const m = l.match(/"model":"([^"<]+)"/);
        if (m) { model = m[1]; break; }
      }
      const st = fs.statSync(file);
      let displayTitle = title;
      if (!displayTitle && meta.cwd) {
        const cwdBase = path.basename(meta.cwd);
        const m = st.mtime;
        const mm = String(m.getMonth() + 1).padStart(2, '0');
        const dd = String(m.getDate()).padStart(2, '0');
        displayTitle = `${cwdBase} · ${mm}-${dd}`;
      }
      sessions.push({
        harness: 'codex', id: meta.id,
        title: (displayTitle || '(无标题)').slice(0, 80),
        model: model || null,
        cwd: meta.cwd || null,
        updated_at: (meta.timestamp && !isNaN(Date.parse(meta.timestamp))) ? meta.timestamp : st.mtime.toISOString(),
        archived: root.includes('archived'),
        file: path.relative(HOME, file),
      });
    }
  }
  return sessions;
}

function probeClaude() {
  const root = path.join(HOME, '.claude/projects');
  const sessions = [];
  for (const file of walk(root, 3)) {
    const recs = parseJsonLines(readLines(file, 15));
    if (!recs.length) continue;
    const sum = recs.find((r) => r.type === 'summary')?.summary;
    const withCwd = recs.find((r) => r.cwd);
    const sid = recs.find((r) => r.sessionId)?.sessionId || path.basename(file, '.jsonl');
    // 真实驱动模型(claude 壳 + 国产模型是常态,owner 要求显示真实模型)
    let model = '';
    const full = readLines(file, 400);
    for (const l of full) {
      const m = l.match(/"model":"([^"<]+)"/);
      if (m && m[1] !== '<synthetic>') { model = m[1]; break; }
    }
    let title = sum || '';
    if (!title) {
      for (const r of recs) {
        if (r.type === 'user' && r.message) {
          const c = r.message.content;
          title = (typeof c === 'string' ? c : (Array.isArray(c) ? c.map((b) => b?.text || '').join(' ') : '')).trim();
          if (title && !title.startsWith('<')) break;
          title = '';
        }
      }
    }
    const st = fs.statSync(file);
    sessions.push({
      harness: 'claude', id: sid,
      title: (title || '(无标题)').slice(0, 80),
      model: model || null,
      cwd: withCwd?.cwd || null,
      updated_at: st.mtime.toISOString(),
      archived: false,
      file: path.relative(HOME, file),
    });
  }
  return sessions;
}

function sqliteRo(dbPath, sql) {
  // 只读 URI + busy_timeout,与应用写并发安全;sqlite3 -json 直接出 JSON
  try {
    const out = execFileSync('/usr/bin/sqlite3', [
      '-json', `file:${dbPath}?mode=ro&busy_timeout=3000`, sql,
    ], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out || '[]');
  } catch { return []; }
}

function probeZcode() {
  const db = path.join(HOME, '.zcode/v2/tasks-index.sqlite');
  const db2 = path.join(HOME, '.zcode/cli/db/db.sqlite');
  return sqliteRo(db,
    `SELECT task_id, title, created_at, updated_at, workspace_path, task_status
     FROM tasks WHERE deleted=0 ORDER BY updated_at DESC LIMIT ${opt.limit * 2}`)
    .map((r) => {
      const mr = sqliteRo(db2,
        `SELECT json_extract(data,'$.model.modelID') AS m FROM message
          WHERE session_id='${String(r.task_id).replace(/'/g, "''")}'
            AND json_extract(data,'$.model.modelID') IS NOT NULL LIMIT 1`);
      return {
      harness: 'zcode', id: r.task_id,
      title: (r.title || '(无标题)').slice(0, 80),
      model: (mr[0] && mr[0].m) || null,
      cwd: r.workspace_path || null,
        updated_at: new Date(Number(r.updated_at)).toISOString(),
        archived: false,
        file: '.zcode/v2/tasks-index.sqlite',
      };
    });
}

function probeWorkbuddy() {
  const db = path.join(HOME, '.workbuddy/workbuddy.db');
  return sqliteRo(db,
    `SELECT id, COALESCE(custom_title,title) AS t, created_at, updated_at, cwd, status
     FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${opt.limit * 2}`)
    .map((r) => {
      let model = '';
      for (const l of readLines(path.join(HOME, '.workbuddy/projects', r.id + '.jsonl'), 200)) {
        const m = l.match(/"model":"([^"<]+)"/);
        if (m && m[1] !== 'auto') { model = m[1]; break; }
      }
      return {
      harness: 'workbuddy', id: r.id,
      title: (r.t || '(无标题)').slice(0, 80),
      model: model || null,
      cwd: (r.cwd && r.cwd !== '/' ? r.cwd : null),
        updated_at: new Date(Number(r.updated_at)).toISOString(),
        archived: false,
        file: '.workbuddy/workbuddy.db',
      };
    });
}

export function probeAll(o = {}) {
  const oo = { harness: o.harness || 'all', limit: Number(o.limit) || 50 };
  const per = Math.max(5, Math.ceil(oo.limit / 4)); // 每源保底配额,防单源挤爆
  let out = [];
  if (oo.harness === 'codex' || oo.harness === 'all') out = out.concat(probeCodex().slice(0, per));
  if (oo.harness === 'claude' || oo.harness === 'all') out = out.concat(probeClaude().slice(0, per));
  if (oo.harness === 'zcode' || oo.harness === 'all') out = out.concat(probeZcode().slice(0, per));
  if (oo.harness === 'workbuddy' || oo.harness === 'all') out = out.concat(probeWorkbuddy().slice(0, per));
  out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return out.slice(0, oo.limit);
}

// CLI 直跑时才输出(import 时不执行)
if (import.meta.url === 'file://' + process.argv[1]) {
  process.stdout.write(JSON.stringify(probeAll(opt), null, 2) + '\n');
}

// ---------- 会话正文(详情只读)----------
function textOfBlocks(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => b?.text || '').join('\n');
  return '';
}

export function getMessages(harness, id, file, limit = 120) {
  const msgs = [];
  if (harness === 'codex' || harness === 'claude') {
    const abs = path.join(HOME, file);
    for (const r of parseJsonLines(readLines(abs, 200000))) {
      if (harness === 'codex') {
        const p = r.payload || {};
        const role = p.role || (p.type === 'agent_message' ? 'assistant' : p.type === 'user_message' ? 'user' : null);
        if ((p.type === 'message' || p.type === 'agent_message' || p.type === 'user_message') && (role === 'user' || role === 'assistant')) {
          const t = textOfBlocks(p.content || p.message).trim();
          if (t && !t.startsWith('<')) msgs.push({ role, text: t.slice(0, 4000) });
        }
      } else {
        if ((r.type === 'user' || r.type === 'assistant') && r.message) {
          const t = textOfBlocks(r.message.content).trim();
          if (t && !t.startsWith('<')) msgs.push({ role: r.type, text: t.slice(0, 4000) });
        }
      }
    }
  } else if (harness === 'zcode') {
    const db = path.join(HOME, '.zcode/cli/db/db.sqlite');
    const rows = sqliteRo(db,
      `SELECT json_extract(m.data,'$.role') AS role,
              (SELECT group_concat(json_extract(p.data,'$.text'), char(10))
                 FROM part p WHERE p.message_id = m.id
                   AND json_extract(p.data,'$.type')='text') AS txt
         FROM message m WHERE m.session_id = '${String(id).replace(/'/g, "''")}'
         ORDER BY json_extract(m.data,'$.time.created') LIMIT ${limit * 2}`);
    for (const r of rows) {
      const t = (r.txt || '').trim();
      if (t && (r.role === 'user' || r.role === 'assistant')) msgs.push({ role: r.role, text: t.slice(0, 4000) });
    }
  } else if (harness === 'workbuddy') {
    const abs = path.join(HOME, '.workbuddy/projects', `${id}.jsonl`);
    for (const r of parseJsonLines(readLines(abs, 200000))) {
      if (r.type === 'message' && (r.role === 'user' || r.role === 'assistant')) {
        const t = textOfBlocks(r.content).trim();
        if (t && !t.startsWith('<')) msgs.push({ role: r.role, text: t.slice(0, 4000) });
      }
    }
  }
  return msgs.slice(-limit);
}
