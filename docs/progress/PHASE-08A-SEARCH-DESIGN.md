# Phase 8A — 非地点搜索合同与查询设计

2026-10-02 UTC；限定 Astra Low 设计。源码基线 `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`。8A0创建本设计时仅设计，不实施、不迁移、不commit/push；后续8A1已正式closure，提交授权以当前用户指令和checkpoint记录为准。Phase7功能/发布状态按 `PHASE-08-PLAN.md`；本文件不重新签核 Phase7，也不声称 Phase8 完成。

**结论：8A1 APPROVED_FOR_SOL，限本文件时间＋单相册＋我的收藏纵切。8A2 的共同安全边界已定义，但首次来源披露、文件名匹配与 Tag 多选产品语义待集中确认，不能据本文件直接实施 8A2。** 无须更改 schema、锁序、Auth、storage 或既有 root。实施通过 targeted 验收后交接，不自动进入下一 slice。

## 1. 依据与已核实事实

- PROJECT §8：拍摄时间优先、缺失用上传时间；§11 统一搜索包括时间、上传成员、相册、收藏、Tag、地点、文件名；§12 区分个人收藏和家庭精选。ROADMAP Phase8 对应 Search & Map，不包括 Phase9 回忆或 V2 语义搜索。
- `PHASE-02-GUARDRAILS.md`：同 family 先持有 family FOR UPDATE，锁后验证 actor/session；owner、FAMILY、明确 can_view 可看，ADMIN/SUPER_ADMIN 不绕过 CUSTOM。
- `PHASE-05A-HOME-TIMELINE-DESIGN.md`、实际 `packages/db/src/album-repository.ts:listFamilyTimeline/readFamilyTimeline`：复用 runCheckedTransaction → lockFamily → lockActor → readServerTime → assertActor；live placement JOIN、可见 album ACL、按媒体 GROUP BY、MIN(可见 album ID) 为 jump album、timeline_key/id 降序 keyset。
- `packages/db/src/media-lifecycle.ts`：activeMediaSql 必须同时要求 trashed_at IS NULL、purge_intent_id IS NULL。有 favorite/tag 不恢复可见性；READY 不是时间线行的准入条件，图片另走现有 derived 授权。
- `packages/db/src/schema.ts`：timeline_key 是 DATETIME(3)，不是随 viewer 时区转换的即时刻；CHECK 绑定 CAPTURE_LOCAL → captured_local_at 或 UPLOAD_UTC → uploaded_at。captured_at_utc 另有字段，不能替换既定时间线。`apps/web/lib/gallery-paths.ts:monthKey` 直接取 timelineKey 年月，也没有本地时区转换。
- `packages/contracts/src/gallery.ts`：旧 query 严格仅 cursor/limit；familyTimelineItem 含 jump albumId、个人 isFavorite、isFamilyFeatured、时间/尺寸/thumbnail kind，不含 GPS、filename、source upload、上传者、存储路径。保留这一响应白名单。
- `PHASE-06-DESIGN.md` 的首次 provenance 与 schema 一致：media_items.source_upload_id 指向 upload_sessions.id，receipt 上才有 original_filename 和 created_by_member_id；后续重复上传不替换 canonical source。不存在 media_items 文件名/上传成员列。source receipt 的 album 不是当前可见 placement 的授权依据。
- 8A0 未运行数据库、EXPLAIN、性能或功能测试。下文为实施验收要求，不把代码阅读写成测试 PASS。

## 2. 产品语义与决策边界

