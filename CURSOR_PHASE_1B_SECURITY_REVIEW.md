# Phase 1B Security Review

审查范围：Phase 1B Web Auth / Session 只读安全审查。未修改代码，未连接或修改数据库，未运行 migration，未输出 secret。

依据：`AGENTS.md`、`docs/progress/PHASE-01-DESIGN.md`、`docs/progress/PHASE-01B-GUARDRAILS.md`、`docs/progress/PHASE-01B-SUMMARY.md`，以及 `packages/auth`、`packages/contracts`、`packages/db/src/auth-repository.ts`、`apps/api/src/auth/*` 与相关 tests。

## Overall
PASS_WITH_WARNINGS

核心登录、session hash、Cookie 属性、Origin/JSON CSRF 门禁、WEB/Bearer 隔离、换密事务、reauth rotation、logout-all 与 user 行锁串行化、dummy Argon2、三维限速和 fail-closed DB 错误处理均已落地，且与设计/guardrails 一致。未发现可直接利用的 P0。进入 Phase 1C 前应处理下方 P1（尤其是日志脱敏、死锁重试、反代 IP、以及仍缺失的真实 HTTPS 浏览器证据）。

## P0
必须立即修复的安全问题

- 无。

## P1
进入 Phase 1C 前建议修复的问题

- **日志脱敏不完整。** `createLoggerOptions()` 只 redact `password` / `*.password` / `*.token` / Cookie / Authorization。换密字段是 `currentPassword` / `newPassword`，不匹配这些路径；也未 redact `set-cookie`、`passwordHash` 以外的 PHC 字段名变体、或 SQL driver `err`。当前 Fastify 默认 request log 不含 body，因此不是立刻泄露，但一旦打开更详细日志或走 `app.log.error({ err })`，凭据可能进日志。Auth 成功/失败路径本身只记 `event` / `result` / `requestId` / `userId`，这一点是对的。
- **`inTransaction` 没有死锁重试。** Guardrails 要求明确回滚后最多 2 次抖动重试。login / logout-all / reauth / password / revokeOwnSession 共用该事务包装。死锁会变成 503，不会写一半，但并发换密/logout-all/login 在真实 MySQL 上可能不必要地失败。
- **logout-all 只 `FOR UPDATE` 当前 session，再 `UPDATE ... WHERE user_id` 全表撤销。** 与 login 都先锁 `users`，commit-order 语义成立（integration 已覆盖）。未按 guardrails 字面“锁其全部 session 行”先锁再改；目前靠 user 锁阻止并发签发。建议在 1C 前改成与 `changePassword` 相同的 `ORDER BY id ASC FOR UPDATE` 全 session 锁，避免后续家庭写路径插入反向锁。
- **未配置 `trustProxy`。** 限速 IP 使用 `request.ip`。本机直连没问题；若 Web/API 已按 SUMMARY 要求放到同一 HTTPS reverse proxy 后，所有客户端可能共享一个 socket IP，IP/burst 桶失效或被一人打满。需要显式可信反代，不能默认信任任意 `X-Forwarded-For`。
- **损坏 PHC 对外是 503，不是统一 401。** 符合“不得接受明文/低成本 hash”，但与错密 401 可区分；也没有脱敏内部告警。应记内部事件（不含 hash），对外仍可保持 fail closed。
- **真实本地 HTTPS 浏览器 Cookie/CSRF 证据仍缺失。** Guardrails 明确 `app.inject` 不能替代。SUMMARY 把它推迟到 Web UI。Phase 1C 邀请页会真正依赖 `__Host-` Cookie 与 Origin；在 1C 前端接入前至少补一条本地 HTTPS smoke。

## P2
可以以后处理的问题

- 内存限速：单进程、重启清空、多实例不共享。SUMMARY 已记录；Production 前必须替换。不属于 1C 邀请实现阻断。
- `/health` 仍是 liveness，不反映 DB/Argon2 dummy 就绪。Auth 请求本身会逐连接 health check。
- login 带 `Authorization` 返回 400 `INVALID_REQUEST`，其他路由双凭证是 401 `UNAUTHENTICATED`。
- 无有效 membership 的失败发生在 Argon2 之后的事务内，比 unknown/disabled 多一次 DB 往返；公开错误码相同。
- `authenticate()` 先 `findSession` 再无 affected-rows 检查的 `touchSession`。撤销与 GET `/me` 之间存在设计已承认的 in-flight 窗口。
- `updated_at` / `authenticated_at` 落在未来时，`isValid` 仍可能通过；`isRecent` 会拒绝负年龄。
- logout / 部分 POST 未单独设置 16KB `bodyLimit`（login/reauth/password 有）。
- `Argon2Limiter` 队列超时后，已开始的 native hash 仍占名额直到完成（这是正确行为，但缺少 HTTP 断开场景测试）。

## Missing Tests

已覆盖（抽查）：unknown dummy Argon2；disabled/wrong password 统一失败形状；WEB 拒绝 ANDROID session；绝对/空闲/撤销/停用 fail closed；Cookie 属性与无 Domain；Origin 缺失/null/untrusted；非 JSON；Cookie+Bearer；login 不复用旧 Cookie；logout 旧 token 不清新 Cookie；reauth 单胜者；rotation 后旧 token 不能当 logout 目标；跨用户 session revoke；换密原子性；login/password 与 login/logout-all commit-order；last_seen 节流；token canonical/malformed；限速 username/IP/combo/burst；Argon2 2+队列上限。

实现存在但测试不足：

- 真实 HTTPS 浏览器：`__Host-family_session` 在浏览器里的 Secure/HttpOnly/SameSite/Path/无 Domain；不可信 Origin 的跨站 POST；同源 fetch。
- login 同时携带 Bearer 的 400 路径。
- 多值 Origin、带 path 的 Origin、`http://` Origin。
- 无 membership → 401 `INVALID_CREDENTIALS` 的 service/HTTP 层（仅 repository integration）。
- 损坏 PHC → 503 且日志无 hash。
- 日志 redact：`currentPassword` / `newPassword` / `set-cookie` / driver `err`。
- 限速 10000 桶容量拒绝、HMAC 桶隔离（Dad/全角同桶在 service login 有 normalize，限速层本身未测不同拼写）。
- DELETE session A↔B 死锁/锁顺序双连接测试。
- touch 与 revoke/rotation 交错（integration 只测节流，不测复活）。
- 15 分钟边界恰好相等（service 测了 stale logout-all；缺 lock-wait 后重读服务器时间）。
- 30 天绝对期限的时钟边界（SQL `INTERVAL 30 DAY` 无断言）。
- 无 CORS 头 / 无 wildcard credentialed CORS 的正向断言。
- dummy PHC 启动失败时进程拒绝就绪。

## Known Limitations

- Phase 1B 只开放 WEB Cookie。ANDROID Bearer 未实现；当前会拒绝 `Authorization`。
- 限速为进程内存实现，不能当作集群保护。
- 未实现 Invitation、Role management、Bootstrap、家庭资源授权中间件。
- DEV 的 `__Host-` + Secure Cookie 要求 Web 与 API 同 HTTPS origin，并写入 `TRUSTED_WEB_ORIGINS`。
- 设计允许撤销提交前已通过认证检查的 in-flight 响应把数据返回；不能追回。

## Ready for Phase 1C
YES

可以开始 Phase 1C（Invitation）后端，前提是不要把当前 HTTP inject 测试当成浏览器 Cookie 已验收，并在 1C 涉及跨页/跨 origin 之前补 P1 中的 HTTPS smoke 与日志脱敏。本次未修代码。
