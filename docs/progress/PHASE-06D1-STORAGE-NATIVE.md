# Phase 6D1 — Storage/Native Async Verified Original Download

日期：2026-09-28。性质：R3-IMPLEMENT。基线 `main` / `c7180542f3a27c56074c6726b0dba40f25ebe7cd`，落实已通过的 Phase 6D 高风险设计，仅实现 storage/native capability。Phase 6D1 实现与 remediation 已完成，并已通过最终独立安全复核；不据此宣称 Phase 6D 完成或 production ready。

## 范围与结论

新增 `OriginalReader.withVerifiedDownload(identity, { signal }, callback)`。callback 只收到 opaque、顺序、只读、不可 seek 的 `VerifiedOriginalDownload`，公开操作仅为 `readNext()` 与幂等 `cancel()`。没有暴露 FD、路径、storage key、native pointer 或 `FileHandle`；没有借用 `OriginalReader` 的目录 FD，而是在启动时复制独立 root/originals dirfd。

本 slice **没有**实现 DB authorization、second authorization、HTTP original route、preview download、filename/header encoder、download limiter、public sharing 或 Web；没有修改 schema/migration，也不表示 Phase 6D 完成。

## Environment teardown remediation

初版使用 `napi_async_work`。独立审查在 Node 22.23.2 复现：Node 会先等待 pending async work，之后才进入 addon cleanup hook；因此若 native work 停在可取消的 userspace barrier，cleanup hook 无法先设置 cancellation，Worker termination 会等待外部 barrier release。该架构不能满足本阶段的 teardown 顺序，已移除。

修正后的每个 download context 最多拥有一个 joinable POSIX worker thread，不使用 `napi_async_work`、TSFN、`uv_async` 或其他 libuv request。verification 和每次 bounded read 均在 worker thread 执行；background thread 不调用 N-API。JS event loop 通过 bounded adaptive polling 读取同步 `pollOriginalDownload()` 的完成结果：先同步检查，一次快速 `setImmediate`，仍未完成时使用 1/2/4/8/16 ms timer，之后保持 16 ms。每个 verification/read operation 独立重置 backoff。timer 保持 referenced，使被 await 的正常下载不会因没有其他 active handle 而静默停止；每条链最多一个待处理 immediate/timer，settlement 后不再调度。

每个 context 注册 async environment cleanup hook。由于 context 不再向 Node/libuv 登记 pending native work，cleanup hook 可以在 environment teardown 中先设置 atomic cancellation、禁止新 work、唤醒 test/userspace barrier，再 `pthread_join()`；join 返回后才清理 work buffer、关闭 original/parent/originals/root FDs 并释放引用。worker 没有 detached 状态，context 在 worker、cleanup-hook 与 external 引用全部释放前不会销毁，也不会在 environment destruction 后投递 JS completion。

真实 Worker teardown 测试分别在 VERIFY 和 READ worker 已到达 native cancellable barrier 后调用 `Worker.terminate()`，父线程从不执行 `RELEASE`；cleanup hook 自行 cancel/wake/join。每种状态连续执行 10 次，termination 均在 watchdog 前完成；每轮 `activeWork=0`、original open/close 增量 1/1、owned directory/pinned FD 与 live native context 回到该轮基线。watchdog 仅用于失败测试。专用 pthread 没有应用层 queued-work 状态，因此 queued teardown 为 N/A。

保留限制：已经进入的 blocking kernel disk operation 未承诺在精确 deadline 被强制中断；这与可由 cleanup hook 主动唤醒的 userspace test barrier 明确区分。

## Native ownership、状态机与关闭顺序

- 每个 download context 独立拥有 root/originals/parent/original FDs。original 只打开一次；同一个 FD 完成完整 hash、size 校验、所有顺序读取、expected-offset extra-byte probe 与最终 `fstat`。
- 状态主路径为 `OPENING → VERIFYING → VERIFIED → STREAMING → EOF_VALIDATED → CLOSED`；失败和取消分别经 `FAILED` / `CANCELLING` 后关闭。
- 每个 context 最多一个 active work；并发 `readNext()` 立即安全拒绝，不排队或预取。active work 持有 native refcount，cancel/abort/early return/callback throw/GC/environment teardown 均先设置 cancellation，再等待 worker settle/join，最后 exactly-once close，禁止 `close(fd)` 与 `pread(fd)` 竞态。
- double cancel 收敛到同一个 JS close promise；CLOSED/FAILED/CANCELLING 不可恢复。`OriginalReader.close()` 不影响已经复制独立资源的 download context。

