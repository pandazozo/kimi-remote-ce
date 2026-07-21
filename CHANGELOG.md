# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循语义化版本。

## [v0.4.23] - 2026-07-21

### Added

- **蜂群工人通道**(`fleet/swarm-dispatch.sh`,owner「Kimi 额度严重不够,用智能蜂群」钦定):开发任务派 claude 壳 + MiniMax m3(经 M2 litellm),证据驱动(任务必须自证),主会话独立复核后入库;审计落 `~/.kimi-remote-swarm.log`。首两单实测通过且复核为真
- codex 会话标题两处优化(均由蜂群工人完成):`(无标题)` 兜底为「目录名 · MM-DD」;过滤 AGENTS.md/`<INSTRUCTIONS>` 指令注入冒充真人标题
- AGENTS.md 双宪:Kimi 额度保护条款(主会话只沟通/调度/验收,执行派蜂群,SOL 评审走 M2)

## [v0.4.22] - 2026-07-21

### Added

- **全源真实模型显示**(壳脑分离收尾):codex(`"model"` 记录,实测 gpt-5.6-sol)、zcode(`message.data.model.modelID`,实测 GLM-5.2)、workbuddy(jsonl model 行,实测 kimi-k3 / minimax-m3-pay / deepseek-v4-pro)全部接入;机群列表每个会话一眼可见「壳是谁、脑是谁」

## [v0.4.21] - 2026-07-20

### Added

- **「壳脑分离」:Claude Code 会话显示真实驱动模型**(owner 疑「没有 Claude 账号却显示 claude 会话是不是虚假」):探针为每个 claude 会话提取 jsonl 里记录的 model 字段,机群列表/详情直接显示。实测近 5 个「claude 会话」的驱动模型:k3、MiniMax-M3、glm-5.2、k3、doubao-seed-2.0-code——**无一为 Anthropic Claude**。标签文案由「Claude」改为「Claude Code」(harness 本名),消除误解
- 结论落档:这些会话走的是国产网关/端点(M2 litellm、kimi 端点、豆包等),与 Anthropic 账号无关;不虚假、可接管

## [v0.4.20] - 2026-07-20

### Added

- **机群页生命体征卡**(SOL 仪表盘 v1):每源一张卡(计数大数字 + 最新活动时间 + 运行中徽标),彩色顶边,横向滑动;下接五源混排列表。机群页从「裸列表」升级为「体征面板 + 列表」
- HARNESS-FLEET.md §8 接管矩阵落档(claude ✅/codex 🟡/workbuddy 🔴/zcode 🟡 及各自卡点)

### 卡点说明(zcode 接管)

- zcode CLI 配置文件 schema 逆向未果(app v2 配置照抄/6 种变体/`--settings` 均被同一句报错挡回);Z.AI OAuth 初始化被网络拦截(非 JSON 响应)。**剩余解锁路径:桌面端 Settings 手动加一次 OpenAI 兼容供应商(2 分钟)**,之后 CLI 立即可驱动

## [v0.4.19] - 2026-07-20

### Added

- **Codex 接管**(路径就绪,两项已知限制):
  - 实现:`codex exec resume <id> <text>`(会话原 cwd,OpenAI 登录态);`CODEX_GW_FORCE=1` 可切 M2 litellm m3 通道(实验开关)
  - H5 接管 composer 放开到 codex;接管失败原文上屏(不吞错)
  - 限制①:OpenAI 订阅额度已用尽,07-26 06:12 重置(实测 M5 与谷大两账号同限);届时路径即通
  - 限制②:multi-agent v2 **子代理会话** codex 自身禁止注入(`direct app-server input is not allowed`);TUI 直建会话不受影响
  - litellm wire 死结实测:codex 0.144 已删 chat wire(`wire_api="chat" is no longer supported`),responses wire 与 litellm 模型清单形状不兼容,适配层待做
- 修复:fleet agent 在 launchd 极简 PATH 下 npm 包 env-node 找不到 node(补 node 目录进 exec PATH)

## [v0.4.18] - 2026-07-20

### Added

