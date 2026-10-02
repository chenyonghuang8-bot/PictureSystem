# F1 initialization publication — historical design gap

> 历史 finding / 审查状态保留。原 F1 P1 与初始化 P2 已由 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md` 正式 CLOSED / PASS；后续 gate / 阶段状态见最新 milestone 和 final summary。本历史结论不再表示当前 open blocker。

此缺口已由 `PHASE-07-F1-INIT-PUBLICATION-DESIGN.md` 的 APPROVED_FOR_SOL 补充方案解决，并完成限定实现/定向验证。本文保留当时未批准的边界，不再作为当前缺少方案的判断；独立 closure 仍待完成。

2026-10-02 UTC。HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640`，现有 working tree 保留。本跟进未改实现/测试、未 build/test、未创建 fixture、未运行 DB、未 commit/push。不绕过 interrupted review 的安全过滤。

## Verified readable finding

当前 `storage_root_v2.h` 在 final `.storage-root` 上 O_EXCL 写入完整合法 V2 bytes，然后才执行 fsync、F_FULLFSYNC 和 root directory sync。`storage_marker.h` 的 `sm_read` 对完整但尚未同步的 bytes 没有初始化完成状态/跨进程准入屏障。

独立复核的 `closure-init-probe/result.json` 与 `probe.cjs` 保存如下事实：暂停在 full marker write / pre-fsync，production addon 并发 openRoot 和 R-X 都成功；SIGKILL initializer 后仍成功；resume-error 路径最终拒绝，但不能撤回错误发生前的成功准入。probe 使用 ignored native source copy 注入暂停，runtime 检查使用 production addon；其记录称 owned fixtures 已清理。本跟进读取证据，未重新运行该 probe，不把旧 69 storage / 79 DEV purge PASS 当作修复后验证。

## Missing approved decisions

可读 independent closure status 明确："The concrete repair design still needs Astra review; this status document does not authorize an invented implementation."

现有 coordination design 第 3 节允许 fixed temporary marker + no-replace publish 或 final O_EXCL write，并要求部分写/未知同步不能被 adopt；但没有批准以下具体规则：

1. 初始化的完成/可准入边界，以及 marker publish 与最终目录同步之间的并发 open/coord 行为。
2. 初始化与 runtime admission 的同步方式、所有入口如何检查，以及是否增加持久状态或 OS 锁；这不能只靠 initializer 返回成功或 JS flag。
3. initializer 在 marker 完整写入后、各同步边界、publish 前后被 SIGKILL 的未完成根行为；锁随进程死亡释放后，不能单凭当前 marker 完整就误判已完成。
4. 同步错误/未知结果是否允许既有 runtime capability，以及如何保持 fail closed 而不自动修复/adopt/删除不明文件。

这些是需要 Astra 作决定的缺口，不是本任务提出或批准的新方案。仅将 write 改成 rename 不能单独证明 publish 后/目录 sync 前的窗口关闭；仅增加进程内 flag 也没有跨进程/重启证据。选择同步锁或持久状态协议将触及项目 AGENTS 第 5 节的 transaction/locking/security invariant 设计边界。

## Required next input

GPT-6 Astra / Low 提供限定 publication/admission patch plan 和 interruption semantics，明确沿用或调整原已批准的临时 marker 选项，保持 V2 身份字段、K、DB/0007、权限/ACL、现有 writer→L→R→CapacityGate 顺序和禁止 existing-root upgrade。获批后 Fast 才落实，并新增真正跨进程 concurrent-open、resume-error、SIGKILL 各边界回归；重新 build native 并运行相关定向验收后再交独立 closure。

F1 CLOSED = NO；implementation acceptance = NEEDS_FIX；完整 milestone gate = NOT_RUN。本轮没有新的安全签核或修复后 PASS。
