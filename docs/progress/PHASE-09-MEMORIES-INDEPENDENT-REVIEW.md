# Phase 9 Memories 独立源码与定向验证审查

最新限定复核状态：**P2-01 CLOSED**，可以进入 Phase 9 Full Quality Gate。下方原审查结论保留历史语境；关闭证据及场景限制见末尾追加记录。

日期：2026-10-05。基线：`979d6eb063a1137387ded31330ea3a3a6cd99436`。

结论：本次没有确认新的源码级 P0/P1 阻塞。核心实现符合已批准的 Memories 日期、授权、游标和失效护栏；保留一项 P2 验证缺口，必须在阶段验收记录中明确处理。不能据此宣布 Phase 9 COMPLETE；完整 Quality Gate 尚待父任务执行。没有复审 Phase 7/8，没有修改实现或测试，也没有 commit/push、Production 或真实媒体操作。

## 审查范围与指纹

读取项目约束、Phase 9 产品要求、`PHASE-09-MEMORIES-IMPLEMENTATION-GUARDRAILS.md`、实现 handoff、实际 tracked diff 与新增源码/测试。核对 calendar/contracts、repository SQL 和事务、service/cursor、API/proxy、Memories session/UI、Viewer 变更、fixture 与实际 HTTPS 上传验收源码。

开始审查时，`.cache/phase9/final-candidate-fingerprint.json` 中 34 个候选文件、两个受保护 Web 指令文件、所有列出的证据文件 SHA-256 全部吻合。结束复核时，34 个候选文件与受保护文件仍无漂移。独立 MySQL 测试按其既有逻辑重写了 `.cache/phase9/explain-10k.json`，所以该证据的旧哈希已过期；这不是源码漂移。后续最终 fingerprint 应刷新该证据哈希并纳入本报告。

## Finding P2-01：真实 BFCache/可见性恢复证据尚未成立

位置：`apps/web/components/gallery/memories-browser.test.ts:24`、`:192`–`:217`；`docs/progress/PHASE-09-MEMORIES-IMPLEMENTATION-HANDOFF.md:14`。

触发：用户在浏览器中离开回忆页面，再从真实 BFCache 恢复，或后台挂起后重新可见。现有测试在原文档内主动 dispatch `new PageTransitionEvent("pageshow", { persisted: true })`；随后的 `goBack()` 是 fixture 的同文档 history。测试没有证明实际跨文档 BFCache 命中，也没有检查新请求未完成期间照片/Viewer 持续为空。此次 Chrome 启动输出还明确包含 Playwright 默认的 `--disable-back-forward-cache`。没有找到真实 visibility 切换的直接回归。

影响：这些测试能证明事件处理函数发起了重新请求，不能证明缓存恢复/挂起时不暴露旧照片。handoff 的“真实 BFCache”措辞超出已有证据。本项是验收覆盖缺口，不是已证实的照片泄漏；源码的 pagehide/visibility suspend 和 flushSync 清空路径本身未发现确定错误。

最小修复与回归：将证据描述改为“模拟 persisted pageshow + 同文档 history”；补一项启用 BFCache 的跨文档返回测试，记录浏览器实际 `pageshow.persisted === true`，若环境不能缓存则诚实记录未覆盖。恢复前持有照片及 Viewer，恢复时暂扣回忆响应，断言照片与 Viewer 在放行响应前已清空，再以撤权/过期响应确认旧内容不回来。另用真实页面可见性切换验证同样的空白等待期。无需修改产品范围或重设计 session。

## 已核实的关键实现

