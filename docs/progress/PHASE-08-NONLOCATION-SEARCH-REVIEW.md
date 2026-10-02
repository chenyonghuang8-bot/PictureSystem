# Phase 8 非地点搜索完整批次 — 独立限定复核

2026-10-02 UTC；基线 `ac39e49f9d7cdc8a8cbe7052deebd2d1958c2823`。本轮按用户授权集中复核整批非地点搜索，结束早于延长后的 20:00 UTC 硬停止。

**结论：NEEDS_FIX。发现 1 项当前范围 P2：搜索分页收到旧版本/不匹配游标的 400 后，客户端没有按批准合同重启当前条件首屏，重复加载继续发送同一游标。未发现新的 P0/P1。** 其余被检查的新增匹配、选项可见集、日志隐私、正常分页与 UI/API 行为符合本批次批准边界。本结论不是整个 Phase8 完成或生产安全签核。

## 1. 范围和证据完整性

读取 AGENTS、PHASE-08-NONLOCATION-SEARCH-BATCH、PHASE-08A-SEARCH-DESIGN 的产品确认补充、产品问题记录、当前真实 diff、新增 source/test 文件，以及 final-evidence/checkpoint-manifest 和原始日志/EXPLAIN。仅复核已批准的时间、单相册、个人收藏，加 canonical 首次上传 filename/creator、单 tag 与两类 options；没有扩大到地图、GPS、多 tag、Auth/权限/事务重新设计。

开始与收尾均独立核对 checkpoint：22 个 source/test/doc、2 个排除保留的局部指令文件和 17 个原证据哈希全部匹配。HEAD 未改变。独立重跑会输出到原证据位置的 EXPLAIN、HTTPS 回执/日志已按字节恢复，next-env 也恢复。实现未修改；仅增加本复核文档及 ignored `.cache/phase8-search-review/` 证据。未 commit/push。

## 2. 必须关闭的当前范围问题

### NLS-R1 / P2 — 拒绝旧游标后没有重启当前条件首屏

- 定位：`apps/web/lib/gallery-client.ts:24` 将 400 统一转换成 UNAVAILABLE；`apps/web/components/gallery/timeline.tsx:86` 的 loadMore catch 只对 401 清理状态，其余错误保留 items/cursor/Viewer 并标记失败。`apps/web/components/gallery/search-gallery.tsx:169` 已提供当前条件的 onRefresh，但此错误路径未调用。
- 合同：设计 §4 明确“scope 不匹配400，客户端重启首屏，不隐式混页”；§6 要求新增 filter 后旧 cursor 拒绝重启。本批次将媒体 cursor 从 version1 升级到 version2，批次报告还明确写了“旧version1返回400并重启分页”。API 的 version2 严格校验正确，缺失的是客户端恢复行为。
- 独立复现：用现有 SearchGallery/Timeline 生产组件，加载仅含合成照片的既有 UI fixture；初始 cursor 为 canonical base64url version1，scope 使用原 `family-search-v1` 的真实算法及 fixture 的 family/user/filter/limit24 计算。浏览器拦截仅提供合成 API 响应：有 cursor 返回 400 INVALID_REQUEST，无 cursor 可返回正常首屏。连续点击两次“加载更多”，得到 2 次旧 v1 cursor 请求、0 次无 cursor 首屏请求；旧照片和加载按钮仍保留。证据 `cursor-recovery-probe.mjs/json`：`oldCursorVersion:1`、`firstPageRestartObserved:false`、`searchRequestCount:2`、`oldRowsRetained:1`。API 拒绝 v1 的规则另由当前契约/service 测试及实现核实；该定向 UI 探针使用合成响应，未将它冒充真实 HTTPS 旧游标测试。
- 影响：本批次明确存在 v1→v2 的游标失效场景，例如保留旧分页状态的页面。客户端只显示暂不可用，重复加载不能恢复；手工重新应用条件或刷新页面才恢复。当前没有证据表明越权或混入新条件页面，因此定为 P2 功能/合同缺陷。
- 最小修复：为无效请求/游标提供可区分的客户端错误，在**搜索分页**的对应 400 路径清空旧页、cursor 和 Viewer，并调用已有当前 filters 的首屏 refresh。维持 401 清理和普通网络失败重试；不得退回无条件 timeline，不得重发旧 cursor，不需要修改权限、schema、lock 或 cursor 安全模型。
- 最小回归：使用当前过滤条件和已加载页/打开的 Viewer，模拟旧 v1 或 scope 不匹配的分页 400；断言旧页面和 Viewer 被清理、仅请求当前条件的无 cursor 首屏、重新得到合法 cursor 后可继续分页、不会形成 400 重试循环。再保留现有 401/迟到响应用例。完成后只需相关客户端/浏览器 targeted tests 和 NLS-R1 定点关闭确认。

