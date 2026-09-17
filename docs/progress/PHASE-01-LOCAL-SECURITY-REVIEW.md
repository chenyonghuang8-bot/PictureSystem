# Phase 1 Final Local Security Review

日期：2026-09-15。范围：Phase 1 Auth、Session、Invitation、Family roles、Bootstrap、Schema、事务与对应测试。首次审查为本地静态安全审查；同日完成 P1-01 修复复核、真实 MySQL 回归和最终 Quality Gate。本报告未授权或进入 Phase 2。

依据：本地 packages/auth、contracts、permissions；packages/db 的 schema、connection、health、transaction、Auth/Phase1C repositories、bootstrap；API auth/phase1c routes/services、HTTP guards、logger config、bootstrap CLI/TTY；对应 unit/API/integration 测试；Phase 1 design、B/C guardrails 与 A/B/B1/C summaries。此前 Quality Gate 的 PASS 是既有执行证据，不代表本次重新执行。MySQL 9.7.2、Native FK=1、FK checks=1 及 ERROR 1452 同样引用前次验证，未重新连接数据库。

## Overall

PASS_WITH_WARNINGS

P0：0；P1：0（原 P1-01 已关闭）；P2：4；P3：1。

原阻断项是日常认证的 idle 检查与 last_seen 写入不在同一锁后状态判断内。该项已经修复并通过完整 `AuthService.authenticate()` idle/absolute 锁等待回归。下述 P2/P3 保留为 deferred/non-blocking，不影响进入 Phase 2，但其中标记为 `BLOCKS_PRODUCTION` 的项目仍须在生产交付前完成。

已经存在的控制：严格 token canonical 解码及 SHA-256(raw bytes)、密码 Argon2id t=6 与共享并发池、未知账号 dummy verify、严格输入白名单、Cookie/Origin 门禁、默认不信任代理、用户锁串行化登录/换密/revoke-all、COMMIT 不明不重放、邀请消费事务、最终 ADMIN revoke 规则及 SUPER_ADMIN 普通 API 禁改规则。未发现可确认的明文凭证响应、跨家庭写入、SUPER_ADMIN 晋升或已撤销 session 被直接清除 revoked_at 的路径。

## P0

未发现有充分本地证据支持的 Critical blocker。

## P1

### P1-01 — CLOSED：日常认证可在 idle 到期后持久化刷新 last_seen

- Original finding：`AuthService.authenticate` 的初始读取与旧 `touchSession` 分离，旧 touch 未在锁后复核 idle deadline，可能把等待期间过期的 session 刷新复活。
- Resolution：`MySqlAuthRepository.touchSession` 现复用事务 helper，按 users → sessions 加锁，在锁完成后读取数据库 server time，并复核 user enabled、WEB、token hash、revoked_at、absolute expiry 和 7-day idle expiry。只有仍有效且超过 5-minute throttle 的 session 才执行 conditional UPDATE；`affectedRows` 必须为 1。锁后失效会返回 `UNAUTHENTICATED`，`AuthService.authenticate` 必须等待 touch 成功才返回。
- Regression evidence：真实 DEV MySQL 双连接 barrier 已覆盖完整 `AuthService.authenticate()` 调用链等待期间跨过 idle deadline 和 absolute expiry；两种情况均返回 HTTP 401、`last_seen_at` 不变且后续认证失败。未跨期 touch 与 5-minute throttle 也通过。
- Re-review：Original P1 `CLOSED`；未发现 residual session resurrection/auth bypass。两阶段 authenticate → touch 结构在当前锁后权威复核下不构成 Phase 2 blocker。

## P2

### P2-01 — PHC 结构检查缺少计算资源上界

- Finding：合法结构的 PHC 可携带远超当前预算的 m/t/p。
- Evidence / file + symbol：`packages/auth/src/password-hash.ts:49`，`isValidArgon2idPhc` / `positiveInteger` 只要求正安全整数；随后 `verifyPassword` 将 PHC 交给 native Argon2。`Argon2Limiter` 限任务数，不限单任务内存/耗时。
- Exploit/failure scenario：损坏或未来错误导入的 credential 仍满足结构要求，但包含巨大资源参数；一次登录即可消耗高内存或长期占满计算槽位。当前普通 API 不能提交 PHC，故不是已证明的匿名远程参数注入。
- Severity reason：服务端 credential corruption 的可用性风险，已有权限边界降低了可达性，非 Phase 2 阻断。
- Minimal fix：为支持的历史 PHC 规定 m/t/p、salt/digest 长度及格式上界，进入 native verify 前拒绝超预算值；保留 t=3 等明确支持的 rehash 兼容性；内部安全分类、对外通用 503。
- Required test：结构合法但资源超上界的 PHC 不调用 native verify；正常 t=6 和受支持旧参数仍成功；错误密码与 corruption 不混淆；测试不实际分配巨大内存。

