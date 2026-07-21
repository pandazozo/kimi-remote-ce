# SECURITY — 威胁模型、凭证清单与轮换

## 威胁模型

本系统把「Mac 上 kimi code 的会话操作能力」暴露到公网。kimi code 能读写文件、执行 shell——所以网关按"凭证泄露一层还有一层"设计:

| 层 | 机制 | 泄露后果 |
|---|---|---|
| 手机 ↔ 网关 | 密码登录(scrypt)+ JWT cookie(12h,httpOnly,SameSite=Lax)+ 登录限流 5 次/10min/IP | 拿到一层也只能做白名单内的会话操作,拿不到 Mac 终端、配置、文件系统直读 |
| 网关转发 | 显式白名单(方法+路径)+ WS 帧过滤(禁 terminal_*/watch_fs_*) | `shutdown/terminals/gui/oauth/config/providers写/mcp/debug/v2` 永不放出 |
| 网关 ↔ Mac | KIMI_TOKEN 只存服务器 `/opt/kimi-remote/deploy/.env`(0600),前端永不可得 | 需先攻破服务器 root 才能拿到 |
| Mac | kimi server 只绑 127.0.0.1;公网到达它的唯一路径是 gateway | 无直接公网面 |
| 传输 | 全链 HTTPS + HSTS;安全响应头 | 防嗅探/中间人 |

残余风险(已接受,见 decisions.md):白名单内的 `sessions/*` 仍允许"让 kimi 执行任意 prompt"——这是产品功能本身;防护依赖登录这层 + 密码强度 + 限流。若手机丢失:改密码(轮换流程见下)+ `kimi server rotate-token` 双保险。

## 凭证清单

| 凭证 | 存哪 | 谁能看 | 轮换 |
|---|---|---|---|
| 登录密码(明文) | 只存在于 owner 脑子/密码本;系统里只有 scrypt 哈希 | owner | 见下「密码轮换」 |
| LOGIN_PASSWORD_SCRYPT | 服务器 `.env`(0600)+ 本机 `gateway/.env`(gitignore) | root@opc-prod | 同上 |
| JWT_SECRET | 同上 | 同上 | 换后所有已签 JWT 立即失效 |
| KIMI_TOKEN(Mac kimi server) | 同上;Mac 侧 `~/.kimi-code/server/` | 同上 | `kimi server rotate-token`(旧 token 立即失效)→ 更新两处 .env → 重启 gateway |
| 芃芃阿里云 AK/SK | macOS Keychain `zaios-aliyun-pengpeng`,经 `Work/zaios/ops/cred-get` 取用 | 本机 | 阿里云 RAM 控制台;本次系统未使用 |
| Dynadot API key | Keychain `zaios-dynadot` | 本机 | 未使用(NS 在阿里云,用不上) |
| SSH root 密钥 | `~/.ssh/m5_fleet`(既有) | 本机 | 既有 fleet 流程 |

## 密码轮换

```bash
node gateway/bin/hash-password.js '<新密码>'      # 得新哈希
# 更新服务器 /opt/kimi-remote/deploy/.env 的 LOGIN_PASSWORD_SCRYPT
ssh opc-prod 'cd /opt/kimi-remote/gateway && docker compose up -d --force-recreate'
# 顺手换 JWT_SECRET 让所有旧会话失效(可选但更稳)
```

## 审计与监控(现状)

- gateway 日志:登录成功/失败、白名单拦截(`docker compose logs`)
- nginx access log:全量请求
- cred-get 审计:`Work/zaios/ops/cred-audit.log`
- 待做(ROADMAP):登录失败飞书告警;白名单拦截告警

## 泄露应急

1. 立即改密码 + 换 JWT_SECRET(上述命令)→ 所有手机端会话失效
2. `kimi server rotate-token` + 更新服务器 .env
3. 查 nginx access log 与 gateway 日志定位异常来源
4. 必要时 `docker compose down` + 停隧道(`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.pengpeng.kimi-remote-tunnel.plist`)整体熔断
