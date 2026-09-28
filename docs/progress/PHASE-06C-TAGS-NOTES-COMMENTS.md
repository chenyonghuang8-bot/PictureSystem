# Phase 6C — Tags + Canonical Notes + Comments

日期：2026-09-28。基线与 `origin/main`：`d25014e52e7686069077c572b128aea3d42100ea`。本阶段仅实现 tags、canonical media note、comments、private detail enrichment、进程内评论限速及其测试；没有实现 download、Web interaction controls 或 Phase 6D。

## Tags

- 唯一 `tag-v1` helper 在 service 写入 repository 前执行：raw 256 code points / 1024 bytes 上限、malformed Unicode 拒绝、NFKC、以同一 `\p{White_Space}` 定义移除首尾空白并将内部连续空白折叠为一个 ASCII space、剩余 Cc/Cf 拒绝、locale-independent `toLowerCase()`，最终 display name 1–64 code points / 256 bytes，binary normalized identity 1–256 bytes。独立审查发现旧实现将 JavaScript `.trim()` 与 `\p{White_Space}` 混用，导致 U+0085 可产生边缘空格甚至空白 tag；现已移除 `.trim()`，U+0085/NBSP/EM SPACE、混合内部空白、empty rejection 与 normalization idempotency 均有回归。é/e 与 ß/ss 继续保持不同 identity。
- `POST .../tags` 在当前 media 授权 transaction 内 find/create family tag 并 attach；既有 canonical tag 保留首次 display name。`PUT .../tags/:tagId` 仅允许复用同 family 且至少出现在一个 caller 当前可见 media 上的 tag，不提供全 family dictionary endpoint。`DELETE` 只保证目标 relation 最终不存在，不查询 global tag existence。
- 每个 media 上限 64；先检查 existing association，因此 at-cap 重复 apply 仍成功，新第 65 个返回 conflict。family mutex、media lock、exact unique classifier 与完整 identity re-read 让等价 create/attach 收敛，未知 1062 fail closed。

## Canonical note

- 直接使用 frozen 0006 的 `media_items.description` 与独立 `note_revision`；不新增 notes table。detail read 要求当前 view，PUT 要求 selected album 当前 edit。
- 输入拒绝 malformed Unicode/NUL，CRLF/CR 转 LF，全空白转 NULL，非空内容保留有意义的首尾空格；上限 4000 code points / 16000 UTF-8 bytes。
- 写入使用 `family_id + media_id + expectedRevision` CAS 并只更新 `description`、`note_revision`。stale（即使正文相同）为 409；unsigned BIGINT max fail closed；不 Number-convert、不自动重试 CAS 或 COMMIT-unknown。
- note 是 canonical media state；从 Album A 更新后，另一个有权 Album B detail 看到相同值，但 A 的权限不会授权 B。

## Comments

- 提供 ascending `(created_at,id)` keyset list、non-idempotent create、author-only delete；limit 1–50，严格 versioned base64url cursor，查询始终绑定已授权 family/media，使用 limit+1 判定下一页。
- body 拒绝 malformed Unicode/NUL/blank，统一换行，1–2000 code points / 8000 bytes；HTML-like 内容仅作为普通字符串。author 从 locked current member 派生，DTO 只含 memberId/displayName。
- process-local limiter 按 actor member 为 key，20 POST/minute，10,000 buckets 上限并过期清理；它不宣称是 persistent/multi-process production limiter。
- delete 先重验当前 media visibility，再锁 comment 并核对 author；重复删除 404，ADMIN 不能删除别人评论。inactive/left author 可继续作为历史署名出现，但其历史 row 不恢复访问。

## Authorization, privacy and query strategy

