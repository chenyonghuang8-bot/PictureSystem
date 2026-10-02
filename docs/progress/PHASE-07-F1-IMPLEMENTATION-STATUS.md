# Phase 7 F1 — current implementation status

2026-10-02 UTC。HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640` + working tree。**INIT1 已实施；独立 Astra limited closure CLOSED / PASS，原 F1 P1 与初始化 P2 均关闭。** 正式结果见 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md`；closure 后完整 gate 的新结果统一见 `PHASE-07-MILESTONE-VALIDATION.md` 与 `PHASE-07-FINAL-SUMMARY.md`，不继承旧 milestone。Production Ready 保持 NO，不进入 Phase 8。

依据 `PHASE-07-F1-INIT-PUBLICATION-DESIGN.md` 的 APPROVED_FOR_SOL 协议。本轮仅落实明确 patch plan，保持用户指定 Sol Medium / Fast；实际模型标识无法可靠确认。原复核 finding 和被过滤中断的报告记录保留，不绕过过滤、不将本实现验收当安全签核。前状态原文保存在 ignored `init-publication/status-before-init1-implementation.md`。

## Current protocol

- V2 marker 保留原 ID 与 10 个身份字段，强制精确 `:INIT1\n`，无标签 V2、未知/重复/变体标签拒绝；V1 保留 legacy 识别但不授予 L/R/purge，不自动升级。
- fresh prepare 排他 mkdir 不存在的 final root，在 root inode 上持非阻塞 X；排他创建并 full-sync `.storage-root.initializing`，先 sync root，再创建布局/namespace 和严格 marker。
- marker 文件及命名目录同步、writer lock 排他创建/非阻塞锁定与属性/full-sync、布局验证、writable probe 清理、canonical path、响应对象构造和完整自检都在提交前完成。最后复核 root/marker/namespace、writer named/open inode 及本次 fence identity，执行最后必需 root sync。
- 只有精确 fence unlink 成功是提交点；之后不再安排必需磁盘写入/sync/验证，不 truncate marker、不重写 fence。unlink 前明确失败保留拒绝状态；unlink 成功后模拟响应错误/查询未知返回 `INIT_COMMIT_UNKNOWN`，只分类/关闭资源，不 replay/rollback。
- runtime `sm_read` 用 `openat(root, ".", ...)` 的独立 OFD 取得 nonblocking S，检查 fence 明确 ENOENT、严格 marker、再次 fence/root identity，释放自己的 S。不会转换业务 root FD/initializer X。fence 任意类型或 stat 不确定均拒绝。
- raw contents/namespace helper 只由 fresh 私有 context 自检和 gated reader 内部调用；没有 N-API/JS/env bypass。所有原 reader、coordination、purge、handoff 和固定 supervisor 继续经过共同 gated admission。release/close 仍可执行。

K、writer→L→R→CapacityGate 业务锁顺序、0007/schema/journal、SQL lease、权限/retention/recent-auth、每 K ledger/SCM_RIGHTS 消息均未改。补充 X/S 锁仅用于未发布 root 的本地初始化准入，非阻塞且不进入 DB 事务。没有操作现有 V1/无标签 V2 root、真实媒体、Production、服务重启或 home ACL。

## Fresh targeted verification

本轮 evidence 目录：`.cache/phase7-f1-design/init-publication/`。命令/结果/日志/源码与全部 native 产物 hash 见 `acceptance-evidence.json`、`checkpoint-manifest.json`。此前 249/195 或独立 69/79 的历史结果不继承为本轮 PASS。

| 验证                                                                                  | fresh 结果                                  | 日志                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| native build：production/test addon 与全部固定 helper                                 | PASS，exit0                                 | `native-build-final.log`                                     |
| namespace/INIT1、coordination、handoff、purge-derived、root、Original reader/download | 7 files / 194 tests PASS，skip0             | `storage-final.log`                                          |
| live DEV Phase7 purge/race/crash/unknown-COMMIT                                       | 1 file / 79 tests PASS，skip0               | `purge-dev-final.log`                                        |
| 实际旧 V1 与无标签 V2 addon → fresh INIT1 root                                        | 两者拒绝、marker 未变、owned container 删除 | `version-barrier-final.log`                                  |
| workspace typecheck                                                                   | PASS                                        | `typecheck-final.log`                                        |
| 相关 TypeScript lint/format + diff check                                              | PASS                                        | `lint-final.log`、`format-final.log`、`diff-check-final.log` |

