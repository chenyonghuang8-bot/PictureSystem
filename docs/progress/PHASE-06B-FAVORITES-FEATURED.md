# Phase 6B — Personal Favorites + Family Featured

日期：2026-09-28。基线：`fc656e5fb3bef4bf5827891132ce5f8480f55169`。范围仅为 public/private Gallery DTO 隔离、个人收藏、家庭精选、私有 Gallery flags、测试与本文档；未实现 tags、notes、comments、downloads 或 Phase 6E Web controls。

## Public / private DTO isolation

- `publicGalleryMediaItemSchema` 与 `publicGalleryMediaItem()` 固化 Phase 5 公开字段：mediaId、timelineKey、timelineBasis、displayWidth、displayHeight、thumbnail。
- 私有 `galleryMediaItemSchema` 在该基础上要求 `isFavorite` 与 `isFamilyFeatured`。
- `PublicShareService` 不再使用私有 Gallery mapper；公开 schema 和 mapper 都是独立白名单。
- strict contract、route exact-key，以及真实 `AuthService`、真实有效 session record/cookie 与匿名请求的 API 回归证明公开响应相同；公开 payload 明确排除 favorite、featured、tags、note、comments、capabilities 与 member/family identity。

## Personal favorites

- API：`PUT/DELETE /api/v1/albums/:albumId/media/:mediaId/favorite`，严格空 JSON，请求不接受 familyId/memberId。
- actor member 只从已认证 session 在 DB 锁内派生。
- 锁序：family mutex → user/session/member → album/grant → media → album_media placement → user_favorites。
- 所有读取与 mutation 都先通过当前 session、active membership、selected album、当前 placement 与 can_view；favorite row 从不参与媒体发现或授权。
- PUT/DELETE 在授权后幂等。重复 PUT 不更新 created_at；重复 DELETE 返回 false。1062 必须同时具有实际 mysql2 的 `ER_DUP_ENTRY`/1062/23000 字段、可无歧义解析的单引号 key，以及精确匹配的终端 index identifier；近似名称、无关 index、畸形消息与非 1062 全部 fail closed，随后仍须完整 identity 行回查才收敛。
- 失去 Album A 可见性后，经 A 的 detail/state/mutation 全部 NOT_FOUND；若 Album B 仍可见，经 B 可读取同一 media-level favorite。失去全部可见 placement/ACL 后，detail、favorite PUT/DELETE 与 READY thumbnail/preview discovery 均不可访问，DB relation 可以保留；恢复真实可见路径后原 favorite 状态重新可见。

## Family featured

- API：`PUT/DELETE /api/v1/albums/:albumId/media/:mediaId/featured`，严格空 JSON。
- 读取要求当前 can_view；mutation 额外要求当前角色 ADMIN 或 SUPER_ADMIN，但不要求 can_edit。
- ADMIN/SUPER_ADMIN 对 hidden album 都没有 bypass。MEMBER 可读自己当前可见媒体的 featured flag，但不能 mutation。
- PUT/DELETE 在完整授权后幂等；首次成功的 featured_by_member_id 与 created_at 保留。
- 历史 actor 降级、停用或离开不删除 featured row，也不提供未来管理权限；每次 mutation 重新检查当前 session、membership、role 与 ACL。

## Gallery integration and query strategy

- family timeline、album media list、media detail 均返回两个必需 boolean flags。
- SQL 先从当前可见 media/placement/album 集合出发，再 LEFT JOIN 当前 member 的 user_favorites 与 family_featured；不会从关系表向外发现 hidden media。
- album list/detail 使用单条页面查询完成 enrichment；timeline 使用同一可见聚合查询。没有 per-tile state query。
- instrumentation regression 将同一页面从 1 个媒体扩至 2 个媒体，SQL query 总数保持不变。页面最大 100 项，因此查询数量对页面项目数有界。
- 一个 media 同时位于两个可见 albums，且当前 member favorite 与 family featured 行均存在时，timeline 仍只返回一个 item，并同时返回两个 true flags；原 timeline cursor/order 不变。

