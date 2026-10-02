# Phase 7 — Final security review

> 历史 finding / 审查状态保留。原 F1 P1 与初始化 P2 已由 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md` 正式 CLOSED / PASS；后续 gate / 阶段状态见最新 milestone 和 final summary。本历史结论不再表示当前 open blocker。

日期：2026-10-02 UTC。审查配置：GPT-6 Astra / Low（本次委派配置）。结论：**NEEDS_FIX：1 个 P1 安全不变量阻塞，Phase 7 尚不能最终关闭。Production Ready 保持 NO。**

审查基线为 7C `b1764a16cec571be43a525a36559acd644e05324`、7D/HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640`，加未提交 `package.json`、`tests/e2e-web/run-suites.mjs` 和 milestone 验证文档。未修改实现、测试、schema、migration，未 stage/commit/push；未运行数据库 purge、worker CLI、真实用户媒体操作或 Production 操作。只新增本报告和 ignored 诊断证据。读取了根及 Web 指令、7A–7D 当前记录与相关源码；项目 `.agents/skills` 不存在。没有访问个人 Codex 记忆或使用 Bridge。

## F1 — P1 / blocking：替换协调目录后同 K 的活跃 reader 不再阻挡物理 purge

位置：`packages/storage/native/phase7_coordination.h:81`、`:125`、`:141`；相关物理 authority 检查 `packages/storage/native/purge_cleanup.h:65`（特别是 81–82）。

`ps_coord_validate_file` 只在句柄保存的 `directory_fd` 下比较 lock FD 与 basename，未把该目录重新绑定到当前根的 `.coord/v1`。`ps_open_coordination` 每次以 create=1 打开/创建协调目录和 lock 文件。若持有 R-S 时 `.coord/v1` 被移动，旧 reader 仍锁住旧目录里的 inode；后续正常调用自动创建新 v1 和新的同 K lock inode。两个锁域具有相同内容 K，却不再互斥。`pg_authority` 检查 writer/root/Derived 命名空间和这两个 lock 文件自身，未发现这种协调锁域分裂。

**触发边界：**需要本机有权移动私有存储目录的进程或运维操作改变 `.coord/v1`；普通 Web 用户不能通过 API 触发该 rename。这不是远程 ACL 越权，也不声称能防御已完全控制同 UID/数据库的恶意主体。问题属于本阶段已采用的“命名空间被移动/替换时 fail closed”存储安全范围：7C-R1 已把 Derived 目录替换列为阻塞并修复；这里同类变化直接打破 purge 的 R-exclusive 前提。当前 exclusive Original/Derived writer 边界不能关闭它，因为纯 R reader 明确不要求全局 writer；复现始终保留同一双 writer，未启动第二 writer、API/worker 共存拓扑或绕过 writer 锁。

### 本轮实际复现

命令（使用现有 native addon 与内部接口）：

```sh
node --import tsx .cache/phase7-final-security/coord-probe.mts
```

ignored 脚本及输出在 `.cache/phase7-final-security/coord-probe.{mts,log}`。脚本只创建、使用、删除它自己拥有的合成空存储根和固定合成字节，不读取任何已有媒体，不连接数据库。按项目 native fixture 惯例使用 canonical 系统临时目录；所有代码/证据在项目内。步骤：

1. 创建 synthetic StorageRoot、DerivedStore，并持有两个现有 writer；写入一份合成 Original，内容 hash/size/0400/目录0700均正确。
2. 对同 K 持有纯 R-S。正常 L-X 后尝试 R-X，得到 `COORD_ACQUIRE_TIMEOUT`（对照）。
3. 保持 R-S 不释放，把 `.coord/v1` rename 为同父目录的 `v1-held`。
4. 新 ContentCoordination 自动建立新锁域，获得同 K L-X/R-X。
5. 用内部 manifest-only `PurgeFilesNative` 原语对该合成 Original 执行 QUARANTINE，返回 QUARANTINED，canonical 不存在；旧 R-S 仍未释放。
6. 关闭所有句柄并删除本次 exact owned 根，输出 `ownedSyntheticRootRemoved=true`。

实际结果：

```json
{
  "control": "COORD_ACQUIRE_TIMEOUT",
  "oldReaderStillHeld": true,
  "newSameKeyExclusiveAcquired": true,
  "physicalResult": "QUARANTINED",
  "canonicalStillPresent": false
}
```

这是 native reader fencing 与物理 authority 的反例，**不是完整 DB intent/purge worker 端到端复现**；诊断直接传入合成 manifest/短期 permit，未绕过或测试 DB 授权。已足以证明 worker 所依赖的同 K R-X 排他性不成立。没有尝试真实 unlink 或声称活跃 FD 立即失效；POSIX FD 可能继续读到已移走文件，但物理 purge 已能在 reader 未退出时开始，违背当前安全前提。