| 事项                                               | 本次状态与处理                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 统一搜索、时间/相册/个人收藏                       | 已授权首纵切；在照片首页统一筛选区落地，不增加另一套图库                                                                                                                       |
| 时间                                               | 沿用照片 timeline；本设计将日期解释为该 timeline 的日历日，UI 写“照片时间（无拍摄时间时用上传时间）”，不偷偷增加独立上传时间维度                                               |
| 组合                                               | 本次最小合同：不同条件 AND，单相册，可选起止日期，可选“仅我的收藏”；非重要新产品能力，属于落实首纵切的明确协议选择                                                             |
| 家庭精选                                           | 响应继续保留既有徽标；不是“我的收藏”，本次不增加精选筛选                                                                                                                       |
| 文件名/上传成员                                    | 推荐且仅能直接利用首次 source receipt；对可见照片允许按这些来源属性推断匹配，本身也是披露，Phase6 有字段映射不等于用户已批准搜索披露。需协调方一次确认首次来源语义及该披露边界 |
| 文件名匹配                                         | 推荐 literal substring、大小写/重音敏感、不做 NFKC 折叠；需与上一项一起确认，不擅自将 DB 默认 collation 当产品需求                                                             |
| Tag 多选                                           | 推荐首版单 Tag，未来多选再决定 any/all。若用户本次要求多选，集中确认 any/all，不凭实现便利代选                                                                                 |
| 独立上传时间、多个相册 OR、排除收藏、全文/模糊搜索 | 未要求，不纳入 8A1；无需为这些可选项等待或扩范围                                                                                                                               |
| GPS、地点、地图、国家城市                          | 8B/8C 单独决策；本接口不接收这些参数，也不增加坐标 DTO                                                                                                                         |

因此 8A1 无待用户产品选择的阻塞项；8A2 的三项选择应一次提出，避免每个 filter 单独开启新设计轮次。若选择推荐值，依下文受限合同补充确认记录即可；若改为“任一次重复上传”，须另审 receipt 可见性，不能扩大 JOIN。

## 3. 8A1 API 严格合同

新增 `GET /api/v1/families/:familyId/search`。旧 timeline 和 album media endpoint/query/cursor 完全兼容，不把搜索字段塞入旧 galleryMediaQuerySchema。无条件搜索与旧 timeline 应得到同一媒体顺序/DTO（cursor 编码可不同）。新方法、schema 可放现有 albums/gallery 文件，避免单独服务层。

| Query             | 合同                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fromDate / toDate | 可选，严格 YYYY-MM-DD，真实 Gregorian 日期，年份 1000–9999；空串、offset、时间部分、重复键/数组拒绝。fromDate ≤ toDate；单边范围允许。fromDate 含当日 00:00:00.000；toDate 含当日 23:59:59.999，与 DATETIME(3) 精度一致 |
| albumId           | 可选，复用 unsignedBigIntStringSchema，禁止 Number 转换、数组、多值或逗号列表                                                                                                                                           |
| favoritesOnly     | 可选，仅字面字符串 `true`；缺省关闭。空串、false、1 不做 truthy coercion；客户端关闭时删除该键                                                                                                                          |
| limit             | 缺省20，1–100；新 schema 严格十进制整数词法后转数，拒绝空白、指数、小数、重复键；Web 继续24                                                                                                                             |
| cursor            | 可选，非空 base64url，最多1024 ASCII字符；见下节                                                                                                                                                                        |
| 其他键            | 400 INVALID_REQUEST；包括 familyId/memberId、sort、offset、filename、tag、GPS 等                                                                                                                                        |

日期转 SQL 参数必须按字面年月日构造 UTC 编码的 Date 或固定 DATETIME 字符串，与现有 mysql2 UTC 约定保持一致；不可通过本地时区 parse、DST、`toLocaleDateString` 转换。SQL 对裸 timeline_key 作 >= / <= 参数比较，不包 DATE(column)。末日用 .999 上界，不做 9999-12-31 加一天的溢出运算。CAPTURE_LOCAL 的 Z 表示现有序列化约定，不宣称拍摄当地时间是 UTC 即时刻。

响应直接复用 familyTimelinePageSchema；不得加 total、所有 albumIds、filename、GPS、uploadId/memberId。使用 limit+1 查询（最大101），返回前 limit 条，有多余行才用最后返回行产生 nextCursor；这只改变新 endpoint，无需重写旧 endpoint 的满页语义。

Auth 沿用现有 authenticate、checked transaction 和错误映射。格式错误400，未认证401；有效但非自身 active family、不存在 family 按既有 NOT_FOUND404；已认证可访问 family 的隐藏/不存在/他家 album 筛选统一200空页，不先查询目标存在性或返回不同错误。合法条件没有结果同样空页。数据库故障用既有安全错误，禁止原始 driver error。

在新 route 处理开始即设置 `Cache-Control: private, no-store`，覆盖成功、400、401、404和错误；现有 onSend 只匹配 /api/v1/albums，不能以为自动覆盖 family 搜索。不加共享缓存、ETag或外部 analytics。日志只记既有允许的事件/状态，不记 query/cursor、搜索字符串、文件名、SQL参数或原始 URL；检查 API/BFF 现有 logger 是否会自动记录 query。

