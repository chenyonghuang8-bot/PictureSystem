# Phase 7 F1 — 固定协调 namespace 身份修复设计

2026-10-02 UTC；GPT-6 Astra / Low 委派。**设计批准：按下述限定方案实施；F1 仍 OPEN，需实现和独立 closure 后才能关闭。** 本轮只读源码并写设计，未执行新探针、数据库操作、媒体操作或 Git mutation。没有使用项目外临时目录；后续诊断只能放在项目 `.cache/phase7-f1-design/`，native 若拒绝该路径，只报告验证受阻，不改用系统临时目录。

## 1. 要修复的性质

F1 证据及准确源码位置见 `PHASE-07-FINAL-SECURITY-REVIEW.md`。当前同 K 的 R-S 保持时，移动 `.coord/v1` 会让新调用建立另一套 lock inode，R-X 和物理 QUARANTINE 随即成功。双 writer 不能替代纯 reader fencing。

修复必须使同一个受信 StorageRoot 在所有新/旧句柄、所有支持的进程和进程重启后只承认一个 `.coord/v1` inode 链。丢失/替换不能被 runtime 当成首次创建。只比较旧目录 FD、仅对旧句柄补 recheck、在 README 禁止 rename、依赖双 writer 或进程内 Map，都不满足此性质。

威胁边界保持既有 native 存储边界：检测私有 namespace 的缺失、移动、替换、错误权限/ACL/设备，不增加对完全控制同 UID、可伪造整个受信 root marker/修改应用二进制的恶意管理员的抵抗承诺。外部配置的 expectedMarkerId 和 root marker 仍是身份信任入口；不能在读失败时生成新身份并自动更新配置。

## 2. 决策：将目录身份放入现有 root marker 的 V2 格式

批准小幅扩展 native `.storage-root` 持久格式，而不新增数据库 migration、表、列或第三方服务。使用现有 marker 承载绑定，避免另设可丢失的 sidecar 后又把 sidecar 缺失解释为可初始化。

V2 保留现有32位十六进制 marker ID，增加固定的 root、`.coord`、`v1` 身份。K 仍为现有 root device/inode + marker ID + family/SHA/size；L/R basename、flock 模式、租约、DB schema0007、handoff record业务身份都不改。不是给新目录生成新 K 来绕过旧 reader。

建议精确 ASCII 单行格式（Sol 应按此定型，不自选宽松 JSON parser）：

```text
FAMILY_ALBUM_STORAGE_V2:<marker32>:<rootDev>:<rootIno>:<coordDev>:<coordIno>:<coordBirthSec>:<coordBirthNsec>:<v1Dev>:<v1Ino>:<v1BirthSec>:<v1BirthNsec>\n
```

`marker32` 为小写hex；其余为无前导零的非负十进制，device/inode非零，秒按 macOS有效非负值，纳秒0..999999999。字段数量、末尾LF、总长（上限512字节）严格固定；拒绝溢出、尾随数据、NUL、未知版本、短读/超长。底层仍要求 regular、单链接、当前uid/gid、无扩展ACL、0600；已有 V1 宽松模式兼容读取不扩大为 V2 模式。读取前后复核 named/open marker inode、size、mtime/ctime，失配拒绝；将已解析V2字节/身份留在 native capability 中供后续一致性复核。不要把 struct 内存 padding 当作磁盘协议。

目录 birthtime 是 inode复用的附加辨别，不当作密码学身份。平台无法取得或解释这些字段时拒绝 V2 admission；本阶段平台就是 macOS。实际 inode身份以 dev+ino为主，birthtime用于重启后 ABA 检测，且任何字段变化不能自动改写 marker。

为什么不是只加 sidecar：保留原 V1 marker 会使旧二进制忽略新sidecar并继续建立锁域。现有旧 `read_marker` 严格检查 `FAMILY_ALBUM_STORAGE_V1:` 和精确长度；V2使旧二进制新启动/新获取相关能力时技术性拒绝。实现须保留这个不兼容屏障，不能同时写回V1兼容marker。

## 3. 初始化必须是显式、不可重入的新根创建

