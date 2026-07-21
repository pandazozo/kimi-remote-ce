# 回归用例(Bug Regressions)

> 机制(owner 2026-07-20 钦定):**每一个 bug 修复必须配一个可执行的回归用例**。用例即文档——记录现象、根因、复现路径、断言。全量可跑(`tests/run-all.sh`),任何项目可复用此结构(见 `~/.kimi-code/skills/bug-regression-mechanism/`)。

## 收录约定

- 命名:`R<三位序号>-<slug>.sh`(如 `R001-questions-status-pending.sh`),序号递增不重用
- 每个用例必须:①头部注释写清 现象/根因/出处(日期+commit)②可独立执行 ③退出码 0=通过
- 环境变量:真实端点类用例读 `BASE`(必填)、`PASSWORD`、`TOKEN`(上游);纯逻辑类不依赖环境
- 不写脆弱断言(依赖具体会话标题/消息内容的,用结构断言代替)

## 用例索引

| # | 用例 | 覆盖的 bug | 类型 |
|---|---|---|---|
| R001 | R001-questions-status-pending.sh | questions/approvals 裸调 40001 致卡片永不渲染(v0.4.2) | 端点契约 |
| R002 | R002-overlay-undefined-immune.sh | 置顶写坏标题:String(undefined) 落库(v0.4.3) | 纯逻辑 |
| R003 | R003-pin-preserves-title.sh | 置顶/取消置顶标题必须保留(v0.4.3) | 端点契约 |
| R004 | R004-steer-queue-semantics.sh | ⚡插队传 active id 报 40402;正确语义=steer 排队项自身 id(v0.4.6) | 端点契约 |
| R005 | R005-render-freeze-containment.sh | 单条坏消息冻结整个视图(v0.3.3,逐条 try/catch) | 纯逻辑 |
| R006 | R006-owner-fileusers-login.sh | 有文件用户后 owner 单密码 401(v0.4.0) | 纯逻辑(单测已含,此处做端到端复核) |
| R007 | R007-earlier-pagination.sh | 「加载更早」不出现/点了没反应:quiet 刷新冲掉已翻页消息;守 before_id 分页契约(2026-07-20) | 端点契约(本机 kimi server,无环境时 SKIP) |
| R008 | R008-injection-origin-classify.js | 系统注入显示成用户气泡:改用 metadata.origin.kind 判定(2026-07-20) | 纯逻辑(vm 沙箱加载 app.js 真函数) |
| R009 | R009-assistant-tail-rerender.js | 结论文本不显示:server 原地更新 assistant 消息,前端 keyed 渲染不 patch(2026-07-20) | 纯逻辑(签名/渲染次序/合并语义) |

| R010 | R010-burst-prompts-no-400.sh | 连发 prompt 间歇 400:Connection 逐跳头毒化网关连接池(2026-07-21) | 端点契约 |
| R011 | R011-large-attachments-file-ref.sh | 两张截图必败:base64 内联撞 kimi prompts 1MB bodyLimit 50001(2026-07-21) | 端点契约 |
| R012 | R012-watchdog-no-residue.sh | 看门狗探针刷屏:空 body+JSON content-type 归档全灭(2026-07-21) | 本机探针卫生 |
| R013 | R013-fresh-session-first-prompt-executes.sh | 新建会话发指令不执行:v2 惰性执行+订阅无重试+网关绕开修复层(2026-07-21「诊断」) | 端点契约 |

## 手工验证步骤(纯前端交互,无法脚本化的部分)

以下三项在**测试版**(test.kimi.pengpengco.com)或本机验证后才能在正式版关闭:

- **R007 加载更早(交互半)**:打开一个消息 >50 条的 busy 会话 → 上滑到顶 → ①自动触发或点「加载更早消息」→ 更早消息出现且**视口不跳**(锚定在原消息)②等待 20s+(quiet 轮询/WS 事件发生后)**旧消息不被冲掉** ③继续上滑可再翻页,到最早后按钮消失。
- **R008 系统注入(目视)**:同一会话里找 todo_list_reminder / 任务通知(`<notification>`)/ 交接备忘 消息 → 全部显示为「💉 …(非我本人输入)」折叠条,**不出现蓝色用户气泡**;菜单「只看我的输入」里也不含这些条目。
- **R009 结论文本(目视)**:开一个会跑工具的会话发指令,turn 结束后(状态转「空闲」)→ 最后一条助手消息的**结论文本在工具卡之后显示**,无需手动重进会话;运行中流式气泡在结束后不残留重复内容。

## 新增用例模板

```bash
#!/bin/bash
# R<seq>-<slug>
# 现象:<用户看到的现象一句话>
# 根因:<技术根因一句话>
# 出处:<日期 commit/版本>
set -uo pipefail
BASE="${BASE:?need BASE}"
# ... 断言;失败: echo "FAIL: 原因" >&2; exit 1
echo "R<seq> OK"
```

## 提交审查清单(每次 bug 修复)

- [ ] 有对应 R 用例(新 bug 新建,旧 bug 更新)
- [ ] `tests/run-all.sh` 全绿
- [ ] 用例头部注释完整(现象/根因/出处)
- [ ] CHANGELOG 记了该修复
