# Phase 10 展示名称更新

2026-10-06 UTC。本次最终授权名称为 **嘟嘟家庭相册**，覆盖此前尚未落盘的“陈家的时光”请求。只改固定品牌与项目显示名称；技术目录 PictureSystem、GitHub repository、npm packages、applicationId、DB schema、deeplink scheme、release key alias 保留。

## 2026-10-07 本地可见验收补记

本轮只补文档与证据，未改产品源码、未重建 APK、未重跑完整 gate 或安全审查。下文 2026-10-06 的“新 APK 未安装”等表述保留为当时历史；本节及 `phase10-branding-artifacts/visible/evidence.json` 记录最新状态。原 branding evidence.json 保留原始指纹和时间，其 report hash 对应补记前版本。

- **Native PASS**：核对同一 APK 的 85,204,648 bytes / SHA-256 `3e15988b972fb5d8f43df27b4d4d36e6e69ea9c9f27a73e4e5f2196a1e6694c9`，在原有 Pixel_8_Pro DEV 模拟器 install -r 成功；MainActivity 启动 Status ok。实际登录页与 Android Settings App info 的应用 label 均显示“嘟嘟家庭相册”，UI XML 精确文本检查 PASS，并逐张查看截图。label 证据来自 App info；没有宣称拍到 launcher 首页图标。
- **Web PASS**：既有 HTTPS harness 只监听 127.0.0.1:3443，未启动 API/数据库。Chrome 新建无认证 context，`ignoreHTTPSErrors:false`，访问 https://localhost:3443/login；390×844 与 1440×1000 均 HTTP 200，document title 与可见 h1 精确为新名。heading bounding box 位于 viewport 内，实际截图无明显截断。未输入账号、未登录或上传。
- **Studio BLOCKED**：只读 recentProjects.xml 的本项目条目仍为旧 frameTitle“张家的时光”，opened 属性当前未出现；该缓存不能证明实时窗口状态。当前无可靠原生 GUI 工具确认用户活动窗口，因此未关闭/重开工程、未触发 trust/JDK migration，也未改写 live cache。工程 `.idea/.name` 与 Gradle 名称仍为新名；最近项目卡片截图仍待安全 reopen/refresh。
- **权限与 cleanup**：实际执行环境 workspace-write / auto_review，没有修改审批设置或自助批准。普通 Chrome 启动失败 SIGABRT/EPERM 留存，最小本地 runtime escalation 后两 viewport 成功（退出 0）。ADB/模拟器与 loopback 服务使用同类最小授权；ps EPERM 后仅为精确 cleanup 查询进程。无审批拒绝。已删除两份任务 XML 的 emulator 临时副本、force-stop DEV app、停止本轮启动的模拟器与 HTTPS harness；host 截图/XML/日志留作证据。无账号/DB fixture/媒体创建、trust/proxy 变更、正式签名或用户窗口操作。

截图：[Native 登录](phase10-branding-artifacts/visible/native-brand-login.png)、[系统应用 label](phase10-branding-artifacts/visible/native-brand-label.png)、[H5](phase10-branding-artifacts/visible/h5-brand-login.png)、[桌面 Web](phase10-branding-artifacts/visible/desktop-brand-login.png)。9 个原 branding 源文件及 APK 指纹再次匹配基线，没有额外产品修改。正式交付 C 门槛不变，**PHASE_10_COMPLETE: NO / PRODUCTION_READY: NO**。

## 来源与实际变更

9 个文件，共 10 行文案变化：

- Expo `apps/mobile/app.json` name、Android `strings.xml` app_name：张家的时光 → 嘟嘟家庭相册。
- Gradle `settings.gradle` rootProject.name 与本项目 `.idea/.name`：张家的时光 → 嘟嘟家庭相册。这两处是 Studio 工程显示名称来源。
- 原生登录页、Web 登录页：家的时光 → 嘟嘟家庭相册；Web root metadata.title：家庭相册 → 嘟嘟家庭相册。
- 当前 `project-spec/README.md` 标题/介绍、`PROJECT.md` 标题同步；其他“家庭相册”功能术语与原文格式保留。

登录后的家庭名称/相册标题仍来自实际 DB 数据；没有修改任何真实或合成家庭名。参考 app-preview/web-preview 图像未编辑，不将参考图文字冒充当前 UI。既有历史报告、原始日志、migration hash、证书与用户 keystore 内容未改。

Studio 最近项目缓存的本项目 entry 在检查时仍记录 `frameTitle="张家的时光"`、`opened="true"`。未直接覆盖运行中的 IDE 外部缓存，也未修改无关 recent projects。用户关闭并重新打开 `apps/mobile/android` 后，需让 Studio 按新 `.idea/.name` 与 Gradle 名称刷新最近列表/首字图标；**该最近项目卡片的刷新截图仍未验证**。当前工具未进行新 APK 安装或原生运行截图，不用 label 资源检查冒充屏幕验收。

## 验证与交付

- Mobile + Web package typecheck PASS；3 个改动 TSX 文件 ESLint PASS；代码与 README targeted Prettier PASS；git diff check PASS。PROJECT 文档保持原有格式，仅替换标题。
- Web build PASS，实际生成的 login HTML h1 和浏览器 title 均为嘟嘟家庭相册。
- 既有 JDK 17/SDK/缓存下单次离线 Android arm64 debug assemble PASS，43 秒，30 tasks executed / 309 up-to-date；没有下载、正式 release build 或用户 keystore 签名。
- SDK aapt2 对实际 APK 验证 application-label（含 zh-CN/zh-HK/zh-TW）为嘟嘟家庭相册，package 仍为 `local.familyalbum.app.dev`；apksigner verify PASS。
- 未发现旧品牌文字对应的现有测试 expectation，无业务逻辑变更，因此没有添加只镜像字符串的单测，也未重跑全 gate。

新 DEV-only APK：`.cache/phase10-branding/family-album-dev-arm64.apk`，85,204,648 bytes。

```text
SHA-256: 3e15988b972fb5d8f43df27b4d4d36e6e69ea9c9f27a73e4e5f2196a1e6694c9
```

旧 accepted APK 与 `phase10-client-artifacts/evidence.json` 原样保留，属于改名前独立审查/真实链路验收基线；不可把旧安装截图及指纹说成新品牌 APK 验收。新的变更前后指纹、两份构建日志及 APK 记录见 `phase10-branding-artifacts/evidence.json`；改名前 9 文件备份位于 `.cache/phase10-branding/20261006T175511108150Z/`。本批文案没有重新设计或变更安全合同，也未重做独立安全审查。正式签名、手机可达 HTTPS、家人设备与 Phase 完成门槛仍未解除。

## 独立获准的 keystore 权限操作

用户明确批准后，仅对 `<user-managed signing directory>/family-album-release.jks` 做 lstat/fstat：确认本人持有、常规文件、非 symlink，随后该单文件 fchmod 为 **0600** 并复核。没有读取内容/密码/alias，没有递归权限变更、上传或签名。此批准不扩展至系统 trust、LAN/公网或部署。
