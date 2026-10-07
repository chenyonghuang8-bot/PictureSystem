# Phase 10 最终候选总结

日期：2026-10-06 UTC。此文件记录实施与 DEV 验收候选，**不是 Phase 完成或 Production ready 声明**。

```text
HEAD: 6510261f920b5ebe6d98d1cefa3227fb221bbd5f
PHASE_10_COMPLETE: NO
DEV_IMPLEMENTATION_AND_ACCEPTANCE_CANDIDATE: YES
FINAL_INDEPENDENT_REVIEW: ACCEPT_DEV_CANDIDATE
FAMILY_DEVICE_ACCEPTANCE: PENDING
FORMAL_RELEASE_SIGNING: NOT_PERFORMED
PRODUCTION_READY: NO
```

## 范围与授权

共同服务端交接见 [服务端实施报告](PHASE-10-SERVER-IMPLEMENTATION-HANDOFF.md)，其 [独立审查](PHASE-10-SERVER-INDEPENDENT-REVIEW.md) 已接受。后续用户授权 Android APK、HarmonyOS 6.1 手机 H5 的实际链路验收和适用完整 gate；没有实现 HarmonyOS 原生或厂商 SDK。通知、FCM、device registration 不在本批范围。

实际执行配置为 workspace-write / auto_review；未修改审批设置、代点批准或声称创建接口设置了审批模式。模型运行时不能独立查询，记为 unknown；沿用用户指定 Sol 6.1 Medium 普通速度。普通文件修改和单测未提权，真实 DEV MySQL、loopback、SDK/模拟器等仅在实际权限阻塞后申请相应本地 runtime。用户另外明确批准专用 DEV TLS CA 与用户 SSL trust；未改变 home ACL 或系统级信任。

原待续工作及无关 `apps/web/AGENTS.md`、`CLAUDE.md` 保留。无 Git 提交、推送、部署、tag、下一 Phase、额度重置或购买。只使用合成 DEV 媒体和已授权 tmp/storage 路径，无真实家庭媒体或 Production 操作。

## 本轮实际修复

原客户端独立审查 C1–C4 已全部 CLOSED，见 [closure 追加](PHASE-10-CLIENT-INDEPENDENT-REVIEW.md)。之后真实运行暴露并修复以下问题；这些新增差异已由 [最终独立审查](PHASE-10-FINAL-REVIEW.md) 接受：

- `session.ts`：重复 initial active 事件曾取消尚未完成的 SecureStore restore；相同生命周期状态不重复失效，真实 inactive→active 在无内存凭据时走既有 restore / `/me` 验证。持久 deny marker、顺序存储和旧 epoch 拒绝仍保留；没有改变服务端会话合同。
- `queue.ts`：系统 picker 活动会暂停认证作用域，复制前有界等待既有当前身份验证，账号/家庭变化拒绝。Android provider 的 descriptor 不保证 seek，改用有界 content InputStream 范围读，每块至多 1 MiB；私有 file 使用现有 FileHandle。Hermes 没有浏览器 atob，采用严格、有界 base64 解码并增加独立二进制向量。错误日志只含固定 event/category，不含原始错误或 URI。
- `patches/expo-file-system@57.0.7.patch`：仅将 legacy READ 分支的 SAF URI 条件扩为 `content` scheme，以支持真实 Android picker provider；保留权限预检查和 OS grant，WRITE 分支不改。版本固定，pnpm patch/lock 登记；该模块显式 buildFromSource，避免预编译 AAR 忽略补丁。未安装另一套 SDK 或全局 Java。
- 共享上传状态：COMPLETE + retryable UNAVAILABLE + PENDING placement 继续观察既有 reconciliation；不推断 READY、不新建 writer、不重放未知 COMMIT、不因 APPLIED 历史重新 placement。
- `index.tsx`：恢复后当前账号/家庭已验证时刷新持久队列视图；任务可访问名称包含该任务及状态，确保断点恢复断言不会被旧 DONE 任务满足。
- Metro 增加现有 Expo SQLite Web export 所需 wasm asset 类型。严格 Web 测试入口对浏览器及 health probe 均启用证书/hostname 校验，提供已有 TLS 时仅绑定 loopback IPv4。
- SDK Instrumentation 与 H5 测试覆盖实际链路。H5 首轮 locator/fixture 失败后仅修正测试作用域和每案例 fixture，保留错误内容拒绝、IndexedDB 故障不 create、旧分页结果不能回填等断言。

