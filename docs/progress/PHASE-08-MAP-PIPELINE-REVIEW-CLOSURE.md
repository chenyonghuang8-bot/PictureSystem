# Phase 8 地图与上传运行接线 — 限定审查 Closure

2026-10-04 UTC。复核原 `PHASE-08-MAP-PIPELINE-INDEPENDENT-REVIEW.md` 的两个 P2、明确列出的证据缺口，以及修复交接中新增的 API shutdown idle-connection sweep。已读取 `PHASE-08-MAP-PIPELINE-REVIEW-FIX-HANDOFF.md`，核对实际源码、测试和最终运行证据。模型按父代理明确确认的 `gpt-6-astra / low` 路由执行；本次仅新增本报告，无实现/测试修改，无 full gate、migration、Production、真实媒体、Git 写操作或下一 Phase 工作。

```text
Profile: PRO_STABLE
Risk: R3-DESIGN
Test Scope: targeted
SCOPED_REVIEW: CLOSED
P8-MAP-R1: CLOSED
P8-MAP-R2: CLOSED
DIRECT_ACCEPTANCE_EVIDENCE_GAPS: CLOSED_WITH_DOCUMENTED_BOUNDARIES
SHUTDOWN_IDLE_SWEEP_REVIEW: PASS
NEW_BLOCKING_FINDINGS: 0
READY_FOR_PARENT_PHASE8_FINAL_GATE: YES
PHASE_8_COMPLETE: NO
FULL_GATE_RUN_BY_REVIEWER: NO
PRODUCTION_READY: NO
```

本结论关闭原限定审查，不替代完整 Phase 8 gate，也不把硬件断电、所有竞态组合或 Production 验证扩大为已通过。

## 最终候选与 freshness

- HEAD 保持 `0c948451774efd10a293029e727b666758441436`。
- 当前 `git diff HEAD --binary` SHA-256：`2ea0606a70b931b5ed28de241b3cf4003ef1fc2edfa3e72988a59f23ffef4f80`。
- 沿用原审查清单算法（tracked changed + nonignored untracked，按路径排序，每文件 SHA-256，compact JSON），本轮报告写入前 **80 文件**；清单 `/tmp/phase8-closure-fingerprint.json`，SHA-256 `937ba56e040a9c33d5594569d6eb4f24f4126a944246b791f5cdfe2d2932cdc1`。
- 与原 74 文件指纹比较：67 文件原样；仅以下 7 文件变化：API index、Web location-browser test、gallery-paths、metadata-driver、metadata-main、phase8-location-metadata test、phase8-upload-pipeline test。其他新增/新增修改集合为 search-paths test、metadata-job-loop 与 test、UI fixture，以及原报告和修复交接。与 `closure-fingerprint-delta.json` 各项 hash **全部一致**。
- Web AGENTS/CLAUDE、pinned dataset、既有事务/ACL/schema/存储实现保持原审查 hash。原报告未改写。
- 78 PASS 日志早于最后 runtime fixture 与 idle sweep，不能直接充作最后候选全覆盖；已确认最后 `closure-final-runtime-idle-drain.log` 在 API rebuild 与最后 runtime fixture 之后，11 PASS。API dist 含新增 `closeIdleConnections()`；metadata dist 包含停止状态/新 loop，构建时间晚于相关源码。
- 本轮最终候选又独立复跑直接相关文件（见下文）。测试前后 80 文件 hash 无变化；`git diff --check` 通过。

## 两个 P2 的关闭依据

### P8-MAP-R1 — CLOSED

`apps/worker/src/metadata-job-loop.ts:12`–19：recovery 返回后检查 stopped，再允许 runNext；requestStop 同时传递给 driver 和 SerialJobLoop。`metadata-driver.ts:43`–46 在 claim 前检查 stopping，`:72`–74 在各独立 recovery 事务之间检查。`metadata-main.ts` 把信号接到 loop，初始化中收到的停止也在启动前生效；已开始的 DB/native operation 没有被中断。

独立通过 `metadata-job-loop.test.ts` 的 discovery、active recovery、active probe/idle 三项控制流测试；真实 entrypoint 用例 `phase8-upload-pipeline.test.ts:536` 验证首项真实 recovery commit 后、返回前的屏障收到 SIGTERM，放行后不再恢复第二项或 claim，reader 只关闭一次、exit 0，两个 jobs 维持预期 RETRY_WAIT/RUNNING 与 attempts=1。该屏障不是 SQL commit 内部暂停，测试对此没有冒称。

原“停止后继续领取新任务”触发路径已经消除。正常 settle/drain 与原 lease/fencing 保留，无新增事务设计。

### P8-MAP-R2 — CLOSED

`apps/web/lib/gallery-paths.ts:211`–231：四元组、有限数值、范围和纬度顺序先校验，再用最多 10 位小数的普通十进制编码；去除 exponent/负零，保留反子午线 west > east。最大串长度仍低于 100。没有改变服务端严格 schema 或媒体 H3 精度政策。

独立通过 `search-paths.test.ts` 的真实 query schema 回归，包括近零正负、常规 bounds、极值、反子午线、负零/极小数与坏输入；`location-browser.test.ts:406` 的 synthetic bounds 经真实 MapLibre movement → 生产 onView/URL → 当前 API schema 接受。bounds 注入只在测试 fixture 显式 query 开启，真实 hosted-provider 用例没有该注入。

## 新增 shutdown idle sweep — PASS

