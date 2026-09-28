# Phase 6 — Album Features Design

日期：2026-09-27。性质：R3-DESIGN；仅设计，不代表功能、migration 或下载 capability 已实现。

## 1. Scope reconciliation

基线：`main`，HEAD 与 `phase-5-complete` 都是 `039e59ca129796d14c2a78f087c681e313fbdbc6`。Phase 5 COMPLETE，PRODUCTION_READY = NO。产品工作区干净；仅已知生成文件 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md` 未跟踪，本轮不修改。

本阶段只补个人收藏、家庭精选、标签、媒体备注、评论、原图/预览下载与 Web 交互。不实现搜索、地图、回忆、Trash、管理员面板、转码或新的分享能力。

依据：PROJECT / ARCHITECTURE / ROADMAP / UI_REFERENCE / DATABASE_SCHEMA、Phase 5 Final Summary，以及下面列出的真实实现。旧逻辑文档的阶段状态、Sharp/Bridge 描述不是本阶段替换现有 native pipeline 的依据。

## 2. Existing implementation inventory

### 2.1 实证与数据库

本轮只读连接 `family_album_dev`，确认 MySQL `9.7.2`、应用用户非 root、native FK = 1、foreign_key_checks = 1。查询 information_schema，不读取家庭业务行或媒体；`assertMigrationReadiness()` PASS。

读取并核对 0000–0005 SQL 的建表/约束、对应 snapshot 表集合、`meta/_journal.json`，与 live readiness 一致：

| Migration                | 现有对象                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| 0000 identity foundation | users / families / family_members / invitations / sessions               |
| 0001 albums permissions  | albums / album_members                                                   |
| 0002 storage uploads     | storage_objects / upload_sessions                                        |
| 0003 media processing    | media_items / background_jobs / derived_assets；receipt composite unique |
| 0004 album media         | album_media                                                              |
| 0005 sharing             | shares / share_events                                                    |

实际共 15 个应用表，加 `__drizzle_migrations`。没有 Phase 6 五个表，没有 media note/description 列。实际主键是 **BIGINT UNSIGNED AUTO_INCREMENT**，不是逻辑 UUID；仅特定 public upload identity 等采用 binary。API IDs/revisions 全部十进制字符串。

### 2.2 逻辑 DATABASE_SCHEMA 全项对账

下表中的“映射”表示逻辑能力已有可信存储位置，不表示可以查询同名列。NOT_IMPLEMENTED 不等于本阶段都要补齐。

| 逻辑表/字段                                                                        | 分类                          | 真实实现 / Phase 6 处理                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| users：id、username、username_normalized、password_hash、display_name、disabled_at | EXISTS_AND_USABLE             | 同名列；normalized 为 VARBINARY                                               |
| users.avatar_media_id                                                              | NOT_IMPLEMENTED               | 不在 Phase 6 新增                                                             |
| families                                                                           | EXISTS_AND_USABLE             | 原 family boundary                                                            |
| family_members.role                                                                | EXISTS_AND_USABLE             | SUPER_ADMIN / ADMIN / MEMBER；disabled_at / left_at                           |
| invitations / sessions（token hash）                                               | EXISTS_AND_USABLE             | 不改变 auth 模型                                                              |
| devices                                                                            | NOT_IMPLEMENTED               | 延后                                                                          |
| albums.visibility / owner_member_id                                                | EXISTS_AND_USABLE             | FAMILY/CUSTOM；原权限引擎                                                     |
| album_members 五个 permission bits                                                 | EXISTS_AND_USABLE             | 原 CHECK 与 family composite FK                                               |
| storage_objects：family/hash/byte_size unique、byte_size、sha256                   | EXISTS_AND_USABLE             | canonical immutable identity                                                  |
| storage_objects.storage_key                                                        | NOT_IMPLEMENTED               | 刻意不存任意路径；key_version + identity，由 storage 内部解析；不补此列       |
| storage_objects.original_filename                                                  | EXISTS_AND_USABLE（映射）     | 实际在 source upload receipt.original_filename；不是可信 header 文本          |
| storage_objects.mime_type                                                          | EXISTS_AND_USABLE（映射）     | media_items.detected_mime；reported_mime 不可信                               |
| storage_objects.extension                                                          | NOT_IMPLEMENTED               | 不需要新增；下载用固定安全后缀映射                                            |
| storage_objects.health_status                                                      | EXISTS_AND_USABLE（映射）     | state = AVAILABLE/MISSING/CORRUPT                                             |
| media_items 基表                                                                   | EXISTS_BUT_NEEDS_CHANGE       | 仅新增 description 与独立 note_revision                                       |
| media_items.media_type PHOTO/VIDEO/OTHER                                           | EXISTS_AND_USABLE（映射）     | 实际 UNKNOWN/IMAGE/VIDEO/OTHER；不改 enum                                     |
| media_items.captured_at                                                            | EXISTS_AND_USABLE（映射）     | captured_local_at / captured_at_utc / offset/source/status；不得猜 timezone   |
| media_items.uploaded_at                                                            | EXISTS_AND_USABLE             | 同名                                                                          |
| media_items.uploaded_by_member_id                                                  | EXISTS_AND_USABLE（映射）     | source_upload_id → upload_sessions.created_by_member_id，首次 provenance 不改 |
| media_items.width/height                                                           | EXISTS_AND_USABLE（映射）     | raw_width/height 与 display_width/height                                      |
| media_items.duration_ms                                                            | EXISTS_AND_USABLE             | BIGINT，现有 CHECK                                                            |
| media_items.description                                                            | NOT_IMPLEMENTED               | 0006 新增，无重复 notes 表                                                    |
| media_items.favorite candidate metadata                                            | NOT_IMPLEMENTED               | 不做 AI candidate；个人收藏用独立关系表                                       |
| media_items.trash fields                                                           | NOT_IMPLEMENTED               | Phase 7，不在本轮伪装已有 soft-delete                                         |
| media_metadata 表 / extended EXIF JSON                                             | NOT_IMPLEMENTED               | 常用 metadata 已规范化在 media_items，额外原始 JSON 不补                      |
| media_locations 表                                                                 | NOT_IMPLEMENTED               | 不新增位置表                                                                  |
| media_locations.lat/lng                                                            | EXISTS_AND_USABLE（映射）     | media_items.gps_latitude/gps_longitude；Phase 6 DTO 不暴露                    |
| altitude/country/region/city/place_name                                            | NOT_IMPLEMENTED               | 不补地理编码                                                                  |
| album_media                                                                        | EXISTS_AND_USABLE             | 多 placement，canonical media 不变                                            |
| user_favorites / family_featured / tags / media_tags / comments                    | NOT_IMPLEMENTED               | 0006 创建                                                                     |
| upload_events 表                                                                   | NOT_IMPLEMENTED               | upload_sessions 已保存上传/重复 receipt；不再建事件表                         |
| derived_assets：THUMBNAIL/PREVIEW                                                  | EXISTS_AND_USABLE             | READY + current generation/recipe、安全 reader                                |
| derived_assets：VIDEO_POSTER/FUTURE_TRANSCODE                                      | NOT_IMPLEMENTED（可交付能力） | 部分 job/kind 预留不等于处理已交付；不在 Phase 6 开启                         |
| background_jobs                                                                    | EXISTS_AND_USABLE             | lease/epoch/generation 不变                                                   |
| audit_logs                                                                         | NOT_IMPLEMENTED               | 现有日志不是 durable audit；share_events 只服务分享                           |
| system_settings / backups / integrity_runs / integrity_issues / memories           | NOT_IMPLEMENTED               | runtime storage checks 不等于这些逻辑表，全部延后                             |

### 2.3 直接复用的代码边界

- `packages/db/src/album-repository.ts`：`MySqlAlbumRepository`、`withVisibleAlbum`、`mutatePlacement`，family mutex 与锁后授权。
- `packages/permissions/src/index.ts`：`evaluateAlbumPermissions`；role 明确不参与 album bypass。
- `packages/db/src/transaction.ts`：`runTransaction`；最多 3 次、仅明确回滚 deadlock 重试；COMMIT unknown 不 replay。
- `packages/db/src/derived-read-repository.ts`：`findReadyDerivedInAlbum` 返回 READY/current identity，但本身不替调用者做用户授权。
- `apps/api/src/derived-serving/service.ts`：`DerivedReadService` / `DerivedByteReader`；当前是 bounded derived Buffer，不是 original stream。
- `packages/storage/src/index.ts`：`OriginalReader.withVerifiedOriginal`、opaque `VerifiedOriginalHandle`，callback finally close。
- `packages/storage/native/storage_native.c`：`open_original_reader`、`open_verified_original`、`consume_original_handle`：marker/root/dirfd confinement、O_RDONLY、regular file、same-device、mode0400/nlink1、同 FD full SHA/size、前后 inode/mtime/name identity 检查。
- `packages/contracts/src/gallery.ts` 与 `shares.ts`：**publicSharePageSchema 当前复用 galleryMediaItemSchema**；`PublicShareService.openAlbum` 也复用 `galleryMediaItem` mapper。私人字段扩展前必须拆开公共 DTO/mapper。

## 3. Phase 5B inherited complete

`PHASE_6_INHERITED_COMPLETE`：add/remove placement、一个 media 多 albums、移除 placement 不修改 original/storage/derived/canonical identity。保留原 add(upload 或 edit)/remove(delete) 权限和 album revision 协议。不把本阶段 tags/comments 删除解释为删除 media。

后续回归：两个相册引用同一 media；移除其中一个后另一个仍可见；移除最后可见 placement 后收藏、评论、下载全部不可访问；source_upload_id/hash/path/derived 均不变。

## 4. Data model — proposed 0006

以下是精确设计，不是已经生成的 DDL。全部 InnoDB、utf8mb4_0900_ai_ci；文字 canonical uniqueness 使用 VARBINARY，不依赖 ai_ci。`ID` = BIGINT UNSIGNED；每表 `id ID PRIMARY KEY AUTO_INCREMENT`。所有字段默认 NOT NULL，除明确 NULL；`created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`。所有 FK ON UPDATE RESTRICT / ON DELETE RESTRICT，无 cascade。

### 4.1 user_favorites

字段：id、family_id ID、member_id ID、media_id ID、created_at。

- `uq_user_favorites_identity(family_id,member_id,media_id)`。
- `idx_user_favorites_member_time(family_id,member_id,created_at,id)`。
- `idx_user_favorites_media(family_id,media_id)`。
- `fk_user_favorites_member(family_id,member_id)` → family_members(family_id,id)。
- `fk_user_favorites_media(family_id,media_id)` → media_items(family_id,id)。

不单独存 user_id；服务端从当前 user 的 active family_member 派生 member_id，不接受 caller 指定。

### 4.2 family_featured

字段：id、family_id ID、media_id ID、featured_by_member_id ID、created_at。

- `uq_family_featured_identity(family_id,media_id)`。
- `idx_family_featured_time(family_id,created_at,id)`。
- `idx_family_featured_actor(family_id,featured_by_member_id)`。
- `fk_family_featured_media(family_id,media_id)` → media_items(family_id,id)。
- `fk_family_featured_actor(family_id,featured_by_member_id)` → family_members(family_id,id)。

重复 feature 不覆盖首次 actor/time；unfeature 后重新 feature 是新的记录。撤销事件记录当前 actor，不冒用 featured_by。

### 4.3 tags

字段：id、family_id ID、name VARCHAR(64)、name_normalized VARBINARY(256)、created_at。

- `uq_tags_identity(family_id,name_normalized)`；`uq_tags_family_id(family_id,id)`。
- `fk_tags_family(family_id)` → families(id)。
- `chk_tags_name`：CHAR_LENGTH(name) BETWEEN 1 AND 64 AND OCTET_LENGTH(name) <= 256。
- `chk_tags_normalized`：OCTET_LENGTH(name_normalized) BETWEEN 1 AND 256。

DB 不自行实现 Unicode normalization；由唯一规范化 helper 保证。名称首个成功创建值保留，重复不改大小写展示。不提供 rename/global delete。

### 4.4 media_tags

字段：id、family_id ID、media_id ID、tag_id ID、created_at。

- `uq_media_tags_identity(family_id,media_id,tag_id)`。
- `idx_media_tags_tag(family_id,tag_id,media_id)`。
- `fk_media_tags_media(family_id,media_id)` → media_items(family_id,id)。
- `fk_media_tags_tag(family_id,tag_id)` → tags(family_id,id)。

不把 tag author 当权限来源；操作者进入白名单日志。每 media 最多 64 个 tags，在 media 锁内计数后新增；已存在关联即使达到上限仍幂等成功。孤立 tag 可保留，但不对用户枚举。

### 4.5 comments

字段：id、family_id ID、media_id ID、author_member_id ID、body VARCHAR(2000)、created_at。

- `idx_comments_media_time(family_id,media_id,created_at,id)`。
- `idx_comments_author(family_id,author_member_id)`。
- `fk_comments_media(family_id,media_id)` → media_items(family_id,id)。
- `fk_comments_author(family_id,author_member_id)` → family_members(family_id,id)。
- `chk_comments_body`：CHAR_LENGTH(body) BETWEEN 1 AND 2000 AND OCTET_LENGTH(body) <= 8000。

V1 create/list/delete own；**edit own 延后**，故无 edited_at/revision，无点赞/管理员 moderation。只删除自己的评论行不是删除媒体或 original。

### 4.6 media_items additive columns

- `description VARCHAR(4000) NULL DEFAULT NULL`。
- `note_revision BIGINT UNSIGNED NOT NULL DEFAULT 1`。
- `chk_media_items_description`：description IS NULL OR (CHAR_LENGTH(description) BETWEEN 1 AND 4000 AND OCTET_LENGTH(description) <= 16000)。
- `chk_media_items_note_revision`：note_revision >= 1。

独立 note revision；不复用 pipeline generation 或 album revision。原 processing metadata 更新必须只 SET 自己列，不覆盖 description/note_revision。旧行自动 NULL/1，无外部媒体 backfill。

以上新 CHECK 共 5 个，新 FK 共 9 个；索引显式覆盖 FK 左前缀。真实 6A 生成 SQL/snapshot 后再次审查，不将本数字替代 DDL 验证。

## 5. Permission matrix and transaction protocol

所有新 private endpoints 都要求有效 Web session、当前 user enabled、active same-family membership、指定 album 未删除、**当前 album_media placement**、统一 engine 的 can_view。下面的权限是这些基础条件之外的增量；owner 通过引擎获得权限，ADMIN/SUPER_ADMIN 从不 bypass。

| Operation                                  | can_view | can_edit | role / ownership                            | recent-auth |
| ------------------------------------------ | -------- | -------- | ------------------------------------------- | ----------- |
| Favorite read/PUT/DELETE                   | 必须     | 否       | 仅当前 member 的状态                        | 否          |
| Featured read                              | 必须     | 否       | 任意 active member                          | 否          |
| Featured PUT/DELETE                        | 必须     | 否       | 当前 ADMIN/SUPER_ADMIN                      | 否          |
| Tags list                                  | 必须     | 否       | 无 role bypass                              | 否          |
| Tag create+apply / apply existing / remove | 必须     | 必须     | selected album context                      | 否          |
| Note read                                  | 必须     | 否       | 无 role bypass                              | 否          |
| Note PUT                                   | 必须     | 必须     | selected album context                      | 否          |
| Comments list/create                       | 必须     | 否       | author 从 session 派生                      | 否          |
| Comment delete                             | 必须     | 否       | comment.author_member_id = actor member     | 否          |
| Comment edit                               | 不提供   | —        | Phase 6 不开放                              | —           |
| Original / preview download                | 必须     | 否       | selected album context，public share 不适用 | 否          |

不新增 recent-auth 门槛；当前 auth、Origin/CSRF、Cookie、Bearer conflict、rate-limit 规则不变。mutation strict JSON，拒绝额外 family/member/owner/role/permission/storage/revision 字段。

新 repository 使用现有 transaction helper，统一锁序：families → users → sessions → family_members → albums → album_members → media_items → album_media → Phase 6 关系行。多 ID 数值升序；不会从 comment/tag 锁反向取得 family/media 锁。继承 family 粗粒度 mutex，不引入新 retry 框架。先前无锁 locate 仅用于找到 family，不能据此授权。

取得全部所需锁后单独读取 DB server time，复核 session/token/client/expiry/idle、user/member；再做 album/placement/media visibility，再做 can_edit/role/author 检查，最后条件 mutation。新媒体可操作性与现有 gallery 的可见性/processing/storage eligibility 保持一致；不可借 Phase 6 读出 gallery 已排除的 BLOCKED/不可用条目。

基础登录失效401；hidden/deleted/cross-family/no-placement/no-view统一404；已确认可见才可以403（无 edit、无 role、非作者）。不存在或不属于该 media 的comment为404；tag读取/引用失败为404，关联的幂等DELETE按第9节统一无副作用成功，不泄漏另一media的实体。隐藏目标media不因角色、revision、幂等检查而出现另一错误。

family mutex使 Phase 2 ACL/disable/placement mutations 与新操作有明确提交顺序。读列表在同一受控 transaction 内 SQL 过滤再 LIMIT；不先授权后在另一连接无条件读取正文。不为家庭操作持有锁跨 HTTP 传输或文件 hash。

## 6. API contract

以下 `P = /api/v1/albums/:albumId/media/:mediaId`。IDs/revisions：复用 unsignedBigIntStringSchema，禁止 Number 转换；日期 UTC ISO毫秒。所有对象 strict；GET 不接受 body；无 body mutation 使用空 JSON `{}` 以沿用 JSON guard。新文本请求 body 总大小上限 24 KiB，先限制请求体再解析。所有新 private 响应 private,no-store。

| Method/path                  | Request                               | Success                                    | Authorization / idempotency                                                         |
| ---------------------------- | ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| GET P（已有 detail 扩展）    | 无                                    | 200 detail，见14                           | view；只读                                                                          |
| PUT P/favorite               | `{}`                                  | 200 `{isFavorite:true}`                    | view；重复不改变created_at                                                          |
| DELETE P/favorite            | `{}`                                  | 200 `{isFavorite:false}`                   | view；不存在自己的关系也成功                                                        |
| PUT P/featured               | `{}`                                  | 200 `{isFamilyFeatured:true}`              | view + role；幂等                                                                   |
| DELETE P/featured            | `{}`                                  | 200 `{isFamilyFeatured:false}`             | view + role；先授权再幂等                                                           |
| GET P/tags                   | 无                                    | 200 `{tags:Tag[]}`，最多64                 | view；仅本media tags                                                                |
| POST P/tags                  | `{name:string}`                       | 200 `{tag:Tag}`                            | edit；原子 find/create tag + attach，规范化 identity 幂等                           |
| PUT P/tags/:tagId            | `{}`                                  | 200 `{tag:Tag}`                            | edit；tag必须同family且当前已在至少一处caller可见media出现；否则404；幂等           |
| DELETE P/tags/:tagId         | `{}`                                  | 200 `{removed:true}`                       | edit；只按family/media/tag删除目标关联，已不存在同样成功，不查询或披露全局tag存在性 |
| PUT P/note                   | `{note:string                         | null,expectedRevision:ID}`                 | 200 `{note:string                                                                   | null,noteRevision:ID}`         | edit；CAS；旧revision409，即使正文相同 |
| GET P/comments               | `limit=1..50(default20),cursor?<=512` | 200 `{comments:Comment[],nextCursor:string | null}`                                                                              | view；时间+ID ascending keyset |
| POST P/comments              | `{body:string}`                       | 201 `{comment:Comment}`                    | view；非幂等，不自动重发                                                            |
| DELETE P/comments/:commentId | `{}`                                  | 204                                        | view+author；重复删除404，不假称无条件幂等                                          |
| GET P/download/original      | 无 query/body                         | 200 attachment stream                      | view；只读，不是签名URL                                                             |
| GET P/download/preview       | 无 query/body                         | 200 image/webp attachment                  | view + current READY preview；只读                                                  |

`Tag={id:ID,name:string}`。`Comment={id:ID,body:string,createdAt:timestamp,author:{memberId:ID,displayName:string},canDelete:boolean}`；不返回username、session、email等。作者显示名取已有 display_name；失活作者仍可展示历史署名，不恢复其访问权。`commentCount` 用十进制非负字符串，避免 COUNT 转 Number。

新增 contracts：favoriteStateSchema、featuredStateSchema、mediaTagSchema、createMediaTagSchema、mediaTagsResponseSchema、updateMediaNoteSchema、mediaNoteResponseSchema、createMediaCommentSchema、mediaCommentSchema、mediaCommentPageSchema、mediaCommentQuerySchema、privateMediaCapabilitiesSchema；重用 gallery params；明确区分 publicGalleryMediaItemSchema 与 private gallery schema/mapper。

错误继续 `{code,message,requestId}`：400 INVALID_REQUEST（strict shape/Unicode/上限），401 UNAUTHENTICATED，403 FORBIDDEN，404 NOT_FOUND，409 CONFLICT（note revision），429 RATE_LIMITED，503 SERVICE_UNAVAILABLE。preview未READY在可见性确认后404 NOT_FOUND，UI显示“预览暂不可下载”；缺失/损坏original或storage unavailable统一503，不输出 native reason/path/hash。COMMIT unknown与rollback failure统一503，日志只保留安全类别。若实际共享code union缺少某项，在6A contracts显式添加而非临时字符串。不得把数据库错误原文返回。

## 7. Personal favorites

作用域是 family member，不是全家/全局。所有 add/remove/read先当前可见性；失去所有可见placement后关系可留存但响应不能返回此media、缩略图、计数或历史收藏状态。恢复可见性后恢复显示既有收藏。

唯一键 + family锁；重复成功按完整family/member/media查到原行才可收敛，不能吞任意1062。收藏列表/搜索暂不新增；未来列表必须SQL EXISTS当前visibility后分页，不从favorite行直接取media。禁止返回“谁收藏了”或全家favoriteCount。

## 8. Family featured

ADMIN/SUPER_ADMIN可以管理自己当前能view的media，不要求can_edit；这不是授予它们隐藏media权限。普通成员只对自己可见media读精选状态。精选不改变album visibility、不创建placement、不影响public share。

角色降级/停用与feature并发按family锁先后线性化；授权在幂等之前。历史featured_by不自动获得权限；actor停用不自动删除已精选记录。

## 9. Tags

`tag-v1`：先拒绝 malformed Unicode；NFKC → trim Unicode whitespace → 内部Unicode whitespace折叠为单个ASCII space → 拒绝剩余Cc/Cf（含零宽/双向格式控制）→ 展示name；normalized = locale-independent lowercase(name)。两者分别检查1–64 code points、UTF-8<=256 bytes，拒绝空。先对原输入设256 code points/1024 bytes上限，避免无界normalization。写VARBINARY存normalized UTF-8 bytes。

Trip/trip/全角/首尾空格收敛，组合字符收敛；é与e、ß与ss不擅自合并。不做accent stripping或locale casefold。

创建只通过已授权media的POST，tag与association同transaction成功/回滚；不提供独立全家tag字典枚举，避免泄漏hidden-only tag词汇。已存在同family规范化名称可在POST按用户已提供的名称复用，但只返回该名称/id，不返回hidden media、creator、关联数量。PUT既有id采用可见tag限制；规范化身份碰撞仅在指定unique+完整identity验证后收敛。

移除只删media_tags，不删tag或media。DELETE 的 removed:true 表示目标关联最终不存在，不表示这次确实删除一行；不存在、另一family或另一media的tagId同样无副作用且不披露它们的存在。POST/PUT引用跨family tag则404。这样同一tag移除两次稳定成功，不通过global existence查询建立oracle。不做批量replace、跨family引用、rename合并。正文/tag均纯文本，不做HTML/Markdown解析。

## 10. Canonical notes

真实没有description，增加该列不建notes表。读需要当前view，写需要指定placement上的edit。**在一个相册修改备注，会改变同一canonical media在其他有权相册中的备注。** Viewer保存前明确提示“此备注用于这张照片的所有相册”。

note：拒绝不合法Unicode及NUL；CRLF/CR统一LF；保留普通Unicode、空格与emoji，不做NFKC/lowercase，不生成时区/GPS。全空白转NULL，非空内容不随意trim；最多4000 code points/16000bytes。CHECK作为存储兜底，不替代API验证。

`UPDATE media_items SET description=?,note_revision=note_revision+1 WHERE family_id=? AND id=? AND note_revision=?`；affectedRows=1，最大unsigned值拒绝继续增长。对相同revision即使同正文也推进一次；并发只有一个成功，另一个409。client refresh后显式重试，COMMIT unknown不自动重放。pipeline不SET note字段；note不SET processing/generation/source/storage字段。

## 11. Comments

V1只list/create/delete own。body malformed Unicode/NUL拒绝；newline规则同note；1–2000code points/8000bytes，trim后全空白拒绝，正文保留。React文本节点渲染，不dangerouslySetInnerHTML。

author由当前member派生，不信body中的authorId。删除再次验证当前visibility及author；ADMIN不得删除别人的评论。无当前placement或失去view时，历史author身份不允许编辑/删除/读取。

分页 `(created_at,id)` keyset，cursor严格schema，追加family/media WHERE，limit+1判定hasMore；timestamp相同用ID稳定排序。删除并发：一次204、其他404。POST commit不明显示“结果待确认，请刷新”，不自动重发；不为此增加新幂等key系统。每actor评论POST进程内保守限速（20/min，复用已有有界limiter），production持久限速继续deferred。

## 12. Original download security design

### 12.1 能力缺口与批准的最小扩展

现有handle能安全verify与交给fixed child，却没有异步bounded下载读取。禁止API调用`consumeForFixedProbe`取FD，禁止`readFile(path)`或`/dev/fd` reopen。Phase6D必须先实现storage内部 **single-use verified download stream capability**，不能仅在route拼接路径。

建议接口：`OriginalReader.withVerifiedDownload(identity,{signal},async stream => await sendAndAwaitClose(stream))`。identity只来自授权DB结果 `{familyId,sha256Hex,byteSize}`；公开值不含root/path/FD。opaque stream只允许bounded顺序读与cancel；不能seek arbitrary offset、write、reopen或转成rawFD。handle真实对象验证防伪造；callback退出前等待传输结束/abort，finally关闭；root配置只在应用composition root注入。

扩展native同FD验证核心为异步工作，不把现有同步全文件hash直接放到HTTP event loop。沿用same-FD full SHA/size与前后stat/name/marker检查；验证和读取固定块<=256KiB，不把整文件存buffer；不使用probe的512MiB渲染上限限制大original，更不放宽数据库上传大小既有约束。此项是只读capability扩展，不是改变storage identity/immutability。

### 12.2 真实执行顺序

1. authenticate；短DB事务按第5节锁序校验album/view/placement及trusted media/storage AVAILABLE，media不BLOCKED；取source receipt的显示filename，仅从服务端记录取identity。
2. 释放SQL锁；获得有界download slot后，打开marker-bound opaque reader，同一个O_RDONLY FD完成完整SHA/size验证。
3. **验证可能耗时，再做一次短DB事务**：锁后server-time，复核当前session、membership、selected placement/ACL、media/storage identity及AVAILABLE。失效则close handle，不发body/header成功；禁止持有family/session锁等整个文件hash/网络传输。
4. 存储层再次检查handle identity，成功后发送attachment，通过backpressure逐块读取同FD；不得重新按path打开。
5. success、client abort、socket error、timeout、read异常全部cancel→等待in-flight read退出→exact close；禁止read/close竞态导致FD复用。queued request取消也释放slot。

授权线性化点是步骤3。该点之前revoke/remove必须拒绝；之后已经开始的下载可以完成，不能回收已发送bytes。下一请求重新认证。若未来要求传输中即时撤权，须另行设计，不假称现在提供逐chunk授权。

### 12.3 Bounded resource / failure

每进程最多2个验证/传输slot，每member1个；不排无界队列，满时429。每stream read chunk<=256KiB、单个in-flight read、backpressure下不预读无界；不要Web端fetch().blob()缓存整个视频。验证deadline120s、传输idle60s、总传输1h，取消后原生任务可协作中止；这些是DEV保守上限，production需大文件实测。

预先严格known byte size；只发送exact expected bytes，short/extra/stat变化失败；extra不发出。headers已发后异常terminate response，不附JSON到binary，不记录成功。保存bytes/hash/inode/mode/mtime的synthetic前后快照。外部高权限恶意改盘不属于OS immutable保证，但检测变化必须fail closed，绝不借此允许in-place rewrite。

不支持Range/resume/multipart/conditional304；Range header忽略并返回完整200，`Accept-Ranges: none`，不写自制range parser。这是attachment下载，不是视频播放服务；无无认证HEAD捷径。Range设计依据HTTP允许服务器忽略Range：[RFC 9110 §14](https://www.rfc-editor.org/rfc/rfc9110.html#section-14)。

### 12.4 Headers / private content

`Content-Disposition: attachment; filename="<safe-ascii>"; filename*=UTF-8''<percent-encoded>`；固定已验证encoder，只输出一次每个参数。[RFC 6266](https://www.rfc-editor.org/rfc/rfc6266.html)定义两种filename参数及不可信名称风险。

filename源自first receipt.original_filename但仍当不可信：拒绝/替换invalid Unicode、CR/LF/NUL、Cc/Cf、斜线/反斜线、引号；去路径组成、点路径、首尾空白，截断安全stem至120 UTF-8 bytes且不截断code point。ASCII fallback固定`media-<id>.<safe-ext>`，Unicode名称用编码参数。后缀由服务器固定可信MIME allowlist推导，不保留exe/html等可执行后缀；无法确认用`.bin`。不把originalFilename或path写日志。

Content-Type仅允许当前已验证detected_mime中的image/jpeg、image/png、image/webp、image/gif、image/heic、image/heif、video/mp4、video/quicktime；其余application/octet-stream。RAW/unknown仍可在view+AVAILABLE下作为不执行的attachment下载，但不绕过BLOCKED。原文件EXIF/GPS仍完整，UI明确“原文件可能包含位置与拍摄信息”，不为隐私提示修改original。

同时设置Content-Length=exact decimal size、X-Content-Type-Options:nosniff、Cache-Control:private,no-store、Referrer-Policy:no-referrer；不返回path/hash/ETag或公开cache/signed URL。只使用现有可信origin/CORS，不增加任意credentialed origins。下载审计不改变权限。

## 13. Preview download and logging

相同album-context认证；复用`findReadyDerivedInAlbum`但调用方必须先按第5节授权，再绑定同family/media/current generation/recipe1/PREVIEW/READY/cleaned_at NULL/AVAILABLE。使用现有安全DerivedByteReader核对SHA/size；4MiB上限内已有bounded Buffer可以复用，不扩大为original读取器。读取后在headers前重新授权并确认generation/READY未变化。

缺preview不即时生成、不fallback original、不返回过期generation。Content-Type image/webp、固定`media-<id>-preview.webp` attachment、nosniff/private,no-store。公开分享预览原契约保持不变。

复用现有structured logger：`media_download_started/completed/aborted/failed`，白名单requestId、actor member ID、family/album/media ID、kind、result category、bytesSent十进制、duration；completed只代表服务端流结束，不证明用户已保存。mutation事件类似记录动作/对象ID，不记录note/comment/tag正文、filename、路径、hash、token/Cookie/Authorization/raw error。当前无通用audit_logs：durable audit明确deferred，不借share_events建半套系统。

## 14. Gallery/detail and Web integration

grid/timeline仅添加`isFavorite:boolean`、`isFamilyFeatured:boolean`；不加入tags/note/comments/count/GPS。SQL先过滤当前可见媒体再分页，对页内最多100个media一次批量获取当前member收藏+精选或以unique LEFT JOIN取值，禁止逐item请求，不因JS后过滤造成短页。

detail添加`isFavorite`、`isFamilyFeatured`、`tags:Tag[]`、`note:null|string`、`noteRevision:ID`、`commentCount:decimal-string`、`capabilities:{canManageFeatured,canEditTags,canEditNote,canComment,canDownloadOriginal,canDownloadPreview}`。不嵌全量comments；展开评论单独分页。flags/capabilities都是UI提示，mutation仍实时授权。count对当前media一次聚合；detail读取在同一授权transaction内。

timeline已有albumId作为selected context；不可用时重新加载，不悄悄用隐藏album请求。同一media多placement的私人状态相同，但edit capability按selected album算。mutation完成只更新当前用户cache，避免跨账号缓存；logout/family切换清空。

保持Phase5暖白、绿色、圆角、照片优先：Viewer底部收藏/更多操作，metadata侧栏折叠标签、备注、评论；移动端收起panel。家庭精选按钮仅服务器capability允许时展示。预览/原文件下载分开文案；普通gallery只加载thumbnail/preview，不自动请求original。native浏览器attachment流，若走现有Web代理必须pipe而非buffer且传播abort。无fake cover/count/activity；不新增Search/Map/Memories入口。

## 15. Public sharing boundary

Phase6私有字段全部不进public share：favorite、featured、tags、note、comments、count、actor/capabilities。public token不能调用private endpoints、不能换session、不能original下载。

**6B扩展gallery前先拆 public DTO与mapper**：保留Phase5公开字段白名单独立schema，public service不再复用将被扩展的private mapper。不要仅靠前端不显示字段。添加exact keys断言，public响应必须不包含所有Phase6字段。分享preview观看仍由原token/expiry/revoke路径授权，不因private download新增原图或attachment权限。

## 16. Migration and deletion safety

需要新`0006`（建议tag `0006_phase_06_album_features`），只五表与media两列/两个CHECK；不改0000–0005、不改schema enum/storage path/lease/generation、无数据清空。6A同时更新Drizzle、generatedSQL、snapshot/journal和readiness PROJECT_TABLES；readiness不得通过忽略新增表来通过。

执行另需用户批准：只DEV/nonroot/MySQL9.7.2/nativeFK/fk_checks/readiness0000–0005全通过，新增对象/列不得已存在；先审DDL，MySQL DDL非整体可回滚，失败标partial migration并停止，不blind retry、不IF NOT EXISTS掩盖drift。目标schema与journal完整一致才PASS。新表RESTRICT不允许级联删除media/storage/member。

Phase7未实现：当前仅处理album软删除/placement移除带来的不可见，不凭空查询media.deleted_at。未来mediaTrash必须在统一visibility谓词加过滤；收藏/精选/tags/note/comments保留但全部不可读，restore后仍需当前ACL，不能自动重新授权。未来purge独立审查后按引用清理顺序显式删除关系；本阶段不实现purge/永久删original。

## 17. Test plan

只在各slice跑targeted；6F完整gate。所有真实DB用synthetic fixtures，native tests用受控synthetic root，不读取真实media；afterEach按明确fixture identity清理，最终0 residue。不因.env缺失skip。

- Unit/contracts：strict额外字段、BIGINT>2^53、tag idempotent normalization/Trip/全角/组合/é/ß、malformed surrogate/零宽/长度、note空白NULL/emoji/bytes、comment空白/HTML纯文本、filename CRLF/quotes/path/bidi/invalidUnicode/极长、错误envelope脱敏。
- Real MySQL schema：全部FK跨family拒绝、canonical VARBINARY唯一、CHECK长度/revision、删除父行RESTRICT、readiness exact manifest、旧media默认NULL/1。
- Repository races（两个真实连接+可控barrier）：favorite twice/DELETE twice、featured twice/角色降级、same tag normalize/create/apply/remove、note相同revision只有一个成功、comment双delete、ACL revoke/disable/placement remove与mutation。已回滚deadlock重试，任意1062不吞，COMMIT unknown不replay。
- Privacy：CUSTOM no-view、deleted/cross-family/no-placement、SUPER_ADMIN hidden、有view无edit、伪造member/author、tag跨family/hidden-only词典、历史favorite/comment失去全部view后的所有读写均404，public响应exact白名单，public original拒绝。
- Download native：wrong marker/root replacement/symlink/hardlink/FIFO/mode/uid、same-FD SHA/size mismatch、路径reopen零调用；success/abort/error/timeout保证close、FD无线性增长；验证等待时撤权后不发body；大synthetic file内存有界、backpressure、读期间异常、short/extra bytes、Range完整200、headers安全。
- Preview：not READY/old generation/cleaned/missing/corrupt、读取后generation变化、不得触发worker或fallback original。
- Preservation：note/tag/comment/favorite操作及下载前后receipt/source_upload_id、original bytes/hash/path/inode/mode/mtime、derived identity不变；pipeline更新不覆盖note。
- Web/components：viewer controls/capability、pending/error/409 refresh、无自动POST重试、comment纯文本、download非blob全buffer、loading/focus/mobile、logout cache清理，无假数据。
- Authenticated HTTPS E2E：owner/editor/viewer/hidden same-family/admin-noACL/cross-family主体，真实Cookie→HTTP→DB；收藏/精选/notes/comments权限与隐私、preview和original attachment、中断大下载、公开分享private字段缺失。
- Phase5B/C回归：many albums、add/remove placement、canonical preservation、share expiry/revoke与公开preview不扩权。性能固定页query数量，不随100items线性增长。

## 18. Phase 6 slices

| Slice | 交付边界 / Gate                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| 6A    | 五表+note字段、contracts primitives、0006审查与另行批准执行；liveFK/CHECK/readiness；不先改历史migration             |
| 6B    | public/private DTO隔离先行；favorites/featured repo/API+bulk flags；role/view/visibility-loss/race tests             |
| 6C    | tags、canonical note CAS、comments create/list/delete own；plain text与cross-family/conflict测试                     |
| 6D    | 单独完成storage异步same-FD stream capability及native安全review后，接original/preview下载；不把接口未实现当已复用     |
| 6E    | Viewer交互、私有cache、无buffer大文件下载、Web responsive和HTTPS验收                                                 |
| 6F    | 安全review→完整format/lint/typecheck/unit/API/liveMySQL/race/build/E2E，synthetic residue0；总结后等待checkpoint授权 |

本轮仅设计，未开始6A。6D若不能保持root/FD/验证/生命周期不变量，停止R3设计复核，不能fallback路径接口。

## 19. Risks / deferred items

- 当前基线P0/P1为Phase5已通过结论，本轮不是全仓安全重审；没有证据支持新增现存P0/P1。以下属于必须满足的未来实现gate，不能把它们标作已实现PASS。
- 6D高风险gate：异步full verification+stream的cancel/close竞态、hash到发送前的撤权窗口、whole-file buffering、header injection。必须native tests+targeted安全复核；无法完成则Phase6不完整。
- 6B隐私gate：public复用private schema/mapper，必须先分离。当前尚无Phase6字段泄漏，但直接extend会引入泄漏风险。
- P2 deferred：persistent production rate limiting、durable audit、真实power-loss/SSD/platform production验证沿用Phase5；大型original full hash带来首字节延迟与存储I/O压力，生产需实测。不是降低完整验证的理由。
- P3 deferred：继承HTTPS测试certificate目录清理问题。评论编辑、tag重命名、favorite搜索/filter、Range、传输中即时撤权为明确非V1功能，不伪装为已完成。
- 不能承诺用户下载original后没有GPS；原始metadata存在是产品选择，保持immutable并提示。新文本和标签默认仅家庭私有。

## 20. Acceptance criteria and decision

本轮实证：Git基线、真实表/列、readiness0000–0005、MySQL安全状态已只读确认；未运行feature tests、migration、bootstrap或业务写入。功能测试为后续计划，不沿用Phase5结果冒充Phase6PASS。

Phase6完成需要：0006安全执行并readiness PASS；权限矩阵全部实现且真实races通过；public DTO零private字段；原始流capability通过安全验证和abort资源回收；原始媒体未变；三种client角色HTTPS验收及完整gate0skip/0residue。所有P0/P1关闭才可声明完成；生产仍须单独批准。

```text
DESIGN_PASS: YES
DATABASE_MIGRATION_REQUIRED: YES (0006, not created)
PRODUCTION_AUTH_CHANGE_REQUIRED: NO
PHASE_3_STORAGE_REDESIGN_REQUIRED: NO
ORIGINAL_DOWNLOAD_CAPABILITY_EXTENSION_REQUIRED: YES
READY_FOR_PHASE_06A: YES
PHASE_6_IMPLEMENTED: NO
```

本设计批准新增Phase6授权规则与最小只读stream capability，不授权修改原有auth/session/album权限算法、immutable identity或进入Production。
