# Phase 10 Android / H5 client independent review

Date: 2026-10-06. Decision: **CHANGES REQUIRED; CLIENT ACCEPTANCE NOT COMPLETE**.

Scope: 当前 Android + 手机 H5 客户端候选，独立源码审查及必要 targeted 诊断。共同服务端沿用已接受的独立审查，不重开其实现；通知、FCM/device registration 已由用户排除，不作为门槛。没有修改实现、测试、migration、系统信任或 TLS 配置，没有运行全量 gate、接触真实媒体或提交 Git。

ROUTING DECISION: PRO_STABLE / R3-DESIGN independent security review / 用户授权 Astra 审查 / targeted。本报告是审查结果，不是 Phase 10 完成声明。

## 候选与证据指纹

- HEAD: `6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。
- 交接：`docs/progress/PHASE-10-CLIENT-IMPLEMENTATION-HANDOFF.md`；要求：`project-spec/ROADMAP.md:212` 和 `docs/progress/PHASE-10-ANDROID-IMPLEMENTATION-GUARDRAILS.md`，按用户最新 FCM 排除范围解释。
- 实际 evidence 位置是 `docs/progress/phase10-client-artifacts/evidence.json`，不是仓库根目录。审查时 SHA-256：`10587434390c13b4866d1b75979cb89ef9523db1f9c346e21c5539185a5ce9c1`。
- 独立重新计算：manifest 中 **36/36 源码文件匹配，9/9 日志匹配，APK 匹配**。源码包含原生会话、媒体、队列、邀请、Android plugin、H5 上传/账户/页面和共享上传状态机；审查以实际文件为准。
- APK SHA-256：`a1e0ce685d12ab39ac91ff2ffe3dd81220955fc4e3fd0513f7c7670b46b70ff9`。它是 debug APK；Expo 模板公开 debug.keystore 不视为正式签名秘密或正式交付证据。

## Findings

### C1 — P1：退出清理与凭据持久化没有形成可靠的失效边界

位置：`apps/mobile/lib/session.ts:133`、`:171`、`:183`，恢复入口 `:71`。

触发与影响：

1. 已登录时 SecureStore 删除失败，且远端 logout 因离线失败。代码立即清空内存并显示未登录，但旧凭据仍在 SecureStore，远端失败被吞掉。下次冷启动直接读出旧记录并成功 `/auth/me`，无需再次输入密码即可恢复私有页面和队列。退出失败提示不等于阻止后续自动恢复。
2. login/rotation 的 `setItemAsync` 已开始而未结束时，若退出清理先完成，随后旧写入完成，写入后的 epoch 检查只抛错，不撤销刚持久化的凭据。该陈旧凭据可被下一次 restore 接纳。这里已实证的是控制器调用交错；当前 UI 在 busy 时是否允许直接点击退出不是本诊断的假定。生命周期失效同样可能打断写入，需要覆盖。

独立证据：在 Node 中转译**实际 session.ts**，注入受控 SecureStore/transport，仅使用合成会话记录；没有更改生产源码或现有测试。删除失败 + 离线序列输出 `after failed-delete offline logout authenticated=false`，新建模块实例后 `cold restart authenticates without credentials=true`。阻塞 setItem → logout → 释放写入序列输出 `late-write after logout persisted=true`，新实例 restore 后 `authenticated=true`。这些是控制器诊断，不是 Android Keystore 实机验收。

最小修复：使凭据写入、撤销和恢复共享有顺序的生命周期边界；旧 epoch 的持久化不能在撤销后重新成为可恢复凭据。删除失败时必须保留可执行的失效/重试状态并让恢复保持未认证，而不是只清内存。不要为了修复改变服务端 token/rotation 合同或把 token 移到普通数据库。实现具体持久失效办法若改变已批准安全模型，应先补 guardrail 复核。

回归：真实控制器覆盖 pending login/rotation write 与 logout/后台切换交错；删除失败 + 远端离线 + 新进程恢复；旧失败清理不得删除后续新登录凭据；Android SecureStore 实测上述失败/恢复边界。

### C2 — P2，阻塞客户端接受：私有上传副本存在无上限的隐藏占用和崩溃后遗漏清理

位置：`apps/mobile/lib/queue.ts:94`、`:106`、`:171`、`:29`、`:258`、`:293`；共享状态机 `packages/contracts/src/client-upload.ts:238`。

触发与影响：

- DocumentPicker 使用 `multiple:true, copyToCacheDirectory:true`，在 50 个任务、256 MiB 单文件、2 GiB 总量及剩余空间检查之前，已将选中内容完整复制到本地。成功、额度拒绝、摘要不符及 reselect 后都没有清理这些 picker 缓存副本。重复选择相同照片或一次选择超限集合，会留下未计入 queue size 的完整照片副本；删除/DONE 队列任务也不释放它们。系统可能回收 cache，但这不能兑现应用的有界磁盘合同。
- `uploadStep` 先持久化 DONE，`pumpQueue` 随后才删 `.source`。进程恰在两者之间结束后，`openQueue` 只清理 COPYING；pump 又排除 DONE。该原始大小的私有副本永久遗漏，后续 DONE 历史裁剪还能删除其唯一记录。无需修改原始媒体就能修复。

独立证据：检查已安装 `expo-document-picker@57.0.3` 的 Android `DocumentPickerModule.kt:82–138`：逐个同步复制到 `cacheDir/DocumentPicker` 后才 resolve，路径为生成的输出文件，未见本应用调用后的自动清理。转译实际 queue.ts 并注入一条 DONE + 存在 source 的 SQLite/File 替身，调用 openQueue 的删除次数为 **0**。后者证明恢复控制流遗漏，未声称执行了真机 kill/crash。

最小修复：在大批量复制前执行可行的有界准入，或使用受控的有界复制入口；只清理能够证明由本应用本次 picker 创建的缓存路径，绝不删除外部用户选择的原文件。成功、拒绝、取消/异常及重启都需覆盖清理。启动时对 DONE 和已失去记录的应用自有副本作有界 reconciliation，并将实际临时占用纳入额度。

回归：合成超限选择/重复 reselect/正常成功后的磁盘用量；DONE 提交后、文件删除前 kill/restart；历史裁剪后的 orphan；其他账号未完成任务和外部原文件必须保留。仅 mock 计数不足以接受最终文件系统行为。

### C3 — P2，阻塞客户端接受：原生目标变更把 404/409 当成功保存

位置：`apps/mobile/lib/queue.ts:205–215`，`apps/mobile/lib/session.ts` 的 `queueRequest`。

触发：服务端已经 APPLIED，或上传已不可用，PUT `/uploads/:id/targets` 返回 409/404。queueRequest 为上传观察协议特意将这两个状态转换为正常 Response；changeTargets 没有调用 checked，仍覆盖本地 targets 并设为 WAITING。

影响：用户看到目标修改已完成/等待重试，但服务端保持旧目标；后续观察原 APPLIED 结果可能显示 DONE，造成照片已加入新相册的错误认知。服务端权限并未被绕过，不是重新打开服务端问题。

独立证据：转译实际 queue.ts，queueRequest 返回 409；`changeTargets(job,['2'])` 正常 resolve，持久化结果为 `targets=['2'], stage=WAITING`。H5 同一路径已有 `.then(checked)`，原生遗漏明确。

最小修复：检查 PUT 状态后再改变本地目标；404/409 保留服务器已知目标并提示重新观察。回归 200、403、404、409、响应丢失，特别是 APPLIED 后变更不得假成功或重新 placement。

### C4 — P2，阻塞客户端接受：H5 “更多相册”迟到响应可重新填入已失效私有状态

位置：`apps/web/components/mobile/upload-panel.tsx:395–406`；失效清理 `:62–72`；上传按钮 `:269` 附近。

触发：有超过 50 个可列出的相册，点击“更多相册”后让响应延迟；此时触发 `family-auth-lost`、页面隐藏/恢复或账号重新验证不匹配。suspend 清空状态，但翻页请求既没有绑定 AbortSignal，也没有捕获/检查 epoch，随后仍会 `setAlbums` / `setAfter`。

影响：旧账号的相册名称/权限摘要可回填到已失效的组件。上传按钮自身没有 active 门控，失效后再次打开选择框即可显示这些旧名称。上传执行处的 active 检查能阻止新的传输，却不能阻止这里的私有信息回显。此结论来自完整分支源码追踪；尚未执行真实 TLS 浏览器复现，不把它描述成已观察到的 E2E 泄漏。

最小修复：所有相册分页使用同一请求生命周期和 epoch 校验，捕获错误；suspend 同时清理 after 等分页状态，未通过当前账户验证时不得打开私有相册选择器。回归将第二页响应 hold，分别跨 auth-lost、隐藏/恢复和账号不匹配再释放，检查 DOM 无旧名称且不能继续旧分页。

## 已验证的边界及 targeted 结果

- 独立复跑：`pnpm exec vitest run --config vitest.config.ts packages/contracts/src/client-upload.test.ts apps/mobile/lib/session.test.ts apps/web/lib/gallery-client.test.ts apps/web/lib/memories-session.test.ts`，**4 files / 33 PASS / 0 FAIL / 0 skip**。全部属于 unit/mock，不是 E2E。
- 交接的 typecheck、lint、format、Web build、APK build 日志指纹匹配；本轮没有无意义重复构建，也没有运行全量 gate。
- 源码确认 exact HTTPS origin、credentials omit、私有 binary 请求不使用裸远端图片 URL；安装的 Expo 57.0.22 Android `NativeRequest.kt:44–45` 对非 FOLLOW 设置 `followRedirects(false)`，`NativeResponse.kt:128` 对 ERROR 拒绝重定向。这支持实现方向，没有发现“仅 JS 声明但 native 自动跟随”的现成源码缺陷；仍需真实 Android 请求/重定向观测。
- 身份 epoch 覆盖常规响应和私有 binary stream；预览缓存有独立删除入口；queue scope 包含 origin/user/family，UUID+摘要先持久化再创建请求；未知 create 走 operation 观察，HEAD 观察 offset；历史 APPLIED 不足以宣称可见成功。上述正向边界不抵消 C1–C4。
- 邀请采用固定 scheme/host/唯一规范 token、SecureStore 限时 pending、显式新账号 consume，未发现自动入会或 token 路由展示；Android 备份排除及禁明文配置存在。邀请冷/热启动、取消/过期和生命周期竞态仍缺原生端到端证据。

## TLS 与未完成的验收：不得改写为 PASS

- 历史 H5 `ignoreHTTPSErrors` 试跑 **不属于可接受验收**。它只到 create 断连、重新打开后需重选；折叠队列断言失败，曾有 fixture cleanup 失败。其后的同内容重选、READY/APPLIED、照片/我的/logout 链路没有跑通，不能从单元测试或源码推定通过。合成 fixture 已由实现方清理，证据记录 remaining=0；本轮未另造家庭数据。
- 严格 TLS 浏览器日志为 `ERR_CERT_AUTHORITY_INVALID`；最终 preflight 为 `PHASE10_EXISTING_TRUSTED_DEV_TLS_PAIR_REQUIRED`，exit 1、0 acceptance。现有 harness 自签证书 SAN 仅 localhost/127.0.0.1，不含 native 默认目标 10.0.2.2；即使解决信任，native 主机名验证还需正确证书。缺少可信 DEV HTTPS 是明确环境门槛，不能归因于已证明的业务故障，也不能掩盖 C1–C4。
- Android 仅 debug APK 构建/安装/启动到登录页；**没有真实 HTTPS 登录**，因此 SecureStore 恢复、四页、私有图片、真实 picker、上传/断连/重启/去重/READY/选择相册、logout、邀请均未形成 native E2E 验收。
- 本轮没有申请/安装 CA、修改 Mac 信任、关闭证书/主机名校验，或使用任何 TLS bypass。父线程正在另行请求专用 DEV CA/信任设置授权；尚未获批这一事实不构成执行许可。
- 正式签名 APK、vivo Y35 / HarmonyOS4.2 安装体验及 HarmonyOS6.1 H5/桌面快捷方式仍待实机验收。公开 debug 签名不能代替正式交付；FCM 无需补齐。

## 接受条件

当前 **P0=0；P1=1；阻塞 P2=3**。先修复 C1–C4 并整批提交源码指纹和对应回归证据复核；获批且建立可信 DEV HTTPS 后补齐真实 H5/native 流程，保留历史 FAIL。之后才进入 Phase 10 full Quality Gate 和交付验收。没有批准进入 Phase 11，也不声明 Phase 10 complete。

## C1–C4 closure 复审追加 — 2026-10-06

**本节更新上文原候选的 findings 状态：C1、C2、C3、C4 均 CLOSED。修复候选可通过本次限定源码 closure；客户端真实链路验收及 Phase 10 完成仍未通过。** 原报告及其失败证据保留，不追溯改写为 PASS。

范围严格限于四项修复及直接依赖；读取 `PHASE-10-CLIENT-REVIEW-FIX-HANDOFF.md`、当前 evidence、修复源码、回归用例和已安装 Expo Android 文件访问实现。本轮只追加本报告，没有修改产品、测试或 migration，没有重开共同服务端或全架构设计。

### 修复候选指纹

HEAD 仍为 `6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。当前 `docs/progress/phase10-client-artifacts/evidence.json` SHA-256 为 `6aa0c60547a5ba792d8e493a43446ad0e98121c5c68b256400378c93b623c7b0`；独立重算 **41/41 源码、20/20 日志匹配**。其中日志包括保留的早期失败，20/20 是文件完整性匹配，不是 20 项 PASS。