- `packages/db/src/album-repository.ts:253`、`:283`：family lock、actor lock、SQL server time、当前 actor 验证后才构造 anchor；预览两卡共享一个 context 和事务。过期 anchor 在查询媒体前拒绝。测试时钟只在内部构造参数，未开放 HTTP/环境入口。
- calendar 使用 Asia/Shanghai 的服务器日历；照片 DATE 仍取 capture literal 或 canonical uploaded UTC。闰日、减年夹取和周一半开区间与合同一致。
- Memories SQL 在 GROUP/LIMIT 前应用当前 placement/album ACL、媒体与 original/source 状态、当前 metadata/recipe、PREVIEW 和 THUMBNAIL 有效性；最小相册来自可见集合，无 admin bypass、隐藏总数或先截断后过滤。
- cursor 严格解码并绑定 actor/family/kind/anchor/zone/policy/limit；scope SHA 不是授权凭据，重新授权仍在事务中。last-emitted keyset 和 limit+1 实现一致。
- API/proxy no-store；SSR 不输出 provisional Memories 照片。session epoch/Abort、请求起点 monotonic deadline、late-200/409/timer 共用一次 bootstrap 预算；内部成功响应不重置预算。身份/家庭/种类通过 key 隔离。Viewer 403/404 清除失败详情。
- 审核真实 HTTPS 验收源码及既有 proof/log：用户/相册可由 fixture 建立，媒体通过实际 TUS finalize、metadata/derived runtime 和 placement API；未用手插 media/job/READY 代替上传链。原件 hash/inode 比较存在。这一 HTTPS 测试本次未重复运行，不能算独立重跑结果。

## 独立定向执行

| 范围 | 结果 |
| --- | --- |
| memories calendar/contracts、cursor、API routes、client session | 4 files，22 PASS，0 skip |
| DEV MySQL `phase9-memories.test.ts` | 7 PASS，0 skip |
| Chrome `memories-browser.test.ts` | 5 PASS，0 skip；覆盖限度见 P2-01 |
| `git diff --check` | PASS |

有效独立复跑合计 34 PASS、0 skip。MySQL 首次沙箱连接 EPERM，Chrome 首次沙箱启动 SIGABRT/kill EPERM，各导致 suite setup 失败和测试未执行；窄范围批准后重跑通过。首次失败不计为 PASS，也不是产品测试断言失败。

MySQL 复跑包含约 10k owned synthetic 样本 EXPLAIN ANALYZE：两个种类 first/deep 四次均返回 49 行，耗时约 14.1–36.3ms。本机单轮结果只证明当前规模的有界返回和查询可执行性，不能外推生产延迟或并发吞吐。纯查询 fixture 不证明上传完整性。

锁后取时的调用顺序已有源码证据，但本批没有额外复现“事务等锁跨上海午夜”的并发场景；不把日历注入测试表述成真实等锁跨日测试。完整 HTTPS 上传、工作区 typecheck/build/lint/format 的实现者记录已审阅，本次未全量重复。

## 额外 test-source TypeScript 失败的基线核实

使用同一安装依赖、同一 `tsconfig.vitest.json` 和 TypeScript 6.0.3 编译器 API，分别检查当前候选，以及只读虚拟基线：tracked 改动内容替换成 `git show HEAD:path`，屏蔽新未跟踪 TS/TSX 文件；没有 checkout 或改动仓库。

两边均 201 条诊断，诊断文件、行号、代码集合相同；198 条完整文本相同。另三条是 `tests/integration/phase6d4-preview-download.test.ts:491`、`:558`、`:636` 的既有 TS2345 mock/repository 结构不匹配。候选文本新增列出 `listFamilyMemories`/`listFamilyMemoriesPreview`，基线这些调用本就不满足 `MySqlAlbumRepository`；它们不是本批新增错误位置。Memories/Phase9 新文件无诊断。

原始对照存于本机 `/tmp/phase9-review-tsc.json`，脚本 `/tmp/phase9-review-tsc.cjs`。此结果支持“该额外命令既有失败”的归因，但该命令仍是 FAIL，不能与正式 workspace typecheck PASS 混为一谈；对照沿用同一依赖和生成声明，不是两套干净安装构建对比。

## 后续

先处理 P2-01 的证据表述及必要生命周期补测，再由父任务完成阶段 Full Quality Gate、刷新最终指纹和阶段总结。本报告不授予 production-ready 或下一 Phase 的状态。

## P2-01 限定 evidence closure（2026-10-05）

状态：**CLOSED**。本轮只核实既有验证缺口，未作新安全设计或架构评估。按本轮明确指示继续 Sol；AGENTS 的 R3 新设计/最终安全复核规则不需要用于这次测试证据 closure。可以进行父任务的 Phase 9 Full Quality Gate；本结论不代表完整 gate、Phase 9 完成或生产验收。

