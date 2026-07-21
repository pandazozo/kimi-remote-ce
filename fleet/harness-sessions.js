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
          if (t && !t.startsWith('<')) { title = t; break; }
        }
      }
      const st = fs.statSync(file);
      sessions.push({
        harness: 'codex', id: meta.id,
        title: (title || '(无标题)').slice(0, 80),
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
  return sqliteRo(db,
    `SELECT task_id, title, created_at, updated_at, workspace_path, task_status
     FROM tasks WHERE deleted=0 ORDER BY updated_at DESC LIMIT ${opt.limit * 2}`)
    .map((r) => ({
      harness: 'zcode', id: r.task_id,
      title: (r.title || '(无标题)').slice(0, 80),
      cwd: r.workspace_path || null,
      updated_at: new Date(Number(r.updated_at)).toISOString(),
      archived: false,
      file: '.zcode/v2/tasks-index.sqlite',
    }));
}

function probeWorkbuddy() {
  const db = path.join(HOME, '.workbuddy/workbuddy.db');
  return sqliteRo(db,
    `SELECT id, COALESCE(custom_title,title) AS t, created_at, updated_at, cwd, status
     FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ${opt.limit * 2}`)
    .map((r) => ({
      harness: 'workbuddy', id: r.id,
      title: (r.t || '(无标题)').slice(0, 80),
      cwd: (r.cwd && r.cwd !== '/' ? r.cwd : null),
      updated_at: new Date(Number(r.updated_at)).toISOString(),
      archived: false,
      file: '.workbuddy/workbuddy.db',
    }));
}

let out = [];
if (opt.harness === 'codex' || opt.harness === 'all') out = out.concat(probeCodex());
if (opt.harness === 'claude' || opt.harness === 'all') out = out.concat(probeClaude());
if (opt.harness === 'zcode' || opt.harness === 'all') out = out.concat(probeZcode());
if (opt.harness === 'workbuddy' || opt.harness === 'all') out = out.concat(probeWorkbuddy());
out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
process.stdout.write(JSON.stringify(out.slice(0, opt.limit), null, 2) + '\n');
