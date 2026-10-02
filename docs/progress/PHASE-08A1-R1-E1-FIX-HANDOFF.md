# Phase 8A1 — R1-E1 代理失败日志最小修复交接

2026-10-02 UTC，17:40起；HEAD `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。只落实 `PHASE-08A1-R1-CLOSURE.md` 的 R1-E1/P2；状态 **IMPLEMENTED_PENDING_INDEPENDENT_CLOSURE**。不是R1整体CLOSED、Phase8完成或生产签核；未commit/push。Fast Medium；模型ID unknown。

## 变化与范围

- 新增精确 `apps/web/app/api/v1/families/[familyId]/search/route.ts` GET转发边界；无业务授权逻辑，strict query/认证/可见性仍由原API执行。参数路径编码、原始query（包括重复参数）保留；Cookie与Authorization同时转发，不消除混用，API继续拒绝。也转发Origin/Content-Type/Accept；不接受客户端提供上游地址。
- 沿用配置API origin（http/https，固定search路径），no-store、manual redirect、客户端abort与30秒代理超时。API返回状态/content-type/body保留；Cache-Control固定private,no-store。网络失败仍500 Internal Server Error，日志只为固定 `family_search_proxy_failed` event和白名单类别（ECONNREFUSED/TIMEOUT/REQUEST_ABORTED/UPSTREAM_FAILURE）；不输出URL/query/cursor、异常message/stack或credentials，不全局吞其他错误。
- Next array rewrite先于dynamic route，初次实际故障探针证明仍被原external proxy截获（NOT PASS，保存probe-initial.log）。据安装版本rewrites文档，将**原通用API转发放到fallback**，让确切search handler先匹配；其他API仍原destination，真实登录/Viewer/收藏等回归经过它。没有新服务、端口部署、node_modules改动或全局console过滤。
- R1 incomingRequests关闭与原样stdout/stderr观察器保留，所有owned root/nonce/certificate守卫保留。新真实正常日志回归输出到独立R1-E1目录。

## Fresh验证（仅定向）

`.cache/phase8a1-r1-e1/`：

- `probe-run.log` / `proxy-error-log-probe.json` / `proxy-error-log-probe.log`：专属Web3544→无监听45999，真实HTTP500，安全event与ECONNREFUSED仍可观察，fromDate/albumId/favoritesOnly/cursor与合成标记均不在日志；非mock。
- `https-final.log`：现有真实HTTPS8A1纵切1 PASS、skip0/retries0；验证Cookie登录、BFF严格参数/正常响应、分页、SSR刷新、Viewer、隐藏相册/401/404与实际日志。不是新增累计功能数。
- `forwarding-test.log`：专属真实本地HTTP上游3 PASS，核对Cookie/Bearer混用同时传入、Bearer与无凭据转发、重复query保留、上游200/400/401及JSON/no-store保留；此上游是合成观察fixture，不冒充真实API授权测试。
- `lint.log` / `format.log` / `typecheck.log` / `build.log`：对应限定文件lint/format与Web类型/构建结果。构建路由表实际列出确切search handler。
- `cleanup.json` / `cleanup-checks.json` / `checkpoint-manifest.json` / `final-evidence.json`：当前执行/源码hash与DEV及owned root/端口/生成文件清理。未重复全门禁或性能fixture。

证据边界：第一次E1正常HTTPS复跑沿用了R1测试硬编码输出，覆盖了旧 `.cache/phase8a1-r1/web-log-regression.json` 和 `web-observation.log` 两份观察文件；这些新观察已复制到E1目录，原R1 manifest对这两文件不再匹配，**不能继续声称原R1 artifacts全部unchanged**。原R1 closure已独立验证当时证据，报告与closure目录独立证据保留；旧8A1原https-run恢复。最终测试已把输出改为E1目录，避免重复覆盖。这里不重造丢失的原始日志或修改旧hash掩盖差异。

## 恢复/复核入口与停止

原reviewer只定点检查精确handler与fallback precedence、凭据/query/status语义、白名单故障事件和实际失败/正常日志，给出R1-E1 closure；未closure前保持NEEDS_REVIEW，不自行整体PASS。若需额外改变权限/部署结构，停止并报告设计缺口，不仓促扩大。PERF-E1非阻塞待办保持不变。

17:50开始收尾，18:00硬停止；未运行的全门禁/Production/长期代理压力测试明确NOT_RUN。本轮不重置额度、不付费，不进入8A2/地图/下一阶段。

```text
R1_E1_IMPLEMENTATION: DONE
R1_E1_TARGETED_TESTS: RECORDED_IN_FINAL_EVIDENCE
R1_OVERALL_INDEPENDENT_CLOSURE: PENDING
MILESTONE_FULL_GATE: NOT_RUN
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