普通 `openRoot`、`openCoordination`、reader、worker、scheduler不得创建/补建 `.coord` 或 `v1`。V2根即使完全没有媒体和DB记录，缺目录也必须拒绝。

新增一个窄幅 native/TS fresh-root provisioning入口，或将现有 initialize分支收紧为等价语义：**native必须自己用排他 mkdir 创建此前不存在的最终 root目录**，然后持有该 inode完成初始化。路径已存在就拒绝，不根据“目录为空”推断从未初始化。不允许调用者传 `fresh=true`、JS boolean或测试环境变量作为新根证明。父目录使用现有逐段 nofollow/owner/ACL校验。

顺序：

1. 排他创建最终 root（0700），打开并固定 inode；同步父目录。
2. 创建原有布局、`.coord`、`.coord/v1`，全部同设备/0700/当前owner/group/无ACL；同步新目录及父目录。
3. 读取并验证上述 inode和birthtime，生成随机marker ID；以 O_EXCL 写完整V2 marker，full-sync文件，再sync root；再次验证命名链及marker完整内容。
4. 成功后才返回可使用的 root capability。失败关闭所有FD，不返回capability，不自动删除不明文件，不自动把部分目录视为成功。

可使用固定临时marker+no-replace publish，也可 O_EXCL直接写最终marker；在两种情况下，部分写或未知同步结果都必须作为未完成根拒绝，不能自动重建。无需引入通用修复协议。fixture拥有者可删除自己本轮失败创建的准确合成根；runtime不能递归清理失败根。

现有测试常先 `mkdtemp` 再 `StorageRoot.open(initialize:true)`：改为在项目批准测试父目录下先建owned容器，然后把**不存在的子路径**交给新入口。保持测试所有权和精确cleanup。不要为兼容测试留下可对现有root重新初始化的生产后门。

如果 `.storage-root` 本身被移动/删除，普通open必须拒绝；fresh入口对已存在最终root同样拒绝，因此新进程不会“忘记”旧身份。即便整个目录后来被管理员删除再创建，旧配置 expectedMarkerId 也不能自动接受新随机marker；重新绑定现有DB是独立维护操作，不在本修复授权内。

## 4. Runtime共同验证与锁准入

新增单一 native helper（例如 `ps_validate_coord_namespace`），从受信root FD和V2 marker重新打开**当前命名**的 `.coord` 与 `v1`，逐级使用 openat/O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC，检查：

- root当前绝对路径与受信root dev/inode/marker一致；当前V2 marker与capability最初接受的身份一致。
- 每段 named/open dev、ino、birthtime与V2固定记录一致，当前owner/group、0700、同设备、无ACL；拒绝符号链接、非目录、缺失和不确定I/O。
- 保存的 `coord->directory_fd` 与当前v1一致；不能只比较v1下面的basename。
- L/R文件继续做现有named/open、0600、单链接、ACL、inode校验。

`ps_open_coordination` 将顶层目录 create改为0：验证V2 namespace后才允许按当前协议创建某个此前尚未使用K的L/R文件；创建和返回间再次验证namespace。锁文件的既有生命周期规则不改，不新增自动lock文件清理。

`ps_try_coordination` 在flock之前检查，取得flock后再检查；任一失配立即解锁、拒绝返回guard。只有EWOULDBLOCK/EAGAIN表示普通busy。namespace错误必须是稳定安全分类（例如 `COORD_NAMESPACE_UNCERTAIN`），不能伪装成超时并自动无限retry。

在 `pg_authority`、purge inventory/inspect/remove/quarantine/unlink/verify、handoff创建/注册/转交前调用同一验证。物理步骤必须紧邻实际mutation重新检查，保留已有root/Derived/writer/lease检查；没有新的DB锁等待OS锁路径。

旧guard失效时允许close/release来释放本进程FD；释放无需namespace仍然健康。不得由于validation错误拒绝释放并泄漏锁。释放只是资源释放，不能记录已完成purge或完成handoff。

现有held R-S不能阻止本机rename本身。修复的关键是：rename后新进程无法在另一inode链获得有效X；原inode链若被原样放回且所有身份仍匹配，继续使用的是同一锁域，不需要为了这次修复永久锁死root。不要自动执行放回/改marker。

## 5. Handoff与生命周期

