// WS subscribe materialization probe for kimi web v2 backend
// usage: node ws-probe.js <session_id> [prompt]
// Verifies whether a WS client_hello+subscription causes the server to
// materialize a REST-created session so its prompt actually executes.
const fs = require('fs');
const TOKEN = fs.readFileSync(process.env.HOME + '/.kimi-code/server.token', 'utf8').trim();
const SID = process.argv[2];
const PROMPT = process.argv[3] || '只回复:活';
if (!SID) { console.error('usage: node ws-probe.js <session_id> [prompt]'); process.exit(1); }

const B = 'http://127.0.0.1:58627';
const WS = `ws://127.0.0.1:58627/api/v1/ws?client_id=ws-probe`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ws = new WebSocket(WS, [`kimi-code.bearer.${TOKEN}`]);
let promptSent = false;

ws.onopen = () => {
  log('WS open');
  ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'ws-probe', subscriptions: [SID] } }));
};
ws.onmessage = async (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return log('raw:', String(ev.data).slice(0, 200)); }
  const t = m.type;
  if (t === 'client_hello_ack' || t === 'server_hello') {
    log(t, JSON.stringify(m.payload || {}).slice(0, 300));
    if (!promptSent) {
      promptSent = true;
      const r = await fetch(`${B}/api/v1/sessions/${SID}/prompts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'text', text: PROMPT }] }),
      });
      const j = await r.json();
      log('prompt posted:', JSON.stringify(j.data || j).slice(0, 200));
    }
    return;
  }
  if (t === 'session_event') {
    const p = m.payload || {};
    const et = p.event_type || p.kind || (p.event && p.event.type) || m.type || '?';
    const isErr = JSON.stringify(m).includes('error');
    log('event:', et, JSON.stringify(p).slice(0, isErr ? 2000 : 800));
    return;
  }
  log('msg:', t, JSON.stringify(m).slice(0, 2000));
};
ws.onerror = (e) => log('WS error', e.message || e.type || '');
ws.onclose = (e) => { log('WS closed', e.code, e.reason || ''); process.exit(2); };
setTimeout(() => { log('timeout, exit'); process.exit(0); }, 90000);
