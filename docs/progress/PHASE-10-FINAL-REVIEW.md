# Phase 10 final DEV candidate independent review

2026-10-06。结论：**ACCEPT DEV CANDIDATE**。限定终审未发现新增 P0/P1/阻塞 P2，C1–C4 保持 CLOSED。正式签名与家人设备验收仍待完成，**PHASE_10_COMPLETE: NO / PRODUCTION_READY: NO**。

本轮按用户指定 Sol 6.1 High、普通速度执行。运行时模型无法独立查询，记为 unknown。范围是已接受服务端、已关闭客户端问题之后的新增实现与可信 DEV 验收证据；没有重新设计安全模型或发现需要另起 Astra 设计审查的具体变化。只写本报告；未修改产品、测试、migration、系统信任或代理，未重跑全量 gates、启动模拟器、提交、推送或部署。

## 候选指纹与源码范围

- HEAD：`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`，工作树未提交。
- 输入：`PHASE-10-FINAL-SUMMARY.md`、客户端两份 handoff、`PHASE-10-CLIENT-INDEPENDENT-REVIEW.md` closure、实际 tracked diff / 新文件，以及 `phase10-client-artifacts/evidence.json`。服务端沿用既有独立接受结论。
- 当前 evidence SHA-256：`21b4a0dcce3852ba1bba0ff8b0950929206f3b2bec230fd4b677ef430608ff35`；创建时间 `2026-10-06T13:52:06.478567+00:00`。
- 独立重算 **49/49 源码配置、25/25 日志、12/12 截图、4/4 观察记录、3/3 交付文档匹配**。25 份日志包含历史失败，匹配不等于全为 PASS。
- APK：`.cache/phase10-client/family-album-dev-arm64.apk`，85,204,644 bytes，独立 SHA-256 匹配 `c346d17c3ea0e336f9d3139480d5bfbf43057f93a7a340c37f7cc38559126eb5`。
- 对既有服务端 handoff 的 51 项指纹只作漂移检查，唯一变化是已批准范围更新的 `project-spec/ROADMAP.md`，服务端产品源码/migration 没有新漂移。checkpoint 另有独立报告追加后的预期文档变化，不作为服务端重开理由。

新增产品逻辑的最后修改包括 queue（12:52）、原生 package/source-build 配置（12:59）、session 生命周期（13:11）、原生队列视图（13:18），均先于相关最终 unit / native 恢复验收。Metro wasm 配置最后修改 13:30:08，随后 root build 于 13:30:30 PASS。H5 受影响用例最后修改 13:44:13，随后完整六项 suite 重跑 PASS。最后的 native harness 格式化/保护性 DEV guard 更新在 13:45 左右，之后 format/lint/typecheck 全通过；它们不是一次新 native 安装验收。不能说所有 49 项文件都在每一个 gate 前具有相同修改时间，但未发现验证后又改变产品逻辑而继续沿用旧结果的情况。

## 新增实现核对

| 区域                                          | 独立核对结论                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/lib/session.ts:243` lifecycle    | 重复相同 active 状态不再取消 initial restore；真实 inactive→active 仍失效旧请求，再走 restore 或 `/me`。restore 继续受 deny marker、orderedStorage 和 epoch 约束。没有删除 C1 的失败关闭边界。                                                 |
| `apps/mobile/lib/queue.ts` picker scope       | picker 返回后最多等待 10 秒，只接受原 user/family scope 且当前认证激活；新 scope 和失败验证拒绝。任务始终记原 scope，上传请求另有 epoch/scope fence，没有把旧任务借给新账号。                                                                  |
| content reader / base64                       | 每次范围读取最多 1 MiB，JS 校验编码长度/解码大小；无需 Hermes atob。固定分类日志不输出 raw exception、URI 或内容。installed legacy reader 的 skipBytes 与 readByteRange 循环支持非 seekable InputStream，并在原生分配受请求 length 约束。      |
| `patches/expo-file-system@57.0.7.patch`       | 单行 READ 输入分支扩大到 content scheme；`ensurePermission(...READ)` 和 ContentResolver/OS grant 保留，WRITE 分支保持 SAF 限制。pnpm patchedDependencies、lock 与 mobile buildFromSource 对应；本次不是绕过文件权限或新的 storage writer。     |
| `packages/contracts/src/client-upload.ts:212` | retryable UNAVAILABLE 且尚未 APPLIED 时继续 PROCESSING 观察。FAILED、非 retryable、已 APPLIED 而当前 identity 不可用、NEEDS_ALBUM_ACTION 均要求处理。没有猜测 READY、创建第二 receipt/writer、重放未知 COMMIT，或重新 placement 历史 APPLIED。 |
| `apps/mobile/app/index.tsx`                   | 当前 me/family 恢复后刷新所属队列；指定任务的无障碍标签包含名称和阶段。恢复断言能精确找本次大文件 DONE，不能被其他旧 DONE 任务满足。私有视图仍在 epoch 清理。                                                                                  |
| H5 后续分页                                   | 原 C4 helper 和 validated/suspend 边界保持；新真实 HTTP 用例覆盖旧分页跨 logout、隐藏恢复和账户不匹配。账户变化不自动打开旧私有选择器。                                                                                                        |

本轮独立 targeted 复跑：

```text
pnpm exec vitest run --config vitest.config.ts \
  apps/mobile/lib/session.test.ts apps/mobile/lib/queue.test.ts \
  packages/contracts/src/client-upload.test.ts apps/web/lib/private-album-page.test.ts