## 实际验收

Android 使用已有 Pixel_8_Pro AVD / emulator-5554、API 37.1 arm64，通过 SDK Instrumentation / UiAutomation 操作安装后的真实 RN app、系统 picker、真实 API 和处理管线。不是 mock UI 或仅 Expo Web export。

1. 严格 OkHttp HTTPS，登录后实际照片/相册/回忆/我的四页；系统 provider 选择 9,437,555 bytes 合成图，私有有界复制、TUS 上传、真实管线 READY/APPLIED，receipt `667772` COMPLETE，私有授权 viewer 可见。
2. receipt `667773` 在真实 UPLOADING offset **4,194,304 / 33,554,803** 时由只读观察器确认后 force-stop。重新启动先查询权威状态，观察继续至 8,388,608，最终 COMPLETE 33,554,803；精确新任务名称 READY/APPLIED + viewer 断言通过。计划中断的 instrumentation exit 1 是预期中断，不记作 PASS；后续恢复阶段 exit 0。
3. 真实 UI logout、冷启动显示登录页、严格匿名 `/me` 401。匿名 401 本身不等同于“重用已撤销 token”的证明；服务端撤销合同沿用已审查实现与回归。
4. 真实服务端发行/preview invitation，冷/热 Android VIEW，同一当前邀请保留服务端家庭 preview；消费创建新 MEMBER 账号并要求正常登录，没有自动登录。

H5 在严格 TLS 下实际 Cookie 登录、create 响应丢失、reload 保持 UUID、IndexedDB 仅元数据、同内容重选和真实上传 READY/APPLIED、照片/我的、logout / me401。错误内容重选无 PATCH，IndexedDB 不可用无 create。三种 held API page 场景均拒绝旧名称：auth-lost、hide/restore、account mismatch。生命周期/bfcache 事件由浏览器测试明确派发，API、账户切换和被延迟的响应是真实服务；不冒称华为设备物理生命周期实测。

## 适用 gate 与日志

日志完整标题、命令、UTC、退出码及 SHA-256 保存于 [证据 manifest](phase10-client-artifacts/evidence.json)，25 份原日志已复制到 `phase10-client-artifacts/logs/`，保留原 `/tmp` 来源路径。下面短名对应 `phase10-checkpoint-<短名>.log`。

| 检查                                                          | 最新结果                                                                     | 日志短名                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Format / lint / package typecheck                             | 全部 PASS，exit 0                                                            | phase10-final-format-complete / phase10-final-lint-complete / phase10-final-types-complete |
| Unit                                                          | 131 files / 1258 PASS，0 FAIL，0 SKIP                                        | phase10-full-unit-latest                                                                   |
| DEV MySQL integration / race / native storage / fault / crash | 37 files / 474 PASS，0 FAIL，0 SKIP；串行运行时无竞争中的另一个 API pipeline | phase10-full-integration-serial                                                            |
| pnpm build                                                    | PASS，含 packages/API/worker/Next 与 Expo Web export                         | phase10-web-wasm-build                                                                     |
| API E2E                                                       | 5 PASS，0 FAIL，0 SKIP                                                       | phase10-final-api-e2e                                                                      |
| Web 原有三 suite                                              | gallery 10 + download 10 + memories 1 = 21 PASS；严格 TLS                    | phase10-all-strict-web-e2e                                                                 |
| Web Phase10 完整受影响 suite 重跑                             | 6 PASS，0 FAIL，0 SKIP；严格 TLS                                             | phase10-strict-client-precise-ui                                                           |
| Android assembleDebug + processReleaseResources               | PASS，实际 native Kotlin / resources                                         | phase10-final-android-resource-audit                                                       |
| debug APK signature verification                              | PASS；任务 JDK17 的 apksigner                                                | phase10-final-apk-signature                                                                |
| 只读 DEV readiness / owned cleanup                            | PASS，无 DDL                                                                 | phase10-final-readiness-cleanup                                                            |

