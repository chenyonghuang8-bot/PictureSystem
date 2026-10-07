# Phase 10 当前剩余工作与延期清单

2026-10-07 UTC。有界状态核对与计划；本轮不改产品、不重跑 gate、不做网络实验、不进入 Phase 11。后续直接由 Codex 规划执行，不使用网页 GPT / Bridge / Browser handoff。

HEAD 仍为 `6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。服务端、客户端和文档待续工作保留在未提交工作区，包括原有无关 `apps/web/AGENTS.md`、`CLAUDE.md`。本轮读 ROADMAP、最终总结/独立审查、branding 更新与相关源码；不将工作区未提交状态误判为功能缺失。branding 9 文件、两份构建日志及新 APK 指纹匹配；旧 accepted source manifest 的漂移仅为已记录的 branding 文件，没有发现额外源码漂移。

## A — 现在可做的真实剩余

**当前已批准功能范围内：未发现需要继续编写的功能遗漏。** 本地品牌验收已在本轮执行，Native 与 Web 关闭，只剩 Studio 卡片待安全观察。

| 工作                                        | 当前结果 | 证据 / 剩余                                                                                                                                             |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 APK 安装、启动、登录品牌与系统应用 label | PASS     | 原 Pixel_8_Pro DEV 模拟器；同一 APK 指纹；登录页与 Settings App info 截图/XML均为“嘟嘟家庭相册”。应用 label 来源为 App info，没有 launcher 首页截图     |
| Web 移动 / 桌面品牌                         | PASS     | 严格 HTTPS、HTTP 200、精确 title/h1；390×844 / 1440×1000 未认证截图，无明显截断；未启动 API/数据库                                                      |
| Studio 工程标题 / 最近卡片刷新              | BLOCKED  | 工程配置为新名，只读 recentProjects 缓存仍旧名；当前无法可靠确认/操作用户窗口，未改 live cache 或触发 trust/JDK migration，需安全 reopen/refresh 后截图 |

详见 [品牌验收补记](PHASE-10-BRANDING-UPDATE.md) 与 `phase10-branding-artifacts/visible/evidence.json`。保留原构建证据、历史失败与旧 accepted APK；截图仅含 DEV 未认证界面。已停止本任务 HTTPS 服务和模拟器，删除 emulator XML 临时副本，没有 DB/账号/媒体 fixture。只更新文档与证据，没有重建、复跑 gate 或安全审查。

## B — 已完成，不重做

- [最终独立审查](PHASE-10-FINAL-REVIEW.md)：ACCEPT DEV CANDIDATE；C1–C4 CLOSED，新 P0/P1/阻塞 P2 为 0，独立 targeted 48 PASS。唯一非阻塞 D1 文案已在 README 明确通知/FCM 本期延期。
- [最终候选总结](PHASE-10-FINAL-SUMMARY.md)：unit 1258、DEV integration/race/storage/fault/crash 474、API E2E 5；严格 Web 原三套 21 + 本期受影响六项 6 的组合完整覆盖。原 root driver / 早期失败和 skip 证据保持历史，不称单次 root 全绿。本轮没有重跑这些检查。
- 原生真实模拟器登录四页、系统 picker、真实 TUS/READY/APPLIED、指定 partial-offset kill/cold resume、私有 viewer、logout、邀请新账号语义均已有验收。H5 严格 TLS 的实际 Cookie、持久 UUID、重选、READY、IDB 不可用和旧分页失效场景已有证据。现有 `index.tsx` 的文件名/日期/收藏筛选、分页、retry/选目标等已实现；不为笼统“其他”重复编写 CRUD。
- [品牌更新](PHASE-10-BRANDING-UPDATE.md)：9 文件/10 行展示文案，新名“嘟嘟家庭相册”；受影响 typecheck、lint/format、Web build、离线 Android debug build、APK label/签名验证 PASS；技术标识不变。最新 debug APK 为 `.cache/phase10-branding/family-album-dev-arm64.apk`，SHA-256 `3e15988b972fb5d8f43df27b4d4d36e6e69ea9c9f27a73e4e5f2196a1e6694c9`。
- 0009 已应用并有 readiness，0000–0008 未改；不重复 migration。原 DEV fixture cleanup 记录保留。
- 已有项目本地 Temurin 17 修复与离线 Gradle 版本证据，不重新安装 JDK/SDK、清缓存或改变全局 IDE runtime。
- 用户已在本机创建正式 keystore；指定文件曾 stat 确認存在、2660 bytes，并经单文件授权收紧为 0600。没有读取内容/密码/alias，没有使用它签名；“未创建 keystore”的旧记录是历史状态。

## C — 必须等待的门槛

| 门槛                                   | 当前状态与依赖                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 家人可访问的可信 HTTPS 地址 / 外网路线 | 用户明确延期方案与费用决策。当前已有服务验收为 loopback/模拟器地址；家庭 WAN 为共享 IPv4，Mac 有 global IPv6但出站受 TUN/执行限制，手机 IPv6 检测 0/10 为用户报告，不据此证明所有 IPv6 永久不可用。停止网络实验、客服咨询、订公网包/中转、域名购买与端口开放。现不补假部署地址                                                             |
| 正式 release 配置与签名                | `session.ts` 使用构建时 exact HTTPS `EXPO_PUBLIC_API_ORIGIN`，生成 Gradle 正式 gate 排除缺省/loopback/10.0.2.2；release buildType 尚无用户 signingConfig。正式 origin 未定，不构造假的正式交付。用户本地秘密输入/签名操作、签名归属及安全备份确认仍需对应材料与授权；不得将密码/keystore 发给 agent。keystore 备份未核实，不擅自读取或复制 |
| 家人三设备交付验收                     | ROADMAP 已明确 vivo Y35 Android 13 / HarmonyOS 4.2 使用 Android APK；HarmonyOS 6.1 使用 H5 + 桌面快捷方式。实际安装/升级、浏览器存储、picker、触控/后台恢复等尚未完成，依赖相应设备及手机可达可信服务，不反复询问已确认型号或承诺模拟器替代真机                                                                                            |
| Production 门槛                        | 正式部署安全、真实掉电/SSD 断连及既有生产延期项目不由 DEV 验收覆盖；无 Production 操作授权，本轮不补做                                                                                                                                                                                                                                     |

通知/FCM/device registration 是明确本期延期范围，不是当前未做缺陷。已有 guardrails/交接对图片上传、前台可恢复队列、基础搜索边界如实保留；不自行扩展视频上传、原生地图、多维地点搜索或杀进程后后台持续传输。

## 下一步建议与阶段边界

Native / Web 本地品牌验收已完成。父线程仅需安全处理 Studio 最近卡片刷新，或明确保留其 BLOCKED 状态；正式交付继续等待 C，保持 **PHASE_10_COMPLETE: NO / PRODUCTION_READY: NO**。

ROADMAP 的 Phase 11 Admin（成员、容量、worker、备份/integrity、trash/audit、maintenance/read-only）是独立下一阶段，没有允许绕过 Phase 10 交付门槛自动开始的条款。本轮不提前实现或设计其中安全模型。如用户以后明确授权，可先界定 Admin 范围、复用已有 API 并按 R3 规则处理涉及权限/维护操作的设计；由父线程决定，不作为本期“其他”工作执行。

无提交、推送、部署、真实媒体、密钥读取、quota reset 或购买；额度耗尽或新确认重置时停止，不操作重置卡。
