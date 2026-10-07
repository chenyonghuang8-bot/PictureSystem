# Phase 10 通用服务端独立安全审查

日期：2026-10-06 UTC。审查基线 HEAD：`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。

## 结论

**COMMON_SERVER_REVIEW: ACCEPTED_WITH_EXPLICIT_EVIDENCE_LIMITS**<br />
**P0: 0 / P1: 0 / BLOCKING_P2: 0**<br />
**MANDATORY_CODE_FIXES_IDENTIFIED: NONE**<br />
**PHASE_10_COMPLETE: NO**<br />
**PRODUCTION_READY: NOT_ESTABLISHED**

本次没有确认本候选中可利用的鉴权绕过、隐藏 dedup 身份泄露、重复 quota reservation、非原子目标 placement 或未知 COMMIT 盲重放缺陷。可以采用本批通用服务端实现，继续父任务的收尾验证；这不是整个 Phase 10 的最终安全批准或完成声明。测试覆盖的边界和未执行场景见后文，不能把它们扩写成已通过。

本轮按用户指定的 Astra 高风险独立审查委托执行；没有通过工具可独立核实的模型档位标识，不虚构该标识。没有重新设计架构、修改产品代码/测试/migration，唯一仓库写入为本报告。没有重开 Phase 8/9、执行迁移、提交/推送/部署、访问真实媒体或修改 home ACL。无自行批准、额度重置或购买操作。

## 范围与候选对应

读取根 AGENTS、ROADMAP Phase 10、完整 `PHASE-10-ANDROID-IMPLEMENTATION-GUARDRAILS.md`、`PHASE-10-SERVER-IMPLEMENTATION-HANDOFF.md`，检查实际 tracked diff 与新增 native helper tests、upload completion、0009/schema/readiness/migration script、integration tests。检查面集中在 HTTP credential dispatch、session/actor 传递、锁后权限与时间检查、operation/staging、result/placement、native invitation。

HEAD 与委托一致。开始时 34 个 tracked 修改，1046+/147-；加新增文件共核对 46 个候选/保护文件。实施者 `/tmp/phase10-resume-source-manifest.json` 的 42 个条目全部 SHA-256 匹配。独立复跑结束、写报告前，46 个文件均无漂移。`apps/web/AGENTS.md`、`CLAUDE.md` 及无关 next-env/Memories E2E 改动保持原样。完整起始清单在 `/tmp/phase10-independent-start-fingerprint.json`。

## 已核实的安全边界

### 1. Credential transport 和锁后 session

- `apps/api/src/auth/http.ts:78`：中央选择 WEB Cookie 或 ANDROID Bearer。Bearer 大小写、单空格、43 字符 canonical token 检查；检查原始 Authorization 重复头；任何 Cookie 或 Origin 共存均拒绝；无 malformed fallback 或 query token 入口。
- `auth/http.ts:109`、`:128`：native anonymous JSON 与 authenticated JSON mutation 分开；原 Web exact HTTPS Origin 和 JSON guard 仍适用。`uploads/routes.ts:482` 只对成功解析的 ANDROID transport 选择 native TUS policy，其后仍认证 session；PATCH 维持 offset/octet-stream、版本、大小及偏移限制。
- `auth/routes.ts:69` 起的专用 native issuance/rotation/password/logout 不发 Cookie。共享 routes 的 credential.expectedClientType 进入 AuthService；所有 album/search/memories、Phase1C、upload、derived、original/preview download、share management、Trash actor adapter 均传递该值。未发现遗留硬编码 WEB 导致 native 请求跳过锁后校验的路径。匿名 public-share 实现没有改为 bearer 私有访问入口。
- `packages/db/src/auth-repository.ts:395`、`:466`、`:550`，以及 album `:2603`、Phase1C `:621`、upload `:1204` 附近的 actor 检查使用期望 transport，保留 token hash、revoked/disabled/left、absolute/idle/recent-auth 条件。revokeByToken 也有 exact type；reauth 保留原 expiresAt，password replacement 保留 transport 并撤销既有 Web/Android sessions。未改 Argon2、opaque token、Cookie 属性、CORS 或日志白名单。

证据：独立 core 实测 Web/Android token transport confusion、锁等待后 type 变化、rotation expiry 不延长、旧 token 无效、logout-all 跨 transport、password replacement/revoke；另以实际 Node HTTP parser 补核重复头和混用，见执行记录。

### 2. Operation identity、quota、staging 和 unknown COMMIT

- `packages/db/src/upload-repository.ts:447`、`:1346`：family/actor 锁内，以 family+owner member+operation 查询已有 receipt；严格匹配不可变 versioned fingerprint，先于 quota 计数/插入。fingerprint 包含声明大小、normalized filename/MIME 与原始 sorted unique target IDs，不依赖后来替换的 targets，也不含随机 proposed receipt ID。
- 新 receipt 与 1–20 个 target 同一 transaction 写入；目标权限复用 canView 与 canUpload OR canEdit，album/grant 按确定顺序处理。生产 capacity 分支复用已有 gate/session barrier；没有增加另一套 storage writer。
- `apps/api/src/uploads/protocol.ts:47` 更新 Tus 原 Upload 对象的 id/offset，实际 response Location 指向原 receipt；`uploads/service.ts:164`、`:259` 附近 reused 分支不 create/truncate staging，不把无用的新随机 ID 用于失败写入。
- `upload-repository.ts:579` owner operation lookup 在 family/actor 锁之后做 current locking read，重新校验当前 actor；公开 DTO 不输出 fingerprint/storage/canonical 身份。缺失 staging 的已有 receipt 不被“恢复”为新 payload。
- `uploads/service.ts:1017` 与既有 checked/capacity transaction 的 unknown outcome/connection discard 语义保持。代码中没有 unknown COMMIT 后自动补偿、重建 staging 或重放 placement。内部 bounded deadlock retry 与 COMMIT unknown 区分。

证据：实际并发 HTTP create 返回同一 Location、receipt 计数 1；修改 targets 后旧 immutable create snapshot 可恢复、变更 snapshot 409；staging 不截断。commit 已完成但 acknowledgement 抛错通过 repository seam 注入；fresh lookup 与缺 staging 的 HEAD/create retry 503 已实测。此 fault seam 的层次不能描述成 TCP 层丢失 create response。

### 3. Result 和全目标 placement

- `packages/db/src/upload-completion.ts:77`、`:86`：请求以 receipt publicId 定位 family，再锁 family/current actor/owner receipt；admin 没有 receipt owner bypass。
- `:155`–`:232`：核对 COMPLETE receipt 的 offset/size/hash 与 AVAILABLE key-version-1 original、canonical source COMPLETE binding、active/nonpurging media、current generation/metadata/recipe 1、IMAGE READY，以及 PREVIEW/THUMBNAIL 的有效状态、大小、尺寸、producer 字段。
- `:236` 起的观察事务遵循批准的 family/actor/receipt/storage/media/derived/target/current album/grant/placement 读取；不创建 canonical 或 placement，返回前重新取 server time。公开 mediaId/albumId 还要求当前 visible target 的 live placement。历史 APPLIED、隐藏 source 的 READY 或先前授权均不足以披露身份。
- `apps/api/src/uploads/service.ts:291` 在 SQL placement transaction 前取得 K lifecycle shared guard。`upload-completion.ts:341` 起重新核对 K/owner/COMPLETE、目标集合、每个目标当前 ACL 和 READY；全组 pending inserts 与 APPLIED 更新在同一 checked transaction。任一目标拒绝不会留下部分 placement。
- `upload-completion.ts:304` 的 target replacement 在任何 APPLIED 后冻结；`:380` 明确跳过 APPLIED，不恢复用户移除的关系。result 发现移除/撤权后抑制身份；Trash/purge 状态不能重新激活。0009 没有 media child FK，实际 purge 退役路径通过。

未发现把隐藏 source ID、其 metadata、以前相册或 uploader 放入 result 的路径。READY 仅作为“本次上传字节的处理状态”公开，符合批准合同；不是隐藏媒体的授权凭证。

### 4. Native invitation 与 migration

`apps/api/src/phase1c/routes.ts:173`、`:196` 的 native adapter 复用原服务及 rate/capacity/creator/role/expiry/consume transaction。仍要求新 username/password，创建账号和 membership；没有 existing-account join、自动登录或自动 session issuance。重复 consume 只有一次成功。

0009 仅 additive operation 字段、paired CHECK、owner-scope unique、receipt identity unique 与 upload_album_targets/RESTRICT same-family FKs/APPLIED timestamp CHECK。**没有 FCM/device 空表**，符合后续收窄范围。0000–0008 bytes 与基线逐一一致。独立 core 的 DEV setup 对当前数据库执行 exact schema/history readiness 成功；0009 SHA 为 `e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`。未运行 migration script/apply/DDL。

## 独立执行及证据真实性

| 检查                                             | 实际结果与范围                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| native-http / phase10-migration / phase10-server | 3 files、25 PASS、0 skip，8.53s；含 12 项真实 DEV integration               |
| 原始 HTTP parser 补核                            | 12 个 negative cases 均 401 且 service 未被 dispatch；canonical control 200 |
| extra root test-source TypeScript baseline 对照  | 当前 201、HEAD 基线 201；仍 FAIL，没有新增错误消息或 Phase10 文件诊断       |
| `git diff --check`                               | PASS                                                                        |

Core 命令：`pnpm exec vitest run apps/api/src/auth/native-http.test.ts packages/db/src/phase10-migration.test.ts tests/integration/phase10-server.test.ts --reporter=verbose`。首次默认沙箱 DEV MySQL EPERM，13 PASS/12 未执行，suite FAIL；只在实际 EPERM 后请求限定 runtime 权限，再串行重跑有效 25 PASS。有效日志 `/tmp/phase10-independent-core-elevated.log`，初次失败 `/tmp/phase10-independent-core.log`。没有同时启动另一套 DEV pipeline。

HTTP probe 在 `/tmp/phase10-independent-raw-http.mts`，通过真实 loopback Fastify/Node parser 发送 raw headers：duplicate valid-first/valid-last/identical、空/无关 Cookie、空/正常 Origin、comma、非 canonical base64url、lowercase bearer、双空格、query-only。使用 synthetic token 和 stub AuthService，故只证明 HTTP→credential guard，不替代真实 DB auth。首次 listen EPERM 后窄 runtime 重跑；日志 `/tmp/phase10-independent-raw-http-elevated.log`。未输出 token。

实际 pipeline 源码核对：`tests/integration/phase10-server.test.ts:191` 起仅 seed synthetic family/users/membership，album 通过 HTTP 创建；`:374` 起实际 TUS PATCH/finalize，随后 SIGKILL/restart API，再启动真实 metadata worker，等待既有 API-owner processing 到 READY；`:438` 起 placement/gallery/derived/original/preview binary 实际可用，original bytes/inode 不变。没有手插 media/jobs/READY 冒充公开链路。后续 DB 改动用于制造 deleted album、移除 placement、stale generation 等负向条件，不是制造 pipeline 成功。

未知 create/placement COMMIT 测试调用真实 repository/DB，但用 Proxy 在真实 commit 后抛错；placement seam 外确实持有 K L-S。相应“fault injection”限定于此层，不能宣称测试了真实数据库断网。

实现者 123 integration、375 unit、Web Memories 1、typecheck/lint/format/build 记录已读；本次没有重新累计为独立通过数量，也没有运行 full gate。Android HTTPS native client 链路未运行。Phase10 core 使用本机 HTTP loopback；此前 Web Memories 的 HTTPS 验收不能替代 native HTTPS/TLS 验收。

## 证据缺口和非阻塞观察

**E1：partial-offset restart 与实际 response loss 没有在本批新增测试中合并成一条实证。**

位置：`tests/integration/phase10-server.test.ts:329`、`:374`–`:435`。create/PATCH 实际读取成功 response 后再重试/HEAD；kill 发生在 finalize COMPLETE 后。证明了幂等、可信 offset、COMPLETE 后恢复和真实派生链，但没有证明“0 < committedOffset < declaredSize 时杀进程，重启后继续剩余 PATCH”，也没有真实断开响应连接。既有回归包含 service-level 多 chunk resume 和 FINALIZING crash recovery，不能改名为这条 ANDROID HTTP 组合路径。

分类：非阻塞证据边界，未确认实现缺陷；不能把 handoff 的宽泛“resume/restart/lost response”解释为所有组合已覆盖。若父任务需要对此作正式组合验收，应加一条 owned synthetic 双 chunk：首段持久化、在部分 offset kill/restart、重新 authenticate/operation/HEAD、发剩余段、finalize/READY/placement，并校验原字节及单 receipt；真正丢响应另在受控 transport 中断点执行。无需新架构。

**E2：锁后 actor 覆盖是代表性实测加源码追踪，不是所有新操作的穷举矩阵。**

位置：`tests/integration/phase10-server.test.ts:658`、`:859`。新 integration 明确覆盖 result 等 family lock 时 session type 变化、rotation/revoke；没有逐一对 result/targets/placement/operation 穷举 disable/left/idle/absolute 到期及每种 grant 撤销竞态。源码的共享 actor predicate、fresh lock-time 检查和既有受影响回归支持本次采用结论，未发现漏校验；不得宣称这整个排列已测。后续客户端验收若需要这些细分结论，针对相应断点补测即可，不要求无边界扩展全排列。

**Extra tsc 的 FAIL 保留。** 用相同依赖/配置的只读虚拟 HEAD 对照（tracked 内容取 git show、屏蔽新增 TS/TSX），两侧均 201 条、无新增错误消息。上传服务既有 Timeout TS2322 从基线 `:992` 移到候选 `:1119`；不是新错误。新增 phase10/native-http/upload-completion 文件无诊断。脚本 `/tmp/phase10-independent-tsc.cjs`、明细 `/tmp/phase10-independent-tsc.json`。这是共享当前依赖/生成声明的源对照，不是两次干净安装；正式 package typecheck 与该额外失败应继续分列。

## 必须修复列表与阶段阻塞

本次确认的通用服务端代码 blocker：**无**。无需因本报告发起安全架构重设计。E1/E2 要求限制证据表述，不能作为尚未运行场景的 PASS。

Phase10 全阶段阻塞保持：家人华为/荣耀具体型号、OS/APK 兼容性与 GMS 条件未确认；Firebase/provider 未配置；Android 客户端、持久队列/私有媒体 loader/deep links、FCM 专用表/API、Android build/install/launch、用户签名材料与 signed APK、release TLS 验收未完成。它们不计入本批服务器漏洞，也不能被服务器审查或 Web build 洗成完成。后续 FCM 需要独立版本 migration，不能改写已应用 0009。

父任务按当前授权范围保存服务端交付状态；完整阶段仍须补齐平台门槛、客户端实施/审查和最终 gate。不要进入 Phase 11 或宣布 Phase10 COMPLETE。

## 证据摘要

- core 有效日志 SHA-256：`c37b64c5f17bd4938af6f5d481fe25f689077a0a57979aa066533ebfcb0b63d3`
- raw HTTP 有效日志 SHA-256：`4a8929513830a5591a408a9e883cf75af495c6c7a7be8b000d46bb8457911212`
- root tsc 对照明细 SHA-256：`817d8a8a1c0bb1445ebb529a5c745bd4fe2dd01a7bb8912d45a83fad3f152bff`

本机 `/tmp` 证据不是长期存储；报告保存结论、命令和边界。最终候选清单应将本报告纳入。没有删除任何既有文件或测试失败日志。

## 限定新增测试证据 closure（2026-10-06）

**COMMON_SERVER_CHECKPOINT: ACCEPTABLE**<br />
**E1_SERVER_EVIDENCE: CLOSED**<br />
**E2_COVERAGE_LIMIT: RETAINED_NON_EXHAUSTIVE**<br />
**NEW_CODE_BLOCKERS_IDENTIFIED: NONE**<br />
**PHASE_10_COMPLETE: NO**

本轮依用户 10:16 UTC 明确授权，重新尝试上次模型启动失败后未执行的限定 closure。上次 `400 model not enabled` 不是执行通过证据；本轮实际执行并取得结果。按照本轮 Sol6.1 High/普通速度要求，只核对测试证据与其直接依赖，不重新作全架构/安全设计，也不修改产品代码、测试或迁移。原未变业务的 Astra 独立审查结论继续适用。

### 指纹与实际变更

读取原审查、最新 checkpoint summary/handoff、51 项 fingerprint，逐文件计算 SHA。HEAD 仍为 `6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。开始和写 closure 前全部 51 项匹配。对照本审查保存的 `/tmp/phase10-independent-start-fingerprint.json`：旧候选中仅 handoff 和 `tests/integration/phase10-server.test.ts` 改变；所有业务、contracts、schema、migration、guardrails 和受保护 Web 文件保持相同字节。新增的三个历史 schema static test 修改也经实际 diff 检查，没有业务变更。

