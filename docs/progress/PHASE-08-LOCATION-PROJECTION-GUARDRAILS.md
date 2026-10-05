# Phase 8 location projection — R3-DESIGN guardrails

2026-10-03 UTC。Astra Low 定点源码设计；基线 `0c948451774efd10a293029e727b666758441436`，检查时 tracked clean，保留既存未跟踪 Web AGENTS/CLAUDE。结论 **APPROVED_FOR_IMPLEMENTATION**，仅批准下列最小实现，不是功能验收或 Phase8 closure。未运行测试、migration、服务或访问媒体。本轮用户已重新授权使用重置后的额度；以后新确认重置/耗尽即停，Phase8结束即停。

## 1. 范围与源码证据

采用本次用户批准合同，覆盖旧 Phase8 文档中“地图未批准”的历史状态：exact GPS 仅本地生成唯一 H3 resolution 6；标签、bbox、查询、聚类仅取该 cell 的派生值；Natural Earth 国家按 cell 中心，GeoNames cities1000 同国最近且 <=50km，文案“附近城市”；MapLibre/OpenFreeMap披露边界沿用，不重做产品决策。

已读 `AGENTS.md`、`PHASE-08-PLAN.md`、Phase8 搜索设计/批次相关记录及下列源码：

- `packages/db/src/schema.ts:657`：media generation、metadata_generation、GPS 成对/范围 CHECK、family/id UNIQUE；READY 才要求 metadata generation=current，其他状态不可假定成立。
- `metadata-repository.ts:prepare/persistResult/lockContext/isCurrentProbeLease/replaceMetadataSnapshot`：family SHARE → storage SHARE → media UPDATE → job UPDATE；锁后 DB time；active、lifecycle revision、generation、recipe、storage identity/AVAILABLE、worker/epoch/RUNNING/expiry 全部校验；snapshot、下游任务、probe finish 同事务。
- `job-repository.ts:claimNext`：非锁候选发现后 family → media → job；现有 lease fencing，不得增加反向投影→media 锁。
- `connection.ts`/`transaction.ts`：checked DB session；仅 pre-COMMIT deadlock 有界重试；rollback failure discard；COMMIT unknown 不 replay。
- `album-repository.ts:searchFamilyMedia/buildFamilySearchQuery`（约420/3218行）：family UPDATE、actor锁/锁后时间检查；active media、live album ACL、当前 member favorite、canonical source、AND filters 在 GROUP/LIMIT 前执行，MIN 可见 album jump。
- `purge-execution.ts:约312–326`：显式删除媒体子表后删除 media_items；新增 restrict FK 必须配套子表删除，否则会阻塞 purge。
- `migration-readiness.ts`：精确 journal/hash/schema；schema snapshot 当前要求 column primary，故新表沿用单列 surrogate id，而非顺手重写复合主键识别。
- **运行现状限制**：`apps/worker/src/index.ts` 实际只运行 purge；MetadataProcessingService 只有 export，仓库非测试源码没有实例化。不能把 metadata service 测试当作后台 MEDIA_PROBE 已自动运行。此设计仅接线该 service 的投影写入，并提供 DB-only 回填入口，不以地图任务重建媒体调度器。

## 2. 最小新增 schema 与版本合同

新增 `0008_phase_08_location_projection.sql`、对应 journal entry 与 Drizzle 表 `media_location_projections`。0000–0007 SQL/hash/journal旧条目不动；不改 media_items、background_jobs enum、K、storage/root。

表定义（沿用现有 id/timestamp helpers）：