### 最小修复边界 / Astra guardrails

保持现有 K、writer → L → R → CapacityGate 顺序、纯 reader 能力和 schema/权限/retention。最小完整修复必须同时满足：

- 已打开的 L/R/handoff authority 对当前根下 `.coord`、`v1` 的命名 inode/device/owner/mode/ACL 链做验证；在锁准入和物理步骤前失配即 fail closed。
- **不能只修旧句柄校验。** 新调用在旧 reader/未结 handoff 存在时，不能把“目录缺失或已被替换”当成首次初始化，创建一个可独立取得 X 的新锁域。必须以可信、跨相关进程可验证的已初始化 namespace identity 区分首次配置与运行期替换；不确定时拒绝 admission，不自动修复/删除旧目录。
- R-exclusive 必须检查与同一固定 namespace 绑定的 handoff ledger；不能因新空目录就视为无 receiver。
- 同步持有 old R-S、rename `.coord`/`v1`、重新建目录、旧/新 handles、跨进程 reader、未结 handoff 的测试应全部拒绝破坏性准入；没有 DB 进度、容量释放或 canonical/quarantine 变化。正常稳定目录 S/S、S/X 与 crash recovery 必须继续通过。

这些是本轮批准的修复安全约束，并非对新增持久格式或新锁拓扑的实现批准。Sol 可以先定位和实现不改变既定设计的完整身份校验；若“禁止重新建锁域”需要新增 root marker 格式、持久 namespace 记录、额外锁策略或迁移，先返回 Astra 做限定设计，不能只补局部断言后宣告 closure。本报告不授权运维移动/重建已有锁目录。

## 其余限定审查结论

未发现另一个具备具体当前范围影响的阻塞；此结论不等于全仓安全证明。

- Trash/restore/manual purge 在 family-first SQL 锁后验证当前 actor/session；L-X 前 preflight 已结束事务，L-X 后重新授权；all-live-placement delete 不被 ADMIN/SUPER_ADMIN bypass。手动 purge 使用 DB 时间、30 天 retention、15 分钟 recent-auth，revision CAS 与 uint64 上界拒绝，request/audit 原子提交；scheduled request 保留 SYSTEM 身份与同 lifecycle 唯一性。
- 普通 gallery/placement/分享/Original/Preview/Derived 与后台 job/metadata/asset fence 增加 ACTIVE/lifecycle revision 约束；已有任务跨 Trash→restore 不能仅凭 generation 重用旧许可。原始/派生读取的 R guard 与发送前重核路径已查。此处 reader guard 的物理保证仍受 F1 影响。
- purge normalization 对非 READY exact attempt、全部 generation/job identity、实际 absence 与 cleaned_at 保持保守处理；detach 同事务 manifest/引用退休/所有 COMPLETE receipts→RETIRED/PURGING/audit，FINALIZING 冲突阻止 detach。
- Derived manifest 在 Original 前处理，DB 同时拒绝 Derived 未终态/未释放容量时的 Original stage transition。UNLINK_ARMED 前不 unlink；unarmed Original/隔离文件缺失 fail closed；完成要求所有文件 terminal、exact released bytes、删除 storage row 与 DONE/audit 同事务。未知 COMMIT 不 replay。
- 7D 已修 F1/F2 的最终提交前 actor guard、迟到 mutation 回调隔离、原生 showModal/busy focus 在当前源码仍存在。客户端身份 GET 不能原子绑定之后的 Cookie；此已批准限制保持。未知结果不自动 POST，正面只读观察才允许重新明确确认；status404/列表缺席不证明成功，DONE+COMPLETED+completedAt 才报告完成。未把先前 Sol closure 当成本轮浏览器执行。

## 未提交 Web runner 独立复核

**当前补丁 PASS（限定现有两个顶层 spec / 无额外 CLI 参数的 milestone 命令）。** `package.json` 只替换 test:e2e:web 启动命令；runner 排序枚举两个现有 `.spec.ts`，顺序独立 pnpm/Playwright invocation，每次重新加载配置、建立独立 API/Web 和 owned storage harness，非零/启动错误立即停止。配置仍为 workers=1、retries=0、reuseExistingServer=false；全局 teardown 使用各次 nonce-bound storage。生产 auth/rate limit/source/build 命令不受补丁影响。

本轮源级 mock 执行原 runner body：正常分支调用两次、退出0；第一次非零7则只调用一次、退出7。`node --check` PASS。没有将其等同真实 HTTPS 重跑。当前真实 spec 数量/覆盖由历史成功日志的 9+10 证明。未来增加嵌套 spec/其他 testMatch 时需同步 runner 枚举；这不是当前缺失 suite，不列新增问题。历史默认单服务429失败保留，不把它当 skip0 成功。

