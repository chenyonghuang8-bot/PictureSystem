# Phase 7 F1 — INIT1 independent closure handoff (historical request)

**状态更新：独立限定 closure 已 CLOSED / PASS，见 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md`。以下是当时提交审查的原 handoff，PENDING/未关闭措辞已被正式 closure 取代；后续完整 gate 见最新 milestone / final summary。**

2026-10-02 UTC。请 GPT-6 Astra / Low 对完整 F1 working tree 做限定独立 closure，重点复核批准的初始化补充方案。HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640`，未 stage/commit/push。F1 未 CLOSED，Phase7/Production Ready 未完成。本实现方不进行安全终审，不绕过被过滤中断的历史 reviewer 报告。

先读 INIT-PUBLICATION-DESIGN（APPROVED_FOR_SOL）、当前 IMPLEMENTATION-STATUS、原 coordination design 和 independent closure status，再核对新 evidence 目录 `init-publication/checkpoint-manifest.json` 与真实 tracked/untracked diff。旧 `checkpoint-manifest.json`/acceptance 日志是无标签 V2 的历史 checkpoint，不是当前源码 manifest。

## Concrete implementation to review

- `storage_marker.h`：INIT1 是 mandatory strict discriminator；gated `sm_read` 在独立 root OFD 的非阻塞 S 下，前后要求 fence 明确不存在，验证 marker/identity，再释放自己的锁。所有 addon/fixed-supervisor reader 仍从统一入口走；raw contents/helper 没有公开 bypass。
- `storage_root_v2.h`：仅 fresh exclusive mkdir 的私有 context 能 raw 自检；持 root X、排他 durable fence、布局和 marker 全同步。context 复核 named root/namespace/marker/fence/writer，fence close 错误与最后 root sync 仍在提交前。
- `storage_native.c:open_root`：existing-path admission 在 writer creation/probe 前；fresh 后半段 writer bootstrap、layout/probe、canonical/N-API 构造都在 fence commit 前；writer FD 在 context 中只为自检，不改原业务锁。失败资源清理处理 N-API external ownership，不 double-close/free，不写 rollback。
- 成功 fence unlink 是唯一提交点。unlink failure 只查 fence 分类，不 replay；明确 fence 仍在则拒绝；fence 不在或 query 不确定返回 INIT_COMMIT_UNKNOWN，不向该调用返回 capability，关闭资源，无磁盘 rollback。postcommit 不再有必需 write/sync/verification。
- 原 namespace 锁域 binding、purge 紧邻 mutation 的 authority、handoff root/v1 FD 和 registered supervisor 转交/settlement 的共同验证保持。新 fenced root 的 old/new capabilities、pure reader、handoff 创建/注册/发送/settlement 和物理 purge 都有直接回归。

## Fresh evidence

目录 `.cache/phase7-f1-design/init-publication/`；具体命令/exit/hashes 见 `acceptance-evidence.json`。

| 项目                                            | 结果                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| final rebuild 所有 native addon/固定 helper     | exit0；`native-build-final.log`                                                              |
| 定向 storage                                    | 7 files / 194 tests PASS、skip0；`storage-final.log`                                         |
| live DEV Phase7 purge/race/crash/unknown-COMMIT | 79 tests PASS、skip0；`purge-dev-final.log`                                                  |
| 实际旧 V1 + 修复前无标签 V2 addon 拒绝 INIT1    | PASS；`version-barrier-final.log`                                                            |
| typecheck / 相关 lint/format / diff-check       | PASS                                                                                         |
| 65 named hooks / 192 executions                 | `boundary-results.json`，全部有 action、退出、并发 admission、后续 admission 和 cleanup 结果 |

61 precommit boundaries 全部执行 pause→error、pause→SIGKILL、pause→continue。每个 runtime competitor 是独立 OS process，使用新 production addon；initializer 是 test addon。原 full-write/pre-fsync、marker fsync/fullsync/root sync、writer/probe、final sync/pre-unlink 均覆盖。pre-unlink 第二 fresh initializer 拒绝，不改原 marker。post-unlink/pre-unlock 死亡后可接受；post-unlock/pre-response 时 pure reader/coord 可接受、另一个 writer 因原 writer 锁暂时冲突，进程退出后 root 可重新打开。

三类 unlink 测试分别证明保留 fence 的明确失败、实际 unlink 成功后响应 EIO、query EIO；后两项返回 INIT_COMMIT_UNKNOWN 且无 truncate/rewrite/replay，后续严格 runtime 准入可接受。它们是 test-only syscall/error seam，不冒充实际硬件 EIO。SIGKILL 测试不冒充断电。

实际 root-directory flock 验证跨进程 S/S、X/S；同进程独立 OFD 的 gated read 失败不会转换/释放 X，关闭一个 S 不释放其它 S。fence 任意类型/属性、stat uncertainty 均拒绝；源 R 关闭后 registered receiver 遇到 fence 不发送新 FD/伪造 settlement。原 namespace/ledger replacement 反例和 purge 恢复保持。

## Scope and preservation

本轮仅新增修改：marker/fresh header、openRoot 生命周期、namespace/handoff 测试与关联文档。原其他 working-tree 修改保留。无 0007/schema/journal/K/业务锁序/SQL lease/权限/retention/ledger-message 变更。0007 hash 仍 `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`；Web runner hash 仍 `64507cedca904c655b9d479f1e4662920df61c516d9f786392229ecf346f21ef`；无关 Web AGENTS/CLAUDE 保留。

所有 root/媒体只来自本任务 owned 系统临时容器，当前矩阵精确删除 owner 并验证不存在；没有扫描其他 tmp、真实媒体、已有 root 升级、配置更改、服务重启、ACL 放宽或 Production 操作。V1/旧无标签 V2 运行资格维护仍是独立未授权 slice。production addon 不导出 test hook。

目标是 CLOSED 或具体 NEEDS_FIX；实现/测试 PASS 不自动构成签核。完整 milestone gate 由主线程在限定 closure 后统一安排，本轮 NOT_RUN，历史通过不继承；不进入 Phase8、不 commit/push。
