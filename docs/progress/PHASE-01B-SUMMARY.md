# Phase 1B Summary

状态：Phase 1B Web authentication/session core 已完成。未实现 Invitation、Role management、Bootstrap、相册权限、Android credential transport、Web UI 或 Phase 2。

## 实现范围

已实现以下 `/api/v1/auth` endpoint：

- `POST /login`
- `GET /me`
- `POST /logout`
- `POST /logout-all`
- `POST /reauth`
- `POST /password`
- `GET /sessions`
- `DELETE /sessions/:sessionId`

相关实现包括严格请求/响应 contracts、MySQL session repository、认证 service、WEB Cookie transport、Origin/JSON CSRF 门禁、session middleware、recent-auth、认证限速、全局 Argon2 调度预算和脱敏结构化认证事件。

## Session 与事务

- Session token 使用 Phase 1A 已完成的 32-byte CSPRNG、canonical unpadded base64url；DB 只保存 SHA-256 32-byte hash。
- WEB 只接受 `__Host-family_session` Cookie；本阶段拒绝 Authorization/Bearer，且拒绝 Cookie 与 Authorization 混用。
- Session 绝对期限 30 天、idle timeout 7 天；`last_seen_at` 只在持久化值已超过 5 分钟时条件更新，不延长 `expires_at`。
- 每次 DB Auth 操作使用实际 checked-out connection，fail closed 检查 Native FK、session FK checks、UTC session time zone 与 strict SQL mode；不会修改 MySQL GLOBAL 设置。
- login、logout-all、reauth、password change 和本人 session revoke 使用 guardrails 规定的锁内状态复核。多行路径遵循 `users → sessions`；密码修改在一个事务中更新 hash、撤销旧 session 并创建替代 session。
- BIGINT API ID 全程使用十进制字符串，不经过可能丢精度的 JavaScript number。

## Cookie、Origin 与错误边界

- Cookie 固定为 `Secure; HttpOnly; SameSite=Lax; Path=/`，不设置 Domain；Max-Age 向下取整且不超过 session 剩余绝对期限。
- 所有 POST/DELETE Auth 请求要求 canonical、精确 allowlist 内的 HTTPS Origin 和 JSON Content-Type；拒绝缺失、`null`、多值、格式错误或未知 Origin，不开放宽泛 credentialed CORS。
- 登录、reauth、换密仅在 DB transaction 明确 commit 后设置新 Cookie；失败响应不覆盖现有 Cookie。logout 的 DB revoke 失败不会清 Cookie或返回成功。
- Auth 响应统一 `Cache-Control: no-store`，错误使用稳定 `{code,message,requestId}`。应用认证日志不包含 password、request body、Cookie、Authorization、raw token、token hash 或 PHC。

DEV Cookie 不会因 HTTP 开发便利而降级。浏览器联调必须把 Web 和 `/api` 放在同一个本地 HTTPS origin 后（例如受信任的本地 TLS reverse proxy），并把该 canonical origin 配入 `TRUSTED_WEB_ORIGINS`；直接 HTTP 调试不会收到 Secure Cookie。当前 targeted HTTP tests 使用 Fastify injection 验证 Cookie 属性、Origin/Content-Type 和错误 envelope；真实浏览器 HTTPS smoke 留给 Web UI 集成阶段。

## 资源保护

- normalized username：15 分钟 10 次失败。
- IP：15 分钟 50 次尝试；1 分钟 10 次 burst。
- normalized username + IP：15 分钟 5 次失败。
- 并发请求先预留失败额度；成功只清组合失败计数。
- 单进程 Argon2 全局最多 2 个运行、10 个排队，等待 5 秒超时；login、dummy verify、reauth、password hash/verify 和 rehash 共用预算。
- Dummy PHC 在 API 启动时生成一次；未知 username 执行 dummy verify，账号不存在、错密、disabled、无有效 membership 对外统一为 `INVALID_CREDENTIALS`。

Argon2 参数保持 Phase 1A 定稿值：Argon2id v=19、memoryCost=65536 KiB、timeCost=6、parallelism=1、salt=16 bytes、hashLength=32 bytes。M4 既有 benchmark 为约 200.9 ms/hash。

## 验证结果

- Phase 1B 相关 package/unit targeted suite：16 files，92 tests，PASS。
- MySQL 9.7.2 targeted integration：1 file，10 tests，PASS。
- Integration 覆盖 synthetic 登录签发、无 membership 拒绝、幂等 logout、并发 reauth 单胜者、rotation 后旧 token 不清替代 Cookie、跨用户 session revoke 隔离、原子换密、last_seen 节流、login/password race、login/logout-all commit-order 语义。
- `@family-album/auth` typecheck：PASS。
- `@family-album/api` typecheck：PASS。
- `@family-album/contracts` typecheck：PASS。
- `@family-album/db` typecheck：PASS。
- Phase 1B scoped ESLint：PASS。
- Phase 1B scoped Prettier check：PASS。

真实 DB 测试只使用随机 synthetic fixture，并按 `sessions → family_members → users → families` 顺序清理；未运行 bootstrap、未接触 Production、未执行或修改 migration。

## 已知限制与后续边界

- 当前 rate limiter 是单 API 进程内存实现；进程重启会重置，多实例不共享。Production/多实例前必须引入持久化或网关级限速方案，不能把当前实现视为集群保护。
- 当前 `/health` 仍是 liveness。Auth 请求本身会逐连接 fail closed；独立 readiness 和真实浏览器 HTTPS Cookie smoke 可在部署/Web 集成工作中补充。
- Phase 1B 仅正式开放 WEB Cookie transport。ANDROID Bearer 只保留 DB client type，不可通过当前 endpoint 使用。
- 本阶段没有实现 Invitation、Role management、Bootstrap 或 family-resource authorization middleware。

本阶段未调用 Bridge，未进入 Phase 1C 或 Phase 2。
