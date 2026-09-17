# PHASE_2_GUARDRAILS — Albums & Permission Engine

日期：2026-09-15。范围：Phase 2 安全设计与 implementation guardrails；未实现业务代码、生成/运行 migration 或操作数据库。

DESIGN_CHANGE_REQUIRED: NO

DATABASE_MIGRATION_REQUIRED: YES

这里的 NO 表示无需推翻 Phase 1 Auth/Session/角色设计或项目相册产品规则；本文新增 Phase 2 的具体授权、并发和 contract 约定，并在既有锁层级末尾追加相册层级。YES 表示后续实现必须为 albums/album_members 创建新版本 migration，本次没有创建或执行它。

依据：[PROJECT](../../project-spec/PROJECT.md) 第 4 节、[ARCHITECTURE](../../project-spec/ARCHITECTURE.md) 第 18 节、[ROADMAP](../../project-spec/ROADMAP.md) Phase 2、[数据库逻辑模型](../../project-spec/database/DATABASE_SCHEMA.md)、[Phase 1 Final Summary](PHASE-01-FINAL-SUMMARY.md)，以及当前 permissions、contracts、family/member schema。Phase 1 的 4 项 deferred P2 和 1 项 P3 保持原状态，不将其视为本轮已修复。

## 1. 最终决策

- 使用 FAMILY / CUSTOM 两种 visibility，不增加 PUBLIC、链接分享或继承状态；默认 CUSTOM。
- 使用五个显式 boolean grant，不引入相册角色、deny、优先级或 policy DSL。
- 有效 Owner 隐式拥有全部五权限；Owner 单独保存在 albums，不另建一条 Owner ACL，避免两种权威来源。
- FAMILY 仅向有效本家庭成员开放 view。upload/edit/delete/manage_members 必须由 Owner 或显式 grant 获得。
- 家庭 SUPER_ADMIN / ADMIN 没有任何 album bypass。Family role 不进入相册内容权限计算。
- Owner 专有操作：改变 visibility、删除整个相册、授予/撤销 manage_members。Phase 2 不提供 Owner 转移或相册恢复/硬删除接口。
- 所有相册请求逐次服务端授权；所有相册读写使用同一家庭锁协议和锁后有效性判断，不使用缓存权限或旧 session identity 作最终授权。

## 2. Final schema

仅新增两张表。使用现有 MySQL 9.7.2 环境，InnoDB、utf8mb4；延续 BIGINT UNSIGNED、DATETIME(3)/UTC、Native FK 与 CHECK 验证方式。此处列出的兼容性须在 migration review/真实 DEV 测试中验证，不把文档设计当作 DDL 已运行证据。

### albums

| 字段            | 类型/约束                                         | 语义                                        |
| --------------- | ------------------------------------------------- | ------------------------------------------- |
| id              | BIGINT UNSIGNED PK AUTO_INCREMENT                 | 不可变                                      |
| family_id       | BIGINT UNSIGNED NOT NULL                          | 不可变，FK families.id                      |
| owner_member_id | BIGINT UNSIGNED NOT NULL                          | 创建者在该 family 的 member；Phase 2 不可变 |
| name            | VARCHAR(128) NOT NULL                             | 普通文本，无 HTML                           |
| description     | VARCHAR(2000) NULL                                | 普通文本，无 HTML                           |
| visibility      | ENUM('FAMILY','CUSTOM') NOT NULL DEFAULT 'CUSTOM' | 可见范围                                    |
| revision        | BIGINT UNSIGNED NOT NULL DEFAULT 1                | 整个相册及 ACL 的并发版本                   |
| created_at      | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) | 创建时间                                    |
| updated_at      | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) | 相册或 ACL 变更时间                         |
| deleted_at      | DATETIME(3) NULL                                  | 软删除；NULL 为 active                      |

索引：PRIMARY(id)、uq_albums_family_id UNIQUE(family_id,id)、idx_albums_family_deleted_id(family_id,deleted_at,id)、idx_albums_family_owner(family_id,owner_member_id)。

外键：fk_albums_family(family_id) → families(id)；fk_albums_owner_member(family_id,owner_member_id) → family_members(family_id,id)。复用现有 uq_family_members_family_id，数据库直接禁止跨家庭 Owner。

