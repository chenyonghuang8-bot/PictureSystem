# Phase 10 — 通用服务端实施交接

> 更新于2026-10-06 10:05 UTC：本文件下列首轮实施记录保留历史证据。最新合并验收、真实HTTP丢响应/partial-offset恢复、失败/取消记录、最终指纹与复核边界以[checkpoint summary](PHASE-10-SERVER-CHECKPOINT-SUMMARY.md)为准。首轮“未跑full gate/未独立审查”描述只适用于首轮；Astra独立review已完成，此后测试证据已由独立 reviewer 在本报告末尾所引用 closure 中接受。

日期：2026-10-06 UTC。基线 HEAD：`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`，交接时 HEAD 未改变。

## 结论与范围

`COMMON_SERVER_IMPLEMENTATION_HANDOFF_READY: YES`<br />
`COMMON_SERVER_TARGETED_VALIDATION: PASS`<br />
`INDEPENDENT_R3_REVIEW: ACCEPTED_WITH_EXPLICIT_EVIDENCE_LIMITS (pre-checkpoint)`<br />
`UPDATED_TEST_EVIDENCE_REVIEW: ACCEPTED_BY_INDEPENDENT_CLOSURE`<br />
`PHASE_10_COMPLETE: NO`<br />
`PRODUCTION_READY: NOT_ESTABLISHED`

本次仅接续用户授权的 Phase 10 通用服务端工作。依据 `PHASE-10-ANDROID-IMPLEMENTATION-GUARDRAILS.md`（2026-10-05 Astra Low 设计）核对实现并运行 targeted 验证；这是实施者的合同核对与测试，不能替代独立安全审查。未回到 Phase 8 推送等旧任务，未调用 Bridge，未提交、推送、部署、创建 tag 或进入下一 Phase。

实际运行配置：`workspace-write`，`approvals_reviewer=auto_review`。创建接口未提供审批参数；没有设置/修改审批模式或自行点击批准。用户指定 Sol 6.1 Medium/普通速度，工具未提供可独立核实的模型或速度标识，故实际模型标为 unknown。普通编辑/单测使用默认沙箱；实际 DEV MySQL EPERM 后仅对 DEV MySQL/loopback runtime 请求 escalation，获准后执行。无审批拒绝/取消；一次 performance_schema 诊断被 DEV 应用账号拒绝，未扩大权限或改账号。

已读根 `AGENTS.md`、ROADMAP 的 Phase 10 内容、完整 Phase 10 guardrails。仓库 `.agents/` 不存在；本地找到的旧 Bridge skill 明确被禁止，未调用。AGENTS 的旧 Phase 4 状态未被当作本次工作范围；用户本次委托为 Phase 10。

## 工作区保留与本次改动

委托预期 31 tracked 修改、468+/106-；实际开始时已有 34 tracked 修改、1046+/147-，另有迁移、completion、测试等 untracked 文件。所有待续实现保留，未回滚或重写。`apps/web/AGENTS.md`、`apps/web/CLAUDE.md` 原样保留。已有 `apps/web/next-env.d.ts` dev 类型路径改动和 Memories E2E 修复也保留。

本次新增/修改仅：

- 在现有 `tests/integration/phase10-server.test.ts` 的 unknown create COMMIT 测试中补充 COMMIT 已完成但 staging 尚未创建窗口：原 receipt 查询、HEAD 503、create retry 503、payload 不补建、receipt 计数仍为 1。
- `packages/db/drizzle/meta/0009_snapshot.json` Prettier 格式修正；修正前后解析 JSON 深度相等。未改迁移 SQL 或数据库设计。
- 本交接报告。重新构建 API/worker 及依赖的生成文件，未改变业务源码。

交接 tracked diff 仍为 34 文件、1046+/147-；untracked 文件不计入该统计。源码证据清单见 `/tmp/phase10-resume-source-manifest.json`；日志和清单是本机临时证据，应在需要长期保留时另存。报告本身保存关键事实。

## 已实现合同与核对证据

### Credential transport 与 session