## 4. Cursor 与一致性

独立严格 cursor payload：`{version:1, timelineKey, mediaId, scope}`。timelineKey 必须 canonical `YYYY-MM-DDTHH:mm:ss.sssZ` 且真实有效日期，mediaId 复用 unsigned BIGINT string；scope 是64位小写十六进制 SHA-256。

scope 的输入为固定顺序 JSON 数组：`["family-search-v1", familyId, authenticatedUserId, fromDateOrNull, toDateOrNull, albumIdOrNull, favoritesOnlyBoolean, limit]`。用户 identity 从 authenticate 取，绝不从 query 取。familyId 与 userId 唯一确定当前 family member；repository 仍从数据库锁后取 memberId。所有 absent 归一 null，boolean 归一布尔，ID 不改变已批准规范。编码使用 UTF-8/base64url 无 padding；decode 先查字节预算、合法字符、canonical round-trip，再严格 JSON/schema/时间验证；旧 gallery cursor 不接受。scope 不匹配400，客户端重启首屏，不隐式混页。

该 hash **不是签名、不是权限凭据**，无需引入 signing secret。用户可构造另一个合法边界，只能在本次重新授权并过滤后的集合内继续；安全性不能依赖 cursor 未篡改。scope 绑定防误用/串用户/串条件，不抵抗主动重算；无数据泄露依靠 SQL ACL。cursor 中不包含原始搜索文本、session/token 或隐藏关联。

keyset 为 `timeline_key < key OR (timeline_key = key AND id < mediaId)`，顺序严格 DESC/DESC。不需要 cursor 对应行仍存在，也不先加载该行。权限撤销、trash/purge、取消收藏在下一请求按当前 DB 生效。不是跨请求 snapshot：新上传、metadata 改变 timeline、placement/favorite 改变可导致浏览期间遗漏/重新出现；刷新得到当前集合，不能承诺历史快照或 exactly-once。客户端按 mediaId 去重只是展示容错，不代替 SQL 去重/过滤。

## 5. 唯一可见集合与 SQL 计划

定义 V(actor,family) 为：当前 active actor/session/membership + m.family_id = family + activeMediaSql(m) + 至少一条同 family 的 album_media → 未删除 album 且 owner/FAMILY/can_view。所有搜索行、后续选项与未来 aggregates 从 V 或其可见 placements 派生；不从所有 media/filter hits 再过滤 ACL。

沿用 listFamilyTimeline 的事务前缀和锁顺序，不另建只读无锁捷径，不改 isolation/retry/commit-unknown 行为。SQL 可复用 readFamilyTimeline 为内部 helper，增加可选受类型约束的 filters；旧调用传空条件。但为最小回归风险，也允许新增 readFamilySearch 并抽取固定 ACL predicate（仅固定 alias 白名单），必须以一致性测试防漂移。两者都不能改旧授权语义。

具体新查询从现有 readFamilyTimeline 复制其 SELECT/JOIN/ACL/GROUP BY，增加以下 WHERE（仅选择固定 SQL 片段，所有值通过 mysql2 参数绑定）：

- fromDate: `m.timeline_key >= ?`；toDate: `m.timeline_key <= ?`。
- albumId: `a.id = ?` **限制已经通过 ACL 的同一个 a/placement**。不能另加一个未经 ACL 的 EXISTS(hidden album) 让可见于 A 的照片泄露 B 中的归属。
- favoritesOnly: 当前 member JOIN 的 `favorite.id IS NOT NULL`，或同 family/member/media 的 EXISTS；不得接收用户提供 favorite owner，不得查询其他成员收藏或计数。
- cursor 按上节；所有筛选均在 GROUP BY/ORDER/LIMIT 前；limit绑定经验证的 limit+1。

无 album 筛选时 jump album = MIN(所有可见 live a.id)；有 album 筛选时 jump album 正是该可见筛选 album。媒体若有一个隐藏和一个可见 placement，只返回可见路径；删除筛选相册后不能自动改跳另一个相册而继续命中原筛选。GROUP BY m.id 等既有列，不对 placement 行先 LIMIT；ID MIN/ORDER 在数据库 BIGINT 上做，不做字符串字典排序。

