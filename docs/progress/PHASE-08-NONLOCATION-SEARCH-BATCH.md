# Phase 8 — 非地点搜索完整批次实施与独立复核交接

2026-10-02 UTC。基线 `ac39e49f9d7cdc8a8cbe7052deebd2d1958c2823`（8A1本地checkpoint，未push）。用户18:25对集中呈现的全部推荐明确回复“是的”，授权一次完成文件名＋首次上传成员＋单Tag，与已实现时间/单相册/个人收藏组合。当前 **IMPLEMENTED_TARGETED_VALIDATION_PASS / NONLOCATION_REVIEW_PASS_NLS_R1_CLOSED**。本轮不commit/push，不以实现方测试代签独立closure，不宣称Phase8整体完成或Production ready。

## 授权与实现

首次canonical来源匹配及其披露已获明确接受；重复receipt不改变文件名/成员归属，停用/离开的历史来源仍可匹配。filename trim后字面包含、大小写/重音敏感、无NFKC，%/_/!普通字符；最多255 Unicode code points/1024 UTF-8 bytes，拒绝control/unpaired surrogate。首版单tagId。来自既有 `source_upload_id → upload_sessions`，无新列或migration。

- Contracts/API/DB：strict filename/uploaderMemberId/tagId，所有条件AND；canonical source JOIN含family约束；固定 utf8mb4_0900_bin literal LIKE及ESCAPE，参数绑定；tag同family EXISTS。现有timeline DTO不追加filename、来源receipt、GPS、counts。media cursor升级version2，绑定全部规范条件、family/user/limit；旧version1返回400并重启分页。
- 新 `GET /api/v1/families/:familyId/search/options`：strict kind=tag/uploader、limit1–50、canonical cursor；numeric afterId封装在cursor里并绑定kind/family/user/limit，不另收裸afterId。按数值ID分页+lookahead，只返回id/name与nextCursor。候选来自**未加用户filters的当前可见集合V**，不从全家成员列表或隐藏媒体产生；同名不同ID保留，uploader只displayName（空值为“家庭成员”），无username/email/count。
- Repository完全继承 checked transaction → family lock → actor lock → server-time → assertActor；V先做active media/live placement/owner或FAMILY或can_view，再filter/group/order/LIMIT。options复用同一实际search builder的FROM/WHERE，移除媒体LIMIT后添加固定候选JOIN及ID keyset；该SQL片段复用方式需要独立review重点检查。无角色bypass、权限/锁序/事务/Auth改动。
- Web统一入口追加“首次上传文件名/首次上传成员/标签”；空值删query、规范URL/history/刷新恢复，候选分页/显式重试，401清空；现有账户/filter身份、abort/generation、Viewer取消收藏/Trash刷新保留。暖白/绿色三栏与390px窄屏。
- exact GET BFF的已审安全转发逻辑抽为 `apps/web/lib/search-proxy.ts`，原search和新options两个固定resource wrapper复用。固定upstream origin/path、原样query与Cookie/Bearer混用传至API；private/no-store、manual redirect、30s/abort。失败只固定event/errorCategory，不打印原始URL/cause/stack。既有Next incomingRequests关闭与启动器原样日志观察保留。

未改0007/schema/K/native/storage/root、原始媒体、生产或系统配置。AGENTS/CLAUDE无关文件保留且排除范围；Next生成next-env恢复基线。

## Fresh targeted结果

Ignored证据专目录 `.cache/phase8-search-batch/`。结果不是40/41或旧build沿用；下列均为本批最终源码的fresh验证。初轮/中间失败日志保留，重跑次数不叠加总数。

| 项目                                                                        | 最终结果                                          | 证据                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| contracts/API/service/旧timeline/Web helpers/proxy/旧gallery/client/browser | 9 files，111 tests PASS，skip0；browser11项       | unit-final-fourth.log                                               |
| DEV MySQL search＋旧timeline/gallery                                        | 3 files，23 tests PASS，skip0                     | integration-final.log                                               |
| 真实HTTPS完整搜索批次                                                       | 1 test PASS，retries0，skip0                      | https-final-second.log、https-run.json                              |
| 两条exact代理连接失败实测                                                   | 两次500，固定ECONNREFUSED日志，无私有query/cursor | proxy-error-log-probe.json、proxy-error-log-probe.log               |
| format / targeted lint / contracts+DB+API+Web typecheck                     | PASS                                              | format-final.log、lint-final-second.log、typecheck-final-second.log |
| contracts/DB/API与Web build                                                 | PASS                                              | build-api-final.log、build-web-final.log                            |
| DEV readiness / DB清理 / owned root与端口清理 / diff check                  | PASS                                              | cleanup.json、final-evidence.json                                   |

最终功能集合共 **135 tests**（111+23+1），代理故障探针另列，不叠加重复运行。未跑或宣称Phase8 milestone full gate、全仓安全终审、native rebuild（native未改）。

