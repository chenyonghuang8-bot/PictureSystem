# Phase 11 Admin — implementation guardrails

2026-10-07；设计基线 `209b8d36e4a9337ee6c9975878f6031e52a62ace`。本文件是用户授权的直接 Codex 高风险设计与一次 Sol 实施交接。实现前由父线程核对本文件；不依赖 Bridge/WebGPT。当前任务只产生设计文档，没有创建 schema、执行 migration、切换运行模式、授予真实账号权限或运行测试。

## 1. 范围裁定与完成定义

按 ROADMAP Phase 11 的十项完整实施：member management、storage usage、media counts、worker status、backups、integrity status、trash、audit、maintenance mode、read-only mode，包含 PROJECT §19 的各成员上传量、DB 与系统健康。**维护与只读必须可操作、持久化、跨进程生效、故障后安全恢复；只有状态卡片不算完成。** 原 Sol 计划的“只显示状态/再询问是否实现开关”不再有效。

Phase 13 的备份/恢复 engine、Phase 15 的周期完整性扫描仍不提前实现。本期有真实状态契约及接入点；没有引擎或权威记录时返回 NOT_CONFIGURED/NEVER_RUN/UNKNOWN，不能造最近成功时间、显示绿色正常或提供无效“立即备份/修复”按钮。FCM/通知按用户批准延期，**健康检查、故障锁存、只读保护及后台可见告警不延期**。

交付是完整 DEV Admin 工作台、既有成员/邀请与 Trash 动作、受限统计和审计、系统健康采集及维护/只读控制、相关 migration/测试/独立复核和完整 Phase gate。Phase 10 签包/家人真机/外网部署延期不阻止本期本地工作；不借本文件授权 Production、真实媒体、公网或真实账号的系统权限扩大。完成 Phase 11 后停止，不自动进入 Phase 12。

## 2. 实际源码依据

- `apps/api/src/phase1c/routes.ts`、`packages/db/src/phase1c-repository.ts`、`packages/permissions/src/index.ts:129` 已实现成员/邀请权限和事务。ADMIN 只对 MEMBER 做允许的管理；角色变化仅 SUPER_ADMIN 按现行 API 执行；自身和 SUPER_ADMIN 目标保护不变。
- `apps/api/src/index.ts:140` 起的启动 probe/reconciliation/CapacityGate 与 `:254` 起 DEV pipeline；runtime 中复用 OriginalReader、唯一 DerivedStore、UploadPipelineReconciler、ImageDerivativeDriver。不能为 Admin 再开一个存储 writer。
- `apps/worker/src/index.ts` 是独立 purge owner 入口，注释及 native writer 锁明确禁止与 API writer 并存；`metadata-main.ts` 是单独只读 original / 写 metadata 的进程。所有入口都要接入本设计，不可仅在 HTTP route 挡一次。
- `packages/storage/src/index.ts:1996` 的 probe 接受 readOnlyReason，但 capability 是局部对象；`apps/api/src/uploads/service.ts` 有局部 READ_ONLY。它们不是持久全局控制，不能用一次赋值替代全局屏障。
- `packages/storage/src/phase7-coordination.ts`/native phase7 coordination 已有 S/X 锁、身份校验、注册 child handoff；可复用其安全原语，但不能拿某一媒体内容的锁冒充系统控制锁。
- `packages/db/src/capacity-transaction.ts` 规定 root-local capacity lock 在前，DB named lock 与 SQL transaction 使用同一 checked connection，回调禁止文件系统变更；`transaction.ts` 的 bounded deadlock retry、rollback failure discard、COMMIT unknown 不 replay 必须保留。
- `packages/db/src/schema.ts:1111` 的 audit_logs 专为 Trash/purge，media/storage identity 必填；不能靠塞虚假 media ID 扩为成员或系统审计。

## 3. 权限与披露：两个作用域

### 家庭管理

所有 `/families/:familyId/admin/*` 在服务端重新验证 enabled user、有效 session/client type、active membership 和当前 ADMIN/SUPER_ADMIN。沿用 Cookie/Bearer 分离、Origin exact allowlist、JSON guard、服务端锁后时间和 recent-auth。MEMBER 不可直接 API/URL 访问 Admin；UI 隐藏只改善体验。

家庭管理员可管理本家庭已允许的成员/邀请、看本家庭管理事件和当前 ACL 可见媒体统计。SUPER_ADMIN **不获得 private album/media bypass**。普通 API 仍不能创建/晋升/disable/restore/downgrade/remove SUPER_ADMIN，不能自增系统权限。

媒体集合必须复用当前 gallery/trash 的权限谓词：family + active identity + 当前 album/media lifecycle + 当前有效可见 placement；先 ACL/filter、后 distinct/aggregate。不能统计所有媒体再剔除列表，不能用总数减可见数显示“隐藏 N 项”。媒体审计也遵守当前权限，不能借日志拿到 private media ID、标题或存在性。角色变化/家庭切换/登出/401/403 中止并清空旧 Admin 状态。

### 系统控制与跨家庭运行状态

新增独立 `system_admin_grants`，不是把任何家庭 SUPER_ADMIN 自动当宿主管理员。grant 必须同时绑定 user + 某 active SUPER_ADMIN membership + family；每次请求验证三者仍有效。只有持有该 grant 的当前 SUPER_ADMIN 可读 `/admin/system/*` 和操作全局模式。单纯 ADMIN 或未绑定 SUPER_ADMIN 返回 403；不接受 query/header 指定另一个 grant/部署作用域。

grant 仅有显式本机可信 provision 路径，没有 Web grant/promotion API。迁移不为现有用户自动授予。实施期只在合成 DEV fixture 显式创建 grant；真实 DEV 账号绑定需用户明确指定账号/家庭并确认部署级影响，生产绑定不在本批执行权限内。可提供 DEV-only 本机 provision 命令设计/实现，必须检查 family_album_dev、非 root、明确目标和 `--ack-system-scope`，事务内重读角色并审计；不得运行它去修改真实账号。撤销 grant 也走本机显式操作/审计，绝不通过家庭角色降级去规避 SUPER_ADMIN 保护。

系统权限仅授权运行状态/容量总账/全局模式，不授权任何家庭照片内容、私有媒体数量、GPS、缩略图或 raw path。系统可展示设备总/可用 bytes、全局 reserved/staging/derived accounting 类别及管线总负荷，这是显式 system grant 的运维披露；不展示按其他家庭拆分的用量/成员/内容数量，也不提供相减求隐藏媒体数的接口。家庭 Admin 仅看到媒体子系统可写/暂停/不可用的粗状态，不看到其他家庭或宿主诊断详情。

用户在系统模式确认界面必须看到：“影响此部署内所有家庭、API 和 Worker”，目标模式、当前修订、将暂停的动作、在途排空语义；执行 recent-auth，不能以浏览概览代替 recent-auth。

## 4. 统计与状态契约

### 家庭统计

- photos/videos：当前 ACTIVE、READY、至少一个当前可见 placement 的 distinct media ID；多相册 placement 不重复，Trash 单列并使用既有 Trash 权限。处理中的数据不混为 READY，个人上传进度仍走本人 receipt API。
- visible logical bytes：上述 media 对应 original 的 byte_size 按 media 求和，名称明确“当前可见媒体逻辑大小”。visible referenced storage bytes：对同集合引用的 storage object 去重后求和，只表示该可见集合所引用的字节，不宣称是家庭全部物理用量或可释放空间。
- 成员上传量：按当前可见 canonical media 的 source upload creator 分组；不把 dedup receipt 次数、album_media 条数混作媒体数。若增加 receipt 活动计数，只允许本人 receipt 或已关联当前可见 media 的记录，另起命名字段，不能暴露其他成员未发布/私有上传。
- derived visible bytes 按可见 media 和有效 generation/recipe 的现存 asset 求和；reserved/retained 不猜测为可见媒体大小。禁止在页面轮询调用带 FOR UPDATE 的 capacity inventory writer 方法。
- 所有 COUNT/SUM/BIGINT 返回规范十进制字符串；空可见集合是 0，DB 超时/错误是 UNKNOWN/503，不回 0。同一响应用一致只读快照并绑定 actor/family；无跨请求共享结果缓存。private,no-store，cursor/分页及聚合都在当前授权后执行。