## Exact-byte 与 identity protocol

- callback 只在完整 SHA-256、expected `off_t` size、root/marker/name/inode/device/UID/mode/nlink/ACL/mtime/ctime 全部验证后进入。
- 单次 native read 和返回 chunk 最大均为 256 KiB；caller 未调用 `readNext()` 时不预取，也不按 expected byteSize 分配内存。
- positive short system read 会继续读取；expected size 前 EOF 会失败。
- 最后一个 bounded chunk 暂存在 native work 中，先用同一 FD 在 expected offset 做 extra-byte probe，再执行 file/name/intermediate directory/root/marker 最终 identity 检查；全部通过后才复制给 JS 并返回 `final:true`。
- stream 中 mutation/replacement 在后续或最终 identity check fail closed。已经交给 caller 的 prefix 无法召回；能力只承诺不会把检测失败误报为成功 final/EOF。
- 下载路径不修改 original、权限、mtime、metadata、derived data 或 DB 状态。

## Exact-integrity branch evidence

所有 fixture 均是受控 synthetic media，不读取真实家庭媒体。

- SHA mismatch：在受信 identity 派生出的准确 CAS 路径原位写入同长度、不同内容；native original open/close 为 1/1，专用 `hashMismatchCount` 增加 1，callback 未进入。
- Size mismatch：保留准确 identity-derived CAS 名称但使实际文件增加一字节；native original open/close 为 1/1，专用 `sizeMismatchCount` 增加 1，callback 未进入。
- Short EOF：成功 verification 和首块读取后，test-only lowest-level `pread` seam 单次返回 EOF；`shortEofCount` 增加 1，未报告 final success，FD 关闭。
- Extra byte：最后预期块已经填入 native buffer 并停在 FINAL barrier，JS 尚未收到它；test-only same-FD extra-byte probe 单次报告一字节，`extraByteCount` 与 `finalWithheldCount` 各增加 1，Promise 拒绝，最后块和 `final:true` 均未交付，FD 关闭。
- Async originals replacement：前两块成功后，最终块停在 FINAL barrier；替换 storage root 下的 `originals` 目录，再释放 worker。最终 root/originals identity check fail closed，未交付成功 final，open/close 为 1/1。

marker/root/intermediate replacement、symlink、hardlink、FIFO、directory、wrong mode、extended ACL、stream mutation、concurrent read、abort verify/read、cancel before first read、double cancel、early return、callback throw、reader close、read after cancel/final、native finalizer abandonment 与 active-work GC 仍有覆盖。

wrong UID 需要 root/chown，DEV 测试进程不可安全构造，**NOT RUN / PLATFORM PREREQUISITE**。cross-device original 需要另一个可控同约束文件系统挂载点，当前 DEV fixture 不具备，**NOT RUN / PLATFORM PREREQUISITE**。这些项目没有伪报 PASS。

## Test-only instrumentation isolation

构建脚本先生成 production `storage_native.node`，再以 `PS_STORAGE_TEST_HOOKS` 单独编译 `storage_native_test.node`。test control、fault seam、barrier 和 branch-counter exports 位于该 compile-time guard 内；production addon 明确测试为三个 test-control property 均 `undefined`。部分 passive internal resource counters 也编译进 production，但 production 不导出读取或修改它们的控制接口。公开 package entrypoint 不导出 test addon、polling diagnostics 或 controls；没有 environment/config/HTTP activation，没有返回 raw FD/path，也没有关闭或绕过 production validation 的接口。

## Memory、event loop 与 resource evidence

隔离 `--expose-gc` 子进程增量生成并消费 64 MiB synthetic original：

- total streamed：67,108,864 bytes
- maximum returned/native read buffer：262,144 bytes
- maximum active native work：1
- event-loop 1 ms heartbeat：最近一次独立测量 344 次（verification/read 期间持续运行）
- forced GC：在 active verify/read barrier 时执行，无 crash、premature close 或 use-after-free
- RSS peak growth after warmup：最近一次独立测量 2,867,200 bytes；该数值只作为本次 bounded-memory 证据，不作为通用上限
- operation wall time：最近一次独立测量约 417 ms，只记录信息，不设置脆弱的 throughput deadline

256 MiB optional case 本轮未运行；64 MiB required gate 已通过。

