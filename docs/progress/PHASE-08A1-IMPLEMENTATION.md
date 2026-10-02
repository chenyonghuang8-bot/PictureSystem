# Phase 8A1 — 搜索纵切实施与独立复核交接

2026-10-02 UTC。源码基线 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。范围依据：`PHASE-08A-SEARCH-DESIGN.md` 的 **8A1 APPROVED_FOR_SOL**。当前状态 **IMPLEMENTED_SCOPED_REVIEW_PASS**：`PHASE-08A1-R1-E1-CLOSURE.md` 已正式给出 PASS / R1整体CLOSED，无当前blocker。此文件与相关源码/测试/审查文档纳入用户授权的8A1本地checkpoint提交；不push。不是整个Phase8完成或Production签核。当前硬停止为用户延长后的 **2026-10-02 20:00 UTC / 北京时间10月3日04:00**；原18:00约束已覆盖。最新收尾记录见 `PHASE-08A1-CHECKPOINT.md`。

```text
ROUTING DECISION
Profile: PRO_STABLE
Risk: R3-IMPLEMENT
Current Model: unknown
Recommended Model: Sol Medium / Fast（用户指定）
Test Scope: targeted
Action: continue
Reason: 仅落实 Astra 已批准的 8A1 查询/合同/UI，未改变安全模型
```

## 1. 实现与不变量

- 新 `GET /api/v1/families/:familyId/search`，严格真实日历日期、单个 unsigned BIGINT 相册、仅字面 true 的个人收藏、十进制 limit 与有界 canonical cursor；未知/重复参数拒绝。沿用既有 timeline DTO，不返回 GPS、filename、receipt、成员或总数。
- 日期按既有 DATETIME(3) timeline 日历解释，包含 .000/.999；cursor scope 绑定 family、认证用户、规范条件和 limit，limit+1 精确判断下一页。scope 不是签名/权限凭据。
- Repository 继续 checked transaction → family lock → actor lock → server-time → assertActor；active media、live placement 与 owner/FAMILY/can_view 先过滤，再 GROUP BY/numeric keyset/LIMIT。单相册筛选约束同一已授权 placement；没有 ADMIN/SUPER_ADMIN CUSTOM bypass。旧 timeline/album 合同保留。
- 首页筛选、分页可见相册选项、清除/URL 恢复、账户与条件身份、请求 abort/generation、401 清空；收藏取消和 Trash 后刷新当前条件。桌面暖白/绿色三栏及窄屏保留，辅助栏用静态提示，防旧条件缩略图残留。
- 新搜索 route 在处理开始设置 private/no-store，并在精确 search 路径的 onSend 再设置。真实服务的旧 Phase1C family-wide hook 原会覆盖成 no-store，新增回归包含此 hook。没有改旧 hook 或其他 endpoint 的合同。
- 新筛选让移动照片进入底部导航区域，真实回归发现照片 z-index=1 遮住同层导航；导航调为2，Viewer调为3，Trash dialog仍100。真实命中测试验证导航可点、Viewer覆盖导航，未用 force click 绕过。
- 没有修改 0007/schema、K、锁序、Auth、native/storage、既有 root、生产、真实媒体或系统配置。Web AGENTS.md/CLAUDE.md 与已审启动器保留，排除本 slice；生成 next-env 无持久改动。

## 2. Fresh targeted 验收

最终日志位于 ignored `.cache/phase8a1/`；初轮失败日志另保留，不作为最终 PASS。最终结果、退出码、hash、清理检查集中在 `final-evidence.json` / `checkpoint-manifest.json`。

| 验证                                                          | Fresh 结果                     | 证据                                                    |
| ------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| contracts/API/service/旧 timeline/Web helpers/旧 gallery unit | 8 files / 81 tests PASS，skip0 | unit-final.log                                          |
| Browser 合成状态矩阵                                          | 1 file / 8 tests PASS，skip0   | ui-final.log                                            |
| DEV MySQL search + 旧 timeline/gallery                        | 3 files / 17 tests PASS，skip0 | integration-final.log                                   |
| 真实 HTTPS 搜索及直接 desktop/mobile/Viewer Trash 回归        | 4 tests PASS，retries0，skip0  | https-regression-final.log                              |
| Format / lint / workspace typecheck                           | PASS                           | format-final.log / lint-final.log / typecheck-final.log |
| contracts、DB、API、Web build                                 | PASS                           | build-final.log                                         |

合计本 targeted 集：Vitest 12 files / 106 tests，Playwright4，共110测试；不同重跑不叠加计数。没有执行或宣称 Phase8 milestone full gate。

覆盖：八种 AND 组合、单边与闰日毫秒边界、capture-local/upload fallback、角色/grant/撤权/跨家庭、hidden placement推断、trashed/purge intent/orphan、当前成员收藏、同毫秒keyset/移除边界行、session撤销等待family锁后的重验、可见空相册与真实53候选分页、严格参数/cursor/DTO/no-store/安全数据库错误；浏览器 apply/clear/history、迟到成功/失败/finally、旧actor loadMore、401、收藏取消/Trash当前条件刷新、UTC与纽约DST日期一致。HTTPS包含真实cookie请求、SSR刷新、下一页、Viewer、隐藏相册空页、401/404头部及 query/cursor 未进入 owned API 日志。

