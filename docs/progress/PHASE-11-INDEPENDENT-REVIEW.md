> 后续关闭状态（2026-10-12）：本报告保留2026-10-07原始发现与失败事实。R1 的当前权威结论为 [Astra Low 定向复审 CLOSED](PHASE-11-R1-TARGETED-CLOSURE-REVIEW-2026-10-12.md)，限定范围内新增 P0/P1=0；G1/G2 已由完整 unit 与 root lint PASS 闭环，Phase11 DEV 最终验收见 [最终总结](PHASE-11-FINAL-SUMMARY.md)。以下 CHANGES_REQUIRED 为历史审查结论，不是当前未关闭状态；不扩大为其它阶段问题重审或 Production 就绪。

# Phase 11 集中独立安全与正确性复核

2026-10-07。结论：**CHANGES REQUIRED；当前 DEV milestone 不接受，不批准以“Phase11已验收”为前提提交/推送或进入 Phase12。** 新确认 P0=0、P1=1；另有两项真实 gate 失败未关闭。允许继续合成 DEV 修复。没有把物理断电、Production、SSD 断连当作已验证。

本轮是当前实施的独立源码复核；本线程此前参与过 guardrails 的 child bridge 设计，因此不是对该设计来源完全独立的第三方评估。本轮没有修改产品实现或产品测试、连接 DEV DB、变更真实账号/模式、读取真实媒体/凭据/私钥、运行完整 gate、提交或推送。仅写本报告及 `/tmp` 的有界合成复现/日志；复现临时 control namespace 已精确删除。

## 1. 候选与证据冻结

- HEAD `209b8d36e4a9337ee6c9975878f6031e52a62ace`。
- 审查 `PHASE-11-IMPLEMENTATION-HANDOFF.md` 第181行后的最终节、CURRENT-FINGERPRINT、guardrails，及 ROADMAP 第238行的完整十项范围。
- CURRENT-FINGERPRINT SHA-256：`1f641bdb24d5d1feddd0dbf5f1ed7092d41e78cf57455180f9c89dafedb23162`。
- 对其顶层数组中的 **722 项**文件/日志/构建证据逐项核对 SHA-256，全部匹配：含127项候选文件、568项日志、10项旧 migration、13项 supporting evidence、4项 built artifacts。没有读取 fingerprint 单列的敏感失败日志内容。
- 原0000–0009 migration哈希与候选记录匹配；0010指纹保留。实际应用/readiness只引用实施证据，本轮不重跑迁移或DB查询。
- 395 audit/77 runtime、原327 audit/70 runtime身份保留来自已核对哈希的 retention proof；本轮未执行清理，未重新独立查询DB计数。

## 2. Findings

### R1 — P1 / 阻塞：marker与DB锁存同时失败后，新进程可恢复NORMAL准入

**位置：**

- `packages/storage/native/operation_gate.h:225`–233：FILE_FSYNC失败后，按精确身份删除尚未发布的 `deny.<nonce>`。
- `packages/storage/src/control-coordinator.ts:84`–97：native marker失败后尝试DB latch；DB也失败时仅剩当前进程内的 `#protection`/local deny。第94行“marker或无效namespace仍保留”的注释在此组合下不成立。
- `apps/worker/src/deployment-control.ts:155`–164：启动只在发现marker时回填DB锁存；DB仍为NORMAL/STABLE且marker不存在就设置startupWritable。
- `packages/storage/src/control-admission.ts:109`–120：新实例没有旧local deny，接受NORMAL且无marker的快照。

**触发与影响：**控制行原为NORMAL；健康故障触发trip，文件同步EIO，temporary被成功清理，同时DB连接故障令latch无法提交。旧进程仍拒写，但持久控制目录只剩identity及两把锁。若旧进程在补写保护前退出/崩溃，DB恢复后新进程可按原NORMAL重新准入，不要求授权RECHECK。甚至独立的新admission进程在旧进程仍local-denied时，也没有跨进程保护依据。违反“故障锁存保护重启、不得自动恢复NORMAL”的既有合同。持续性硬件故障可能被fresh probe再次发现，但一次性故障和未决结局不能靠此保证。

**独立实证：**`/tmp/phase11-independent-marker-review.mts`（SHA-256 `4feb4385cf49811d834b8f39cfdd85dbd12fa8247a22ce8fc4cfc8a46139550f`）和 `/tmp/phase11-independent-marker-review.log`。使用真实native test addon的单次FILE_FSYNC EIO、实际ControlCoordinator/DeploymentAdmission、全新子进程。仅DB接口模拟latch不可用及随后仍为NORMAL的持久快照；没有连接真实DB，也没有实际媒体写入。结果：