- **联邦第二刀:他源详情 + Claude 接管**(SOL「接管」标准落地):
  - `getMessages` 四源正文归一(codex/claude/zcode/workbuddy,真实格式各异:rollout JSONL/projects JSONL/db.sqlite/projects JSONL)
  - Mac agent 新增 `/fleet/messages`(只读)与 `/fleet/takeover`(POST,写路径);网关同名代理
  - **Claude 接管端到端**:H5 详情页对 claude 会话开放输入框 → 网关 → Mac 在**会话原 cwd** 执行 `claude -r <id> --model m3 -p`(经 M2 litellm 国产网关),回复实时上屏;审计落 `~/.kimi-remote-takeover.log`
  - 关键实测:claude resume 必须在会话原 cwd(跨目录报 No conversation found);M2 litellm 网关 key 为 start-gateway.sh 的 SWARM_GATEWAY_KEY;lingya 无 claude 模型(79 个全查过)
  - H5 `#/fs/:h/:id` 他源详情页:消息流(user 气泡/assistant markdown)+ claude 接管 composer;他源 v1 只读
- 实测:全链 playwright 端到端(详情 10 条消息、发「验证」回「验证」),prod 冒烟 12/12

## [v0.4.17] - 2026-07-20

多 harness **控制面**里程碑(与 v0.4.16 读面「五源会话进机群页」互补):claude 可写可流式,harness 命名空间路由落地。

### Added

- **adapter server**(`adapters/`,单机前门 127.0.0.1:58629,launchd 常驻):
  - 默认路径落 kimi;`/h/kimi` 剥前缀透传;`/h/claude` Agent SDK 控制面;`/fleet/*` 透传并行线读面(58628)
  - **claude 引擎**(`adapters/claude/engine.js`):cc-remote-h5 `chats.ts` 移植——每会话一个 SDK streaming-input 常驻热进程、`canUseTool` 权限中继(允许/总是允许/拒绝)、**原生 delta 打字机**(text/thinking/tool_input)、SSE seq 积压重放、30min 空闲+2h 僵尸回收
  - claude 读路径:sessions/messages 归一化(实测:8 会话列出、159 条消息读出)
- **网关 harness 命名空间**:`/m/:machine/h/:harness/api/*`——按 machines.harnesses 映射选上游与 token(kimi/claude → adapter 58629);未登记 harness 404;allowlist 加 harness 能力表(kimi/claude 全双工,未登记一律只读)
- 隧道三口转发(58627 kimi / 58628 fleet 读面 / 58629 adapter);adapter 由 `com.pengpeng.kimi-remote-adapter` launchd 常驻
- 端到端实测:生产域名 `/m/m5/h/claude/api/v1/sessions` 返回真实 Claude Code 会话;`/m/m5/h/kimi/*` 与默认路径行为不变

### Fixed(过程中实抓)

- 开发态 adapter 残留进程致 launchd EADDRINUSE;index.js machineMiddleware 重复声明;harness 上游 kimi 前缀未剥(返官方 UI HTML)

### 决策

- D-18 融合架构:读面(fleet/agent 58628,并行线)+ 控制面(adapters/ 58629,本线)分平面共存防碰撞;前门 adapter 统一出口

## [v0.4.16] - 2026-07-20

### Added

- **联邦切片:机群页**(owner「线上没变化」直接驱动):
  - Mac `fleet/agent.js`(loopback 58628,Bearer 鉴权):五源会话探针服务;隧道升级双口转发(58627+58628),launchd 注入 FLEET_TOKEN
  - 网关 `GET /fleet/sessions`(cookie 鉴权 → 隧道 → Mac 探针)
  - H5 新增 `#/fleet` 机群页:五源统计条(kimi/codex/claude/zcode/workbuddy 彩色计数)+ 统一会话列表(harness 徽标·标题·cwd·相对时间),kimi 可点进详情,他源 v1 只读;列表页顶栏加「机群」入口
  - `fleet/probe-core.js`:探针核心模块化(CLI/服务复用),每源保底配额防单源挤爆
- 实测:prod 五源分布 claude:8 workbuddy:4 codex:15 zcode:4 + kimi,冒烟 11/11

## [v0.4.15] - 2026-07-20

### Added

- **Codex Remote 对标拆解**(docs/BENCHMARK-codex-remote.md):OpenAI 官方远程体系(desktop+cloud+ChatGPT 手机遥控)全调研+本机 `codex cloud` CLI 实测;产出取长补短清单 A1-A7(codex cloud 官方 CLI 接联邦第 6 源/产物卡/审批 push 化/机群队列视图/蜂群 worktree 隔离/Hooks 护栏/用量可见);关键结论:**E 源(官方 CLI)已覆盖大部分接入需求,D-16 的 B 层网页快照(ToS 灰)大概率不必签收**

## [v0.4.14] - 2026-07-20

### Added

