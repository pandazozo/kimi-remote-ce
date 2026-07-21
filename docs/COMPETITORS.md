# COMPETITORS — 竞品监控清单(持续对标)

> 目的:持续参考最优秀产品团队的远程控制体验,喂养 kimi-remote 迭代与 acceptance-walkthrough 维度库。
> 维护:每周一自动走查(cron);新竞品发现随时增补。对标维度:状态可见性/操作回执/排队与引导/审批模型/移动端/配对与安全。

## 直接对标(手机远程控制 coding agent)

| 产品 | 远程形态 | 本机状态 | 重点监控点 |
|---|---|---|---|
| **ChatGPT(Codex)** | App 内云任务 + 手机授权绑定电脑([绑定教程](https://agent.csdn.net/6a24bc94662f9a54cb7ad485.html)) | ✅ ChatGPT.app / Codex.app / codex CLI 0.x | App 任务状态呈现、授权配对流、云端与本地接力 |
| **ZCode(智谱)** | 桌面端弹 QR → 手机 H5 瘦控制面([Remote Control 文档](https://zcode.z.ai/en/docs/remote-control)) | ✅ ZCode.app(已装) | QR 配对、审批一等公民、权限五档、工具摘要行、上下文环(详见 2026-07-19 调研) |
| **Claude Code** | CLI + claude.ai 网页版接力 | ✅ claude CLI 已装;**账号待 owner 恢复后激活** | 终端→网页的会话接力、权限交互 |
| **腾讯 CodeBuddy / WorkBuddy** | IDE 插件 + 微信助理远程([分析](https://www.cnblogs.com/informatics/p/19722426)) | 未装(插件进 IDE) | IM 内嵌交互、任务卡片、国内 IM 生态打法 |
| **Gemini CLI** | 开源 CLI,社区有 web 封装 | ✅ gemini CLI 0.51.0(本次装) | 谷歌开源节奏、checkpoint/恢复交互 |
| **opencode** | 开源,TUI + `opencode serve` Web 模式 | ✅ opencode 1.18.3(本次装) | **开源可抄**:serve 协议、Web UI 交互、多 agent 抽象 |
| **open-im**(桥) | 开源 IM 桥:微信/飞书/钉钉 ↔ Claude Code/Codex([repo](https://github.com/wu529778790/open-im)) | 未装 | IM 命令体系、session 共享、7 平台桥接 |
| **cursorclaw** | 开源 IM 远控 Cursor([repo](https://github.com/keunsy/cursorclaw)) | 未装 | 多工作区路由、飞书/钉钉/企微交互 |
| **Cursor(Background Agents)** | 云端后台 agent + PR 流 | 未装(商业) | 云端任务卡、diff/PR 审阅流 |

## 监控动作(每周 cron)

1. 上面各产品的 release notes / changelog / 官方文档变更(远程控制相关段落)
2. opencode / open-im / cursorclaw 的 GitHub release(开源,可抄协议设计)
3. 发现值得借鉴的交互模式 → 写入本文件「借鉴池」→ 评估后进 docs/ROADMAP.md → 同时回填 acceptance-walkthrough 维度库

## 借鉴池(已吸收)

- ZCode:审批挂起锁 composer、权限档位、工具一行摘要(v0.2 已吸收前两者)
- Kimi Web 官方:Enter=queue / Ctrl+S=inject、状态行、停止键(v0.2 已吸收)
- ZCode:一次性 QR 配对 + 单端在线(v0.3 团队版采用,见 TEAM-ROADMAP)

## 借鉴池(待评估)

- **Codex Remote GA(2026-07-18)**:①认证版一对一 QR 配对(每手机↔每主机绑定,失活重配)——与我们 v0.4 一次性邀请链接同构,参照其「设备换绑/失活重配」语义;②DigitalOcean 插件自动 provision 远程工作区——参照做 ECS 一键装 agent 的 provisioning 流(v0.4c 安装脚本的 plugin 化);③手机审批动作(approve actions on phone)已是行业标配,我们的排队/引导/停止三键对齐无缺口
- **opencode Desktop v2(1.18.x)**:会话上下文内显示 token 与成本合计(我们已有上下文%,成本合计可扩展进信息条);每 prompt 选模型(我们 modelOverride 已同构);TUI yolo 模式(已对齐)
- **Claude Code v2.1.212**:嵌套子代理生成上限(防 agent 失控硬熔断)——fleet 治理借鉴:给我们的 notifier 速率熔断同源思想;v2.1.211 权限欺骗修复提醒我们审批链路要做参数指纹校验

## 走查日志

- **2026-07-20**:Codex Remote 正式 GA(QR 认证配对+DO 云工作区插件,最大竞品动向,已飞书通报);ZCode 移动远控已上线+GLM Coding Plan 定价;opencode Desktop v2 重构+成本合计;Claude Code 子代理上限/权限欺骗修复;行业:SpaceX $60B 收购 Anysphere(Cursor)、Copilot 转用量计费。借鉴池+3 条。
