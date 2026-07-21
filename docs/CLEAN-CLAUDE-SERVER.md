# 干净服务器部署真 Claude Code 并接入 kimi-remote 机群

> 目标读者:把「真 Anthropic Claude Code」以一台独立、专用、干净的服务器形态接入 kimi-remote H5 机队页的 owner / 运维。
> 写于 2026-07-21,对应 `fleet/harness-upgrade.sh` 决策:claude-code 全线下线(封号风控)。

## 1. 适用场景与目标

把这台服务器当 kimi-remote 机队里**唯一**一台跑真 Claude Code 的机器:手机 H5 机群页可见、会话可读、新建会话可选 Claude Code。与现有 Mac 完全隔离——账号、IP、网络栈、隧道账号、凭据全独立。**禁止把现有任一台机的 kimi/codex/zcode harness 装上来,也不装任何把 claude CLI 指向非 Anthropic 端点的 wrapper**(见 §2)。链路:手机 → 网关域名 → 网关容器 → 服务器 `tunnel` 账号 SSH 反向隧道(`127.0.0.1:587xx` ← 新机 `127.0.0.1:58629` adapter)。机器名约定:`claude-us-01`(美国首台)。

## 2. 风控教训与「干净」定义

2026-07-21 全线下线本机 claude 的根因:`claude CLI 壳 + 国产 litellm 网关跑非 Anthropic 模型` 命中 Anthropic 风控典型打击面,直接封号。新机器必须做到:不装国产网关/litellm/任何把 claude 指向非 Anthropic 端点的 wrapper(`ANTHROPIC_BASE_URL`/`CLAUDE_BASE_URL` 不得指向月之暗面/智谱/DeepSeek/MiniMax/自建代理),claude CLI 出口必须直达 `api.anthropic.com`;不做账号共享(账号池分开,`claude` 二进制不能跨机 `scp` 复制登录态);固定出口 IP(独立固定公网 IP——DO Reserved IP / Vultr 主 IPv4,出口 IP 与注册时同区);注册与使用同区域(账号注册时浏览器出口 IP 与日常服务器出口 IP 同区,跨区跳板触发风控);不混装(`pip list` / `npm ls -g` 不出现国产 SDK)。

## 3. 服务器选购规格单(2026-07-21 定案:美国方案;调研全文见 `~/Work/server-migration/RESEARCH-US-MASTER-SERVER.md`)

> 选型变更:2026-07-21 王佐拍板方向——不再买新加坡/阿里云,改用美国服务商美国机房。推荐 **DigitalOcean Memory-Optimized 32 GiB(SFO)**,备选 **Vultr Optimized Cloud·Memory 32 GB(LAX)**;两者对中国电信均为普通 163 骨干直连(成都→美西 ~190-220ms),买前须在成都晚高峰对两家官方测速点实测后二选一(方法见调研报告 §3.4)。

| 项 | 推荐 | 备注 |
|---|---|---|
| 服务商/区域 | **DigitalOcean 旧金山(SFO)**;备选 Vultr 洛杉矶(LAX) | Anthropic 可用区;美国一线厂商;**不要香港**(HK 风控历史偏高) |
| 实例 | 4 vCPU(独享)/ 32 GiB | DO Memory-Optimized $168/月;Vultr voc-m-4c-32gb $160/月;可原地升 64 GiB |
| 系统盘 | 100 GiB NVMe(随套餐) | `~/.claude/projects/` JSONL + npm 缓存 + git 托管 |
| 镜像 | Ubuntu 24.04 LTS(最小化) | 与 你的现有服务器 同款,排障工具链一致 |
| 公网 | **DO Reserved IP(绑定免费)**;Vultr 主 IPv4 随实例固定 | **必须固定出口 IP**(防封纪律 §2/§8) |
| 防火墙 | Cloud Firewall/ufw 仅放行 22/TCP(来源限办公 IP/跳板) | 80/443 不开;HTTP 入口走网关域名 |
| 主机名 | `claude-us-01` | 队列延续:`claude-us-02` 等 |

## 4. 系统初始化与加固

`root` 首次 SSH 后跑:

```bash
adduser claude && usermod -aG sudo claude
mkdir -p /home/claude/.ssh && cp ~/.ssh/authorized_keys /home/claude/.ssh/ && chown -R claude:claude /home/claude/.ssh
sudo sed -i 's/^#\?\(PasswordAuthentication\|PermitRootLogin\).*/\1 no/' /etc/ssh/sshd_config && sudo systemctl restart sshd
sudo hostnamectl set-hostname claude-us-01 && sudo timedatectl set-timezone America/Los_Angeles
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y ufw fail2ban unattended-upgrades unzip jq \
  && sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow 22/tcp && sudo ufw --force enable \
  && sudo systemctl enable --now fail2ban unattended-upgrades
```

验证:`sudo -u claude ssh claude@127.0.0.1 true && echo OK` · `curl -fsSL https://api.anthropic.com -o /dev/null -w "%{http_code}\n"` 期望 200/301/302。

## 5. Claude Code 官方安装(未实测,按官方文档)

