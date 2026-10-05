# Phase 9 Memories — final summary

2026-10-05。**PHASE_9_IMPLEMENTATION_COMPLETE: YES**；**PHASE_9_FULL_QUALITY_GATE: PASS**；**PHASE_9_PRODUCTION_READY: NO**。

Phase 9 已在 DEV 合成环境收口。独立源码审查没有确认 P0/P1；唯一 P2-01 生命周期证据缺口已由原审查者独立复跑后 CLOSED，见 `PHASE-09-MEMORIES-INDEPENDENT-REVIEW.md` 的 closure。此后执行一次统一完整 gate，没有再开审查轮次、修改产品安全逻辑或扩展旧债范围。到本阶段停止，不进入 Phase 10；没有 commit/push/deploy 授权或操作。

基线 HEAD：`979d6eb063a1137387ded31330ea3a3a6cd99436`，Phase 9 改动保留在工作区。DEV 以外没有数据库、媒体、系统设置或账户操作。

## 交付

- 首页“往年今日”和“一年前的这周”两张卡片共享一次授权请求和 server anchor；启用回忆导航，`/memories` 提供两种固定类型、完整有界分页、日期标签、空态、失败重试与既有 PhotoGrid/Viewer。
- 固定 Asia/Shanghai、memories-v1。同月日的历史年份匹配往年今日；2 月 29 日不代替为其他日期。一年前的这周按日历减一年，闰日夹取后取周一至下周一半开区间。照片按 capture wall DATE 匹配；缺拍摄日期时按 canonical upload UTC DATE，明确标注上传日期，不转换成上海照片日期。
- checked transaction 的既有 family/actor lock 和 current auth 之后只取一次 SQL serverNow，再求 anchor。当前 owner/FAMILY/can_view 授权和 active IMAGE/READY/current metadata/recipe 1/coherent COMPLETE receipt/AVAILABLE original/有效 PREVIEW+THUMBNAIL 全部在分组和 limit 前执行，无 admin bypass；最小 viewer album 来自可见集合。
- 默认页 48、最大 100，preview 各 6；limit+1、last-emitted keyset、媒体去重。严格独立 cursor 绑定 actor/family/kind/anchor/zone/policy/limit，过期 anchor 在当前授权后、媒体查询前返回窄 409。SHA scope 是上下文绑定，不是 MAC 或授权凭据。
- API、proxy、SSR fetch 保持 private/no-store，无共享缓存、GPS/私有存储数据输出。客户端 epoch/Abort、请求起点 monotonic deadline、一次共享 bootstrap 预算处理 late 200/409/timer；身份/家庭/类型/日期/认证失效和挂起清空照片、游标、Viewer，恢复重新验证。SSR 回忆照片保持 provisional 隐藏。

没有 AI、mobile Memories、通知、cron、时区设置、新表/列/索引/migration、新服务或存储/授权/Session 不变量变化。Original 仍 immutable。

## 本轮统一 gate

原始输出、结果与 SHA 清单在 `.cache/phase9-full/`。以下仅计本次执行，不累计重叠定向或独立复跑数字。

| 仓库检查                                    | 本轮结果                                                               | 证据                                      |
| ------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `pnpm format:check`                         | PASS；gate 前后均通过                                                  | `format-start.log`、`format-final.log`    |
| `pnpm lint`                                 | PASS；gate 前后均通过                                                  | `lint-start.log`、`lint-final.log`        |
| `pnpm typecheck`                            | 全 workspace PASS                                                      | `typecheck.log`                           |
| `pnpm build`                                | 全 workspace PASS，含 native、API/worker、Next Web、mobile Expo export | `build.log`                               |
| `pnpm test --reporter=dot`                  | **161 files / 1659 tests PASS，skip=0**，158.65s                       | `test.log`                                |
| `pnpm test:e2e`                             | **5 PASS**，1.9s                                                       | `api-e2e.log`                             |
| `pnpm test:e2e:web`                         | **21 PASS**：gallery 10 / download 10 / Memories 1                     | `web-e2e.log`                             |
| Strict DEV readiness / owned fixture counts | PASS，9 migrations，no DDL；本批 family/user/media/job 均 0            | `readiness-cleanup.log`                   |
| Owned test process / listener cleanup       | PASS；已知测试服务及专用 Chrome 剩余 0；3443/4000/4400 无监听          | `owned-process-cleanup.log`、最终工具记录 |
| `git diff --check`                          | PASS                                                                   | 最终工具 exit 0                           |

`pnpm test` 包含真实 MySQL integration/race、native、fault/crash、日期/ACL/分页/cursor/preview equivalence，以及五项真实生命周期用例，没有因 `.env` 未加载而 silently skip。完整测试日志是工具分块捕获，其中一块常规 stdout 被工具截断；末尾正式汇总完整，不能声称该文件保存了每一行原始 stdout。没有测试断言失败或为收口修改测试/源码。