CHECK：chk_albums_revision(revision >= 1)、chk_albums_deleted_at(deleted_at IS NULL OR deleted_at >= created_at)。name 非空及 Unicode 输入规范在 contract 执行，不依赖 SQL trim/collation 判断产品规则。

### album_members

| 字段               | 类型/约束                                         | 语义                                                |
| ------------------ | ------------------------------------------------- | --------------------------------------------------- |
| id                 | BIGINT UNSIGNED PK AUTO_INCREMENT                 | ACL 行标识                                          |
| family_id          | BIGINT UNSIGNED NOT NULL                          | 用于复合 FK 的边界字段，不由 ACL 请求提供           |
| album_id           | BIGINT UNSIGNED NOT NULL                          | 所属相册                                            |
| member_id          | BIGINT UNSIGNED NOT NULL                          | family_members.id，不是 users.id                    |
| can_view           | BOOLEAN NOT NULL DEFAULT FALSE                    | 显式 view grant                                     |
| can_upload         | BOOLEAN NOT NULL DEFAULT FALSE                    | 未来向相册上传/加入内容的能力                       |
| can_edit           | BOOLEAN NOT NULL DEFAULT FALSE                    | Phase 2 编辑相册 name/description                   |
| can_delete         | BOOLEAN NOT NULL DEFAULT FALSE                    | 未来从相册移除内容的能力，不是删相册或删除 original |
| can_manage_members | BOOLEAN NOT NULL DEFAULT FALSE                    | 有界管理非管理者的 ACL                              |
| created_at         | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) | 授权行创建                                          |
| updated_at         | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) | 授权行变更                                          |

索引：PRIMARY(id)、uq_album_members_album_member UNIQUE(album_id,member_id)、idx_album_members_family_album(family_id,album_id)、idx_album_members_family_member(family_id,member_id)。

外键：fk_album_members_album(family_id,album_id) → albums(family_id,id)；fk_album_members_member(family_id,member_id) → family_members(family_id,id)。不存在跨 family ACL。所有 Phase 2 外键 ON DELETE RESTRICT / ON UPDATE RESTRICT，无 CASCADE。

CHECK：五个命名 chk_album_members_*_boolean，分别保证对应列 IN (0,1)，因为 BOOLEAN 存储本身不代表只允许 0/1；chk_album_members_view_required：can_view = 1 OR (can_upload = 0 AND can_edit = 0 AND can_delete = 0 AND can_manage_members = 0)。任何扩展能力都必须同时显式 can_view=true，即使目前 visibility=FAMILY 也一样。

全 false 行不表示 deny：API 不写这种行，撤销用 DELETE；数据库可容忍遗留全 false 行，计算结果等同无 grant。应用层拒绝对 owner_member_id 创建或修改 ACL；Owner 从 albums 唯一计算，普通 CHECK 不跨表验证这条规则。

共 4 个外键、8 个 CHECK，含两个主键在内 8 个声明索引（实现生成 DDL 后核对，不把引擎隐式索引重复计数）。不改已有 family/member 表，无新 audit/media 表。

BIGINT 在 Drizzle 保持 bigint，在 API 与 mysql2 raw SQL 输出为精确十进制 string；禁止 Number(id/revision/insertId)。复用 unsignedBigIntStringSchema，写入 ID 在同连接通过 CAST(LAST_INSERT_ID() AS CHAR) 等精确路径取得。revision 溢出须失败，不能重置或绕回。

created_at/updated_at 维持当前应用层更新时间约定：不手工混入 ON UPDATE DDL。相册 repository 在修改事务中显式使用锁后 server time 更新 updated_at；ACL 修改同时增加 albums.revision。Drizzle schema、SQL、snapshot/meta 必须一致。

## 3. Permission model 与 Owner

五权限彼此独立，唯一前提是所有操作都需要有效 view。can_edit 不包含改 visibility、ACL、Owner 或删相册；can_delete 不包含删除 original、全局 media、其他相册关联或整张 album。未来多相册照片必须单独设计媒体访问和删除规则，不能把“任一相册 can_delete”提升为物理删除权。

Owner 是 albums.owner_member_id 对应的家庭成员。有效 user + 未 disabled/left 的本家庭 membership + 未删除 album 才能获得 Owner 全权限；Owner 不绕过账号、session、family 或删除状态检查。