`auth/http.ts` 的中央 credential helper 区分 WEB Cookie 与 ANDROID canonical Bearer。拒绝任意 Cookie+Authorization、Bearer+Origin、非 canonical/重复 Authorization；不回退猜测 transport。native anonymous login/invitation 拒绝 Cookie/Origin/Authorization，并保留严格 JSON。

专用 native login/reauth/password/logout 返回 opaque token DTO，不发 Cookie。共享 reads/mutations/TUS 将 expectedClientType 传入 AuthService、AuthContext、各 service actor adapter、auth/Phase1C/album/upload repository，并在锁后检查 DB client_type。Web 登录/Cookie 属性、exact HTTPS Origin、JSON/TUS guards 未放宽；公共 share 路由未改成私有 bearer 路由。

保持 opaque 随机 token、hash-only DB、现有 absolute/idle/recent-auth、rotation/revoke/密码变更边界及既有 checked transaction。实测 transport confusion、锁等待期间 type 改变、reauth 不延长 expiry、Web+Android logout-all、native password replacement/revoke。相关 Web auth/权限/下载回归通过。

### Upload identity / result / placement

`upload-repository.ts` 保存不可变 versioned fingerprint，scope 为 family+owner member+operation ID；receipt 与 targets 在原 create transaction 创建。重复 operation 在 quota/insertion 前查询，fingerprint 不读取后来修改的 targets。TUS datastore 修正实际 response Location 使用原 receipt ID；reused receipt 不重新创建/truncate staging，不使用新随机候选 ID做失败 mutation。

owner-only operation lookup 是当前 actor/family 锁后的 fresh read；result/targets/placement 均以 receipt 作为输入。结果仅返回安全状态分类；mediaId/albumId 需要当前 live placement、ACL、active media、当前 generation/recipe READY 资产。GET 是观察操作；hidden dedup 的源 ID/metadata 不泄露。

placement 先取得既有 K lifecycle shared guard，再进入 checked SQL transaction，复用原权限 helper、family serialization 和原唯一 writer/reconciler；不创造 canonical media 或 READY。全 pending target 的 placement 原子提交；APPLIED 是历史记录，不能恢复人工移除的关联；targets 一旦任一 APPLIED 即冻结。未知 COMMIT 经 fresh observation 解决，没有 blind replay/compensation。Trash/purge 可退役 receipt，新 targets 无 media child FK，不阻塞现有 purge。

集成测试用实际 synthetic JPEG → TUS/PATCH → finalize → API-owner reconciliation → worker/READY → placement → gallery/binary download。original bytes 与 inode 不变；未 seed media/jobs/READY 快捷路径。覆盖 concurrent create、lost PATCH/HEAD、process kill/restart、ACL 全目标失败、hidden dedup、未知 create/placement COMMIT、APPLIED 移除/撤权、stale generation、实际 purge/retirement。

COMMIT-before-staging 的新覆盖说明：operation 查询成功不代表可恢复传输。缺失 staging 时 HEAD 与 create retry 均 503（capacity inventory fail closed），未补建 payload、未新增 receipt；原身份仍可查询。恢复/终止由既有 recovery 策略负责，本次没有增设自动修复 writer。

### Native invitation

`/api/v1/android/invitations/preview` 和 `/consume` 为窄 anonymous JSON adapter，复用 Phase1C rate/capacity/role/creator/expiry/consume transaction。仍是新建 username/password 账号与 membership，非现有账号自动 join/login；并发 consume 仅一次成功，不创建 session。native deep-link 客户端未实现。

## DEV migration 与 readiness

`0009_phase_10_android.sql` 已在此前授权运行应用。本次 **没有运行 apply 或任何 DDL**。

- DB：`family_album_dev`，MySQL `9.7.2`，应用账号 non-root。
- Journal：10 条，`0000`–`0009`；last `created_at=1791215974522`。
- 0009 SQL SHA-256：`e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`，与数据库 journal hash 相同。
- 当前 schema + exact migration history readiness PASS（2026-10-06T04:34:34Z）。
- 单测逐个比较 `0000`–`0008` SQL 与基线 Git bytes：PASS。
- Additive 变更：nullable operation ID/fingerprint paired CHECK、owner-scope unique、same-family receipt identity unique、upload_album_targets 及 RESTRICT composite FKs、APPLIED/applied_at CHECK；无 destructive backfill、无 media child。
- 按用户后续更窄范围，本 migration **不含 FCM/device registry 表**；device API/provider/signing 也未实现。将来恢复这些工作需按批准设计和独立版本迁移处理，不能修改已应用 0009。

