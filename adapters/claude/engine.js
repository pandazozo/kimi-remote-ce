// claude 引擎:每活跃会话一个 Agent SDK streaming-input query() 常驻热进程
// SSE 多客户端扇出 + seq 事件积压重放(断线续传)+ canUseTool 权限中继 + 空闲/僵尸回收
// 移植自 cc-remote-h5/src/chats.ts(逻辑保真,去 TS 类型;感谢原作者线)
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

const BACKLOG_LIMIT = 3000;
const IDLE_CLOSE_MS = 30 * 60 * 1000;
const HARD_STALE_MS = 2 * 60 * 60 * 1000;
const STREAM_EVENT_TYPES = new Set(['delta', 'thinking_delta', 'tool_input_delta', 'block_start', 'block_stop', 'msg_stop']);

class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  get isClosed() { return this.#closed; }

  push(item) {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }

  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => this.#waiters.push(res));
      },
    };
  }
}

export class ActiveChat {
  constructor(opts) {
    this.key = opts.key;
    this.cwd = opts.cwd;
    this.sessionId = opts.resume;
    this.mode = opts.mode ?? 'default';
    this.onSessionId = opts.onSessionId;
    this.onClosed = opts.onClosed;
    this.state = 'idle';
    this.closed = false;
    this.lastActivity = Date.now();
    this.pendingTitle = undefined;
    this.pendingPermissions = new Map();

    this.q = undefined;
    this.input = new AsyncQueue();
    this.clients = new Set();
    this.backlog = [];
    this.seq = 0;
  }

  get started() { return this.q !== undefined; }