真实回忆 HTTPS 验收本轮重新执行：两张自建历史 EXIF JPEG 经实际登录、TUS finalize、metadata 与 native derivatives 进入 READY，随后通过 placement API 加入相册，验证 Home/cards/full Memories/Viewer/preview serving。没有手插 media/job/READY 或公开测试时钟代替上传链。59.4s（suite 总 1.1m）PASS；Original SHA 和 inode 前后不变。新 proof：`.cache/phase9/https-upload-proof.json`。

本轮 MySQL 10k 合成查询证据：`.cache/phase9/explain-10k.json`，两个种类首/深页各返回 49 条；deep cursor 来自第 501 个实际可见结果，没有空深页证明或新增索引。性能只代表当前本机这一轮，不外推生产吞吐。

## 生命周期证据归属与网页方案勘误

1. 原 `memories-browser.test.ts` 是模拟 persisted pageshow + 同文档 history，未冒充真实 BFCache。新增 `memories-bfcache-browser.test.ts` 在完整 gate 中执行五项真实 Chrome 用例：可缓存合成 HTML 的 auth/day 各两次真实 persisted 恢复、实际标签 hidden→visible、production-form no-store main HTML 的 auth/day 普通 back reload。首个恢复事件同步采样、microtask、首个及后续 rAF 等待帧照片/Viewer 均为空。最新逐事件 proof：`.cache/phase9/real-bfcache-proof.json`。
2. 实际 Chrome 不缓存这类 no-store+JS network main document，原生原因如 `response-cache-control-no-store-with-js-network-request` 已记录；为验证实际缓存恢复组件路径，仅合成 main HTML 的相应两项省略 no-store。应用缓存策略未修改，API/图片仍 private,no-store。不得把该组表述为已部署 Next 页面默认命中 BFCache，或把 DOM/rAF 证据表述为逐像素 OS compositor 采样。
3. 网页示例把 2024-02-29 的减一年写为 2025 是错误。实现及测试采用 2023-02-28 → `[2023-02-27,2023-03-06)`。其余批准示例：2026-10-05 → `[2025-09-29,2025-10-06)`；2026-01-01 → `[2024-12-30,2025-01-06)`；2025-02-28 → `[2024-02-26,2024-03-04)`。
4. guardrails 对旧 API error envelope 的描述与源码不同；保留实际既有 `{code,message,requestId}`，没有重设计公共错误格式。完成照片按真实 READY 表达，不引入不存在的 COMPLETE photo processing state。

## 检查顺序、指纹和清理

最后产品/测试改动在独立审查 closure 之前。本轮顺序：format/lint/正式 typecheck → full build → unified tests → API E2E → 全 Web HTTPS → readiness/cleanup → final format/lint/diff → 最终文档。没有 gate 中的产品/测试修补，也没有安全审查后逻辑变化。Next dev 只改了 next-env.d.ts 两行生成类型路径；核对后恢复起点/HEAD 的 build paths。

参考起点 `.cache/phase9/phase9-fullgate-start-fingerprint.json` 从最后候选指纹复制；其中 review 文档 hash 是追加 closure 前的版本。结束比较：唯一既有条目差异是该报告在 gate 前追加的 closure，所有产品/测试/guardrails 字节不变。最终 SHA 与 evidence inventory：`.cache/phase9-full/final-fingerprint.json`、`evidence-inventory.json`。新增最终总结属于文档收口，不是 gate 输入变更。两个无关 Web AGENTS/CLAUDE 与 Phase 8 受保护 hash 一致。

只读核验 DEV 为 `family_album_dev`、MySQL 9.7.2、non-root、native FK=1、FK checks=1、9 条迁移 strict readiness PASS。cleanup 只按本批 synthetic prefix 查询，没有批量删除或修改他人数据。各验收 teardown 处理自己的系统 tmp root/cert/profile；最后 known repository test services 与自建 Chrome 无残留。没有 home ACL、其他人的 tmp 或真实媒体操作。

## 已知限制

额外根测试源码命令 `pnpm exec tsc --noEmit -p tsconfig.vitest.json` 仍是 **FAIL：201 条既有诊断**。独立审查用同一依赖/编译器核对 baseline/candidate，错误位置和代码集合没有新增；Memories/Phase9 新文件无诊断。未重跑或改成 PASS，未扩范围清旧债。这与正式 workspace typecheck PASS 分别记录。

没有 Production、真实媒体、真实硬件断电/SSD 拔出、设备 Android APK、已部署 reverse proxy/CSP/长时并发与生产延迟验证。日期/午夜 race 用内部 clock 与受控响应证明策略，不声称真实事务等锁跨上海午夜；生命周期受控 401/409 也不代替实际 DB ACL 测试。既有 production rate limiting/persistent audit/硬件部署待验项保持原状态。

阶段已完成并停止，供用户评估网页规划流程；下一阶段需另行授权。
