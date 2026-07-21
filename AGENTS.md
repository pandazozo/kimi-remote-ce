# kimi-remote 项目契约(AGENTS.md)

> 本文件是 AI 代理在本项目工作的默认约定。全局契约见 `~/.kimi-code/AGENTS.md`。

## 这是什么

手机远程控制 Mac 上 kimi code 会话的 H5 系统。链路:手机浏览器 → https://your.domain(nginx)→ gateway 容器(127.0.0.1:8080)→ SSH 反向隧道(服务器 127.0.0.1:58627)→ Mac `kimi server`(127.0.0.1:58627)。

## 技术栈与硬约束

- **gateway**:Node 20,ESM,依赖只允许 `express` + `ws`(其余用 node:crypto 等标准库)。新增依赖必须先在 decisions.md 记一条理由。
- **web**:vanilla HTML/CSS/JS,**无构建、无 CDN、无框架**(中国网络环境 + 可维护性)。防 XSS 是第一优先级(所有模型/工具输出必须转义渲染)。
- **agent**:bash + launchd,不引入新守护进程框架。
- **部署**:Docker(network_mode: host,只绑 loopback)+ nginx + certbot。服务器 opc-prod 同时跑着 OPC 生产栈,**任何改动不得碰既有容器/容器网络/nginx 既有 vhost**。
- **密钥永不进 git**:`.env` 一律 gitignore;模板只放键名。芃芃阿里云 AK 只经 `Work/zaios/ops/cred-get` 取用,明文不写盘、不进日志、不进飞书群。

## 安全红线(改动必须遵守)

1. `gateway/src/allowlist.js` 是公网暴露面的核心:新增放行路径必须**显式白名单**(方法+路径),禁止放宽成正则大开口;放行前在 decisions.md 记录。
2. `shutdown`、`terminals`、`gui`、`oauth`、`config`、`providers` 写、`mcp`、`debug`、`connections`、`/api/v2/*` 永远不放行。
3. Mac 的 `KIMI_TOKEN` 只出现在服务器 `/opt/kimi-remote/deploy/.env`(0600)与本机 `gateway/.env`;前端永远只持有 JWT cookie。
4. 登录必须限流;JWT 12h 过期;密码哈希用 scrypt。
5. 本地 kimi server 永远只绑 127.0.0.1(不 `--host`),公网到达它的唯一路径是 gateway。

## 常用命令

```bash
cd gateway && npm start                    # 本机起网关(需 gateway/.env)
node gateway/bin/hash-password.js <pw>     # 生成密码 scrypt 哈希
BASE=... PASSWORD=... ./tests/smoke.sh     # 端到端冒烟
./deploy/deploy.sh test                  # 部署测试版(test.kimi.pengpengco.com)
./deploy/deploy.sh prod                  # 部署正式版(只部署打过 tag 的版本)
launchctl list | grep kimi-remote-tunnel   # 查 Mac 侧隧道状态
tail -f ~/Library/Logs/kimi-remote-tunnel.log
```

## 排障速查

- 手机端显示「Mac 离线」→ 按顺序查:①本机 Clash 必须 **rule 模式**(global 会杀死到 opc-prod 的直连,见 decisions D-10)②`launchctl list | grep kimi-remote-tunnel` ③ `tail -50 ~/Library/Logs/kimi-remote-tunnel.log`(自愈循环会记录每次重连)④服务器 `ss -tln | grep 58627`、`curl 127.0.0.1:58627/api/v1/healthz`(带 token)。
- **H5 会话与 TUI 终端「对不上」** → 两层原因:①TUI `kimi --session` 选择器**按当前目录过滤**,只列当前 cwd 的会话(实测:在 ~ 只出 ~ 的会话);H5 则列全部工作区。②**macOS `/tmp` 是 `/private/tmp` 软链**:TUI 按真实路径建工作区,H5/API 按字面 `/tmp` 建另一个(磁盘实证 `wd_tmp_11fe14a563f7` ≠ `wd_tmp_e9671acd2448`),同目录被劈成两个工作区。**规避:新建会话用真实项目目录,别用 `/tmp`;按 ID 直开 `kimi --session <id>` 任意目录可达。**(2026-07-20 实测)
- gateway 502 → 服务器 `docker compose -f /opt/kimi-remote/gateway/docker-compose.yml logs`。
- 会话不回消息 → 大概率是 pending approval/questions 或 kimi 会员额度;H5 会话页看徽标。
- 更多见 docs/DEPLOY.md「排障」。

## 变更流程与版本协调(VCR · 多代理线共用 · 强制执行)

> 背景:本仓由多条 AI 代理线并行开发,共享 main。版本号/CHANGELOG/决策编号是公共资源,必须按序领取,禁止抢占。

1. **VCR-1 先同步**:开工前 `git pull --rebase origin main`。被拒禁止硬推——先看别人的新提交。
2. **VCR-2 先占位**:`./deploy/version-claim.sh "主题"`。自动:pull --rebase → 算下一号 → CHANGELOG 顶部加 WIP 节 → commit+push。号即被全仓领走,其他线可见。
3. **VCR-3 后写码**:开发 → `tests/run-unit.sh` → `./deploy/deploy.sh test` → 测试版冒烟。
4. **VCR-4 只加自己的文件**:`git add` 显式列文件;用 `git add -A` 前必须 `git status` 确认工作区没有别人的 WIP。
5. **VCR-5 编号先查**:D-xx 落笔前 `grep -oE "D-[0-9]+" docs/decisions.md | sort -uV | tail -1`,取下一个。
6. **VCR-6 完成收口**:CHANGELOG 去掉 (WIP) 补全内容 → commit → `git tag -a <同号>` → `git push origin main --tags` → `./deploy/deploy.sh prod` → 正式版冒烟。
7. **VCR-7 撞车处理**:号被占 → 让号取下一,不改历史;CHANGELOG 同号两节 → 后来者改号并留注。
