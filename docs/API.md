# API — 网关对外接口

网关同源托管 H5,对浏览器只暴露以下接口。除 `/login`、`/logout`、`/healthz` 与静态文件外,一切请求需要 JWT cookie(`kr_token`,httpOnly,12h)。

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/login` | body `{password}` → 204 + Set-Cookie;401 密码错;429 限流(同 IP 10min 5 次) |
| POST | `/logout` | 清 cookie → 204 |
| GET | `/healthz` | `{ok:true, upstream:bool}`(upstream=false 表示 Mac 隧道断开) |

## 转发白名单(`/api/*`,转发到 Mac kimi server)

返回信封与上游一致:`{code:0, msg, data, request_id}`。白名单之外一律 `403 {code:1,msg:"blocked by gateway allowlist"}`。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/meta` `/api/v1/healthz` | 上游版本/能力/存活 |
| GET | `/api/v1/models` 及 `/models/*` | 模型列表 |
| GET | `/api/v1/tools` | 工具清单 |
| GET | `/api/v1/fs:browse?path=` `/api/v1/fs:home` | Mac 文件浏览(新建会话选 cwd) |
| GET | `/api/v1/workspaces` `/{id}` `/{id}/skills` | 工作区 |
| * | `/api/v1/sessions` 及全部子路径(**排除 `/terminals` 段**) | 会话 CRUD、messages、prompts(`:steer`)、approvals、questions、skills、tasks、status、snapshot、warnings、goal、`:archive`、export |
| POST | `/api/v1/files` | 上传(multipart field `file`;可选 `name`、`expires_in_sec`)→ `data.file_id` |
| GET/DELETE | `/api/v1/files/{file_id}` | 取/删已上传文件 |

**显式拒绝**:`/api/v1/shutdown`、`/api/v1/gui/*`、`/api/v1/oauth/*`、`/api/v1/config`、`/api/v1/providers*`、`/api/v1/mcp/*`、`/api/v1/debug/*`、`/api/v1/auth`、`/api/v1/connections`、`/api/v2/*`、根路径。新增放行 = 改 `allowlist.js` + decisions.md 记一条。

## WebSocket

- 端点:`GET /ws`(upgrade;cookie 鉴权,失败 401 断连)
- 协议与上游 `/api/v1/ws` 完全一致(JSON 帧;`client_hello`/`subscribe`/`unsubscribe`/`ping` → `server_hello`/`*_ack`/`session_event`/`error`/`resync_required`/`pong`),详见上游 `asyncapi.json`
- 网关过滤:client→server 帧含 `"type":"terminal_` 或 `"type":"watch_fs_` 即丢弃,并回 `{type:"error",...}` 说明
- 游标:`session_event` 带 `seq`/`epoch`;断线重连后在 `subscribe.payload.cursors` 带上最后游标;收到 `resync_required` 必须 `GET messages` 全量对齐

## 常用上游契约速查(实测为准)

- 建会话:`POST /api/v1/sessions` `{title?, metadata:{cwd}, agent_config?{model,permission_mode,plan_mode,...}}` → `data.id`(`session_...`)
- 列会话:`GET /api/v1/sessions?page_size=50&include_archive=0` → `data.items[]`(`id/title/busy/archived/pending_interaction/message_count/updated_at/...`)+ `has_more`
- 发 prompt:`POST /api/v1/sessions/{id}/prompts` `{content:[...], permission_mode?}` → `data.prompt_id`
  - content block:`{type:"text",text}` / `{type:"image",source:{kind:"base64",media_type,data}}` / `{type:"file",file_id,name,media_type,size}`
- 审批:`GET .../approvals?status=pending`(**必须带 `?status=pending`,裸调返回 40001**,2026-07-20 实测)→ `items[{approval_id,tool_name,...}]`;`POST .../approvals/{approval_id}` `{decision:"approved"|"rejected"|"cancelled", feedback?}`
- 提问:`GET .../questions?status=pending`(**同样必须带 status**)→ `items[{question_id, questions:[{id,question,header,body,options:[{id,label,description}],multi_select,allow_other}]}]`(一次调用最多 4 个子问题);作答:`POST .../questions/{question_id}` `{answers:{<子问题id>:{kind:"single",option_id}|{kind:"multi",option_ids}|{kind:"other",text}}}`
- 权威队列:`GET .../prompts` → `{active:{prompt_id,status,content}|null, queued:[{prompt_id,status,content,created_at?}]}`(2026-07-20 实测,active/queued 同构);插队引导:`POST .../prompts:steer` `{prompt_ids:[active.prompt_id], content:[...]}`;取消排队:`POST .../prompts/{prompt_id}`(空 body)
- 历史:`GET .../messages?page_size=100&before_id=` → `items[]`