4 files / 48 PASS / 0 FAIL / 0 skip
```

包含 C1 凭据失败/迟写、重复 initial active、picker 原 scope 恢复/新账号拒绝、磁盘与 crash cleanup、目标错误保留、content 范围/base64 黄金向量及 UNAVAILABLE/APPLIED 行为。不是把 mock 当成 Android Keystore、provider 或真实掉电证明。

## 严格 TLS 与真实验收证据

独立使用已有 SDK `aapt2 dump xmltree` 读取实际 debug APK 与实际 release `.ap_`，没有构建或改资源：

- debug 含 public `res/raw/dev_ca.pem`；network security 的 base-config 仅 system、cleartext false；唯一 DEV domain-config 为 `10.0.2.2`，includeSubdomains false、cleartext false。
- release `.ap_` SHA-256 独立匹配 `b0f8b24a8a4a1d602a9aceeffcc8e352d016d5934ca11f314353f679087a455a`；ZIP 无 dev_ca，network security 只有 system/cleartext false，没有 domain-config。
- `playwright.phase10-client.config.ts` 强制 browser 和 health probe `ignoreHTTPSErrors:false`，缺既有 cert/key 时停止。当前提供 cert/key 的 runner 路径不生成新 key；native transport/probe 没有替换 hostname verifier 或 trust-all 实现。用户已批准的 DEV trust 不再是待授权项，本轮未再次改系统设置。
- debug apksigner 日志实际 Verifies/v2 true，证书为模板 Android Debug；它不是正式签名或 release APK。manifest/观察记录注明实际验收包与最后 audit 包相同；本轮核实了现存交付包指纹及资源，不在已关闭模拟器上重新安装或重演过去运行。

真实链路的证据由测试源码、命令日志、公开状态观察和截图共同支持，不单靠 manifest 中的布尔值：

1. Native 使用 SDK Instrumentation/UiAutomation 对安装的 RN app 和系统 DocumentsUI 操作，没有替代 app 方法。fixture setup 只建合成用户/家庭/相册和测试角色；这些 E2E 路径没有调用 fixture.media，也没有手工补 upload receipt、media/job 或 READY。上传、邀请发行/preview/消费经过真实公开 HTTP API 和处理管线。
2. receipt `667772` 的 9,437,555-byte 图经实际 picker、上传到完成；四页实际 UI 和后续授权 viewer 有日志/截图。
3. receipt `667773` 的 33,554,803-byte 图，在只读 DB 观察到 UPLOADING `4,194,304` 后 force-stop。观察器只 SELECT 并调用 force-stop，不写 receipt/offset。13:15:14 的原始状态记录与 observer 日志匹配。随后观察记录记 offset 8,388,608，最终 COMPLETE；13:19:41–13:21:05 的恢复 UI 阶段明确断言 `上传任务 <本次文件名>：已加入相册`，再打开授权 viewer。viewer 操作是“查看”列表项，没有额外断言其一定是 receipt 667773 对应图片；因此本报告接受“指定任务完成 + viewer 可用”，不扩写成“该指定图片的像素已逐项验收”。
4. 真实 logout、冷启动登录页、匿名严格 `/me`401，以及真实邀请 cold/warm VIEW、MEMBER 新账号消费且没有自动登录均有相应成功日志。匿名 401 不是携旧 token 重用后被拒绝的证明；不覆盖服务端既有撤销回归。
5. 严格 H5 测试通过实际 Cookie 登录、真实 create 成功后的响应丢失、reload 保持 UUID、同内容重选到 COMPLETE/READY/APPLIED、照片/我的、logout204 和 me401。不同内容不 PATCH、IndexedDB 故障不 create、真实被延迟的相册 API 响应和真实账户切换的断言保留。浏览器 visibility/pageshow 事件是明确模拟的，未声称物理 Huawei 生命周期或真 BFCache 导航实测。

Native 是 Pixel_8_Pro AVD/API37.1 arm64；H5 是桌面 Chromium 的 390×844 viewport。两者均不是家人的 vivo Y35 / HarmonyOS4.2 / HarmonyOS6.1 真机验收。

## Gate 结论与失败记录

| 检查                                     | 可接受的最新证据                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| format/lint/package typecheck            | 13:46 最后完整命令均 exit 0                                                                                 |
| Unit                                     | 131 files / 1258 PASS，0 FAIL、0 skip                                                                       |
| DEV integration/race/storage/fault/crash | 37 files / 474 PASS，0 FAIL、0 skip，13:31 串行完整重跑                                                     |
| root build                               | Metro 修复后 13:30 exit 0，含 Expo Web export；此前 exit 1 保留                                             |
| API E2E                                  | 5 PASS、0 skip                                                                                              |
| strict Web 原三套                        | 10 + 10 + 1 = 21 PASS                                                                                       |
| strict H5 本期套件                       | 修改受影响 locator/fixture 后六项全部重跑 6 PASS、0 skip                                                    |
| Android                                  | assembleDebug + processReleaseResources exit 0；debug 签名可验证；没有正式 release APK                      |
| extra root test-source tsc               | 原独立服务端报告的 **201 baseline diagnostics / FAIL** 保留；本轮未重跑，也不由 package typecheck PASS 覆盖 |

Web 是 **21+6 的组合覆盖**，不是 root driver 全绿。总入口 exit 1 / 本期 1 PASS+5 FAIL 明确保留；六项后续重跑保留真实请求、内容错误/IDB/旧页面隔离断言，只修正 UI 范围和必要 fixture。原 integration 469 PASS+5 FAIL 的日志仍在 manifest；串行环境完整重跑相同 474 后通过，服务端指纹没有漂移。Gradle 的 `...SKIPPED` 是任务状态（如不存在 Kotlin plugin 错误检查），不混同于 Vitest/Playwright test skip=0。

两条旧 native 失败仍在原 `/tmp` 日志，独立确认没有改写：13:08:49 `UI_NOT_FOUND` 与 13:09:32 `PARTIAL_TUS_NOT_OBSERVED`。前一轮没有成功到达上传，自然不能用后一条“未观察到 partial”说明断点恢复已测。生命周期恢复修复之后的新 retry 日志实际捕获 partial offset 并 kill，后续更严格的指定任务恢复断言通过。计划中的 live instrumentation 被 force-stop 后 exit 1 是预期中断，未计 PASS。旧的泛化 resume-viewer PASS 也未被本报告用于代替指定新任务的断言。

历史证书绕过试跑仍无效；本轮接受的是后续严格入口证据，不把旧 ERR_CERT_AUTHORITY_INVALID、TLS preflight 阻塞或绕过后的失败追溯标成 PASS。

## Cleanup 与文档说明

只读 readiness 日志命令的实际脚本验证 family_album_dev/非 root、现行 migration readiness，并按两份 owned fixture ID 检查家庭/upload/targets 等残留为 0，无 DDL。harness cleanup 限定本次 family/用户/targets/invitations，并关闭自己持有的子进程与自己创建的 storage runRoot；没有扩大到其他家庭或整个 tmp。0009 SHA 匹配既有 `e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`，本轮无 migration 操作。

清理记录说明 instrumentation APK 和两份 Download fixture 从 emulator 移除，debug app 登出后保留，task-started emulator 停止、原代理恢复。`.cache/phase10-native-tests/test.apk` 仍在主机作构建材料，不矛盾于“emulator uninstall”，也不声明主机 tmp/cache 全空。本轮未启动服务来重新查询或改变这些状态；端口/代理和 emulator 清理接受现有记录，数据库 readiness 接受已执行只读日志与其实际 SELECT 范围，不扩张成所有系统资源零残留。

**D1 — P3，非阻塞文档差异。** `project-spec/ROADMAP.md:214` 已明确本期排除通知/FCM/device registration；当前仓库没有 root README，`project-spec/README.md:29` 的旧总体说明仍写“App Push 通知”，未明确本期延期。因此“README/ROADMAP 均已明确延期”的描述与实际文件不完全一致。触发是读 starter-pack README 判断当前交付范围，影响为可能误认为本期必须交付 Push。最小后续修正是在该条追加“Phase 10 延期，以 ROADMAP 当前范围为准”；验证只需核对文案，不需新测试。本轮遵守只写审查报告约束，没有改文档，也没有把 FCM 重列门槛。

## 接受状态与最小后续动作

本批 **P0=0、P1=0、阻塞 P2=0、P3=1（D1 文档说明）**。DEV 实现候选可接受，原 C1–C4 不重开，没有发现需要暂停并扩为新高风险架构设计的区域。

下一步只需用户安排正式签名材料的安全本地路径/签名归属、确认具体设备型号与 OS，并安排 vivo Y35/目标 Android 或 HarmonyOS4.2 的安装/升级/相册与 picker/重启恢复，及 HarmonyOS6.1 的 H5 登录、IndexedDB 重开、上传和快捷方式实测。不要在聊天中发送密钥或密码。正式 release 构建/签名及设备结果接受后才能判断完整交付；无需重新申请已有 DEV CA trust，也无需为本次报告重复所有已通过 gates。

设备验收、正式 release、生产部署安全及真实掉电/SSD 断连仍不由本次模拟器和合成 DEV 证据证明。**不声明 Phase 10 全部完成，不进入 Phase 11。**