`7b1df51fb8cc3ac8f65b544c2813749356f50c881c7a0cd422d567e12b547582` 已独立重算，是 manifest 定义的 **sourceSetSha256**（sorted path/sha256 array canonical JSON）；不是 manifest 文件自身 bytes 的哈希。manifest 文件自身 SHA-256 为 `a27fbb9a8269dc0b4080431dc06cb59ea82178b243c648280407427a79992193`。0009 SQL SHA 仍为 `e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`。

本次 append 会改变 manifest 内所列独立报告的哈希，原 manifest 应作为 **append 前 checkpoint 快照** 保留，若父任务生成新的最终清单需刷新报告项和 source set；本轮不改 manifest。

### E1 的实证闭合

`tests/integration/phase10-server.test.ts:168` 的 loseResponse helper 使用真实 loopback HTTP proxy：pipe 完整 incoming request，等待 upstream response end、取得成功 status witness，在不发 downstream headers/body 的情况下销毁 socket；客户端 fetch 必须 rejected，上游失败不能当成功。每次 finally 清除 timeout、关闭自有连接/server。没有用 mock rejection、忽略成功 response 或手动 lifecycle dispatch 冒充网络丢响应。

新增组合核实如下：

- create 成功201的客户端响应真正丢失后，先 current owner operation GET 找到原 identity，再做 concurrent idempotent create；实际 Location 与 observation 一致，receipt count=1。后续 immutable create snapshot/目标修改/mismatch 仍有原断言。
- JPEG 首段是 `floor(bytes.length/2)`，严格 `0 < split < declaredSize`。首段 PATCH204 响应丢失后 HEAD 观察 split；SIGKILL API 后重启，`auth/me`、operation 和 HEAD 证明当前认证、同一 receipt 和同一 partial offset。重试 create 不截断 staging；再发送尾段且丢其成功响应，HEAD 返回 declaredSize，旧 offset PATCH409。
- finalize200 响应丢失后先 GET result 观察 COMPLETE；再重启并经已有 owner/metadata/derivative runtime 到 READY。没有手插 media/job/READY。
- placement200 响应丢失后先 GET result 观察当前 APPLIED/ACL 身份，而非盲重放 placement；gallery、derived、original/preview binary 可用，最终字节与 synthetic JPEG 相等，placement 前后 original inode 不变。原全目标否决、hidden dedup、APPLIED 移除、未知 COMMIT seam 与 purge 负向回归保留。