新 APK SHA-256 为 `be2e16cad7a53761f3c880f92766849e4d89524471a210f3d0adfefff86fe16b`，独立匹配。该包只完成构建和 debug 签名核验，**尚未重新安装/启动**；旧安装截图不能证明新包运行成功。

### 逐项关闭理由

- **C1 — CLOSED。** `apps/mobile/lib/session.ts` 的 orderedStorage 将读、写、删除串行化；logout 先留下 app-private 非秘密失效标记，删除失败也不能被 restore 当成有效凭据。persistCredential 在写前标记禁止恢复，写后检查 epoch；迟到写入只做失效清理，不清标记，后续新登录写入排在旧清理之后。restore 发现标记即拒绝恢复且不调用 me。token 仍只存 SecureStore，固定 deny 标记不含 token、hash 或账户身份，受既有备份排除保护；这属于原审查失效边界的局部落实，不改变服务端安全合同。复跑覆盖 logout 删除失败+离线后的模块重建、login/rotation/background 迟写、失败清理之后新登录；均通过。没有发现原 C1 序列在当前实现中仍能恢复旧会话的具体路径。所有持久介质同时失败、真正掉电以及 Android Keystore 行为不由这些 mock 测试证明，保留为实机证据边界，不据此无限重开已修复的确定性问题。