## 3. 已核实的其余行为

- 首次 canonical source JOIN 同 family；filename 和 creator 都由 media.source_upload_id 指向的持久化来源计算。duplicate receipt 的文件名/上传人不会改变搜索归属或扩大可见集；历史 disabled creator 可作为归属，当前访问者仍必须有效。用户明确确认了该来源披露语义，本轮不重新提出产品分歧。
- filename trim、Unicode 字符/UTF-8 预算、控制字符拒绝；无 NFKC/case/accent 折叠。固定 utf8mb4_0900_bin LIKE 和参数绑定，`!`/`%`/`_` 按文字转义。真实 DEV 测试覆盖 literal、大小写与重音。单 tag 使用同 family EXISTS，所有条件在 GROUP BY/order/limit 前 AND 组合。
- main 和 options 均沿用 checked transaction → family lock → actor lock → server time → assertActor。live placement/live album、owner/FAMILY/current grant、trash/purge 排除均在候选与分页之前；ADMIN/SUPER_ADMIN 不 bypass CUSTOM。单相册筛选同一个获授权 placement，个人收藏仍取当前 member。
- 两类 options 从不受本次筛选限制的当前可见集合 V 导出；排除隐藏、删除、未使用和跨 family 标签/来源。历史 creator 不因离开/禁用丢失；输出仅 id/name，不输出账号、邮件、receipt、GPS、总数或隐藏关联。numeric afterId 封装在绑定 kind/family/user/limit 的 strict canonical cursor，limit+1 与末页处理明确。当前 SQL 片段复用的 JOIN/WHERE/参数顺序经检查和真实 DB 定向测试一致，没有据其未来维护可能性提出额外 blocker。
- 主分页 scope 包含所有规范条件、family、认证 user 和 limit；版本升级/旧游标拒绝正确。BIGINT 字符串、同时间戳 id DESC、边界行删除、去重、组合过滤和精确末页均通过 targeted tests；NLS-R1 是异常恢复缺口，不否定正常分页证据。
- SearchControls 和 options 的 key/abort/alive/generation、清除/URL/popstate、分页选项及当前条件的取消收藏/Trash refresh 经浏览器和 HTTPS 检查。昵称边界额外探针验证 65 个 emoji/130 UTF-16 units 的现有用户数据仍能通过当前 options schema/API，未发现字段长度不兼容，不作为问题提出。
- 两条固定 search/search-options proxy 沿用受限目标、no-store、手动 redirect、超时和安全错误日志。fresh 真 HTTPS 捕获实际 Next stdout/stderr，SSR reload、代理分页和无效 query 均未出现敏感 query；另启专用未监听 upstream 的失败探针，两条路由均返回 500，只记录固定事件与 ECONNREFUSED，不记录 filename/uploader/tag/kind/cursor。此前 8A1 日志问题没有复发。

## 4. 独立验证结果