读取 `PHASE-09-MEMORIES-BFCACHE-CLOSURE-HANDOFF.md`，逐项检查新增 `memories-bfcache-browser.test.ts`、原测试标题修正、fixture、实现者日志与事件/帧 proof。开始复核时最终 fingerprint 的 37 个文件、受保护文件、列出的全部证据均吻合；相对原始候选，已有文件只改变模拟 browser test 标题和实现 handoff 描述。产品源码无变化。结束测试、写本报告前，候选及受保护文件仍无漂移。

独立执行 `pnpm exec vitest run apps/web/components/gallery/memories-bfcache-browser.test.ts --reporter=dot`：**1 file / 5 PASS / 0 skip，4.07s**。普通沙箱首次因本地 server `listen EPERM` 导致 setup 超时、5 项未执行；随后窄范围许可重跑通过。原失败保留于 `/tmp/phase9-bfcache-independent.log`，有效复跑日志 `/tmp/phase9-bfcache-independent-elevated.log`。没有把未执行轮次计为通过。

实际核实的三种场景：

- **真实 BFCache 组件路径**：owned Chrome 154.0.8037.97，真实 HTTP 跨文档 back/forward/back，没有请求拦截或模拟 lifecycle dispatch。auth/day 各有两次真实 `pageshow.persisted=true`，document ID 不变。恢复前 grid、Viewer 和已解码图片存在；head 中先于产品 handler 的监听器记录恢复事件同步采样和 microtask 采样皆为空，rAF 从恢复事件同步重置并保留首帧。独立 proof 的 auth 两次 17/18 帧、day 两次 18/18 帧均为 cells/viewer/images=0，受控响应至少暂扣 200ms。释放 401 后没有旧照片；释放 409 后暂扣自动 bootstrap，最后新 anchor 空列表也没有旧照片。
- **真实可见性切换**：owned Chrome 默认 context 关闭工具 focus override，真实同窗口 tab background/foreground，记录原生 hidden→visible；16 个等待帧全部为空，释放 401 后显示登录提示。
- **保留生产形式 no-store 的返回路径**：合成 main HTML 使用 `private, no-cache, no-store, max-age=0, must-revalidate`；auth/day 均为真实 back reload，document ID 改变、persisted=false、navigation type=back_forward。Chrome 原生 notRestoredReasons 包含 `response-cache-control-no-store` 和 `response-cache-control-no-store-with-js-network-request`（另有 masked）；两项各 17 个等待帧为空，401/409 和后续 bootstrap 未恢复旧内容。

场景边界：为了真正触发当前 Chrome BFCache，第一组**仅在合成 main HTML 中省略 no-store**；API 和图片仍 private,no-store。它证明实际 Memories/Viewer 组件在真实缓存恢复事件中的行为，不等同于生产 Next no-store 文档默认会命中 BFCache。第三组使用相同组件的合成 HTTP 壳和生产形式 header，验证本浏览器的实际重载退路；它也不是一次实际 Next 部署页面的导航验收。没有改变应用缓存头或产品源码。这些区别已在 handoff 明确，原 handoff 对模拟测试的措辞也已纠正。

DOM、恢复事件及首个 rAF 可绘制帧的证据足以关闭原 P2-01 要求；没有声称逐像素 OS compositor 截帧、数据库实时撤权或真实跨上海午夜。受控 401/409 是本项 lifecycle 隔离证明，不能代替既有 DEV ACL 与 HTTPS 上传证据。

独立复跑会重写 `.cache/phase9/real-bfcache-proof.json`，本报告也改变原报告哈希，后续最终 fingerprint 应刷新这些证据。独立复跑 proof SHA-256：`3d4e8889b8478b73befec408457dd2b1cf00634261c0d47c6e4f94cebc2208d1`；日志 SHA-256：`bd53e3300810ed2c15e1d3ddd0128bc4d3c3ba21f4cd55ead890ee93bd103980`；新增测试 SHA-256：`ff84c1a6381f0468beac1a05388f48292c0dbba5fe57a6f010a94977558ef5bb`。本轮不修改最终 fingerprint 或实现者原日志。

额外根测试源码 tsc 的既有 **201 条诊断 FAIL** 继续保留此前基线对照结论，本轮未重跑或改写为 PASS。没有全项目复审、产品源码/测试修改、commit/push/deploy 或进入 Phase 10。