- **五源会话探针**(fleet/harness-sessions.js):新增 zcode(`~/.zcode/v2/tasks-index.sqlite` tasks 表)与 workbuddy(`~/.workbuddy/workbuddy.db` sessions 表,custom_title 优先)只读接入;WAL 库统一 `mode=ro&busy_timeout=3000`;codex/claude/zcode/workbuddy 四源本地 + kimi API 五源会话模型归一 `[{harness,id,title,cwd,updated_at,archived,file}]`,实测各源真实会话均正确解析
- HARNESS-FLEET.md §7 补齐五源存储格式实证与只读纪律

## [v0.4.13] - 2026-07-20

### Added

- **跨 harness 会话只读探针**(fleet/harness-sessions.js,P0/P1 联邦输入):codex(`~/.codex/sessions` rollout JSONL,session_meta+真人消息标题,跳过系统注入)与 claude(`~/.claude/projects`,summary 标题源)统一输出 `[{harness,id,title,cwd,updated_at,archived,file}]`;实测解析正确
- HARNESS-FLEET.md 补 §7 会话存储格式实证
- 凭证登记修正(zaios):MiniMax key 实测 Token Plan 已失效(key 有效,需续费),accounts.yaml 已标注待续费

## [v0.4.12] - 2026-07-20

### Added

- **机队 harness 盘点真源**(docs/HARNESS-FLEET.md):3 台 Mac × 9 个 harness 已实测登记(含会话存储与接入方式);Claude Code 三机本已装;MiniMax mmx-cli 三机新装 1.0.18 并鉴权(账号暂无 Token Plan 订阅);小米 "Honeycomb" 未检索到存在证据,待确认
- **每日升级机制**(fleet/harness-upgrade.sh):M5 每日 05:47 编排三机(ssh 推送,远端零安装);分渠道升级(npm / brew / codex 自更新 / 仅上报),验收以 `npm ls` 对比 registry latest(免疫 PATH 旧二进制遮挡),快照回滚;升级前冷备会话目录(7 天滚动);失败/回滚/SHADOW-WARN 当天飞书汇总,周一 09:07 版本周报
- SOL(gpt-5.6-sol)方案评审已执行并逐条采纳(记录见 docs/HARNESS-FLEET.md §4)
- `deploy/version-claim.sh` 两修:仅拦 CHANGELOG 脏;fetch+behind 检查替代 rebase(他线 WIP 共存可用)

## [v0.4.11] - 2026-07-20

### Fixed

- **状态 chip 守护态根修**(owner 真机报障「运行状态不准确:底部还在执行,状态显示却是空闲;为什么测试没发现」):
  - 根因一:聊天页 `renderStatusChip` 只有 运行中/待处理/空闲 三态,**主轮空闲但后台任务(bash/subagent/cron)在跑时永远只能显示「空闲」**;修复为四态优先级:待处理 > 运行中 > 守护 N > 空闲。
  - 根因二:守护任务数据(`loadActivity`)仅在进入会话时拉一次、**不轮询**,后台任务后来起跑 chip 永不更新;新增 `refreshGuardTasks` 并入 4s 状态轮询,后台任务起落在 ≤4s 内反映到 chip。
  - 根因三:切回页面(`visibilitychange`)只刷消息不刷状态,chip 滞后;现补挂 `pollStatusOnce`。
  - 回归网:`tests/regressions/R005-status-chip-guard-tasks.sh`(此前测试只覆盖 busy/待处理两态,没有「主轮空闲+后台在跑」用例——这就是测试没发现的原因,已立档防回归)。

## [v0.4.10] - 2026-07-20

### Added

- **流式体验对齐终端**(owner 反馈「和终端打字机差距大」):
  - 打字机:`in_flight_turn.assistant_text/thinking_text` 1.2s 轮询,「正在输入」气泡(光标 ▍)+「正在思考 N 字」折叠卡,增量追加不整刷
  - keyed 增量渲染:消息按 id 复用 DOM 节点(新增 append/变更 patch/消失 remove),消灭整页 innerHTML 刷新与闪烁
  - runbar 计时「正在执行 X… (Ns)」;工具卡摘要行(工具名+关键参数一行)
  - `tests/terminal-parity.sh` 对账机制 v1:wire.jsonl(终端真源)vs API(H5 数据源),内容覆盖+富度能力报告(owner 钦定:每版本与终端窗口对比)

### Fixed

- (无)

## [v0.4.9] - 2026-07-20

### Added