macOS `/dev/fd` 枚举覆盖 100 次完整成功消费与 100 次 early-return cancellation；settlement 后 FD count 不高于基线 +2，native original ledger 精确增加 open 200 / close 200，active work 回到 0，无线性增长。另有 VERIFY/READ environment teardown 各 10 轮，每轮 live context、owned FD、active work 和 original open/close ledger 均平衡。

## Bounded polling evidence

真实 verification pthread 到达 VERIFY barrier 后保持约 1.5 秒，父测试不提前释放。旧实现测得约 113,190 polls、239.693 ms CPU、ELU 1.0；bounded polling 最近一次独立测量为 93 polls、27.015 ms CPU、ELU 0.0167，并有 140 次 10 ms heartbeat。确定性 gate 要求 polls ≤250；CPU <150 ms 与 ELU <0.75 只用于识别接近旧 scheduling storm 的明显回归，保留较大机器差异余量，不作为性能承诺。operation settlement 后再观察 50 ms，新增 poll 为 0。

结构测试证明：同步完成不安排 timer；第一次未完成只经过一次 `setImmediate`；持续 pending 的序列为 `immediate, 1, 2, 4, 8, 16, 16…`；连续两个 native operation 都从快速阶段重新开始，且任一时刻最多一个 scheduler wait。polling 只观察当前 operation，不启动下一次 read 或 prefetch。Worker teardown 仍由 native cleanup cancel/wake/join 完成，不依赖 immediate、timer 或 Promise settlement。

## Existing behavior regression

现有 `withVerifiedOriginal()`、`VerifiedOriginalHandle`、`consumeForFixedProbe()` 的 transfer ownership 与 fixed-child probe/parser/renderer 路径未改成新 API。相关 6 个 test files 在外层 Codex sandbox 之外按其自身 macOS sandbox 要求运行，预计 87 tests；完整 non-DB `unit` project 的最终 evidence 必须在本文最后修改后重跑。

## Validation

- native addon build：PASS
- 6D1 targeted：2 files / 23 tests PASS
- bounded busy-poll：93 polls / 1.5 s，settlement 后 residue 0，PASS
- VERIFY/READ real Worker teardown：各 10 轮 PASS
- 64 MiB async/GC/memory：PASS
- fixed-child / probe / parser / renderer regression：6 files / 87 tests PASS
- `pnpm lint`：PASS
- `pnpm format:check`：PASS
- `pnpm typecheck`：PASS
- complete non-DB `unit` project：88 files / 650 tests PASS
- `pnpm build`：PASS
- `git diff --check`：PASS

Aggregate `pnpm test` 不运行，因为该脚本同时包含 write-capable DEV MySQL integration project；本 remediation 明确不要求 MySQL/E2E。完整 unit project 将显式运行，不允许 silent skip。MySQL integration/race 与 E2E 均为 **NOT RUN / OUT OF SCOPE**。

## Migration、scope 与 decision

- DB/API/contracts/public-share/schema changed：NO
- 0006 SHA-256：`533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`
- 0006 changed：NO
- 0007：absent
- 独立复核状态：最终独立安全复核 PASS；busy-polling finding 与 documentation instrumentation wording finding 已 CLOSED；P0 = 0，P1 = 0，剩余新 Phase 6D1 P2 = 0，剩余新 Phase 6D1 P3 = 0

继承项目的 production/Phase 4 P2/P3 保持不变：uid-mismatch/cross-device production fixture、verifier production deadline 与 DEV fixture 差异、identical sealed temp 不自动进入 READY、storage `READ_ONLY` 时 derived serving 返回 503，以及 production deployment / power-loss / SSD-disconnect / rate-limit / durable-audit 验证。本 slice 没有扩大或宣称关闭这些项目。

`PHASE_06D1_ENV_ASYNC_MECHANISM_CHANGE_REQUIRED: YES — COMPLETED`

`PHASE_3_STORAGE_REDESIGN_REQUIRED: NO`

`SAME_FD_VERIFICATION_AND_STREAM: YES`

`WHOLE_FILE_BUFFERING_USED: NO`

`PATH_REOPEN_USED: NO`（final confinement 只重开目录；original reopen 为 0）

`READ_CLOSE_RACE_SAFE: YES`

`GC_LIFETIME_SAFE: YES`

`PHASE_06D1_COMPLETE: YES`

`READY_FOR_PHASE_06D1_CHECKPOINT: YES`

`PHASE_06D_COMPLETE: NO`

`PHASE_6_PRODUCTION_READY: NO`

`READY_FOR_PHASE_06D3: NO`（Phase 6D3 尚未开始）