### 系统观测

统一状态 `{state, observedAt, staleAfter, source, reasonCode}`，时间用服务器时间、原因是固定枚举。枚举区分 HEALTHY/DEGRADED/UNAVAILABLE/UNKNOWN/NOT_CONFIGURED/NEVER_RUN；没有观测或已过期不能 HEALTHY。只暴露服务角色名，不输出 PID、原始 worker id、路径、SQL、驱动错误、凭据或私人 EXIF。

新增 runtime heartbeat：进程 boot UUID、role（API/DERIVATIVE/METADATA/PURGE）、DB server receivedAt、最近成功轮次时间、当前受控状态、control revision。5 秒更新一次，15 秒后 STALE/UNKNOWN；队列为空只能说明 idle，不能证明 worker 离线。heartbeats 使用当前 boot incarnation 的 CAS，旧退出回调不能覆盖新进程。是否“应运行”来自现有 runtime 配置；独立 purge 未启用/因 writer 互斥而未运行显示 NOT_CONFIGURED/INACTIVE，不判红色宕机。heartbeat 不授予写入或恢复权限。

DB 状态：有界 checked SELECT/readiness 查询，2 秒超时，错误分类；DB 已不可用时 system endpoint 返回 503 + 本机可确认的 mode/fault 状态，不能依靠旧授权快照继续披露系统详情。公开 health 仅 API liveness，不泄部署健康详情。

Storage 状态：writer owner 使用现有 root identity/marker/coordination 和 capacity 能力作只读健康检查，每 5 秒以及每次写入前原有边界检查；不重复初始化 root、不写 sentinel 测试原图、不重建 marker。健康原因包括 identity/marker/namespace 变化、I/O/只读挂载、capacity coordination 不可用、DB outcome unknown、硬性安全余量不足。空间不足沿用现有 capacity 预算/保留量定义，不能另设一个互相矛盾的任意数字。单个文件/单个 job 的拒绝不自动升级全局故障；系统性安全边界失败才 latch。worker heartbeat 失联本身不等于 storage 损坏，但失联/UNKNOWN 的关键 readiness 阻止解除保护。

Backup/integrity：本期无 engine 时明确 NOT_CONFIGURED，`lastSuccessAt:null`。只读 API 预留固定 source/provider 接口，不提供伪造检查结果写入口；未来 Phase 13/15 再加入可信持久运行记录/migration。已有启动 probe 和 bounded reconciliation 可显示其实际时间/范围，不能命名为“全库完整性检查成功”。不把后续 engine 缺失当本期没做健康保护的借口。

## 5. 持久模式与生效语义

部署控制唯一 DB row（本部署，不是 family row）：`requestedMode`、`enforcedMode`（NORMAL/READ_ONLY/MAINTENANCE）、`transitionState`（STABLE/DRAINING/RESUMING/RECOVERY_REQUIRED）、revision、healthGeneration、faultLatched、reasonCode、DB 时间、activeOperationId。无 row、坏 schema、未知枚举、无法查询、控制 namespace 无法验证，一律不接收媒体写入。

- READ_ONLY：允许登录、reauth、logout、session revoke、授权 metadata/已有媒体读取；停止新上传/create/PATCH/finalize/abort 删除、canonical reconciliation/placement、媒体/相册元数据改变、favorite、Trash/restore/purge、derived/projection/job mutation、容量预约及回收写入。成员/邀请管理独立于媒体写入，可继续现有授权动作并原子审计；不因此开放媒体权限绕过。
- MAINTENANCE：包含 READ_ONLY 的媒体限制，同时暂停邀请创建/消费和成员/相册/分享等业务配置增加或恢复。保留登录/验证/登出、撤销 session、disable/revoke 等明确减少权限的安全操作，以及授权系统查询/模式控制。每项例外必须是命名操作类别，不可按路径前缀泛放行。
- 正常浏览仍按 ACL；storage 不可用时二进制读取失败 503，不伪造空图。此阶段不强行修正已有 READ_ONLY derived serving 的 503 限制，UI 明确区分 metadata 可见与 binary 暂不可用。
- DRAINING 不等于已经静止。普通维护允许切换前已获准的一个有界操作单元走到原有安全边界；其后不开始下一个单元。HTTP 返回 202 + operation ID，只有跨进程屏障确认排空才标 QUIESCED/STABLE（由 enforcedMode+transitionState 表示）。超时 30 秒保留已生效的拒绝新写入和 DRAINING，提示继续观察，不能回滚到 NORMAL 或假报已完成。
- 自动健康保护先本地 deny、再持久 latch 和排空；危险 I/O/identity 错误不允许原单元“为了完成”继续文件写入。按原 invariant 停止并进入观察/恢复；无法证明安全结局标 RECOVERY_REQUIRED。
- 不自动恢复 NORMAL。人工解除需 system grant + recent-auth + expectedRevision + 幂等 operationId，并且所有当前关键健康证据新鲜、未决 unknown 已解决、原 writer 身份/锁与 accounting/reconciliation 已验证。无 force 参数，无 UI“一键忽略故障”。

## 6. 跨进程写入屏障：新增机制但不替换原锁

采用部署级 `OperationGate`，native S/X advisory file lock。与现有 root/内容锁使用**不同的固定 namespace**，目录在内部稳定 control path，不能放到可能离线的 media mount。配置显式绑定 deployment UUID/DB/APP_ENV；private owner 0700、regular lock file、no symlink、打开及每次 acquire 验证 directory/file inode/owner。缺失/替换时失败关闭，不在请求中自动另建锁文件。只在受控 DEV provision/bootstrap 创建；不能悄悄改变 home ACL 或 Production 路径。

实现复用已审阅 coordination 的 native S/X 与 registered child lifetime 思路，新增专用 system gate 类型；**不能假造 family/hash 参数去复用某张照片的锁，不能只用 JS mutex/DB GET_LOCK/heartbeat lease 代替跨进程屏障。** DB 连接断开会释放 DB lock，不能据此认定仍在运行的文件写入已停止。

所有实际媒体变更单元：先取得 S permit，再从 DB 读取当前准入状态并检查本地 durable deny marker，随后进入既有业务操作；只有允许时才执行。读状态是该单元的准入线性化点；控制请求随后 commit 的单元属于在途单元，由持有 S permit 证明其尚未排空。该 permit 持有至所有 SQL/FS/错误处理/child 输出实际 settle；不能在 response headers、超时 Promise.race、abort 发出或 lease 到期时提前释放。child lifetime 按下文 §6.1 的持久 registered-handoff bridge 证明；禁止向 parser/codec/bootstrap 传递 OperationGate FD（包括 dup/SCM_RIGHTS）或扩大原 FD/sandbox allowlist。父进程持 S 不能单独证明父死亡后的排空。

S permits 可以并发，不把全系统普通上传串行化。X 只用于排空确认、恢复检查和控制 namespace 的安全维护。控制代码不能持 actor/业务/DB row lock 等待 X；必须先结束请求事务。禁止 S→X 升级；在持 S 的失败回调只标记本地 deny、提交短控制事件，再由独立控制协调回合等待 X。