### P2-02 — Invitation limiter 的键未执行已批准 HMAC 规则

- Finding：Invitation 限速 Map 存储原始 IP 和 management:userId:familyId 字符串。
- Evidence / file + symbol：`apps/api/src/phase1c/service.ts:187`，`recordInvitationAttempt` / `recordManagementAttempt`；与 `packages/auth/src/rate-limit.ts` 的进程密钥 HMAC 及 C guardrails 第 9 节要求不一致。
- Exploit/failure scenario：进程 dump/诊断若暴露该 Map，可直接关联 IP 与管理主体；不需要反推出 HMAC。未发现该 Map 目前被记录到日志，也未证明此问题本身允许绕过次数上限。
- Severity reason：隐私纵深防护和已批准实现约定缺口，不是 role/auth bypass。
- Minimal fix：复用一致的键派生规则，为 public IP 与 management 域分隔并使用进程随机密钥 HMAC；保留现有窗口、共享预算和容量拒绝行为。
- Required test：同一 IP 的 preview/consume 共桶、management 与 IP 域不冲突、容量满 fail closed、到期回收；存储键不包含明文 IP/主体。

### P2-03 — 竞态测试证据不足以支持“全部安全边界均已验证”

- Finding：若干 guardrails 中要求的真实竞争只覆盖顺序状态或 mock。
- Evidence / file + symbol：`tests/integration/phase1c.test.ts:433,471` 先完成 downgrade/disable 再 consume；`:394` 使用 Promise.allSettled，没有控制两种提交顺序。`packages/db/src/bootstrap.test.ts` 的双 bootstrap 是模拟 connection/GET_LOCK；真实 integration 仅检查 migration journal。Auth barrier 部分用 delay 猜测等待，而未断言已到达锁等待位置。
- Exploit/failure scenario：调度变化或后续重构导致锁内复核遗漏，既有顺序测试仍通过。当前静态锁/授权检查提供支持，不能据此断言已存在可利用的 invitation race。
- Severity reason：安全回归证据缺口；不把未知行为冒充已确认漏洞，也不撤销此前测试确实 PASS 的事实。
- Minimal fix：补受控的双向提交测试，证明实际等待位置；在已批准的隔离环境验证真实 named lock，不在现有用户数据上运行 bootstrap。
- Required test：consume vs inviter disable/downgrade 两方向；session revoke/reauth vs invitation create/revoke/member patch；ADMIN 等锁时降权；跨家庭相同 normalized username；真实 bootstrap 双连接互斥和再执行拒绝；每种消费写失败后的 orphan/used 状态。

### P2-04 — Integration 入口自身未强制 DEV/non-root 条件

- Finding：测试直接使用环境连接串创建 pool；有值即运行，无值则 skip，未在 fixture 写入前自行核验目标身份。
- Evidence / file + symbol：`tests/integration/auth-phase1b.test.ts:19,22`、`tests/integration/phase1c.test.ts:23,26`；beforeAll 直接 INSERT。`packages/db/src/index.ts:createDatabase` 是通用工厂，不验证数据库名称和 CURRENT_USER。
- Exploit/failure scenario：未来从其他 shell/CI 运行测试时载入错误目标，synthetic INSERT/cleanup 会进入错误数据库。前次 Quality Gate 单独做了 DEV preflight，因此这不是对前次运行访问 Production 的指控。
- Severity reason：运维误配置防护缺口，当前单一 DEV 环境未发生已知数据事件；引入 Production 或自动化执行前必须补齐。
- Minimal fix：统一 integration fixture preflight，在任何写入之前确认目标 DEV、非 root、FK/UTC/strict 等要求；质量门禁模式缺环境应失败。通用数据库工厂无需为此增加隐式读取 env。
- Required test：错误库/root/缺环境在第一条 fixture 写入前拒绝；正确 DEV 执行且精确清理；禁止以 skip 作为成功门禁。

## P3

### P3-01 — 阶段文档存在过时状态及覆盖表述