- `id` unsigned BIGINT 自增 primary；`family_id/media_id/generation` unsigned BIGINT NOT NULL；generation >=1。
- `policy_version` unsigned INT NOT NULL >=1；`dataset_version` VARCHAR(64) ASCII binary NOT NULL：固定 lowercase SHA-256 manifest hex，严格64字符。manifest绑定两份本地数据的实际hash、解析/规范化版本。policy绑定 H3算法/库版本、res6、边界/距离/平局规则；同一版本不得换算法或数据。
- `h3_cell` VARCHAR(15) ASCII binary NOT NULL，canonical lowercase；SQL形状检查 + 应用层 H3合法性且resolution=6（字符串regex不能代替H3检查）。
- `country_code` nullable VARCHAR(2) ASCII binary，大写ISO code；`city_geoname_id` nullable unsigned BIGINT；city非空要求country非空、id>0。无需数据库country/city维表，无FK到外部数据。
- `created_at/updated_at` 沿现有毫秒UTC时间；不存 exact GPS、副本EXIF、GPS hash、原图路径。中心坐标、展示名从 cell/已校验本地manifest计算，不另建可漂移坐标字段。
- UNIQUE `(family_id, media_id, policy_version, dataset_version)`；同版本每媒体一条，generation是受保护payload。多个版本不互相覆盖，不增加全局“current”可变表。
- FK `(family_id,media_id)` → media_items `(family_id,id)`，UPDATE/DELETE RESTRICT。unique前缀支撑FK。索引 `(family_id,policy_version,dataset_version,h3_cell,media_id)`；国家/城市先在有界可见集合聚合，不凭猜测追加索引，targeted EXPLAIN确有需要才加同表索引。

API/worker启动固定当前 `(P,D)`，读取并校验本地manifest及实际文件hash；不接受请求指定版本，不自动选择最高版本，不混不同版本补结果。每次可用 join 必须满足 `p.family_id=m.family_id AND p.media_id=m.id AND p.generation=m.generation AND m.metadata_generation=m.generation AND p.policy_version=P AND p.dataset_version=D`，并有有效GPS pair。版本缺失/不匹配是“未有当前投影”，不是无GPS；不fallback旧投影。数据损坏/缺失拒绝位置能力启动或返回已有503类别，不影响非地点查询。客户端不能因回填未完声称地图覆盖全部媒体。

## 3. 唯一派生入口及 metadata 原子接线

新增纯本地 projector（建议 `packages/media/src/location-projection.ts`）。输入为受信 normalized GPS pair + 固定加载的(P,D)，输出 cell/country/city。country与city计算只能使用 `cellToLatLng(cell)`；严禁用输入GPS找城市、筛bbox、求cluster。固定距离算法、<=50000米包含边界、平局按数值GeoNames id升序；国家边界多命中使用固定ISO字典序，无命中country/city null，海洋不猜国家。这些确定性规则记入policy manifest。country存在而无50km内city时city null。经度180/-180统一归一，NaN/Infinity/部分pair拒绝。运行时不发网络请求。

`MySqlMetadataRepository.persistResult` 在事务外为**最终映射 snapshot**准备projection（不能直接对parser SUCCESS前的原始结果投影；INVALID_MEDIA映射会清空GPS）。在现有 fence完全通过、snapshot UPDATE成功之后，原事务删除该媒体所有旧projection，再插入本次(P,D)投影；随后沿现有enqueue/finish流程。所有变更一起commit。`persistOperationalFailure` 中 CAPABILITY_DISABLED会替换空snapshot，也必须同事务清除projection；仅setMediaFailureState而不改snapshot的分支不必删除，读侧current/visibility规则仍生效。

允许注入已校验projector；未配置位置能力时仍执行snapshot替换时的projection invalidation，不写新projection，供DB-only扫描补齐。不要让旧版本行在同generation重新解析/GPS改变后继续可见。旧二进制不兼容新schema时沿精确migration readiness拒绝启动，不承诺混跑未支持0008的旧worker。

projector内部/数据错误不能伪装成NO_GPS，不能落部分projection，不能转换成 parser StorageSafetyError 或改成功媒体为失败。配置错误启动拒绝；意外投影计算失败可保留正常metadata提交但仅invalidate，不插入，并记录固定类别计数，后续扫描重新发现。DB写错误整笔rollback并保留现有lease恢复，不吞错误假报probe成功。COMMIT unknown透传，不再调用persistOperationalFailure。

