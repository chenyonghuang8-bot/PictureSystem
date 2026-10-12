# Phase 11 — DEV synthetic fixture retirement design

设计范围：仅本次已授权的 `family_album_dev` 合成夹具退休与新夹具初始化；不是旧部署恢复成功，不是 R1 closure。只读审阅依据：§7.1、handoff 最新暂停断点、`dev-control-harness.ts`、`retained-audit-fixtures.ts`、`phase11-instance-proof.ts`、control/run repository 与 Drizzle constraints。本文件不授权 Production、真实媒体、系统重启、schema migration 或改变产品准入。

## 结论与必要区别

旧 namespace/container 已不存在，不能调用 resume 后补建同名目录、伪造 inode/identity，不能在替代空媒体根上声称旧库存恢复。允许的是销毁精确合成业务夹具并退休其控制上下文，然后以新 UUID、新 namespace、新空 synthetic root 走原 bootstrap/recheck。新实例不得把旧 run 作为 CLEAN 前驱。

必须保留所有旧 operation、run/member、runtime、admin audit 行及审计 FK 图。保留 unknown 的含义是绝不把它改成功或删除证据；下面唯一允许的未知操作变化为 **PENDING→RECOVERY_REQUIRED，result_revision 与 finished_at 仍 NULL**，并持久保存前像。若要求 PENDING 枚举原值也绝不改变，则本设计不能实施：产品在 `system-run-repository.ts` 305/548/741 对全表 PENDING 计数，新部署自动启动/CLEAN 将持续拒绝；不能用 test registry 绕过产品检查，也不能悄改产品查询范围。

同理，旧 active runtime 仅在确切证明旧进程已消失后允许记录观测 STOPPED；它不代表正常退出、terminal ACK、CLEAN 或恢复已成功。前像与观测时间必须保留。要求所有 runtime 列绝对不变也与现有 insertMembers 对旧同角色行的 STOPPED 更新冲突。

## 1. 只读前置条件

- 固定数据库 `family_album_dev`、非 root 用户；只用一条 maintenance connection，无应用、runner、worker、metadata、codec 或其它 DEV connection 并行。不输出凭据/argv/private data。
- parent 已报告 OS boot time `1791766333`（2026-10-12 08:52:13 Asia/Shanghai），晚于旧部署全部 run/operation/job/runtime 时间（2026-10-08）。执行者应重读并绑定该值。**主机重启证明旧进程及其所有 native 后代已消失**；expired heartbeat/lease 本身不提供此证明。仍检查本次 boot 下无新实例、无其它 DEV 连接，无自动 runner 会启动。
- 只读 proof 拆为真实 OS/connection 观察与数据库 RUNNING job 观察。修正误报时不得忽略未知 Node、codec、cwd 无法读取或任意非祖先进程。普通 `assertNoPhase11DevInstances` 保持 RUNNING job 必拒；仅一次性退休工具在已绑定旧 boot、精确 job ID/前像的条件下接受这 5 行是待销毁夹具，绝不把通用 proof 改为按过期时间忽略 jobs。
- 严格验证 manifest 的 deployment `4c1fa415-a062-4b52-a9c8-acdc909e9400`、family `18964`/nonce、actor family `18965`及 user/member/session/grant 精确绑定。所有非退休业务只能属于 manifest 的 owned family；跨 family 引用、非 synthetic 名称、未登记主体一律拒绝。
- 重新验证当前 control 为同部署、READ_ONLY/RESUMING、revision 173、health 30、fault=true、run `60de28ac-4a69-4b0a-84ff-d8d57a21b5e9`、epoch 689；72 operations 的完整 ID/摘要集合与精确 PENDING `00aacda1-a561-4199-833d-fd867e6656ea`。数字只是本次预期，不得失败后自动刷新预期再执行。
- 哈希核对所有已有 retained-audit graphs。核实这次 family 的 purge intents 全部 DONE/COMPLETED，所有 media/object/upload/job 和关联行的闭包归属。不能只凭 55/55/60/60 行计数删除；保存精确 ID 集与无跨家庭引用证明。

## 2. 持久退休证据

在 `.cache/phase11-r1/` 写新的唯一 retirement UUID manifest；0600、临时文件 fsync→rename→目录 fsync。保留旧 manifest，不覆盖已有证据。内容仅必要 identity、时间、主机 boot、migration readiness、完整目标 ID 集、前像摘要、无实例证明、control/operations/run/member/runtime 的安全字段前像、预期后像；不包含 password/token/token hash/cookie、原媒体或 EXIF。DB 审计/历史完整摘要可在内存计算，仅保存 digest/count。

本 manifest 先标 PREPARED，不能冒充已提交。使用固定 retirement UUID 向现有 `admin_audit_events` 添加 `OUTCOME_OBSERVED`、SYSTEM/CONTROL、result `RECOVERY_REQUIRED` 事件，和下述 DB mutation 同事务，transition token 确定且唯一；它证明 DEV 退休观测，不宣称原 RECHECK 成功。旧 audit 行全不变。

## 3. 唯一受控事务（test-only 离线工具）

工具只可放 tests/helpers 或一次性明确 DEV script，不从 API/worker/package 公共 export 可达，不增 env force 开关。沿既有 checked transaction/connection discard/COMMIT unknown 规则；不得关 FK/check、不得重试 unknown。

