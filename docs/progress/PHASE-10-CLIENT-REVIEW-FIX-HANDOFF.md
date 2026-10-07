# Phase 10 C1–C4 整批修复交接

2026-10-06 UTC；HEAD仍为 `6510261f920b5ebe6d98d1cefa3227fb221bbd5f`。依据 Astra 独立审查 `PHASE-10-CLIENT-INDEPENDENT-REVIEW.md` 的最小方案落实；**修复候选待针对性复审，未自行关闭 P1/P2，客户端验收仍未完成**。

## 修复

- **C1**：SecureStore read/write/delete 共享有序队列。app私有 document 保存仅含固定 `denied` 的失效标记，token仍只在SecureStore；任何凭据持久化开始前标记禁止恢复，仅成功完成且epoch仍一致的写入可移除标记。退出先持久失效再排队删除；删除失败/远端离线保留标记，下一模块/进程 restore 不读取旧token/不调用me。旧write完成后发现epoch失效，删除其记录且不清标记；旧cleanup排序在新login写入之前，不删后续新凭据。401/foreground失败也用同一边界。该标记受既有backup排除保护，不包含token/hash/user身份，不改变服务端合同。所有本地持久介质同时失效/真实掉电的持久保证不在本轮测试证据内；失效标记写入错误不可静默当作退出成功。
- **C2**：DocumentPicker `copyToCacheDirectory:false`，先读取元数据/准入，再由本应用以1MiB块拷贝唯一私有partial；已安装Expo Android源码支持content URI只读handle。每次按实际目录占用和任务保留量检查2GiB上限、256MiB单文件、50任务、128MiB剩余空间底线；reselect将旧source+新partial峰值纳入限额。成功无picker缓存副本，reselect异常清partial；初始copy移动后WAITING持久化失败也删除source。启动reconciliation清理DONE对应source、COPYING对应source/partial、已无记录UUID source和全部UUID partial；保留所有账号未完成source。清理范围仅app私有upload-queue及其专用Expo DocumentPicker旧cache，绝不删除外部选择原文件。历史裁剪后的orphan下一启动回收。
- **C3**：目标PUT先`checked`，404/409/403和响应丢失不改变本地targets/stage、不显示成功；成功后仍检查账号epoch/scope才保存。原operation fingerprint/originalTargets不变，APPLIED不重做placement。
- **C4**：全部后续相册页绑定当前AbortSignal和epoch/active检查，覆盖headers与body完成之后；错误被捕获。suspend清albums/after/selection/dialog，validated=false；当前账户未验证不能打开私有选择器。隔离browser测试使用实际React组件，而不是替代组件。

## 精确验证

| 检查                                                                 | 实际结果                                                              | 本机日志                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| 单元/控制器回归                                                      | **6 files /51 PASS/0 FAIL/0 SKIP**，11:31:56前后完成                  | `/tmp/phase10-checkpoint-client-review-fixes-tests-final.log` |
| package typecheck contracts/mobile/web                               | PASS，exit0                                                           | `client-review-fixes-types-final`                             |
| targeted ESLint（含隔离browser脚本）                                 | PASS，exit0                                                           | `client-review-fixes-lint-final`                              |
| targeted Prettier                                                    | PASS，exit0                                                           | `client-review-fixes-format`                                  |
| Web production build                                                 | PASS，exit0                                                           | `client-review-fixes-web-build`                               |
| Android arm64 debug assemble                                         | PASS，exit0，318tasks，16s                                            | `client-review-fixes-apk`                                     |
| debug APK signature verification                                     | PASS，仍为原Expo Android Debug证书                                    | 本机apksigner                                                 |
| 实际React DOM：auth-lost / hide→restore / account-mismatch held page | **3 PASS**，无旧相册DOM，selector关闭，signal中止，恢复不显示迟到名称 | `client-review-fixes-dom-final`                               |
| 真Native HTTPS/SecureStore/DocumentPicker/content URI/crash-kill     | **未执行**                                                            | 可信DEV TLS及设备门槛仍在                                     |
| 真H5 HTTPS重选→READY/APPLIED→My/logout                               | **未执行**                                                            | TLS preflight门槛，历史绕证书FAIL不计PASS                     |
| 独立针对性复审/完整Quality Gate                                      | **未执行**                                                            | 交父线程安排                                                  |

原33项保持；新增18项：session5（delete+offline冷启动、延迟login/rotation/background写、旧失败cleanup后新login）；queue9（真实Node合成目录的DONE/COPYING/orphan/partial、其他账号保留、50任务/实际2GiB稀疏文件/空间底线、move后persist失败、反复reselect、403/404/409、lost+200）；privateAlbumPage4（三种epoch失效与body读取期间失效）。Node文件适配器操作真实临时文件并清理，证明JS控制流/磁盘用量，不冒充Android FileSystem或SecureStore实机证据。稀疏2GiB synthetic文件仅在owned系统tmp创建，测试后移除。

本轮首跑1 FAIL+50 PASS：body失效后仍先parse已失效payload，修为先检查epoch再parse后51PASS；早期typecheck因Node测试类型未声明失败、lint因测试变量/globals失败，补Node-only类型和明确browser callback globals后正式检查PASS。首次DOM本地listen遇EPERM，最小runtime escalation后PASS；没有安全拒绝绕行，没有DEV数据库fixture、CA/私钥生成或trust变更。全部最终日志含命令/UTC/退出码；新旧日志指纹分别保存。

## 交付指纹与剩余

修复后APK：`.cache/phase10-client/family-album-dev-arm64.apk`，85,168,880bytes，SHA256 `be2e16cad7a53761f3c880f92766849e4d89524471a210f3d0adfefff86fe16b`。本轮仅构建和签名核验，**没有重新安装/启动此修复包**。前轮登录截图/安装属于旧候选，旧APK另留 `.cache/phase10-client/family-album-dev-arm64-pre-review.apk`，旧evidence保存 `phase10-client-artifacts/evidence-pre-review.json`。

当前 `phase10-client-artifacts/evidence.json` 重新记录修复源码/日志/新APK。原独立审查文件保持原候选指纹，不能将其当成新代码通过的证据。

继续门槛不变：专用DEV CA及Mac信任尚未获批，未改trust、未ignoreHTTPSErrors、未点击证书警告。正式签名、真实手机/HarmonyOS6.1H5、邀请/轮换/断连/重启/READY等native和H5联调待后续。请针对C1–C4复审尤其持久标记/序列交错、Expo content URI只读行为及startup reconciliation、404/409目标保留、React DOM失效清理；本轮不宣布关闭审查、不做完整Phase gate、不进入下一Phase、不commit/push/deploy。