## 旧证据核查

旧日志均来自此前运行，通常不含完整命令/退出码；因此其汇总只作历史记录，本次 fresh 有标题/UTC/退出码日志用于验收。Vitest 旧显示时间为机器 UTC+08；mtime 已按 UTC 核对。

| 旧日志                        | UTC mtime | 实际记录/局限                                                                                                 |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| phase10-unit-first            | 03:43:36  | 11 files /117 PASS，缺少命令/退出码                                                                           |
| phase10-server-first          | 03:45:42  | native 10 PASS、integration setup EPERM、7 SKIP；整体 FAIL，不能算 PASS                                       |
| phase10-targeted-unit         | 04:12:16  | 1 FAIL +343 PASS，AlbumService actor expectation；后续 final 344 PASS                                         |
| phase10-targeted-unit-final   | 04:14:11  | 43 files /344 PASS；缺少命令/退出码                                                                           |
| phase10-mysql-regression      | 04:13:14  | 8 files /123 PASS；缺少测试标题/命令/退出码                                                                   |
| phase10-server-final          | 04:19:51  | 3 files /25 PASS，start 显示12:19:42，duration8.47s；dot reporter 无文件/标题/命令/退出码，不能单凭此认定来源 |
| phase10-web-final             | 04:17:43  | Memories 一次 FAIL，不可忽略                                                                                  |
| phase10-web-memories-final    | 04:21:46  | Memories 后续1 PASS；缺少退出码                                                                               |
| phase10-test-source-tsc-final | 04:19:20  | 201 个 TS error 诊断行，包含既有全测试项目类型问题；不是 PASS                                                 |

旧 server-final 的核心 test source mtime 04:19:16、native helper test 04:04:34、completion/repository 04:09:21，早于该日志。但仅 mtime+计数不足以证明命令或构建对应，因此用本次串行 verbose 重跑替代。没有根据上次 ls-remote 窗口宣称完成。

## 本次精确验证

每条 fresh 日志含 UTC_START/UTC_END、命令、退出码（readiness 为只读检查标签）。所有下表测试最终 0 FAIL / 0 SKIP；重复的 core 单测也出现在 unit 组，不把数量相加宣称唯一测试总数。

| 验证               | UTC 起止                                                            | 结果                                              | Exit | 证据                                         |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------------- | ---- | -------------------------------------------- |
| build-dependencies | 2026-10-06T04:30:13.458806+00:00 → 2026-10-06T04:30:26.888224+00:00 | PASS                                              | 0    | `/tmp/phase10-resume-build-dependencies.log` |
| unit               | 2026-10-06T04:29:06.067947+00:00 → 2026-10-06T04:29:11.152584+00:00 | Test Files 50 passed (50); Tests 375 passed (375) | 0    | `/tmp/phase10-resume-unit.log`               |
| regression         | 2026-10-06T04:29:24.439310+00:00 → 2026-10-06T04:30:26.171586+00:00 | Test Files 9 passed (9); Tests 123 passed (123)   | 0    | `/tmp/phase10-resume-regression.log`         |
| core-serial-final  | 2026-10-06T04:33:51.464527+00:00 → 2026-10-06T04:34:00.263888+00:00 | Test Files 3 passed (3); Tests 25 passed (25)     | 0    | `/tmp/phase10-resume-core-serial-final.log`  |
| typecheck          | 2026-10-06T04:29:07.488152+00:00 → 2026-10-06T04:29:14.151694+00:00 | PASS                                              | 0    | `/tmp/phase10-resume-typecheck.log`          |
| lint               | 2026-10-06T04:30:01.902281+00:00 → 2026-10-06T04:30:02.920446+00:00 | PASS                                              | 0    | `/tmp/phase10-resume-lint.log`               |
| format-final       | 2026-10-06T04:32:49.354533+00:00 → 2026-10-06T04:32:50.229385+00:00 | PASS                                              | 0    | `/tmp/phase10-resume-format-final.log`       |
| web-memories       | 2026-10-06T04:31:45.885984+00:00 → 2026-10-06T04:32:34.255986+00:00 | 1 passed; 0 failed; 0 skipped                     | 0    | `/tmp/phase10-resume-web-memories.log`       |
| readiness-cleanup  | 2026-10-06T04:34:34.226Z → 2026-10-06T04:34:34.316Z                 | PASS                                              | 0    | `/tmp/phase10-resume-readiness-cleanup.log`  |