不得 JOIN storage/native，不从磁盘读取，不升级 root。页面显示和详情/derived/下载继续各自服务端授权；搜索返回不授予下载能力。并发撤权后的下一请求必须拒绝/消失，已发送给浏览器的数据不能承诺远程擦除。

## 6. 选项与 8A2 受限扩展

8A1 相册下拉复用现有 `GET /api/v1/albums?familyId&afterId&limit` 的 authorized live album list，按现有有界分页逐页加载，不能只加载第一页就声称全部。允许显示自己可见但无媒体的相册（本身已获相册列表授权），选择后为空页。不增加相册 counts，不调用管理成员列表填筛选框。

8A2 待产品确认后，拟增 filename（1–255 Unicode code points，trim 后非空，UTF-8预算1024 bytes，拒绝 NUL/control/unpaired surrogate）、uploaderMemberId、tagId（单值 BIGINT）。空 UI 值删除参数；API 空值拒绝。filter 之间仍 AND。

- 来源只 JOIN `upload_sessions source ON source.family_id=m.family_id AND source.id=m.source_upload_id`。不联查其他 receipts、不根据 receipt album 扩 ACL，不暴露 receipt 详情；重复上传的新 filename/member 不匹配旧 canonical media。首次指创建 canonical media 所保留的 receipt，不是每个 placement 的首次，也不能声称是人类实际摄影者。
- 推荐 filename literal substring：先将 `!` → `!!`、`%` → `!%`、`_` → `!_`，再包 `%`，参数绑定，固定 `LIKE ? ESCAPE '!'`；固定 binary UTF-8比较实现大小写/重音敏感（验收确认真实 MySQL collation行为），不接受客户端 collation/SQL片段。保留Unicode，不改存储的上传文件名；禁止 HTML 注入与文件路径拼接。若产品要求忽略大小写/重音，先确定精确规则，不静默继承默认 collation。
- uploaderMemberId 比较 source.created_by_member_id；disabled/left 原始上传成员是否仍可作为历史归属应按首次来源保留，不能把此条件当 current active actor 条件。这项必须随来源产品确认；不在8A1实现。
- tagId 用 EXISTS(media_tags JOIN tags)，family与media均绑定，避免多tag JOIN 放大结果。隐藏/不存在/他家 tag/member ID统一空页；可见媒体上的 Tag 是既有 metadata 授权，不额外披露仅在隐藏媒体使用的 Tag。
- 若需要 options endpoint，限定 `/families/:familyId/search/options`，strict kind=tag或uploader、afterId、limit1–50，按数值ID升序 keyset；不接受自由查询/聚合，返回 id/name（uploader仅 displayName，不是username/email），无counts。由未加用户filters的 V 中 distinct source/tag实体得出（稳定全可见候选，而非额外facets语义）。同一 family锁+actor检查；分页cursor需绑定kind/family/user。未决来源披露确认前不实现 uploader options。tag名/member名同名不合并。无需选项时不得提前开发该endpoint。
- 后续真有 counts 需求必须 count distinct media 从相同 V+filters；本次不实现总数/动态facet counts，不能从全family聚合再删选项。

8A2 新增filter后升级 scope标识及cursor version或引入独立明确版本，旧cursor拒绝重启；不能让新filter游离scope。不得提前在8A1接受但忽略这些参数。

## 7. 第一纵切逐文件 patch map

| 文件/范围                                                                                        | 允许变化与验收职责                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| packages/contracts/src/gallery.ts、导出入口与对应 tests                                          | 新 familySearchQuery/cursor schema，复用 page/item；严格解析与独立cursor，不改旧strict合同                    |
| apps/api/src/albums/routes.ts                                                                    | 新GET search，authenticate、private no-store、解码/绑定cursor、limit+1、DTO白名单、错误；不改public share     |
| apps/api/src/albums/service.ts                                                                   | search方法与scope/cursor helper；扩repository接口（如接口在同文件）；复用database错误封装，不新Auth路径       |
| packages/db/src/album-repository.ts                                                              | 上述受限查询与既有transaction前缀；无写操作、锁序/DDL变化；activeMediaSql直接复用                             |
| apps/web/lib/gallery-paths.ts、gallery-server/client相关测试                                     | 新searchPath与canonical query serialization；旧helpers不变；禁止使用本地时区                                  |
| apps/web/app/page.tsx、components/gallery/home-header.tsx、timeline.tsx及小型search-controls组件 | 首页统一筛选区，时间/可见相册/我的收藏，应用/清除/恢复URL条件；新结果分页仍用PhotoGrid/Viewer；保留无条件体验 |
| Web既有BFF转发路由（仅实际allowlist需要时）                                                      | 开放确切search路径与允许query；同源session转发、no-store，不开任意URL代理                                     |
| apps/api/src/albums/_search_.test.ts、service tests；packages/db现有DEV integration harness      | 下面矩阵；新增精确owned合成记录并清理，不改真实数据                                                           |
| apps/web相关gallery测试与已有HTTPS E2E harness                                                   | 筛选→分页→viewer、撤权、状态切换；仅复用fresh owned INIT1 fixture                                             |

