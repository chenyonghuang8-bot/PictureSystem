# Phase 10 客户端实施交接

更新时间：2026-10-06 UTC。基线 HEAD：`6510261f920b5ebe6d98d1cefa3227fb221bbd5f`；工作树未提交，原服务端待续修改及无关 `apps/web/AGENTS.md`、`CLAUDE.md` 保留。

## 独立审查后更新

原 CHANGES REQUIRED 的 C1 P1 与 C2/C3/C4 blocking P2 已经独立复审全部 CLOSED，见 [独立报告的 closure 追加](PHASE-10-CLIENT-INDEPENDENT-REVIEW.md)。后续真实 Android / 严格 TLS H5 验收已执行，暴露的问题和修复、完整适用 gate、最终 APK 与 cleanup 见 [最终候选总结](PHASE-10-FINAL-SUMMARY.md)。[最终独立审查](PHASE-10-FINAL-REVIEW.md) 已 ACCEPT DEV CANDIDATE，新 P0/P1/阻塞 P2 为 0；家庭设备和正式签名未验收。下文保留原轮次结果，包括旧 APK、TLS 阻塞和未执行条目，均为历史状态，不代表当前候选。旧 evidence 分别保留为 `evidence-pre-review.json`、`evidence-review-closure.json`、`evidence-final-reviewed.json`；`phase10-client-artifacts/evidence.json` 是文档收尾后的最新指纹，源码/测试日志/APK 未变。

## 状态与授权边界

本批交付 Android 原生客户端和移动 H5 的实施及 DEV 验收候选；**实际模拟器链路与严格 TLS H5 测试通过，最终独立审查已接受 DEV 候选，Phase 10 未完成，未宣称 Production ready**。本期通知/FCM 排除，不以 Firebase 项目为阻塞。用户后续明确授权 Android APK + HarmonyOS 6.1 H5，覆盖早期“Android 暂缓”的实施范围；华为/荣耀具体设备实测、正式签名仍待用户材料和设备。

实际运行审批配置证据：`workspace-write`、`approvals_reviewer=auto_review`。未修改安全设置、未自行点击批准；模型/速度没有独立运行时查询证据，仅沿用用户指定 Sol 6.1 Medium 普通速度。文件编辑、单测未提权；Gradle/SDK、模拟器/ADB、Chrome、DEV 数据库实际 EPERM 后仅申请相应本地 runtime 访问。

无提交/push/deploy，无 Production/真实家庭媒体操作，无 home ACL、全局 CA、系统 Java/MySQL 配置修改，无额度卡/重置操作。未重新应用 0009：其既有服务端 SHA-256 为 `e749f32760f0f0bcd643e674fd62365c8ca716f8acf793314fbd3e465b910939`，readiness 使用前序已验收结果，客户端不修改 migration/schema/auth 安全模型。

## 实际代码