```json
{"tripRejected":true,"localDenied":true,"controlFiles":["identity","latch.lock","operation.lock"]}
{"freshProcess":true,"marker":null,"admittedSyntheticCallback":true}
```

复现命令：

```sh
node --import ./node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/loader.mjs /tmp/phase11-independent-marker-review.mts
```

原 `pnpm exec tsx` 尝试因sandbox IPC监听EPERM退出，改用Node loader成功；没有权限升级或网络配置修改。该复现证明真实native保护记录消失及新进程准入缺口；不冒称完整打包API/真实DB联合故障已跑。

**最小修复边界：**只处理“保护无法持久化＋启动准入”的链路。marker创建失败时不能假设已留下durable deny；必须使后续进程不能仅凭旧NORMAL＋marker缺失恢复写入。需要明确覆盖未正常收口的进程身份/启动恢复证明，或等价的可验证持久保护协议；若改变既有持久/启动不变量，先做针对性的R3设计修订。仅保留临时文件不充分：当前S准入不扫描bridge未知条目；仅进程内deny/日志/重试也不充分。不要将本报告当作已批准某种新schema/锁方案。

**必要回归：**真实DB不可达＋FILE_FSYNC失败→旧进程退出→DB恢复→实际打包API重启，HTTP媒体写入仍503；授权fresh RECHECK保持READ_ONLY，显式NORMAL后才可写。再覆盖原始temporary创建失败、保护写入失败与DB latch结果未知，验证没有盲重放、原owner互斥不变。现有 `phase11-marker-durability.test.ts:108` 明确先确认DB已faultLatched，故四个marker测试不能覆盖此双失败；database-outage测试又以成功持久marker为前提。

### G1 — P2 / 验收阻塞：完整unit仍有真实外部底图FAIL

**位置：**`apps/web/components/gallery/location-browser.test.ts:255`，失败断言`:287`。命令 `pnpm exec vitest run --config vitest.config.ts apps/web/components/gallery/location-browser.test.ts`；完整入口为 `pnpm test`。

完整结果保持145 files、1357 PASS / 1 FAIL / 0 SKIP；独立文件历史重跑7 PASS / 1 FAIL。浏览器日志为 `net::ERR_CONNECTION_CLOSED`，公开端点curl历史返回35/SSL_ERROR_SYSCALL。本轮有界 `curl --head --connect-timeout 8 --max-time 12 --silent --show-error https://tiles.openfreemap.org/styles/liberty` 返回6/DNS无法解析；本轮受限网络不能用来断言外部服务全局故障或已恢复。

**baseline实证：**location-browser、location-map、map-provider当前字节均与HEAD一致；最近相关测试提交为`979d6eb`（Phase8）。prepare-map-worker及lockfile无diff。vendor文件是生成产物、不在HEAD，不能说“vendor与HEAD相同”；本轮逐字节核对worker/shared与已安装锁定MapLibre6.11.2包分发文件相同。

**判断：**强证据支持当前外部连接问题，无证据将本次失败归因于Phase11修改；但本轮没有独立成功渲染底图，也没有在可达网络完成全部请求/CSP/初始化链核验，所以不作“排除了所有应用问题”的绝对结论。失败影响是真实底图不可用，降级地区列表与超时/retry历史测试通过不等于底图PASS。

**最小闭环：**在原有允许的网络条件恢复后，保持provider/断言/TLS不变重跑该文件；若用户选择接受已知外部依赖失败，应单独记录验收例外，fullGate仍不得写PASS。本轮未豁免、换provider、mock、skip或调整网络。

### G2 — P3 / 非产品缺陷，但root gate仍阻塞：保留旧未跟踪观察脚本lint失败

**位置：**`docs/progress/phase10-branding-artifacts/visible/web-visible-check.mjs:13`，`console no-undef`。

`pnpm lint`实际失败1；本轮独立 `pnpm exec eslint docs/progress/phase10-branding-artifacts/visible/web-visible-check.mjs --max-warnings=0` 同样失败1。`git ls-files --error-unmatch`确认不在HEAD；原阶段交接已列明其为保留残留，不属于本批运行产品。当前SHA-256 `76626c5834b8f11f25019cdc96ce1a35beeca76d9dc0c37cdc537060c38279c6`。由于文件未跟踪，不能伪称有HEAD字节基线；“早已存在”依据前轮交接/本线程之前快照。

**最小闭环：**若允许维护该保留文件，可仅为它显式导入Node console或加准确文件级Node环境声明，保留原观察行为，再跑root lint。当前有保留原样约束，需父任务明确是否解除这一文件的编辑限制；不得删除文件、加全局ignore或拿候选lint代替root PASS。与R1修复独立。

## 3. 源码复核结论与十项覆盖