```bash
# 未实测,按官方文档:Claude Code 原生安装,见 https://docs.claude.com/en/docs/claude-code
curl -fsSL https://claude.ai/install.sh | bash && claude --version && which claude
```

## 6. 登录新账号(无人值守/自动化 → B)

### 6.1 路径 A:服务器交互登录 + 本机 SSH 端口转发

```bash
claude login                                            # 服务器提示 "open http://localhost:3xxx ..."
ssh -L 3xxx:127.0.0.1:3xxx claude@<服务器IP>            # 笔记本另起终端
# 本机浏览器打开 http://localhost:3xxx(全新、未与被封账号关联的浏览器 profile)
claude -p "ping"
```

### 6.2 路径 B:`claude setup-token`(推荐无人值守)

```bash
# 未实测,按官方文档:在任一已登录设备(干净 Mac 或 sandbox)跑
claude setup-token                                      # 输出 sk-ant-oat01-XXXXXXXX
sudo -u claude bash -c 'umask 077; mkdir -p /home/claude/.claude && echo "sk-ant-oat01-XXXX" > /home/claude/.claude/.oauth_token'
sudo chmod 600 /home/claude/.claude/.oauth_token
echo 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-XXXX' | sudo tee /etc/kimi-remote-clean-claude.env > /dev/null
sudo chmod 600 /etc/kimi-remote-clean-claude.env
# 纪律:`CLAUDE_CODE_OAUTH_TOKEN`=账号口令,泄露即封号。绝不入 git/飞书/日志/docker history,见 §8。

## 7. 接入 kimi-remote 机群(复用 `install/agent.sh` 设备契约,`docs/SELF-HOSTING.md` + D-15;`install/agent.sh` 第一行 `uname = Darwin` die,Linux 手工平移 + systemd 化)

### 7.1 网关侧注册(一次性,owner 在网关服务器跑)

```bash
JAR=$(mktemp)
curl -sc "$JAR" -X POST https://kimi.example.com/login -H 'content-type: application/json' \
  -d '{"username":"<owner>","password":"<LOGIN_PASSWORD>"}'
RESP=$(curl -sb "$JAR" -X POST https://kimi.example.com/machines/register -H 'content-type: application/json' \
  -d '{"machine_id":"claude-us-01","note":"clean claude-code singapore"}')
echo "$RESP" | jq .
REMOTE_PORT=$(echo "$RESP" | jq -r '.data.remote_port')       # 58700-58899 池(gateway/src/machines.js:8-9)
MACHINE_TOKEN=$(echo "$RESP" | jq -r '.data.machine_token')
```

### 7.2 上传新机器的 SSH 公钥(限定到 REMOTE_PORT,格式见 `gateway/src/sshkeys.js:35`)

```bash
sudo -u claude ssh-keygen -t ed25519 -N '' -C 'kimi-remote-tunnel-claude-us-01' \
  -f /home/claude/.ssh/kimi-remote-tunnel
cat /home/claude/.ssh/kimi-remote-tunnel.pub     # 交给 owner
# owner 在网关侧跑;写入格式见 gateway/src/sshkeys.js:35(permitlisten/permitopen 钉 REMOTE_PORT,no-pty/no-agent/no-X11)
PUBKEY='ssh-ed25519 AAAA... kimi-remote-tunnel-claude-us-01'
curl -sb "$JAR" -X POST https://kimi.example.com/machines/claude-us-01/pubkey \
  -H 'content-type: application/json' -d "{\"pubkey\":\"$PUBKEY\"}" | jq .
```

### 7.4 装依赖 + adapter/fleet/tunnel 凭证与 systemd 单元

`adapters/server.js` 跑真 Claude(`adapters/claude/engine.js`),SDK 默认出口 `api.anthropic.com`——**不引入 litellm 或国产网关**。`KIMI_TOKEN`/`KIMI_UPSTREAM` 留空,kimi 透传 502 是预期(`adapters/server.js:38-52`)。Fleet 探针读 `~/.claude/projects/` 由 `fleet/probe-core.js:95` 的 `probeClaude`,无需 kimi server。

```bash
# adapter 凭证 + fleet 凭证(都 0600;FLEET_TOKEN 由 owner 密钥交接带入)
SVC=/etc/systemd/system
sudo -u claude bash -c "umask 077; cat > /home/claude/kimi-remote-adapter.env <<EOF
MACHINE_TOKEN=${MACHINE_TOKEN}
ADAPTER_PORT=58629
FLEET_UPSTREAM=http://127.0.0.1:58628
KIMI_TOKEN=
KIMI_UPSTREAM=
EOF"
sudo -u claude bash -c "umask 077; cat > /home/claude/kimi-remote-fleet.env <<EOF
FLEET_TOKEN=<from-gateway-deploy.env>
FLEET_PORT=58628
EOF"
sudo chmod 600 /home/claude/kimi-remote-{adapter,fleet}.env