Web 是完整 suite 覆盖的 **21 + 6 = 27 PASS 组合证据**，不是单次 root driver exit 0：首次总入口 exit 1，Phase10 当时 1 PASS / 5 FAIL（locator 与 fixture），原有三 suite 全通过；修正受影响测试后全部六项重跑通过，没有不必要地重复原三 suite。

历史失败明确保留：并发运行中的 Native DEV pipeline 影响首次 integration（469 PASS / 5 FAIL，exit 1）；停止竞争服务后相同 37 files 完整重跑 474 PASS，没有降低断言或修改服务端。首次 root build 缺 wasm asset 导致 exit 1，Metro 修复后 root build exit 0。最早 MySQL EPERM 的 skipped 结果不算通过。旧裸 root tsc 基线错误不混入本次正式 package typecheck，也未声称其已修复。早期 TLS/provider/startup 失败保留于历史交接和本地日志，不改写为 PASS。

## APK、TLS 与证据新鲜度

DEV-only APK：`.cache/phase10-client/family-album-dev-arm64.apk`，85,204,644 bytes。

```text
SHA-256: c346d17c3ea0e336f9d3139480d5bfbf43057f93a7a340c37f7cc38559126eb5
```

最终 resource audit 生成 APK 与实际安装并验收的 APK 整包 SHA 完全一致，逐项 uncompressed ZIP entry 无差异。debug 签名已验证；没有生成正式签名密钥或 release APK。Release 实际链接 `.ap_` 中没有 DEV CA，network security 只信任 system、cleartext false、没有 domain-config，见 [资源观察](phase10-client-artifacts/release-resource-observation.json)。

已批准专用 CA/私钥留在仓库外受控 DEV TLS 目录；用户 login keychain 仅 SSL trust，不是系统级 CA。Android 仅 debug exact `10.0.2.2` 使用 public DEV CA。Chrome/Node 严格证书路径未使用 ignoreHTTPS、禁用 hostname 或 cleartext。Node 仅按进程配置 NODE_EXTRA_CA_CERTS。模拟器原代理导致 OkHttp handshake 失败，测试期间暂清代理，结束已恢复原 `10.0.2.2:7890`；没有修改宿主机代理。

最终 manifest 覆盖 49 源码/配置文件、25 日志、12 截图、观察记录与 APK，并逐项重新计算匹配。旧轮指纹保存在 `evidence-pre-review.json` 和 `evidence-review-closure.json`，不能用旧 APK 安装证据冒充新候选。partial observer 的实际源码快照也已保存，不包含 protected runtime 凭据。

## Migration 与 cleanup

0009 已在 `family_album_dev` 应用，本批 **未重复应用**。SHA-256：`e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`；0000–0008 未修改，最新只读 readiness/current history 验证通过，没有客户端 DDL。

只清理当前 harness 证明归属的 synthetic family、上传 targets/receipts、邀请和新增邀请用户；最终 Native/H5 owned rows 均 0。own loopback 4000/4400/3443 无监听。删除本批两份 emulator Download fixture 和 instrumentation test APK，保留已登出的 debug app 与原 AVD；本批启动的 emulator 已停止，原代理恢复。没有擦除其他测试根目录。受控 runtime 调试文件、本机 APK/SDK 和合成截图留作复现；不宣称系统 tmp 全空。用户批准的 DEV CA trust 保留，撤销说明仍在仓库外 DEV TLS README。

## 独立终审与剩余门槛

最终独立审查已核对 manifest 指纹并接受本轮新差异，C1–C4 保持 CLOSED，新 P0/P1/阻塞 P2 为 0；独立 targeted 回归 4 files / 48 PASS / 0 FAIL / 0 SKIP。审查范围包括：生命周期 restore / deny-marker 交错；picker scope 等待、content reader 的 grant 与有界读、base64 长度/错误日志；expo-file-system READ-only patch 与源码构建；retryable UNAVAILABLE 状态观察不产生第二 writer/placement；真实 partial 恢复的特定任务断言；严格 TLS runner 与 actual Release 资源隔离。完整结论见独立报告，本实施线程未独立审查自身。