- **C2 — CLOSED。** `apps/mobile/lib/queue.ts` 将两个 picker 入口改为不自动复制，按实际目录 bytes 与任务预留的较大值准入，并在受控 1 MiB 分块复制之前检查大小/剩余空间；reselect 计入旧 source 与新 partial 同时存在的峰值。copy 移动后 WAITING 保存失败会清理 source；启动清理 DONE/COPYING source、UUID partial 与无记录 source，并保留所有账号未完成 source。范围限于应用专用目录及既有专用 picker cache，未对外部选择 URI 执行删除或写入。实际 Node 临时文件回归覆盖 2 GiB 稀疏占用、空间底线、任务数、move 后保存失败、重复 reselect、DONE/COPYING/orphan 清理及其他账号/外部原文件保留，全部通过。另读已安装 `expo-file-system@57.0.7` Android `FileSystemFile.kt:63–72`：SAFDocumentFile 默认 READ，进入 forContentURI；`FileSystemFileHandle.kt:74` 使用 ContentResolver descriptor。未发现本次去掉 picker cache 必然导致 content URI 以写模式打开的源码问题。真正 provider 权限、Android 文件句柄和 kill/restart 尚未实机验证，但目前无剩余具体 C2 复现。

- **C3 — CLOSED。** changeTargets 先 checked 再进行 epoch/scope 校验和本地 targets 更新；403/404/409 与丢响应不会写成功状态。复跑三种错误、丢响应及成功 200 的回归全部通过；originalTargets 和 operation fingerprint 保持原值，没有借修复重新执行 APPLIED placement。

