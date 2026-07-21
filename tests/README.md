# kimi-remote 测试体系

> 机制(owner 2026-07-21 钦定):**测试要完整详细、每次出问题就增补、尽量穷尽**;
> **视觉走查必备**——很多 bug 不看渲染结果发现不了。

## 分层

| 层 | 内容 | 入口 |
|---|---|---|
| ① 单元 | 纯逻辑单测(无环境依赖) | `tests/run-unit.sh` |
| ② 回归 | **每 bug 一用例**,编号递增不重用,头注 现象/根因/出处/断言 | `tests/regressions/`(R001-R013+) |
| ③ 生产冒烟 | 登录/建会话/多轮/上传/归档 全链路 | `tests/smoke.sh` |
| ③.5 视觉走查 | Playwright 真机视口逐页 DOM 断言+截图 | `tests/visual/run-visual.sh` |
| ④ 真值对账 | H5 显示 vs 终端真值(状态/时间戳对齐) | `tests/parity-check.sh` |

全量:`tests/run-all.sh --full`(需 BASE/PASSWORD/TOKEN;视觉层需 playwright,缺则 SKIP)

## 增补纪律

1. **任何线上 bug → 先写复现用例(红)→ 修复(绿)→ 用例入库**,编号进 `tests/regressions/README.md` 索引
2. 视觉/交互类 bug(渲染错位、按钮失灵、视口跳动)→ 同步在 `tests/visual/walkthrough.js` 加一步走查
3. 发版门禁:deploy 后必跑 smoke;大版本前跑 `--full`
4. 探针/测试自身不得污染环境(看 R012:探针零残留)

## 当前覆盖地图(2026-07-21)

- 协议/契约:R001(questions 40001)、R003(置顶保标题)、R004(steer 语义)、R007(before_id 分页)、R010(间歇 400)、R011(附件 1MB)、R013(新会话惰性执行)
- 纯逻辑:R002(undefined 免疫)、R005(渲染冻结遏制)、R006(单密码登录)、R008(注入分类)、R009(尾部重渲染)
- 卫生:R012(看门狗零残留)
- 视觉走查:9 步(登录/列表/详情/加载更早/注入折叠/输入区/机群/他源详情/收发)
