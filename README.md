# kimi-remote(社区版)

**用手机/任意浏览器,远程驱动你工作站上的 AI 编程会话**——Kimi Code / Claude Code / Codex / Z Code / WorkBuddy,看状态、读消息、发指令、排队、上传附件、一键接管。

```
手机浏览器 → 你的域名(网关,云服务器 docker) → SSH 隧道 → 你的 Mac → 各 AI CLI 会话
```

## 为什么

- AI CLI 都长在终端里,离开工位就成了瞎子;这个系统让你的会话**随身带**
- 不只一个 harness:五源会话聚合在一个「机群页」,壳(工具)和脑(模型)分开显示
- 每个 bug 一个回归用例,带视觉走查的测试体系,双环境(正式/测试)部署

## 快速开始(自托管,约 20 分钟)

前置:一台有公网 IP 的云服务器(docker+nginx)+ 一个域名 + 一台 macOS 工作站(已登录 kimi CLI;可选 codex/claude CLI)+ 工作站能免密 ssh 到服务器。

```bash
git clone https://github.com/pandazozo/kimi-remote-ce && cd kimi-remote-ce
cp config.example.env config.env        # 按注释填 ~8 项(域名/密码/服务器)
sudo bash install/gateway.sh            # 在云服务器:装网关+nginx+证书,自检
bash install/agent.sh                   # 在 Mac:装 kimi server+adapter+隧道,自检
```

打开 `https://你的域名`,用 `LOGIN_PASSWORD` 登录。详见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)(功能矩阵/隔离声明/排障)。

## 架构

| 层 | 位置 | 职责 |
|---|---|---|
| `gateway/` | 云服务器(docker) | 域名/登录/多用户邀请/审计/白名单代理/WS 桥 |
| `web/` | 网关托管的 H5 | 单页应用:会话列表/详情/排队/附件/机群页/接管 |
| `adapters/` | 工作站 | 设备前门:模型注入、WS 订阅激活、多 harness 分发 |
| `fleet/` | 工作站 | 五源会话探针(codex/claude/zcode/workbuddy 只读聚合)+ 接管执行 |
| `monitor/` | 工作站 | 健康/执行器/会话 janitor 探针(可接飞书/webhook 告警) |
| `install/` | — | 两个安装器,严谨自检 |
| `tests/` | — | 分层测试:单元/每 bug 一回归/生产冒烟/视觉走查/真值对账 |

## 隔离与安全

- 你的账号、密钥、会话数据**只在你自己的机器上**;安装器在本机生成全部随机密钥,明文密码不落盘
- 仓库不含任何部署方的域名/IP/密钥(发现请提 issue)
- 无遥测;网关默认仅监听 127.0.0.1,由本机 nginx 反代
- 逐跳代理头已按规范处理;网关有路径白名单(终端类接口不出机)

## 功能速览

- 会话全双工:发指令/排队(多条,逐条记时,支持插队引导)/打断/重命名/置顶/归档
- 附件:任意文件上传(8MB+ 实测),图片走 file 引用不撞 1MB 上限
- 交互卡:审批/AskUserQuestion 在输入框上方常驻,手机上直接点选
- 机群页:五源会话聚合 + 生命体征卡 + 真实驱动模型标签 + 系统会话折叠
- 接管:对 Claude Code·壳 / Codex 会话直接下指令(官方 CLI headless resume)
- 测试体系:`tests/run-all.sh --full`(单元+回归+冒烟+视觉+对账)

## 当前限制(如实)

- 设备代理仅支持 macOS(linux 在 roadmap)
- Z Code / WorkBuddy 接管待解锁(存储格式已破,见文档)
- 中文界面为主

## License

MIT