- 所有操作复用现有 session/member checks、permission engine、transaction helper 与 family mutex；锁序保持 family → actor/session/member → album/grant → media → placement → Phase 6 row。SUPER_ADMIN 不绕过 album ACL。
- hidden/deleted/cross-family/no-placement/no-view 在读取 Phase 6 state 前统一隐藏；tag/note/comment 从不成为 access grant。确定性测试设施见 [PHASE-06C-RACE-HARNESS.md](./PHASE-06C-RACE-HARNESS.md)：它以 per-instance hook 报告 family lock query 已 dispatch 及 mutation 已完成但尚未 commit，并以 deferred latch 控制顺序；watchdog 只用于测试失败退出，不作为锁等待证据。
- 真实 MySQL controlled matrix 覆盖：existing-tag PUT 的 edit revoke-first、placement remove-first 与 PUT-first；tag POST 的 edit revoke-first、placement remove-first 与 POST-first；tag DELETE 的 edit revoke-first；note 的 update-first、edit revoke-first 及 hidden-before-stale-CAS；comment POST 的 view revoke-first、placement remove-first、member disable-first、member leave-first及 POST-first；comment DELETE 的 visibility-first。每项同时断言 operation 结果、relation/正文/revision/row 及后续 visibility/permission；历史 tag/comment relation 均不会恢复访问。
- private detail 在同一授权 transaction 内以固定数量查询读取 media flags/base row、最多64 tags、COUNT decimal string、note/revision。comment list 一次 join family member/user，不逐 comment 查 author。timeline/grid 仍只有 favorite/featured flags。
- detail 固定 capability object 中 `canManageFeatured`、`canEditTags`、`canEditNote`、`canComment` 对应当前实现；6D download 尚未实现，因此 original/preview download capabilities 均为 false。
- public share 继续使用独立 schema/mapper；session cookie 不扩展 public response，favorite、featured、tags、note、revision、comments/count、capabilities 均不泄漏。

## Concurrency and preservation

- 真实 MySQL 证明：`Trip`、U+0085 wrapped `Trip`、`trip`、`TRIP` 通过真实 normalizer 后仅形成一条 binary identity/association；同 tag attach 幂等；visible existing-tag PUT 正向成功且重复仍仅一条 relation；hidden-only/cross-family tag 均 404；63→64 cap race 仅一个新 association 成功；at-cap 已存在 PUT/POST 成功、65th 冲突；双 remove 最终 absent。
- 同 expected note revision 的两个 writer 恰好一胜一 conflict、revision 只加一；stale same-text 与 overflow 均 conflict；hidden state 优先于 stale revision，返回 NOT_FOUND 而不是 conflict。双 comment delete 精确为一次成功、一次 `AlbumRepositoryError(NOT_FOUND)`，最终 DB row absent；同 timestamp 按 ID 稳定分页。
- **DYNAMIC DB MUTATION PRESERVATION：已测试。** 一个独立 synthetic media 在 before/after snapshot 之间通过真实 repository 顺序执行 create/apply tag、update note、create comment、delete comment、remove tag。允许变化仅为 `description` 与 `note_revision`；最终 tag association 与 comment row 均 absent。逐字段比较保持 `media_items` 的 canonical/provenance、storage/source IDs、media/processing/generation/recipe/metadata、capture/dimensions/orientation/video/animation/GPS/camera/timeline/warning/failure 字段，完整 `storage_objects` identity/state/hash/size/times、两个 `album_media` placements 及实际 `derived_assets` identity/state/payload字段不变。
- **PIPELINE NOTE PRESERVATION：已测试。** Phase 4D2 的真实 `MySqlMetadataRepository.persistResult` 在更新 probe metadata/processing 字段后保持 synthetic `description` 与 `note_revision=7` 不变。生产 SQL inventory 共四处：`album-repository.ts` 的 note CAS 明确只写 note 两列；`metadata-repository.ts` 的 snapshot/failure 两条及 `derived-asset-fence.ts` 的 state update 均不写 note 两列，也没有 object-spread/broad-row replacement SQL。
- **ORIGINAL FILE BYTES/INODE：本 Phase 未动态测试。** Phase 6C repository path 没有 filesystem 调用；本次只证明 DB mutation preservation，未将其描述为 native original bytes/inode 验证。

## Migration and validation

- Schema change：无。0006 未修改，SHA-256 仍为 `533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`；无 0007。DEV readiness：0000–0006 共 7 条，PASS。
- Remediation targeted snapshot：Unicode/harness/public unit 4 files / 42 tests PASS；Phase 6C、metadata pipeline、public-share targeted 5 files / 44 tests PASS。完整 final gate 结果在最后一次文档修改后执行并由最终 handoff 记录；本段不预写尚未执行的新总数。

## Findings and stop point

Phase 6C 独立审查的三个 P2 已实现 remediation：Unicode White_Space、确定性授权/并发证据、真实 mutation preservation；等待独立 final review 判定关闭。实现与 targeted validation 未发现新 P0/P1/P2/P3。因本轮自然修改 duplicate-classifier unit file，Phase 6B carried P3 已补成 featured expected-index 的直接 backup-name rejection 测试并关闭。

既有 deferred 不变：public share persistent production rate limiting、token-bearing URL deployment log redaction、durable audit，以及 Phase 4 power-loss/SSD/platform production validation。评论 limiter 仍只是 process-local；这不是 persistent production rate limiting。

Phase 6C implementation complete and ready for review。未开始 Phase 6D；download 与 Web interaction controls 仍未实现；不宣称 Phase 6 complete。