锁顺序：`OperationGate S` → 本入口原有 UploadMutex / content L-R / CapacityGate / DB named lock / actor+业务 row locks 的既有相对顺序。**本设计不重新排序旧锁**。控制 finalization：`OperationGate X` → 短 control-latch mutex → 新控制事务既有 actor 锁序 → system control row。普通“请求切换”只做 actor 验证+control CAS 短事务，释放全部 DB 锁后才尝试 X。禁止持 capacity/content/业务 row lock 回头请求 system gate。

操作单元清单必须有代码所有者和调用点测试：

| 写入入口                            | S permit 范围与暂停点                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create/reserve                      | 准入前到 receipt/reservation 已知结果；不跨客户端整个 upload 生命周期持锁                                                                                   |
| PATCH                               | 原 4 MiB 或服务端既有上限 chunk 的 staging/offset 安全提交；下一 PATCH 独立准入                                                                             |
| finalize                            | 一个既有 finalize 单元，包括 original 持久化及原事务结局；未知结局保持原“不 replay”                                                                         |
| canonical/media/job reconciliation  | 一次原有 bounded/fair batch，每个已批准独立事务边界可暂停；不能扩成全库扫描                                                                                 |
| metadata/projection                 | 从 claim 到一次输出提交/失效处理及 reader child settle；generation/lease CAS 不变                                                                           |
| derived                             | claim→renderer/verifier/seal/publish→READY 的现有有界处理单元及 child settle；不在 publish 到 READY 间任意拆断而改事务协议                                  |
| Trash/restore/placement/album-media | 整个现有授权事务与审计；不允许 READ_ONLY restore 复活媒体                                                                                                   |
| purge scheduler / processor         | scheduler 插入 intent 是写入也需准入；processor claim 到一个已有可恢复 checkpoint/结局，包括 quarantine/unlink/accounting；不新增 writer                    |
| expiry/recovery/garbage collection  | staging 删除、释放预约、derived cleanup、原文件引用/retained accounting 都是受控写入，不因名称叫 cleanup 而豁免                                             |
| 成员/邀请业务写入                   | 同样获取 S，依据 action category 在 READ_ONLY 允许、MAINTENANCE 拒绝增权/恢复；安全 disable/revoke 命名例外不被长时间 drain 阻止；原授权/audit 原子事务不拆 |
| favorite、相册元数据/分享写入       | 按上述 mode matrix 分类覆盖；不能只保护媒体字节漏掉关系/可见性状态改变                                                                                      |

service/runtime 强制要求 admission dependency；无依赖默认拒绝，不得使用 `NODE_ENV=test` 全局跳过权限或模式检查。单元可显式注入受控 fake，集成必须走真实 DB/namespace/native gate。只读 status/HEAD 不获得写许可；原本安全的只读路径保留。

### 6.1 Child lifetime 修订：部署登记桥接（2026-10-07）

这是对实施 handoff 所报真实安全冲突的设计修订，替代原“继承受控 permit lifetime”的歧义。17 项 implementation fingerprint 均核对相符；保留 `.cache/phase11-safety-block/phase11-inheritance-safety.test.ts` 的历史 **1 FAIL**，不能把撤下接口当作修复验收。此节只批准实现协议，没有宣称实际 pipeline 已接线或验证。

**源码依据与证明边界。** `registered_consumer_protocol.h` 已将 supervisor/receiver 的 boot UUID、PID+start time、输入身份和 namespace 绑定到 durable handoff；receiver 在 REGISTERED 持久化及 source-release 握手前拿不到媒体 FD。`image_renderer_supervisor.c` 的 spawn allowlist 给 renderer 的 fd4 是 binary pipe，真正输出 FD 留在可信 supervisor；metadata bootstrap 的额外 FD 禁令不变。`phase7_handoff.h:374` 对 SETTLED 直接返回可接受，但 `image_renderer_supervisor.c:307` 附近在 supervisor 返回前已经写 SETTLED。因此 **部署 X 不得直接复用既有 SETTLED 快捷结论**；必须额外覆盖持输出能力的 supervisor，且不能修改旧内容锁的语义来偷换这个证明。

采用 **父进程独占 S 能力 + 稳定控制目录的持久 bridge index + 原注册 supervisor 协议**。无需给 supervisor 或 receiver 传 gate FD，无需新 DB 表/marker，保留现有独占 storage owner。bridge 是控制协议自己的私有持久记录，不是业务状态或新的媒体 writer：

1. 在已获准的 S 单元内创建原 handoff PREPARED 记录，再在稳定 control namespace 持久创建唯一 bridge（exclusive create、0600、nofollow、文件及目录 durability）。bridge 绑定 deployment/控制 namespace identity、版本、随机 launch ID、原 handoff ID、root device/inode/marker、coordination identity、coordinator boot/PID/start identity；只用受控配置根和固定相对命名定位记录，不能接受请求传任意路径。**两份记录均持久成功后才可 spawn supervisor、传输出能力或发送 INIT/MEDIA**。登记失败绝不 launch。原 handoff 在 bridge 前留下孤立 PREPARED 没有 child/capability，可以沿原 recovery 处理。
2. bridge 完成后才进入既有 registered launch：固定可信 supervisor 先被注册并持久写确切身份，再 INIT；supervisor 先持久登记 receiver，之后才交付媒体。保持原 bootstrap/sandbox、制品校验、清洁环境和 FD allowlist。任何会产生新写能力的 child 路径（含 verifier/metadata/native 内部 launch）必须经过同一 bridge；不得让嵌套 launch 绕过。未经 REGISTERED 的 receiver 只能持握手 socket/管道，不能持媒体或可写文件/控制目录能力；若某路径不满足这一事实，停止接线并回报具体路径。
3. 正常结束：coordinator 仍持 S，等待确切 supervisor 被 reap、原 receiver settlement、全部输出/异步 FS/SQL 回调 settle 后，才可 durable terminal/删除自己匹配 launch ID 的 bridge（含目录同步），再释放 S。不能收到 ARM/SETTLED/JSON、abort、超时或 Node `exit` 就提前结案；实际管道关闭、已有 native exact-reap 语义必须满足。删除/同步结果未知保留保护，不凭内存已结束放行。
4. **取得 kernel X 仅是 RAW_X，不能公开为 drained permit。** 私有 gate 协调器在持 RAW_X 时完整枚举并验证 bridge index；只有所有记录得到终结证明，才构造可做 STABLE、marker clear 或 recovery 的 DRAINED_X 能力。没有旁路 native export / TS acquire('X') 供业务绕开该步骤。新 launch 都需 S，所以 X 扫描期间集合不能增加；记录数量/扫描时间到限返回未排空或 UNKNOWN，绝不能截断后认定成功。正常 S 单元间并发不变，不能为整个 worker/HTTP 生命周期串行化。
5. orphan bridge 逐项重读原 handoff，验证其 namespace、文件身份、checksum、launch/boot/coordination 绑定及完整阶段。部署终结要求 **coordinator、已登记 supervisor、已登记 receiver 的原 incarnation 均确定不存活**，即使原记录已经 SETTLED 也不能跳过 supervisor；或由仍持 S 的正常收尾执行第3项。沿用既有 boot UUID + kernel PID/start identity 判定，不用 PID 单值、kill(pid,0)、心跳/lease 到期或等待时长作为死亡证明。不向非本进程确切 owned child 发 kill。未知/拒绝查询、记录损坏/缺失、media root 离线/被替换、原 namespace 不可验证均拒绝 DRAINED_X，锁存固定原因，不能因根不见就删 bridge。旧 boot 也须验证记录与 namespace，不能只比较字符串即解除。
6. crash windows 必须闭合：bridge前不launch；spawn后注册supervisor前，该固定可信supervisor只能等待INIT且尚无receiver，coordinator死亡关闭握手后退出，不能主动使用预先给它的输出FD；注册后就有确切supervisor身份；receiver登记前无媒体/文件写能力；登记后其身份受durable记录覆盖。这些是固定 supervisor 源码的约束，不是相信不可信 codec 会配合。若 supervisor 尚未登记的启动路径会写输出，必须先改为“注册确认前无输出/无launch”，不得用超时掩盖该窗口。
7. parent死亡导致kernel S消失时，bridge仍在；supervisor死亡但receiver活着时记录仍阻止 DRAINED_X。不可信 receiver 无gate FD、无control namespace/registry可写能力，不能通过 LOCK_UN 或伪造SETTLED放行。其 sandbox 禁止衍生带能力的未登记后代；原限制若无法证明，回设计。所有 gate/control/record FD 对消费者 CLOEXEC 且只按原 allowlist传递，保持 metadata fd>=4 qualification。可信 supervisor 自身不得继承 gate FD；不要新增通用 raw-FD API。
8. orphan检查是只读身份/记录检查，不在 RAW_X 下偷偷调用会改记录的 `ps_handoff_admit_exclusive` 或抢旧内容锁。证明全部无活跃能力后才能在 DRAINED_X 的受限 recovery 中按原锁序处理原记录/残留并回收 bridge。control index正常清理必须有界；达到未解决记录容量上限拒绝新launch，绝不能删除未解决记录腾空间。打开根/查看登记不获得第二个writer；owner互斥不变。

