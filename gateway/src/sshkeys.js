// sshkeys:成员隧道公钥登记(v0.4c2)— 追加受限条目到服务器 tunnel 账号 authorized_keys
// AUTHORIZED_KEYS_FILE(env):容器内挂载的宿主机 authorized_keys 路径
// 条目格式(强制仅限指定端口转发,禁 shell/禁其他转发):
//   restrict,permitopen="127.0.0.1:<port>" <type> <key> <comment>
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.AUTHORIZED_KEYS_FILE || path.join(process.cwd(), 'authorized_keys');

export function keyFilePath() { return FILE; }

function readLines() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

function writeLines(lines) {
  // 注意:authorized_keys 是 docker 单文件 bind mount,不能 tmp+rename(EBUSY),
  // 只能就地写(单写者场景可接受)
  fs.writeFileSync(FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

// 登记/更新某机器的公钥;同一 comment(机器)旧条目先移除
export function authorizeMachineKey(machineId, port, pubkey) {
  const parts = String(pubkey || '').trim().split(/\s+/);
  if (parts.length < 2 || !/^ssh-(ed25519|rsa)/.test(parts[0])) {
    return { error: 'pubkey 格式不正确' };
  }
  const comment = `kimi-remote-tunnel-${machineId}`;
  // OpenSSH 8.9 实测:restrict 会无条件禁掉 -R(permitlisten 也救不回),故改为
  // 显式 permit 到指定端口 + 逐项禁用危险特性;shell 由 nologin 兜底
  const line = `permitlisten="127.0.0.1:${port}",permitopen="127.0.0.1:${port}",no-pty,no-agent-forwarding,no-X11-forwarding ${parts[0]} ${parts[1]} ${comment}`;
  const lines = readLines().filter((l) => !l.includes(comment));
  lines.push(line);
  writeLines(lines);
  return { ok: true, line };
}
