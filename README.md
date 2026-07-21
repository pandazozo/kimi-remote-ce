# kimi-remote

手机远程控制本机 Kimi Code 的 H5 系统 —— 类似 ChatGPT / Claude App 的 remote 功能:随时随地通过手机访问、控制 Mac 上的全部 kimi code 会话,流式聊天、多文件上传(不限大小)、`/` 指令、审批与提问实时处理。

- 生产入口:**https://your.domain**(opc-prod · 阿里云杭州 47.96.255.63)
- 上游:`kimi server`(kimi code CLI 0.27+,REST + WebSocket + Web UI)
- 属主:芃芃科技

## 快速开始

```bash
# 本机开发(gateway 直连本机 kimi server)
cp deploy/env.example gateway/.env   # 填 KIMI_TOKEN / LOGIN_PASSWORD_SCRYPT / JWT_SECRET,DEV_INSECURE_COOKIE=1
cd gateway && npm install && npm start
# 打开 http://127.0.0.1:8080

# 冒烟测试
BASE=http://127.0.0.1:8080 PASSWORD='kimi-remote-dev' ./tests/smoke.sh

# 部署到测试环境(首次见 docs/DEPLOY.md;prod 只部署打过 tag 的版本)
./deploy/deploy.sh test
```

## 目录地图

| 目录 | 说明 |
|---|---|
| `gateway/` | Node 20 安全网关:登录鉴权、转发白名单、REST 流式代理、WS 桥(唯一暴露面) |
| `web/` | H5 单页(vanilla,无构建):登录 / 会话列表 / 聊天 / 上传 / `/` 指令 / 审批 |
| `agent/` | Mac 侧:`tunnel.sh` + launchd plist,维持 kimi server 常驻与 SSH 反向隧道 |
| `deploy/` | nginx vhost、deploy.sh、DNS upsert 脚本、env 模板 |
| `tests/` | `smoke.sh` 端到端冒烟(登录→建会话→流式→上传→白名单) |
| `docs/` | 架构 / API / 部署 / 安全 / 路线 / 决策日志 |

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构与数据流、安全模型
- [docs/API.md](docs/API.md) — 网关对外 API 与转发白名单
- [docs/DEPLOY.md](docs/DEPLOY.md) — 首次部署、日常升级、回滚、排障
- [docs/SECURITY.md](docs/SECURITY.md) — 威胁模型、凭证清单与轮换
- [docs/ROADMAP.md](docs/ROADMAP.md) — 迭代路线
- [docs/decisions.md](docs/decisions.md) — 关键决策(ADR)

## 版本管理约定

- Conventional Commits(`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`)
- `main` 主干 + `feat/*` 短分支;语义化版本 tag(`v0.1.0` 起);CHANGELOG 遵循 Keep a Changelog
- 每次部署到生产前必须跑通 `tests/smoke.sh`