Core：`phase10-server.test.ts` 12、`native-http.test.ts` 10、`phase10-migration.test.ts` 3。最终串行运行在全依赖重建与新增断言之后。

受影响 integration 9 文件：auth-phase1b、phase1c、phase2a、phase3c、phase4d3c2-derived-serving、phase6d3-original-download、phase6d4-preview-download、phase8-upload-pipeline、phase9-memories。按 Vitest integration project 串行；名称中的旧 Phase 只是受影响回归，不是重新进入旧任务。

Unit 50 files/375：auth、Phase1C、album、upload、derived-serving、original/preview-download、share、trash、contracts、auth repository/transaction/migration。Typecheck 为 API/DB/contracts/Web。Lint 为 changed TS +本次相关 untracked TS。Format 为 changed TS/JSON +相关 migration/test 文件。`git diff --check` PASS。

API/worker 及 workspace dependencies build PASS；没有把它当作 Android build 或全仓 build。Web 仅执行 Memories 合成 HTTPS E2E（含真实登录/upload/READY/cards/Viewer），1 PASS；其他 Web E2E 仅历史证据或本次未重跑。没有执行 full Quality Gate、全仓 test-source tsc、Android build/install、真实设备/FCM 或 Production 验证。

### 本次非成功运行保留

- `/tmp/phase10-resume-core.log`：默认沙箱 EPERM，exit1；13 PASS /12 SKIP，setup FAIL。没有 silently skip 当 PASS。
- `/tmp/phase10-resume-format.log`：exit1，0009 snapshot 格式告警；格式修正后 `format-final` exit0，JSON 语义一致。
- `/tmp/phase10-resume-core-final.log`：exit1，24 PASS/1 FAIL；新增测试误期待 missing staging create retry 201，实际503。按已批准 fail-closed 合同修正期望，未修改业务行为。
- `/tmp/phase10-resume-core-verified.log`：exit1，20 PASS/5 FAIL；与 Web E2E 短暂重叠，READY wait timeout 导致后续 placement/dedup/purge 连带失败。两套真实流水线共用 DEV 全局 claim，跨进程重叠是本次实施者安排错误；并发干扰是基于时间与串行复测的原因判断，并非已独立证明的生产缺陷。Web 退出后串行 core 全部 PASS。今后所有使用同一 DEV queue/storage pipeline 的 suite 跨进程也必须串行。
- 一次只读 performance_schema threads 查询被 `ER_TABLEACCESS_DENIED_ERROR` 拒绝；此前 readiness/SHA读取已成功。未改权限，最终去掉诊断后只读 readiness/cleanup exit0。

## Cleanup 与边界

最终核查 04:34:34 UTC：`p10_` synthetic family=0、user=0；系统 tmp `p10-server-*` 14 个历史容器，media root `r`=0。当前套件 afterAll 成功、子 API/worker stop、SQL fixture 清理、临时媒体根清理完成；现有 fixture exit handler负责本进程容器。本次未删除其他运行遗留容器或生产数据。Web afterAll/global teardown 成功，测试私有临时 HTTPS certificate/media 由既有 owned harness 清理，不改 keychain/home ACL。

未读取真实家庭媒体、未调用第三方 AI/上传照片、未共享 DEV/PROD media、未输出 env/credentials/token/hash、未改变 home ACL/MySQL global/root/password/系统服务。未操作额度卡、购买额度或新确认 reset。

