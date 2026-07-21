// fleet/accounts-probe.js — 账号全景探针(只读本机)
// 回答 owner 的全景问题:每个 harness 跑在什么通道、用哪个账号、还剩多少额度
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();

function decodeJwtPayload(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { return null; }
}

function mmxQuota() {
  const candidates = ['mmx', `${HOME}/.local/node/bin/mmx`, `${HOME}/.local/bin/mmx`];
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` };
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['quota'], { encoding: 'utf8', timeout: 15000, env });
      const j = JSON.parse(out);
      const items = (j.model_remains || []).map((m) => ({
        kind: m.model_name,
        weekly_percent: m.current_weekly_remaining_percent,
        interval_percent: m.current_interval_remaining_percent,
      }));
      const worst = items.reduce((a, b) => Math.min(a, b.weekly_percent ?? 100), 100);
      return { ok: true, percent: worst, detail: items };
    } catch { /* 下一个候选 */ }
  }
  return { ok: false, error: 'mmx 不可用' };
}

// 2026-07-21 实测打通:ChatGPT 后端 /backend-api/wham/usage(端点从 codex 二进制 strings 挖出)
// 返回 plan_type + rate_limit.primary_window(used_percent/reset_at/limit_reached),用 ~/.codex/auth.json 的 access_token
function codexQuota() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(HOME, '.codex/auth.json'), 'utf8'));
    const tok = a?.tokens?.access_token || '';
    const acct = a?.tokens?.account_id || '';
    if (!tok) return { ok: false, error: '无 access_token' };
    const out = execFileSync('curl', ['-s', '-m', '15',
      'https://chatgpt.com/backend-api/wham/usage',
      '-H', `Authorization: Bearer ${tok}`,
      '-H', `chatgpt-account-id: ${acct}`,
      '-H', 'User-Agent: codex-cli/0.28',
      '-H', 'originator: codex_cli_rs',
    ], { encoding: 'utf8', timeout: 20000 });
    const j = JSON.parse(out);
    const w = j?.rate_limit?.primary_window;
    if (!j || typeof j.plan_type !== 'string') return { ok: false, error: '响应异常' };
    if (!w) return { ok: true, plan: j.plan_type, used: null, note: '无限额窗口数据' };
    const used = typeof w.used_percent === 'number' ? w.used_percent : null;
    const reached = j.rate_limit.limit_reached === true || j.rate_limit.allowed === false;
    const resetAt = typeof w.reset_at === 'number' ? new Date(w.reset_at * 1000) : null;
    const mmdd = resetAt ? `${resetAt.getMonth() + 1}-${String(resetAt.getDate()).padStart(2, '0')}` : '?';
    return {
      ok: true, plan: j.plan_type, used, reached,
      remain: used == null ? null : Math.max(0, 100 - used),
      note: `Codex(${j.plan_type}) 周用量 ${used ?? '?'}%${reached ? '·已限' : ''}·重置 ${mmdd}`,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 60) };
  }
}

// 2026-07-21 实测打通:智谱 Coding Plan 额度端点 /api/monitor/usage/quota/limit
// 认证直接用 zcode 本地配置里的 apiKey(网传「只认浏览器 Cookie」已过时,实测 Bearer/X-Api-Key 均 200)
function zcodeQuota() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.zcode/v2/config.json'), 'utf8'));
    const key = cfg?.provider?.['builtin:bigmodel-coding-plan']?.options?.apiKey || '';
    if (!key) return { ok: false, error: 'zcode 配置无 apiKey' };
    const out = execFileSync('curl', ['-s', '-m', '15',
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      '-H', `Authorization: Bearer ${key}`, '-H', 'User-Agent: zcode/2.0',
    ], { encoding: 'utf8', timeout: 20000 });
    const j = JSON.parse(out);
    if (j?.code !== 200 || !Array.isArray(j?.data?.limits)) return { ok: false, error: (j && j.msg) || '响应异常' };
    const limits = j.data.limits;
    const worstUsed = limits.reduce((a, l) => Math.max(a, typeof l.percentage === 'number' ? l.percentage : 0), 0);
    const nextReset = limits.reduce((a, l) => (l.nextResetTime && (!a || l.nextResetTime < a) ? l.nextResetTime : a), null);
    const rd = nextReset ? new Date(nextReset) : null;
    const mmdd = rd ? `${rd.getMonth() + 1}-${String(rd.getDate()).padStart(2, '0')}` : '?';
    const kinds = limits.map((l) => `${l.type === 'TIME_LIMIT' ? '调用' : '额度'} ${l.percentage ?? '?'}%`).join(' · ');
    return { ok: true, remain: Math.max(0, 100 - worstUsed), note: `GLM 套餐 ${kinds}·重置 ${mmdd}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 60) };
  }
}