Owner 不能通过 ACL 接口被移除或降权，不可通过普通 PATCH 改 owner_member_id/family_id。Phase 2 无 transfer endpoint。家庭成员停用仍遵循 Phase 1 权限，可停用作为 Owner 的 MEMBER/ADMIN，但不因此获得其相册权限；不改变 Phase 1 SUPER_ADMIN 禁改规则。

Owner 停用/离开后，owner_member_id 保留，Owner 当前访问全部拒绝；其他仍有效的已授权成员继续拥有自身 grant，不自动升级。既有委托管理者仍只能在原有授权范围内管理，不能删除相册、改变可见性、转移 Owner 或制造新管理者。

此最小模型保证“Owner 引用不丢失”和“ACL 操作不会移除唯一 Owner”，不承诺 Owner 被家庭停用后仍有活跃管理员。暂停管理是明确可接受的 fail-closed 状态；正常恢复原 membership 后原有权限恢复，管理员需理解 disable 是暂停、不是删除 grant。若需永久撤销，应由 Owner 在恢复前移除 ACL。left_at 视为更强停用，不提供隐式重新加入/复用 membership 恢复流程。

Owner 离家/账号遗失后的 transfer/recovery 留给单独审查的维护流程；Phase 2 不增加管理员接管、不复用 bootstrap、不因无人管理自动变 FAMILY。恢复流程未来只能由明确授权执行，并记录审计，不能在本阶段预埋绕过接口。

## 4. FAMILY / CUSTOM 和家庭角色边界

FAMILY 的有效同家庭成员自动 view；四项写权限仍按显式 grant/Owner。can_view=false 或删除 ACL 不能对单个人覆盖 FAMILY 默认 view；需要限制查看时改 CUSTOM。FAMILY → CUSTOM 时保留显式 ACL，仅默认查看者失去访问；CUSTOM → FAMILY 向所有有效同家庭成员开放 view，必须 Owner + recent-auth，并明确提示权限扩展。

CUSTOM 只有有效 Owner 或 can_view=true 的显式成员能看到相册。SUPER_ADMIN/ADMIN 如果没有 grant，一样不可见；即使其拥有系统级成员管理权限，也不得借相册列表、搜索、计数、member endpoint、分页或错误响应发现该相册。

家庭角色只管理 Phase 1 的邀请/家庭成员，不授予内容访问或相册接管。部署机器系统管理员理论上的磁盘/数据库能力不属于应用权限例外，也不能成为 API bypass。

## 5. 统一 Permission Service

在 packages/permissions 新增纯计算入口 evaluateAlbumPermissions(verifiedContext)，并由 canViewAlbum/canUploadToAlbum/canEditAlbum/canDeleteFromAlbum/canManageAlbumMembers 调用。repository 负责取得当前可信状态；纯函数不接收客户端声称的 owner、family role 或权限作为事实。

固定顺序：

1. 验证当前 user/session 以及 actor membership 属于该 user。
2. 验证 actor membership active：disabled_at/left_at 均 NULL，user.disabled_at NULL。
3. 验证 album.family_id = membership.family_id，album.deleted_at NULL；查不到或不一致全部拒绝。
4. 计算 visibility 基础权限：FAMILY 只置 view，CUSTOM 不置任何默认权限。
5. 合并同 family/album/member 的显式 allow；数据不合法 fail closed，不扩展出隐含 grant。
6. 若 actor 是有效 Owner，置全部五权限；这是在前述边界成立后的赋权，不是跳过验证。
7. 非 view 时所有能力归 false；额外控制操作继续检查 Owner-only、recent-auth、目标约束和 grant 上界。

输入 family role 的变更不应改变上述相册权限计算结果。角色枚举与已有 canManageMember 等函数继续服务家庭管理，不得用它们授权相册。

## 6. API contracts

所有 JSON 使用 Zod strict object；独立 album errors 保持 code/message/requestId 外形，新增通用 NOT_FOUND/404，避免改写既有 Auth 错误行为。malformed ID/未知字段为 400；缺/失效 session 为 401；album 不存在、已删除、跨家庭、CUSTOM 无 view 一律相同 404。只有确认可 view 后才返回缺操作权限的 403。冲突 409 仅对已授权操作返回，不能在授权之前泄露 revision/目标状态。