## 剩余门槛与一次独立审查清单

请由未参与本实现的 reviewer 按此 batch 独立审查；本报告不对自己作独立安全审批。审查 blocker 修复/复核完成前不得称 final approved。

- transport 全链路：route helper → AuthContext/actor →各 repository锁后 exact type；重复原始 HTTP header、Cookie/Bearer/Origin混用、Web mutation CSRF/CORS/TUS、binary download、匿名 share隔离、session expiry/recent auth/revoke边界与 logs白名单。现有10 helper测试不能替代真实恶意HTTP parser矩阵。
- operation create：immutable normalized fingerprint、receipt/targets atomically创建、actual TUS Location、quota/staging单次副作用、未知COMMIT/未建staging/过期失败 recovery、owner/current-member非披露；审查生产 capacity路径和 fallback的一致性。
- result/placement：fresh锁后time/type/owner、K生命周期先SQL、family/album/grant/receipt/storage/media/derived/targets/placement锁序、当前READY recipe/source/ACL、all-target commit、APPLIED不可复活、PUT freeze、unknown outcome观察、Trash/purge退役无FK阻塞。
- invitation：原new-account语义，creator revoke/disable/role drift/expiry/race、native anonymous guard/rate limiting、未知consume outcome及无token日志。深链输入/冷暖启动属于以后客户端验收，未由adapter测试证明。
- 旧 standalone全测试 `tsconfig.vitest.json` 有类型诊断，尚未作为本次单独检查修复；与 package typecheck PASS区分，独立审查应判断 Phase10相关测试/类型是否还有遗漏。cross-process DEV suite干扰必须规避。
- 全目标更大数量、权限组合、用户/member disable和expiry在所有新操作上的矩阵、真实HTTP重复header、更多storage故障窗口仍需独立审查判断是否补测；不能把有限 targeted PASS当 exhaustive安全证明。

外部门槛仍缺：华为/荣耀具体型号、OS、APK兼容性与GMS/可用模拟器；Firebase项目/provider配置；用户签名材料与release TLS环境。Android客户端、queue/private media loader/deep links、FCM表/API/token注册、签名APK/build/install/launch及家人设备测试全部暂缓，未扩鸿蒙或厂商SDK。Phase10签名APK交付尚未完成；独立审查+平台门槛+最终完整验收未满足，停在通用服务端交接，不进入Phase11。

## 关键源码 SHA-256

- `tests/integration/phase10-server.test.ts`：`8b22f03c398ec1198d2be836a75b6dbfc25e847e3ac3547252bca0dead556d3d`
- `apps/api/src/auth/native-http.test.ts`：`fa09ebc12d96867e26466870d9f86590d3ad484bd2e9b877a94be578b11ef02c`
- `packages/db/src/upload-completion.ts`：`c25334aaf0807bb5939b3f122718e92441dec1fb008f16b3f777602c48848d8f`
- `packages/db/drizzle/0009_phase_10_android.sql`：`e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`

## 最新合并验收交接（2026-10-06）

- 最后版本完整integration：37files/474PASS/0FAIL/0SKIP，exit0；复用未变源码的unit1210/API E2E5/WebHTTPS21、正式typecheck/lint/format/server-Web-build PASS。
- root test-source tsc：201 baseline diagnostics，exit2 FAIL；file/code/message新增0/移除0，不能并入PASS。
- E1服务端组合实证已补足：真实downstream response loss + partial offset SIGKILL/restart + operation/HEAD/result先观察后恢复；Node测试客户端不代表Android队列/nativeTLS验收。E2仍为非穷举覆盖。
- 相对独立审查仅core integration证据与3个schema static测试变化，业务/permission/transaction/schema/migration未改。此前business review仍适用，新测试/门禁事实待父针对性复核。
- DEV schema/history readiness、0009 SQL/journal hash一致；未apply。清理本批15个空tmp容器，并在事务中按原afterAll顺序清理已证明属于暂停的1个auth family/2个user；Phase10和auth synthetic family/user为0、p10 media roots为0，旧Web harness媒体目录保留未读。首次UTC残留时间窗查询的CST假阴性已在summary更正。
- 详细命令/UTC/exit、完整变更列表及历史FAIL/SKIP/取消在[checkpoint summary](PHASE-10-SERVER-CHECKPOINT-SUMMARY.md)；51项候选指纹在[manifest](PHASE-10-SERVER-CHECKPOINT-FINGERPRINT.json)。
- 本批服务端交接可供复核；未提交/推送/部署。Android/FCM/签名仍暂缓，全Phase10未完成。

