# Phase 7 F1 / INIT1 — 独立限定 closure

2026-10-02 UTC；GPT-6 Astra / Low。审查基线为 HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640` 加当前未提交 working tree，源码/产物 checkpoint 见 `.cache/phase7-f1-design/init-publication/checkpoint-manifest.json`。

**结论：CLOSED / PASS（限定原 F1 与初始化发布补充缺口）。原 P1 F1 和初始化窗口 P2 均关闭；本范围没有发现剩余 blocker 或新的 P0/P1。** 此结论取代旧 independent-closure-status 的 NEEDS_FIX，以及 implementation-status/handoff 的 PENDING，限于本文核验的 checkpoint；不是全仓安全签核，也不是 Phase 7 完成或 Production Ready。

## 范围与核验方式

读取 AGENTS、批准的 coordination / INIT-PUBLICATION 设计、当前 implementation-status/handoff 和 acceptance evidence；检查真实 tracked diff 与新增 marker/fresh-root/test 文件。重点逐条检查 root 初始化、统一 marker admission、协调锁、purge authority、handoff 与固定 supervisor。没有重做全仓审计，没有改实现或测试，没有 stage/commit/push。无关 Web AGENTS/CLAUDE 与既有 launcher 修改保留。

核对 checkpoint 的 source/artifact 与 acceptance 日志，共 116 个 SHA-256 全部匹配；checkpoint 自身 SHA-256 匹配 acceptance 记录。独立复跑后再次检查源码与 native 产物，无漂移。没有把历史构建或其他 checkpoint 的测试计数借作当前结果。当前 fresh build 的 production/test addon 和固定 helper 均在匹配产物清单中；本轮未额外重复编译。

## 关键判断与证据

| 性质 | 源码判断与直接证据 |
| --- | --- |
| 固定唯一 namespace，原 F1 不再重建新锁域 | `storage_marker.h:sm_validate_namespace` 将当前 marker、root 命名路径、`.coord/v1` 的 dev/ino/birthtime/属性与持久绑定及旧 FD 共同比较；coord runtime 无 mkdir 顶层 namespace。`phase7_coordination.h` 在 lock 前后及返回前复核。独立测试覆盖旧/new handle、新进程/restart、活跃跨进程 R-S 下 v1/coord 缺失、空替换、复制和 symlink；拒绝且原锁域原样放回可恢复。 |
| 完整 marker 尚未同步不可准入 | `storage_root_v2.h:sm_init_prepare` 排他 mkdir 后持 root inode X，先持久 fence，才创建布局与 marker；`storage_native.c:open_root` 的 writer/bootstrap/probe/N-API 对象准备也在提交前。原 `marker_complete_pre_fsync` 处 production addon 的另一 OS process writer、pure reader、R-X 均拒绝；error/SIGKILL 后仍拒绝。 |
| 准入一致且不转换 initializer 锁 | `sm_read` 从独立 OFD 取得非阻塞 S，前后要求 fence 明确 ENOENT，严格 marker 读取后释放自己的 S。`read_marker`、namespace、record/supervisor 均经它。raw helper 调用仅存在于 gated 实现和 fresh 私有 context。目录 flock 的 X/S、S/S 与独立 OFD 关闭行为实际通过。 |
| 完成点与失败语义一致 | `sm_init_commit` 在所有必需同步、自检、fence close 后 unlink；成功 unlink 才提交。pre-unlink kill 仍拒绝；post-unlink/post-unlock kill 或响应失败后允许严格重开。unlink 明确失败保留 fence；成功后模拟响应 EIO、query EIO 返回 INIT_COMMIT_UNKNOWN，不 replay/rollback。提交后没有必需磁盘写入或同步。 |
| 运行期不采用半成品、不自动修复 | existing-path fresh mkdir 拒绝；普通 open 在 writer/probe mutation 前 admission。fence 任意类型或 stat uncertainty 拒绝；缺/坏 marker、无标签 V2 均拒绝；没有自动删 fence、补 namespace 或升级 V1。 |
| handoff 不丢失绑定 | handoff 保留 root/v1 FD 和 marker；创建、注册、发送、settlement 及固定 supervisor 记录读写/实际转交前共同校验。独立测试包含 source R 释放后 registered receiver 遇到 v1/coord/fence 异常，不发送新 FD、不伪造 settlement；真实 transfer 后 namespace 移动保留 unresolved ledger。 |
| 拒绝不触媒体、不放账 | `pg_authority` 经 L/R file 校验重新验证 namespace，并紧邻 quarantine/unlink。合成 Original 在已取得 guard 后替换 namespace/fence 的 native 测试中保持字节、inode且无 `.purge`。live DEV coord-before-claim / before-physical 测试验证 releasedBytes=0、文件保留、无伪成功 audit；原恢复/unknown-COMMIT 回归通过。 |
| parser 与版本屏障 | INIT1 精确后缀；长度、NUL、数字溢出/前导零、未知/重复标签/尾随等拒绝。现有旧 V1 与未修复无标签 V2 addon 拒绝 INIT1 的日志及 hash 已核实；独立 strict parser/runtime 回归通过。K 未增加 INIT1 字段。 |

`packages/db` / `database` 无 diff，0007 hash 保持 `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`。业务 writer→L→R→CapacityGate 顺序、SQL lease、schema、ledger/message、权限/retention 均未改。root X/S 是批准的非阻塞初始化准入协议，不替代业务锁。

## 独立复跑

证据目录：`.cache/phase7-f1-design/init1-independent-closure/`。

| 命令/核验 | 结果 |
| --- | --- |
| `pnpm exec vitest run packages/storage/src/phase7-namespace.test.ts packages/storage/src/phase7-coordination.test.ts packages/storage/src/phase7-handoff.test.ts packages/storage/src/purge-derived.test.ts --reporter=verbose` | 4 files / 146 tests PASS，skip=0，exit=0；`storage-native.log` |
| 上述 namespace 中命名初始化边界 | 65 hooks / 192 executions；61 precommit × error/kill/continue、2 postcommit × 3、3 unlink 分类；`boundary-results.json`，全部记录 cleanup=true |
| `pnpm exec vitest run tests/integration/phase7c-purge.test.ts --reporter=verbose` | live family_album_dev，1 file / 79 tests PASS，skip=0，exit=0；`purge-dev.log` |
| `git diff --check` | PASS |

初次默认沙箱复跑因 `proc_pidinfo` 无法识别自身而出现 handoff 错误及超时，主动停止，exit=130；`storage.log` 保留，不算 PASS。经自动审批允许在 native API 可用环境运行完全相同测试，得到上述正式 PASS；没有弱化 native 策略。测试使用现有自创 tmp 合成 fixture 和 DEV 自有记录/清理；未读真实媒体、扫描其它 tmp、操作现有 root、改 home ACL 或重启服务。初次被中断进程的 exit cleanup 不额外宣称已逐个外部核验；不为追查它扫描其他临时目录。正式矩阵明确核验自己创建的容器删除。

测试本身会覆盖 implementation 的 `boundary-results.json`；本轮已将独立结果存入独立目录，再恢复原验收文件的确切 bytes，原 acceptance hash 保持有效。原实现报告的 fresh native build、7 files/194 storage、79 DEV、type/lint/format 已核对日志和 hash，和本文独立 146/79 计数分开记录。

## 剩余条件（不延长本轮 closure）

1. 主线程仍须对最终工作树运行一次完整 milestone gate：format、lint、typecheck、unit/API、全 DEV integration/MySQL race（skip=0）、native fault/crash、API/worker/web builds、E2E。本轮未跑完整 gate，不继承旧 milestone PASS。
2. 现有 V1/无标签 V2 的运行兼容升级是另行授权维护 slice；禁止自动 adoption/重写 marker、升级现有根或重启已有服务。fresh INIT1 closure 不代表现有部署已能运行。
3. SIGKILL 和 syscall seam 不证明真实断电、SSD断连或硬件 flush；fence 在物理崩溃后重现时保守拒绝，可用性维护仍保留。既定同 UID 管理员完全伪造 root/二进制、完整镜像回滚不在本次威胁承诺内。本轮无新增非阻塞改造建议。

用户执行停止条件仍有效：额度耗尽或确认重置即停止，不用 reset/额外付费；最迟 UTC 2026-10-02 18:00（北京时间 10 月 3 日 02:00）停止，后续需再授权。本轮完成前未观测到耗尽或可验证重置。

```text
F1_P1: CLOSED
INIT_PUBLICATION_P2: CLOSED
LIMITED_INDEPENDENT_CLOSURE: PASS
REMAINING_BLOCKERS_IN_REVIEWED_SCOPE: NONE
FULL_MILESTONE_GATE_AFTER_COMPLETE_FIX: NOT_RUN
EXISTING_ROOT_UPGRADE: NOT_PERFORMED
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
IMPLEMENTATION_MODIFIED_BY_REVIEWER: NO
STAGE_COMMIT_PUSH: NO
```