## 4. DB-only回填：精确 CAS、锁序与恢复

新增 `packages/db/src/location-projection-repository.ts`，入口 `packages/db/scripts/backfill-location-projections.ts`（名称可随项目命名统一）。显式 DEV/nonroot/schema readiness gate，限定 family、batch size、max batches，默认dry-run；apply需既有授权。仅读DB GPS，不打开Original/root，不re-probe或改generation。不增加持久job类型/lease表。

1. 非锁 keyset 扫描 `(family_id,id)`；只选 active、metadata_generation=generation、GPS有效、当前(P,D)投影缺失或generation不匹配的行。取得 token `{family,id,storageObjectId,generation,metadataGeneration,recipeId,lifecycleRevision,gpsLatitude,gpsLongitude}`，十进制string/BigInt比较，不Number化ID/generation。
2. 事务外用固定projector计算；每个媒体独立 `runCheckedTransaction`。family SHARE → 按token storage SHARE（同family、AVAILABLE）→ media UPDATE → projection。media当前storage必须仍等于token；任何父行缺失、inactive或token字段不一致，返回STALE、零写；GPS用DB返回的canonical decimal/null精确比较，不能只比generation（同generation也可重写metadata）。不先锁projection，再等media。
3. 锁内current read重新检查全部token + metadata_generation=current，再读本(P,D)行。无行insert；已有同generation且同payload则NOOP；其他generation仅在上述当前media锁/CAS成立时更新为当前generation。相同版本/currentgeneration而payload不同：固定类别INVARIANT_CONFLICT，rollback并停止该批，不last-writer-wins掩盖不确定算法/脏数据。
4. PK/identity duplicate仅按明确unique名处理并锁内重读比较；其他SQL错误传播。每次retry重新锁/校验token，不复用已失效判断；不在事务内网络、文件解析或H3全数据扫描。
5. CAS负责fencing：所有投影writer先持有同media UPDATE锁，不需要虚构lease。metadata写入若先完成，则回填GPS/generation/revision token失配；回填先完成，则metadata事务随后清旧projection并原子替换。generation变化后旧projection读侧立即不可用，即使尚未清理。不同(P,D)进程只写自己版本，不能覆盖新版本。
6. SIGKILL在commit前无完整记录，重新扫描；成功后crash重新扫描NOOP。COMMIT unknown立即停止当前批、报告UNKNOWN，不重放该operation；后续独立恢复运行从DB重新发现并校验。无持久checkpoint也安全：完整新一轮从头扫描未匹配行；STALE/失败不得永久标记完成，扫描游标只是本轮进度。

**运行能力门槛：新上传自动出现在地图属于本批完成验收时必须落实的接线，当前源码证据不能证明它已具备。此设计批准不关闭这个能力缺口。** 若协调方已有受控 MEDIA_PROBE 运行入口，只需实例化/注入本projector并验证端到端；当前仓库搜索未找到，不能假定存在。没有该入口时先完成本设计的可实施部分，再将“MEDIA_PROBE运行驱动缺失”报协调方；不得以回填替代尚未提取GPS的新上传处理，也不得为此直接启动/改造purge worker并宣称全媒体流水线完成。

该DB-only入口同时覆盖已存GPS与将来metadata提交后暂缺projection的媒体。可由受控worker调用有界单批扫描，但不得把“提供入口”报告成“metadata自动调度已运行”；若产品验收要求全自动新上传处理，先证明现有MEDIA_PROBE实际驱动，缺失应作为明确运行接线工作报告，不擅自重做全部worker。

## 5. 查询、删除与迁移配套