## 本次委托最终证据对齐（2026-10-06 10:28 UTC）

`COMMON_SERVER_CHECKPOINT: ACCEPTABLE`<br />
`E1_SERVER_EVIDENCE: CLOSED`<br />
`E2_COVERAGE_LIMIT: RETAINED_NON_EXHAUSTIVE`<br />
`PHASE_10_COMPLETE: NO`

以上接受结论引用 [独立审查报告的限定 closure](PHASE-10-SERVER-INDEPENDENT-REVIEW.md)，不是本实施者自行审批。该 closure 已实际复跑 static 3 files/14 PASS 和真实 DEV HTTP/MySQL 1 file/12 PASS，均 0 skip、exit0；未发现新的代码 blocker。首轮与 checkpoint 中“待父复核”的历史描述由此更新，原证据边界继续有效。

本轮重新计算全部51项候选指纹，仅独立报告因追加 closure 与旧清单不同，业务、contracts、schema、迁移、测试、guardrails、Web保护文件均一致。原 checkpoint manifest 保留为 append 前快照；[当前交接指纹](PHASE-10-SERVER-HANDOFF-FINGERPRINT.json)包含最新报告 hash 和原快照 hash。当前 sourceSetSha256：`12b696d7609c933b471843b7f9637339abe90731dc86e4adbcbf20e35e9cccd6`。未修改独立审查报告。

本轮实际补跑命令：`pnpm exec vitest run apps/api/src/auth/native-http.test.ts packages/db/src/phase10-migration.test.ts --reporter=verbose`。UTC 10:28:26.576731 → 10:28:27.465845，2 files/13 PASS/0 FAIL/0 SKIP，exit0；日志 `/tmp/phase10-checkpoint-delegation-transport-migration.log`，SHA-256 `4d5ae55764188372de37e6f9b71e4956647dbce523abd8eb343cc443ccd09828`。完整测试标题逐项核对，`0000–0008` bytes仍与HEAD一致，0009 SHA未变。本轮未重复已有独立12项真实服务端集成或全套门禁，不把历史PASS计作本轮新增执行。独立closure HTTP日志为verbose正文，UTC/exit0依据该独立报告记录；最终474项integration日志另有完整COMMAND/UTC_START/UTC_END/EXIT_CODE。

已重新读取并核对最后有效 unit1210、integration474、API5、Web21、lint/format/package typecheck/build 日志的命令、UTC、退出码及摘要；相关源码指纹一致，可复用。本轮 `git diff --check` PASS。extra root test-source tsc仍为exit2、201基线诊断的FAIL，未重跑或修复；旧EPERM skip/失败/取消日志继续保留。旧 `/tmp/phase10-server-final.log` 缺标题/命令/退出码，仍仅作历史材料，不作为当前验收来源。

本轮没有新数据库、HTTP服务或媒体fixture运行，因此没有新增runtime cleanup；沿用上述实际cleanup记录，不声称重新执行历史删除。审批仍为workspace-write/auto_review；本轮只读、报告编辑及13项单测使用默认沙箱，没有提权申请或修改设置。HEAD仍为`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`，工作区待续实现与无关文件保留，无commit/push/deploy。

服务端实施交接已完成且有独立checkpoint接受证据；该范围可收口。Android客户端/build/install、家人设备兼容性、Firebase/FCM/provider及用户签名材料仍按本委托暂缓。客户端持久队列、nativeHTTPS/TLS、deep links和真实设备验收未执行，Production就绪未建立；整个Phase10仍未完成，不进入下一Phase。E2非穷举覆盖和extra tsc基线FAIL仍如实保留。
