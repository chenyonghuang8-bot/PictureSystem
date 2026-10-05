# Phase 9 P2-01 lifecycle evidence closure handoff

2026-10-05，基线 `979d6eb063a1137387ded31330ea3a3a6cd99436`。仅处理 `PHASE-09-MEMORIES-INDEPENDENT-REVIEW.md` 的 P2-01 验证缺口，待原审查者限定 closure；没有改产品源码、权限/事务/storage 设计或缓存策略，没有新架构、commit/push/deploy/Phase 10。全 gate 交由父代理在 closure 后执行。

## 最小变更

新增 `apps/web/components/gallery/memories-bfcache-browser.test.ts`：复用合成 Memories host bundle，启动本机合成 HTTP server 与独立系统 tmp Chrome profile。Chrome 自有进程、server 和 profile 在 teardown 关闭/清理。没有读取真实媒体、生产库或用户 Chrome profile，没有外部服务、请求拦截或手工 dispatch lifecycle 事件。只读能力核对确认启动参数中没有 `--disable-back-forward-cache`。

现有 browser test 的标题改为“simulated persisted pageshow and same-document history”，修正原 handoff 的证据措辞，保留旧模拟测试的实际覆盖。没有改原独立审查报告。

## 实際结果

Chrome `154.0.8037.97`，headed，Playwright `connectOverCDP(..., {noDefaults:true})` 连接 owned browser 的 default context。检查安装工具源码发现普通 Playwright context 会发送 `Emulation.setFocusEmulationEnabled: true`，导致标签看似一直 visible；此次关闭默认工具覆盖，实际切换同一浏览器窗口的标签。不是模拟 visibility 事件，也不是注入 `document.visibilityState`。

最终命令：`pnpm exec vitest run apps/web/components/gallery/memories-bfcache-browser.test.ts --reporter=dot`。1 file，5 PASS，0 skip，3.87s。日志 `.cache/phase9/real-bfcache-final.log`，逐事件、首帧和 rAF 记录 `.cache/phase9/real-bfcache-proof.json`。

| 用例 | 实际证据 |
| --- | --- |
| BFCache + auth 失效 | 跨文档离开、真实 back、forward、back；两次 `pageshow.persisted === true`，同一 document ID；恢复事件同步样本及全部等待帧 cells/viewer/images 为 0；暂扣响应后释放 401，旧照片和 Viewer 不回来 |
| BFCache + day 失效 | 同样两次真实 persisted 恢复；释放 409 后继续暂扣自动 bootstrap，保持空白；释放新 anchor 的空列表后仍无旧照片 |
| 真实可见性 | Chrome 原生 tab background/foreground；记录真实 hidden→visible；空白等待期 16 个 rAF 样本全部为 0，释放 401 后只显示登录提示 |
| production-header reload + auth | main HTML 带 `private, no-cache, no-store, max-age=0, must-revalidate`；实际 back 为重载，document ID 改变、persisted=false、navigation type=back_forward；17 个空白帧，401 不恢复旧照片 |
| production-header reload + day | 同样真实重载；空白期间释放 409，再暂扣新请求，最后新日空列表，无旧照片 |

前两项的合成 main HTML 为 `private, no-cache, max-age=0, must-revalidate`，为了使当前 Chrome 真正缓存文档而省略 main HTML 的 no-store。所有 API 和图片响应仍为 private,no-store；没有修改应用实际 header。这证明 production Memories 组件的真实缓存恢复路径，不声称实际 Next no-store 文档在该浏览器会命中 BFCache。

后一对用实际 no-store main header 验证当前浏览器的保守退路。Chrome `notRestoredReasons` 实际返回 `response-cache-control-no-store` 与 `response-cache-control-no-store-with-js-network-request`（另有 masked）；没有隐藏环境不能缓存的证据。无需用模拟 persisted 事件冒充真实恢复，也无需改变私有页面缓存策略。

首帧证据来自在 head 注册、先于产品 handler 的真实 pageshow listener，同步采样和 microtask 后采样均为 0；真实 persisted 恢复事件同步重置 rAF 记录，保留第一个恢复帧。测试等待至少 3 个帧，并暂扣合成回忆响应 ≥200ms 后验证全部样本为空。恢复前实际有一个 grid cell、打开的 Viewer 和已解码图片。没有只在响应完成后检查最终 DOM。

## 失败与限度

首次带 no-store HTML 的 BFCache 断言超时，后来记录了上述 Chrome 原生拒绝原因；这是能力限度，未算 PASS。普通 Playwright 上可见性超时，通过 noDefaults 原生 Chrome context 才获得真实 hidden→visible。可缓存文档首次 back 已命中，但 forward 的默认 load 等待不适用于缓存恢复，改用 commit 等待。原生真实帧首轮一次只有 1 帧，改为实际等待 ≥3 帧，不放宽空白断言。最终五项全部通过。

这是合成 host 对实际 Memories/Viewer 组件的生命周期测试，401/409 响应由 owned server 控制；不重新证明数据库 ACL 或真实跨上海午夜，也不代替此前真实 HTTPS 上传验收。没有声称截取 OS compositor 每个像素；证据覆盖 pageshow handler 前/后与浏览器 rAF 可绘制帧中的 DOM 图片/Viewer 为空。

Web targeted typecheck 和新测试 ESLint PASS，最终 diff/format 检查 PASS。根测试 tsc 的独立基线/候选 201 条同位置诊断仍记 FAIL，非本批引入，不为此扩范围。请原审查者仅核对 P2-01 的新增测试和证据，并决定 closure，随后父代理运行一次全 Phase 9 gate。
