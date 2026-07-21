# BENCHMARK:OpenAI Codex Remote 拆解与 kimi-remote 取长补短(2026-07-20)

> 任务:拆解 OpenAI Codex 官方远程体系(desktop app + cloud + ChatGPT 手机遥控),对照 kimi-remote 取长补短。
> 方法:本机实测 `codex cloud` CLI(0.144.6)+ 全网调研(GA 功能线)+ SOL 卓越评审结论交叉验证。

## 1. Codex Remote 是什么(2026 GA 版)

| 组件 | 事实 |
|---|---|
| Desktop app | Mac 起,2026-05 起 Windows;多并行 agent、项目线程、skills 库、in-app browser、memory |
| Codex cloud | 隔离沙箱并行跑任务,产出 PR/diff;GitHub 直接建分支/提交/PR |
| **ChatGPT 手机遥控**(对标我们的 H5) | iOS/Android 监控+管理 paired Mac 上的任务:审批、切模型、看输出;**文件与凭证不出主机**,只传 prompt 与产物 |
| CLI cloud | `codex cloud exec/status/list/diff/apply`(本机实测可用,官方合规通道) |
| 其他 | background computer use(看屏点击)、Remote SSH devboxes、Hooks(密钥扫描/代码校验)、PR review、Profile 用量统计 |
| 模型 | GPT-5.6 家族,默认 gpt-5.6-sol(=我们评审用的那台 SOL) |
| 收费 | ChatGPT Plus/Pro/Enterprise 订阅捆绑 |

## 2. 它强在哪(该吸的)

1. **产物导向的任务模型**:任务 → diff/PR,人审后 apply/合并。不是"看 agent 聊天",而是"收一个可评审的产物"。写代码场景下信任成本最低
2. **审批推送化**:审批直接推到手机 App 可操作,不在任务列表里等你翻
3. **并行一等公民**:多容器并行 + queue-and-forget,人只处理排队回来的结果
4. **Hooks**:确定性护栏(扫描密钥/校验代码),不依赖模型自觉
5. **官方 CLI 数据通道**(`codex cloud list/exec/diff/apply --json`):合规、稳定、机器可读——我们的 E 源接入口(见 §5)
6. **凭证不出机**的安全模型(与我们一致,说明路线对了)
7. **Remote SSH devboxes**:agent 直接操作远程机器(对应我们的机队多设备)

## 3. 我们强在哪(该守的)

1. **多 harness 多模型联邦**:它被锁在 OpenAI 模型内;我们已五源(kimi/codex/claude/zcode/workbuddy)+ 任意模型(GLM/MiniMax/MiMo/SOL)——这是代差级差异
2. **数据边界**:它的 cloud 任务代码要上 OpenAI 服务器;我们全链路自有设备,网关只做白名单代理(D-11)
3. **零订阅依赖**:它的遥控要 Plus/Pro;我们自建自管
4. **会话连续性**:我们保留完整会话历史/审批/questions 交互;codex cloud 偏任务一次性
5. **飞书原生工作流**:审批/汇报/告警进飞书,契合 owner 的手机主入口
6. **审批粒度**:我们是 tool-call 级审批,它是任务级

## 4. 取长补短清单(按 ROI 排,落到版本)

| # | 动作 | 来源 | 落点 |
|---|---|---|---|
| A1 | **codex cloud 官方 CLI 接入联邦第 6 源**:`codex cloud list --json` 读任务列表进 H5;`diff` 看产物;`apply` 写路径(审批门控) | 它的 CLI 通道 | v0.5/v0.6;**E 源已覆盖大部分需求,D-16 的 B 层(网页快照,ToS 灰)大概率不必签收** |
| A2 | **产物卡**:会话详情加「产物」视图(本轮改动的文件 diff 摘要),向"收产物"而非"看流水"演进 | 它的任务模型 | v0.6 |
| A3 | **审批 push 化**:PWA Web Push,审批直达手机通知层(ROADMAP 已有,升优先级) | 它的审批推送 | v0.5 尾/v0.6 |
| A4 | **机群队列视图**:fleet board 一行一任务一状态(对齐 SOL 仪表盘 + 它的 queue 模型) | 两者 | v0.5 |
| A5 | **蜂群 worktree 隔离**:多 agent 并行在同一 Mac 时用 git worktree 互不干扰(对应它的容器隔离) | 它的沙箱 | 蜂群调度 |
| A6 | **Hooks 护栏**:网关侧确定性检查(出站密钥扫描、危险命令正则),不依赖模型自觉 | 它的 Hooks | gateway 迭代 |
| A7 | **用量可见**:H5 显示各 harness 额度/用量(session.usage + mmx quota 等) | 它的 Profile | v0.5 尾 |

## 5. 不吸的(甄别)

- cloud 沙箱托管代码(违背数据边界)
- 订阅捆绑模式(我们零依赖)
- computer-use 看屏控制(与我们代理治理边界冲突,且内部已有专门规约)

## 6. 结论一句话

Codex Remote 验证了「手机遥控本机 agent」的产品形态和我们的路线,它的**产物模型与审批推送**值得照抄级吸收;但**多模型联邦 + 数据不出私域**是我们的护城河,继续按 SOL 评审的「仪表盘 + 人话字典 + 接管」卓越标准推进,不做它的平替,做它做不到的联邦。