覆盖新增条件八组合及六维AND、literal特殊字符/组合Unicode/大小写重音/注入串、canonical与不同名不同作者重复receipt区别、hidden/missing/cross-family source/tag统一空页、历史disabled来源与同名ID、52个可见Tag分页且不受当前filter影响、hidden/deleted/unused/foreign候选排除、trash与无placement收缩候选、options等待family锁后session撤销重验、options cursor kind/limit/family/user隔离、strict/no-store/DTO/400/401/404/503、options重试及401清空、原浏览器迟到响应/账户/Viewer/URL回归。

HTTPS实际Secure cookie、首/下一页、六维组合、选项、大小写/重音/字面miss、窄屏SSR刷新、Viewer取消收藏、hidden相册空页与跨家庭404、main/options401。真实API与Next日志在新filter交通后检查query/cursor缺席；Next startup与stderr warning确实捕获，未静默日志观察器。owned Next日志有若干固定UPSTREAM_FAILURE事件（页面中止/刷新流量），没有原始异常或查询；不将这些记录伪装成全部请求无失败。

## 性能与验证限度

现有production query builder，1万合成media/5成员；30组首/深页SQL与EXPLAIN/EXPLAIN ANALYZE保存于 explain-results.json。新增7种filename/uploader/tag组合×首/深页共14组，全部返回25条且深页在实际日期范围内。最终同轮旧timeline约17.18ms、搜索最大28.93ms；首轮较冷结果约281.80/663.72ms，日志保留，最终证据记录此次测量值，不把一次DEV耗时当生产SLA。无N+1或索引/基础服务变更；10秒为测试预算而非生产deadline。

原8A1 PERF-E1/P3日期deep与cursor互斥的fixture仍是历史非阻塞待办；新14组有命中证据不冒充修复旧16组中的zero-row shortcut。超JS安全BIGINT沿用contract/service/只读numeric probe证据，不向共享自增表灌超大ID。

初轮HTTPS被sandbox localhost EPERM拦截未执行，授权escalated后成功。options503测试最初误用既有映射409的领域错误，改为真实数据库失败分支测试，未改公共错误映射。新增browser故障测试先于初次options完成注入，修正等待候选按钮后最终11项PASS。六维HTTPS的恢复收藏DELETE初次未发送空JSON body而被既有guard正确拒绝400，补上data:{}后最终重跑；测试context类型补齐断言后typecheck PASS；没有弱化native/ACL/Auth检查。

## 一次独立复核入口

输入：本文件、设计§6及用户确认补充、当前真实diff与两个新source文件、final-evidence.json、checkpoint-manifest.json、fresh日志和EXPLAIN。重点检查V/候选过滤位置、canonical disclosure语义、binary literal比较、scope版本、options afterId运输形式、SQL片段复用的稳定性、两条proxy的固定目标/日志/凭据转发、UI陈旧options与账户隔离。协调方安排一次独立Sol High复核；本实现方不创建审查PASS文件、不commit/push。

清理仅任务创建的合成记录/root/进程；DEV nonroot MySQL9.7.2，migration0000–0007共8，不读真实媒体或其他tmp内容。地图/GPS、地点国家城市、地址/tile服务、多Tag、Phase9、部署、既有root维护均未进入。

```text
NONLOCATION_SEARCH_BATCH: IMPLEMENTED
TARGETED_VALIDATION: PASS
INDEPENDENT_REVIEW: PASS_NLS_R1_CLOSED
LOCAL_COMMIT_THIS_BATCH: USER_AUTHORIZED_CHECKPOINT
PUSH_THIS_BATCH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```

## 独立复核后当前状态

独立 `PHASE-08-NONLOCATION-SEARCH-REVIEW.md` 发现唯一P2 NLS-R1 cursor拒绝后首屏恢复缺失，其他范围符合已审边界、新P0/P1=0。现已按最小方案修复并完成33项相关客户端/浏览器、1项真实HTTPS与适用checks，closure仍待独立确认。新证据单独位于 `.cache/phase8-nls-r1/`，不覆盖上面的历史batch证据；详见 `PHASE-08-NLS-R1-FIX-HANDOFF.md`。本轮不commit/push，不宣称Phase8完成。

## 批次正式closure与本地checkpoint

`PHASE-08-NLS-R1-CLOSURE.md` 独立确认NLS-R1/P2 CLOSED、PASS，无当前批次blocker。用户19:09授权限定非地点源码/测试/相关进度文档本地checkpoint，不push。提交前26个此前受审source/test/doc及29个原证据hash全部匹配，无源码漂移；收尾仅同步状态/新建checkpoint记录，不修改功能。最新记录见 `PHASE-08-NONLOCATION-CHECKPOINT.md`。本文此前“本轮不commit/push/closure待执行”为当时授权和状态，现由本节覆盖commit授权与closure；push仍NO。批次功能完成，整个Phase8/地图未完成，Production NO。
