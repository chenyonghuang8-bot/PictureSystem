# Phase 10 服务端合并验收 checkpoint

2026-10-06 UTC。HEAD：`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`，未提交。用户 05:00 UTC 左右暂停时已安全取消 integration；09:58 UTC 明确继续，恢复后完成剩余 batch。

## 当前状态

- `COMMON_SERVER_IMPLEMENTATION_CHECKPOINT: DELIVERED`
- `APPLICABLE_SERVER_WEB_GATE: PASS`（下面列明正式命令与范围）
- `EXTRA_ROOT_TEST_SOURCE_TSC: FAIL_BASELINE_201`，没有把该失败包装成 PASS。
- `PRIOR_INDEPENDENT_REVIEW: ACCEPTED_WITH_EXPLICIT_EVIDENCE_LIMITS`，P0/P1/blocking P2=0、mandatory product fix=0。
- `UPDATED_TEST_EVIDENCE_TARGETED_REVIEW: ACCEPTED_BY_INDEPENDENT_CLOSURE`，引用独立报告限定closure，实施者不自行审批。
- `PHASE_10_COMPLETE: NO`；`PRODUCTION_READY: NOT_ESTABLISHED`。

恢复时审批配置仍为 workspace-write/auto_review；没有修改安全设置或自行批准。模型/普通速度依用户指定，运行时无可独立核实模型/速度标识，实际标记 unknown。普通只读 DEV probe 真正 EPERM 后才使用限定 DEV MySQL/native/loopback runtime；无拒绝/取消后的绕过。此次明确继续解除了此前暂停；旧被取消的日志仍保留。

## 范围与新证据

只完成原批准服务端合同的验收收尾。未进入旧 Phase8/9 推送任务或下一 Phase，没有业务架构重设计、产品功能扩展、migration apply、Production 操作、真实媒体读取、home ACL/系统配置变更、quota reset/购买、Bridge/browser handoff、git add/commit/push/deploy。

审查 E1 的服务端证据已补足：

1. 受控真实 loopback HTTP proxy 转发完整请求并消费上游成功响应；在将任何 headers/body 发给客户端前关闭 downstream TCP socket。客户端 fetch 必须 rejected，上游 witness 必须分别为 create201/PATCH204/finalize200/placement200。这是实际客户端响应丢失，不能描述为数据库连接/COMMIT acknowledgement 丢失。
2. create 丢响应后先 owner operation GET 得到原 upload identity，再并发幂等 create，HTTP Location 同一 receipt，DB count仍为1；immutable snapshot/target-edit/mismatch回归仍保留。
3. synthetic JPEG首段只上传一半，`0 < HEAD offset < declaredSize`；丢首段PATCH响应后以HEAD观察，SIGKILL API，在partial offset重启。`/auth/me`当前认证、operation GET与HEAD得到同一receipt/partial offset，再发送剩余段（其响应也真实丢失），HEAD权威offset到declaredSize；stale offset PATCH409。
4. finalize响应丢失后GET result观察COMPLETE，不盲重放。经原API-owner/metadata worker真实pipeline到READY；placement响应丢失后GET result观察当前APPLIED/ACL身份，不盲重放placement。gallery/derived/original/preview实际可用，Original bytes/inode不变；没有seed media/jobs/READY来伪造成功。

恢复后没有重复添加以上测试；最后版本在完整integration中通过。client行为由Node fetch测试驱动证明，只证明可用的服务端恢复接口和受控HTTP路径，不是Android持久queue/SecureStore/TLS/OS death全链路验收。已有真实repository commit后抛错的fault seam仍单独保留，不能改名为TCP丢响应。审查E2代表性actor/race覆盖仍非穷举，未宣称所有排列通过。

## 相对独立审查之后的实际变更

业务源码、schema、0009、contract及guardrails与独立审查指纹一致；恢复时原审查清单仅integration test有预期漂移。另3个static tests不在原46候选清单内，新增diff明确列出：

- `tests/integration/phase10-server.test.ts`：受控response-loss helper、partial-offset重启、观察后恢复组合；失败时仅输出自有family的固定job类型/state/failure code诊断，无raw错误/paths/token/EXIF。
- `packages/db/src/phase3-schema.test.ts`：当前upload索引/check准确识别0009新增项。
- `packages/db/src/phase4-migration.test.ts`：旧index count改为当前8个明确index名称，保留历史migration/snapshot断言。
- `packages/db/src/phase7-migration.test.ts`：比较冻结0007 topology时只剔除明确批准0009的2columns/2indexes/1check；其余历史columns/types/indexes/FKs/checks继续严格相等，0009由独立migration/readiness测试检查。
- 文档交付：更新 `PHASE-10-SERVER-IMPLEMENTATION-HANDOFF.md`；新增本summary和`PHASE-10-SERVER-CHECKPOINT-FINGERPRINT.json`。独立review报告未修改。