实施Web前读局部 AGENTS/CLAUDE 和既有UI参考；保留这些无关文件及启动器补丁，不把它们纳入本slice。8A2只在以上同一链条追加合同/SQL/控件/测试；options若被选定再新增该方法，不创建新搜索服务。

Web状态必须以 userId+familyId+canonical filters 为身份：应用/清除/URL前进后退都清空旧items/cursor/viewer，首屏加载期间不显示上一个条件的结果。AbortController 或 request generation 验证阻止迟到成功/失败/finally覆盖新请求；账户切换/401清空。filter变化不复用旧cursor；loadMore去重且按当前generation接收。收藏视图内取消收藏、trash后重新取**当前filters**首屏，不能误调用无条件timeline恢复不匹配结果；viewer详情仍独立授权。日期/相册控件使用明确标签，空结果保留控件可清除；不做虚构结果数量。

## 8. 查询/验收矩阵

| 编号      | 最小验收与失败条件                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1        | 未知/重复/数组参数、无效BIGINT、空/指数limit、坏日期/闰日/反向范围、cursor超长/非canonical/旧版本/坏JSON/scope错 →400；合法单边/同日/极值日期通过                                                               |
| Q1        | 8种条件组合：无、时间、相册、收藏、时间+相册、时间+收藏、相册+收藏、三者；时间另测仅起/仅止、边界.000/.999、闰日、CAPTURE_LOCAL及UPLOAD_UTC、DST设备时区不同结果一致                                            |
| A1        | owner、FAMILY、明确can_view命中；CUSTOM无grant的MEMBER/ADMIN/SUPER_ADMIN均不命中；跨family、inactive actor/session、撤权等待family锁后重新检查                                                                  |
| A2        | 同媒体A可见/B隐藏：无条件一次、jump A；filter A命中、filter B空且不泄露名称；多个可见placement去重；删除相册/移除最后placement/orphan均消失                                                                     |
| L1        | trash与purge_intent各自排除；favorite/tag仍保留不能复活；恢复后仅有当前合法placement才命中；processing非READY仍沿用旧行规则                                                                                     |
| F1        | 两成员收藏不同，同media；仅查当前member、跨账号cursor不混用、取消收藏下一请求消失；isFamilyFeatured不能替代isFavorite                                                                                           |
| P1        | 同毫秒多BIGINT ID（含超JS安全整数）多页无重复/遗漏；不同limit scope错；filter变化scope错；cursor行删除后仍可翻页；精确满页末页nextCursor=null（limit+1）                                                        |
| P2        | 分页间权限/placement/trash/favorite改变符合当前授权；记录不是snapshot，不以并发新增造成自然遗漏判算法错误；旧无条件timeline合同回归                                                                             |
| U1        | 应用/清除/URL恢复、桌面/窄屏、空状态、迟到响应、401、账户切换、收藏取消/Trash refresh；viewer/derived重验，未把旧页混入新filters                                                                                |
| O1        | 相册选项隐藏/删除/他家均不出现，多页可加载，零媒体可见album可出现，无counts；错误响应no-store，日志无query                                                                                                      |
| X1（8A2） | canonical与重复receipt不同名字/上传者，只canonical匹配；同family dedupe不跨family；隐藏receipt关系不当授权；%，_，!、Unicode组合字符、大小写重音行为与批准规则一致；tag/member options只源于V；同名不同ID不合并 |

