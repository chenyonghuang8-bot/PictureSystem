# Phase 1A — Identity Foundation 完成总结

Phase 1A 已完成。Phase 1B 尚未实现、尚未开始。

## 数据库与 migration

- DEV：`family_album_dev`，MySQL 9.7.2 LTS。
- `@@GLOBAL.innodb_native_foreign_keys = 1`（ON）。
- `@@SESSION.foreign_key_checks = 1`。
- 应用用户：`family_album_dev_user@localhost`，非 root。
- 已执行 migration：`0000_phase_01a_identity_foundation`。
- 业务表：users、families、family_members、invitations、sessions。
- Drizzle journal：`__drizzle_migrations`，已验证 1 条记录。
- 13 个二级/唯一索引、7 个外键、7 个 CHECK；InnoDB、utf8mb4。
- 最近一次 Native FK live verification：BINARY(32)、VARBINARY、BIGINT exact string、7/7 CHECK 均 PASS。
- sessions 的不存在 `user_id=999999` probe 正确返回 ERROR 1452（ER_NO_REFERENCED_ROW_2），PASS。
- Synthetic 验证事务已回滚；随后确认五张业务表均为 0 行。
- 本次收尾未再次执行 migration，也未修改其 SQL/snapshot。

## Auth primitives 与最终 Argon2 参数

username-v1、密码校验、独立 Session/Invitation token helper、SHA-256 二进制 hash、Auth 错误契约已实现。

Argon2id v=19：memoryCost=65536 KiB，timeCost=6，parallelism=1，saltLength=16 bytes，hashLength=32 bytes。

采用既有 Mac mini M4 synthetic benchmark 结果：t=3 约 100.3ms；t=6 约 200.9ms。目标约 200–500ms。本次采用已批准的 t=6，未重新测量；单样本结果不代表负载或生产并发性能。旧 t=3 PHC 会被 needsRehash 标记，新 hash 使用 t=6。

## FK health 与 fail closed

`packages/db/src/health.ts` 提供 `validateDatabaseHealth`，读取当前连接的 Native FK/global 与 FK checks/session 状态。

- Native FK 非 1 或缺失：`DB_NATIVE_FK_REQUIRED`。
- session FK checks 非 1 或缺失：`DB_FK_CHECKS_REQUIRED`。
- 查询失败直接拒绝通过，不报告健康。
- 已接入 Phase 1A preflight 和迁移后 verifier，并从 DB package 导出。
- 不执行 SET GLOBAL 或自动修正数据库设置。
- API `/health` 仍为 Phase 0 liveness；本次 DB health validation 位于 DB package 与验证脚本中。

## 本次 targeted checks

- `pnpm exec vitest run packages/auth/src packages/db/src`：7 files，52 tests PASS。
- `pnpm --filter @family-album/auth --filter @family-album/db typecheck`：PASS。
- Auth/DB 源码、脚本与 Drizzle 配置 ESLint：PASS。
- 同范围 Prettier check：PASS。
- 新增 FK health 的关闭/缺失/查询失败测试；更新 t=6 PHC 与旧参数 rehash 测试。
- 本次未重复执行 live 数据库 probe；以上 live 结果来自本任务紧邻收尾前已完成的 Native FK migration 验证。

## 尚未实现

Phase 1B 的 bootstrap、登录/登出、Cookie、Session middleware、CSRF、Invitation API/consume、Role management、Web 登录页面与 Android 通道均未实现。本次未调用 Bridge，未进入 Phase 1B 或 Phase 2。