## 证据新鲜度与本轮验证

读取并核对 `.cache/phase7-milestone/{gate-results,harness-gate-results,harness-final-gate-results}.json`、关键原始 test/integration/Web 日志和 readiness/cleanup evidence。历史 milestone 最终成功：135 files/1335 tests；单独 integration 31/403（与前者重叠）；API E2E 5；HTTPS Web 9+10；最终成功运行 skip0。这些由前一协调任务执行，本审查没有重跑 full gate 或 live MySQL。日志与文档对先前记录器中断、429失败和修复后的受影响检查重跑一致。

本轮 hash 比对 source-manifest 的906项清单（跳过无关 Bridge skill/vendor 包的内容读取）：检查项仅 package.json 与基线 hash 不同，正是已审补丁；其余受审功能/测试内容未变化。Web AGENTS/CLAUDE 与 preserved-manifest 一致。HEAD 仍 a0f4ef7。没有 closure 时点的全文件 hash，故不反向声称早前 7C/7D closure 的逐字节证明；当前 checkpoint 和 milestone 源码一致性已核对。runner 未列入旧 source-manifest，现存历史受影响 gate 日志与当前代码审查作为其证据，不能声称旧 manifest 证明 runner 字节。

本轮实际执行：

| 检查                                                                        | 结果                            |
| --------------------------------------------------------------------------- | ------------------------------- |
| Vitest：trash-eligibility、purge-repository、trash-client、phase7-migration | 4 files / 117 tests PASS，skip0 |
| runner 源级 stub 正常/失败分支                                              | PASS；2次成功、1次失败即停      |
| runner node --check、git diff --check                                       | PASS                            |
| native namespace 反例与物理 QUARANTINE probe                                | 复现 F1；不属于验收 PASS        |
| full milestone / MySQL / browser / worker purge                             | 本审查 NOT_RUN；只审阅历史证据  |

诊断初稿在项目 `.cache` 下建存储根被 native 路径安全校验拒绝（包括一次获批 sandbox escalation 后仍拒绝），无媒体动作；后按既有测试惯例使用 canonical 临时目录。物理 probe 初稿漏建/配置 Derived 目录而在 setup 阶段拒绝，修正合成 setup 后获得上述结果。runner stub 初稿断言 argv 下标错误，修正为实际 suite 参数后通过。所有这些失败不计验收 PASS；未改变被审实现。

指纹：

- current `run-suites.mjs` SHA-256：`64507cedca904c655b9d479f1e4662920df61c516d9f786392229ecf346f21ef`
- current `package.json` SHA-256：`270691d18b63553a0a539639195e2f22cfc83eea4f18e82f72d7bf338101184f`
- production native addon SHA-256：`a5f0b471a134394ab0b61b295df89e499e8043e6eff530e61d9735df528381ed`（与7C记录一致；本轮没有 rebuild）
- 0007 SQL SHA-256：`05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`；无 schema/migration 改动。

## Sol 收尾条件

先关闭 F1 并由 Astra 做限定 blocker re-review；需要持久身份/锁策略变化时先提交限定设计。修复 native/coordination 后重建 native，运行受影响 coordination/handoff/purge native、DEV MySQL race/crash/recovery 与 serving 回归；最终 Phase 7 gate 必须对应修复后的代码，不能沿用修复前1335-test成功作为 fresh pass。随后汇总 Phase 7 final summary、准确记录未提交 tooling 与审查结论，再按已有授权处理限定 checkpoint；本审查本身不执行 Git 操作。

既有 Production 延后项目继续：exclusive-owner 部署拓扑、真实断电/SSD断连、生产部署/运行资格、rate-limit/audit/log等先前未关闭事项。Phase 7 通过也不能将 Production Ready 改 YES；不自动进入 Phase 8。保留未跟踪 Web 指令文件，禁止纳入无关提交。

```text
PHASE_7_FINAL_SECURITY_REVIEW: NEEDS_FIX
OPEN_P0: 0
OPEN_P1: 1 (F1)
NEW_BLOCKING_P2: 0
NEW_NON_BLOCKING_FINDINGS: 0
WEB_TEST_TOOLING_PATCH_INDEPENDENT_REVIEW: PASS (current scoped invocation)
PHASE_7_COMPLETE: NO
READY_FOR_PHASE_8: NO
PRODUCTION_READY: NO
IMPLEMENTATION_CHANGED_BY_REVIEW: NO
DB_PURGE_EXECUTED_BY_REVIEW: NO
STAGE_COMMIT_PUSH_PERFORMED: NO
```