Targeted顺序：contract/API/service单测 → DEV真实MySQL search integration及必要permission/lifecycle竞争测试（skip=0，串行隔离）→ Web单测/typecheck →真实HTTPS小slice retries0。新增测试应证明权限/组合/并发等行为，不镜像SQL字符串。失败修复后只重跑受影响集；完整Phase8尚未完成，不运行或冒称milestone fullgate。本轮没有实际执行上述矩阵。

## 9. 索引与有界性能验收

现有：`idx_media_items_family_timeline(family_id,timeline_key,id)`；`uq_album_media_placement(family_id,album_id,media_id)`、`idx_album_media_media(family_id,media_id,album_id)`；albums family/deleted/id、family/owner；album_members album/member unique与family索引；favorites unique(family,member,media)与member时间索引；tags family/nameNormalized unique、media_tags unique(family,media,tag)和(family,tag,media)；source receipt主键/同family约束。时间线索引不是ACL索引，GROUP BY/排序可能使用临时结果；LIKE `%literal%`不声称可利用前缀索引。

实施验收以DEV专用owned合成约1万media、5成员、可见/隐藏/重复placement、稀疏/密集favorite与时间分布做一次有界EXPLAIN（普通EXPLAIN先行，必要再对owned数据EXPLAIN ANALYZE）。只覆盖Q1八组合的首/深页及极窄命中，8A2以后追加其过滤组合，不排列所有无限组合。保存SQL形状、参数类别、计划、rows examined/返回数、临时排序和耗时；不输出私人数据。避免会话内长时间持family锁进行压力循环。

通过条件：正确结果不变、family关联完整、没有每结果N+1或先无限取全量到JS；有界1万规模下单请求无既有API/DB超时、无不可接受family锁阻塞（与同机旧timeline基线及项目实际timeout对比，记录数值而非编造SLA）。单次filesort或扫描1万family行不是自动blocker；出现跨family无界放大、超时或明显锁饥饿才停实施报具体计划证据。优先在本批准SQL边界内调整固定查询形状，不能以猜测新增索引/FULLTEXT/冗余列、Redis/Elasticsearch或migration；真需要这些需协调方重新限定批准。

## 10. 交接与停止条件

Sol可执行8A1，最终交接真实diff、测试/skip数、EXPLAIN证据、剩余问题；review只覆盖搜索与直接回归。测试通过不是安全证明。8A2重要产品选择一次确认后才实施；非阻塞优化不延长8A1。

立即停止并保存进度：需要改变权限/transaction/locking/schema/Auth不变量；需要现有root维护、真实媒体、生产或外发数据；额度耗尽或可验证额度重置；最迟 **2026-10-02 20:00 UTC（北京时间10月3日04:00；用户已延长并覆盖原18:00限制）**。不reset、不额外付费，不把时刻传闻当已重置；读不到额度就明确未知。协调方记录的基线weekly used68%、resetsAt1791340206仅用于检测，不声称本轮独立读取了余额。

范围外：地图/GPS/geocoder/国家城市、AI、所有重复upload receipt搜索、公开分享搜索、媒体写入/purge、root升级、生产验证、提交/推送认证修复、Phase9。完整Phase8所有slice完成后才运行milestone gate并做最终限定复核；此文不标记Production Ready。

## 产品确认补充（实施方记录，非新增Astra审查）

2026-10-02 18:25 UTC，用户对集中呈现的首次canonical来源/披露/历史归属、literal大小写和重音敏感、单Tag整组推荐明确回复“是的”。因此按§6既有受限合同实施非地点搜索完整批次，无schema/permission/locking/Auth变更。选项采用strict kind/limit/cursor；numeric afterId封装在绑定kind/family/user/limit的canonical cursor中，不另外接收裸afterId，落实本节的分页scope要求。该运输形式需独立复核；这不是由实施方追加安全设计批准或代签closure。旧media cursor升级version2并拒绝version1。实施/真实证据见 `PHASE-08-NONLOCATION-SEARCH-BATCH.md`；独立复核待执行。

当前实现已通过限定独立复核及 `PHASE-08-NLS-R1-CLOSURE.md` 的CLOSED/PASS；用户授权本地checkpoint、不push。此前“独立复核待执行”为历史记录，最新状态见 `PHASE-08-NONLOCATION-CHECKPOINT.md`。地图/GPS仍未批准实施。