**有界的含义。** 继续复用原 supervisor runtime deadline、owned child TERM/KILL/exact-reap；控制请求最多等待30秒后返回仍 DRAINING/UNKNOWN。OS未能回收或 waitpid异常时不能承诺固定时间一定settle，更不能释放能力假装完成。实际排空未证明时始终不发 DRAINED_X、不清marker、不恢复写入。正常完成无需等待心跳或全局串行工作；故障宁可停在可观察的受保护状态。

实施最低回归（全部 synthetic，历史失败另列）：原 LOCK_UN 攻击在真实各消费者 FD 边界不能获得 gate能力；metadata额外FD资格保留；真实renderer/verifier/probe正常并发S；逐个 PREPARED/bridge-durable/spawn-before-registration/supervisor-registered/receiver-registered/source-release/SETTLED-before-supervisor-exit 边界杀coordinator与supervisor，独立进程尝试部署X，receiver或writer仍活时必须拒绝；正常exact-reap后可排空；重启读取原bridge、PID reuse/boot mismatch/identity查询未知、离线/替换root、记录损坏、fsync失败、扫描上限、timeout均failclosed；证明未有手工补登记/补settlement。最终还需真实调用链接线测试，独立gate或Python模型不能代替。

## 7. 控制协议、健康锁存和启动恢复

### 请求进入限制模式

1. API 解析固定 enum、规范 UUID、expectedRevision；验证 system grant/current SUPER_ADMIN/recent-auth。在短事务按原 actor 顺序锁身份，再锁 control row；验证请求快照。
2. 同一事务 INSERT control operation + generic audit，CAS 增 revision，requestedMode 设目标，enforcedMode 立即设置为至少该限制（从 MAINTENANCE→READ_ONLY 属减限，不能走此快捷路径），transitionState=DRAINING。**commit 是拒绝新单元的全局线性化点。** 返回 202，不能先回 200 再后台写状态。
3. 协调器尝试 X；等待期间没有 actor/SQL/content/capacity 锁。取得 §6.1 的 DRAINED_X（不是裸 kernel X）后再验证 operation/revision/healthGeneration 和身份（人工控制生效前权限撤销则不能减限；已持久安全限制保留），短事务写 STABLE + audit。release X 后保持 DB 限制。CAS 被新请求取代则旧回合只退出，不覆盖最新状态。
4. 对同 operationId 丢响应重试，只观察原 operation，验证 actor 与 immutable request fingerprint；不执行第二次模式改变。不同 UUID 仍须 expectedRevision。COMMIT unknown 进入查询/RECOVERY_REQUIRED，不重试业务 mutation。

### 健康锁存

任一参与者检测系统性危险时立即停止本进程新准入，并在稳定 control namespace 建立 **仅含部署标识/固定故障分类的 durable deny marker**（临时文件+fsync+原子命名/父目录 fsync，或等价经测原语）。所有参与者每次准入检查 marker；DB 可用后将故障健康世代与 audit 原子持久化。DB 故障时 marker 保护重启，UI 返回 UNKNOWN/受保护，不能声称审计已入库。标记写入也失败则该参与者终止写入并保持不启动；不将无法持久保护当作成功模式切换。

marker 是单调 deny，多个故障不能互相擦除。新增短 native latch mutex 专门串行 marker 创建/清除；故障方立即本机 deny 后有界取得 latch，释放 latch 后再做 DB，不在持 latch 时等待 media gate。恢复方先 X 后 latch；新故障等待 latch 时所有 media S 已被 X 挡住，之后仍须重新建立 deny，不会被恢复操作吞掉。禁止无版本直接 unlink marker，禁止仅 heartbeat 超时解除保护。

### 人工恢复/减限

提供真实的 `RECHECK` 操作（独立 operation UUID、recent-auth/system grant），可在 RECOVERY_REQUIRED 下运行；它只执行上述 fenced recovery/证据重核，不能直接切 NORMAL。证明旧 unknown 与 accounting/root 状态已解决后，CAS 将 RECOVERY_REQUIRED 收口为原限制模式的 STABLE，随后用户才能请求减限。失败仍受保护。初次本机 DEV bootstrap 是同一验证协议的 BOOTSTRAP kind：验证/创建专用控制 namespace、确认 migration 与原 owner/readiness 后从 NOT_INITIALIZED 收口为 READ_ONLY/STABLE；不自动 NORMAL、不自动授 grant。这样首次初始化和故障后恢复都有可执行路径，不是永久锁死或暗藏 force。

NORMAL 或 MAINTENANCE→READ_ONLY 都走减限协议，要求当前已排空且不 RECOVERY_REQUIRED。先持久 RESUMING（enforcedMode 仍旧限制），再取 X+latch；由当前合法 writer owner 的现有句柄做 fresh probe/原 bounded reconciliation 与 accounting 核对，不打开第二个 Original/Derived writer。需恢复性写入时是**专门的 fenced recovery permit**，只给现有恢复流程、在 X 下执行，不能通用地绕过业务 ACL或把任意上传当恢复。所有恢复原 invariants/unknown handling 不变。

控制请求的执行协调回合放在当前合法 writer owner 内（API owner 或既有独立 purge owner），API 是命令接收/查询入口，不能为控制请求抢占另一个 owner。各入口轮询同一持久 operation；同一时间只有持 X 且 control CAS 成功的回合可完成过渡。操作记录内部绑定请求 session ID、expected client type、user/member/grant；执行时重新检查当前 session/用户/成员/grant/recent-auth，使用已经受权并持久化的命令身份，不能让 worker 自选请求者或把 SYSTEM 身份用于人工减限。只有观察/收紧保护可由 SYSTEM 完成。没有合法 owner/readiness 时保持受保护，显示 WRITER_NOT_READY，按既有受控启动/关闭流程恢复 owner，不新增远程进程启动/kill接口。

X 下的 recovery permit 是私有构造、限当前 operation/revision/owner 的能力对象，只准 STARTUP_ASSESS、CANONICAL_RECONCILE、PURGE_RECONCILE、CAPACITY_RECONCILE 等原有恢复入口；不重新获取 S，不允许 normal claim/render/新upload/新placement。否则会发生 X→S 自锁或把恢复变为通用权限绕过。健康 capability 切换由 owner 在 X 下更新统一 runtime provider 与 generation；长期 service 不得继续使用过时 READ_WRITE 快照，也不能把已 poisoned 的 root/handle 仅改枚举就恢复。需要重开句柄时沿原 drain/close/open 检查，仍不允许两个 writer。