沿用 WEB Cookie、精确 Origin allowlist、JSON 写请求、Cookie/Bearer 冲突拒绝；API 不开放新的 credentialed CORS。所有相册响应 no-store；GET 无副作用（会话常规 touch 除外）。没有相册公开/邀请 token。

| Endpoint                                         | 输入                                           | 授权与结果                                                                       |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| POST /api/v1/albums                              | familyId,name,description?,visibility?         | 任何有效该 family 成员均可创建；recent-auth；Owner 从 actor membership 推导；201 |
| GET /api/v1/albums                               | familyId 必填，afterId?，limit 1–100 默认 20   | 只返回当前可见且未删除相册，id keyset 升序；无权 family 404                      |
| GET /api/v1/albums/:albumId                      | 路径 ID                                        | view；200，含 own effectivePermissions 与 revision                               |
| PATCH /api/v1/albums/:albumId                    | revision，至少一个 name/description/visibility | 文案需 edit；含 visibility 则 Owner + recent-auth；全有或全无，200               |
| DELETE /api/v1/albums/:albumId                   | JSON {revision}                                | Owner + recent-auth；软删除，204；后续访问含重复 DELETE 均 404                   |
| GET /api/v1/albums/:albumId/members              | albumId                                        | view + manage_members；只返回当前相册 Owner 与显式 ACL 最小信息                  |
| PUT /api/v1/albums/:albumId/members/:memberId    | revision + 完整五 boolean                      | view + manage_members + recent-auth；授权目标与上界检查；创建/替换 ACL           |
| DELETE /api/v1/albums/:albumId/members/:memberId | JSON {revision}                                | view + manage_members + recent-auth；同样的目标保护；无 ACL 时已授权者幂等 204   |

只提供 PUT 完整 ACL，不同时实现 PATCH ACL；避免遗漏字段默认值造成升权。路径 memberId 唯一定位目标；请求不得含 familyId、albumId、owner、userId、role、timestamps、deletedAt。创建只允许选择 familyId，由服务端确认 membership；其余路径以锁后 album 的 family 为事实。

name trim 后 1–128 Unicode code points、UTF-8 ≤512 bytes；description 可空/null，最多 2000 code points、UTF-8 ≤8000 bytes，保留换行。拒绝非法 Unicode/NUL，不把普通文案当 username normalize。客户端渲染使用文本转义。请求体有长度限制，禁止日志记录正文。

album DTO 最小字段为 id/familyId/ownerMemberId/name/description/visibility/createdAt/updatedAt/revision/effectivePermissions；不返回密码、session、其他家庭信息或被过滤相册计数。member DTO 仅 memberId、displayName、active、五个 grant、isOwner；FAMILY 默认可见成员不伪造成显式 ACL。Phase 2 不为成员选择器新增全局用户搜索或泄漏 CUSTOM 的 endpoint。

列表必须在数据库授权谓词中过滤后 LIMIT，不能先 LIMIT 再在应用层过滤，也不返回全部家庭总数。afterId 仅数值边界，不验证该 ID 是否存在，next cursor 只来自最后返回的可见行；不在 cursor 填入隐藏 album 信息。后续任何 search/count/reference endpoint 必须复用同样 view 规则。

## 7. 有界成员管理

Owner 可添加/修改/移除同家庭非 Owner ACL，包含 can_manage_members；永远拒绝为 Owner 自身写 ACL。

委托管理者（非 Owner 且 can_manage_members=true）：

- 不允许修改自己、Owner 或任何当前 can_manage_members=true 的目标。
- 不能授予 can_manage_members=true，也不能撤销别的管理者；只有 Owner 控制管理者集合，避免互相帮忙提权。
- 只能操作目标现有四项非管理 grant 和请求新 grant 都是自己当前有效权限子集的 ACL；因此不能通过整行替换/DELETE 撤销自己没有能力管理的高权限授权。
- 新 grant 的 upload/edit/delete 必须显式伴随 view=true；不自动补权限。全 false 请求 400，使用 DELETE。
- 添加/扩大授权只允许 user 与 membership 均 active 的同家庭目标；移除或仅缩减 inactive 目标的既有 grant 允许，以便清理。对 left member 不创建新 grant。

