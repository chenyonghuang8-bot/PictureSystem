# Phase 8A1 — R1-E1 独立关闭复核

2026-10-02 UTC；基线 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`，18:08完成最终运行核对。用户已将硬停止延长为20:00 UTC，覆盖原18:00限制；未使用重置卡或额外付费。

**结论：PASS / R1-E1 CLOSED，R1整体CLOSED。8A1限定实现复核的必要条件已满足，无剩余当前范围 blocker。** 此结论关闭 `PHASE-08A1-R1-CLOSURE.md` 的搜索代理失败日志问题，并结合此前正常访问日志关闭结果；历史 NEEDS_FIX 报告保留，不改写当时证据。本结论不是整个Phase8完成、生产安全签核或提交授权。

## 检查范围及真实实现

仅检查 R1-E1 handoff、当前 final-evidence/checkpoint、真实 diff、新 search Route Handler/转发测试、rewrite precedence、错误日志及直接HTTPS回归。没有重审Auth、存储、性能、8A2或地图。

- 精确 `apps/web/app/api/v1/families/[familyId]/search/route.ts` 使用固定配置origin和固定search路径，familyId编码，不接受客户端上游地址。原query保留重复键；Cookie/Authorization均转发，不替API消除混用。Origin/Content-Type/Accept沿用，业务认证和strict query仍由原API执行。
- GET转发使用no-store、manual redirect、客户端abort和有界代理超时；当前API搜索的正常/错误状态、content-type和body保持，Cache-Control固定private,no-store。故障仍返回HTTP500，catch只记录固定事件 `family_search_proxy_failed` 与白名单类别，不输出异常message/stack、地址、query/cursor或凭据，没有全局console过滤或吞掉其他错误。
- `apps/web/next.config.ts` 将原通用external rewrite放入fallback，确切handler先匹配。独立真实失败探针证明请求已由新handler处理，未进入此前打印target URL的Next external proxy失败分支。既有Cookie登录、Viewer、收藏等路径在HTTPS回归中仍经原fallback转发。
- 原 `incomingRequests:false` 保留；stdout/stderr观察器未改变，观察输出原样保留。实际启动信息、stderr warning和安全故障事件均可观察。现有root/certificate/nonce守卫没有修改。
- 与批准合同、前次受审源码比较，API/DB/权限/Schema/锁序/存储实现未变；未发现当前限定范围新的P0/P1或必须修复项。

## 独立 fresh 验证

证据目录 `.cache/phase8a1-r1-e1-closure/`：

| 验证                                                                                 | 结果                                                                                                  | 证据                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 真实连接失败：专属Web3544 → 已确认无监听的本机45999，合成search条件/cursor，无Cookie | HTTP500；安全event及ECONNREFUSED存在；query/cursor标记均不存在                                        | `proxy-error-log-probe.json`、对应实际stdout/stderr日志       |
| 专属真实本地HTTP合成上游转发                                                         | 3 PASS，skip0；Cookie/Bearer混用、Bearer/无凭据、重复query、200/400/401及JSON/no-store保持            | `forwarding.log`                                              |
| 更新后真实HTTPS8A1纵切                                                               | 1 PASS，skip0，retries0；SSR恢复、分页/cursor、无效query、登录/Viewer/收藏、隐藏相册及401/404直接回归 | `https.log`、`web-log-regression.json`、`web-observation.log` |
| 真实Web日志保留可观察性                                                              | Ready、self-signed stderr warning确实存在；受测query/cursor标记不在日志                               | 独立观察日志及HTTPS断言                                       |
| 最后DEV只读清理核对                                                                  | MySQL9.7.2、non-root、8项migration、23业务表全0                                                       | `cleanup.json`                                                |

这是独立复跑的4个测试加一次真实失败探针，不叠加到原110计数。没有运行milestone full gate、Production或长期代理压力测试；这些不作为本次定点关闭的必要条件。

当前R1-E1的27个源码/文档文件、2个保留局部指令文件、16个artifact hash均匹配；独立运行后再次核对，当前源码和handoff证据未变。已有定向format/lint/Web typecheck/build日志与hash已核实，build路由表包含确切search handler；没有重复全仓门禁。

## 历史证据边界及清理

- 已确认旧 `.cache/phase8a1-r1/` 只有 `web-observation.log`、`web-log-regression.json` 与旧manifest不匹配，符合实施方披露；它们不作为仍可核验的旧原始证据。没有重造丢失日志或修改旧hash。此前独立closure目录及本次fresh证据保留。
- 本次复跑保存并恢复当前R1-E1观察文件、旧8A1 https-run回执及生成next-env，独立结果存入新closure目录，未再次覆盖交接证据身份。
- 本次owned HTTPS root已不存在；3544失败探针进程已停止；3443/4400/3544/45999最终均无监听。没有读取真实媒体、操作现有storage root、改ACL或个人文件。
- 额度读数codex weekly used75%，reset仍1791340206，没有确认重置或耗尽。完成早于新20:00 UTC硬停止。

## 8A1 checkpoint

**8A1_IMPLEMENTED_SCOPED_REVIEW_PASS。** R1普通访问日志与R1-E1代理错误日志均关闭；无剩余阻塞校验。协调方可更新当前交接状态并保存此源码/证据快照；不用为此重跑Phase7/全仓门禁。PERF-E1/P3日期深页命中证据继续作为原非阻塞待办，不扩审。

8A2重要产品选择、地图/GPS批准与后续slice、完整Phase8门禁、Production验证仍未交付。不自动进入下一slice，不commit/push/tag。

```text
R1_E1_INDEPENDENT_CLOSURE: PASS_CLOSED
R1_OVERALL: CLOSED
PHASE_8A1_INDEPENDENT_REVIEW: PASS_SCOPED
PHASE_8A1_CHECKPOINT: IMPLEMENTED_SCOPED_REVIEW_PASS
CURRENT_SCOPE_BLOCKERS: 0
NEW_P0_P1: 0
PERF_E1: NONBLOCKING_BACKLOG_UNCHANGED
IMPLEMENTATION_MODIFIED_BY_REVIEW: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