- **版本协调规则 VCR**(AGENTS.md「变更流程与版本协调」,多代理线强制):先同步 → 先占位 → 后写码 → 只加自己文件 → 编号先查 → 完成收口 → 撞车让号
- `deploy/version-claim.sh`:一条命令完成版本占位(pull --rebase + 算下一号 + CHANGELOG WIP 节 + commit+push);`deploy/version-next.sh`:打印下一可用版本号
- 业界对齐:占位即提交的思路与 Changesets(monorepo 版本管理标准工具)的「版本由仓内文件决定」原则一致

## [0.4.7] - 2026-07-20

### Fixed

- **⚡ 排队插队报错**(owner 真机报障):实测实锤 steer 目标是【排队项自身】prompt_id,此前 H5 传 active id 必报 40402;`steerQueued` 改用排队项 id,`steerMessage`(输入框 ⚡)改两步走(先入队拿 id 再 steer)

### Added

- **Bug 回归测试机制**(owner 钦定,跨项目复用):
  - `tests/regressions/`:R001 questions-status-pending / R002 overlay-undefined / R003 pin-title / R004 steer-semantics / R005 render-freeze / R006 owner-login,全部可执行
  - `tests/run-all.sh`:`--quick` / 默认(单测+回归) / `--full`(+冒烟+对账)分层入口
  - `regressions/README.md` 收录约定+索引+模板+提交审查清单
  - `~/.kimi-code/skills/bug-regression-mechanism/` 机制技能(铁律/结构/工作流/模式库)
  - 当前默认层全绿(单测 60+ + 回归 6)

## [0.4.6] - 2026-07-20

### Added

- **会话 title 对齐机制「最新者胜」**(D-17,owner 真机反馈「title 会变、和终端没对齐」):overlay 写 title 时网关自动记录落笔瞬间的上游 title(base_title+at);H5 合并显示时若上游此后又改过名(如 TUI `/title`),上游最新、overlay 静默过期清除——双向都是最新者胜
- **重名会话 badge**:列表对归一化后同名的会话标「重名」(源自 aipowertest 一台两名实例:9efc213a 上游名 aipowertest 与 5a8956aa overlay 名 AIPowerTest 并存)
- overlay 单测 6 条(base_title/at 存储、清除、undefined 键防御、超长截断)

### 已知边界

- TUI 终端永远看不到 overlay 改名(上游 API 无 PATCH,实测 404,写不回 state.json);反向(TUI 改名 H5 跟随)已由本机制覆盖

## [0.4.2] - 2026-07-20

### Fixed

- **AskUserQuestion 无法作答 / 审批卡不渲染**(owner 真机报障,智能蜂群会话):`/questions` 与 `/approvals` 端点裸调返回 40001,**必须带 `?status=pending`**(实测,此前静默 catch 致卡片永不出现);refreshInteractions 两路补齐
- 提问卡按 openapi 契约重写:一次调用最多 4 个子问题(分组渲染),`single`/`multi_select`/`allow_other` 三种作答,答案按子问题 id 键控 `POST /questions/{question_id}`;pending 时状态 chip 显示「待处理」且 composer 锁定
- API.md 同步实测契约

### 说明

- 版本协调:本修复原误标 v0.4.1,与并行线的 v0.4.1(安全探针告警)撞 tag,已更正为 v0.4.1=并行线、v0.4.2=本修复;此后 tag 前必查 CHANGELOG+git tag 台账
- 验收声明:提问作答链路已按 openapi.json 契约对齐并通过端点实测;**真实 AskUserQuestion 端到端验收待平台额度恢复后首问复验**(当前 403 限流中)

## [0.4.1] - 2026-07-20

### Added

- **安全探针飞书告警**(monitor/security-probe.sh):nginx access.log 偏移量增量分析,5 分钟窗口内同 IP 登录 401 ≥10 次(爆破)/ 403 ≥20 次(白名单试探)/ 429 ≥5 次(限流)即告警,1 小时冷却;首跑只记偏移不分析历史;launchd 常驻。零网关代码改动,任何版本网关生效

## [0.4.0] - 2026-07-20

团队试点版本:多账号、机器命名空间、邀请配对、成员机自助接入。**「凭证不出机」架构(R1-A)第一切片落地。**

### Added