  send(text, attachments = []) {
    if (this.closed || this.input.isClosed) throw new Error('chat closed, retry to open a fresh one');
    this.lastActivity = Date.now();
    if (!this.q) this.start();
    let full = text;
    if (attachments.length > 0) {
      const lines = attachments.map((a) => `- ${a.path} (${a.name}, ${a.size} bytes)`);
      full += `\n\n[用户通过遥控台上传了 ${attachments.length} 个附件,已保存到本机磁盘,请用工具按需读取:\n` + lines.join('\n') + '\n]';
    }
    this.state = 'running';
    this.emit({ t: 'user', text, attachments, uuid: randomUUID() });
    this.emit({ t: 'state', state: 'running' });
    this.input.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: full }] },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
    });
  }

  start() {
    const options = {
      cwd: this.cwd,
      resume: this.sessionId,
      includePartialMessages: true,
      permissionMode: this.mode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: (toolName, input, meta) => this.requestPermission(toolName, input, meta),
      stderr: (data) => {
        if (data.trim()) this.emit({ t: 'stderr', text: data.slice(0, 4000) });
      },
    };
    this.state = 'starting';
    this.q = query({ prompt: this.input, options });
    void this.readLoop(this.q);
  }

  async readLoop(q) {
    try {
      for await (const msg of q) this.handleMessage(msg);
      this.emit({ t: 'closed' });
    } catch (err) {
      this.emit({ t: 'error', message: String(err instanceof Error ? err.message : err) });
    } finally {
      this.state = 'idle';
      this.q = undefined;
      this.onClosed(this);
    }
  }

  handleMessage(msg) {
    this.lastActivity = Date.now();
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          this.state = 'running';
          this.emit({ t: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd });
          this.onSessionId(this, msg.session_id);
        } else if (msg.subtype === 'session_state_changed') {
          const st = msg.state === 'running' ? 'running' : 'idle';
          this.state = st;
          this.emit({ t: 'state', state: st });
        } else if (msg.subtype === 'permission_denied') {
          this.emit({ t: 'permission_denied', toolName: msg.tool_name, reason: msg.decision_reason_type });
        }
        break;
      }
      case 'auth_status': {
        this.emit({
          t: 'auth_status',
          isAuthenticating: msg.isAuthenticating ?? false,
          output: (msg.output ?? []).join('\n').slice(0, 2000),
          error: msg.error,
        });
        break;
      }
      case 'stream_event': {
        if (msg.parent_tool_use_id) break;
        this.handleStreamEvent(msg.event);
        break;
      }
      case 'assistant': {
        if (msg.parent_tool_use_id) break;
        const content = msg.message?.content ?? [];
        this.backlog = this.backlog.filter((e) => !STREAM_EVENT_TYPES.has(e.ev.t));
        this.emit({ t: 'assistant', content, uuid: msg.uuid, error: msg.error });
        break;
      }
      case 'user': {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'tool_result') {
              this.emit({
                t: 'tool_result',
                tool_use_id: block.tool_use_id,
                is_error: block.is_error ?? false,
                content: previewToolResult(block.content),
              });
            }
          }
        }
        break;
      }
      case 'result': {
        this.state = 'idle';
        this.emit({
          t: 'result',
          subtype: msg.subtype,
          duration_ms: msg.duration_ms,
          total_cost_usd: msg.total_cost_usd,
          num_turns: msg.num_turns,
          errors: (msg.errors ?? []).map((e) => e.slice(0, 1000)),
        });
        this.emit({ t: 'state', state: 'idle' });
        break;
      }
      default:
        break;
    }
  }

  handleStreamEvent(ev) {
    switch (ev.type) {
      case 'content_block_start': {
        const block = ev.content_block || {};
        this.emit({ t: 'block_start', index: ev.index, blockType: block.type, name: block.name, id: block.id });
        break;
      }
      case 'content_block_delta': {
        const delta = ev.delta || {};
        if (delta.type === 'text_delta') this.emit({ t: 'delta', index: ev.index, text: delta.text });
        else if (delta.type === 'thinking_delta') this.emit({ t: 'thinking_delta', index: ev.index, text: delta.thinking });
        else if (delta.type === 'input_json_delta') this.emit({ t: 'tool_input_delta', index: ev.index, json: delta.partial_json });
        break;
      }
      case 'content_block_stop':
        this.emit({ t: 'block_stop', index: ev.index });
        break;
      case 'message_stop':
        this.emit({ t: 'msg_stop' });
        break;
      default:
        break;
    }
  }

  requestPermission(toolName, input, meta) {
    return new Promise((resolve) => {
      const id = randomUUID();
      const pending = {
        id, toolName, input,
        title: meta.title,
        description: meta.description,
        displayName: meta.displayName,
        suggestions: meta.suggestions,
        resolve: (r) => {
          if (!this.pendingPermissions.delete(id)) return;
          this.emit({ t: 'permission_resolved', id });
          resolve(r);
        },
      };
      this.pendingPermissions.set(id, pending);
      this.emit({
        t: 'permission', id, toolName, input,
        title: meta.title,
        displayName: meta.displayName,
        description: meta.description,
        hasAlwaysAllow: (meta.suggestions?.length ?? 0) > 0,
      });
      meta.signal.addEventListener('abort', () => {
        pending.resolve({ behavior: 'deny', message: 'aborted' });
      });
    });
  }

  resolvePermission(id, allow, always) {
    const p = this.pendingPermissions.get(id);
    if (!p) return false;
    if (allow) {
      p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: always ? p.suggestions : undefined });
    } else {
      p.resolve({ behavior: 'deny', message: '用户在遥控台拒绝了此操作' });
    }
    return true;
  }

  async interrupt() { await this.q?.interrupt(); }

  async setMode(mode) {
    this.mode = mode;
    await this.q?.setPermissionMode(mode);
    this.emit({ t: 'mode', mode });
  }

  addClient(res, lastSeq) {
    this.clients.add(res);
    for (const { seq, ev } of this.backlog) {
      if (seq > lastSeq) res.write(`id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.write(`id: ${this.seq}\ndata: ${JSON.stringify({ t: 'hello', key: this.key, sessionId: this.sessionId, state: this.state, mode: this.mode })}\n\n`);
    res.on('close', () => this.clients.delete(res));
  }

  emit(ev) {
    this.seq += 1;
    this.backlog.push({ seq: this.seq, ev });
    if (this.backlog.length > BACKLOG_LIMIT) this.backlog.splice(0, this.backlog.length - BACKLOG_LIMIT);
    const frame = `id: ${this.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  close() {
    this.closed = true;
    this.input.close();
    this.q?.close();
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  isReapable() {
    if (this.pendingPermissions.size > 0) return false;
    const silentFor = Date.now() - this.lastActivity;
    if (this.state === 'idle') return silentFor > IDLE_CLOSE_MS;
    return silentFor > HARD_STALE_MS;
  }
}

function previewToolResult(content) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : `[${b?.type ?? 'block'}]`))
      .join('\n');
  } else if (content != null) text = JSON.stringify(content);
  return text.length > 3000 ? text.slice(0, 3000) + `\n… (${text.length} chars total)` : text;
}

export class ChatManager {
  constructor(hooks = {}) {
    this.chats = new Map();
    this.hooks = hooks;
    setInterval(() => {
      for (const chat of new Set(this.chats.values())) {
        if (chat.isReapable()) {
          chat.close();
          this.remove(chat);
        }
      }
    }, 60_000).unref();
  }

  get(key) { return this.chats.get(key); }

  ensure(opts) {
    const key = opts.key ?? opts.sessionId ?? `draft-${randomUUID()}`;
    const existing = this.chats.get(key);
    if (existing && !existing.closed) return existing;
    if (existing) this.remove(existing);
    const chat = new ActiveChat({
      key,
      cwd: opts.cwd,
      resume: opts.sessionId,
      mode: opts.mode,
      onSessionId: (c, sid) => {
        this.chats.set(sid, c);
        this.hooks.onSessionId?.(c);
      },
      onClosed: (c) => this.remove(c),
    });
    this.chats.set(key, chat);
    if (opts.sessionId) this.chats.set(opts.sessionId, chat);
    return chat;
  }

  remove(chat) {
    for (const [k, v] of this.chats) if (v === chat) this.chats.delete(k);
  }

  activeSessionIds() {
    const ids = new Set();
    for (const chat of this.chats.values()) if (chat.sessionId) ids.add(chat.sessionId);
    return ids;
  }

  runningSessionIds() {
    const ids = new Set();
    for (const chat of this.chats.values()) {
      if (chat.sessionId && chat.state !== 'idle') ids.add(chat.sessionId);
    }
    return ids;
  }
}