V2绑定的是包含既有K锁与ledger的v1命名空间，不能把重新建出的空v1视为没有receiver。`ps_handoff_directory` 在检查 `<K>.h`之前先验证固定顶层namespace；顶层缺失不得走现有ENOENT→允许R-X分支。

handoff对象须保存/拥有足够的root与namespace身份及FD引用，不能在源ReadGuard关闭后只剩旧目录下record FD。注册、SCM_RIGHTS发送、settlement确认和registered-consumer binding都复用共同验证。失败保留未解决record，不把失败误记SETTLED；既有精确child退出与boot/process身份协议不改。

本设计不声称通过普通flock防止同UID任意删除/伪造某个K的lock/ledger内容；那超出本次“.coord/v1整体替换”的已确认F1。不得因此放宽现有每文件校验或missing-ledger处理。如果实施检查发现必须改变每K ledger格式/归属才可完成本设计的顶层binding传递，返回Astra，不临时发明另一套handoff协议。

## 6. 旧进程、新进程和重启的明确边界

| 情况                               | 必须行为                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| V2新根，多个新进程                 | 全部从同一marker读取同一namespace；普通S/S与S/X语义不变                    |
| V2进程退出/重启                    | 重读持久绑定，不能采用“这次启动看到的目录就是基线”                         |
| `.coord`或v1移动/替换/缺失         | 旧guard的后续受控操作拒绝；新进程也拒绝，不能mkdir/adopt                   |
| V2 marker缺失/损坏                 | 所有新open/coord admission拒绝；fresh-root入口因root已存在拒绝             |
| 旧二进制新开V2 root                | 旧严格V1 parser拒绝；验收需运行旧parser/旧addon读取合成V2的反例            |
| V1 root被新代码打开                | 可识别为legacy；**不得授予L/R或purge能力**，不自动升级marker或登记当前目录 |
| 已持有旧版本R-S/媒体FD时试图切换V2 | 本修复没有运行期切换入口，因此新代码拒绝V1，不能并行启动V2 purge           |

**已经打开的旧进程不能由新parser追溯撤销。** 旧代码在下一次read_marker检查会拒绝V2，但一个已发送给receiver的媒体FD或已进入syscall的旧操作可能继续。这不是技术性close/revoke保证。不能声称更新marker或取得双writer就证明旧pure reader已退出。

因此本次Sol实施范围**不包括现有V1根原地升级工具或自动兼容adoption**。V1保持原样，返回安全可诊断的“需要受控root升级”；API不能将这种错误降级为无coord运行，worker必须在scan/claim之前校验根协议。现有DEV使用中的root不得在测试时顺手升级。

若后续必须迁移V1，另做明确授权的维护slice：保留原marker ID、原root与原coord namespace，不重建锁域；V2需具有“写入时boot不可激活”的持久activation guard，在内核boot UUID变化后才允许新coord/purge admission，借重启确保旧进程/旧receiver FD全部死亡。转换前要停写并检查DB/namespace/ledger一致性，原子durable更新marker，故障时不自动rollback/retry；有异常旧目录或不确定历史就停止。旧二进制新开V2仍被parser拒绝。**该维护协议、activation字段和实际系统重启尚未批准实施，不能用人为声明“所有进程已退出”替代，也不能为了本次closure执行。** 本段仅明确无法自动证明的迁移边界，避免Sol自行扩大。

V2 fresh根可完成本次F1安全closure；现有V1 DEV根的可运行升级是单独未完成的操作条件，须在最终summary显式保留。不能把该兼容限制隐藏成无影响更新。

## 7. inode ABA、恢复与持久性边界

活跃reader/guard保持旧目录及lock FD时，旧inode仍被引用，简单rename后另建目录无法获得同一个活跃inode；固定dev/ino就能阻挡本次已复现split-lock。birthtime增加重启后inode回收复用的拒绝能力；纯比较“当前同名文件”或进程内缓存不能替代它。

在所有旧FD都关闭、inode被回收后，新目录即便复用ino也须匹配持久birthtime；错一项就拒绝。测试用native test-only stat seam验证ABA判定，不要求真实强迫文件系统重复使用inode。不得注入生产可控“忽略birthtime”开关。