- **多账号(v0.4a)**:USERS_JSON 系统账号 + 邀请创建的文件用户(/data/users.json);per-user JWT(sub+role);审计 JSONL(登录/proxy 元数据/overlay/WS/邀请/机器);单 owner 密码与文件用户并存(生产回归已修)
- **机器命名空间(v0.4b)**:`/m/:machine/api/*` 与 `/m/:machine/ws`;机器级授权(JWT role + 用户表实时 machines,admin 全通);未知 404、越权 403 均进审计;默认机(m5)路径行为不变,H5 零改动
- **邀请配对(v0.4c)**:admin `POST /invites` 发一次性链接(24h)→ H5 `#/invite/:token` 认领页设密码 → 建 member 账号并自动登录;登录页支持用户名;邀请可列表(admin)
- **成员机自助接入(v0.4c2)**:
  - `POST /machines/register` 自助注册(端口池 58700+,幂等,授权即时绑定 owner_user)
  - 服务器 `tunnel` 受限账号(nologin + authorized_keys 逐项禁用 + permit 钉端口,`POST /machines/:id/pubkey` 自助登记)
  - **`agent/local-adapter.js` 本地注入层**:成员机 127.0.0.1:58628,入站 machine_token、出站换本机 kimi token(运行时读 `~/.kimi-code/server.token`,支持轮换)——**kimi token 永不出机**
  - `web/agent-install.sh` 一键安装(登录→密钥→注册→adapter→隧道→自验),经 `/agent/local-adapter.js` 在线获取
- **E2E 验证全链**:注册(e2emac→58700)→ 受限账号(shell 拒绝/转发受限)→ adapter(无 token 401/有 token 200)→ 隧道 → 成员读到真实会话;单测 users/machines/invites 共 18 条全绿

### Fixed(过程中实抓)

- JWT 无 machines 字段导致授权 500(改用户表实时查询);文件用户创建后 owner 单密码 401(语义修复+回归测试);compose 旧 builder 缓存静默致容器未更新;compose 项目名冲突双容器抢 8080;authorized_keys 单文件 bind mount 不可 rename(改就地写);OpenSSH 8.9 `restrict` 无条件禁 -R(改显式 permit+逐项禁用)
- D-14 部署防线、D-15 成员机接入架构,均记入 docs/decisions.md

## [0.3.3] - 2026-07-20

### Fixed

- **会话视图冻结(owner 真机反馈)**:消息渲染改为逐条 try/catch,坏消息降级为错误卡,不再因单条消息异常冻结整个视图(「最后内容停在工具结果 9:46」类问题根修)
- **新鲜度兜底网**:聊天页每 20s 无条件强刷消息(原仅 WS 断开才轮询),WS 订阅丢失/事件丢失可自愈

### Added

- **真值对账机制** `tests/parity-check.sh`(owner 钦定):逐会话核对 列表 busy vs snapshot.in_flight_turn、网关可见最新消息 vs 上游直连;首跑 11 会话 0 不一致,纳入验收流程
- **网关多账号底座(v0.4a)**:USERS_JSON 多账号(scrypt+role+machines)+ per-user JWT(含 role)+ 审计日志 JSONL(登录/proxy 元数据/overlay/WS,按天轮转);未配置 USERS_JSON 时向后兼容单 owner 模式;users 单测 6 条

## [0.3.2] - 2026-07-20

### Added

- **生产健康探针飞书告警**(monitor/):healthz 每 2 分钟一探(要求 ok 且上游可达),连续 3 次失败才告警(防 Clash 重启抖动误报)、恢复自动报喜、30 分钟告警冷却;launchd 常驻;手动测试 `PROBE_URL=http://127.0.0.1:59999 ./monitor/health-probe.sh`
- DEPLOY.md 补「监控告警」节;ROADMAP 勾销该项

## [0.3.1] - 2026-07-20

正式/测试双环境,改动不再直接冲击正式版。(注:v0.2.x/v0.3.0 由另一代理线开发,条目见其提交记录)

### Added

- **测试版环境**:https://test.your.domain —— 独立 nginx vhost、独立容器(`kimi-remote-test-gateway-1`)、独立端口(8081)、独立 JWT secret;与正式版共享 Mac 上游隧道(decisions D-11)
- `deploy/deploy.sh [prod|test] [--init]` 双通道部署;nginx 模板拆分为 `nginx-prod.conf` / `nginx-test.conf`
- 标准迭代流程(先 test 冒烟 → tag → 再 prod 冒烟)写入 docs/DEPLOY.md
- ROADMAP 新增:额度/故障感知(额度耗尽时不再假「运行中」,v0.3 候选)

## [0.1.1] - 2026-07-19

修复 owner 真机反馈:手机端登录后一直连接错误、会话不显示。