sudo tee $SVC/kimi-remote-adapter.service > /dev/null <<'EOF'
[Unit]
Description=kimi-remote adapter (claude-us-01)
[Service]
User=claude
WorkingDirectory=/home/claude/kimi-remote/adapters
EnvironmentFile=/home/claude/kimi-remote-adapter.env
ExecStart=/usr/bin/env node /home/claude/kimi-remote/adapters/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
sudo tee $SVC/kimi-remote-fleet.service > /dev/null <<'EOF'
[Unit]
Description=kimi-remote fleet-agent (claude-us-01)
[Service]
User=claude
WorkingDirectory=/home/claude/kimi-remote/fleet
EnvironmentFile=/home/claude/kimi-remote-fleet.env
ExecStart=/usr/bin/env node /home/claude/kimi-remote/fleet/agent.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo tee $SVC/kimi-remote-tunnel.service > /dev/null <<EOF
[Unit]
Description=kimi-remote reverse tunnel (claude-us-01 → gateway)
[Service]
User=claude
ExecStart=/usr/bin/ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes -o BatchMode=yes \
  -i /home/claude/.ssh/kimi-remote-tunnel \
  -R 127.0.0.1:\${REMOTE_PORT}:127.0.0.1:58629 -R 127.0.0.1:\${REMOTE_PORT}:127.0.0.1:58628 \
  tunnel@kimi.example.com
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now kimi-remote-{adapter,fleet,tunnel}.service
```

网关服务器 `ss -tln | grep ":${REMOTE_PORT} "` 应 LISTEN;`curl -fsS http://127.0.0.1:${REMOTE_PORT}/api/v1/meta -H "Authorization: Bearer ${MACHINE_TOKEN}" | jq '.data.harnesses'` 应含 `"claude"`(`adapters/server.js:408`)。H5 `kimi.example.com` 登录 → 机群页 `claude-us-01` 在线 → 新建会话 harness=Claude Code → 跑 `pwd` 验证。

## 8. 防封纪律(运维期)

1. **IP 稳定**:DO Reserved IP(绑定免费)/ Vultr 主 IPv4 随实例固定;销毁/重建前先解绑 Reserved IP 再释放 Droplet。
2. **不跨区跳板**:不挂全局代理;SSH 出口限速上限一致。
3. **不并发账号**:一账号一机。
4. **进程出口纯 Anthropic**:systemd 单元 `Environment=ANTHROPIC_BASE_URL=` 显式置空。
5. **异常信号处置**:401/403 SOP — 停 tunnel+adapter → `sudo -u claude bash -lc 'claude -p "ping"'` 验登录态 → 失败则按 §6.2 重发 token(避免 §6.1 浏览器路径暴露不一致的出口 IP)→ 重启服务。
6. **token 不外传**:env/`.oauth_token` 0600;`grep -r 'sk-ant-'` 每周自查。
7. **不混装**:`ps -ef`/`npm ls -g` 不出现非 claude AI 进程。

## 9. 验收清单

```text
[ ] sudo hostnamectl && timedatectl                                   # claude-us-01 / America/Los_Angeles
[ ] sudo ufw status verbose | grep 22/tcp && sudo grep -E '^(PasswordAuth|PermitRoot).*no' /etc/ssh/sshd_config   # ALLOW 22 / sshd 全 no
[ ] claude --version && curl -fsSI https://api.anthropic.com         # 非空 / 200/301
[ ] systemctl is-active kimi-remote-{adapter,fleet,tunnel} && ssh tunnel@kimi.example.com "ss -tln | grep ${REMOTE_PORT}"  # 全 active / LISTEN
[ ] curl -fsS http://127.0.0.1:${REMOTE_PORT}/api/v1/meta -H "Authorization: Bearer ${MACHINE_TOKEN}" | jq '.data.harnesses'   # 含 "claude"
[ ] H5 机群页可见 / 新建 Claude 会话跑 pwd 通 (人工)
```

## 10. 回滚与废弃

```bash
sudo systemctl disable --now kimi-remote-{tunnel,adapter,fleet} \
  && sudo rm /etc/systemd/system/kimi-remote-{tunnel,adapter,fleet}.service \
  && sudo systemctl daemon-reload
sudo -u claude rm -rf /home/claude/.claude /home/claude/.npm /home/claude/kimi-remote   # 本机清 login/token/JSONL
curl -sb "$JAR" -X DELETE https://kimi.example.com/machines/claude-us-01 2>/dev/null || sudo docker exec kimi-remote-gateway sh -c "sed -i '/claude-us-01/d' /data/machines.json"   # 404 fallback D-15
# DO:解绑 Reserved IP 后删除 Droplet(doctl compute droplet delete <id>;Vultr 同理,vultr-cli instance delete)
```

回滚后本机不再保留任何 claude 登录态/token/SSH 密钥/会话 JSONL;Anthropic 账号中心取消该机器的 Session 授权。

**与 SELF-HOSTING.md 的差异**:Linux 专用干净服务器路径(非 SELF-HOSTING 的 Mac 路径)。`install/agent.sh` 第一行 `uname = Darwin` die,故手工平移其契约——`MACHINE_TOKEN`、受限 SSH 公钥登记、远端端口池 58700-58899、adapter/fleet/tunnel 三进程模型按 D-15 精神 systemd 化。公网暴露面裁剪仍走 `gateway/src/allowlist.js` 白名单,本机无新增入站端口。
