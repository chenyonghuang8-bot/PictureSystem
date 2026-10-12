# Phase 11 R1 定向独立关闭复审 — 2026-10-12

## 结论

**R1: CLOSED。NEW_P0: 0；NEW_P1: 0（仅本报告限定审查范围）。**

原 `PHASE-11-INDEPENDENT-REVIEW.md` R1 的“native deny marker 与 DB latch 同时失败后，新进程可依据旧 NORMAL 自动获得写准入”已由持久 run/成员关闭证明、启动消费协议与对应真实回归关闭。本结论取代原报告的 R1 阻塞状态，不重写历史失败，不等于全仓重新审计、Production ready 或授权进入 Phase 12。

审查覆盖原 R1、§7.1 启停/准入/COMMIT unknown 直接实现、本轮 negative-exit 测试、DEV 夹具退休与受控 Web 启停/finalization。复审只读源码、指纹、持久日志及既有收尾证据，另新增本报告；没有重跑测试、启动 Node/native/CUA、连接或修改数据库、读取真实媒体、执行 Git 操作。

## 候选与证据绑定

- 工作树基准 HEAD：`209b8d36e4a9337ee6c9975878f6031e52a62ace`。本次审查对象是指纹绑定的工作树候选，不声称这些改动已提交。
- 输入指纹：`docs/progress/PHASE-11-IMPLEMENTATION-CURRENT-FINGERPRINT.json`，captured `2026-10-12T07:57:12.530939+00:00`，本次读取时 SHA-256 `1966bc3c35dc6dbd2e6cd4b33a5aa7c9c81822d3f31b56d0274b48c92ecfea0e`。
- 独立用 `shasum -a 256 -c` 核对指纹中的175个scope文件、71个构建/native产物及12份当前持久gate日志，**258项匹配，无不匹配**。另外核对最终runner、DEV proof、两个retention registry，全部匹配。
- 最终runner：`.cache/phase11-r1/resume-20261012-final-6-run.json`，run ID `5bef884b-4e38-4eac-b473-c56fdbbb0b60`，SHA-256 `211dcfda1bde7572b5c1339a4a98e26b56ecf33a83b6ddc974a66dcaf4ed8da7`，状态PASS，结束于 `2026-10-12T07:55:43.710738+00:00`。
- 日志持久目录：`.cache/phase11-r1/final-20261012-evidence/`；不依赖 `/tmp` 继续存在。

输入指纹仍写“closure pending”，因为它在本报告之前采集。父任务可将状态更新为本报告结论，并记录新的指纹文件hash；本报告上述hash固定绑定审查输入，不循环声明自身已被旧指纹覆盖。

## 原 R1 为什么关闭

1. `packages/db/src/system-run-repository.ts` 的 `begin()` 仅在完整匹配 CLEAN、成员 CLEAN_CLOSED manifest、配置/namespace/协议、control revision/health/mode以及无PENDING时消费前驱。旧 ACTIVE/PREPARING/STOPPING或未知记录均不能成为自动恢复依据。新run先持久登记，再可能激活；双失败即使没有deny文件且DB仍NORMAL，旧run也没有CLEAN证书。
2. `readAdmission()` 用同一查询绑定 current run/epoch、精确本进程boot/member、READY/fresh状态、配置及ACTIVE，才签发内部run proof；`DeploymentAdmission`在S下读取该证明并保留mode/fault/marker/local-deny限制。`join()`拒绝新进程加入旧ACTIVE，也不能替换已有角色。新进程不继承旧进程内存许可。
3. `ManagedControl` 在任何write能力前持原run.lock；native owner验证同时绑定OS boot/PID/start incarnation及锁记录。native `operation_gate.h` 在bridge未证明settled时关闭私有RAW_X，不把它交给TS层作为DRAINED_X。
4. API关闭先停准入、HTTP与实际工作排空；worker/metadata同样join工作与control回调后关闭资源。`resourcesClosed()`只在成功、无local fault且已stop时ACK；`clean()`还要求STOPPING、全配置成员CLEAN_CLOSED、STABLE/no fault/no pending及实际DRAINED_X/无deny。runtime STOPPED、超时或单独callback成功均不能代替这些证明。
5. BEGIN/ACTIVE/STOPPING/ACK/CLEAN的lost COMMIT通过相同operation/fingerprint的权威观察确认，不盲重放。失败/未知无法证明时仍保留非CLEAN；授权fresh RECHECK与显式NORMAL继续分开。

原双失败重现场景现在有真实native FILE_FSYNC/TEMP_CREATE故障、真实MySQL TCP断连、原进程退出及新built API写入503→fresh RECHECK后仍READ_ONLY/503→显式NORMAL才成功的直接覆盖；并非只靠健康probe推断安全。

## 验证证据及适用性

| 验证 | 已核对结果 |
| --- | --- |
| 完整unit | 148文件，1381 PASS，0 FAIL/0 SKIP；final-2日志 |
| 完整build | exit0；final-2日志，当前构建产物hash匹配 |
| 退休helper定向unit | 11 PASS；final-6日志 |
| 新Web harness窄范围tsc | exit0；不将旧suite宽范围类型诊断冒称PASS |
| Format / root Lint / workspace Typecheck | final-6均exit0 |
| 实际API E2E | 5 PASS；final-4日志 |
| 独立严格DEV HTTPS Admin | 3 PASS；final-4，包含真实BFcache路径 |
| 完整Web E2E | 5 suites共30 PASS：10+10+1+6+3；final-6，四个旧suite均有外层FINALIZATION_PASS，Admin走原独立生命周期 |
| 无过滤真实DEV MySQL integration | 50文件，541 PASS，0 FAIL/0 SKIP，exit0；final-6日志总Duration 1301.17秒 |