1. 按现有 control→run→members 顺序锁定并比对精确 control 全前像；锁相关 operation/runtime 与 owned family/关联行，重新核对前像摘要和无额外行。这个工具与产品没有并发；DB row lock 不能替代 no-instance 前置条件。
2. 按现有 retained-family FK 顺序删除 **family18964 的精确 synthetic 业务闭包**，包含这 5 个旧 RUNNING jobs。不先伪造 job DONE、不重排队、不 claim/replay、不恢复 Original；这叫销毁测试夹具，不叫成功处理。保留 audit_logs、完成 purge_intents/purge_files、family/member/user FK 祖先。purge 未完成或引用不闭合就回滚。
3. 旧 PENDING operation 精确 CAS 为 RECOVERY_REQUIRED、reason `RECOVERY_FAILED`，result_revision/finished_at 保持 NULL；其它 71 operation 不变。旧 ID、request fingerprint、actor/session/grant binding 全保留。这样记录“已证实无法恢复旧 namespace 的未知请求”，不决定旧副作用成功与否。
4. 三个精确旧 runtime：仅仍匹配前像且 exited_at=NULL 才记 state/reason STOPPED、exited_at=本次观测时间；received_at/last_successful_at/计数等原值保留。manifest 明确此时间为确认旧进程已消失的上界，非真实 exit time。旧 run/member **完全不修改**，不写 CLEAN_CLOSED/ACK/CLEAN/CONSUMED。
5. 删除精确合成 actor 与业务用户的 sessions、精确 grant，保留 actor family/user/member 作为退休控制证据身份。不自动授新 grant。若要删除 actor FK 祖先需另证没有历史身份需要；本次不需要删。
6. CAS singleton 回既有 DEV 测试初始化基线：zero deployment UUID、namespace NULL、current_run_id NULL、active_operation_id NULL、READ_ONLY/RECOVERY_REQUIRED、fault=true、NOT_INITIALIZED、revision=1、health_generation=1；**run_epoch 689 不变**，updated_at 真实当前时间。这仅复制既有 DEV harness 的 protected uninitialized reset，不向产品引入部署 reset API。保留旧 control 前像与所有历史。附加上述退休审计。

所有行数必须精确，任一不符回滚；不可通过扩大 selector 继续。如果 COMMIT unknown，只用 retirement event UUID、singleton 后像、完整目标集合与剩余行摘要只读确认全事务是否提交；未知仍停止，不换 UUID 重放。确认提交后才将 manifest durable 标 COMMITTED 并登记后像摘要。若本地登记中断，下次只能通过同 UUID 的权威 DB 证据补登记，不能重复业务删除。

## 4. 精确退休 allowlist 与新 bootstrap

现有 `DevControlHarness.create/cleanup` 全表计数不能直接忽略这些行。新增仅 test helper 使用的退休控制 registry，验证此次 72 operation 全行后像摘要、actor 身份、旧 runtime/run/member 后像摘要、业务 graph digest，以及 sessions/grants/live business 全零。验证后仅把这些 **精确 ID** 从 test baseline 的 other-family/operation 比较中排除；其余行仍 fail closed。不能按名字前缀、状态或时间泛豁免。cleanup 不得 DELETE 这些旧 operations，也不得覆盖其 registry。

普通 no-instance proof 此时自然看到 RUNNING jobs=0、active runtime=0；不需要永久放宽。新 harness 创建新 deployment/namespace/actor，新 run epoch 必须大于689；调用现有 provision/bootstrap 与实际 built API recovery，完整 required role set 加入。先 READ_ONLY，只有测试确有需要才按原 recent-auth/grant 请求 NORMAL。原 owner、DRAINED_X、fresh root/accounting/readiness、known commit 等检查全部保持。

后续测试必须核实旧 RECHECK 仍 RECOVERY_REQUIRED/NULL result/NULL finished，旧 run 未 CLEAN，所有旧行存在，旧审计前缀摘要不变；新 bootstrap/recheck 成功不替旧操作写 APPLIED。

## 5. 最低验证与停止条件

- test-only negative coverage：错误 DB、family/actor/boot/operation mismatch，新增 job/connection，retained digest 变化、非精确 ID、未知 commit 均不执行/不重放；registry 缺失或不完整不能放行基线。
- 实际 DEV：退休后 exact retention proof；真实新 bootstrap→READ_ONLY→必要的显式 NORMAL→原完整 set 正常关闭；新 run 才可 CLEAN，旧 run 仍非 CLEAN。再跑待修复的 phase8 lifecycle 定向测试。
- 之后按父任务继续 full gate 和 R1 独立复核。本设计不是 R1 通过，历史 FAIL/SKIP 保留。
- 如果不接受 PENDING→RECOVERY_REQUIRED 与观测 STOPPED 的明确语义，停止这条路径；不得将 registry 接入产品来隐藏旧 unknown。需要另一个经过审阅的分代历史存储/查询设计，本文件不批准它。

父任务已确认用户要求是保留未知结局与历史，而非 PENDING 枚举永不变化，并接受上述两项有前像与强死亡证明的精确记录变化。因此本次在既有完整恢复测试授权内可按此 patch plan 实施，无需新增 Production 或真实数据许可。actor18965采用本设计的严格退休登记：保留 family/user/member，撤销精确 grant/session；不会让普通业务 retained graph helper 因不匹配 p8/p10 前缀而泛放行。数据库 operations/admin audit 身份列本身没有强制这些 actor FK 祖先存活，但保留它们提供更强历史可核验性，不需要冒险复用原 cleanup 删除身份。本设计阶段没有执行任何 DB、媒体或业务 FS mutation。