先检查相册可见性、操作者权限和目标保护，再做版本/幂等检查。跨家庭 target 与不存在 target 统一 404，不先暴露目标角色、用户或权限。即便目标行不存在/已移除，self/Owner 禁改规则仍先执行。

## 8. Transaction / locking

沿用 Phase 1 全局顺序，扩展末尾：families → users（数值 ID）→ sessions（数值 ID）→ family_members（数值 ID）→ invitations（数值 ID）→ albums（数值 ID）→ album_members（数值 ID）。Phase 2 没有 invitation 操作，跳过该层。每层多行逐主键数值升序锁定；不能只用 JOIN/ORDER BY 声称跨表锁序确定。

针对约 5 人场景，Phase 2 同 family 的所有相册读写统一先取得 family FOR UPDATE，作为粗粒度串行化边界，优先简单可靠；不引入第二套 retry、权限缓存或分布式锁。读取也使用此协议，使 Phase 1 member disable 与相册读取在相同 family 锁上有明确顺序。事务保持短小，不在锁内网络调用、Argon2 或外部 IO。

按 album ID 的入口可预查 family/owner/target user IDs用于定位，但预查不是授权。锁 family 后收集所需主体，再依次锁 actor 与目标 users、caller session、actor/目标 memberships，最后 album 与所需 ACL；锁后重新验证全部 ID 关系。Owner 只有在作为 actor/target 时需要锁其 user/member；其停用不会改变其他人的 grant。

相册列表/成员列表需读取的多主体和行 ID 在 family 锁保护下定位，再按上述顺序锁并 current-read；禁止普通 REPEATABLE READ 旧快照替代授权。如果实现需要跨层补锁已存在 user/member，停止并重新安排先定位后锁的流程，不允许倒序。新建 album/ACL 行的 FK 与唯一索引仍可能造成隐式死锁，复用现有 helper。

全部必要锁取得后另发 SELECT CURRENT_TIMESTAMP(3)，重验 user、WEB session hash/revoked/absolute/idle、membership 及必要的 15-minute recent-auth；再计算权限。不能仅复用入口 authenticate 返回的旧 serverNow；禁止在事务内再次调用另开连接的 touchSession。入口正常 touch 保持既有行为，锁内只重新验证，不创建新 session 策略。

读请求在锁内生成已授权 DTO 并提交后响应；权限撤销先提交则读取拒绝，读取先通过则允许该已授权在途响应结束，不宣称能追回已发出的数据。FAMILY→CUSTOM、member disable、album delete 同样适用。

修改同 album 的 name/description/visibility/ACL/delete 共用 albums.revision：授权后比较客户端 revision，不匹配 409；条件 UPDATE 带 id/revision/deleted_at IS NULL，affectedRows=1。每次有效变更原子加 1，ACL 变更与 album 版本更新同事务。无实际变化返回原版本、不增加 revision，但仍需授权及版本匹配；无 ACL 的幂等 DELETE 同理。创建 revision=1，无需客户端版本。

锁防止越权竞态，revision 防止两个合法操作者旧页面覆盖新权限，两者不能互相替代。COMMIT 不明返回通用 503，不发成功事件、不自动重放，包括 POST create；客户端重新列出/读取确认结果后由用户决定，不把未知结果当失败重新创建。

复用 runTransaction 的已回滚死锁最多 2 次额外重试、有界 jitter、健康新连接、每次重新定位/锁/授权；rollback 失败销毁、lock timeout 保守失败、COMMIT 不明销毁且不 replay。所有响应与成功日志在明确 commit 后。

## 9. Delete semantics

DELETE album 只写 deleted_at/updated_at 并增加 revision。保留 album_members 以保留逻辑关系，不级联删除；已删除 album 对全部调用者（含 Owner、SUPER_ADMIN）不可访问、不可改 ACL，列表也不返回。

沿用项目 Trash 默认保留至少 30 天；Phase 2 不实现 restore/purge/定时永久删除，不到期自动物理删除。未来恢复需重新审查当前成员与旧 ACL，避免恢复时重新授予不期望权限。

本阶段无 media 表、storage key、删除磁盘函数或删除 original 的回调。未来 album_media 关联生命周期与 storage_objects 分离，删除相册最多处理逻辑关联，绝不能沿 CASCADE 或删除任务链删除 immutable original。

