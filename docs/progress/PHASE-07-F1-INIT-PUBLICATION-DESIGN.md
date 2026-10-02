# Phase 7 F1 — 初始化发布与准入补充设计

2026-10-02 UTC。Astra Low 限定设计，基线 HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640` 加当前未提交 F1 实现。**APPROVED_FOR_SOL：仅按本文件的协议和验收落实。** 本文补充并替代原 coordination design 第 3 节中没有明确的发布完成语义；其他安全不变量不变。设计批准不等于实现通过或 F1 closure。

本轮读取 AGENTS、INIT-PUBLICATION-DESIGN-GAP、COORDINATION-DESIGN、INDEPENDENT-CLOSURE-STATUS，以及实际 marker、fresh-root、openRoot、coordination、registered-consumer 相关源码。未重跑旧探针，未绕过上轮安全过滤，未修改实现/测试、build、启动服务或操作数据库。

## 1. 结论与具体边界

当前 `storage_root_v2.h` 将完整合法 final marker 写出后才执行 fsync/F_FULLFSYNC/root fsync；`storage_marker.h:sm_read` 没有初始化屏障。`storage_native.c:open_root` 在 fresh helper 返回后还会取得 writer lock、同步布局、执行 writable probe。这些步骤必须全部纳入本次 fresh 初始化提交之前，不能只修 helper 而遗漏后半段失败。

批准采用 **root inode 上的短期跨进程准入锁 + 先持久化的 initializing 拒绝标记 + 最后删除拒绝标记提交**。无需新服务、数据库状态或每 K 协议。拒绝标记不是另一个可重建的授权来源；marker 必须携带严格 publication 协议标签，只有符合新协议的 marker 且拒绝标记不存在才可能准入。运行时永远不创建、删除或修复拒绝标记。

必须明确区分三个事件：

1. **持久准备完成**：所有布局、namespace、marker 内容及其命名关系，以及 fresh openRoot 的磁盘探测和 writer bootstrap，已完成本节规定的所有同步与校验。
2. **初始化提交点**：仍持初始化排他锁时，成功 `unlinkat(root, ".storage-root.initializing", 0)`。该 syscall 成功才从未完成变为完成。
3. **对外可准入点**：提交后释放初始化排他锁。之后正常 runtime 取得共享准入锁并完整校验才可授予能力。initializer 被杀时由内核释放锁。

**提交之后不再安排必须成功的初始化写入/fsync/验证。** 不能把 fence 删除后再 root fsync 的失败定义为“初始化未完成”，否则会重新引入无法可靠区分的可见性窗口。所有需要失败即拒绝的步骤都放在 fence 删除之前。

这并未省略 marker 的 durable publish：marker 文件 full sync 和包含 final marker 的 root directory sync 都在 fence 删除之前完成。最后 fence unlink 的目录项持久性只影响重启后的可用性：进程 SIGKILL 不回滚已成功 unlink；真实断电/介质异常后，已删除 fence 可能重现，此时必须拒绝，不能自动删除它。即使 init 返回成功，也**不承诺物理断电后一定仍可用**。接受的根，其 layout/marker/namespace 必須已在 unlink 之前完成同步；看到重新出现的 fence 只会更保守。

不能要求“SIGKILL 发生在成功返回之前任何位置都必须拒绝”：进程可能在已提交 syscall 成功之后、返回 JS 之前被杀。此时根已完成，可以重新打开；调用者没收到响应属于提交结果未知，不是半成品。验收以明确的 unlink 提交点划分，不能以 initializer 是否发回 success 消息划分。

这个协议保障协作进程的安全准入，不声称通过普通文件/锁抵抗可任意删除 fence、伪造受信 marker 或修改二进制的同 UID 恶意管理员；保持原设计威胁边界。真实断电、硬件 flush 和镜像回滚的证明不由 SIGKILL 测试替代。

## 2. 磁盘格式与兼容性（明确选定）

保留 `.storage-root`、V2 marker ID 和全部 10 个身份数字字段。新生成且唯一可授予 V2 能力的格式为：

```text
FAMILY_ALBUM_STORAGE_V2:<marker32>:<rootDev>:<rootIno>:<coordDev>:<coordIno>:<coordBirthSec>:<coordBirthNsec>:<v1Dev>:<v1Ino>:<v1BirthSec>:<v1BirthNsec>:INIT1\n
```

`:INIT1` 是固定的协议 discriminator，不是可选字段，不是运行状态，不增加 K 字段。精确一个 LF；现有大小、数字、overflow、NUL、ACL、mode、named/open inode/metadata 约束全部保留。上限 512 足够，无需提高。`sm_marker` 的原始 bytes 缓存必须包含标签。不能接受缺标签、未知标签、大小写替代、重复标签或尾随 bytes。

当前未修复的无标签 V2 格式必须拒绝获得 runtime root/coord/purge/reader/handoff 能力；不能因看不到 fence 就把这类根当作完成。旧未修复 V2 parser 会因新增后缀拒绝新格式，防止混用旧 admission 代码。V1 维持原方案的 legacy 识别与拒绝 L/R/purge，不自动升级。原 V2 strict parser 的拒绝证据需补测，而不仅是旧 V1 parser。

本次不升级任何已有 V1 或无标签 V2 根。所有测试使用全新合成根；现有 DEV/PROD root 不重写、不复用成 fixture。不更改 expectedMarkerId 配置，不因读取失败生成/绑定新 ID。原身份字段、K、ledger、SCM_RIGHTS 协议、数据库 schema/0007 不变。

固定 fence 名称为 `.storage-root.initializing`，fresh initializer 用 O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC、0600 创建，内容固定 ASCII `FAMILY_ALBUM_INIT1\n`。它只表示拒绝；runtime 不必解释内容，任何类型的同名 entry 存在均拒绝，包括 symlink、目录、空文件、损坏文件。只有在受信 root 下 `fstatat(..., AT_SYMLINK_NOFOLLOW)` 明确返回 ENOENT 才算不存在；EACCES/EIO 等一律拒绝。不得跟随 symlink，也不能将“无有效 fence”理解成“不存在”。

## 3. 跨进程锁和统一 admission

使用 **root 目录 inode 本身的 flock**，不用可替换/缺失时会新建的 lock sidecar。现有 `.writer.lock`、L、R、capacity lock 都在不同 inode，保持原模式和顺序。macOS native 支持是本阶段前提，必须用实际 addon 子进程测试目录 flock 的共享/排他行为；不支持即安全失败，不得退化为 JS Map。

- fresh initializer 排他 mkdir 后，打开并验证 root inode，立即取得 root `LOCK_EX|LOCK_NB`，直到提交/失败清理结束；不能进入无锁写 marker 的分支。mkdir 到取得锁之间没有合法新 marker，runtime 必须拒绝。
- runtime `sm_read` 通过 `openat(root, ".", O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)` 取得**独立 open file description**，验证与 root FD 的 dev/ino 一致，然后 `LOCK_SH|LOCK_NB`。不能在业务 root FD 或其 dup 上改变 flock 模式，防止锁转换/提前释放 initializer 的 X。
- 取得 S 后检查 fence 明确不存在，再读取/严格验证 marker，再检查 fence 仍明确不存在及 root identity，最后解锁并关闭自己的 FD。只有全部通过才返回 marker。持锁范围只含本次本地验证，不返回锁给 JS。
- flock busy 在 root-open 边界报告稳定的初始化不可准入错误；其它不确定结果报告 root/namespace unavailable。不得当作 K 的普通 busy 返回有效 guard，也不得无限等待。读侧使用 nonblocking，不改变业务 writer→L→R→CapacityGate 的等待顺序；initializer 尚未发布根，持 X 时也只非阻塞取得 writer。
- `sm_validate_namespace`、`read_marker`、`sm_record_namespace` 及 addon/固定 supervisor 的所有现有路径都通过上述共同 `sm_read`，不允许任一程序保留旧裸读取。runtime root open 在创建 writer lock/probe 等 mutation **之前**完成 admission。
- 已有能力后续的共同验证继续检查 fence 和严格 marker。若出现 fence/namespace异常，不返回 guard、不发送新 FD、不推进 handoff settlement、不触碰 Original/Derived、不放账。release/close 仍可执行。

initializer 需要在 fence 存在且持 X 时自检，因此拆出仅 C 内部使用的 raw marker contents/namespace validation helper。它不是公共 N-API、布尔参数、环境变量或 exported bypass。只允许 fresh 初始化上下文的私有调用链使用；上下文必须是本次排他 mkdir 成功后创建，持有 root X 和独占创建的 fence FD/identity，existing-path 分支永远拿不到。共享 parser/namespace 属性检查可以复用，但 runtime 的 `sm_read` 入口绝不可绕过 fence。避免 raw namespace helper 内再次调用 gated sm_read 而自锁，也不得以临时 unlock/删除 fence 完成自检。

## 4. fresh 初始化的完整顺序

将当前 `sm_fresh_root` 改为 private prepare/commit/abort 生命周期，`open_root(initialize=true)` 负责在返回外部能力之前完成提交。函数命名可沿项目风格，顺序不能变化：

1. 现有逐段 nofollow/owner/ACL 父路径验证；native 排他 mkdir 最终 root，路径已存在立即拒绝。固定 root FD/命名身份并取得 root X；同步父目录。
2. 排他创建 fence，检查 regular/单链接/uid/gid/0600/无 ACL/同设备及 named/open identity；完整写固定内容，fsync + F_FULLFSYNC fence，然后 fsync root。任一失败终止，不能写可接受 marker。
3. 创建原布局 originals/uploads/temp 和 `.coord/v1`，保持当前权限/设备/身份和目录同步要求。生成随机 marker ID/身份字段及 INIT1 标签。O_EXCL 创建 final `.storage-root`、完整写入、fsync、F_FULLFSYNC，再 fsync root。可以继续直接写 final marker，因为 fence+X 已覆盖整个可见性窗口；不需要临时 marker/rename 新协议。
4. 在同一 private initialization context 下完成现有 `open_root` 剩余的 writer lock 创建/非阻塞获取/属性校验、layout 验证及同步、writable probe（包含探测文件删除和 root sync）、canonical path、root/marker/namespace 完整自检。提前完成必要内存/N-API 对象构造，外部尚不可见。writer lock 如新创建须 file full-sync，再 root sync。不得调用 runtime gated reader 来绕过 fence；只用上下文限定的 raw helper。
5. marker 和其他需要报告 close 错误的写 FD 在此阶段关闭并处理错误；重新验证 root 当前路径、marker、namespace、fence 的 named/open identity。执行最后一次必需 root fsync（覆盖 final marker、writer bootstrap、probe cleanup 和 fence），以及父命名关系检查。fence 必须仍是本次独占创建的文件，不能删除未知对象。准备阶段没有媒体写入、DB claim、handoff 或外部 capability。
6. **提交：**在 root X 下精确 `unlinkat` fence。成功是唯一正常提交点。明确未执行/未删除的失败保留 fence，不发布能力；ENOENT 也视为异常，不能当普通成功。对于 EIO 等可能存在 syscall 结果未知的错误，在仍持 X 时只可检查 fence 状态以分类，不能自动重试 unlink、重建 fence、截断 marker 或清理其它条目：fence 仍在则拒绝；fence 已不在或查询本身失败则报告 `INIT_COMMIT_UNKNOWN`、不向此调用返回能力、关闭资源。若 unlink 实际已完成，未来 runtime 在严格验证后可能正常准入，因为所有正向状态已先同步，属于已提交但结果未知，不是未同步半成品。未来仍看见 fence 就拒绝。正常协作协议无其它 actor 删除 fence；异常缺失不形成自动恢复权限。
7. 标记 C context 为 committed，释放 root X/关闭 admission FD，返回已经准备好的 native root object。此后不得进入“truncate marker/写回 fence/撤销初始化”的失败分支。资源释放异常或返回响应丢失不撤销提交；关闭资源即可，不做磁盘 rollback。不得在这里新增需要失败则撤销的 fsync。N-API 响应构造若仍可能失败，也按已提交但返回失败处理，不能把它描述成未完成根。

prepare 任意失败、同步错误或 SIGKILL 在第 6 步之前（不包括第 6 步本身的提交结果未知）：不删 fence，不修复、不 adopt、不递归清理。关闭所有本进程 FD，释放 X；runtime 仍因 fence 或缺失/无效 marker 拒绝。当前 best-effort `ftruncate(marker,0)` 不再是安全机制，建议删除该回滚写入；保留 fence 与诊断错误即可，不制造额外未知写结果。root 尚未创建的失败无残留；root 已建但 fence 未完成的失败没有可接受 INIT1 marker，仍拒绝。

不自动重试在原路径 initialize；即使根为空也已有 inode，existing-path initializer 必须拒绝。测试 owner 可以精确清理自己创建的 fixture 容器后换新的不存在子路径。生产失败根需要独立维护流程，本 slice 不提供清理/恢复命令。

`StorageRoot.open` 的 expectedMarkerId/canonicalPath 外层检查不作为初始化提交条件：它们是调用者是否接受已创建根的检查。失败只关闭返回能力，不能重写根或配置。这与调用响应丢失一样，不承诺“任何 JS open 抛错都意味着磁盘从未提交”。DEV capacity/derived provisioning 仍是已有独立步骤，不纳入 fresh core root 完成保证，不改变其接口。

## 5. 重启与故障的精确语义

| 状态/边界 | 另一进程准入 | initializer 死亡后新进程 | 磁盘/账务行为 |
| --- | --- | --- | --- |
| mkdir 后、fence/marker 创建前 | 缺 marker 或 X 拒绝 | 缺合法 marker 拒绝 | 不重建、不触媒体 |
| fence 已持久化，任意 layout/marker write/fsync 前后 | X 拒绝 | fence 拒绝 | 不删 fence、不放账 |
| marker 已完整写出但 pre-fsync（原复现点） | X 拒绝 | fence 拒绝 | 原缺口关闭目标 |
| marker full-sync 后、root sync 前或同步报错 | X 拒绝 | fence 拒绝 | 不把完整 bytes 当完成 |
| 全部同步成功但 pre-unlink | X 拒绝 | fence 拒绝 | 完成准备不等于已提交 |
| fence unlink 成功、尚未 unlock/回消息 | X 暂拒绝 | X 释放后可以接受，其他校验必须通过 | 已提交，不是半成品 |
| 正常提交/进程重启 | 严格 marker+fence 缺失+namespace 校验通过才准入 | 同左 | 不建立新 namespace |
| 物理崩溃后 fence 重现 | 拒绝 | 拒绝 | 不自动清除；安全而不可用 |
| 物理崩溃后 fence 缺失且新 marker/namespace仍有效 | 可按共同验证接受 | 同左 | 前置同步保障其状态；不保证硬件实现 |
| 无 INIT1 的 V2 / 未知标签 | 拒绝 | 拒绝 | 不迁移、不采用当前目录为基线 |

在持久准备完成后又向 marker 写“done”并再 fsync，会制造新的 final-write 窗口；本方案禁止。删除 fence 的安全性来自**所有承诺的正向状态已先同步**，不是从 unlink 自身推导其父目录已经持久化。若产品将来要求初始化成功后激活状态在任何物理断电下仍无人工处理地可用，需要另行明确可用性/恢复协议；本次不悄悄加入 runtime adoption。

## 6. Sol 允许修改的文件与交付顺序

| 文件 | 允许修改 |
| --- | --- |
| `packages/storage/native/storage_marker.h` | INIT1 strict parser、共享 root admission helper、raw/gated 验证拆分；保持所有原 identity/ACL 校验 |
| `packages/storage/native/storage_root_v2.h` | fresh prepare/commit/abort context、durable fence 顺序、边界 test-only hooks |
| `packages/storage/native/storage_native.c` | 仅 open_root fresh 生命周期接线、提交前 writer/probe/对象准备、错误/资源释放；read_marker 保持统一 gated 入口 |
| `packages/storage/native/registered_consumer_protocol.h` 及 `registered_consumer_binding.h` | 必要编译/共享 helper 接线；固定 supervisor 使用同一 admission，不改 ledger/消息格式 |
| `packages/storage/native/phase7_coordination.h`、`phase7_handoff.h` | 仅修复发现的 raw reader 绕行/编译接线；不得重做业务锁 |
| `packages/storage/src/phase7-namespace.test.ts` | parser、新旧协议、初始化 fault/crash/多进程矩阵与作用域断言 |
| `packages/storage/src/phase7-coordination.test.ts`、`phase7-handoff.test.ts`、`purge-derived.test.ts` | 必要直接回归、共同 admission 反例 |
| `tests/fixtures/fresh-storage-root.ts`、storage 原有 fixture/相关集成测试 | 仅新格式期望和 test harness 对接；全部新根，不升级已有 fixture 根 |
| `packages/storage/scripts/build-native.mjs` | 仅如必要编译 test-only 边界 hook/固定 helper；production 不导出 hook |
| `packages/storage/src/index.ts` | 如必要添加稳定错误映射/说明，禁止 JS admission bypass 或自动重试初始化 |
| `docs/progress/PHASE-07-F1-IMPLEMENTATION-STATUS.md`、handoff/本设计关联记录 | 新协议、证据与剩余 gate；不把历史 PASS 当新验证 |

先实施 native 协议和 fresh 生命周期，再补命名边界 hook/测试，再 fresh build addon 和所有受影响 supervisor，最后 targeted verification。禁止先靠 TS 加 flag 暂时放行。改动其它文件必须是本表内协议造成的直接编译或 fixture 兼容；无关重构和非阻塞建议不纳入。

## 7. 必须执行的验收矩阵

测试 hook 只在 `PS_STORAGE_TEST_HOOKS` 构建中，使用明确命名边界，不依赖现有固定 `step < 22` 计数。记录完整 hook inventory 与每个执行结果。initializer 用 test addon 注入暂停/错误，**另一个 OS process 使用 freshly built production addon** 尝试 runtime admission；不能仅用 worker_threads、同一 JS Map 或相同 test bypass 证明跨进程安全。暂停协议用专用 IPC/拥有的 pipe，不增加生产环境开关。

每个 precommit 边界都测：暂停并启动 runtime competitor；注入错误后重开；SIGKILL initializer、确认退出并新进程重开。每个 syscall 错误注入须落在真实分支，包含 fence create/write/fsync/fullsync/root-sync、布局 sync、marker write/fsync/fullsync/root-sync、writer bootstrap、probe、最后 root sync、unlink 失败。最少命名暂停点为：mkdir/取得 X 之前、持 X、fence durable、每类 layout sync、完整 marker write/pre-fsync、marker fsync 后、fullsync 后、root sync 前后、writer/probe 完成前后、最后 sync 后/pre-unlink、post-unlink/pre-unlock、post-unlock/pre-response。

| 验收 | 通过条件 |
| --- | --- |
| root inode flock 实际跨进程/同进程独立 OFD | X 阻止 S，S/S 成功，关闭本次 S 不释放其它锁；无 lock-file fallback |
| 原 pre-fsync 反例 | 生产 addon openRoot、pure reader/coord R-X 均失败；SIGKILL 后继续失败；resume-error 后失败 |
| 每个 precommit sync/error/SIGKILL | 无能力返回；fresh 同路径重试失败；runtime 不写 marker/fence/namespace，不动合成媒体/账务 |
| pre-unlink 杀死 | 所有 bytes 已同步也仍拒绝，证明没有 prepared-state adoption |
| unlink 错误与未知结果 | 分别注入 syscall 前明确失败、真实 unlink 成功后模拟响应错误；前者 fence 保留且拒绝，后者 INIT_COMMIT_UNKNOWN、无 rollback，后续正常验证可准入；query 失败不得修复 |
| post-unlink 杀死与响应丢失 | 新进程正常打开同一固定身份；不能误判为要求拒绝的半成品；稳定 S/S、S/X 语义不变 |
| 并发两个 fresh initializer + runtime opener | 至多一个 mkdir/fresh 提交成功；runtime 提交前拒绝，提交后只接受同一 ID/namespace |
| 所有入口 | writer openRoot、pure Original reader、L/R、purge authority、handoff 创建/注册/发送/settlement、固定 supervisor record 校验均覆盖 fenced root 拒绝；release 仍正常 |
| fence 异常 | regular/空/目录/symlink/坏权限均拒绝；stat I/O 不确定拒绝；缺 marker + 无 fence 仍拒绝 |
| parser/版本 | INIT1 成功；无标签 V2/未知/重复标签/尾随/NUL/超长/数字溢出拒绝；旧 V1 和修复前 V2 strict parser 拒绝 INIT1；不改 ID/K |
| 原 F1 namespace/handoff 反例 | old/new handle、新进程、restart、active reader 与 outstanding handoff 的移动/替换仍拒绝，零媒体 mutation、零容量释放 |
| 正常直接回归 | storage marker/namespace/coordination/handoff/purge 与 DEV Phase7 purge integration/races，skip=0；保持 unknown-COMMIT 等原语义 |
| 构建接线 | fresh addon、test addon、registered supervisor 全部来自当前源码；production 无测试 hook；不能只重编 addon 留旧 helper |
| 重启安全模拟 | fence 保留/重现状态拒绝（合成 fixture 状态测试，明确不是物理断电证据）；提交后正常新进程接受 |

进程 kill/error 不执行 real media purge。所有 root/媒体均自创合成数据；按用户最新授权可使用专用系统 tmp 容器的不存在子 root，保存确切 ownership 并精确清理，不扫描其它 tmp/个人文件，不改 ACL 或 native policy。该授权覆盖原 coordination design 的旧项目内 fixture 限制。若 native policy 仍阻塞则报告阻塞，不降级安全检查。

证据保存到项目 ignored `.cache/phase7-f1-design/` 下新子目录：源码/build hash、命名边界结果、子进程退出和错误分类、fixture cleanup 结果、测试命令与 pass/fail/skip。不得继承旧 69/79 或 implementation 报告的历史测试计数。

## 8. 验收判定、剩余 gate 与范围外

本设计无需用户再次决定关键同步条件，可以交 Sol 实施。任何实现若保留 precommit admission、runtime 删除 fence/补建 namespace、无标签 V2 adoption、提交后必需 sync 失败回滚，或测试将 postcommit 响应丢失误当未完成，均不符合批准方案，不能 close。

实现 targeted tests 与全路径审查通过后，再做限定独立 Astra closure。完整修复尚未跑 milestone gate；closure 后由主线程运行 format、lint、typecheck、unit/API、真实 DEV integration/MySQL race（不静默 skip）、native fault/crash、API/worker/web build、E2E。本文不预先给 PASS，不宣称测试是安全证明。

现有 V1 及无标签 V2 的可运行兼容/迁移仍是单独未授权收尾条件；不自动升级，不重启已有服务。本次不改 DB/schema/0007、K、SQL lease、writer→L→R→CapacityGate 业务锁序、权限/30 天/recent-auth、每 K ledger 或业务删除/容量记账协议。不做全仓审计、真实媒体操作、home ACL/系统软件调整、Bridge、commit/push、额度重置或付费。

```text
INIT_PUBLICATION_DESIGN: APPROVED_FOR_SOL
INIT_COMMIT_POINT: SUCCESSFUL_FENCE_UNLINK_AFTER_ALL_REQUIRED_SYNCS
RUNTIME_PRECOMMIT_ADMISSION: FORBIDDEN
CRASH_BEFORE_COMMIT: REJECT_WITHOUT_REPAIR
CRASH_AFTER_COMMIT_BEFORE_RESPONSE: COMMITTED_RESPONSE_UNKNOWN
POWER_LOSS_AVAILABILITY_GUARANTEE: NOT_CLAIMED
EXISTING_V1_OR_UNTAGGED_V2_UPGRADE: FORBIDDEN_IN_THIS_SLICE
F1_CLOSED: NO
FULL_MILESTONE_GATE_AFTER_FIX: NOT_RUN
PHASE_7_COMPLETE: NO
```