| 原Phase11范围     | 实际代码与判断                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| member management | 原Phase1C授权矩阵继续生效；Admin复用原成员/邀请路由，grant不是SA自动附赠；成功审计与mutation同一checked transaction                                |
| storage usage     | 系统资源需独立grant；家庭统计以可见集合为前提；不输出其他家庭拆分或原路径                                                                          |
| media counts      | `admin-read-repository.ts:18`复用gallery ACL后distinct；READY/derived generation准入；源上传者按canonical source分组，无private SA bypass          |
| worker status     | 持久boot、fresh revision/heartbeat、configured roles；陈旧显示UNKNOWN；恢复除readiness外还需native DRAINED_X/owner/inventory，未以心跳代替死亡证明 |
| backups           | NOT_CONFIGURED/null，未虚构备份成功；符合批准的Phase13延期边界                                                                                     |
| integrity status  | NOT_CONFIGURED/null，health probe不冒充全库扫描；物理故障验证仍未完成                                                                              |
| trash             | UI复用既有Trash；HTTP写入口受S包围，purge scheduler/processor/recovery入口已接控制；不另造writer                                                   |
| audit             | 新通用审计与原媒体审计分源；媒体查询当前placement可见性过滤；system与family scope分开，分页白名单，无token/raw payload返回                         |
| maintenance mode  | 固定路由类别限制增权/邀请及媒体写入；鉴权与安全撤销命名例外；命令提交后DRAINING、X排空、再APPLIED，不把202当完成                                   |
| read-only mode    | 媒体/关系/cleanup/job等写路径统一暂停，登录/读取/既有成员管理规则保留；R1使重启故障保护不能接受                                                    |

补充核对：

- `apps/api/src/admin/admission.ts:60`按注册route template包原handler；新mutation默认MEDIA_WRITE，无不可信URL前缀豁免。pipeline/metadata/derivative/purge从claim到settle均持S，fenced recovery单列，不在X内重新拿S。
- `operation_gate.h:108`附近native RAW_X核验bridge后才返回；`operation_bridge.h:71`额外检查coordinator/supervisor/receiver确切incarnation，SETTLED不直接绕过supervisor。consumer没有gate FD；metadata/renderer/verifier使用原受控launch；未知root/record保持关闭。
- 同步marker清除要求native X+latch和精确token；DB已知commit后才clear。R1是额外组合故障，不否认已测的单故障保护。未知COMMIT不重放业务mutation，后续latch是独立收紧操作。
- `StorageRuntimeOwner`/`VersionedOwner`等待读写callback并关闭旧资源后开新代，旧能力不可继续借用。`scripts/tsup-workspace-internals.ts`让内部TS模块保持外部单例，避免打包复制WeakMap；实际built API恢复证据有指纹，不以源码单测替代。
- 双API测试是一个writer＋第二个command-only HTTP入口，真实finalize在途→限制commit→新写503→旧单元完成→APPLIED；证明边界准确，不宣称双writer并行。
- Admin UI的identity复核、activation epoch、pagehide/visibility清空、BFCache pageshow重核、401/403清除和pending只观察均有源码；严格HTTPS 3PASS包含1440/390和实际Chrome history。没有把本轮功能/安全检查当视觉还原验收。

## 4. 验证清单与边界

实施者最终日志经指纹核对：integration **42 files/512 PASS/0 FAIL/0 SKIP**；Admin strict HTTPS **3 PASS**；API E2E **5 PASS**；build/format/workspace typecheck与候选lint PASS。完整unit及root lint仍如G1/G2失败。

本轮独立复跑：

```sh
pnpm exec vitest run --config vitest.config.ts packages/storage/src/control-coordinator.test.ts packages/storage/src/versioned-owner.test.ts packages/db/src/system-control-inventory.test.ts apps/web/lib/admin-client.test.ts
```

**4 files / 39 PASS / 0 FAIL / 0 SKIP，exit0**。另有R1真实native＋子进程合成复现、G2精确lint复现、只读baseline/hash检查。没有重新运行全量或真实DB/race，也没有修改共享DEV模式或历史。

证据缺口：R1的真实DB/打包API双失败回归尚缺；所有media断连/余量故障与resume组合未穷尽，物理掉电/SSD与Production未验证；本轮未复跑截图或家人设备验收。它们不能由现有512PASS外推全部通过。

## 5. 后续收口

先针对R1完成必要R3设计修订、最小实现及指定回归，再集中复核blocker；G1/G2按上述最小范围恢复验证或取得明确记录的验收决策，保留历史失败。修复后更新最终指纹和对应验证，满足完整阶段门槛才由父任务决定提交/推送/Phase12。**本报告不批准当前候选通过DEV milestone，也未执行后续阶段。**
