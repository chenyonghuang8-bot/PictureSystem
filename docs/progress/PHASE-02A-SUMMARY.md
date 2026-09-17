# PHASE-02A SUMMARY — Album Core

日期：2026-09-15。状态：COMPLETE。

Phase 2A 在已审查并执行完成的 `0001_phase_02_albums_permissions` schema 上实现了相册核心能力。本阶段没有修改数据库 schema/migration，也没有进入 ACL mutation、媒体或 Phase 3。

## Delivered

- `packages/permissions` 提供统一的纯函数相册权限计算，以及 view/upload/edit/delete/manage-members 五个入口。
- FAMILY 对有效本家庭成员默认只开放 view；CUSTOM 仅 Owner 或 explicit `can_view` 可见。
- Owner 在 user、membership、family、album-active 边界均有效后获得五项权限。
- ADMIN / SUPER_ADMIN 不形成相册内容权限 bypass；无 ACL 的非 Owner SUPER_ADMIN 无法查看 CUSTOM album。
- 新增严格的相册 contracts：create/list/get/update/delete、精确 BIGINT string、keyset pagination、effective permissions 和通用 `NOT_FOUND`。
- 实现 `POST /api/v1/albums`、`GET /api/v1/albums`、`GET /api/v1/albums/:albumId`、`PATCH /api/v1/albums/:albumId`、`DELETE /api/v1/albums/:albumId`。
- Create 从当前已验证 family membership 推导 Owner，默认 CUSTOM，revision=1；客户端不能指定 Owner/revision/delete/permission 字段。
- List 在 SQL view predicate 后才执行 LIMIT，隐藏 album 不占分页位置，也不返回总数。
- Get 对不存在、跨家庭、CUSTOM 无 view、soft-deleted 统一 `404 NOT_FOUND`。
- Update 对 name/description 要求 effective edit；visibility 仅 Owner + recent-auth；使用 expectedRevision 和条件更新原子增加 revision。
- Delete 仅 Owner + recent-auth，执行 soft delete 并增加 revision；不删除 `album_members`，不触发 media/storage 行为。
- 所有 repository 操作复用 `runCheckedTransaction`，先锁 family，再按 users → sessions → family_members → albums → album_members 顺序锁定；锁后读取 DB server time 并重新验证 session/membership。
- 成功审计只使用 ID、revision、changedFields 等白名单字段，不记录 album name/description 或请求 body。

## Validation

- Permission/contracts/service/routes 与相关 Auth route regression：54 tests PASS。
- DEV MySQL Phase 2A integration：6 tests PASS，未 skip。
- 覆盖：CUSTOM SUPER_ADMIN 无 bypass、FAMILY view-only、explicit edit grant、SQL filter-before-limit、cross-family/deleted non-disclosure、authorization-before-revision、同 revision 并发仅一个成功、atomic revision increment、stale conflict、Owner-only visibility/delete、BIGINT decimal string。
- Synthetic family/user/session/album/ACL fixtures 在 suite 结束后清理并检查为 0。
- `permissions`、`contracts`、`db`、`api` scoped typecheck PASS。
- scoped ESLint PASS；scoped Prettier check PASS。

## Not implemented in Phase 2A

- Album member list/add/update/remove endpoints。
- ACL mutation 与 delegated `can_manage_members` 上界。
- Phase 2B race-heavy ACL/revision concurrency suite。
- Owner transfer、album restore/hard delete。
- Media/upload/storage 或 Phase 3 功能。

下一步只有在用户明确批准后进入 Phase 2B。