### Fixed

- **隧道闪断(阻断级,三层根因)**:①本机 Clash `global` 模式忽略 GEOIP CN 直连规则,SSH 隧道被甩上代理节点被空闲回收(修复:切 rule 模式);②Clash 核心重启(切配置/节点/服务化)无差别杀连接(对策:快速重连,不可杜绝);③ssh 客户端被杀后服务器侧转发监听残留成僵尸,新隧道 ExitOnForwardFailure 死循环(修复:tunnel.sh 改自愈循环,失败先 `fuser -k` 清残留再重连;kill -9 混沌测试 25s 恢复)
- **H5 韧性**:api() 遇到 502/网络错误自动重试一次(1.2s),抹平核心重启造成的秒级抖动
- DEPLOY.md 排障表补充「隧道闪断」排查路径(日志特征 + 源 IP 鉴别)

### Added

- **单元测试套件**(`tests/run-unit.sh`,node:test 零新依赖):
  - `gateway/test/allowlist.test.js`:白名单逐规则断言(放行/拒绝/terminals 排除/方法约束/路径规整)
  - `gateway/test/auth.test.js`:scrypt 校验、HS256 JWT(签发/篡改/过期/畸形)、cookie、登录限流
  - `gateway/test/ws.test.js`:close 码清洗(1006 崩溃回归)、terminal_*/watch_fs_* 帧过滤
  - `tests/md.test.js`:md.js 渲染(数字防腐蚀回归、行内码、XSS 转义、危险链接、代码块/表格/列表)
- 真外网 E2E 实践:从 ecs-tokyo 经公网跑 `tests/smoke.sh`(模拟手机路径),11/11 通过

### Changed

- 初始访问密码按 owner 要求更换(轮换流程见 docs/SECURITY.md);飞书送达格式改为「密码单独一条纯文本」便于长按复制

## [0.1.0] - 2026-07-19

首个可用版本:手机远程控制本机 Kimi Code 全部会话。

### Added

- **gateway**(Node 20 + express + ws,Docker 部署):
  - 密码登录:scrypt 校验、JWT httpOnly cookie(12h)、同 IP 10 分钟 5 次限流
  - 显式转发白名单(sessions/files/fs/models/workspaces/tools/meta 放行;shutdown/terminals/gui/oauth/config/providers/mcp/debug/v2 拒绝)
  - REST 流式代理:零缓冲穿透,支持不限大小 multipart 上传
  - WebSocket 桥:cookie 鉴权、双向 pipe、过滤 terminal_*/watch_fs_* 帧
  - `GET /healthz` 含上游(Mac)可达性
- **web**(vanilla H5,无构建):
  - 登录页 / 会话列表页(busy·待审批·归档徽标,新建会话弹层)/ 聊天页
  - markdown 渲染、流式增量输出、tool_use/tool_result/thinking 折叠卡
  - 多文件上传(图片 base64 直发,其他经 files API),单文件不限大小,进度条
  - `/` 指令面板:客户端指令(/new /sessions /model /permission /plan /clear /help)+ 会话 skills 透传
  - approvals / questions 实时卡片处理
  - WS 断线指数退避重连;「Mac 离线」提示;PWA manifest;iOS safe-area
- **agent**(Mac):`tunnel.sh` + launchd plist,kimi server 保活 + SSH 反向隧道自动重连
- **deploy**:nginx vhost(443 + WS + 零缓冲 + client_max_body_size 0)、deploy.sh(rsync + compose 重建)、dns-upsert-record.py(阿里云云解析幂等 upsert)
- **tests**:smoke.sh 端到端冒烟(登录/白名单/建会话/prompt 回复/8MB 上传/归档)
- **docs**:ARCHITECTURE / API / DEPLOY / SECURITY / ROADMAP / decisions + README + AGENTS.md

### 部署

- 生产:https://your.domain

[0.1.0]: https://your.domain

## [ce-sync 2026-07-21]

### Added
- 同步主线今日版本:Z Code 接管(zcodeTakeover,CLI 配置破解)、账号卡额度全景(accounts-probe.js:Codex/GLM/MiniMax 实测额度)、视口锚定根修、「展开+一键复制」优化轮、视觉走查 11 步套件
- docs/CLEAN-CLAUDE-SERVER.md:干净服务器部署真 Claude Code 并接入机群 runbook
### Security
- 脱敏复扫清零:内部系统名/人名/域名/网段全部中性化(example.com 规约)
