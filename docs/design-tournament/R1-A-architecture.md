# R1-A · 多设备 × 多 harness 统一接入层 — 系统架构

> 设计锦标赛 第 1 轮 · A 路(系统架构)。监控大盘 UI、通知协议不在本路范围。
> Date: 2026-07-20 · Owner: 王佐团队 · Status: design-ready
> 输入材料:kimi-remote ARCHITECTURE/TEAM-ROADMAP、swarm-gateway HARNESS-FEDERATION-PLAN-20260628、
> zaios NORTH-STAR-VISION、cc-remote-h5 源码,以及 M5 本机 harness 数据目录实测。

## 0. 结论摘要

1. **适配层**:每台设备跑一个 `adapter server`(Node 22+,loopback only),内挂六个 harness adapter,
   统一暴露五对象模型(Session/Message/Status/Approval/Attachment)+ 能力位(CapabilitySet)。
   可读且可控:kimi、claude;可读 + 受限可写:codex;只读:zcode、workbuddy(探针后可升级);
   只读快照:chatgpt。能力刻度直接复用 federation plan 的 L0–L3 conformance ladder。
2. **拓扑**:选方案 ③ 混合 —— **数据面**沿用隧道直连代理(网关零存储、零解析正文),
   **控制面**由 agent 主动注册 + 心跳上报(只带元数据与脱敏标题)。不建中心事件库。
3. **合并点**:v0.3 机器命名空间扩一格为 `/m/:machine/h/:harness/`;邀请配对协议原样复用,
   仅把安装产物从 tunnel.sh 升级为 agent(adapter+tunnel);cc-remote-h5 **合并进 kimi-remote**,
   代码以 adapter 形式迁入,原项目归档,不共存。
4. **安全**:凭证不出机 —— KIMI_TOKEN 从服务器 .env 下沉到 Mac 适配层本地注入;
   网关只验 user JWT + machine token;chatgpt 类快照在设备边缘脱敏后才允许出站。
5. **里程碑**:P1 单机五 harness 只读贯通 → P2 可控面 + 吸收 cc-remote-h5 → P3 多机多账号。
   每阶段都有可执行的验证命令,且全程保持单 owner 模式零配置迁移。

## 1. 设计前提(第一性原理)

- **P1 harness 是异构黑盒。** 唯一稳定契约是它落在磁盘与 loopback 上的事实,不是品牌。
  因此适配层由「能力发现」驱动:每个 adapter 先零副作用 probe,再按实测能力分级,
  而不是按厂商预设功能。等级词汇复用 HARNESS-FEDERATION-PLAN 的 `conformance_level`
  (L0 placeholder / L1 evidence-only / L2 task-cancel / L3 streaming-multiturn),与 zaios 文档体系对齐。
- **P2 数据与执行在边缘。** 会话正文与控制权在设备上;跨网搬运的只能是归一化后的模型。
  这既是性能决策(不重复存储)、也是安全决策(网关爆炸半径不随 harness 数增长),直接延续
  TEAM-ROADMAP D-11「网关只做路由与鉴权,不碰代码」。
- **P3 网关是会合点,不是数据库。** 手机网络间歇,断线恢复靠游标重放而非中心缓存。
  现有 WS `seq/epoch` + `resync_required` 语义已验证,全部 adapter 向它对齐,不发明新协议。
- **P4 读与控风险不对称。** 读路径几乎零风险、可全量做;写路径按实测表面逐个开。
  没有写路径的 harness 诚实降级为只读镜像 + `degraded_reason`,绝不伪造控制入口。

## 2. 适配层(harness adapter)

### 2.1 统一最小公共模型

