# Phase 7 — Milestone validation and final-review handoff

> 下方为 7D / F1 修复前历史 gate。最终 F1+INIT1 后 fresh gate 见文末追加记录；历史 PASS 不代替新结果。

日期：2026-10-02（UTC）。本轮按用户授权建立7D限定本地checkpoint，然后执行fresh Phase7 milestone Quality Gate；仅DEV synthetic fixtures，不访问真实媒体/Production，不push或启动Phase8。

## Baseline and checkpoint

7C baseline：`b1764a16cec571be43a525a36559acd644e05324`。7D checkpoint：`a0f4ef7393ab51b0795d7126f1110e243e1cb640`，`Complete Phase 7D trash UI`，31个限定实现/测试/设计/实施/审查文件。原未跟踪 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md` 保留并排除；schema/migration/lockfile未变。7D F1/F2独立closure PASS见 `PHASE-07D-INDEPENDENT-REVIEW.md`；完整gate和最终安全复核不是该closure的范围。

UTC 13:25:04开始checkpoint准备；13:26:44开始milestone gate。closure未提供逐文件hash，本轮不机械声明closure时点字节证明；同步实施记录前后hash比对确认功能/测试未改。后续gate以7D checkpoint源码为基线。

## Validation recorder interruption

首次13:26:44 UTC运行的format/lint/typecheck/native、135文件1335测试、31文件403 integration及workspace build已实际通过。13:30:13启动API E2E后，Playwright清理默认test-results目录，使同目录下记录器的gate-results.json写入失败，Python记录器退出。该失败不是业务测试失败；API E2E该次的exit/status未留下可靠记录，不计通过。原ignored诊断/日志可能随默认清理消失；没有改源码或未提交用户文件。

13:31:16 UTC将证据移至项目ignored `.cache/phase7-milestone/`并重跑完整gate，以下最终证据使用重跑结果。

## Fresh gates

完整验证本轮实际执行；最终采用下表成功结果（日期均为2026-10-02，UTC），失败历史保留。

| Command                                            | UTC start–end     | Final result                                |
| -------------------------------------------------- | ----------------- | ------------------------------------------- |
| `pnpm format:check`                                | 13:39:18–13:39:20 | PASS                                        |
| `pnpm lint`                                        | 13:39:20–13:39:23 | PASS                                        |
| `pnpm typecheck`                                   | 13:31:21–13:31:27 | PASS                                        |
| `pnpm --filter @family-album/storage build:native` | 13:31:27–13:31:36 | PASS                                        |
| `pnpm test -- --reporter=verbose`                  | 13:31:36–13:33:20 | 135 files / 1335 tests PASS; skip 0         |
| `pnpm test:integration -- --reporter=verbose`      | 13:33:20–13:34:27 | 31 files / 403 tests PASS; skip 0           |
| `pnpm build`                                       | 13:34:27–13:34:45 | workspace/native/Web/mobile/API/worker PASS |
| `pnpm test:e2e`                                    | 13:34:45–13:34:48 | 5/5 PASS; skip 0                            |
| `pnpm test:e2e:web`                                | 13:39:23–13:39:53 | 9 + 10 = 19/19 real HTTPS PASS; skip 0      |

机器记录/原始日志：ignored `.cache/phase7-milestone/gate-results.json`、`harness-gate-results.json`（中间lint失败）、`harness-final-gate-results.json`及各命令`.log`。`pnpm test`包含unit/API与integration；单独integration重跑是复核，不能将两项测试数相加当作独立覆盖。命令的reporter参数以实际记录为准，未改变include/exclude或filter；完整文件/测试数如表。

native build与全套Vitest包含storage原生文件系统、fault-injection、purge normalization/finalize/reference/capacity/unknown-COMMIT/race及SIGKILL恢复。synthetic original文件允许本轮fixture purge，不涉及家庭真实媒体；SIGKILL不是实际断电证明。Web全部spec真实HTTPS/Secure Cookie；7D永久删除请求/异步状态在UI测试中仍mock，不以19/19证明物理purge。

最终7D implementation/test内容与checkpoint一致；只有Web测试启动器变更发生在前面typecheck/unit/integration/build/API E2E之后。该启动器不参与这些命令，它们的功能/测试源及构建脚本没有变化；format/lint/全部Web E2E在启动器最后修改后重新通过，node语法检查通过。不是声明所有gate在最后一个工具文件修改后重新执行。

## Web E2E fixture-isolation remediation

重跑的默认单服务Web gate：9 passed、1 failed、9 did not run。失败为download-validation首个真实登录expected204/received429；不是通过或skip0。`packages/auth/src/rate-limit.ts`既有IP bucket为10次/60秒，新增7D登录/reauth与下载suite共用loopback/API进程，前文件9项成功后后文件触发限流。

最小修复只修改根 `package.json` 的 `test:e2e:web` 启动命令并新增 `tests/e2e-web/run-suites.mjs`。自动枚举现有顶层 `.spec.ts`、顺序启动独立Playwright invocation，使每个spec获得新的API/Web与owned storage harness；每个run仍reuseExistingServer=false/retries=0，退出码非0立即停止，没有跳过suite或重试失败测试。真实认证限流、Cookie、服务端权限与mutation源码均未改；不采用等待窗口、限流调大或虚假Cookie。

该test tooling修复发生在7D checkpoint后，须纳入协调方后续独立复核。node语法检查、全量format/lint以及全部Web spec重跑验证受影响范围；前面的unit/integration/build/typecheck/API E2E所验证源码和脚本均未改变，不将它们冒充修复后重复执行。

## Intermediate check failures

启动器首轮lint发现URL全局未声明及ignored辅助`.mts`里的any。显式导入node:url的URL，辅助检查移为不参与lint的JS文本；最终全量lint/format通过。辅助readiness检查初稿因强制环境变量显式存在而报DEV_CHECK_REFUSED，在连接数据库前停止；按 `packages/config/src/index.ts` 的APP_ENV默认dev规则修正后成功，仍拒绝prod、非family_album_dev及root。未显示凭据、执行DDL或修改应用配置。

## Scope and remaining review

本轮复用现有Vitest/Playwright/native构建；不运行独立worker CLI、真实用户purge或migration。原7C purge integration包括synthetic文件、精确ID清理和七项SIGKILL恢复；完整suite执行成功才可记录通过。权限、30天retention、15分钟recent-auth、schema/事务锁/Original不变量不重设计。Production部署拓扑、真实断电/SSD、production-rate-limit/audit/log等既有延后项目保持。

## Final cleanup and preservation evidence

- UTC13:41:30 read-only DEV检查：`family_album_dev`、非root、MySQL9.7.2、ordinary migration readiness PASS，8 migrations（0000–0007）。23张业务表聚合count均0，包括purge_intents/purge_files/audit_logs；未读取数据行/媒体内容或手动清理未知数据。机器证据：`.cache/phase7-milestone/readiness-cleanup.json`。
- UTC13:40:47 filesystem比较：系统canonical temp与/private/tmp中ps7/phase7/picturesystem-/family-album-前缀，相对第二轮运行前snapshot无新增条目；不会把未知历史目录视为本轮残留或删除。purge suite的afterAll另按owned exact family/root核对DB历史记录和含quarantine的root不存在，全部断言已随full suite通过。这不是全系统临时目录无文件的声明。证据：`filesystem-cleanup.json`。
- UTC13:40:54：4000/4400/3443无监听，按项目路径/测试用途匹配的API/HTTPS/Vitest/crash/native/download进程无残留；不查询私人文件或终止未知进程。证据：`process-cleanup.json`。
- Next dev产生的 `apps/web/next-env.d.ts` 已恢复checkpoint字节；全部checkpoint tracked内容只有根package.json的测试命令存在变更。Web AGENTS/CLAUDE hash与原基线保持；source-manifest/preserved-manifest记录于同目录。
- schema/migration/lockfile与checkpoint无差异。0007 SHA-256=`05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`，无0008；final migration manifest记录于同目录。
- `.cache`日志/诊断与构建产物保留用于证据，不纳入Git。没有限额耗尽/重置或额外付费操作。

## Final independent/security review handoff

协调方下一步：复核7D checkpoint `a0f4ef7393ab51b0795d7126f1110e243e1cb640`与本轮新测试启动器patch，结合7A–7C既有设计/closure和这次fresh完整验证，完成Phase7最终安全复核。关注跨账号UI guard/迟到响应、真实modal隔离、未知mutation不重放、all-placement permission提示与最终服务端授权、真实purge recovery/reader fencing，以及新增runner是否逐spec全覆盖且保持limiter/retries/owned cleanup。启动器为本轮新增未提交的test tooling，原7D closure不覆盖它，需要限定独立复核；本报告不是最终安全审查。

当前Git：main，HEAD为7D checkpoint；待审查工作区仅根package.json、新run-suites.mjs、本验证记录及原Web AGENTS/CLAUDE。没有自动提交未审查测试工具patch，未push；最终Phase7完成checkpoint由协调方在review后处理。本轮不新增phase-complete tag、不改旧handoff/AGENTS历史阶段、不进入Phase8或生产。Production延后事项继续见上节及Phase6/7C记录。

```text
PHASE_07D_LOCAL_CHECKPOINT: a0f4ef7393ab51b0795d7126f1110e243e1cb640
PHASE_07D_TARGETED_CLOSURE_PASS: YES (prior independent record)
PHASE_7_MILESTONE_GATE_PASS: YES (after Web fixture isolation; affected checks rerun)
TESTS_SKIPPED_IN_FINAL_SUCCESSFUL_RUNS: 0
SCHEMA_OR_SECURITY_DESIGN_CHANGED: NO
WEB_TEST_TOOLING_PATCH_INDEPENDENT_REVIEW: PENDING
READY_FOR_PHASE_7_FINAL_SECURITY_REVIEW: YES
PHASE_7_FINAL_SECURITY_REVIEW: NOT_RUN
PHASE_7_COMPLETE: NO
READY_FOR_PHASE_8: NO
PRODUCTION_READY: NO
PUSH_PERFORMED: NO
```

## F1 + INIT1 closure 后最终 fresh gate（当前有效结果）

2026-10-02 UTC，HEAD `a0f4ef7393ab51b0795d7126f1110e243e1cb640` + F1/INIT1 working tree。正式 Astra limited closure 已 PASS，原 F1 P1 和初始化 P2 CLOSED；见 `PHASE-07-F1-INIT1-INDEPENDENT-CLOSURE.md`。本节 supersedes 上方旧 gate 和旧待审状态。仅 DEV synthetic fixture，无既有 root 升级/服务重启，无生产或真实媒体动作。

| Gate                                         | UTC start–end     | 最终结果                            |
| -------------------------------------------- | ----------------- | ----------------------------------- |
| native production/test addon + fixed helpers | 16:01:44–16:01:56 | PASS exit=0                         |
| format                                       | 16:06:30–16:06:33 | PASS exit=0                         |
| lint                                         | 16:09:50–16:09:53 | PASS exit=0                         |
| typecheck                                    | 16:12:16–16:12:22 | PASS exit=0                         |
| workspace builds                             | 16:03:42–16:04:08 | PASS exit=0                         |
| unit/API + integration/native fault/crash    | 16:09:33–16:11:20 | PASS 136 files / 1444 tests; skip=0 |
| DEV integration/MySQL race                   | 16:11:32–16:12:45 | PASS 31 files / 407 tests; skip=0   |
| API E2E (owned fresh INIT1 root)             | 16:05:34–16:05:37 | PASS 5/5; skip=0                    |
| Web E2E (reviewed independent suite runner)  | 16:12:54–16:13:26 | PASS 9+10=19/19; skip=0             |

全量测试已包含 integration，独立 407 是重叠复跑，不累加为覆盖数。namespace 命名矩阵实际 65 hooks / 192 executions，全部 cleanup=true；native fault/SIGKILL/IPC/handoff/purge recovery 由当前完整测试执行，不将物理断电/SSD 标为 PASS。所有命令/log SHA-256/UTC/exit 在 `.cache/phase7-final-gate-init1/final-evidence.json`。旧 40/41、旧 build 和旧 1335 均非当前最终证据。

### 实际失败与最小修复

- 首轮 lint 被 `.cache` 中历史 probe/version-barrier/legacy-addon 脚本阻挡；原字节改名为 `.source` 证据归档，archive mapping/hash 保留，未修改 lint 规则或产品源码。另一个本轮辅助脚本赋值 lint 已修正；最终原 `pnpm lint` PASS。
- 首轮 build 的 TS6059 来自 storage 将测试编译进 `rootDir=src`，共享 fixture 在外部。唯一 closure 后配置 patch：`packages/storage/tsconfig.build.json` 排除 `src/**/*.test.ts`。不改运行/安全代码，不扩大 rootDir、不弱化 native。生成在 fixture 旁的 `.js/.d.ts` 已精确删除，format 再通过。这个非运行配置差异单列交接，没有声称属于 Astra 原 checkpoint。
- 首轮 full test 与 native rebuild 重叠，qualification 6 个 verifier-unavailable 和 afterAll writer-live 失败，保留 FAIL；后续无构建重跑 verifier PASS。afterAll 的 close 失败阻断合成 DB 清理，导致随后 full/integration 的 capacity 2 个失败。通过本轮限定时间窗、精确 synthetic family/user 身份确认 family 12349/user 23812，自有六组记录按 ID 删除，不触未知记录；23表归零后无重叠串行 full/integration 均 PASS。没有改容量算法、测试断言、超时、retries 或安全校验。

### 当前清理与 byte preservation

- 最终只读 DEV：MySQL 9.7.2、非root、0000–0007 readiness，23张业务表 aggregate counts 全0；`readiness-final.log` / `readiness-cleanup.json`。无 DDL/migration/root密码操作。
- API owned temporary container 精确 removed=true；namespace 192执行的各容器 cleanup=true；其它 storage fixture 的 owned exit cleanup、purge assertions 和两个 nonce-bound Web global teardown 均随成功 suite 执行。未扫描其他 tmp，不额外宣称外部逐一核验了全部未知临时目录；未删除未知目录。
- 4000/4400/3443 无 listener，匹配项目测试/API/Web/helper 进程无残留；`process-cleanup.json`。Next generated `next-env.d.ts` 恢复本轮保存的确切 bytes。
- 101个非文档源码/产物与 Astra checkpoint SHA-256 完全匹配；`reviewed-checkpoint-match.json`。Web AGENTS/CLAUDE 保持原 hash、排除 Git。0007 hash `05a7a3a66c3902de5ddf99e5b77a13fdc5614a7b9a5a3508404c37b657fd4fdd`，db/schema/journal/lockfile无diff。
- `boundary-results.json` 由实际测试重新产生，fresh copy 位于本轮 evidence；历史 acceptance 对当时 bytes 的 hash 是历史记录，不冒充本轮重新生成文件。证据日志/产物不纳入 Git。

### 交付边界

Phase7 功能验收与限定安全 closure 已通过；现有 V1/无标签 V2 root 仍须另行批准的维护升级，禁止自动 adoption。Production rate limiting、持久 audit、production部署、真实断电/SSD等既有 deferred 保留。完整状态见 `PHASE-07-FINAL-SUMMARY.md`。本地 checkpoint 仅授权范围，无 push/tag/Phase8。

```text
F1_P1: CLOSED
INIT_PUBLICATION_P2: CLOSED
ASTRA_LIMITED_CLOSURE: PASS
FINAL_FRESH_FULL_GATE: PASS
SKIP: 0
POST_CLOSURE_RUNTIME_IMPLEMENTATION_CHANGE: NO
POST_CLOSURE_BUILD_CONFIG_CHANGE: TEST_EXCLUSION_ONLY
PHASE_7_FEATURE_ACCEPTANCE: PASS
EXISTING_ROOT_UPGRADE: NOT_PERFORMED
PRODUCTION_READY: NO
PHASE_8_STARTED: NO
PUSH_PERFORMED: NO
```