## 10. Audit / logging

事件：album_created、album_updated、album_deleted、album_member_added、album_member_removed、album_permission_changed、album_visibility_changed。混合 PATCH 文案/visibility 时可发各自事件，均只在 commit 明确成功后；权限 PUT 原有行使用 permission_changed，新行使用 member_added，无变化不发变更事件。

字段白名单：event、requestId、timestamp、resultCode、actorUserId、actorMemberId、familyId、albumId、必要 targetMemberId、revision、changedFields，以及必要的权限 bit/visibility 前后枚举。禁止记录相册 name/description、成员姓名、请求 body、Cookie、Authorization、token/hash、raw driver/parser error/stack。404 拒绝日志只记请求级拒绝，不补充查询到的隐藏相册信息。

保留现有结构化 stdout 审计的非持久/非事务原子限制，不承诺 exactly-once，不为 Phase 2 新增审计表。持久生产审计仍是 deferred production gate。

## 11. Migration plan

实现阶段生成新的 versioned Drizzle migration（建议 0001_phase_02_albums_permissions；如编号已占用用下一个，不能覆盖历史），只创建 albums 和 album_members，先父表再子表。不得创建 media_items/storage_objects/album_media/comments/tags/AI 表。

运行前：确认 DATABASE()=family_album_dev、VERSION()=9.7.2、非 root、Native FK=1、session FK checks=1、既有 migration journal 完整、两张新表不存在。检查没有 schema drift，展示 SQL/索引/FK/CHECK/snapshot，一致后输出 MIGRATION_READY，等待明确执行批准。禁止 IF NOT EXISTS 掩盖 drift、导入 database/schema.sql、改全局配置、重建数据库或改 0000。

迁移后 synthetic 测试必须证明跨 family owner/ACL 的 FK 拒绝、重复 ACL 唯一性、boolean 与 view prerequisite CHECK、BIGINT 精度、事务回滚；读取 SHOW CREATE TABLE 对齐 schema/meta。目标校验在任何 fixture 写入前完成，环境缺失是失败而非 skip。只清理本测试精确 IDs，不运行真实 bootstrap、不使用真实相册内容。

## 12. 必测权限矩阵

以下均要求有效 session/user/membership、同 family、active album；V/U/E/D/M 为五个能力，D 不代表删相册。

| 身份/授权                                   | V   | U   | E   | D   | M    | 改 visibility / 删相册 / 授管理权 |
| ------------------------------------------- | --- | --- | --- | --- | ---- | --------------------------------- |
| 有效 Owner                                  | 是  | 是  | 是  | 是  | 是   | 是，需 recent-auth                |
| explicit viewer                             | 是  | 否  | 否  | 否  | 否   | 否                                |
| uploader（V+U）                             | 是  | 是  | 否  | 否  | 否   | 否                                |
| editor（V+E）                               | 是  | 否  | 是  | 否  | 否   | 否                                |
| deleter（V+D）                              | 是  | 否  | 否  | 是  | 否   | 否                                |
| manager（V+M）                              | 是  | 否  | 否  | 否  | 有界 | 否                                |
| FAMILY 无 ACL 普通成员                      | 是  | 否  | 否  | 否  | 否   | 否                                |
| CUSTOM 无 ACL 普通成员                      | 否  | 否  | 否  | 否  | 否   | 否                                |
| CUSTOM 无 ACL ADMIN                         | 否  | 否  | 否  | 否  | 否   | 否                                |
| CUSTOM 无 ACL SUPER_ADMIN                   | 否  | 否  | 否  | 否  | 否   | 否                                |
| disabled/left/global-disabled（包括 Owner） | 否  | 否  | 否  | 否  | 否   | 否                                |
| cross-family 或 deleted album               | 否  | 否  | 否  | 否  | 否   | 否                                |

纯函数穷举 32 个 ACL bit 组合、两种 visibility、三种 family role、Owner/非 Owner 与 active 状态，非法组合拒绝；明确所有 family role 结果相同。API 逐端点验证 IDOR、strict mass assignment、跨 family target、Owner/self 修改、委托管理者授高权限/改另一管理者被拒。