这不是对完整文件系统镜像回滚/恶意伪造root marker的防回滚认证。介质更换、跨设备复制、恢复到新inode会因绑定失配拒绝，重新绑定属于Storage/Restore维护设计；本Phase仍不具Production restore资格。

初始化marker/目录同步失败、部分V2、namespace失配均不改变DB progress、released bytes或audit success，不触碰Original/Derived。已存在intent保持原状态并按现有安全失败分类BLOCKED/服务不可用；只有真正flock busy沿用bounded RETRY_WAIT。DB unknown-COMMIT规则及文件UNLINK_ARMED恢复不变。

## 8. Sol实施边界与验收矩阵

预计限定修改：native marker parser/fresh initializer、coordination namespace helper、purge authority/handoff接线、TS窄入口与fixture setup、worker启动前协议检查及相关测试。不要改0007、权限、30天、recent-auth、K、SQL lease或writer/L/R顺序。修改其他模块只能为编译/同仓fixture兼容，禁止借此重做storage API。

| 验收                                                   | 必须证据                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| F1原复现：R-S仍活跃，移动v1                            | 新L/R准入失败，canonical/quarantine不变；不得显示QUARANTINED                                   |
| 同上移动整个`.coord`、替换为空目录/复制旧目录/符号链接 | old/new handles及新进程都拒绝；零DB进度/容量释放                                               |
| guard已取得后、物理mutation前替换                      | native authority拒绝；不得仅依赖TS检查                                                         |
| 替换后重启进程                                         | 仍拒绝，不以新进程状态重新baseline                                                             |
| marker移走/损坏/截断/未知版本                          | runtime与existing-path initializer都拒绝，不创建新marker/coord                                 |
| 初始化首次并发、每个write/sync边界故障                 | 至多一个成功capability；失败根不能自动再登记                                                   |
| 身份属性                                               | dev/ino/birthtime/owner/group/mode/ACL全部分别拒绝；ABA seam拒绝                               |
| 旧/新版本                                              | 旧严格V1 parser拒绝V2；新coord拒绝V1；无自动upgrade路径                                        |
| handoff未结、源guard退出、receiver仍活跃               | namespace变动不能被当空ledger；不发送新FD、不伪造settlement、不准入X                           |
| 正常功能                                               | stable root多进程S/S、S/X、纯reader无需writer、K隔离、long reader与注册消费者退出后正常恢复    |
| purge恢复                                              | Derived-first、容量释放、unknown-COMMIT、rename/arm/unlink/SIGKILL恢复仍通过                   |
| 兼容与隐私                                             | 0007/schema/config expectedMarkerId不变；no raw path/token/private content日志；V1拒绝说明明确 |

所有新fixture、探针、故障产物均须在项目 `.cache/phase7-f1-design/`（或协调方指定的项目内目录）且按exact ownership清理。当前native逐段ACL校验可能拒绝项目根路径；若如此，记录 `VALIDATION_BLOCKED_BY_PROJECT_ROOT_NATIVE_POLICY`，继续源码/纯parser测试，交回协调方解决项目内合规测试根，**禁止换到系统tmp、弱化native路径校验、chmod项目外祖先或把NOT_RUN写PASS**。

先构建native，再运行受影响marker/coord/handoff/purge targeted tests；由独立Astra对本设计关键性质作closure。涉及真实MySQL/完整milestone时由协调方安排对应修复后的fresh gate，历史gate不能继承为修复后PASS。没有通过项目内合成native反例回归前，F1不得关闭。

```text
F1_LIMITED_DESIGN_APPROVED_FOR_SOL: YES
ROOT_MARKER_V2_FRESH_ROOT_PROTOCOL: APPROVED
V1_RUNTIME_AUTOMATIC_ADOPTION: FORBIDDEN
V1_IN_PLACE_MIGRATION_TOOL_OR_REBOOT: NOT_AUTHORIZED_BY_THIS_DESIGN
DB_SCHEMA_0007_CHANGE_REQUIRED: NO
LOCK_ORDER_OR_K_CHANGE_APPROVED: NO
F1_CLOSED: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
IMPLEMENTATION_STAGE_COMMIT_PUSH_THIS_TASK: NO
```