家庭华为/荣耀具体型号与 OS、实际安装/升级/触控/后台恢复/系统 picker 和 HarmonyOS 6.1 浏览器 IndexedDB/生命周期仍需设备验收；Android Keystore 故障、真正掉电/SSD 断连不能由受控单测和模拟器证明。正式签名材料与 release 安装未完成。原视频上传、原生地图/扩展搜索、生产部署验证、rate limiting、persistent audit 等既有范围外/延期项目不借本批宣称完成。未独立审查自身、未进入下一阶段。

## DOC_ONLY 收尾与最小真机准备

最终独立报告唯一非阻塞 D1/P3 为 starter-pack README 未写明本期 Push 延期。现已只改 `project-spec/README.md` 的当前范围：Android APK + HarmonyOS 6.1 H5；通知、FCM/device registration 延期，Push 保留未来路线。README 原历史路线及其他 starter-pack 内容保留。D1 文案已落实，不改写独立报告的历史 finding。

本次 DOC_ONLY 仅更新 README、本总结、客户端交接及 evidence 的文档指纹/审查状态。独立审查输入 manifest 原样保留为 `phase10-client-artifacts/evidence-final-reviewed.json`；49 项源码/配置、25 日志、APK、截图及观察记录重新核对全部不变。没有产品/测试/migration 修改，没有重跑 gate、生成正式密钥、签名、LAN/公网配置或部署。仅对改动文档执行格式检查与 diff check。

正式签名和家人真机的最小准备如下，均是只读清单，尚未授权执行：

1. **确认目标设备。** 提供型号、系统版本以及使用 Android APK 或 HarmonyOS 6.1 H5 的分配；Android 需确认可安装 APK 与 arm64 兼容，H5 需确认实际浏览器和桌面快捷方式。然后才安排真实 picker、上传中断/恢复、四页、私有 viewer、邀请和退出验收。
2. **确定手机能访问的 HTTPS 地址。** `apps/mobile/lib/session.ts:14` 从构建时 `EXPO_PUBLIC_API_ORIGIN` 读取 exact origin，仅接受 HTTPS、无 path/凭据；`.env.example` 与缺省值是 `https://10.0.2.2:3443`，只适用于 Android 模拟器回连宿主。现验收 HTTPS proxy 为 `127.0.0.1:3443`、API 为 `127.0.0.1:4400`，未建立家人手机可访问部署。需要用户选择访问方式/主机名、实际可达服务入口、主机名匹配且手机系统信任的 TLS 链，以及 H5 页面与 API 代理/Origin allowlist 的部署配置。当前仅 DEV CA 不会被 release 信任，不能用明文或把 DEV CA 加进 release 解决。此清单不要求公网，未修改 LAN、路由器、域名或系统服务。
3. **release 地址与签名尚未配置。** Expo 将 `EXPO_PUBLIC_*` 写入客户端 JS bundle，正式地址需在构建时明确并重新打包，参见 [Expo 官方环境变量说明](https://docs.expo.dev/guides/environment-variables/)。当前 plugin/generated Gradle 的正式任务 gate 拒绝缺地址及 `10.0.2.2`/localhost/127.0.0.1；session 还做 exact HTTPS 检查。release buildType 没有用户 signingConfig，不能把 debug APK当正式交付。现 package 为 `local.familyalbum.app`，debug 后缀 `.dev`；正式包名、版本、用户管理签名配置及升级验证还需确认。
4. **用户在本机生成 keystore 的可选入口。** 已只读确认 `<installed Android Studio.app>` 安装，Info.plist 版本 2026.1；未操作其 UI。用户批准后，可在 Studio 打开 `apps/mobile/android`，走 **Build → Generate Signed Bundle/APK → APK → Next → Key store path 下 Create new**。选择仓库外的 `.jks` 保存位置，自行填写 keystore 密码、key alias/密码、有效期至少 25 年和证书身份信息；点 OK 创建。如只准备 keystore，可取消后续打包向导，先不签名/构建。此为 [Android 官方签名向导](https://developer.android.com/studio/publish/app-signing#generate-key)，不是已经创建的证明。密码和 keystore 不发送给 agent；用户自行保管并备份同一签名材料，以便后续升级。

目前尚未获得正式密钥创建授权；以上步骤未执行。DEV 候选 ACCEPT 不解除家庭设备、正式 release 和既有 Production 门槛，Phase 10 仍未完成。