列表测试必须有隐藏 album 穿插在可见 ID 中，检查分页不漏合法项、不泄露隐藏项/总数；GET members 不能成为 CUSTOM 存在性探针。FAMILY 删除 ACL 仍有默认 view、转 CUSTOM 后只有显式 grant/Owner 可见。最少三个 synthetic 成员覆盖允许/拒绝路径，并额外覆盖无 grant SUPER_ADMIN。

## 13. Race tests

真实 DEV MySQL、两个独立连接、受控 barrier；通过测试层查询拦截/等待信号或数据库等待观测确认已进入目标锁请求，不只 Promise.all/sleep 猜测。测试同步不能替换真实授权代码或预先模拟拒绝。

| 竞争                                        | 必须证明                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| 两次 permission PUT，同 revision            | 单次变更成功；另一次 409，不能丢更新或混合 grant                        |
| manager 被撤权 vs 其授权别人                | 撤权先提交则拒绝；管理先提交则仅允许原有有界授权                        |
| Owner disable vs Owner permission change    | disable 先提交则 Owner 请求拒绝；反向已授权提交可完成；不自动转移 Owner |
| 普通 member disable vs GET/list/write       | 锁后 active 重验；停用胜出后无数据/无更新；其他 family 不受影响         |
| FAMILY→CUSTOM vs 原默认 viewer GET/list     | 切换胜出后 404/列表过滤；反向在途读取允许，后续必拒绝                   |
| album delete vs permission PUT              | delete 胜出后 404；PUT 胜出后旧 revision delete 409，Owner 刷新后可删   |
| actor session revoke/rotation vs album 操作 | 锁后 hash/state 重验，旧 token 不可写或取得新的授权读取                 |
| 等锁跨 session idle/absolute/recent-auth    | 锁后新 DB time 判定，失效不返回成功、不更新 album                       |
| 两个创建同 album/member ACL                 | 唯一行；第二次版本冲突，失败无残留                                      |
| rollback/deadlock/COMMIT 不明               | 复用 helper，失败无半套 ACL/版本变更；不 replay、不虚假成功审计         |

还需测试 grant 子集对“现有目标权限”和“新权限”都生效，manager 不能与另一个 manager 相互提权；Owner disabled 后有效普通 grant 仍按本文规则工作、原 Owner 无访问，恢复 membership 的权限恢复行为明确可见。

## 14. P0/P1 design risks

以下是实现必须阻断的风险清单，并非已发现现存 Phase 2 代码漏洞：

- P0：SUPER_ADMIN/ADMIN 内容 bypass、跨 family Owner/ACL、隐式公开 CUSTOM、由删除相册触发 original 删除。
- P1：管理者自提权/互相提权、仅前端授权、旧快照或锁前时间授权、列表/成员接口泄漏隐藏相册、FAMILY 默认为 edit/delete/manage、Owner 停用自动接管。
- P1：倒序锁 user/member、ACL 与 revision 非原子、COMMIT 不明重放、无权者先获知版本/幂等状态、deleted album 仍可访问。

实现遇到本文无法覆盖且需要改变角色、Owner、授权、锁序或 schema 的情况，输出 R3_DESIGN_REVIEW_REQUIRED 并停止改设计。

## 15. Recommended implementation order

1. 先编写 permissions 纯函数与完整矩阵、strict contracts/error/revision 单测。
2. 实现两表 Drizzle schema、生成 migration 并审查；执行前独立 MIGRATION_READY 等待批准。
3. 用既有 transaction helper 实现统一当前权限读取与 create/list/get；验证 FAMILY/CUSTOM、Owner、SUPER_ADMIN 拒绝和分页。
4. 实现 metadata PATCH、Owner visibility/delete，再实现有界 ACL PUT/DELETE 与最小成员列表；补审计。
5. 跑真实 synthetic MySQL FK/CHECK、并发版本与安全竞态；每个 slice targeted tests。
6. Cursor targeted review，必要的 Astra blocker re-review；阶段完成后完整 Quality Gate。Phase 2 权限 E2E 必须实际覆盖三个不同权限主体的拒绝/允许，不得仅沿用 Phase 1 health smoke 充数。

本次只交付设计文档。未运行测试、数据库命令、migration 或 bootstrap；未进入 Phase 3。