- **C4 — CLOSED。** moreAlbums 捕获当前 signal/epoch，通过 privateAlbumPage 在请求前、headers 后、body 后检查有效性，失效 payload 不再解析或回填。suspend 清分页游标、相册、选择和弹窗；validated 与 active 阻止未通过当前身份检查时打开选择器。四项 helper 回归通过；独立运行实际 MobileUploadPanel React DOM 的三种 held-page 场景（auth-lost、hide/restore、account-mismatch）全部通过，旧名称未回填，弹窗关闭且 signal 中止。测试 transport 有意忽略 abort 后释放旧响应，因此不是仅靠取消成功掩盖缺少 epoch 检查。

### 独立 targeted 复跑与界限

1. `pnpm exec vitest run --config vitest.config.ts packages/contracts/src/client-upload.test.ts apps/mobile/lib/session.test.ts apps/mobile/lib/queue.test.ts apps/web/lib/private-album-page.test.ts apps/web/lib/gallery-client.test.ts apps/web/lib/memories-session.test.ts`：**6 files / 51 PASS / 0 FAIL / 0 skip**。
2. `node tests/e2e-web/phase10-upload-panel-isolated.mjs`：**3 actual React DOM cases PASS**。首次 sandbox 执行在临时 `127.0.0.1` listen 处 EPERM；经最小 runtime escalation 获准后重跑通过。仅合成页面/transport，无真实 API、数据库 fixture、TLS bypass 或系统信任修改。
3. 修复交接的 typecheck、lint、format、Web/Android build 最终日志指纹匹配，本轮不重复全量构建或 Quality Gate。Node 文件适配器与会话 mock 不冒充 Expo/Android 实机；隔离 HTTP DOM 测试不冒充真实 HTTPS H5 上传。

本限定批次剩余 **P0=0、P1=0、阻塞 P2=0**。可信 DEV TLS 仍待用户授权；未安装 CA、未修改信任、未使用 ignoreHTTPSErrors。历史严格 TLS FAIL/阻塞和旧绕过试跑失败全部保留。后续需要获批的可信 HTTPS、修复 APK 重装、真实 native/H5 登录与上传恢复到 READY/APPLIED、私有 viewer/邀请/logout、正式签名及目标设备验收，最后运行 Phase 10 full gate。它们是既有交付门槛，不表示 C1–C4 仍未关闭；本轮不声明 Phase 10 complete，不进入下一 Phase。
