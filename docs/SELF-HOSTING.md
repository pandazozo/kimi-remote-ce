# 自托管指南(Self-Hosting)

> 目标读者:想用同一套代码,在**自己的账号 + 自己的服务器**上跑起 kimi-remote 的人。
> 原则:**你的账号、密钥、数据全部只在你自己的机器上**,与任何其他部署(包括我们的)零共享、零依赖、零回传。

## 这套系统是什么

手机/任意浏览器 → 你的域名(网关) → SSH 隧道 → 你的 Mac/工作站 → 驱动本机的
Kimi Code / Claude Code / Codex / Z Code / WorkBuddy 会话:看状态、读消息、发指令、排队、接管。

两端组成:

- **网关**(你的云服务器,docker):域名 + 登录 + 多用户/邀请 + 审计 + 代理转发
- **设备代理**(你的 Mac):kimi server(官方 `kimi web` 拉起)+ adapter(修复层)+ 隧道客户端

## 前置条件(先备齐)

| 项 | 要求 |
|---|---|
| 云服务器 | 有公网 IP、docker + docker compose、80/443 可入站 |
| 域名 | 一个指向该 IP 的域名(证书安装器自动签) |
| 设备(工作站) | macOS,已登录 `kimi` CLI(kimi-code),可选 codex CLI / claude CLI |
|  SSH | 设备能免密 ssh 到云服务器(`ssh-copy-id`) |

## 安装(操作层面就三步)

```bash
git clone <repo> && cd kimi-remote
cp config.example.env config.env   # 按注释填 ~8 项(域名/密码/服务器)
install/gateway.sh                  # 在云服务器上跑:装 docker 网关+nginx+证书,自检
install/agent.sh                    # 在你的 Mac 上跑:装 kimi server+adapter+隧道,自检
```

完成后打开 `https://你的域名` → 用 `LOGIN_PASSWORD` 登录 → 你的会话都在里面。

安装器(严谨侧)做的事:逐项校验前置条件并给出明确报错;`kimi web` 驻留为 launchd 服务;
生成随机 JWT_SECRET/FLEET_TOKEN;密码转 scrypt 哈希(明文不留盘);每步装完做健康检查,
不过即退出并打印排障指引;全部凭据只写本机文件,权限 600。

## 功能矩阵(按配置启用)

| 功能 | 需要的配置 | 没有会怎样 |
|---|---|---|
| Kimi 会话全双工 | kimi CLI 已登录(自动) | — |
| 多用户/邀请同事 | 网关管理页自助 | — |
| Codex 会话只读/接管 | 本机 codex CLI 登录 | 只读列表;接管如实报额度 |
| Claude Code·壳 接管 | `CLAUDE_BASE_URL/TOKEN`(任一 Anthropic 兼容端点) | 该入口自动隐藏 |
| 机群页(五源聚合) | 无(自动探测本机 harness) | — |
| 探针告警 | `LARK_BOT_USER_OPEN_ID` 或 `ALERT_WEBHOOK_URL` | 不告警,系统照跑 |
| 测试通道 | `TEST_DOMAIN` | 单正式版 |

## 隔离声明(开源原则)

- 代码库不含任何他人的域名、IP、密钥、token;我们的部署信息全部收在 **gitignored 的部署档**里,不进 git
- 你的 JWT_SECRET、FLEET_TOKEN、密码哈希均由你的安装器在本机随机生成
- 遥测:无。版本检查:仅访问公开 GitHub releases(可在配置中关闭)

## 与主线的关系

同一 `main` 分支,不分叉。自托管化(v0.5 线)即把历史硬编码全部收到 `config.env` +
安装器,主线功能(机群/接管/测试体系)两边同步演进。