- Finding：早期 design/guardrail 段落仍称后续阶段未实现；部分总结把 mock/顺序状态检查概括为并发验证。
- Evidence / file + symbol：`docs/progress/PHASE-01-DESIGN.md` 开头、`PHASE-01B-GUARDRAILS.md` 的“代码现状”、B1/C summaries 的历史状态；C summary 已明确 bootstrap 未在真实 DEV 执行，应保留该限定。
- Exploit/failure scenario：后续实现者把历史起点或概括性测试结果当成当前权威状态，遗漏必要验收。
- Severity reason：可维护性与证据准确性，不是运行时越权。
- Minimal fix：保留设计历史，增加清晰的当前状态索引，区分单测、真实 MySQL、可控双向 race 与浏览器验证。
- Required test：文档人工核对实际 test 名称/断言，无需业务测试。

## Missing Tests

P1-01 的完整 authenticate/touch idle 与 absolute 边界测试已经补齐。其余 deferred 测试以 P2-03 的交叉模块竞争为先，包括：

- 真实 HTTPS 浏览器 Cookie 存储、同源携带、HttpOnly、rotation/clear；无可信 Origin、null Origin、跨站 fetch/预检均拒绝，不能用 app.inject 替代。
- 大于 2^53 的 INSERT 返回 ID 在实际 mysql2 路径的精度证明；既有选项 supportBigNumbers/bigNumberStrings 和 CAST 查询是正确方向，不能仅凭 String(insertId) 推断或否定精度。
- PHC 有界参数、共享 login+consume Argon2 峰值、限速容量和窗口切换时仍有在途 reservation。
- Pino 正常/异常路由与框架错误的实际输出：当前 redaction 测试覆盖人工构造日志对象，仍应补路由事件及自动错误路径；不将“人工 redaction 测试 PASS”等同所有日志路径已覆盖。
- Bootstrap TTY 在 Ctrl-C、粘贴、多字节输入时的终端恢复，以及真实 named-lock 生命周期。禁止用真实家庭密码测试。

## Production Readiness Gaps

| 项目                                           | 分类                  | 说明                                                                     |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| P1-01 idle/touch 边界                          | NON_BLOCKING / CLOSED | 锁后复核及完整 AuthService idle/absolute 回归均已通过                    |
| 真实 HTTPS Auth/Cookie 与 Join 浏览器行为      | BLOCKS_PRODUCTION     | 当前 Playwright 仅 API health smoke；Web Auth 最终验收仍需完成           |
| 持久/多实例生产限速                            | BLOCKS_PRODUCTION     | 当前内存方案适用于既定单实例 DEV，不保证重启/扩容后的预算                |
| persistent audit storage                       | BLOCKS_PRODUCTION     | 结构化 stdout 事件不等于耐久、事务一致的审计存储；生产审计方案需独立完成 |
| SUPER_ADMIN recovery/transfer maintenance flow | BLOCKS_PRODUCTION     | 正式家庭交付前需要可审查的恢复流程及演练；bootstrap 永远不可替代恢复     |
| Android Bearer transport                       | NON_BLOCKING          | 当前只交付 WEB 边界；Android 功能交付前另验收                            |
| P2-01/02/04                                    | BLOCKS_PRODUCTION     | 可在 Phase 2 开发中排期，生产前完成对应防护                              |
| P2-03 测试补强                                 | NON_BLOCKING          | 本身不证明漏洞；应继续纳入后续安全回归                                   |

静态正向检查：username NFKC/lowercase 与 binary unique 设计一致；é/e、ß/ss 的区别属明确约定。密码未 trim/normalize；未知/停用账号走 verify，corruption 对外通用 503。Cookie 固定 __Host/Secure/HttpOnly/Lax/Path，无 Domain；写入精确 HTTPS Origin+JSON，未配置开放 credentialed CORS。默认 trustProxy=false；显式宽 CIDR 是运维信任配置风险，不等同默认 XFF 可伪造。Invitation revoke 先按目标 role 授权再幂等；consume 新建账号且不发 session；membership 停用不改全局用户；普通 API 禁改任何 SUPER_ADMIN。显式锁遵守既定层级，唯一索引/FK 隐式锁仍可能死锁，由有限重试处理。COMMIT 不明销毁连接且不重放。Schema 与历史 runtime FK 证据支持约束存在，但本轮未重新执行 FK/CHECK probe。

## Final Recommendation

READY_FOR_PHASE_2: YES

原阻断项 P1-01 已关闭；New P0：0，New P1：0。四项 P2 和一项 P3 维持 deferred/non-blocking，其中生产前置项仍按上表执行。

最终 Quality Gate：format、lint、typecheck、186 项 Vitest、34 项独立 MySQL integration/race、workspace build、Playwright API health smoke 1/1 全部 PASS；Skipped Phase 1 tests：0。未执行 bootstrap，未修改数据库 schema/migration，未进入 Phase 2。