```ts
type HarnessId = 'kimi' | 'claude' | 'codex' | 'zcode' | 'workbuddy' | 'chatgpt'

// 全局唯一会话 id = "{machine}/{harness}/{nativeId}"
interface SessionSummary {
  sid: string                 // m5/claude/019f785f-9204-...
  harness: HarnessId
  title: string               // snapshotOnly 会话此处已是脱敏结果
  cwd?: string
  status: SessionStatus
  statusConfidence: 'exact' | 'heuristic' | 'stale'   // 状态置信度,诚实暴露
  createdAt: number; updatedAt: number
  capabilities: CapabilitySet // 会话级(可与 adapter 级不同,如 codex TUI 活跃期写锁)
  conformance: 'L0' | 'L1' | 'L2' | 'L3'
  snapshotOnly: boolean
}

type SessionStatus =
  | 'idle' | 'running' | 'awaiting_approval' | 'awaiting_input'
  | 'error' | 'offline' | 'unknown'

interface Message {
  id: string; sid: string
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system'
  blocks: ContentBlock[]      // text | thinking | tool_call | tool_result | file | image
  ts: number; seq: number     // seq 在会话内单调
}

interface Approval {
  id: string; sid: string
  kind: 'permission' | 'question' | 'plan_review'
  summary: string             // 工具名 + 参数预览(截断)
  options: string[]           // adapter 提供,如 ['allow','always_allow','deny']
  state: 'pending' | 'resolved'
}

interface Attachment {
  ref: string                 // file_id 或本机 path
  inject: 'file_ref' | 'path_ref'   // kimi=file_ref;claude/codex=path_ref
  name: string; size: number
}

interface CapabilitySet {
  readSessions: boolean; readMessages: boolean; liveStatus: boolean
  send: boolean; interrupt: boolean; approval: boolean
  setMode: boolean; upload: boolean; nativePush: boolean // false=tail 模拟
}
```

### 2.2 Adapter 接口定义

```ts
interface HarnessAdapter {
  readonly id: HarnessId
  probe(): Promise<ProbeResult>            // 零副作用发现:版本/传输/能力/degraded_reason
  capabilities(): CapabilitySet            // adapter 级静态声明(probe 后可收紧)

  listSessions(opts?: { limit?: number }): Promise<SessionSummary[]>
  getMessages(sid: string, cursor?: EventCursor): Promise<{ items: Message[]; cursor: EventCursor }>
  getStatus(sid: string): Promise<{ status: SessionStatus; confidence: string }>

  // 事件流:统一输出 session_event 信封 {seq, epoch, type, payload}
  // 无原生推送的 adapter 用 tail/轮询模拟,对上层语义一致
  subscribe(sid: string, since?: EventCursor): AsyncIterable<SessionEvent>

  // 写路径:capability 未声明则方法不存在,网关与 adapter 双重拒绝
  send?(sid: string, content: ContentBlock[], opts?: SendOpts): Promise<void>
  interrupt?(sid: string): Promise<void>
  resolveApproval?(sid: string, approvalId: string, decision: string): Promise<void>
  setMode?(sid: string, mode: string): Promise<void>
  upload?(req: Readable, name: string): Promise<Attachment>
}

type EventCursor = { seq: number; epoch: string }   // epoch = adapter bootId
```

返回模型即 §2.1。错误模型统一:`{ code: 'not_found' | 'capability_denied' | 'session_locked' | 'upstream_offline' | 'degraded', msg }`。

### 2.3 可读 / 可控总览