`apps/api/src/index.ts:309`–316 仅在 shutdown Promise 已存在且 response 完成之后，用 setImmediate 调用 `server.closeIdleConnections()`。它不使用 closeAllConnections/destroy 活动 socket，不取消请求或 native/SQL work，不提前关闭 shared gate/store/root；原 requestStop、app.close、onClose cleanup/drain 顺序未改变。

`phase8-upload-pipeline.test.ts:624` 对 render 和 publication 两个阶段分别执行真实 built API、真实 native renderer/DB，并发真实上传 admission；collaborator 屏障在原操作已完成但返回未交付的边界暂停。SIGTERM 后先放行 admission，获得并正常消费 **默认 keep-alive** 的 201 响应；当前 derivative 完成 READY，再按 store → reader → gate → root 各关闭一次、进程 exit 0。停止期间没有新 claim，活动工作未提前丢失。

本轮独立复跑上述两个阶段通过。原 keep-alive 超时失败日志保留；没有以 Connection: close fixture 取代最终验收。此修复限定于正常响应完成后变成 idle 的连接；不声称任意永不结束的客户端连接也能在固定期限内 drain。

## 原证据缺口的限定关闭

| 原缺口 | 核对与独立复跑依据 | 结论 |
| --- | --- | --- |
| 完整进程纯 A 恢复 | `phase8-upload-pipeline.test.ts:449` 实际 TUS/finalize → COMPLETE/no media → SIGKILL → enabled built API + metadata 直接启动 → READY → API placement/map；无 attachment helper、无手工 media/job/READY/placement | CLOSED |
| >2 页、公平 advance、late low/high-water | `:726` 实际 SQL 20/20/1 页；一个低 key DEFERRED 不阻塞最高 ID；第一轮后才完成的低 receipt 和新增高 receipt 由同一 reconciler 下一轮捕获 | CLOSED；acquire timeout 与等待时间为 seam，native contention 另有真实用例；非长期压力证明 |
| 同 K 并发 dedup | `:823` 两用户真实并发上传、两个 reconciler 在 missing-media 后 barrier 并发，实际 native L-S/DB，最终唯一 canonical/probe 与稳定 source | CLOSED；没有双 writer，继承原 CUSTOM ACL 证明 |
| projection 子行 purge/receipt retirement/并发 backfill | `:1148` runtime READY fixture 经 API Trash/permanent-delete（仅 fixture retention clock 调整）；API 停后单 purge writer。DETACH commit 前真实 L-X 阻止 reconcile；backfill 等待后 STALE；projection/media/jobs/assets 删除，receipt RETIRED/离开 discovery，audit 完成 | CLOSED |
| generation、trash/restore、lease takeover 双锁序 | `phase8-location-metadata.test.ts:507` 六个双连接组合，第二 writer 确实等待；CAS 与旧 metadata fence 拒绝，lease-only 不虚构 backfill lease | CLOSED；这些是定向 SQL fixture，不冒充生命周期 API E2E |
| owner 运行中 stop 与 admission/drain | 上述实际进程 render/publication + concurrent admission + 默认 keep-alive 用例，metadata entrypoint stop 用例 | CLOSED；屏障不代表 native 每条指令/commit 内部所有中断点 |

这些补测满足原报告要求的最小直接交叉证明。真实 power loss/SSD disconnect、所有 Trash API/T1/T2 交错、长期无界流量与其他未授权范围继续保持既有边界，不作为本次新增泛化阻塞。

## 本轮独立验证

1. `pnpm exec vitest run apps/worker/src/metadata-job-loop.test.ts apps/web/lib/search-paths.test.ts tests/integration/phase8-upload-pipeline.test.ts tests/integration/phase8-location-metadata.test.ts --reporter=dot`
   - **4 files PASS / 31 tests PASS / skip=0**，40.72s，exit 0。
   - 日志：`/tmp/phase8-closure-direct.log`。包含最终 runtime 11 tests 与完整相关 metadata suite，不以挑选新 test 绕开其共享 fixture。
2. `pnpm exec vitest run apps/web/components/gallery/location-browser.test.ts --reporter=dot`
   - **1 file PASS / 8 tests PASS / skip=0**，26.76s，exit 0。
   - 日志：`/tmp/phase8-closure-browser.log`。真实 OpenFreeMap hosted load、near-zero、stale camera、auth isolation、stalled/failed/disabled provider 一并通过。
3. 候选证据 78 PASS、最后 runtime 11 PASS、browser 24 PASS 的日志/freshness 已核对；不与本轮重叠用例相加，不宣称 reviewer 重跑了全部 78/24。候选 API build、最后 lint/format 日志已核对；本轮未另跑全量 typecheck/build/lint。

本机 DEV/native/隔离 Chrome 执行使用已授权的权限提升，成功退出，没有新的测试阻塞。仅 synthetic 专用 tmp 与 fixture 自有 DEV 记录；实现者原有测试会更新 ignored IPC 证据文件，未修改源码或测试。

## OpenFreeMap 记录与最终交接

旧 `pipeline-browser-final.log` 的 **22 PASS / 1 FAIL** 原样保留。修复批次 24 PASS 与本轮 8 PASS 是较晚窗口的新成功观察；没有据此倒推旧失败为供应商、网络或 CSP，也没有把旧 FAIL 改成 PASS。此次仍出现笼统 fixture 404 console 信息；本轮未重新逐 URL 定位，不将其泛称 favicon。真实 provider 没有被 deterministic style 替换。

原限定审查现已 CLOSED，无剩余本次阻塞项。父代理可在该候选上运行统一 Phase 8 final gate；其真实失败仍须处理，closure 不能代替 gate。最终 Phase 8 完成后停止，不自动进入 Phase 9、commit/push/tag 或部署。
