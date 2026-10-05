# Phase 8 地图批次：独立审查修复交接

2026-10-04。依据 `PHASE-08-MAP-PIPELINE-INDEPENDENT-REVIEW.md` 的两项 P2 与验收证据缺口落实最小修复，供原 reviewer 限定 closure。不是独立复核结论，不是 Phase 8 完成声明。HEAD 保持 `0c948451774efd10a293029e727b666758441436`。

```text
Profile: PRO_STABLE
Risk: R3-IMPLEMENT
Current Model: unknown
Recommended Model: GPT-5.6 Sol Medium
Test Scope: targeted
Action: continue
Reason: approved review patch plan; transaction/storage/ACL/schema contracts unchanged
PHASE_8_COMPLETE: NO
FULL_GATE_RUN: NO
PRODUCTION_READY: NO
```

## 修复差异

### P8-MAP-R1：停止后不再选择 recovery 或 claim

`apps/worker/src/metadata-main.ts` 将信号传给 `MetadataJobLoop`，沿用现有 `SerialJobLoop` 的停止和空闲等待中断机制。每次 recovery 返回后先检查 stopped，再允许新 claim。`metadata-driver.ts` 的 `runNext` 在 claim 前检查 stopping；恢复批次每个独立事务之间检查 stopping。信号发生在初始化期间也会在 loop 启动前生效。

已开始的 claim/recovery/probe 正常 settle；没有 abort DB/native 操作，没有 lease、锁序、generation 或 schema 变化。原错误传播/进程退出策略保持。

新增 `metadata-job-loop.test.ts` 的三个 barrier 回归分别覆盖 discovery、首项 recovery、active probe/idle。真实 metadata entrypoint 进程另用两个经实际 API 上传、运行接线生成的 probe jobs 验证：实际首项 recovery 返回屏障期间投递 SIGTERM，放行后只有一次 reader close、exit 0；没有第二次 recovery 或 claim，jobs 保持 RETRY_WAIT/RUNNING、attempts 均为 1。该进程屏障位于首项真实 recovery commit 后、方法返回前；不冒称信号打在 SQL commit 内部。第二项通过现有 recovery API 收尾。

### P8-MAP-R2：bbox 使用受限普通十进制

`apps/web/lib/gallery-paths.ts` 的生产 URL 构造先拒绝非四元组、NaN/Infinity、越界和 south > north，再以最多十位小数序列化视野，消除 exponent 与负零。四项总长度低于现有 100 字符预算。保留 west > east 的反子午线语义；不改变 server schema、H3 res6 或媒体 GPS 政策。

`search-paths.test.ts` 经实际 `familyMapQuerySchema` 验证近零正负经纬度、普通视野、±180/±90、反子午线、负零及极小数；非法输入仍拒绝。浏览器 fixture 注入 synthetic near-zero bounds，真实 MapLibre zoom → production onView → URL → 实际 schema 返回 200；不是 mock URL 函数。真实 hosted provider 用例没有该 bounds 注入。

### 补测中暴露的 owner idle 连接收尾

正常 keep-alive admission 请求在 SIGTERM 期间完成后，native derivative 已 commitSucceeded，但原进程仍未在 15 秒内退出；这不是 metadata R1 或 bbox R2，也不归因 OpenFreeMap。失败日志保留在 `closure-owner-consumed-keepalive.log`。先前 `Connection: close` fixture 可通过，但不能代替默认连接语义的验证。

在 `apps/api/src/index.ts` 增加一处 onResponse hook：若 shutdown 已开始，在下一轮事件循环调用 Node `server.closeIdleConnections()`，清理 initial server-close sweep 后才变成 idle 的连接。仅关闭 idle sockets，不 destroy 活动连接，不 abort 请求/SQL/native，不改变 writer ownership 或资源关闭顺序。最后测试移除了 `Connection: close`，正常消费响应，验证默认 keep-alive 的真实 render/publication + admission drain。这一额外差异需要 reviewer 一并限定核对。

## 补齐的证据及其边界

全部实际媒体仅为专用系统 tmp 中的 synthetic JPEG。实际进程 E2E 只 seed family/user/session，未 INSERT media/job/READY/album_media 冒充 runtime。相册、placement、Trash、永久删除请求走现有 API。

