# Phase 8A1 — R1 定点关闭复核

2026-10-02 UTC，17:38；基线 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。只复核 R1 日志修复和直接回归，未实现、未 commit/push，未扩展 8A2、地图或性能复核。

**结论：NEEDS_FIX。普通 DEV incoming request 日志泄露已修复，但搜索代理的连接失败日志仍包含完整 query/cursor。R1 尚不能整体 CLOSED。无新的 P0/P1；剩余同范围 blocker 为 R1-E1 / P2。**

## 已通过部分

- `apps/web/next.config.ts:10` 的 `logging: { incomingRequests: false }` 只关闭原始访问日志，没有 `logging:false`、吞异常或删除 URL 恢复。原始合成首页探针独立复跑：HTTP200，`privateQueryLogged:false`，证明此前已复现的正常访问泄露已消除。
- 观察器先执行既有 owned root/certificate/nonce 检查，才创建 wx/0600 观察文件。Next stdout/stderr 原样转发到文件及原 console，没有过滤、截断或错误吞掉；原 ownership 守卫未变。
- 独立复跑更新后的真实 HTTPS 8A1 日志用例：**1 PASS、skip0、retries0**。SSR 筛选 URL 刷新、search 代理分页/cursor、无效 query 的正常 HTTP 响应场景通过；实际观察日志仍包含 Ready 和真实 stderr self-signed warning，且所测 query/cursor 不出现。
- 24 个 R1 checkpoint 源码/文档文件和14个 artifact hash 全部吻合；复跑后再次核对仍一致。其他搜索实现文件与前次复核一致，仅 R1 配置、观察器、对应测试及状态文档变化。检查了 targeted format/lint/Web typecheck/build 的真实日志与 hash；未重跑全仓 gate。
- 本复核保留原 handoff 日志、回执及生成文件；独立结果放 `.cache/phase8a1-r1-closure/`，不覆盖原验收身份。

## R1-E1 / P2 — 搜索代理故障仍记录敏感 URL

定位：`apps/web/next.config.ts:18–23` 的通用 external rewrite 仍将 search 转发交给 Next proxy。`incomingRequests:false` 不控制 proxy 错误输出。安装版本 Next 的 `dist/server/lib/router-utils/proxy-request.js:80` 在 `onProxyError` 直接执行 `console.error`，消息包含完整 target URL。

**真实定向复现，非假设：**

1. 先确认专属上游45999无监听；仅本次 Web probe 启动在3544，并将其 FAMILY_ALBUM_API_ORIGIN 指向该未监听本机端口。
2. 请求合成 `/api/v1/families/4/search`，包含 fromDate、合成 albumId、favoritesOnly 和合成 cursor；不带Cookie，不连接现有API或DEV数据库，不读取媒体。
3. HTTP500。实际 stderr 含 `Failed to proxy` 和 `ECONNREFUSED`，同时含原样完整合成搜索 query/cursor。

证据 `.cache/phase8a1-r1-closure/proxy-error-log-probe.json`：`privateQueryLogged:true`、`proxyFailureLogPresent:true`、`errorCategoryPresent:true`；合成原始日志及可重跑 probe 同目录。本次仅声称 DEV 实际复现，不声称测试过Production。

影响：上游API重启/不可达等故障期间，仍会把私人搜索条件和cursor写入Web错误日志。保留错误本身是正确行为，但已批准合同要求保留安全错误字段，不能靠恢复正常访问路径来证明故障路径无query。现有HTTPS测试的400非法请求仍是API正常返回，不能代表转发连接失败。

**最小修复及唯一必要剩余校验：** 对搜索转发的故障提供可控的安全错误边界，保持既有API认证/转发语义与故障响应，日志只保留固定事件、错误类别等允许字段；避免完整target/query/cursor进入Next默认proxy错误消息。不要关闭所有错误、静默吞故障、修改node_modules，或仅过滤测试观察日志。补一次实际search上游连接失败回归：错误类别/事件仍可观察，query/cursor标记均不在Web stdout/stderr。修复后只复跑这一失败场景及现有单项HTTPS日志回归，再对R1-E1定点关闭，不需要全仓重审或新性能轮次。

## 清理及 checkpoint

- 独立HTTPS fresh owned tmp root已删除；3544 probe进程已停止，3443/4400/3544/45999最终均无监听；生成next-env与原handoff观察日志/回执已恢复。
- 独立只读DEV清理核对：MySQL9.7.2、non-root、8项migration、23业务表均0，见 `cleanup.json`。
- codex weekly读数74%，reset仍1791340206；没有确认重置或耗尽，没有使用重置卡/额外付费。17:38收尾，早于17:50目标及18:00硬停止。
- **8A1 checkpoint：IMPLEMENTED_REVIEW_NEEDS_FIX_R1_E1。** 当前唯一必要剩余工作是上述搜索代理故障日志修复与对应定点校验。PERF-E1/P3保持原非阻塞待办，不升级为本checkpoint阻塞。
- 此复核不宣称Phase8完成、不进入后续slice、不生产签核、不提交或推送。

```text
R1_NORMAL_ACCESS_LOGGING: CLOSED
R1_PROXY_ERROR_LOGGING: NEEDS_FIX_P2_R1_E1
R1_OVERALL_CLOSURE: NEEDS_FIX
PHASE_8A1_INDEPENDENT_REVIEW: NEEDS_FIX_R1_E1
NEW_P0_P1: 0
PERF_E1: NONBLOCKING_BACKLOG_UNCHANGED
IMPLEMENTATION_MODIFIED_BY_REVIEW: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
