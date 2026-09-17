# PHASE-02B SUMMARY — Album ACL Management

日期：2026-09-15。状态：COMPLETE。

Phase 2B 在 Phase 2A 相册核心与既有 `0001_phase_02_albums_permissions` schema 上实现 ACL 成员管理、delegated manager 上界和 revision 并发保护。本阶段没有修改 schema/migration，没有实现媒体功能或进入 Phase 3。

## Delivered

- 实现 `GET /api/v1/albums/:albumId/members`：仅有效 Owner 或当前 `can_manage_members=true` 的调用者可访问；返回 Owner 与显式 ACL 的最小 display/active/grant 信息。
- 实现 `PUT /api/v1/albums/:albumId/members/:memberId`：完整替换五个 boolean grant，必须提供 `expectedRevision`；应用 contract 与 repository 均 fail closed。
- 实现 `DELETE /api/v1/albums/:albumId/members/:memberId`：删除显式 ACL；不存在的 ACL 对已授权调用者幂等成功且不增加 revision。
- 所有扩展能力都要求 `can_view=true`；全 false grant 被拒绝并要求使用 DELETE。
- Owner 可管理同家庭非 Owner ACL，并且是唯一能授予、修改或移除 `can_manage_members` 的主体。
- Delegated manager 不能修改自己、Owner 或另一个 manager，不能授予 manage-members，也不能授予自己不拥有的能力。
- Delegated mutation 同时要求目标现有权限与请求新权限都是 caller 当前 effective permissions 的子集，避免先授高再缩减、remove/add 或 manager 互助绕过。
- PUT 目标必须是同家庭且当前 active 的 member/user；DELETE 可清理 inactive member 的既有 ACL，但仍禁止 self/Owner/manager 越界。
- ADMIN / SUPER_ADMIN 不因 family role 获得 album ACL 管理能力；CUSTOM 无 view 时统一 non-disclosure 404。
- FAMILY 删除显式 ACL 后仍保留 active family member 的 implicit view；CUSTOM 删除后失去 view。
- ACL add/change/remove 与 metadata/visibility/delete 共用 `albums.revision`。有效变化在同一事务内条件增加 revision；无变化不增加。
- 复用既有 `runCheckedTransaction` 与 family 粗锁；按 users → sessions → family_members → albums → album_members 顺序锁定，锁后重新读取 DB server time 并重新验证 caller、target、album、ACL 与 revision。
- 实现 `album_member_added`、`album_permission_changed`、`album_member_removed` 安全事件；日志只包含 actor/target/family/album/revision 等白名单字段，不记录 body 或 description。

## Validation

- Phase 2 permissions/contracts/service/routes 及相关 Auth route targeted suite：59 tests PASS。
- Phase 2B DEV MySQL ACL/integration/race：11 tests PASS，未 skip。
- Phase 2A+2B MySQL regression：17 tests PASS，未 skip。
- 真实竞争覆盖：两个 manager 同 revision 修改同一 ACL、Owner delete/visibility 与 delegated mutation、caller manage permission 在 family-lock 等待期间被实际 repository 撤销、target 在等待期间被 Phase 1 repository disable、deleted/visibility/revision 锁后重验。
- 权限覆盖：Owner/manager/viewer、self escalation、manager-on-manager、Owner protection、existing/requested subset、disabled/cross-family target、ADMIN/SUPER_ADMIN no bypass、FAMILY/CUSTOM remove semantics。
- DB runtime 覆盖：cross-family ACL FK 返回 1452，view prerequisite CHECK 返回 3819。
- Synthetic family/user/session/album/ACL fixtures 在 suite 结束后清理并核验为 0。
- `permissions`、`contracts`、`db`、`api` scoped typecheck PASS；scoped ESLint 与 Prettier PASS。

## Not implemented in Phase 2B

- Media、upload、album_media、tags、comments。
- Owner transfer、album restore/hard delete。
- Production persistent audit storage（沿用已知 deferred production gap）。
- Phase 2 final independent review / full milestone Quality Gate。

下一步只有在用户明确批准后进行 Phase 2 Final Review；不得自动进入 Phase 3。