所有 critical participants 必须具备本版控制协议、fresh incarnation/readiness；仅“心跳没有了”不能证明已停。已有 native owner/child lifetime 证明和原恢复协议未完成时拒绝解锁，显示具体安全 reasonCode。

然后事务再次验证 grant/recent-auth、expectedRevision、healthGeneration、operation fingerprint，原子写目标 enforcedMode/STABLE 和 audit；仅已知 COMMIT 后、仍持 X+latch 且未出现新故障才清除对应 marker，完成 durability 后 release。marker 清理失败则写许可继续因 marker 拒绝，响应显示“DB 状态已记录但保护未解除”，不能声称 NORMAL 可写。COMMIT unknown 时保留/重建 deny，停止协调器的后续写入，query operation 观察；绝不盲重放或先清 marker 再赌 commit。

### 启动

启动准入按下文 §7.1 的运行证明协议执行。新进程默认无写许可；旧NORMAL、marker缺失、STOPPED heartbeat或健康probe成功均不是启动证明。可证明干净关闭且fresh检查成功时，自动恢复原模式；否则保持只读并人工处理。登录/只读Admin/受权恢复命令可用。原唯一writer与registered child排空规则保持；不自动kill、抢锁或修改lease假装安全。

### 7.1 R1 最终设计修订：干净重启自动恢复，异常重启人工恢复（2026-10-08）

**本节完整替代2026-10-07“每次重启都人工RECHECK”的版本；该产品行为未获用户接受，不能再据旧节实施。** 用户已确认：正常重启经安全确认自动恢复，异常或无法确认时只读并人工处理。本节批准R1所需运行证明/锁/schema设计，Sol可直接落实；不是R1关闭结论。范围限启动、关闭、admission与既有恢复协议，不重做Phase11其它功能。

源码依据：当前 `loadDeploymentControl` 仍用旧NORMAL+无marker推导startupWritable；`ManagedControl.drain()` 在媒体资源关闭前写STOPPED；`runtimeRegister()` 会将旧行标STOPPED。这些记录均不能证明干净关闭。R1已用实际native FILE_FSYNC失败＋模拟DB latch不可用复现：无持久deny的新进程重新准入。

#### A. 安全不变量与自动恢复边界

1. **先持久记为运行中，再给任何写能力；最后完全排空并撤销能力，才持久记为干净关闭。** 因而故障发生时即使marker和DB latch都写不成，上一次已经提交的运行记录仍不是CLEAN，新boot不能自动进入。
2. 自动恢复只支持**完整部署运行集合的有序关闭→新集合启动**，集合包括实际owner及所有配置启用的API/DERIVATIVE/METADATA或PURGE参与者。日常仅API内置管线的部署可正常自动重启。配置有独立metadata时也必须完成其有序排空。部分进程单独退出、SIGKILL、机器断电、进程身份/配置变化、未确认退出不承诺自动；不将其伪装为clean。
3. 自动路径只恢复证书记录且仍被当前control允许的模式。用户主动READ_ONLY/MAINTENANCE、fault latch、未完成mode/RECHECK、变化的control revision/healthGeneration都不能被自动解除。自动启动不调用人工NORMAL API，不模拟操作者、不造grant、不清fault/deny。
4. admission必须同时验证当前run+本进程boot的有效性及原mode/marker/health条件。旧run的进程即使还活着也不能在新run开新单元；其旧在途单元继续受原S/child/owner屏障约束。单纯heartbeat/PID/lease到期永远不是排空证据。

#### B. 最小新增持久结构与native协调权

已有0010表没有“不可重用的运行证书”，不能把runtime STOPPED或自由拼审计当它。批准**一份additive 0011 migration**（Drizzle schema、SQL、snapshot/journal/readiness/静态与真实DEV验证）；0000–0010字节不改，不回填CLEAN，不在本设计轮执行迁移：

- `system_control_runs`：run UUID、单调epoch、前驱run UUID（唯一消费约束）、deployment/namespace身份、协议版本与canonical配置digest、阶段 `PREPARING/ACTIVE/STOPPING/CLEAN/CONSUMED/RECOVERY_REQUIRED`；固定expected role集合、指定owner role（API或PURGE）；协调者process boot UUID及kernel start identity；启动/关闭operation UUID与immutable fingerprint；clean时绑定的requested/enforced模式、control revision、healthGeneration、成员manifest摘要、时间。CLEAN字段完整性用CHECK约束，run epoch溢出拒绝。只存固定内部身份/摘要，不存照片/任意客户端payload。
- `system_control_run_members`：`(run_id,role)`唯一、boot UUID唯一、同进程role使用同一process incarnation ID、状态 `REGISTERED/READY/CLEAN_CLOSED/FAULTED`、terminal acknowledgment及对应run epoch。引用run及已有runtime boot，保留历史，不通过删除旧行腾位置。CLEAN_CLOSED是新的安全确认，既有STOPPED只继续用于观测。
- `system_control`增加nullable `current_run_id`（restrict FK）及单调run epoch或等价同锁原子指针；migration默认null＝没有证明。完整原control状态机保持，run状态是额外准入条件。新增固定reason与必要audit action（如RUN_STARTED/RUN_CLEAN_CLOSED/STARTUP_AUTO_CONFIRMED/STARTUP_RECHECK_REQUIRED），成功状态变化与audit同事务；不将新增SYSTEM自动事件记作用户人工MODE。该必要enum扩展也在0011审阅，不能手工改DB。

稳定control namespace新增固定 `run.lock`：owner0700目录、regular0600/no symlink/ACL、inode/device校验，**可信run coordinator终生独占X**，从创建/消费run之前持到该run停止且资源关闭之后。它不是媒体writer，不替代原storage owner；不传给supervisor/parser，不暴露FD。只有原API owner或既有purge owner担任协调者，metadata只能加入。第二command-only API无媒体services、无admission许可、不能竞争run协调权。

`run.lock`仅由显式DEV provision/upgrade流程创建并同步文件/目录，正常请求缺失即拒绝；现有bridge scanner仅增加这个固定、验证身份后的合法条目，不能泛放行未知文件。run证明的namespace摘要额外绑定run.lock inode及协议版本；旧operation.lock身份不用偷偷重置。正常S并发保持；run.lock不按每个请求反复拿，不增网络/OS服务。

#### C. 建立/消费启动证明

**协调者：**先持run.lock，验证原control/namespace/readiness。不能取得锁则仅控制/读取可用，不能接替尚活着的owner。随后取得短DRAINED_X（含bridge证明），再进行短checked transaction，锁序见F。

- 只有前驱为CLEAN、证书字段完整、配置/required roles/namespace/协议精确匹配、当前control仍STABLE且无fault/deny、无PENDING/unknown命令，并且证书的control revision/healthGeneration与模式均匹配，才可走自动启动。
- **一个事务**将前驱CLEAN CAS为CONSUMED，创建新的PREPARING run、epoch+1、设置current_run指针、登记本协调者的新boot集合及audit。前驱唯一消费约束防两个进程各拿同一clean证书。新run从PREPARING起即是“未干净关闭”，不能重复使用前驱。
- 只有已知commit或对同startup operation ID/fingerprint的权威只读确认提交，才继续受保护初始化。COMMIT unknown停止写入、只观察，不重新消费/换UUID重试。DB不可确认则没有启动许可。
- 其它新参与者仅在同一存活协调者、同一PREPARING run、expected role未占用时登记新boot；不能自动顶替已有boot。加入前验证协调者的run.lock占用与记录的确切OS boot/PID/start incarnation对应关系；不能只看锁busy或只看PID。实现可提供native核验接口，但不把它当death/drain证明。协调者持有者死亡后遗留PREPARING不得由后继自动接着启动，必须进人工恢复。