原报告的 111 + 23 + 1 = 135、skip0/retries0 与真实日志及哈希相符。format/lint/typecheck/API-Web build 的对应日志/哈希检查通过；本轮没有重新运行全仓门禁，也没有把日志核对写成 fresh 执行。

| 本轮 fresh 验证                                                                         | 结果                             | `.cache/phase8-search-review/` 证据                |
| --------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| contracts/API/service、旧 timeline/gallery、Web client/path、生产组件浏览器、proxy 转发 | 9 files / 112 PASS，skip0        | `unit.log`                                         |
| 真实 DEV search + timeline/gallery，包括 10k 合成 EXPLAIN                               | 3 files / 23 PASS，skip0         | `integration.log`、`integration-status.json`       |
| 非地点整批真实 HTTPS UI/API                                                             | 1 PASS，skip0/retries0           | `https.log`、`https-status.json`、`https-run.json` |
| 两条实际代理失败日志                                                                    | PASS：500/500，敏感 query 未记录 | `proxy-error-log-probe.json/log`                   |
| 旧 v1 cursor 客户端恢复                                                                 | NLS-R1 已复现                    | `cursor-recovery-probe.mjs/json`                   |

fresh 功能测试合计 136 PASS；112 与原 111 的差异来自本轮选取的测试文件集合，不是累计重跑或替代原报告计数。定向缺陷探针另列，不混入 PASS。初次昵称探针的 tsx 沙箱 IPC 启动受限，改用 node --import=tsx 后完成；没有静默跳过 DB 或浏览器测试。

fresh 10k 媒体、5 成员、30 组实际 EXPLAIN/ANALYZE 与查询：baseline 17.246ms，最大搜索 27.864ms；新增 filename/uploader/tag 的 14 组 first/deep 均有命中并返回 25 行，检查计划包含真实过滤、聚合/排序，未发现本规模超时或应用层 N+1。仍存在历史日期 deep fixture 的 Zero rows shortcut；既有 **PERF-E1/P3 非阻塞待办** 保留，不能据这几组证明有命中的日期深页压力。单轮耗时不是生产 deadline、长期并发 SLA 或生产部署验证；本轮不因此添加索引/基础服务或开启新审查轮次。

## 5. 清理、停止与 checkpoint

最后只读检查 MySQL9.7.2、non-root、8 项迁移，DEV 23 业务表全部0。fresh HTTPS 专属 root 已删除，3443/4400/3544/45999 均无监听；合成 Chrome profile/本轮专用进程已关闭。未修改 existing storage root/ACL，未读取真实媒体或个人文件。`review-evidence.json` 保存最终清理与原证据哈希核对。

最后额度读数 codex weekly used78%，reset时间戳仍1791340206，未确认发生更早重置/耗尽；没有使用重置卡或额外付费。本轮在 19:00 UTC 前收口，早于用户延长的20:00硬停止。

当前批次 checkpoint 为 `NONLOCATION_SEARCH_IMPLEMENTED_REVIEW_NEEDS_FIX_NLS_R1`。必要剩余条件仅为 NLS-R1 最小客户端修复、定向浏览器恢复回归和一次关闭确认；通过后可按用户指令处理该批次 checkpoint。8A1 已提交 checkpoint 不被改写；未自动 commit/push/tag，未进入地图/下一阶段。地图/GPS、后续 Phase8 slice、Production 验证仍不在本次交付内，不能标记整个 Phase8 COMPLETE/PRODUCTION_READY。

```text
NONLOCATION_SEARCH_INDEPENDENT_REVIEW: NEEDS_FIX
NEW_P0_P1: 0
CURRENT_SCOPE_REQUIRED_FIX: NLS_R1_P2_CURSOR_RESTART
NONBLOCKING_BACKLOG: PERF_E1_P3_DATE_DEEP_EVIDENCE
FRESH_FUNCTIONAL_TESTS: 136_PASS_SKIP0
IMPLEMENTATION_MODIFIED_BY_REVIEW: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
