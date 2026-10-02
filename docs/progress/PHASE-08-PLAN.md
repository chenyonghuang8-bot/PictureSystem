# Phase 8 — Search & Map：有界实施计划

2026-10-02 UTC。基线 HEAD `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。用户在确认 Phase7 功能完成后授权继续。**状态：8A1 IMPLEMENTED_SCOPED_REVIEW_PASS；Astra 已在 `PHASE-08A-SEARCH-DESIGN.md` 批准时间＋单相册＋我的收藏纵切。** 实施/验收详情见 `PHASE-08A1-IMPLEMENTATION.md`；用户18:25集中回复“是的”，已接受首次来源披露与历史归属、literal大小写/重音敏感、单Tag范围；剩余非地点搜索已作为一个功能批次实施，独立复核发现的NLS-R1/P2已修复并获独立CLOSED/PASS，当前批次无blocker，用户授权限定本地checkpoint、不push。GPS/地理编码未批准。当前详情见 `PHASE-08-NONLOCATION-SEARCH-BATCH.md`。 协调方按下面入口安排审批和实施。非 Astra 使用用户指定 Sol Medium / Fast；实际模型 ID unknown。禁止 Bridge。

## 1. 权威范围与实际基线

- `project-spec/ROADMAP.md` 的下一阶段明确是 **Phase 8 — Search & Map**：filters、filename、member、album、tag、time、location、favorites、MapLibre、marker cluster、country/city grouping。Phase9 才是 Memories；本阶段不引入回忆、AI、人脸、语义搜索。
- `project-spec/PROJECT.md` §9/§11：统一搜索入口；时间/上传成员/相册/收藏/Tag/地点/文件名；EXIF GPS 地图、聚合、点击地区浏览、国家/城市聚合，地图服务不得获得原始照片。
- `project-spec/ARCHITECTURE.md` §21：MapLibre GL、tile provider 可配置、GPS 自有 DB、不得向供应商上传照片。它没有指定 tile/geocoder 提供商、坐标披露权限或国家/城市数据来源，不能推断已经批准这些选择。
- `PHASE-07-FINAL-SUMMARY.md`：Phase7 implementation COMPLETE、feature acceptance/final gate PASS，F1 P1/INIT1 P2 CLOSED，production NO。现有 V1/无标签 V2 root 维护未完成；Phase8 仅8A1已实施并正式限定复核PASS，R1整体CLOSED；未完成整个Phase8。
- AGENTS 对 Phase4 的状态和 ROADMAP Phase16 的 Bridge 文字属于旧记录；当前阶段用 Phase7 final summary，Bridge 禁止以 AGENTS/当前用户指令为准。不要据旧文字重新跑已完成阶段或自动 handoff 浏览器。

## 2. 有界盘点：能复用什么、不能假装有什么

| 项目              | 已有真实实现 / 已批准边界                                                                                                                                                                  | Phase8 缺口                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Family timeline   | `packages/db/src/album-repository.ts:readFamilyTimeline`：事务中 active actor/family、live album ACL、active media；GROUP BY media，最低可见 album jump；timeline_key/id descending keyset | 当前 `galleryMediaQuerySchema` 严格仅 cursor/limit，无搜索 filters                                                   |
| 权限 / lifecycle  | Phase2 + Phase5A + Phase6/7；owner/FAMILY/can_view，无 ADMIN/SUPER_ADMIN CUSTOM bypass；`media-lifecycle.ts` 的非trashed且无purge intent                                                   | 新搜索 SQL/facets/aggregates 必须由 Astra 复核是否仍在同一可见集合内；不能先分页再 JS 过滤                           |
| 时间              | `media_items.timeline_key/timeline_basis`，capture-local 或 upload fallback；已有排序与 cursor                                                                                             | 日期输入与范围语义需统一；不能猜 timezone 或混用 uploaded_at/captured_at_utc                                         |
| 相册 / 收藏 / Tag | `album_media`、当前 member `user_favorites`、family tags/media_tags，已有 gallery feature DTO                                                                                              | 过滤和选项集合不存在；隐藏相册/Tag/成员关联不能通过 autocomplete/counts 泄露                                         |
| 文件名 / 上传成员 | Phase6设计映射：media.source_upload_id → upload_sessions.original_filename / created_by_member_id，首次 provenance；去重不改 canonical source                                              | 不存在 media_items.uploaded_by_member_id 或文件名列；“首次上传”与“任一次重复上传”的搜索语义不能擅自混同              |
| GPS               | media_items.gps_latitude/longitude，DB成对/范围CHECK；既有 Phase5/6 DTO 明确不暴露GPS                                                                                                      | 坐标可见权限、精度、响应预算与 map endpoint 未批准；不能把“能看照片”自动等同“已批准看到坐标”                         |
| 国家 / 城市       | spec的 media_locations 是概念设计；真实 schema 无该表和 country/region/city/place_name，Phase6明确 NOT_IMPLEMENTED                                                                         | 数据来源、无GPS/查不到地址处理、准确性与可能的 versioned migration 待批准；不凭坐标编造城市                          |
| Web               | 现有 gallery grid/viewer/session/BFF；搜索/地图为后续功能，暖白/绿色/三栏视觉规范                                                                                                          | 真实搜索入口、filters/results和map UI未实现；按 `project-spec/ui/web-preview.png` 对齐，实施UI时读取参考图及局部规范 |
| 外部地图          | 架构指定 MapLibre；当前 package/config无maplibre、tile/geocode字段                                                                                                                         | 不在本轮装包、选号收费服务或增基础设施；进入地图实施前核验官方 API/许可/可用性，不锁定未经查证版本                   |

本段盘点创建时尚无Phase8专项guardrails；当前已有 `PHASE-08A-SEARCH-DESIGN.md` 的8A1批准及8A2受限扩展建议，8A1正式closure。来源披露已获18:25明确确认，地图仍未获授权；Phase5/6仅继承既有边界。

## 3. 旧 root 是否阻塞：分清实际交付环境

**不阻塞本计划和 Phase8 搜索的 DB-only 开发/隔离验收。** `apps/api/src/index.ts` 在 storage capability 之外构造 albumRepository/albumService；timeline查询只访问DB，没有依赖native media读取。旧root不可准入不构成新增索引/搜索SQL设计的技术前置条件。

**媒体可视化必须有可用 root；隔离 DEV 用新建、自有、合成 fresh INIT1 fixture 满足。** Phase7完整 Web E2E已证明现有harness用fresh INIT1运行；Phase8 thumbnail/preview/map照片选择同样可复用。测试不读取 `.env` 中的存储路径内容，不重启既有服务，不复制真实媒体。

**旧部署的正常图片访问仍被维护兼容条件阻挡。** 本轮没有运行探针读取旧root来证明其具体状态；不能宣称旧V1已可运行、不能weakening/adopt/重写marker。若验收要求换成“现有部署实际可用”，必须先由用户另行授权并经Astra批准root维护slice；它不是默认Phase8代码依赖，也不将它偷偷并入搜索计划。Production Ready持续NO。

## 4. 剩余工作按完整功能批次推进

用户已同意减少拆轮次、重复设计和零碎确认。该同意只确认工作方式，**不是原三项产品推荐值的无条件批准，尤其不是来源披露授权**。不另建分层子阶段、不为每个filter单独设计/实施/审查。

| 批次                                          | 交付与状态                                                                                          | 边界                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 已完成基线（原8A0/8A1）                       | 既有设计、时间/单相册/个人收藏、日志修复与正式限定closure；本地checkpoint已保存                     | 不重复基础审计，不重新设计Auth/ACL                                                                                                                        |
| **剩余非地点搜索完整功能批次（沿用8A2代号）** | **文件名＋首次上传成员＋Tag** 一次完成，同一入口、组合、选项、分页/cursor、API→DB→Web与完整定向验收 | 只集中收口下面真正未决产品语义；随后沿用已定义受限边界。当前已整体实施并通过定向验证、待独立复核，不按三个filter拆提交/确认轮次；不凭计划扩大权限或schema |
| 后续地图/地区功能（原8B/8C规划）              | 位置搜索、地图与国家/城市范围沿原ROADMAP，当前不开展                                                | GPS权限/来源/外发及可能schema仍须既有审批；本轮不研究或合并到非地点搜索                                                                                   |

一次批次包含strict合同/受限查询、既有统一UI、可见集合候选、定向功能/数据库/实际Web安全日志验收及一次限定复核。只有实际新权限/事务/schema问题才返回设计，不因普通字段追加重复开启Astra设计。完整Phase8交付后才运行milestone full gate。

## 5. 有界核对：既有规则、技术承接与未决取舍

本次只读取PROJECT §11/§13、ROADMAP Phase8、相关schema概念/真实字段、Phase6来源映射与现有8A设计/PRODUCT-QUESTIONS，不是全仓审计。`PHASE-08A2-PRODUCT-QUESTIONS.md` 保留此前三项建议作为输入，**本节将必要决策整合为两项，不另发多轮问题**。

| 分类                           | 核对结果与依据                                                                                                                                                                                                                                          | 是否再问用户                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 已明确产品范围                 | PROJECT §11统一入口/V1文件名、上传成员、Tag；§13手动Tag；ROADMAP Phase8同批包含这些filters。人物/语义/自然语言为V2                                                                                                                                      | 不问是否需要这些功能或是否改为AI标签                                                                                |
| 已定义继承边界                 | 8A设计 §3–6：同family当前可见active media、不同条件AND、strict输入、hidden/missing/cross-family统一空页、private/no-store、安全日志、有界keyset和scope、visible-only options无counts                                                                    | 不重新让用户选择ACL、参数编码、分页算法或索引                                                                       |
| 可从真实兼容实现确定的技术来源 | Phase6设计字段映射：`media_items.source_upload_id → upload_sessions.original_filename / created_by_member_id`；canonical首次provenance不随重复上传改变。真实schema存在该关系，概念schema中的storage_objects.original_filename不是另一个实际可用数据来源 | 不问JOIN哪张表，不新建文件名/上传者列。**字段可用不等于按来源搜索的披露已授权**                                     |
| 可继承的技术落实               | canonical JOIN含family约束；Tag沿现有media_tags/tags、按ID EXISTS；LIKE特殊字符转义/参数绑定、输入预算、cursor scope版本更新、候选仅来自可见集合                                                                                                        | 用户不选SQL/索引/转义或是否隐藏敏感日志；真要schema/权限改变才另报设计缺口                                          |
| 未要求的可选扩展               | 多Tag、多个相册OR、独立上传时间、全文/模糊、动态counts均非本批必要需求。8A设计推荐首版单Tag                                                                                                                                                             | 不增加any/all独立确认轮次。单Tag是保守批次范围建议，**不是用户已确认的事实**；若用户明确要求多选，再一次确定any/all |

以下保留集中确认时的问题，用户已在18:25回复“是的”接受整组推荐及单Tag；不再是未决项：

1. **是否接受首次上传来源匹配及其披露**。推荐按创建canonical媒体的首次文件名/上传成员检索；重复上传不改归属，成员停用/离开后保留历史归属。可看照片的人可通过filter/成员候选推断其首次来源，这一点须明确接受（8A设计§2/§6已列待确认）。例如爸爸先上传A.jpg、妈妈后来重复上传B.jpg，推荐只匹配A.jpg/爸爸。若想匹配任一次/最近一次上传，是不同产品语义与receipt可见性，不能简单扩JOIN；不接受披露则暂不开放对应filter。
2. **文件名比较是否区分大小写/重音**。spec未规定，当前也没有已上线文件名filter可继承。推荐保留8A设计的字面包含、区分大小写与重音、不做NFKC折叠；%/_/!作普通字符，`IMG`不自动命中`img`、`e`不自动等于`é`。这是可感知产品行为，**不是由数据库默认collation决定的技术细节，在提问时尚未获用户确认，现已接受推荐**。若选择忽略，先明确具体比较规则，仍不扩大为模糊/全文。

批次范围建议附带“首版单Tag”，无须额外问未要求的多选逻辑；统一scope接受记录即可。推荐语义已由用户明确接受，按既有8A设计§6受限扩展实施完整批次；没有追加Astra设计，没有改变schema/权限/锁，没有提交或push。

地图/GPS权限、精度、地址来源/供应商/坐标外发仍按原设计入口处理，是后续功能范围；不把这些问题塞进当前非地点搜索确认。

## 6. 已执行的8A0设计入口（历史计划）

**执行角色：GPT-6 Astra / Low。目标：一次批准覆盖8A1+8A2的非地点搜索安全合同；代码实现等待协调方安排。** 该入口已执行，批准见 `PHASE-08A-SEARCH-DESIGN.md`；下面保留最少输入/输出计划，不把8A1批准扩大到未定8A2。

最少输入：本计划；PROJECT §8/11、ROADMAP Phase8；PHASE-07-FINAL-SUMMARY；Phase2 ACL guardrails；Phase5A home timeline/serving boundary及Phase5 final；Phase6设计中provenance/feature DTO段和Phase6 final；实际gallery contract/routes/service/repository/lifecycle。不要读取真实照片/旧root/Secrets，不要重做全仓检查。

工作输出：`docs/progress/PHASE-08A-SEARCH-DESIGN.md`，须同时给出：

- 产品语义已确认/尚待决策表；新/复用endpoint的选择、strict参数/长度/limit/时间/cursor定义、错误与private no-store响应，保持现有consumer可兼容；未选择的值不冒充用户决定。
- 单一family/session/live-placement/album ACL/active media可见集合，再filter、dedupe/order/limit的参数化查询计划；album/tag/member选项、counts以及hidden IDs not-found/empty的具体语义；不得引入跨family或角色bypass。是否复用现有锁与事务需显式确认，不由Sol修改。
- 源filename/member从哪条receipt取值、LIKE通配符/Unicode/长度/未可信filename的规则，避免匹配hidden重复上传关系；timeline/date/cursor组合语义，不猜timezone。
- 对现有索引的有界EXPLAIN计划与约1万张合成数据验收思路；在出现具体性能证据前不新增FULLTEXT/索引/冗余列或搜索服务。
- 8A1和8A2逐文件patch map、允许变化/禁止变化、以下矩阵与明确 APPROVED_FOR_SOL 或具体blocker。若必须schema/permission/transaction变动，单列设计，不含自动migration。

审批后 **8A1 Sol Fast实施入口**：contracts `gallery.ts`（或批准的新search contract）；API `albums/routes.ts` / `service.ts`；DB `album-repository.ts` 的批准query；Web `gallery-paths.ts` / `timeline.tsx` /统一入口及必要server加载；对应contract/API/DB/integration/Web/HTTPS tests。文件只是候选patch map，不能提前强制新route或把新filters塞入未经审批的旧strict schema。保留现有viewer/derived/Original能力调用链。

8A1 acceptance：选时间/可见相册/“我的收藏”后首屏与下一页只显示符合条件且当前可见媒体；媒体多相册不重复，页面能打开仍被服务端授权的detail，切条件无旧响应混入，撤销权限/trashed/purge intent在下一次请求生效；无条件旧timeline仍兼容。完成8A1后交接，不自动实施8A2。

## 7. 测试、复核、结束条件

- 日常targeted：strict contracts（未知键、BIGINT、坏cursor/range/字符串）；API auth/error/无敏感字段日志；DB参数化query与可见性单测；Web URL/filter/cursor/迟到响应/账户切换；web typecheck/相关lint。
- **live DEV integration必须运行且skip0**：owner/FAMILY/explicit-view、hidden CUSTOM ADMIN/SUPER_ADMIN、跨family、disabled/revoked session、hidden/missing album/tag/member；多placement过滤和jump album、分页ties、filter改变、trash/purge intent、favorite属于当前member、Tag归family、receipt provenance。用现有非rootfamily_album_dev及精确owned记录清理。
- 8A1/8A2的真实HTTPS小slice：真实Secure cookie、筛选→分页→viewer，桌面/窄屏，401/404和撤权结果；复用owned fresh INIT1 storage harness，retries0，不弱化limiter。不并行build native与native测试，不让不同DEV数据库suite重叠，以免重演Phase7验收污染。
- 地图slice追加bounds/经度跨界/坐标缺失/cluster与hidden集合、响应上限、zoom请求迟到、地区→同一结果、tile断网/错误fallback、外部请求中无原图/私有媒体URL/token、位置日志脱敏。具体算法/预算由批准设计确定，不在此写成伪已定协议。
- milestone只在完整Phase8交付时跑一次format/lint/type/unit/API/allDEVintegration/race/native/build/必要E2E；相同受审源码不做每轮全仓重复审计。记录未运行/失败/成功各自证据，不借Phase7 PASS。
- **立即停止**：额度耗尽或确认重置；最迟2026-10-02 20:00UTC；需要改变已批准schema/permission/transaction/locking/auth/native不变量；需要读取真实媒体/现有root、外发坐标、生产服务或新的系统依赖且未授权；approval blocker。不用reset/付费、反复重试限额或绕过校验。
- 子阶段完成后按授权范围交接；Phase8完结后停止等用户，不自动Phase9/部署/root升级/push。用户对Phase7的push授权不自动扩展到本计划或Phase8提交。

## 8. 非阻塞待办 / 发布记录

非阻塞：二级索引/全文搜索基于实际EXPLAIN再评估；更复杂facet counts/本地地址数据库更新/离线tile；既有production rate limit/audit/hardware deferred。本轮不增Redis/Elasticsearch/新微服务、不修无关Web AGENTS/CLAUDE。

Phase7 发布由用户另开的独立任务完成。协调方确认远端 main 为 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`，仅三个 Phase7 提交 fast-forward，没有 Phase8 内容；本任务 fresh fetch 的 origin/main 也为该 SHA。本任务未发起 push。协调方报告无 CI 记录，不能写成 CI PASS。用户已授权限定8A1本地checkpoint提交；不push。