完整unit/build继承final-2，API/独立Admin继承final-4；runner逐项记录原时间、exitCode、inheritedFrom及适用性，没有把这些阶段说成final-6重新执行。将final-2 source baseline与当前交集比较，差异为生成的 `apps/web/next-env.d.ts`、Web runner、retained-helper类型引用及phase8 integration测试；R1产品实现与其unit未变化。新增/后改测试生命周期helper有当前窄tsc、helper unit、完整Web和integration验证。此继承边界可接受，不据后改测试代码虚构之前运行结果。

定向矩阵源码与无过滤collection配置已核对：`phase11-run-double-fault`、`phase11-run-failure-boundaries`、`phase11-built-run-commit-loss`、`phase11-run-commit-observation`、`phase11-run-certificate-drift`、`phase11-full-process-set-restart`、`phase11-marker-durability`、`phase11-media-health-recovery`全部位于integration默认glob，未发现only/skip过滤。日志采用汇总输出，因此本结论将其覆盖绑定到无过滤命令、配置/文件指纹及50文件541项完整PASS，不捏造日志中没有逐条打印的用例结果。

## 本轮直接修复与恢复边界

- phase8 `stop()`对自然已退出child也核对exitCode；仅已验证join的child可重复返回。两个故意拒绝案例停止后按原run ID核验RECOVERY_REQUIRED、clean_at NULL、无RUN_CLEAN_CLOSED audit。正常退出仍要求0，负向1没有泛化为成功退出。
- DB发布构建仅排除新增退休helper测试以避免跨rootDir产物；unit与常规typecheck仍收集该测试。产品准入未因该修正改变。
- 受控Web由同一supervisor拥有真实API/DERIVATIVE/METADATA集合，达到真实RO/ACTIVE后通过原授权请求NORMAL；每suite独立部署。worker先真实RO排空，再清理自己的synthetic业务。
- Playwright内回调只在真实join/exit0/CLEAN后写CLOSED_AWAITING_INSTANCE_PROOF。外层等待CLI退出，重新执行原严格无实例、精确CLEAN revision/health/config/时间、全局pending0及业务/能力零残留检查，才h.cleanup和owned root清理。已APPLIED且result revision不晚于current的active pointer按原协议接受，不把未决pointer当成功。
- 最多5秒等待只重复原strict proof；时间本身不提供通过结论，不加进程豁免、不杀测试timeout。FINALIZING/BASELINE_RESTORED中断不会自动重放。最终四份旧suite receipt均FINALIZED，API-only为[0,null]，完整集合为[0,0]。
- 已审批lost-namespace DEV退休保留72条旧operation及原run/member/audit；指定PENDING仅记RECOVERY_REQUIRED，不填成功结果。另一条匿名BOOTSTRAP未知记录单独登记，共73条精确退休operation。registry只供test baseline识别历史，不进入产品准入。
- Gallery公开synthetic隔离严格限制2份Original和4份Derived，原root/namespace未替换，Original没有覆盖改写。隔离记录标明DRAINED_X、publicSyntheticOnly、no overwrite；公开source SHA/size明确。字节与身份档案独立保存于 `.cache/phase11-r1/gallery-public-synthetic-quarantine-20261012`，不随owned root cleanup删除。随后真实恢复/新CLEAN/outer finalization，不补造旧退出证据，不把历史失败改成PASS。

## 最终DEV收尾与保留证明

`.cache/phase11-r1/resume-20261012-dev-proof.json` captured `2026-10-12T07:56:05.878Z`，晚于所有最终gates；SHA-256 `d10b62313ab17537e05fbe9233744a1aa7417fbac6a4f689b095856550119832`。本复审核对该已完成证明及其hash，没有再开DB重复证明。

- readiness12；实际仓库实例0、其它DEV连接0、RUNNING jobs0。
- protected baseline：zero deployment、namespace/current run NULL、READ_ONLY/RECOVERY_REQUIRED、fault=true、revision/health=1、NOT_INITIALIZED，单调epoch882。
- 业务media/object/upload/job/derived/album/placement/invitation均0；grant/session/active runtime均0。
- 20个已验证退休家庭、44个对应用户、13个DONE purge；73条退休operations、7971 admin audit、62 lifecycle audit、1302 runtime历史、882 run历史保留。
- 原395条audit前缀、77个历史boot均保留；不存在通过删除历史“凑零”的成功声明。

本轮发现的预执行后像核验、完整退休live表检查、自然退出断言及Web根删除前业务证明缺口均已修正，并有相关定向/完整回归。限定范围内没有未关闭P0/P1。

## 限制与下一步边界

真实断电、真实SSD拔除、Production部署与存储验证、真实Android/家庭设备验收仍为 **NOT_RUN**。native故障注入、TCP断连与synthetic目录故障不替代这些实物验证。现有其它阶段P2/P3不在本次重新审计范围。

父任务可据此更新R1状态和Phase11交接/验收材料；本报告不自动批准Production、不创建tag/commit/push，不授权进入Phase12。