## Permission and race results

真实 `family_album_dev`、独立连接与 family mutex 覆盖：

- favorite PUT+PUT：两者 true、仅一行、created_at 不重写。
- favorite DELETE+DELETE：两者 false、最终无行。
- featured PUT+PUT：仅一行、first actor/time 保留；DELETE+DELETE 最终无行。
- role downgrade、member disable、member leave、ACL revoke、placement removal 与 favorite/featured mutation 均覆盖两个确定顺序。mutation-first 先等待 relation transaction 完整提交，再提交状态变化；state-first 由独立连接持有 family mutex、写入变化并在锁仍持有时启动 mutation，然后提交，使 mutation 必须在锁后按新状态重新授权。没有允许 success/failure 任一结果的宽松断言。
- cross-family、no placement、hidden album、ADMIN hidden、SUPER_ADMIN hidden 均不披露状态。
- 同一媒体跨两个相册 flags 一致，selected album context 不自动切换。
- mutation 前后 source_upload_id、storage_object_id、storage hash/size、generation、processing_state、placement count 与 derived identity/reference 快照不变；代码检查确认 Phase 6B mutation 只写对应 relation table，且没有文件系统调用。本 slice 未运行 original bytes/inode 的动态 native 快照，因此不将其声明为该测试已证明。

## Migration invariants

- schema 未改变；未创建 0007。
- 0006 SHA-256：`533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`。
- journal：0000–0006，共 7 条。
- 最终 `assertMigrationReadiness()`：PASS，migrationCount = 7。

## Quality gate

- Targeted contracts/API：7 files / 33 tests PASS。
- Duplicate classifier：1 file / 6 tests PASS；另由真实 DEV MySQL duplicate 对象验证 positive shape。
- Phase 6B real MySQL：1 file / 17 tests PASS，包括确定顺序的 role/lifecycle/ACL/placement 测试、全部可见性丢失与 timeline relations dedupe。
- Public share real-session MySQL/API：1 file / 3 tests PASS；targeted 两文件合计 20/20。
- `pnpm lint`：PASS。
- `pnpm format:check`：PASS。
- `pnpm typecheck`：PASS。
- `pnpm test`：106 files / 801 tests PASS，0 skipped（批准本机 DB/native capability 后运行）。
- `pnpm test:integration`：24 files / 214 tests PASS，0 skipped。
- `pnpm build`：PASS。
- `pnpm test:e2e`：5/5 PASS。
- `pnpm test:e2e:web`：2/2 authenticated HTTPS regressions PASS；这是现有 Gallery/Share shape 回归，不声明 Phase 6E UI acceptance。

初次在受限 sandbox 内运行完整 `pnpm test` 时，本机 MySQL、Unix socket 与 native process capability 被 EPERM 拒绝；这不是产品失败。按批准在本机能力环境重跑后完整通过。测试只使用 synthetic fixtures，未读取真实家庭媒体。

## Findings and stop point

独立审查的三个 Phase 6B P2 已按要求修复并补证；等待独立 final review 确认关闭。当前实现复核 P0/P1 为 0，未发现新的 P2/P3。既有 public share persistent production rate limiting、token-bearing URL deployment log redaction、persistent audit 与 Phase 4 power-loss/SSD/platform production validation deferred 不变。

`PHASE_06B_PASS: YES`

`PUBLIC_PRIVATE_DTO_ISOLATED: YES`

`FAVORITE_IS_ACCESS_GRANT: NO`

`FEATURED_BYPASSES_ACL: NO`

`SCHEMA_CHANGE_REQUIRED: NO`

`READY_FOR_PHASE_06B_FINAL_REVIEW: YES`

`READY_FOR_PHASE_06B_CHECKPOINT: NO`（必须等待独立 final review）

`READY_FOR_PHASE_06C: NO`（等待独立 review 与用户批准；未开始 6C）