- `apps/mobile/app/index.tsx`：原生照片/相册/回忆/我的四导航，登录、家庭选择、相册分页、照片网格与预览/详情、文件名/日期/收藏查询、回忆截止时间和一次自动 bootstrap 预算、reauth/密码/全部登出、邀请新账号确认、上传队列和显式导出。照片选择当前支持图片，不交付视频上传或后台杀进程持续传输；搜索为基础筛选，原生地图/地点多维搜索未覆盖。
- `apps/mobile/lib/session.ts`：HTTPS exact origin、Bearer/SecureStore、Cookie omit、redirect error、请求/响应体超时和 epoch fence；账号/家庭/前后台切换中止旧请求、401 清理、凭据轮换单飞。登出 SecureStore 删除失败仍尝试服务端 revoke，错误不默默吞掉。
- `apps/mobile/lib/queue.ts`：SQLite WAL + 原子元数据写入、私有 `.partial`→`.source` 完整副本、SHA-256、50 未完成任务/2GiB 队列/256MiB 单图片、4MiB PATCH、一条前台 worker。重启先查询 owner operation/result、HEAD；未知结果先观察；同内容重选保持 UUID/fingerprint。当前不提供用户手动 pause 按钮，后台/账号失效自动暂停。
- `packages/contracts/src/client-upload.ts`：共享 receipt/result/offset 观察协议、目标 canonical 快照、显式 placement、READY + 当前 ACL identity 才显示完成，历史 APPLIED 不复活 placement。每次网络调用前检查 epoch，包括 response.json 期间换账号的情况。增量 SHA-256 使用独立黄金向量测试。
- `apps/mobile/lib/media.tsx`：授权 API 获取私有 thumbnail/preview，两并发、单响应限额与64MiB缓存上限；等待槽位前捕获 epoch，切换后不借用新账号凭据；登出/前后台清理。原图仅用户点击导出后下载到私有临时目录并调用分享、随后删除。
- `apps/mobile/lib/invitations.ts`：严格 canonical `familyalbum://invite?token=...` 解析，15分钟 SecureStore pending、串行处理及有限重复投递抑制；保留新账号创建语义，不自动兑换未知结果/不自动登录。
- `apps/mobile/plugins/with-private-android.cjs`：可复现 prebuild，`.dev` 独立包、禁明文、禁 backup/device-transfer、无 Metro 依赖；移除 broad storage/overlay/biometric 权限，最终合并 APK 仍有 INTERNET、VIBRATE 和本包非导出 receiver 权限。Release 不使用模板 debug 签名，并要求用户配置 HTTPS origin 和自管签名。
- `apps/web/components/mobile`、`lib/mobile-upload.ts`：移动相册目标选择、上传/进度/重试/重选/删除/目标替换；IndexedDB 仅存元数据，文件只在内存。内容 SHA-256 和 durable UUID 在第一次 create 前完成，reopen 必须同内容重选。visibility/bfcache 重新验证 auth/me、Cookie sameOrigin/noStore/redirect error，无浏览器 Bearer。四导航与安全区/触控样式，保留桌面导航；登录和我的页面新增账户操作。
- `playwright.phase10-client.config.ts`：新验收入口强制 `ignoreHTTPSErrors:false`，缺已有 DEV TLS 文件对时在 fixture/key 创建前停止；`start-web-https.mjs` 使用已有受保护本地路径，不复制/删除外部 TLS 材料。旧套件行为保留，不将旧忽略证书配置认作本批 TLS 验收。

## 最终验证证据

所有以下最终命令日志具有 UTC_START、完整 COMMAND、EXIT_CODE、UTC_END；本机 `/tmp` 日志易失，关键结果和日志哈希另存 `phase10-client-artifacts/evidence.json`。

| 检查                                                                          | 结果                                    | 日志 / UTC 完成时间                                                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| shared upload/SHA/invite + native session + gallery-client + memories-session | **4 files / 33 PASS / 0 FAIL / 0 SKIP** | `/tmp/phase10-checkpoint-client-final-tests.log`，11:12:31                                              |
| contracts/mobile/web 正式 package typecheck                                   | PASS，exit 0                            | `client-final-types`，11:12:56                                                                          |
| 客户端及受影响 harness targeted ESLint                                        | PASS，exit 0                            | `client-final-lint`，11:12:56                                                                           |
| targeted Prettier                                                             | PASS，exit 0                            | `client-final-format`，11:13:14                                                                         |
| Next Web production build                                                     | PASS，exit 0                            | `client-web-delivery`，11:12:17                                                                         |
| Android arm64 debug APK assemble                                              | PASS，exit 0，318 tasks，15s            | `client-native-delivery`，11:13:08                                                                      |
| APK signature verification / 最终 APK adb install / 独立启动                  | PASS；最终应用 PID 6515，登录 UI 可见   | Android Debug 签名；登录页截图                                                                          |
| 手机390×844、桌面1440×1000登录页 UI                                           | PASS，仅未认证页面渲染                  | H5/桌面截图；HTTP localhost，不是 HTTPS 验收                                                            |
| 首轮 H5真实 Cookie + 响应丢失试跑                                             | **FAIL**                                | `client-h5`；队列 details 折叠导致断言失败，afterAll FK清理失败；只到持久 UUID/重开需重选，未验证 READY |
| 严格 TLS H5试跑                                                               | **FAIL / BLOCKED**                      | `client-h5-strict-tls`；`ERR_CERT_AUTHORITY_INVALID`，未进入认证流程                                    |
| 修正后可信 TLS前置检查                                                        | **BLOCKED，exit 1，0验收执行**          | `client-h5-tls-preflight`；`PHASE10_EXISTING_TRUSTED_DEV_TLS_PAIR_REQUIRED`                             |
| 原生认证四页、上传断点/重启/READY的真实服务联调                               | **未执行**                              | 尚无配置可达可信 DEV HTTPS origin / public DEV CA                                                       |
| Android真实设备、HarmonyOS 6.1 H5/桌面快捷方式、签名 Release                  | **未执行**                              | 用户设备/正式签名/TLS环境门槛                                                                           |
| 独立审查 / Phase完整 Quality Gate                                             | **未执行**                              | 本任务不自行独立审查或宣布完成                                                                          |