命名 hook inventory 共 65 项，`boundary-results.json` 保存 192 次实际执行：61 个 precommit 边界分别 pause→error、pause→SIGKILL、pause→continue（183）；post-unlink/post-unlock 各 3 次（6）；明确 unlink 失败、unlink 成功响应错误、查询错误各 1 次（3）。initializer 使用 test addon，runtime competitor 是另一 OS process 的 freshly built production addon。各轮精确删除父进程 owned container 并验证不存在；不扫描其他 tmp。

原 pre-fsync 反例在 `marker_complete_pre_fsync` 被覆盖：并发 writer openRoot、pure Original reader 与 R-X 均拒绝；error/SIGKILL 后新进程仍拒绝；不自动修复。所有准备已同步但 pre-unlink 死亡仍拒绝。提交后 SIGKILL/响应丢失可在严格校验后重新打开；post-unlock 尚持 writer 的 initializer 期间，另一个 writer 仍正常冲突，但 pure reader/coordination 可准入，这是已提交状态。

验证实际目录 flock 跨进程 S/S、X/S 与同进程独立 OFD；关闭一次 reader/其中一个 S 不释放其它锁，失败的共享 reader 不转换/释放同进程 X。pre-unlink 同时加入第二 production fresh initializer，existing-path 必须拒绝，唯一 marker/namespace 不变。

fence reappearance 覆盖 regular/空/目录/symlink/坏权限、stat I/O seam、旧 guard acquisition、handoff 创建/注册、已注册真实 receiver 转交/settlement、物理 purge authority。原 namespace 移动/替换、cross-process active reader、handoff ledger、稳定 K/S/S/S/X 与 DEV purge 恢复矩阵继续通过。生产 addon 无 `phase7Test*` exports。故障 hook 只在 test 构建，用 owned IPC pipe，没有生产环境开关。

## Current closure and limits

1. 独立 GPT-6 Astra / Low 已核验最终 checkpoint，正式 closure CLOSED / PASS；101 项非文档源码/产物在 closure 后 gate 再次匹配。旧 NEEDS_FIX / PENDING 文档是历史审查状态。
2. 完整 milestone gate 和本地 checkpoint 状态以最新 `PHASE-07-MILESTONE-VALIDATION.md` / `PHASE-07-FINAL-SUMMARY.md` 为准。本页上方 194/79 是定向验证，和完整 gate 计数分开。
3. gate 暴露 storage production build 将测试纳入 rootDir，新增 `tsconfig.build.json` 排除 `src/**/*.test.ts`；只改变构建输入，不改运行代码、native 校验、schema/K/锁顺序。这个 closure 后配置差异没有冒充 Astra 已审字节，单列交接。
4. V1/无标签 V2 root 升级仍需另行授权维护；没有升级、adoption 或重启。SIGKILL/syscall seam 不证明物理断电、SSD 或硬件 flush。Production Ready NO。

```text
INIT_PUBLICATION_DESIGN: APPROVED_FOR_SOL
INIT1_IMPLEMENTATION: COMPLETE
INIT1_TARGETED_VALIDATION: PASS
ASTRA_LIMITED_CLOSURE: PASS
F1_P1: CLOSED
INIT_PUBLICATION_P2: CLOSED
FULL_MILESTONE_GATE: SEE_LATEST_MILESTONE_RECORD
PHASE_7_ACCEPTANCE: SEE_FINAL_SUMMARY
PRODUCTION_READY: NO
EXISTING_ROOT_UPGRADE: NO
NEXT_PHASE_STARTED: NO
```
