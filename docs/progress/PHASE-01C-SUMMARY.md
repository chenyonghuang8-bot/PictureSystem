# Phase 1C — Invitation / Role Boundary / Bootstrap 完成总结

状态：Phase 1C 后端实现完成。实现遵循 `PHASE-01C-GUARDRAILS.md` 及其最终 role-boundary 裁决；未修改数据库 schema、未生成或执行 migration、未调用 Bridge、未进入 Phase 2。

## Invitation API

已实现：

- `POST /api/v1/families/:familyId/invitations`
- `GET /api/v1/families/:familyId/invitations`
- `POST /api/v1/families/:familyId/invitations/:invitationId/revoke`
- `POST /api/v1/invitations/preview`
- `POST /api/v1/invitations/consume`

创建邀请使用独立 `randomBytes(32)` invitation token、canonical unpadded base64url 和 SHA-256 raw-byte hash；数据库只收到 32-byte hash。原始 token 仅在事务明确提交后的创建响应 fragment URL 中返回一次。有效期默认 48 小时，API contract 限定 1–168 小时；role 仅允许 MEMBER/ADMIN。

最终撤销边界已落实：MEMBER 全拒绝；ADMIN 可撤销本家庭任意签发者的 MEMBER invitation，但对 ADMIN invitation（包括已经撤销的邀请）始终 403；SUPER_ADMIN 可撤销 MEMBER/ADMIN invitation。有权限调用者重复撤销保持幂等，used invitation 返回冲突，跨家庭 ID 不泄露目标存在性。

preview 不消费邀请，只返回 family name、target role、expiry；malformed/nonexistent/expired/revoked/used 均映射为统一 `INVALID_INVITATION`。consume 仅创建新 user/member，不复用已有 username，不创建 session，也不自动登录。

## Transaction 与一致性

Phase 1C 复用 Phase 1B.1 唯一的 `runTransaction` deadlock retry/rollback/commit-unknown 机制，并把健康连接、服务器时间读取提取为共享 primitive。固定锁层级为 family → existing users（数值 ID 升序）→ actor session → family_members（数值 ID 升序）→ invitations（数值 ID 升序）。

consume 的 Argon2 hash 在事务外、有效 token 定位后完成；事务内重新锁定并验证 family、inviter user/member、invitation、实时签发权限和最终服务器时间。user/member 创建及 invitation conditional consume 是同一事务；affectedRows 必须为 1。COMMIT outcome unknown 不重放。

成员降权或停用会在同一事务自动撤销其所有 pending invitations。并发 consume/consume、consume/revoke、重复 normalized username、签发者降权/停用及等待 family lock 跨过 invitation expiry 均有真实 MySQL targeted integration 覆盖。

## Role boundary 与成员管理

已实现：

- `GET /api/v1/families/:familyId/members`
- `PATCH /api/v1/families/:familyId/members/:memberId`

MEMBER 不能管理成员。ADMIN 只能 disable/restore 普通 MEMBER，不能管理 ADMIN、SUPER_ADMIN 或自己。SUPER_ADMIN 可管理 MEMBER/ADMIN，但普通 API 对任意 SUPER_ADMIN 目标的 disable、restore、downgrade 和 remove 均拒绝；API contract 也禁止创建或晋升 SUPER_ADMIN。不存在 member delete endpoint。

成员停用只修改目标家庭的 `family_members.disabled_at`，不修改全局 `users.disabled_at`，也不影响同一 user 的其他家庭 membership。至少一个有效 SUPER_ADMIN 作为 fail-closed invariant 保留；本阶段没有普通 API 能修改 SUPER_ADMIN。

## Bootstrap CLI

本机一次性命令：

```text
pnpm --filter @family-album/api bootstrap:dev
```

CLI 要求显式 `APP_ENV=dev`、非 production、无额外 argv、stdin/stdout 均为 TTY、目标为本机 `family_album_dev` 且 DB user 非 root。它验证 Native FK/foreign_key_checks、UTC、strict mode、六个预期表、Phase 1A migration journal hash，以及 users/families/family_members 全为空。

密码仅通过 raw-mode 无回显 TTY 两次输入，不从 argv/env 读取。username-v1、密码规则、Argon2id 参数及共享并发 budget 与 Auth 共用。固定 MySQL named lock `family_album_dev.bootstrap.v1` 在每次事务 attempt 获取，并且只在明确 commit/rollback 后释放；释放失败销毁连接，COMMIT 不明销毁且绝不重放。family、first user 和 first SUPER_ADMIN member 在一个事务创建，不创建 invitation/session。

本阶段没有在真实 DEV 数据库执行 bootstrap；unit tests 使用 synthetic connection 验证成功、重复/部分初始化、root/错库、migration 不匹配、同时竞争、锁释放失败及 commit unknown。真实 MySQL integration 只读核对了已执行 migration 的 journal hash。

## URL / QR 与 HTTP 安全

邀请链接 helper 固定生成 `https://<trusted-origin>/join#token=<TOKEN>`，拒绝 HTTP、带 path 的 origin 和 malformed token；QR helper 返回同一完整本地 payload，不接触第三方 QR 服务。完整 Join UI、fragment 读取后 `replaceState` 清除以及二维码视觉渲染留给后续 Web slice。

Phase 1C API 返回 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。写请求继续使用精确 Origin/JSON 门禁；WEB 管理接口只接受 Cookie session，公开 invitation flow 拒绝 Authorization 且不会因已有 Cookie 自动关联账号。Fastify 自动 request URL logging 已关闭，避免误传 query token 先于验证进入日志。

## Audit、限速与敏感信息

已实现 invitation created/revoked/consumed、member role changed/disabled/restored 及 bootstrap completed/rejected 的结构化安全事件。事务成功事件只在 commit 明确完成后写入；revoke/member mutation 使用事务返回的真实 actor member ID。

日志采用字段白名单，Pino redaction 新增 raw token、invitationToken、invitationUrl 及各请求嵌套路径；不记录 token hash、password/PHC、Cookie、Authorization、credential body 或 raw driver error。preview/consume 共用每 IP 15 分钟 30 次的有界内存预算；管理写操作使用 actor+family 同样的有界预算。所有 API Argon2 work 共用 Phase 1B 的全局 limiter。

## Targeted tests

- Unit/API/Auth dependency：22 个 test files，141 tests PASS。
- MySQL integration：Phase 1C + Phase 1B auth dependency，2 个 test files，30 tests PASS。
- API/DB/Auth/Contracts/Permissions typecheck：PASS。
- Scoped ESLint：PASS。
- Scoped Prettier write/check：PASS（summary 创建后再次检查）。
- 未运行全仓 build 或 E2E，符合本阶段 targeted test 范围。

## 尚未完成 / 已知限制

- 本地真实 HTTPS 浏览器对 Cookie 行为，以及 Join 页面 fragment 立即清除、no-third-party network 和二维码本地视觉渲染，仍需后续 Web slice 提供浏览器证据。
- DEV 内存限速会在进程重启后重置；上线前仍需确定持久化或可信网关限速方案。
- 结构化安全日志不是数据库事务型 exactly-once audit store；专用持久审计存储仍按既有设计延期。
- SUPER_ADMIN transfer/recovery/replacement 未实现，必须走未来独立审查的本机维护流程；bootstrap 不可用于恢复。
- Android Bearer session 与 Phase 2 均未开始。

`DATABASE_MIGRATION_REQUIRED: NO`

`READY_FOR_PHASE_1_FINAL_REVIEW: YES`