export function probeAccounts(env = process.env) {
  const accs = [];

  // 1) Kimi 编程会员(OAuth)
  accs.push({
    id: 'kimi', name: 'Kimi 编程会员', account: 'OAuth 登录态(本机)',
    channel: 'api.kimi.com/coding', harness: ['kimi'],
    quota: null, quota_note: '无公开额度接口(2026-07-21 探明截止)',
  });

  // 2) Codex(ChatGPT 订阅)
  const cq = codexQuota();
  let codex = {
    id: 'codex', name: 'ChatGPT 订阅(Codex)', account: '未知', channel: 'chatgpt.com/codex',
    harness: ['codex'],
    quota: cq.ok && cq.remain != null ? { percent: cq.remain } : null,
    quota_note: cq.ok ? cq.note : `额度读取失败:${cq.error}`,
  };
  try {
    const a = JSON.parse(fs.readFileSync(path.join(HOME, '.codex/auth.json'), 'utf8'));
    const claims = decodeJwtPayload(a?.tokens?.id_token || '');
    codex.account = claims?.email || (a?.tokens?.account_id ? `acct:${String(a.tokens.account_id).slice(0, 8)}…` : '未知');
    codex.auth_mode = a?.auth_mode || null;
    codex.plan = claims?.['https://api.openai.com/auth']?.plan_type || claims?.plan_type || cq.plan || null;
  } catch { /* 未登录 */ }
  accs.push(codex);

  // 3) MiniMax Token Plan(蜂群主力 worker 通道:kimi harness 直驱 m3;2026-07-21 claude 壳下线后正名)
  const q = mmxQuota();
  accs.push({
    id: 'minimax', name: 'MiniMax Token Plan', account: '顶配订阅',
    channel: 'api.minimaxi.com/anthropic',
    harness: ['kimi'],
    quota: q.ok ? { percent: q.percent } : null,
    quota_note: q.ok ? `MiniMax 周剩余 ${q.percent}%` : `额度读取失败:${q.error}`,
  });

  // 4) Z.AI Coding Plan(zcode)
  const zq = zcodeQuota();
  accs.push({
    id: 'zcode', name: 'Z.AI Coding Plan', account: 'OAuth(加密存储)', channel: 'bigmodel.cn',
    harness: ['zcode'],
    quota: zq.ok ? { percent: zq.remain } : null,
    quota_note: zq.ok ? zq.note : `额度读取失败:${zq.error}`,
  });

  // 5) WorkBuddy(腾讯):未见公开额度接口(2026-07-21 探明截止,留待后续)
  accs.push({
    id: 'workbuddy', name: 'WorkBuddy(腾讯)', account: 'App 登录态', channel: 'codebuddy 内置',
    harness: ['workbuddy'], quota: null, quota_note: '无公开额度接口(未探明)',
  });

  return accs;
}

// CLI 自测
if (import.meta.url === 'file://' + process.argv[1]) {
  console.log(JSON.stringify(probeAccounts(), null, 2));
}