没有为了让测试通过而放宽业务权限或改变migration。暂停后未发现新用户源码变动：所有source edits早于暂停；原审查business hashes匹配，恢复开始保存50项清单，测试完成时0 drift。没有暂停点全量专用hash清单，因此复用也明确依据独立business hashes、现有日志时间、源码mtime与恢复期间指纹稳定，不能伪称有未保存的暂停指纹。Next自动生成next-env在build/dev中切换后恢复审查时内容，非手工回滚。

## 最后版本的门禁与复用

除integration/readiness/cleanup外，复用暂停前有完整命令、UTC和退出码的有效证据；相关源码未变、最后的HTTP观察顺序测试仅影响integration，恢复后完整重跑该project。不盲目全重跑。unit与integration共1684项（1210+474），core25包含在其中，未重复累计。

| 命令                                                          | 结果                                                        | Exit | UTC起止                                                             | 证据                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm lint`                                                   | PASS；0 warning                                             | 0    | 2026-10-06T04:58:53.220989+00:00 → 2026-10-06T04:59:00.297533+00:00 | `/tmp/phase10-checkpoint-lint-last.log`                   |
| `pnpm format:check`                                           | PASS                                                        | 0    | 2026-10-06T04:58:53.221234+00:00 → 2026-10-06T04:59:01.043136+00:00 | `/tmp/phase10-checkpoint-format-last.log`                 |
| `pnpm typecheck`                                              | PASS（正式 package 检查）                                   | 0    | 2026-10-06T04:58:53.223833+00:00 → 2026-10-06T04:59:06.043093+00:00 | `/tmp/phase10-checkpoint-typecheck-last.log`              |
| `pnpm test --project unit --reporter=verbose`                 | 127 files /1210 PASS /0 FAIL /0 SKIP                        | 0    | 2026-10-06T04:55:08.290043+00:00 → 2026-10-06T04:55:44.206076+00:00 | `/tmp/phase10-checkpoint-unit-final.log`                  |
| `pnpm test:integration --reporter=verbose`                    | 37 files /474 PASS /0 FAIL /0 SKIP                          | 0    | 2026-10-06T10:01:26.821488+00:00 → 2026-10-06T10:03:34.683532+00:00 | `/tmp/phase10-checkpoint-integration-resumed.log`         |
| `pnpm -r --filter '!@family-album/mobile' --if-present build` | server/Web/shared build PASS；排除 mobile export            | 0    | 2026-10-06T04:54:27.386512+00:00 → 2026-10-06T04:54:45.923386+00:00 | `/tmp/phase10-checkpoint-build-final.log`                 |
| `pnpm test:e2e`                                               | 5 PASS /0 FAIL /0 SKIP                                      | 0    | 2026-10-06T04:55:44.233239+00:00 → 2026-10-06T04:55:46.537012+00:00 | `/tmp/phase10-checkpoint-api-e2e.log`                     |
| `pnpm test:e2e:web`                                           | gallery10 + download10 + Memories1 =21 PASS /0 FAIL /0 SKIP | 0    | 2026-10-06T04:55:46.557519+00:00 → 2026-10-06T04:58:10.404929+00:00 | `/tmp/phase10-checkpoint-web-e2e.log`                     |
| `pnpm exec tsc --noEmit -p tsconfig.vitest.json`              | FAIL：201 baseline diagnostics；新增/移除消息=0/0           | 2    | 2026-10-06T04:58:53.221672+00:00 → 2026-10-06T04:59:03.244247+00:00 | `/tmp/phase10-checkpoint-root-tsc-last.log`               |
| `只读 DEV readiness/SHA/cleanup probe`                        | PASS；无 DDL                                                | 0    | 2026-10-06T10:04:32.572Z → 2026-10-06T10:04:32.664Z                 | `/tmp/phase10-checkpoint-readiness-cleanup-completed.log` |

`pnpm test`包含完整unit+integration的首轮runtime结果：3 FAIL/1681 PASS/0 SKIP，3个失败均为上述旧schema static断言。它仍是FAIL记录；修正后完整unit1210通过，最终独立`test:integration`474通过。没有声称首轮root命令退出0。API/Web共26项E2E不计入Vitest1684。构建不包含mobile Webexport，不是Android构建证据。

额外roottsc与独立审查既有201诊断的(file/code/message) multiset比较：added0、removed0；`/tmp/phase10-checkpoint-tsc-comparison.json`。仍exit2，正式package typecheck exit0分列。这是当前同依赖/声明基线对照，不是重新干净安装。

### 历史失败/取消，原样保留

- checkpoint core-sandbox：EPERM，13PASS/12未执行(SKIP)、suiteFAIL；复测runtime25PASS。
- checkpoint core：20PASS/5FAIL，READY wait超时并连带placement/dedup/purge失败；当时构建与核心重叠。构建完成后的core-built25PASS和两次完整integration证据支持串行验收；不把执行排序推断当作独立证明的生产缺陷，也不隐藏该FAIL。
- checkpoint unit默认sandbox：19filesFAIL/108PASS；64FAIL/1074PASS/72SKIP，包含native identity/isolation拒绝和3个旧static断言。实际ps/proc_pidinfo拒绝后限定runtime运行native测试，最后unit全通过。
- checkpoint full-tests首轮runtime：上述3staticFAIL/1681PASS，随后修复与最终project门禁通过。
- checkpoint integration-final：用户明确暂停，SIGINT安全取消，exit-2，无最终PASS摘要，不作为验收通过。queued cleanup被阻止，暂停时没有继续整理报告。
- checkpoint resumed-readiness-sandbox：恢复后实际EPERM，exit1；限定runtime只读preflight及最终probe均exit0。
- roottsc201 baseline FAIL始终单列，无Phase10新diagnostic/message。

## Migration、cleanup与保存边界

0009此前已应用；此次及此前checkpoint均未apply/DDL。MySQL`9.7.2`、DB`family_album_dev`、non-root，exact schema/history readiness通过。Journal10条(0000–0009)，last createdAt=`1791215974522`。0000–0008 frozen bytes测试通过。

0009 SQL/journal SHA-256：`e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`。

只读schema/Phase10 probe 10:04:32 UTC：Phase10 synthetic family=0/user=0、p10 media roots=0；4000/4400/3443测试端口CLOSED。暂停auth fixture的首个UTC时间窗查询没有候选，但后来精确synthetic模板统计发现1 family/2 users；首个查询存在CST DATETIME时间窗假阴性，不能当作无残留证明。核实family14649/users28382、28383的同suffix精确模板、唯一membership及零albums/invitations/uploads/storage/media/purge/audit；DATETIME均为2026-10-06 13:00:21.902 CST，对应05:00:21.902 UTC，恰在暂停取消前约5秒。10:10:42 UTC按原auth-phase1b afterAll顺序、checked transaction内再核对精确身份/零内容后仅清理该family/两users及其session/member；最终精确模板family=0/user=0。没有媒体删除/DDL或非本批DB删除。证据：`/tmp/phase10-checkpoint-auth-residue-count.log`和`/tmp/phase10-checkpoint-cancelled-auth-cleanup.log`。这是已完成suite正常afterAll以外的暂停残留收尾，不能把取消套件说成正常完成。

仅以同uid、非symlink、精确p10-server格式、实际运行时间窗、目录为空为依据，用`rmdir`删除本批14个旧暂停批次空容器和1个恢复integration空容器；不递归删除，不读取媒体。最终保留9个其他历史p10空容器，media root仍0。历史Web harness `picturesystem-phase5-web-e2e-bZOL2q` birth04:14:18 UTC，早于本执行窗口，保留其media目录、未读内容。其存在不被伪装成“整个系统tmp无残留”；本批Web21项正常owned harness teardown已通过。

日志仍存于本机/tmp；源码指纹另持久保存在repo progress manifest，避免只依赖临时路径。原工作区所有已有改动、Web AGENTS/CLAUDE及旧日志保留。HEAD未变，无提交/推送/部署。

## 最终指纹与父针对性复核

Source candidate set SHA-256：`7b1df51fb8cc3ac8f65b544c2813749356f50c881c7a0cd422d567e12b547582`。完整51项path/SHA见`PHASE-10-SERVER-CHECKPOINT-FINGERPRINT.json`（排除动态handoff/summary/manifest自身避免循环；包括protected docs，定义在manifest）。变更文件、来源和migration SHA均可复核。

此前独立审查对未变business code的结论及rawHTTP12reject/validBearer control证据仍新鲜；原core test SHA和E1证据范围已被新测试版本替代。请父任务只针对新增真实HTTP fault helper/partial restart/observation顺序、3个精确static断言修复和最终门禁/cleanup事实作独立复核。实施者没有修改独立review结论或自行批准本checkpoint。

未执行/仍暂缓：Android客户端、真实设备兼容性（华为/荣耀型号/OS/GMS尚缺）、nativeHTTPS/TLS/media loader/持久队列/deep links、FCM专用表/API/provider/token、签名材料/APK/build/install/launch、Production部署/断电/SSD实测。没有新增HarmonyOS/厂商SDK。整个Phase10签名APK交付仍未完成，不关闭Phase10、不进入Phase11。

## 交接证据对齐更新（2026-10-06 10:28 UTC）

独立review已追加限定closure：checkpoint ACCEPTABLE、E1 CLOSED、E2仍非穷举、新blocker NONE。原51项manifest保留为append前快照；当前[handoff fingerprint](PHASE-10-SERVER-HANDOFF-FINGERPRINT.json)刷新独立报告项，sourceSetSha256为`12b696d7609c933b471843b7f9637339abe90731dc86e4adbcbf20e35e9cccd6`，其余50项字节未变。本轮默认沙箱native-http/phase10-migration补跑13PASS/0SKIP/exit0；没有新MySQL/HTTP fixture、未重复全gate。详见[最终交接段](PHASE-10-SERVER-IMPLEMENTATION-HANDOFF.md)。历史待复核描述已由独立closure更新，整个Phase10未完成。