因此原 E1 所缺的 **真实客户端 response loss + partial-offset process restart + authoritative observation/resume** 已在同一服务端路径形成实证。该 proxy 实证是客户端 TCP 响应丢失，不是 DB COMMIT ack 丢失；既有 repository commit 后抛错 seam 仍只证明另一类 DB outcome。Node fetch 驱动并未证明 Android 的 SQLite queue/SecureStore/native TLS/OS death 行为，不扩大关闭范围。

### 三个 static test 修正与直接复跑

- `phase3-schema.test.ts` 增加当前已批准的两个 upload index 名称与 paired CHECK，保留原边界断言。
- `phase4-migration.test.ts:178` 附近用当前八个明确 index 名称代替旧 count=6，历史 migration/snapshot 断言仍在。
- `phase7-migration.test.ts:193` 附近只为 uploadSessions 剔除 0009 已批准的两个字段、两个 index、一个 CHECK，再比较冻结 0007 topology。其他列 type/nullability、index/FK/CHECK 比较保留；0009 由独立 migration/readiness 负责。不是把全部历史 schema 差异跳过。

独立命令和结果：

| 限定命令                                                                                                                                                          | 结果                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm exec vitest run packages/db/src/phase3-schema.test.ts packages/db/src/phase4-migration.test.ts packages/db/src/phase7-migration.test.ts --reporter=verbose` | 3 files /14 PASS /0 skip，exit0        |
| `pnpm exec vitest run tests/integration/phase10-server.test.ts --reporter=verbose`                                                                                | 1 file /12 PASS /0 skip，10.39s，exit0 |
| `git diff --check`                                                                                                                                                | PASS                                   |

HTTP integration 是顺序相依的一份小型 suite，复跑这12项以保留其真实 setup/pipeline/cleanup，没有重复全套1210/474/API/Web门禁。第一次默认沙箱因 MySQL EPERM 导致12项未执行、suite FAIL，实际失败后才申请限定 runtime；有效重跑结果如上。默认失败日志 `/tmp/phase10-evidence-closure-http.log`、有效日志 `/tmp/phase10-evidence-closure-http-elevated.log`；static 日志 `/tmp/phase10-evidence-closure-static.log`。

### 最终日志新鲜度与 cleanup 表述

已核日志内 COMMAND、UTC_START/UTC_END、EXIT_CODE 和 test 摘要：unit1210、integration474、API5、Web10+10+1=21均为最后有效 PASS；正式 lint/format/package typecheck/server-Web build exit0。最新 integration 源码 mtime 为04:58:31 UTC，最终 integration 在10:01:26–10:03:34 UTC执行，并逐个列出新增 response-loss/partial-restart 标题和成功状态；三个 static tests 在04:52:32–33 UTC修改，完整 unit04:55执行。lint/format/typecheck04:58:53后执行。业务未变，所以较早 build/Web/API 证据可按 checkpoint 说明复用；未把被取消 integration、旧 native sandbox skip 或旧 static FAIL 改成 PASS。

cleanup 记录已交叉核实：10:04只读 readiness/SHA probe 记录 Phase10 synthetic family/user=0、p10 media roots=0、测试端口关闭，同时明确仍有一个历史 Web harness/media root。空容器记录为10:04:23删除14个、10:05:02再删除1个，均非递归，保留9个其他容器。脚本检查同uid、非symlink、精确名称和时间窗，实际使用 rmdir。暂停 auth 另在10:08精确模板 probe 发现1 family/2 users，10:10:42 cleanup记录删除该已确认 owned fixture后归零；summary正确纠正首次UTC时间窗的CST假阴性，没有把取消 suite 说成正常 teardown。本轮核实的是现存日志/脚本和新增 suite 的正常 afterAll，不声称亲自重新执行历史删除，也没有清理历史媒体目录。

完整 gate 的1210+474与26项E2E不重复累加成独立本轮测试数量。额外 root tsc 的 exit2、201 baseline diagnostics及 message新增/移除0/0继续列为 **FAIL**；本轮未重跑，也未用 package typecheck PASS覆盖它。

### 剩余边界

E2 仍保留代表性 actor/race 覆盖、非全排列这一事实，本次没有将其关闭为 exhaustive coverage。没有发现新增测试削弱原安全断言或暴露新的产品 blocker。服务端 checkpoint 可以接受，原业务安全结论沿用。

Android客户端、华为/荣耀具体型号/OS/APK/GMS、持久队列和私有媒体 loader/nativeHTTPS/deep links、FCM专用表/API/provider/token、用户签名材料、signed APK/build/install/launch及release TLS/真实设备仍未完成。没有 migration apply、commit/push/deploy、Production/真实媒体/home ACL操作；整个Phase10仍不能关闭，不能进入Phase11。