**Fresh检查与激活：**所有required roles已登记/READY且其能力仍被admission封闭；原唯一storage owner成功取得原锁，版本化资源/namespace/挂载可写性/容量余量/DB readiness/库存及原unknown检查均通过。自动分支在X下只准必要的句柄打开、只读检查和run/observation事务，**不自动修复文件、不claim job、不运行会写的assessStorageStartup/reconcile、不清marker**。若既有方法混合检查与修复，只拆出只读证明入口；需要恢复性mutation或发现未决业务结局就转人工RECHECK。ACTIVE后正常scheduler才可继续已知合法QUEUED/可恢复上传，不把尚未完成的正常排队任务一律当故障。

最终仍持run.lock+DRAINED_X，短事务再次核对current_run/epoch/完整boot集合、前驱消费关系、control模式/revision/healthGeneration、无fault/marker变化及fresh结果，CAS PREPARING→ACTIVE并审计。每个成员只在观察到该ACTIVE和自己的精确boot后安装内部不可伪造admission能力；不能从客户端或公共构造器传“approved=true”。局部真实fault deny不能被这个步骤随便清掉；任一参与者报告fault则自动启动失败。

若任何检查失败：新run不能ACTIVE，尽力将原control收紧到至少READ_ONLY并fault latch、run=RECOVERY_REQUIRED；MAINTENANCE不降级。即使收紧写入也失败，已持久PREPARING仍挡新boot/admission。UI显示“启动安全未确认/只读，需要检查”，不凭旧control NORMAL显示实际可写。DB恢复后按原monotone latch同步真实状态。数据库commit持久性必须沿用经验证的DEV保证；不能确认时关闭自动路径，不自动调整MySQL全局配置。未来从备份恢复DB或迁移存储须显式使旧运行证明失效，再走受保护初始化；不能搬运旧CLEAN当新部署许可。

#### D. 正常关闭与一次性CLEAN证明

不能仅改SIGTERM捕获或在现有control.drain的STOPPED位置签证。关闭需部署协调：

1. run coordinator记录STOPPING＋audit（known commit/权威观察）并停止本地新准入；所有成员每次S准入检查run状态，看到STOPPING后不再开始单元，停scheduler/新业务handler。关闭意图无法持久时，本机照常停止/排空，但本轮**永不签CLEAN**。正常阶段不要因此更改用户requestedMode。
2. 每个参与者等待自己的全部HTTP/SQL/FS/child与读callback settle，停止health/coordinator/heartbeat中可能发起后续mutation的任务，再关闭本进程原root/reader/store/capacity资源；保持DB仅用于terminal ack。**撤销本进程admission能力不可逆**，不能ack后恢复loop。精确known close成功、没有本地fault、unknown/rollback/cleanup失败，才提交CLEAN_CLOSED ack；失败或unknown不以STOPPED代替，可观察同ack是否已确切提交。读回ack只证明已执行关闭的事务，不允许重做文件关闭副作用。
3. API/DERIVATIVE同进程的ack必须等该进程全部资源关闭；metadata不能仅停heartbeat就ack。配置角色全部纳入，不能超时剔除一个没响应的成员。独立成员的普通停止信号可以提出部署STOPPING意图，由唯一coordinator汇合排空；不自动kill任何进程。若没有coordinator或某成员未确认，保留STOPPING，下一启动人工处理。
4. 最后由仍持run.lock的coordinator取得DRAINED_X，验证完整role/boot集合的terminal ack、bridge实际排空、无fault/unknown、control仍STABLE且无待办控制命令。coordinator先完成自己的读写callback排空和原媒体owner资源关闭，再签自己的terminal ack；可继续持control DB连接和run.lock完成最后事务，不能再处理媒体。`VersionedOwner.close()`失败时不签证，不能强制释放再声称成功。
5. 在X下最后短事务锁control→run→members，确认run仍STOPPING、身份/配置一致、全部CLEAN_CLOSED、control revision/healthGeneration/模式未发生不允许的变化、无fault或未决operation，写CLEAN证书与audit。mode必须取当前权威值；关闭期间人工mode命令若令transition非STABLE，则不签CLEAN，绝不覆盖其意图。证书签完后该进程只做无媒体能力的连接/FD释放及退出。
6. 成功签证后释放X及run.lock。新协调者即使看到CLEAN也要先获得run.lock，防旧协调者尚未终结时接替。关闭事务COMMIT unknown时旧进程不自动重放、不宣称成功；已完全撤销媒体能力。下一启动只有权威只读确认完整原子CLEAN记录、精确shutdown ID/fingerprint且无更新故障/控制状态，才算unknown已被正面解决并按C进入。记录不见/冲突/查询不可用保持只读；不能把“未知”直接当clean，也不需要为纯证书事务无限追加“提交确认的提交”。

正常关闭中已成功处理过的历史fault不必永久污染后续run：人工RECHECK成功可建立新的当前安全基线；但当前本地deny、未决unknown及故障发生后的失败收尾绝不能签CLEAN。健康监测必须在排空后、签terminal ack前真正停止/汇合，避免签证后又发生一个无法持久化的本地故障而旧CLEAN仍被误用。

#### E. R1组合故障、人工恢复、首次升级

- 曾经可写的run必有事先提交的ACTIVE记录。FILE_FSYNC或temporary创建失败＋DB latch失败时，原marker清理可以保持精确规则，旧进程local deny保留；**run记录仍ACTIVE/STOPPING而非CLEAN**。进程崩溃后新协调者拿到run.lock也无权自动恢复，不依赖事后写出新marker。旧进程恢复后也不能忽略本地fault签CLEAN。
- 新run PREPARING/ACTIVE、STOPPING缺ack、CLEAN证书缺字段/不匹配、DB或namespace不可验证、未知child、config变化，一律不自动恢复。已运行且无法通过持久通道传播故障的其它进程不承诺瞬时感知；它们仍逐单元checked DB/run/marker检查，发现故障立即停；**任何新进程**必须遵守本协议。
- 人工恢复保留原system grant/recent-auth/session、expectedRevision、新operation ID，原DRAINED_X、owner唯一、fresh reconciliation与known commit规则。无clean的新启动可创建RECOVERY_REQUIRED run并登记暂停boot，同时收紧control和audit；COMMIT unknown同样只观察。旧run不可达/旧writer仍活着时不抢占，不将旧runtime标STOPPED视为已死；新run即使已登记也不能获业务许可。
- 授权RECHECK可以使用既有受限恢复写能力，处理原未知结局/库存和marker；全部fresh参与者及当前run epoch/boot fence验证后，在原完成事务中把当前run置ACTIVE，但control仍READ_ONLY或MAINTENANCE；之后由用户明确NORMAL。不得以“自动恢复”替代这一步清fault。真实fault后的非owner参与者若不能安全清local deny，先重启到受保护的新boot，完成相应登记/排空后再RECHECK。
- 0011首次升级不产生clean证书，旧NORMAL/旧STOPPED也不回填为clean。先按既有DEV授权停止旧版本写参与者并确认owner/bridge，受控provision run.lock、应用审阅后的additive migration，再受保护启动、人工RECHECK。完成一次真正的正常关闭后才有后续自动重启资格。禁止新旧协议写进程混跑；无法证明全部参与者版本时拒写。
- 全新0010全零部署先保留原可信DEV BOOTSTRAP流程，不因run登记破坏revision1条件；BOOTSTRAP绑定namespace后创建受保护run/登记，原owner完成首次初始化只得到READ_ONLY/ACTIVE，显式NORMAL仍需授权。没有自动创建真实grant、重置control、删除未知bridge或历史audit/runtime的路径。

#### F. 锁序、崩溃证明与实现清单

