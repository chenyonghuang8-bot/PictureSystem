# Phase 8A1 — 独立限定实现复核

2026-10-02 UTC；基线 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。复核截止检查时间 17:23 UTC，早于用户要求的 18:00 UTC 硬停止。

**结论：NEEDS_FIX。当前范围发现 1 个 P2：Web 开发服务器记录完整搜索筛选 URL，违反已批准的日志隐私合同。未发现 P0/P1；没有提出新的权限、Schema、事务或存储设计。** 本结论只针对未提交的 8A1 时间＋单相册＋个人收藏纵切，不是 Phase8 完成或生产安全签核。

## 1. 范围与复核方法

读取 AGENTS、PHASE-08-PLAN、PHASE-08A-SEARCH-DESIGN、PHASE-08A1-IMPLEMENTATION、final-evidence、checkpoint-manifest、真实 tracked diff 和新增实现/测试文件。检查批准合同、服务端可见集合与响应白名单、组合/keyset、执行计划以及实际 Web/API 行为。未扩展 8A2、地图、Auth 重审或 root 维护。

21 个 checkpoint 文件、2 个保留的局部指令文件、16 个原验收证据的 SHA-256 全部匹配；独立运行结束后再次核对，源码和原证据仍匹配。HEAD 未改变。未修改实现、Schema、现有 root 或真实媒体；未 commit/push。仅增加本复核文档和 ignored `.cache/phase8a1-review/` 合成验收证据。

## 2. 必须收口的当前范围问题

### R1 / P2 — Web 访问日志泄露搜索筛选 query

- 定位：`apps/web/components/gallery/search-gallery.tsx:126–128` 将规范筛选写入首页 URL；`apps/web/app/page.tsx:25–31` 支持该 URL 的 SSR 恢复。`apps/web/next.config.ts:6–23` 没有关闭/过滤 Next 的原始 URL 访问日志。
- 合同：PHASE-08A-SEARCH-DESIGN §3 要求日志不记录 query/cursor/原始 URL，并检查 API/BFF logger。现有 HTTPS 测试 `tests/e2e-web/authenticated-gallery.spec.ts:725–729` 只检查 API observation log，不能证明 Web 日志满足合同。
- 实际复现：在专属本机端口 3544 启动现有 Next dev，访问不带 Cookie 的合成首页 URL，包含有效 fromDate、合成 albumId、favoritesOnly。返回 200 fallback 后，Web stdout 包含原样的完整 query。证据 `.cache/phase8a1-review/next-dev-log-probe.json`：`privateQueryLogged: true`；原始合成日志保存在同目录。未读取账号或媒体。Next 当前安装版本的 `dist/server/dev/log-requests.js` 在默认配置下直接输出 `request.url`，与实际复现一致。
- 影响：搜索日期、相册 ID 和个人收藏条件在恢复/刷新页面时进入 Web 控制台或被部署日志收集。API 的 no-store 和字段白名单不能消除这一旁路。本次证明的是 DEV Web stdout 泄露，不声称已证明生产服务器同样记录。
- 最小修复：在现有 Web 配置中禁用这些原始 URL 访问日志（例如 `logging: { incomingRequests: false }`，或同等覆盖首页搜索和 search 代理请求的固定过滤）；保持已批准 URL 恢复行为。增加一次捕获实际 Web stdout/stderr 的合成回归，检查首屏/SSR 刷新及代理搜索的 query、cursor、无效参数标记均未进入日志。不要只检查 API log，也不要通过删除 URL 恢复功能绕过要求。
- 这是已批准隐私 guardrail 的落实问题，可按批准边界进行小修复；无需另起权限/Schema/存储设计。修复后仅复跑相关 Web 配置检查和日志回归，再做 R1 定点复核。

## 3. 已核实的实现行为

- 新搜索 strict schema 独立于旧 timeline；日期真实有效、1000–9999、单边/同日允许，末日 .999；favoritesOnly 仅字面 true；未知/重复键及非法 BIGINT/limit/cursor 拒绝。scope 包含认证 user、family、规范条件和 limit，canonical decode 校验明确；hash 不被当作授权凭据。
- Repository 沿用 checked transaction → family lock → actor lock → server time → assertActor。所有 JOIN 含 family 约束；activeMediaSql 排除 trash/purge intent，live album 的 owner/FAMILY/can_view 先过滤；ADMIN/SUPER_ADMIN 没有 CUSTOM bypass。单相册条件绑定同一个获授权的 placement，隐藏关联不能通过另一可见 placement 命中。个人收藏使用锁后当前 member，不接收 favorite owner。
- SQL 在 GROUP BY/order/limit 前组合 AND 条件；媒体去重、jump album 数值 MIN、timeline/id DESC keyset、limit+1 与精确末页符合合同。传参没有 Number 转换 ID 或请求控制的 SQL 片段。DTO 没有 GPS、filename、receipt、成员、总数或所有关联相册。
- 服务端真实隐藏相册空页、非自身 family 404、401/400 private no-store 已复跑。API logger 禁用自动 request logging，搜索失败日志字段白名单；API observation log 的 query/cursor 检查通过，R1 是另一个 Web 日志面。
- Web 的 filter/actor key、abort/generation、切条件清空旧页、历史恢复、当前条件下取消收藏/Trash 刷新、Viewer 独立授权和窄屏导航行为经代码及浏览器/HTTPS验收检查。正常空结果可清除条件。无条件搜索保留旧 timeline 的媒体顺序及白名单。
- BIGINT 证据组合可接受本 slice：真实 DB 查询保留字符串参数并在 BIGINT 上比较/排序、真实 CTE probe、contract/service/cursor 超安全整数验证。没有将 CTE 冒充实际超大自增媒体 fixture，也没有为验证而改共享 DEV AUTO_INCREMENT。

