# Phase 1B.1 — Auth Security Patch 完成总结

状态：Phase 1B.1 已完成。实现严格遵循 GPT-6 Astra Low 已批准的 patch plan；`DESIGN_CHANGE_REQUIRED: NO`。未修改数据库 schema、未执行 migration、未调用 Bridge、未进入 Phase 1C。

## 已完成

- 日志防护：认证事件只记录安全白名单字段；Pino redaction 覆盖 password、currentPassword、newPassword、Cookie、Authorization、raw session token 与 token hash 的顶层及请求嵌套路径。日志不直接记录 driver/parser Error。
- Session 锁顺序：先锁 user，再将相关 session 按数值 ID 升序逐行锁定。logout-all 与 password change 共用相同策略；login 在 session 之后锁 family_members，再插入新 session。
- 时间复核：相关行锁全部取得后，另发服务器时间查询，再检查 absolute expiry、idle timeout 与 recent-auth。
- 事务失败策略：只对完整 rollback 的 MySQL deadlock 进行最多两次额外尝试，jitter 为 10–50ms、25–100ms；每次使用新的健康连接。lock wait timeout 不自动重试。
- 连接处置：rollback 失败或协议状态不确定时销毁连接。COMMIT outcome 不明确时不 rollback、不重放、不发送成功 Cookie，并映射内部 `COMMIT_OUTCOME_UNKNOWN` 与通用 503。
- Proxy/IP：默认 `trustProxy=false`；只有经过配置校验的精确可信 IP/CIDR 才启用代理信任，不直接信任 X-Forwarded-For 首项。
- PHC 分类：错误密码、确认的 malformed PHC、Argon2 容量耗尽、Argon2 执行失败使用不同内部类别；客户端仅收到稳定的 401/503，不暴露 PHC、parser 或 stack。

## Targeted tests

- Auth/DB/API typecheck：PASS。
- Auth/transaction/logging/routes/proxy/config targeted unit tests：PASS。
- Phase 1B synthetic MySQL integration：16 tests PASS。
- 双真实连接与可控 barrier 已覆盖 login/logout-all 两种提交顺序、login/换密、交叉 revoke，以及锁等待跨过 absolute/idle expiry 后的重新判定。
- 未运行全仓 build/E2E；符合本阶段 targeted test 范围。

## 尚未完成

- 真实本地 HTTPS 浏览器对 `__Host-family_session` 的存储、同源携带、rotation 和清除行为尚未提供证据；该项不阻塞后端 Phase 1C 开发，但在 Web Auth 验收前必须完成。
- Phase 1C、Invitation、Role management、bootstrap、Android Bearer 通道与 Phase 2 均未开始。

READY_FOR_PHASE_1C