| 缺口                             | 本轮新增证据                                                                                                                                                                                                                                                                                                                            | 验证层次/边界                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 纯 A 恢复                        | 实际 TUS POST/PATCH/finalize → COMPLETE/no media → SIGKILL → enabled built API 直接重启 → 独立 native metadata → derivative READY → API placement/map；唯一 media/probe/projection，Original bytes 不变                                                                                                                                 | 实际进程/native。没有中间 attachment helper；保留原 B/unknown 测试                                                                                                                               |
| >2 页、公平性、late low、高水位  | 41 个实际 COMPLETE receipt，真实 SQL 页 20/20/1；低 key DEFERRED 不阻挡最高 ID；首轮读实际 high-water 后插入更高 receipt，不进入本轮；更低 ID 的实际 TUS finalize 在第一页面后完成，同一 reconciler 下一轮发现并修复两个 gap                                                                                                            | 实际 API + SQL + scheduler。SQL discovery 下界限制在本 fixture；低 key acquisition timeout 与等待时间使用注入 seam，native contention 由原独立用例证明。不是每个 fairness 状态组合的进程压力测试 |
| 并发 dedup/source                | 两个用户并发实际同 K 上传；两个 reconciler 在实际 missing-media 观察后 barrier 同时进入 T1/T2，持真实 native L-S；同一 canonical/probe，source 属于一个获胜 receipt，后续 reconcile 保持 source                                                                                                                                         | 实际 DB/native。没有双 Original writer；保留先前 CUSTOM map ACL 用例                                                                                                                             |
| purge/retirement + projection FK | 使用纯 A runtime READY fixture，已有 projection 子行；API Trash、测试保留期时钟、API永久删除请求；停止 API writer 后独立 PurgeProcessor 完成。DETACH 的真实 commit 前屏障持 L-X，reconciler L-S 拒绝；backfill SQL 等待该事务，提交后 STALE；projection/media/jobs/assets 删除、receipt RETIRED 且移出 discovery、PURGE_COMPLETED audit | 实际 API + DB + native purge。测试时钟只改 owned fixture 的保留时间；没有 API/purge 双 writer并行，没有重审旧 Phase 7                                                                            |
| backfill fence 双顺序            | generation、Trash/restore、lease takeover 各与 backfill 两种先后顺序，真实双连接 media lock barrier；后序操作确实等待。generation/lifecycle token 失效；lease 变更不虚构 backfill lease，旧 metadata worker affectedRows=0，不能覆写当前 projection                                                                                     | 定向 SQL 状态 fixture。用于 CAS/lock 证明，不称作上传 E2E 或完整生命周期 API 压力测试                                                                                                            |
| 停止/资源收尾                    | 实际 built API entrypoint preload 仅暂停真实 native render callback 返回或 markPublishing commit 后返回；同 owner 实际 TUS admission commit 后也暂停。SIGTERM 期间资源不关；放行 admission 和 work 后响应201、media READY、无后续 claim，store→reader→gate→root 各关闭一次，exit0                                                       | 实际进程/native/default keep-alive。preload 每个 collaborator 都执行原实现，没有 mock DB/native；屏障不证明 C/native 内每个指令点都能被测试停住                                                  |

`phase8-location-metadata.test.ts` 新增双锁序 test 内含六种组合。lease takeover 的用意是证明旧 metadata lease 不覆盖 backfill；backfill 自身不领取 processing lease。

## 本轮结果与原始日志

日志统一在 `.cache/phase8-map/evidence/`；成功与失败记录没有相互覆盖成“全部一直 PASS”。

- `closure-final-targeted.log`：13 files / **78 PASS / skip=0**。包括两个 P2、新 runtime/locking 用例及原 location/worker 定向回归。之后仅细化 runtime fixture 的同实例 next-round 与 purge/backfill 等待证明，并修复 owner idle sweep。
- `closure-final-runtime-refinement.log`：细化后的 runtime suite **11 PASS / skip=0**。
- `closure-final-runtime-idle-drain.log`：最后 API idle sweep/default keep-alive 差异的实际 runtime suite **11 PASS / skip=0**。本日志是最终 runtime 候选证据，不与前两份重叠用例相加。
- `closure-final-browser.log`：2 files / **24 PASS / skip=0**，包含真实 OpenFreeMap hosted load、near-zero UI、stale camera、failure/stalled fallback 和 search 回归。
- API：`closure-api-types.log`、`closure-api-build.log` PASS；worker/web：`closure-final-*-types.log`、`closure-final-*-build.log` PASS。
- 最后变更文件：`closure-last-lint.log`、`closure-last-format.log` PASS；`git diff --check` PASS。
- `closure-owner-render.json`、`closure-owner-publication.json`：白名单 IPC 阶段事件，没有凭证、GPS、私人文件名或媒体内容。

之前 sandbox EPERM、错误 locatedCount fixture 断言、上传 burst 预算、重复 SIGTERM、owner keep-alive 超时运行均保留；不计为 PASS。fairness fixture 使用显式 disabled-owner 小批重启维持现有上传限流，没有改限流参数。

本轮 24 PASS 是新的真实 provider 观察，原 `pipeline-browser-final.log` **22 PASS / 1 FAIL** 仍然有效。不能倒推原失败的供应商/网络/CSP原因；本轮 console 泛化 404 也不擅自定性为 favicon。

## 给原 reviewer 的限定 closure 范围

检查 R1/R2 的实现与回归，新增 idle socket sweep 是否保持 active request drain，以及本报告的真实运行证据边界。对照 `/tmp/phase8-review-fingerprint.json`：原 74 文件仅报告列出的预期实现/测试文件变化，Web AGENTS/CLAUDE 和 pinned dataset 保持原 hash；最新 delta 清单保存为 `closure-fingerprint-delta.json`。

仍不能宣布完整 guardrails crash/race 笛卡尔积全部覆盖：例如实际 Trash API 等待 T1/T2 的所有交错、长期连续 higher-ID 写入压力、每一个 native publish 指令点崩溃、任意不结束的客户端连接、真实 power loss/SSD 断开均不由本轮 PASS 推导。已补的是审查报告与本批新接线直接相交的最小真实证明。Production、全 Phase 8 Quality Gate 和独立复核结论仍未执行。

0000–0007 migration 无改动，本轮没有 migration、真实媒体、Production、commit/push/tag/deploy、额度购买或 Phase 9。等待原 reviewer 限定复核，再由父代理执行一次完整 Phase 8 gate；Phase 8 完成后停止。