## 4. 独立执行和原报告证据

原报告 110 = Vitest 81+8+17，加 Playwright4。检查了对应真实日志、artifact hash、源码 checkpoint；format/lint/typecheck/build 的对应日志与 hash 匹配。没有重复执行全仓 format/lint/build，也不将这些写成本复核新跑的门禁。

本复核 fresh 结果：

| 范围                                                                      | 结果                                          | 独立证据                          |
| ------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------- |
| strict contracts、API/service、旧 timeline/gallery、Web URL/client/server | 8 files / 82 PASS，skip0                      | `.cache/phase8a1-review/unit.log` |
| 合成浏览器状态矩阵                                                        | 1 file / 8 PASS，skip0                        | `browser.log`                     |
| DEV MySQL search + timeline/gallery                                       | 3 files / 16 PASS；1 个性能用例显式按名称排除 | `integration.log`                 |
| 真实 HTTPS 搜索和窄屏直接回归                                             | 2 PASS，skip0，retries0                       | `https.log`、`https-status.json`  |
| 实际 Web 日志定向探针                                                     | 完整合成 query 被记录，R1 已复现              | `next-dev-log-probe.json`         |

Fresh 功能测试共 108 PASS，不重复累计初轮或重跑。首次普通沙箱 Chrome 启动失败，8 个浏览器用例未执行；经本次授权范围所需的自动审批执行后，独立浏览器8项和HTTPS2项全部通过。失败初轮保留在 `unit-browser.log`，不计入 PASS。DEV 的 1 个 skip 是主动排除会覆盖原 EXPLAIN 证据的性能用例，不是缺少 `.env` 或数据库访问导致的静默跳过，不能把该次 integration 报成 skip0。

## 5. 性能证据与非阻塞待办

实际检查 `explain-results.json` 的16组普通/ANALYZE tree 和生成它的测试代码；使用 production query builder。10000 个新增合成媒体加4个功能fixture；5个成员、可见/隐藏/重复 placement、当前成员及另一成员收藏均由真实SQL生成并验证数量。旧 timeline 单轮 17.579ms；搜索最大 24.606ms。无条件实际处理7503条 placement；单相册计划扫描10004个本 family media、聚合5002行；相册+收藏计划从500条当前 member favorite 驱动。存在临时聚合/排序，未发现该规模的超时或应用层 N+1；没有增加索引或服务。

**非阻塞 P3 / PERF-E1：** 四个带日期的 deep case 将2022-01-01范围与2021-06-01 cursor组合，逻辑互斥，ANALYZE 均为 Zero rows shortcut；不能将这四组当作有命中的日期深页性能证明。日期+收藏的窄首屏也为空。现有功能矩阵与SQL检查没有发现因此产生的实现缺陷；以后更新性能fixture时，让日期范围含多页且cursor位于范围内即可，不为此无限续审或新增索引。

10秒是测试预算，不是已验证的生产 driver deadline/SLA；单轮耗时和 ANALYZE operator rows/loops 不是长期锁饥饿或 session-wide rows_examined 证明。本复核没有重造10000数据或宣称新的压力测试 PASS。

## 6. 清理、停止和 checkpoint

- 最后独立只读 DEV 检查：MySQL9.7.2、non-root、8项migration（0000–0007），23业务表全部0，见 `cleanup.json`。
- 原 HTTPS root 与本复核 HTTPS root均不存在；3443、4400、3544最终无监听。专属3544探针进程已停止。Chrome只使用本次新建临时 profile；没有访问用户浏览器 profile/个人文件。复跑生成的 next-env 和原 https-run 回执均已恢复。
- 额度读数为 codex weekly used73%、reset时间戳仍1791340206；没有确认发生重置、没有耗尽，也没有使用重置卡/额外付费。结束早于18:00 UTC。
- 当前 checkpoint：`8A1_IMPLEMENTED_REVIEW_NEEDS_FIX_R1`。剩余必要条件只为 R1 最小修复、实际Web日志回归与定点关闭确认；不要重跑Phase7全仓审查或把非阻塞性能补充升级为无限轮次。
- 不创建提交、push或tag。8A2 的产品确认、地图/GPS批准、Production验证和后续slice仍未交付；本结果不能标记整个Phase8 COMPLETE或PRODUCTION_READY。

```text
PHASE_8A1_INDEPENDENT_REVIEW: NEEDS_FIX
NEW_P0_P1: 0
CURRENT_SCOPE_REQUIRED_FIX: R1_P2_WEB_QUERY_LOGGING
NONBLOCKING_BACKLOG: PERF_E1_P3_DATE_DEEP_EVIDENCE
IMPLEMENTATION_MODIFIED_BY_REVIEW: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