在 `album-repository.ts` 当前checked transaction/family/actor检查内复用同一visibility/filter构造：family、active、live album、owner/FAMILY/can_view、time、指定album、当前member favorites、literal filename、canonical uploader、tag全部先于位置聚合。先得到distinct media集合与MIN可见album，再join当前projection、应用cell中心bbox/国家/城市/cell条件，之后才GROUP/count/order/LIMIT。不聚合后JS ACL，不在地图聚合前套媒体分页，不重复计跨相册media；无ADMIN CUSTOM bypass。分页仍timeline/id，cursor绑定新增规范filters及(P,D)，版本切换拒绝旧cursor。所有位置facet/count/cluster/drilldown共用同一过滤集合，不复用未过滤options SQL误报全family统计。

bbox反子午线、极点、边界点、聚类均由cell中心确定；响应只白名单粗cell/派生中心/粗标签、授权结果及计数，原detail保持无exact GPS；日志不含GPS/私有EXIF。缓存若存在必须绑定actor/family/filter/版本与既有权限失效机制，否则不引入跨请求缓存。

`purge-execution.ts` 现有子表删除列表增加media_location_projections（原transaction、media锁后、media_items删除前）；无新文件操作/容量账/K锁。Trash期间projection可留存但active过滤隐藏，restore可重用current版本；回填token包含lifecycleRevision，不能跨trash/restore使用旧token。

migration readiness加入新表，增加Phase8 predecessor精确快照；旧Phase6/7 predecessor构造必须排除后加表，保持历史schema验证。新增DEV preflight/apply脚本沿Phase7模式校验8条历史hash及schema，0008后9条精确检查。MySQL DDL非事务，部分执行时停并报告物理schema/journal，不盲重跑/drop重建。数据库schema参考文档仅同步，不代替migration。以上是schema必需配套，不重开Phase7审查。

## 6. 实施顺序与验收/停止条件

1. 固定projector/manifest及合成单元用例；schema/0008/readiness/migration review。
2. projection repository、metadata snapshot原子invalidations/接线、purge子表清理；DB-only有界回填。
3. 当前版本join与统一ACL/filter聚合；仅相关contracts/API/cursor接线。
4. targeted验证通过后交限定review；Phase8全部完成才milestone gate。

必须验收（仅synthetic DEV；本设计未执行）：

- migration FK跨family拒绝、unique/形状CHECK、0000–0007 hash未变、精确predecessor与新schema；purge有投影子行仍正常完成、账/锁序不变。
- 两GPS在同cell：cell/标签/bbox/cluster归属相同；country无命中、无附近city、50km边界/平局、反子午线、无GPS/坏pair、视频unsupported不伪造位置；manifest hash错拒绝。
- metadata旧lease/epoch/expiry、旧generation、trash/revision冲突：projection零写；snapshot清GPS与projection删除同commit；projection写失败rollback metadata/job；COMMIT unknown不补偿重放。
- 两回填进程同媒体NOOP；回填vs新generation、同generation GPS替换、trash/restore、purge、metadata lease takeover，使用barrier双连接真实MySQL验证两种commit顺序；旧(P,D)与新(P,D)并发不互相覆盖，读侧只取当前版本。
- crash在compute、锁后、write后commit前、commit响应丢失；再扫描收敛，不覆盖新generation、不永久跳过STALE、不记录GPS。
- hidden CUSTOM、撤权/禁用、不同family、trash、个人收藏、多相册去重及全部filters组合，map/facet/drilldown同集合；无先limit/后ACL；旧cursor版本拒绝；targeted EXPLAIN证明查询有界，无需全仓性能审计。

以上明确 guardrails 内允许 Sol 实施；无待用户重新选择的产品阻塞。若必须改权限、原业务锁序、storage模型、0000–0007、exact GPS外发/过滤、新增任务fence模型或接入全新媒体调度架构，停止并回报R3-DESIGN。数据包真实版本/hash/许可及外部服务当前行为本次未验证，实施方必须用实际选定本地文件落实manifest，不能填造hash或声称已经运行通过。非地点历史P2/P3、Production rollout、原root升级、真实媒体回填/清理、Phase9均范围外。