早期 Native bundle 因 workspace NodeNext `.js` resolver 失败、JDK25 CMake native-call失败，均修复后构建通过；未把失败日志隐藏为通过。使用项目内官方 Adoptium JDK17，校验 SHA-256 `196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8`；没有系统安装 Java。[React Native 环境要求](https://reactnative.dev/docs/set-up-your-environment)。SDK/NDK官方依赖经已授权 Gradle runtime 下载。

## APK 与截图

最终 APK：`.cache/phase10-client/family-album-dev-arm64.apk`（忽略的本机交付文件，**仅调试测试**），85,164,580 bytes。

- SHA-256：`a1e0ce685d12ab39ac91ff2ffe3dd81220955fc4e3fd0513f7c7670b46b70ff9`
- 包：`local.familyalbum.app.dev`，version0.0.0/code1，arm64，minSDK24/targetSDK36。
- 模板 Android Debug 证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`；不是用户正式签名证书。未生成用户正式签名密钥。
- `phase10-client-artifacts/android-login.png` 是最终 APK 模拟器登录截图；`h5-login-mobile.png`、`web-login-desktop.png` 是未认证页面截图。没有用截图替代认证四页/媒体联调验收。

## Cleanup 和后续门槛

首轮失败的 owned synthetic family14896（无原图）按精确时间、随机命名和两测试用户核实后清理，upload_album_targets 先删再调用原 fixture cleanup；严格 TLS试跑 family14897 cleanup 完成。最终只读复核两者残留 **0**；3443/4400无测试监听。已关闭本任务启动的 localhost Next UI server 和 Android emulator；不 wipe 现有 AVD、不删除其他测试遗留根目录/外部 TLS材料。保留本机 APK、截图、源码和日志，未触碰真实照片。

必须坦诚记录：第一轮误用旧 harness，其 `ignoreHTTPSErrors:true` 且自动生成 ephemeral TLS测试 key，最终失败。后续改为严格入口，不再生成该材料或绕过证书校验；没有生成正式签名 key、安装全局 CA、禁用 hostname validation 或放开 cleartext。

继续验收所需：已有、在测试浏览器实际信任的 DEV TLS cert/key **本地文件路径**，供严格 H5 suite 使用；Native 则配置可达可信 `EXPO_PUBLIC_API_ORIGIN`，或仅 debug exact-domain 的既有 public DEV CA（`EXPO_DEV_CA_FILE`，拒绝 PRIVATE KEY）。不要在聊天中发送私钥/账号凭据，不创建公网入口。

独立审查清单：

1. 检查 Native Cookie/redirect/原点和响应体 lifetime、SecureStore写失败/删除失败/rotation unknown、401/冷启动与多家庭 epoch；验证旧队列/等待媒体请求不以新账号发出。
2. 真 DEV HTTPS 下测试 create/PATCH/finalize/placement response loss、process kill/reopen、同内容重选/内容不同拒绝、配额/磁盘不足、DONE清理、当前ACL变化/APPLIED不可复活。
3. 检查 SQLite atomicity 和部分拷贝 crash recovery、picker/private路径/backup rules、媒体并发/上限/timeout/export revoke。
4. 检查 invitation cold/warm/conflict/过期/重复投递/unknown consume、新账号语义和 token无日志/无导航泄漏。
5. 真设备复核触控、回忆server deadline/409一次bootstrap、相册/家庭切换、H5 IndexedDB不可用/页面恢复/同源Cookie与CSRF；补足暂未交付的视频上传和原生搜索维度时需另行确定范围。
6. 复核最终 merged release manifest、可信 TLS、用户签名/安装升级；独立确认后再做用户批准的最终验收，禁止自行打完成 tag 或进入下一 Phase。