BIGINT 验证边界：真实 repository 分页使用普通自增合成ID；超JS安全整数及最大unsigned ID分别经过 contract/service/cursor精确字符串测试、真实MySQL只读CTE numeric keyset/codec probe及真实search参数保留检查。**没有向共享DEV表插入超大自增ID**，避免无关 AUTO_INCREMENT 副作用；不把CTE冒充实际media表上的超大ID端到端fixture。独立复核请明确评估该组合证据是否充分。

## 3. 有界性能证据

`explain-results.json`：本任务专属 10000 合成media、5家庭成员、可见/隐藏/重复placement、稀疏/密集个人收藏，八组合首/深页共16组；保存实际 production query builder SQL形状、参数类别、普通EXPLAIN与EXPLAIN ANALYZE operator actual rows/loops、返回行数、事务调用耗时。不会将optimizer估算当actual rows_examined；未获取session-wide rows_examined计数。

本次单轮旧timeline约17.6ms，搜索最大约24.6ms，返回最多25（limit24的lookahead）。有临时聚合/排序，但无N+1、跨family无限放大或测试超时；未增加索引、全文搜索或基础服务。10秒是测试请求预算，**不是已经测定的生产SLA/driver deadline**。没有长期压力测试或生产锁饥饿证明。

## 4. 失败修复、清理与复核入口

- 初轮fixture枚举/撤销字段配对、MySQL不支持MD5已修正；这些是测试数据错误。
- 初次浏览器detail多带albumId、favorite路径/DTO错误已修正；严格production DTO未弱化。
- 初次真实HTTPS加载旧DB dist导致503；fresh build后重跑。随后发现真实family hook覆盖cache header，落实精确search onSend修复，保留包含旧hook的回归。
- 移动端真实遮挡修复见上；final结果来自修复后源码，不借旧日志或Phase7 PASS。
- DEV readiness为MySQL9.7.2、non-root、8项migration（0000–0007）；23业务表最终0。owned HTTPS临时root在global teardown删除，回执确认不存在；本任务服务端口结束后无监听。没有枚举其他tmp文件或访问其他媒体。

独立复核输入：设计批准文档、本文件、真实未提交diff与新增文件、checkpoint-manifest、final-evidence、SQL/actual plans。集中检查严格合同/DTO、ACL与active media过滤位置、日期/keyset/scope、全配置响应头/日志、客户端陈旧响应/actor/filter身份、回归与清理证据。测试通过不等于安全签核；存在新权限/schema/locking/Auth需求立即返回Astra设计。

8A2 filename/member/tag及来源披露、地图/GPS、生产验证未实施；现有root维护仍未完成；不自动进入8A2/8B/Phase9。Phase7固定SHA已由独立发布任务推送并由协调方确认，当前origin/main同SHA；本任务没有push，不能声称无CI记录为CI PASS。

```text
PHASE_8A1_IMPLEMENTATION: COMPLETE
PHASE_8A1_TARGETED_VALIDATION: PASS
PHASE_8A1_INDEPENDENT_REVIEW: PASS_SCOPED_R1_OVERALL_CLOSED
PHASE_8A1_COMMIT: USER_AUTHORIZED_LOCAL_CHECKPOINT
PHASE_8A1_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```

## 5. 独立复核后 R1 最小修复（17:26 UTC 起）

详见 `PHASE-08A1-INDEPENDENT-REVIEW.md` / `PHASE-08A1-R1-FIX-HANDOFF.md`。Next配置新增 `logging: { incomingRequests: false }`，仅关闭DEV原始访问URL日志，保留错误/警告/构建日志。HTTPS测试观察器原样捕获并转发真实Next stdout/stderr，仅在已校验ownership的专属临时目录以wx/0600写入。真实SSR/刷新与BFF搜索分页、无效参数回归确认所有敏感query/cursor不存在，启动与stderr警告确实存在。R1证据单独位于 `.cache/phase8a1-r1/`，不把这一次复跑加到原110功能测试总数。

原复核性能PERF-E1/P3为非阻塞待办：日期deep范围与cursor互斥导致Zero rows shortcut，不把它宣称有命中深页证据。本次不扩展性能fixture/索引或重跑全门禁。原复核文件保持不修改，R1 closure结论由原reviewer给出。

## 6. R1-E1失败路径后续

`PHASE-08A1-R1-CLOSURE.md` 判定正常日志已关闭但external proxy连接失败仍泄露。限定修复/实际故障回归与证据完整性说明见 `PHASE-08A1-R1-E1-FIX-HANDOFF.md`；整体closure仍待原reviewer，不以本地测试代签。

## 7. 正式closure与当前状态

18:08独立复核结束，R1-E1 PASS/CLOSED，R1整体CLOSED，无当前范围blocker；原 NEEDS_FIX 报告及历史handoff保留当时记录。用户随后授权限定8A1本地提交、不push。收尾前22个受审源码/测试文件hash逐一匹配，未改变功能；当前计划/实施状态同步为限定复核PASS。PERF-E1/P3继续非阻塞待办，日期deep互斥fixture不是有命中深页性能证据。8A2产品待确认与地图未实施。