run.lock由唯一coordinator在获得任何S/X/DB/媒体owner之前取得，终生持有；不得持其它锁再阻塞获取它。其它参与者只验证它与协调者身份，不申请成为coordinator。原正常次序仍S→既有内容/容量/业务事务，增加同一checked snapshot内run/boot校验；不改旧内部相对顺序。启动/激活/clean finalization由coordinator持DRAINED_X→（需要时）短latch→原actor/control→run→members→audit；短STOPPING/登记事务按control→run→members结束后才等X，绝不S→X升级。run状态事务不得长持DB锁等participant/native/文件关闭。

| 故障窗口                               | 结果及原因                                                   |
| -------------------------------------- | ------------------------------------------------------------ |
| clean消费前失败                        | 新boot没有能力；原clean尚可由一个后继合法消费                |
| 消费commit已成功但确认丢失             | 同ID只读观察；新run已PREPARING，旧clean不能二次消费          |
| PREPARING中协调者崩溃                  | 后继看到未完成run，人工恢复；不能抢原startup继续自动         |
| ACTIVE期间marker＋DB latch均失败后崩溃 | 事先持久ACTIVE足以阻止自动重启，不要求故障时写marker成功     |
| STOPPING中成员退出/close/ack失败       | 全员clean条件不成立，不签证，不靠超时排除                    |
| 最后ack后、CLEAN事务前崩溃             | 保守人工恢复；不从全员STOPPED自行推导证书                    |
| CLEAN事务未知                          | 原子权威证书可正面解析该纯记录事务；其余情况只读，禁止盲重放 |
| CLEAN后人工限制或healthGeneration变化  | 严格匹配失败；不自动解除限制/fault                           |
| 两个新coordinator竞争                  | run.lock＋前驱唯一消费＋current_run/epoch CAS只允许一个      |

**Sol按单批最小顺序实施：**①0011/schema/readiness、run记录事务与audit；②稳定run.lock/provision/身份验证，admission默认无证明与run/boot fence；③早期startup、PREPARING fresh只读检查与自动ACTIVE；④真正全参与者STOPPING/资源关闭/CLEAN签证（重排当前STOPPED先于resource close的位置）；⑤旧BOOTSTRAP/RECHECK兼容；⑥以下定向回归与built API实证。不得顺手修改其它Phase产品/UI或执行Production操作。

**R1关闭必测：**

1. 真实合成DEV NORMAL→有序全员关闭→持久CLEAN→新built API消费→fresh检查→自动NORMAL，实际HTTP201；无需操作者再次reauth。对READ_ONLY/MAINTENANCE做同样重启，仍保持原限制且媒体503。
2. 完整R1：真实DB不可达＋native FILE_FSYNC失败/temporary创建失败→旧进程退出→DB恢复→新built API，保持实际只读503；人工fresh RECHECK后仍只读，显式NORMAL才201。不得手工补run/marker/boot/媒体job。
3. ACTIVE/PREPARING/STOPPING各处SIGKILL，child/supervisor仍活、资源close失败、读callback未结束、缺participant、DB COMMIT未知、audit失败；只能安全拒写，不能签CLEAN或重用旧证书。
4. 精确CLEAN消费/ack/签证事务COMMIT丢响应，只观察同ID/fingerprint，证明不双消费、不重放业务；配置/namespace/run.lock替换、旧证书复制/重放、revision/healthGeneration/主动mode变化均拒绝自动路径。
5. 两个实际启动者竞争、旧boot试图heartbeat/claim、独立metadata参与者、API/DERIVATIVE同进程关闭、单writer＋第二command-only API；旧epoch不能新准入，S仍可正常并发。正常重启不能通过“超时把缺角色算已停”通过。
6. 首次升级与全新bootstrap无自动NORMAL；原审计/runtime历史保留；真实打包模块单例/WeakMap及私有启动能力一致。物理掉电/SSD验证仍另列，不把SIGKILL或syscall EIO模拟等同真实硬件证明。

本轮只写设计，未改产品/共享DB、未执行migration/模式切换/OS网络配置。上述自动行为是有条件且可验证的，不能对所有Mac重启/断电做自动恢复承诺。修复后更新指纹，交集中R1关闭复核；Phase11通过复核并推送确认后才允许父任务进入Phase12，本轮不push/启动下一阶段。

## 8. 最小持久数据：versioned 0010

本节保留原0010基线；2026-10-08 R1运行证明的必要additive 0011增量以§7.1 B为准，不能回改已应用0010或假称不需要migration。

新增 Drizzle schema + `0010_phase_11_admin.sql` + snapshot/journal/readiness，review additive migration。0000–0009 不改。禁止手工 ALTER 后补文档，禁止直接改变既有 audit_logs 非空媒体字段。

建议五张表（可按本合同收敛命名，不可删安全语义）：

1. `system_control`：singleton id=1、deployment UUID、control namespace identity 摘要、上述 mode/transition/revision/healthGeneration/latch/reason/currentOperation/time。uint64 revision 溢出拒绝；CHECK 约束 mode/state 合法组合。migration 初始为 READ_ONLY+RECOVERY_REQUIRED/NOT_INITIALIZED，不为现有运行环境默默开启全局权限或 NORMAL。
2. `system_admin_grants`：user/member/family 显式绑定、enabled、revision、授予时间；复合 FK 保持用户与 membership 对应，唯一 binding，删除限制。没有默认 grant。
3. `system_control_operations`：UUID 主键、kind MODE/RECHECK/BOOTSTRAP、request immutable fingerprint、actor user/member/family、内部 session ID/expected client type（不对客户端返回）、expected revision、requested target、status、result revision、固定 error category、created/finished。完成记录有界分页；不自动删去未知/未完成操作。本期无需新后台清理 engine。
4. `admin_audit_events`：append-only uint64 id、scope SYSTEM/FAMILY、family nullable 与 scope CHECK、actor kind/user/member、固定 action/targetType、target ID、operation UUID、transition token/序号、result category、revision/time。唯一 operation+transition 防重复。不给客户端 arbitrary JSON/payload 字段；目标成员/invitation ID、模式/revision 可用固定列/严格 schema。与原 audit_logs 分开。
5. `admin_runtime_observations`：固定 role+boot UUID、server receivedAt、observed revision、bounded state/counters/error enum、退出状态；进程只更新自己的 incarnation，退出不删新记录。按 role+receivedAt 索引；过期行数量有界（每角色保留最近少量且排除未解决事件），不能为了观测增 Redis。

bootstrap 激活在受控合成 DEV fixture/本机显式流程中执行 fresh checks+control audit；migration 创建表不执行 FS provision。集成 mode 切换影响全 DEV DB，因此必须串行、确认没有另一个实际 API/pipeline 在运行，并使用专用 synthetic control namespace。保存/恢复测试前 control baseline 要核对修订和所有权，不覆盖并发人工改动；测试结束有 unknown 时保留受保护状态并报告，不能为了 cleanup 强制 NORMAL。不能全局 disable safety 让其他测试通过。

## 9. 审计覆盖与查询

本期必须补通用审计：成功的成员 disable/restore/允许的角色变化、invitation create/revoke/consume、system grant provision/revoke、控制请求/应用/拒绝恢复/健康锁存/未知结局观察。成员/邀请成功事件与原业务 mutation **同一 SQL transaction**；不能 commit 后 best-effort 插日志。系统控制/audit 失败则对应控制 mutation 不成功。拒绝请求若未进入授权范围，不新增泄身份的 family 事件；使用固定字段安全日志/有界系统事件，不记录攻击者任意输入。

现有 Trash/purge 继续用原 audit 原子链，Admin 查询适配既有表，不重写 purge。认证/分享等历史通用审计不假称已覆盖；UI 展示明确 event coverage 与启用时间，本期不追溯捏造审计，不做全业务 history 引擎。