```text
NEXT_PHASE: PHASE_8_SEARCH_AND_MAP
PHASE_8_IMPLEMENTATION_STARTED: YES_NONLOCATION_SEARCH_BATCH
PLAN_STATUS: NONLOCATION_SEARCH_COMPLETE_REVIEW_PASS_NLS_R1_CLOSED
FIRST_EXECUTABLE_SLICE: 8A1_APPROVED_SEARCH_VERTICAL_SLICE
EXISTING_PHASE_8_APPROVED_GUARDRAILS: PHASE_08A_SEARCH_DESIGN_PLUS_CONFIRMED_SECTION_6
V1_ROOT_MAINTENANCE_REQUIRED_FOR_ISOLATED_DEV_SEARCH: NO
V1_ROOT_MAINTENANCE_COMPLETE: NO
SCHEMA_MIGRATION_APPROVED: NO
PHASE_7_PUSH: VERIFIED_BY_INDEPENDENT_TASK_03f6491
PHASE_8A1_LOCAL_COMMIT: USER_AUTHORIZED_CHECKPOINT
PHASE_8_PUSH: NO
PRODUCTION_READY: NO
```

## 9. 8A1 checkpoint后入口

`PHASE-08A1-R1-E1-CLOSURE.md` 正式PASS，R1整体CLOSED；限定提交收尾见 `PHASE-08A1-CHECKPOINT.md`。原审查结论按历史保留，当前blocker=0。PERF-E1/P3非阻塞待办保持，不重新展开1万数据性能验收。下一步按本文件§4–5将剩余非地点搜索合为一个功能批次，两项集中语义及单Tag已在18:25获得用户明确“是的”确认；原 `PHASE-08A2-PRODUCT-QUESTIONS.md` 追加确认记录。当前非地点功能批次实施/验收交接见 `PHASE-08-NONLOCATION-SEARCH-BATCH.md`，已通过独立复核与NLS-R1 closure，不进入地图。用户最新硬停止为20:00UTC（北京时间10月3日04:00），覆盖原18:00。

当前收尾入口：`PHASE-08-NONLOCATION-CHECKPOINT.md`。原独立复核NEEDS_FIX报告保持，最新独立closure CLOSED/PASS。用户授权限定本地commit、不push；非地点批次完成，地图未开始，不扩功能/新设计。
