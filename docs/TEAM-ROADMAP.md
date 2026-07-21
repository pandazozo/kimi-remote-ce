# TEAM-ROADMAP — 团队共享与开源推进方案

> 目标:把 kimi-remote 从「owner 单人工具」推进到「团队可用的成熟产品」,并以开源标准收尾。
> 决策:见 docs/decisions.md D-11。节奏:先小范围真用,再硬化,最后开源——每一步都可回头。

## 现状(v0.2.x)

单 owner:共享一个访问密码 → 单一 JWT `sub:"owner"`;单 Mac 隧道;白名单网关;文档/测试/版本管理已规范。安全模型假设"一个人一台机"。

## 关键产品决策(D-11,已拍板)

**团队模型 = 每人各自 Mac 跑 agent,网关多租户,邀请制配对**——对照 ZCode(桌面 runtime + QR 配对)而不是"共享一台中央机"。理由:
- 代码/会话留在各自机器,数据边界天然清晰(合规与信任)
- 网关只做路由与鉴权,不碰代码,爆炸半径最小
- 配对制(ZCode 已验证的交互)比账号密码分发更安全、更好讲

**权限第一性:成员默认只能看自己机器的会话**;owner 是 admin 可见全部。不做"全员互相可见"——需要时再开,开了要记 decision。

## 分阶段

### v0.3 团队试点(2~5 人,目标:真跑通一个非 owner 成员)

- **多账号**:gateway 用户表(`deploy/.env` 里 `USERS_JSON`,如 `{"wangzuo":{...hash,role:admin},"member1":{...hash,role:member}}`),登录签 per-user JWT(sub=用户名),全部登录/失败/代理操作记审计日志(文件,按天)
- **机器命名空间**:tunnel agent 启动时带 `MACHINE_ID`+机器 token 注册;gateway 维护 machine→tunnel 端口映射;REST/WS 路径加 `/m/:machine/` 前缀;H5 会话按机器分组展示
- **邀请配对**:admin 在 Mac 上跑一条命令生成一次性邀请链接(24h 有效),成员手机打开 → 设置自己的密码 → 自动引导装 agent(一行 curl 脚本)→ 上线。邀请链路走 HTTPS 一次性 token,不过飞书明文
- **兼容**:单 owner 模式继续可用(零配置迁移)
- **文档**:成员上手指南(图文)+ admin 运维手册

### v0.4 硬化(团队扩大前)

- per-user 登录限流与操作配额;成员停用/删除命令
- 审计日志查看页(admin);隧道断连 → 飞书告警(复用 zaios 通道)
- 安全自查:白名单再审视、依赖审计(npm audit)、JWT secret 轮换流程演练
- H5 英文/中文切换(开源预备)

### v1.0 开源(标准收尾)

- **脱敏**:内部代号全清(芃芃/zaios/域名默认值化 example.com);git 历史审查(必要时重建仓库)
- **LICENSE:Apache-2.0**(专利授权+商用友好,适合"标准"定位;备选 MIT 更短更宽)
- **品牌**:`kimi-remote` 与 Kimi 官方命名有混淆风险,开源前改名(候选:`agent-remote` / `remoted` / 新造词;届时定,不阻塞)
- README(英文)+ 自部署指南 + 架构图;CI(单测+smoke 门禁);CONTRIBUTING + CODE_OF_CONDUCT
- 发布后:HN/V2EX/即刻 发帖素材(英文稿)

## 需要 owner 的一件事(不阻塞,飞书已/将提醒)

- **git 远程推送**:团队化意味着代码要上远程(芃芃 Codeup 或 GitHub 私有库)。D-09 留了待确认——确认后我推送并设分支保护。

## 与竞品对标的落点

- 配对交互抄 ZCode QR(但用一次性链接,免扫码也兼容)
- 权限模型对照 ZCode 五档(先做 Default/Auto/Plan 三档,Full Access 不做)
- 审计与多机器管理对照 Coder/Tailscale 的 admin 体验
- 监控清单见 docs/COMPETITORS.md,每周自动走查