family audit：成员/邀请事件依 family admin 权限；ADMIN 不可借 audit读取其无权管理的敏感 invitation token/秘密，所有 token 均不返回。媒体事件要求当前 media/placement ACL；media 已 purge、无法证明当前授权则从家庭内容审计列表排除，不返回“隐藏事件数”。系统事件仅 system grant 查询，仍不带媒体身份/其他家庭明细。

分页 keyset `(created_at,id)` + 固定 source discriminator，limit 默认25/max100，时间范围默认7天/max90天；cursor严格编码、绑定 scope/filter/source，签名或不可信重新校验均不得代替授权。每请求重新授权再取限额+1，禁止先翻全表再内存ACL筛选。建议旧媒体审计与新管理审计分 tabs/cursors，避免人为 UNION 扫描泄计数。仅白名单 action/time/actorRole/result，绝不 raw SQL/order 参数。no-store，无 IP/user-agent/raw errors/paths/session/token/hash/password/EXIF/free-form原始请求。

## 10. Contracts / API / UI 最小完整 slice

家庭：`GET /api/v1/families/:id/admin/overview`、`GET .../audit?source=management|media&cursor=...`；成员/邀请/Trash 使用原 APIs，不另开 bypass action。概览每块显式 scope+observedAt，DB 故障整体503或有型 partial UNKNOWN，不混绿色0。

系统：`GET /api/v1/admin/system/status`、`GET .../audit`、`POST .../mode`（operationId、expectedRevision、targetMode、reasonCode）、`POST .../recheck`（operationId、expectedRevision）、`GET .../operations/:id`。recheck 只收口恢复证明、保持限制态，bootstrap 仅受控本机 DEV 路径。mode 请求只承认固定三态；解除保护仍同一严格状态机，拒绝 `force`/路径/任意family/原始故障文案。HTTP 202 表示已接收/排空中，200 仅观察到完成，409 revision/状态冲突，403权限，reauth 使用既有合同，503未知/保护不可证明。unknown 响应也提供已知 operationId 供同授权查询，不用自动重发切换。

Web 增 Admin 同应用路由/左侧入口与 H5可用布局；家庭概览、成员与邀请、可见用量、Trash、审计、运行状态。system grant 才显示系统控制页，跨家庭影响和安全原因明确。维持暖白/绿、照片优先；不变成蓝灰 BI dashboard。

维护/只读控件必须真实请求/观察状态：确认对话框+recent-auth、revision 冲突刷新、unknown只观察、draining显示仍可能完成的在途单元、resume未通过列出安全原因。管理员切家族不会保留另一家族聚合；epoch、导航/后台/退出、角色撤销会清缓存并abort迟到响应。Invitation token 只沿原一次展示流程，不进审计/cache/控制台。后台轮询5秒，隐藏页停止，恢复重新auth；无跨请求缓存或无限自动 retry。

## 11. 验收矩阵（同一完整实施批次）

| 主题              | 必须覆盖                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| role/scope        | 两家庭 MEMBER/ADMIN/SUPER_ADMIN；无grant SA拒系统；显式grant但membership/user disabled拒绝；recent-auth过期；直接URL/API；Cookie/Bearer混用及Origin；角色撤销与迟到响应                                      |
| 聚合              | private不可见媒体/隐藏placement不影响可见计数；同媒体多相册distinct；dedup引用物理/逻辑区分；Trash、processing、purged、derived旧generation；uint64精确；DB错误非0；system资源披露不按其他家庭细分           |
| 成员/审计         | 原权限矩阵不变；成功mutation+audit一起commit/rollback；audit失败拒操作；consume新账号无自动登录；审计cursor过滤/上限/当前ACL撤销/已purge身份不泄；无secret字段                                               |
| 三态动作矩阵      | 所有上表入口逐一真实测试；READ_ONLY/MAINTENANCE不仅挡HTTP还挡reconciler/metadata/derived/purge/cleanup；允许的login/read/安全撤销仍可用；maintenance控制面可访问                                             |
| 并发线性化        | 先获S并读NORMAL→切换commit→旧单元安全settle；后读限制态拒；两个API进程/独立metadata入口；X等待时无actor锁死锁；模式并发CAS；未知commit操作查询不重放                                                         |
| in-flight storage | PATCH中断/完成边界；finalize original已持久DB未知；renderer child仍写temp时不能QUIESCED；publish/READY；purge quarantine/unlink/accounting；restore引用检查；原容量/L-R/lease fencing均不回退                |
| health/startup    | media disconnect/identity mismatch、control path丢失/替换、DB断连、disk余量/coord失败；本机deny+DB不可用后的重启；旧heartbeat不能变HEALTHY；故障不自动解锁；无grant/无row failclosed；启动不会先写再加载mode |
| resume            | fresh checks、原owner互斥、未知结局未解决拒绝、healthGeneration变化CAS拒绝、marker删除失败仍拒写、COMMIT unknown latch不清、resume与新health trip竞态；无force恢复                                           |
| 独占owner         | API/purge不能同时writer；只读Admin不打开第二writer；退出等待所有child/FS/SQL settle才释放gate；不凭lease超时抢锁                                                                                             |
| UI E2E            | 严格现有DEV HTTPS；实际管理员登录/邀请/成员动作/overview/审计/切换→202观察→暂停写入→fresh resume；两账户/两家庭切换隔离，桌面/H5；无测试专用HTTP绕过                                                         |
| 未配置状态        | backups/integrity无engine时NOT_CONFIGURED/null，队列idle不是worker健康证据；UNKNOWN不显示绿色；FCM延期不影响自动只读                                                                                         |
| migration/cleanup | 0010 additive review、readiness、FK/CHECK/uint64；旧history不变；全部真实MySQL/race不silent skip；synthetic归属、精确资源cleanup、原无关残留保留                                                             |

开发阶段 targeted；先新状态机/权限与admission tests，再真实 MySQL/native S-X/child lifetime/fault races，再实际 Admin E2E。达到全部十项后做一次完整 AGENTS Quality Gate（format/lint/typecheck/unit/API/integration/MySQL race/build/e2e，含涉及的native storage/fault），集中独立复核 blockers、一次 handoff/fingerprint/PHASE-11-SUMMARY。不得用 mock模式开关替代跨进程生效证据，旧 FAIL/skip如实保留。

## 12. 一批 Sol 交接与停止条件

Sol 连续实施顺序：①0010/contracts/授权与审计原子集成；②native OperationGate/marker与控制状态机、全部writer入口/启动接线；③只读状态/聚合/观测与完整Web Admin；④targeted与实际并发/严格E2E，完整gate和集中复核。不是每张卡片单独审批，也不能只完成①③就称Phase11完成。

遇到需要改变原 transaction/locking、COMMIT unknown、Original immutable、generation/lease fence、writer ownership或本设计明确权限边界，报告具体差异并回设计；常规代码组织/命名/布局自主处理。child 桥接按 §6.1 实施；先完成 durable index/RAW_X→DRAINED_X 与实际 registered launch 故障回归，再连接控制 finalization/resume。尤其发现未登记即可获得写能力的路径、不能覆盖的存活后代，或现有恢复边界无法在一个S单元内安全收口时，不能删掉屏障或自动kill假排空，应带具体调用链回设计。

**当前没有阻塞设计/合成DEV实施的产品选择。** 采用完整maintenance/read-only、显式system grant、保守ACL统计和人工安全恢复。以后若用户要让某真实DEV账号实际操作部署模式，只需要确认“绑定哪个现有SUPER_ADMIN账号/家庭作为部署操作者”；实现时不默认选择、不自动授予。真实Production、本机现用数据库模式变更、正式签包和设备验收仍须各自既有授权，不从本设计推导许可。