| harness | conformance | 读 | 写 | 依据 |
|---|---|---|---|---|
| kimi | L3 | ✅ 全量 | ✅ 全双工(发消息/审批/上传/中断) | kimi server REST+WS,现有链路 |
| claude | L3 | ✅ 全量 | ✅ 全双工(SDK hot process + canUseTool 中继) | Agent SDK + jsonl,cc-remote-h5 已验证 |
| codex | L1(读)/ L2(exec 臂) | ✅ jsonl 增量 | ⚠️ 受限:`codex exec resume --json` 一次性续跑,无轮中审批 | rollout jsonl 实测;exec 模式 cc-remote-h5 已验证 |
| zcode | L1 | ✅ jsonl 增量 | ❌ 无已知写路径 | rollout jsonl + db.sqlite 实测 |
| workbuddy | L1(probe 后最高 L3) | ✅ 会话清单 + loopback 探针 | ❓ probe 决定,未验证前不开 | sessions/*.json 含 endpoint,实测确认 |
| chatgpt | L1(快照) | ⚠️ 仅人工导入快照 | ❌ 永不接管 | 无本地 API,云端为主 |
| gemini / opencode | L0 | — | — | 已装无数据,registry 登记 `needs_discovery`,不写代码 |

### 2.4 各 adapter 实现要点与缺口

**kimi(adapter 直连 REST)**
- 包装现有 kimi server API;token 由 adapter 从 `~/.kimi-remote-adapter/secrets/`(0600)读取并注入 loopback 请求,**不再放服务器 .env**(见 §5)。
- 事件流直接桥接其 WS `session_event`,seq/epoch 原生透传。零缺口。

**claude(jsonl + Agent SDK 双模)**
- 冷读:SDK `listSessions` / `getSessionMessages`(底层即 `~/.claude/projects/<cwd>/<sid>.jsonl`)。
- 热控:每个活跃会话一个 streaming-input `query()` 常驻进程,`canUseTool` → Approval 中继
  (allow / always_allow / deny);30 分钟空闲回收。整体直接迁移 cc-remote-h5 `src/chats.ts`,不重写。
- 缺口:每会话一进程有内存开销 → 活跃会话数上限(建议 8)LRU;SDK 版本漂移由 probe 的版本字段暴露。

**codex(jsonl 增量解析 + exec 臂)**
- 增量游标:按**文件**维护 `{inode, offset}`(持久化到 adapter state 目录),追加读、
  遇不完整行缓冲到下次;inode 变化或 size<offset 视为轮转,重开从头读;adapter 重启从
  持久化游标恢复,游标失效则回退读尾部 N 行并在事件流打 gap 标记。
  会话发现走 `session_index.jsonl`;`state_5.sqlite` 以 `immutable=1` 只读打开补 cwd/标题。
- 实测坑:`~/.codex/sessions/YYYY/MM/DD/` 下存在**同 UUID 前缀的多文件 fork 族**——
  游标与会话 id 必须以文件为单位,不得以 UUID 去重合并。
- 写路径降级策略:无本地可注入 API → 对**未附着 TUI** 的会话提供 `codex exec resume --json`
  一次性续跑(新消息 = 一次 exec);会话 mtime < 30s 判定 TUI 活跃 → 拒绝并返回
  `session_locked`;轮中无审批,按 cc-remote-h5 已验证的四档沙箱映射
  (默认询问→只读 / 自动接受编辑→工作区可写 / 计划→只读计划 / 完全放行→无沙箱)。
- 缺口:续跑是「新进程重放上下文」,延迟高于原生;exec 与 TUI 并发写同一 thread 的锁语义
  未定义,故只做保守互斥,不做并发写。

**zcode(jsonl 增量)**
- 复用 codex 的 `JsonlTailer` 组件(同一游标机制),实测目录 `~/.zcode/cli/rollout/`,
  **文件名实为 `model-io-sess_<uuid>.jsonl`(下划线)**;`db.sqlite` 同样 `immutable=1` 只读。
- 事件 schema 未文档化 → blocks 做 best-effort 归一,未知字段原样透传在 `raw` 里,不丢信息。
- 缺口:无写路径。ZCode 桌面有配对协议(TEAM-ROADMAP 提过),CLI 是否有 prompt 入口未探明
  → 列入 P2 探针任务,探明前只读。

**workbuddy(endpoint 探针)**
- 会话发现:`~/.workbuddy/sessions/*.json`(实测字段:`pid/sessionId/cwd/endpoint/lastHeartbeat`);
  进程存活 + heartbeat 新鲜度(阈值 60s)→ status;进程死 → offline。
- 读路径:P1 先 `workbuddy.db` 只读 + 对 endpoint 做 **GET-only 零副作用探针**(探测是否存在
  OpenAPI / 已知路由);任何 POST 类端点在沙箱会话验证前一律不碰。
- 缺口:API 表面未文档化 → conformance 封顶 L1,probe 出可验证的消息接口后逐案升级,
  升级必须过 federation plan 的「live probe before claiming compatibility」门。

**chatgpt(只读快照)**
- 本地无二进制以外的可读源 → adapter 只提供 `listSessions`/`getMessages`,
  数据源 = **人工导入**:share-link 抓取(P2,失败则手动导出粘贴)落入 adapter 本地 ingest 表。
  `snapshotOnly=true`,出站前强制过 §5.3 脱敏管线。无导入时 adapter 存在但为空,
  `degraded_reason='no_local_api'`。
- 缺口:无写路径且永不规划(云端产品,接管=逆向,违背 NFR 与账号条款风险)。

### 2.5 事件流与游标语义统一

所有 adapter 对外只讲一种协议:kimi 现有的 `session_event` 信封 + `seq/epoch` 游标 +
`resync_required`。jsonl 类 adapter 的 seq 直接取文件字节偏移(天然单调且可恢复),
epoch = adapter bootId;tail 模拟的「live」事件与 kimi 原生推送对 H5 完全同构,
**H5 断线重连逻辑零改动**。网关 WS 桥的帧过滤规则(`terminal_*`/`watch_fs_*` 丢弃)原样保留。

### 2.6 状态推导

- 有进程可问(kimi / workbuddy endpoint / claude hot process):`exact`。
- jsonl 尾推(codex / zcode):末事件时间 < N 秒 且 末事件类型非终止集 → `running`,
  否则 `idle`,一律标 `heuristic`;文件 mtime > 10min 无变化 → `stale`。
- `statusConfidence` 进模型是硬要求:状态是猜的就必须让上层知道是猜的。

## 3. 拓扑演进

### 3.1 三个候选

- **① 网关直连各机隧道,适配层跑各机**:现架构的自然延伸。每机一条 SSH -R,
  上游从 kimi server 换成 adapter server;网关 allowlist 按 `/m/:machine/h/:harness/` 路由。
  纯请求-响应,网关无任何状态。
- **② 每机 agent 上报到中心**:agent 本地归一化后推送到网关,网关建事件库/缓存,
  H5 全部读中心。控制指令经中心队列下发。
- **③ 混合**:数据面(会话正文、控制操作)= ① 的隧道直连,网关零存储;
  控制面(机器注册、能力清单、心跳、状态摘要)= ② 的上报,网关只存元数据。

### 3.2 决策矩阵

| 维度 | ① 纯隧道直连 | ② 中心上报 | ③ 混合(选定) |
|---|---|---|---|
| 交互延迟(发消息/审批) | 优:一跳,流式零缓冲已验证 | 差:控制多一跳队列/长轮询 | 优:控制面走直连 |
| 状态/清单新鲜度 | 中:需网关轮询各机 | 优:推送 | 良:30s 心跳,手机场景足够 |
| 安全(爆炸半径) | 优:网关零存储零解析 | **差:中心成正文数据库,违背 D-11,单点失陷=全部会话** | 优:中心只有元数据,标题脱敏后上报 |
| 运维成本 | 优:tunnel/launchd/allowlist 全复用 | 差:队列/缓存/回放/背压全套新设施 | 良:+1 个注册心跳端点,无新组件 |
| 离线韧性 | 差:掉线即全黑 | 优:中心缓存可离线读历史 | 中:可见「最后活跃/清单」,正文不可得 |
| 演进弹性(加机/加 harness) | 良 | 良 | 优:注册清单驱动,网关免改 |

### 3.3 选定:③ 混合

理由按第一性原理排序:
1. **安全否决项先算**:② 把会话正文中心化的收益只是「离线可读历史」,代价是网关从路由
   变成数据存储,直接违背 D-11 数据边界,且与 NORTH-STAR 第 10 条「先防污染」相悖 —— 一票否决。
2. ① 与 ③ 在交互路径上完全等价(延迟、流式一致),③ 只多了一个心跳端点,
   换来机器注册/能力清单/离线展示三样运维必需品,成本接近零。
3. ③ 的离线取舍是**有意的**:Mac 休眠时正文不可得,网关展示最后心跳与脱敏清单。
   若未来真要离线读历史,另开决策做 opt-in 的边缘加密快照缓存,不在本架构内默认开启。

目标拓扑:

```
手机 H5 ──HTTPS/WSS(JWT)──▶ 阿里云网关(opc-prod,nginx+docker)
                              ├─ 注册表:machine→tunnel 端口、能力清单、最后心跳(元数据 only)
                              ├─ allowlist 2.0:/m/:machine/h/:harness/* 按能力位放行
                              ▼ 每机一条 SSH -R(复用 tunnel.sh 自愈机制)
        ┌──────────────┬──────────────┬──────────────┐
        M5            M1             M2             ECS(东京/硅谷/杭州)
   adapter server  adapter server  ...          adapter server
   (loopback only) ├ kimi(REST)                 ├ codex(jsonl+exec)
   ├ kimi(L3)      ├ claude(SDK)               └ …按各机实际安装 probe
   ├ claude(L3)    └ …
   ├ codex/zcode/workbuddy(L1+)
   └ chatgpt(快照)
   每机 agent = adapter server + tunnel + 注册心跳(launchd 保活,一个 plist)
```

## 4. 与 kimi-remote 的合并点

### 4.1 机器命名空间 → harness 命名空间

v0.3 规划的 `/m/:machine/` 前缀扩一格:**`/m/:machine/h/:harness/api/...`**。
adapter server 在每机占一个 loopback 端口(替代 kimi server 成为隧道唯一上游),
内部按 `h/:harness` 分发到各 adapter。隧道每机仍只有一条,端口映射逻辑不变。
allowlist 2.0 从「静态路径集」升级为「路径模板 × 能力位」:chatgpt 命名空间下
所有非 GET 直接 403;codex 下无 approvals 路径;纵深防御,adapter 自身也再拒一次。
**兼容**:单 owner 单机场景,`kimi` 为默认 harness,旧 H5 路由平滑迁移,零配置。

### 4.2 邀请配对协议复用

v0.3 的一次性邀请链接(24h)→ 设密码 → 一行 curl 装 agent,流程**原样不动**,
变的只是安装产物:从「tunnel.sh + launchd plist」升级为「adapter server + tunnel + plist」
(单二进制/单 npm 包,仍一行 curl)。agent 首次上线即向网关注册:`MACHINE_ID` +
machine token + **probe 出的 harness 清单与能力位**;admin 在网关即刻看到该机暴露了什么。
machine token 覆盖该机全部 harness —— 各 harness 自己的凭证(KIMI_TOKEN、claude OAuth、
codex auth.json)**不参与配对、永不出机**(见 §5)。

### 4.3 cc-remote-h5:合并,不共存(明确建议)

事实:cc-remote-h5 的 claude 会话引擎(`src/chats.ts`)与 codex exec 臂
(`src/codex-worker.ts`,含 SSH 远端 worker、四档沙箱映射)正是本架构 claude/codex
adapter 需要的全部核心;但它的交付面(局域网绑定、URL query token、无 allowlist、SSE)
**达不到公网网关的安全基线,且永远不该被直接暴露**。kimi-remote 恰好相反:交付面已硬化,
缺 harness 覆盖面。两者共存 = 两套认证、两个 H5、永久漂移,没有第三样结果。

合并动作:
1. `chats.ts` → `adapters/claude`(去 HTTP 层,实现 §2.2 接口;SSE 积压重放逻辑改为
   session_event 游标重放);
2. `codex-worker.ts` → `adapters/codex` 的 exec 臂 + ECS 场景的 SSH-sourced 适配参考;
3. H5 侧有价值的交互(权限卡、四档模式、附件直传)按能力位驱动并入 kimi-remote `web/`;
4. cc-remote-h5 仓库归档,README 标注 deprecated 与迁移去向(保留作 LAN 调试工具,不再演进)。

### 4.4 ECS 设备

统一装 agent(与 Mac 同一安装脚本,systemd 替代 launchd)。ad-hoc 场景保留
codex-worker 已验证的 SSH-sourced 模式作fallback,但它是例外路径,不进主拓扑。

## 5. 安全边界

### 5.1 分层凭证

| 层 | 持有什么 | 不持有什么 | 形式 |
|---|---|---|---|
| 浏览器/H5 | 仅 user JWT(httpOnly cookie,12h) | machine token、一切 harness 凭证 | 现状沿用 |
| 网关 | user 表(scrypt hash)、JWT secret、machine token 表(可吊销)、审计日志(元数据) | **不再持有 KIMI_TOKEN**;永不落会话正文 | deploy/.env 0600;审计按天轮转 |
| 隧道 | SSH 既有机房密钥 + 每机 machine token(应用层鉴权) | harness 凭证 | token 32B 随机,可轮换 |
| adapter(设备上) | 各 harness 凭证**就地使用**:KIMI_TOKEN 读自本机 0600 文件注入 loopback;claude/codex 用各自原生登录态(SDK/CLI 自己读 `~/.claude`、`~/.codex/auth.json`),adapter 不复制、不记录 | 用户密码、其他机器的 token | adapter 绑 127.0.0.1,仅隧道可达;以普通用户身份跑,禁 root |
| harness 进程 | 各自原生凭证 | — | 不动 |

原则一句话:**凭证不出机,适配层本地注入**。这把现状里最大的单点(服务器 .env 里的
KIMI_TOKEN)撤掉,网关失陷的损失上限从「控制 Mac」降回「路由层被拒」。

### 5.2 最小权限清单

- 网关:allowlist 2.0 按能力位放行;只读 harness 的写路径在网关与 adapter 双重 403。
- adapter:jsonl/sqlite 全部只读打开(sqlite `immutable=1`);上传文件只落专用目录
  (沿用 cc-remote-h5 上传目录隔离与路径校验模式);exec 臂默认只读沙箱,升档需显式 mode。
- 多账号(P3):member 默认只见自己机器(D-11),跨机访问尝试全部进审计日志。

### 5.3 chatgpt 类只读快照的脱敏

脱敏发生在**设备边缘、出站之前**,网关与浏览器只收到脱敏结果:
1. **标题脱敏**:`snapshotOnly` 会话标题默认替换为派生标签(如 `gpt·a4f2`,取 nativeId 短哈希);
   查看原标题需逐会话显式 reveal,reveal 动作进审计日志;member 角色对 snapshotOnly
   会话默认不可见,owner 显式分享才开。
2. **正文脱敏**:出站前过 secret 扫描规则(AKIA/sk-/BEGIN .*PRIVATE KEY/token 形态),
   命中即遮蔽并在元数据记 redaction 计数;规则集与 federation plan 的 redaction policy 同源维护。
3. 快照数据只存设备本地 ingest 表,网关不缓存;删除即真删。

## 6. 里程碑

### P1 — 单机多 harness 只读联邦(M5,2 周内可完成)

范围:adapter server v0(§2.2 接口 + SessionSummary schema)+ 五个读路径 adapter
(kimi REST 包装、claude SDK 冷读、codex/zcode JsonlTailer、workbuddy 会话发现+只读探针)
+ 网关 `/m/:machine/h/:harness/` 路由与 allowlist 2.0(GET-only)+ H5 按 机器→harness 分组列表。
**验证**:
- 带 JWT 经公网网关 `curl /m/m5/h/{kimi,claude,codex,zcode,workbuddy}/api/v1/sessions`
  五路均返回符合 schema 的清单(schema 校验进单测);
- codex tailer 单测:向 fixture jsonl 追加行 → 事件按序出现且游标正确;杀进程重启 →
  从游标恢复零重复;inode 轮换 fixture → 触发重扫不丢行;
- 无 JWT / 写方法打只读 harness → 401/403(网关层测试)。

### P2 — 可控面 + 吸收 cc-remote-h5

范围:claude 写路径(chats.ts 迁入,canUseTool→Approval 中继、interrupt、四档 mode);
codex exec 臂(resume --json + 沙箱映射 + TUI 活跃互斥);kimi 写路径接入新命名空间;
chatgpt share-link 快照导入 + §5.3 脱敏管线;zcode/workbuddy 写路径探针(探明才做,不承诺);
H5 统一会话视图(UI 细节归另一路,本路只交付能力位驱动的接口契约)。
**验证**:
- 手机端端到端:向 claude 会话发消息 → 收到权限请求 → 点允许 → 执行继续 → interrupt 生效;
- codex exec 任务:只读档发起 → 确认无写副作用;TUI 活跃会话发消息 → 返回 `session_locked`;
- 脱敏单测:含假密钥/敏感标题的 fixture 出站后无原文;grep 服务器部署配置确认无 KIMI_TOKEN;
- cc-remote-h5 仓库打 deprecated 标记,其三个功能场景在新链路全数复现。

### P3 — 多机多账号(即 v0.3 范围扩展)

范围:USERS_JSON 多账号 + per-user JWT + 审计;machine token 注册 + 心跳(30s)+ 元数据注册表;
邀请配对全链路(安装产物=adapter+tunnel);M1/M2/至少一台 ECS 上线;member 权限隔离。
**验证**:
- 非 owner 成员走邀请链接 → 一行 curl 装 agent → 手机看到自己机器的会话清单;
  访问 owner 机器路径 → 403 且审计有记录;
- 休眠 Mac → 30s 内 H5 显示离线+最后心跳;唤醒 → launchd 自愈重连,会话可继续;
- 3 机 × 每机 ≥2 harness 经同一网关同屏列出;网关重启后注册表可从心跳重建(无持久化单点)。

## 7. 开放问题

1. zcode CLI 是否存在 prompt/ACP 写入口(P2 探针,探明前只读)。
2. workbuddy loopback API 表面:probe 出可验证消息接口前 conformance 封顶 L1。
3. chatgpt share-link 抓取的稳定性(Cloudflare 拦截风险)→ 保底手动导出导入。
4. 「离线可读历史」是否真有需求:有则另开决策做 opt-in 边缘加密快照缓存,默认不做。
5. gemini CLI / opencode 有真实会话数据后再登记 probe,当前保持 L0 needs_discovery。

## 8. 附:对输入材料的事实校正(本机实测)

- zcode rollout 文件名实为 `model-io-sess_<uuid>.jsonl`(下划线),非 `model-io-sess-*`。
- codex sessions 存在同 UUID 前缀的多文件 fork 族 → 游标/会话 id 必须以文件为单位。
- workbuddy 会话文件实测字段:`pid / sessionId / cwd / endpoint(http://127.0.0.1:<动态端口>) / lastHeartbeat / version`;版本字段与盘点值(5.2.6)不一致,以 probe 实测为准。
- kimi-remote 现状中 KIMI_TOKEN 存于服务器 .env 并由网关注入;本架构将其下沉到 Mac adapter(P2 完成迁移,P1 期间兼容旧路径)。
```

---
