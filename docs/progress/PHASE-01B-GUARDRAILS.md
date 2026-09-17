# PHASE_1B_GUARDRAILS

状态：implementation guardrails review 已完成；Phase 1B.1 安全补丁已按 Astra 批准的 patch plan 实现并通过 targeted tests。未修改 schema、执行 migration、调用 Bridge 或进入 Phase 1C。

ROUTING DECISION：PRO_SPARK_BALANCED / R3-IMPLEMENT / Current Model unknown / Recommended GPT-5.6 Sol Medium / Bridge no / targeted / continue。依据：Astra 安全复核与 patch plan 已完成，本次未改变 transaction、locking 或 Auth 安全设计。

DESIGN_CHANGE_REQUIRED: NO

## Phase 1B.1 实施补充

- 日志采用认证事件字段白名单；Pino redaction 明确覆盖顶层、`body`、`req.body` 中的 password/currentPassword/newPassword/session token/token hash，以及 Cookie、Authorization。业务日志不序列化请求 body 或原始 Error。
- 所有先锁 user、再处理多条 session 的路径，先取得 session ID 清单，再逐条按数值 ID 升序执行 locking read；logout-all 与 password change 使用同一策略。login 在 session 锁之后才锁有效 family_members，最后插入 session。
- expiry、idle timeout、recent-auth 判断使用全部相关锁取得后另发的 `SELECT CURRENT_TIMESTAMP(3)`，不使用等待锁之前的时间。
- 事务只对白名单死锁且完整 rollback 成功的情形重试：原尝试加最多两次，jitter 分别为 10–50ms、25–100ms；等待前释放旧连接，每次重新取得健康连接。锁等待超时不自动重试。
- rollback 失败或连接状态不确定时销毁连接。COMMIT 抛错一律视为 outcome unknown，销毁连接、不 rollback、不重放、不发送成功 Cookie；内部类别为 `COMMIT_OUTCOME_UNKNOWN`。
- Fastify 默认显式 `trustProxy=false`。仅 `TRUSTED_PROXY_CIDRS` 中通过校验的精确 IP/CIDR 可启用信任链；不允许 `true` 全信任，也不手工取 X-Forwarded-For 首项。
- PHC 结构确认损坏时对外返回通用 503，内部分类 `CREDENTIAL_CORRUPTION`；密码不匹配、Argon2 容量耗尽和执行失败分别使用独立内部类别，均不记录 PHC/parser/stack。

现有五表及 PHASE-01-DESIGN.md 可支持本次八个认证 endpoint。以下是对其锁顺序、状态检查、错误处理和测试的实现细化，不要求改变 schema、token 架构或超时策略。Argon2 使用 Phase 1A 已批准的 t=6，原设计第 4 节 t=3 是历史起点，不应复制进实现。

## 依据与代码现状

已检查 AGENTS.md、PHASE-01-DESIGN.md、PHASE-01A-SUMMARY.md，以及 packages/auth、db、contracts 和 apps/api 的相关源码。环境依据已完成的 Phase 1A 验证：MySQL 9.7.2、Native FK=1、session FK checks=1、FK probe 返回 1452；本次未重新执行这些测试。

- token.ts 已使用 randomBytes(32)，严格 43 字符 canonical unpadded base64url，SHA-256(raw bytes) 返回 Buffer。Session/Invitation helper 分离，但二者没有不同编码前缀；跨类型隔离依赖只查正确表，不能尝试多表 fallback。
- password-hash.ts 当前为 Argon2id v=19、m=65536 KiB、t=6、p=1、salt=16 bytes、hash=32 bytes。尚无 dummy PHC、限速或进程级并发控制。
- sessions 已包含所需时间、撤销和 client_type 字段；无 role snapshot。BIGINT 为 bigint，API 必须显式转十进制字符串。
- createDatabase 已设置 mysql2 UTC 转换和精度选项，但尚未强制调用 DB health。timezone: Z 不等于 MySQL SESSION time_zone 已是 UTC。
- validateDatabaseHealth 检查两个 FK 开关；尚需在真实 API 使用的连接上集成。
- API 仅 /health liveness，无 Auth 路由、Cookie/Origin/middleware。错误契约已有稳定 code/message/requestId。

## 1. Endpoint 实现顺序

先建立共用请求限额、Origin 校验、安全错误映射、Cookie serializer、DB 连接健康验证和 Argon2 调度器，再按下列顺序实现。测试账号使用获授权的隔离 synthetic fixture；本次范围不包括 bootstrap。

| 顺序 | Endpoint（/api/v1 前缀）         | 实现与完成条件                                                                                                     |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1    | POST /auth/login                 | 严格 username/password 输入；统一失败响应与 dummy verify；锁用户后复核并插入全新 WEB session；commit 后 Set-Cookie |
| 2    | GET /auth/me                     | session middleware；本人最小信息和实时有效家庭成员身份；无 hash、token 或全局角色推断                              |
| 3    | POST /auth/logout                | 当前 session 撤销，重复退出幂等；通过 Origin 门禁后清 Cookie；DB 撤销失败返回 503                                  |
| 4    | GET /auth/sessions               | 只列本人会话，允许字段白名单，ID 字符串；分页与数量上限；无 token/hash、IP 或完整 UA                               |
| 5    | DELETE /auth/sessions/:sessionId | 调用者 session 有效，目标限定本人；重复撤销不改变原原因/时间；不存在与非本人目标同一响应                           |
| 6    | POST /auth/reauth                | 当前口令验证、同一 session 行 token rotation；维持 created_at/expires_at；并发仅一次成功                           |
| 7    | POST /auth/logout-all            | recent-auth；撤销包含当前在内的全部旧会话；成功清 Cookie，不自动创建替代会话                                       |
| 8    | POST /auth/password              | 校验当前口令及新口令；同一事务换 hash、设置 password_changed_at、撤销旧 session、建立替代 WEB session              |

GET 不触发退出、token rotation 或其他业务写操作；允许 middleware 按频率更新 last_seen_at 这种会话活动记录。response DTO 与数据库实体分离。sessionId 仅接受正整数十进制字符串且不超过 BIGINT UNSIGNED 上限，禁止 Number/parseInt 转换。

## 2. Transaction / locking 要求

每个事务使用同一个 checked-out connection，不在事务中用 pool 随机连接执行查询。MySQL REPEATABLE READ 下授权复核用 locking current read，不复用事务外对象或旧快照。锁等待结束后重新取得服务器时间，不能拿排队前时间判断到期/recent-auth。

Phase 1B 的锁序为 users → sessions（多行按数值 ID 升序）→ family_members（如需锁）。不增加反向锁用户的路径；未来涉及家庭管理时服从原设计的 families → users → sessions → members 顺序。SQL ORDER BY 和索引访问计划都要验证，不把 UPDATE 的书写顺序当作行锁顺序保证。

| 动作           | 锁与提交要求                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| login          | 在事务外取得 password_hash 并 verify；随后锁 users，比较当前 hash 与已验证的完整 PHC，检查 disabled_at、有效成员；插入新 session。成员状态必须从当前读获得；未来成员停用的家庭授权仍实时检查。rehash 的新 PHC 在锁外准备，持锁时比较原 hash 后才替换，不改变 password_changed_at |
| logout         | 单行条件 UPDATE，限定 session id、user id、请求 token_hash 及尚未撤销；不在锁 session 后再锁 user。重复调用允许无更新，但不能用过期 token 定位后撤销已经 rotation 的新 token                                                                                                     |
| DELETE session | 事务中锁调用者 user，再按 ID 排序锁调用者和目标 session；复核调用者 token_hash/有效期/未停用，目标必须属于该 user。只更新目标 revoked_at/reason，重复操作不覆盖；删除本人当前 session 时清 Cookie                                                                                |
| logout-all     | 锁 user，再锁其 session 行；复核调用者仍有效且 recent-auth。撤销全部未撤销会话。login 也锁同一 user：login 先提交则被撤销，logout-all 先提交则随后独立口令登录可以签发新 session，这是提交顺序语义                                                                               |
| reauth         | verify 在锁外；锁 user → 当前 session，复核 password_hash 未变、请求旧 token_hash 仍匹配、用户有效、session 未撤销且未过期；换全新 token_hash，更新 authenticated_at/last_seen_at，保留 created_at/expires_at                                                                    |
| password       | 当前口令 verify 与新 hash 在事务外完成；锁 user → sessions，复核旧 password_hash 和调用者 token_hash/有效状态。原子更新口令、撤销所有旧 session（PASSWORD_CHANGE）、插入替代 session。当前口令验证即本次 fresh proof，不能只靠旧 recent-auth 跳过当前口令                        |

换密中的“校验在同一事务内”落实为锁内复核已验证的 PHC 和授权状态；昂贵的 Argon2 运算不持锁。失败任一步全部 rollback；只有 commit 明确成功后发送新 Cookie。commit 结果不明返回通用服务失败，不重放写操作、不声称已撤销成功；用户重新登录恢复。

撤销后的新认证检查必须拒绝；已经完成认证的数据读取不能追回。最后活动时间 UPDATE 必须限定旧 token_hash、未撤销、未过期和写入间隔，并取单调不减的时间，禁止“读整行再回写”复活会话。死锁仅在明确完整回滚后最多重试 2 次；第一次重试等待 10–50ms、第二次 25–100ms，释放旧连接后再等待并重新获取健康连接、加锁、读状态和服务器时间。锁等待超时完整 rollback 后直接失败，不自动重试。rollback 失败或连接协议状态不确定时销毁连接，不放回池。COMMIT outcome 不明确时绝不重放，即使后续 rollback 看似成功也不能推断原提交失败。

## 3. Session middleware 规则

只从 __Host-family_session 提取 WEB 凭证，不接受 URL/query/body session token。重复同名 Cookie、歧义 header 或同时存在 Cookie 与 Authorization 凭证直接拒绝。本阶段不开放 ANDROID Bearer；将来独立通道严格比较数据库 client_type，不能把任一 token 在两种 transport 中通用。

解析 canonical 32-byte token → SHA-256 Buffer → sessions JOIN users 当前查询。要求 WEB、hash 匹配、revoked_at 为空、users.disabled_at 为空。未知/畸形/撤销/到期 token 对外统一 UNAUTHENTICATED。身份与 family role 分离：/me 从有效成员行得角色，不从 session、客户端字段或全局 user 推断。

绝对到期为创建后 30×24 小时；空闲为 last_seen_at+7×24 小时。now >= 任一期限即无效。expires_at 不滚动；reauth 不延长绝对寿命。last_seen_at 最多每 5 分钟条件写一次；比较持久化值，因此允许比精确活动时间最多早约 5 分钟到期，不能先 touch 再检查过期。并发 touch 的旧时间不得覆盖新时间。

recent-auth 条件为 0 <= now-authenticated_at < 15 分钟，边界恰为 15 分钟需要 reauth；将来时间异常同样拒绝。logout-all 必须 recent-auth；logout 与本人单 session 撤销不额外要求 recent-auth。换密始终要求当前密码；reauth 本身不能要求 recent-auth，否则会形成无法刷新认证的循环。

DB 查询/必需 touch 写入失败返回 503，不使用缓存身份、不跳过授权。API readiness 必须区别于现有 liveness。实际借用连接在执行 Auth 前验证 Native FK=1、SESSION FK checks=1、严格 SQL mode 和 UTC；新连接/重连不能沿用其他连接的健康结果。不得自动改 GLOBAL 设置。MySQL UTC session 初始化属于连接配置，要验证默认 CURRENT_TIMESTAMP 与应用显式时间一致。

## 4. Cookie / Origin / CSRF 规则

Cookie 固定 __Host-family_session；Secure、HttpOnly、SameSite=Lax、Path=/，无 Domain。Max-Age 向下取整且不超过绝对剩余秒数；成功 login/reauth/password 才发送新值。清除时使用相同 name/path 和安全属性并设 Max-Age=0。WEB 响应正文不返回 raw token，token 不进浏览器 storage。

所有 POST/DELETE（包括 login、logout）在昂贵运算和副作用前校验 Origin：精确匹配配置中的 HTTPS origin（scheme/host/port），拒绝缺失、null、多值、无效及不匹配 Origin。不能用 Host/X-Forwarded-Host 自动构造信任来源，也不能用后缀匹配。Fastify 默认固定 `trustProxy=false`；只有 `TRUSTED_PROXY_CIDRS` 明确列出可信精确地址/CIDR 时才启用，禁止全信任或手工采用 XFF 首项。同源部署，禁止任意来源 credentialed CORS；预检不授予不可信站点权限。

写请求统一 JSON Content-Type（允许 charset）；无业务字段的 POST/DELETE 使用空 JSON 对象。限制 body 总大小与字段白名单，拒绝表单/text/plain 和意外字段。GET 可没有 Origin，但若提供则不可借此放开跨源读取；读取响应不允许跨源 CORS。

本设计选择严格 Origin + JSON + 同源策略作为 CSRF 门禁，SameSite 仅辅助；不能因 Cookie=Lax 省略 Origin 检查。如果未来需要支持缺 Origin、跨站前端或表单写入，需单独评估 CSRF token 方案。XSS 仍能代表用户发请求，不把 HttpOnly 描述成 XSS 授权防护。

logout 的“总是清理 Cookie”只对通过 Origin 门禁的退出请求成立；Origin 拒绝不修改 Cookie。一般 401 和 rotation 竞争失败不自动 clear-cookie，防止迟到失败响应覆盖并发成功的新 Cookie。两个独立成功登录响应乱序可能选择其中一个仍有效会话；客户端应串行登录/reauth/换密。旧 token 无宽限期，rotation 提交后立即失效；响应丢失时重新登录。

## 5. 限速、dummy verify 与资源预算

| 维度                | 固定窗口基线                                    |
| ------------------- | ----------------------------------------------- |
| normalized username | 15 分钟最多 10 次失败                           |
| IP                  | 15 分钟最多 50 次尝试；1 分钟最多 10 次突发     |
| username + IP       | 15 分钟最多 5 次失败                            |
| Argon2              | 单 API 进程最多 2 个正在执行的运算，队列最多 10 |

先限制 body/header 与 IP，再 username-v1，再规范化 username/combo 桶，最后进入 Argon2 队列。username 桶与 DB 是否存在完全无关；Dad/dad/全角同桶。并发需预留失败额度，完成后转换为失败计数或释放；成功只清组合失败计数，不能抹掉别的在途预留、username 失败或 IP 总量。

login、reauth、当前密码验证、新密码 hash、rehash、dummy verify 都共享同一调度器。换密多个运算顺序执行，不能占一个名额却同时跑多个 hash。取消等待任务应清队列；已开始的 native Argon2 不能因 HTTP 断开就释放名额，必须等运算实际完成。队列必须有有限等待期限；满载/超时统一 SERVICE_UNAVAILABLE，可返回 Retry-After，限速触发则 429 RATE_LIMITED。

未知 username 对提交的候选密码执行一个预先生成的 dummy PHC verify（m65536/t6/p1），结果永不授权；不能每次请求重新生成 dummy hash。dummy 初始化失败 readiness 不通过。已存在、停用、无有效成员、密码错误的账号均走口令 verify 后统一 401，避免账号状态早返回。无效输入可提前拒绝，但输入规则对所有账号相同。

口令错误时不额外 rehash；成功需要 rehash 才执行受预算保护的新 hash。确认 malformed PHC 时拒绝登录并使用内部 `CREDENTIAL_CORRUPTION`；普通不匹配为 `INVALID_PASSWORD`，容量耗尽为 `ARGON2_CAPACITY_EXHAUSTED`，其他 verify/hash 执行异常为 `ARGON2_EXECUTION_FAILURE`。对外仍为统一 401 或通用 503，不能回退接受明文或低成本 hash，也不输出 hash、parser 信息或堆栈。

reauth/换密从已认证用户取得 normalized username，共享口令尝试预算，不接受客户端另选用户名绕过。桶 key 用进程密钥 HMAC，最多 10000 桶、TTL 清理；容量满拒绝新分配，不驱逐活跃限速桶。IP 正规化和可信代理策略固定；不能信任任意 X-Forwarded-For。

当前仅单实例 DEV 内存限速；重启会清空，多进程不共享。上线/扩容前仍需原设计要求的持久限速或网关策略，五张业务表并未实现该能力。

## 6. Error contract 与日志

统一使用现有 {code,message,requestId}，requestId 由服务端生成或严格验证；Zod/Fastify/数据库异常通过统一映射输出，拒绝未知响应字段。所有认证响应（包括失败）Cache-Control: no-store。

| 情况                                             | HTTP / code                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| username 不存在、错密、停用、无有效成员          | 401 INVALID_CREDENTIALS，完全相同公开文案                             |
| session 缺失、未知、到期、撤销、transport 不适用 | 401 UNAUTHENTICATED                                                   |
| Origin 不可信、recent-auth 超时                  | 403 FORBIDDEN；本阶段无需新增 code，可由前端进入 reauth 流程          |
| JSON/字段/ID 格式不合法                          | 400 INVALID_REQUEST；体积/媒体类型拒绝可用 413/415，同一安全 envelope |
| 口令尝试阈值                                     | 429 RATE_LIMITED + Retry-After                                        |
| DB/连接健康/Argon2 队列不可用                    | 503 SERVICE_UNAVAILABLE                                               |
| 并发验证状态已变化且当前凭证仍有效               | 409 CONFLICT；旧 token 已失效则 401                                   |

DELETE 非本人或不存在 session 可统一 204，无目标存在性提示；成功/重复 logout 使用 204。所有幂等成功都必须保证授权门禁已满足；DB 错误不可映射为成功。

日志仅记录事件名、服务器时间、requestId、必要的非敏感 user/session ID、结果码及安全内部分类。拒绝序列化 request body、Cookie、Authorization、Set-Cookie、password/currentPassword/newPassword、PHC、raw token、token hash、DATABASE_URL、SQL 参数及带凭据 URL。SQL driver Error 可能含原 SQL/参数，不能直接 app.log.error({err})；validation 错误可能含输入，需安全映射。Pino 仍配置纵深 redaction，并以实际序列化输出测试顶层、body、req.body、正常与异常路径。

## 7. 必测 race conditions 与验收

用两个独立真实 MySQL 连接、受控 barrier 安排提交次序，不只依赖 mock 或 sleep；用隔离 synthetic fixtures，测试失败也清理。不得使用真实家庭账号或执行 bootstrap。

1. login 与 logout-all 两种提交顺序，确认前者已提交会被撤销，后者之后独立登录可成功。
2. login verify 后并发换密：旧 PHC 不再匹配，拒绝签发；rehash 不覆盖新口令、不更新 password_changed_at。
3. password 任一步失败（写 hash、revoke、insert、commit 前）全部回滚；commit 不明不重试、不发新 Cookie。
4. 两个 reauth 使用同一旧 token：恰一个 rotation 成功；另一请求不修改 Cookie，不覆盖胜者 authenticated_at/token。
5. reauth 与 logout/logout-all/换密：撤销行不被复活；旧 token 不得在 rotation 后凭 session ID 撤销胜者；revoke-all 可以撤销已提交的新 token。
6. last_seen touch 与 revoke/rotation、两个 touch 乱序：不复活、不延长 expires_at、不倒退时间；5 分钟边界最多一次有效更新。
7. DELETE A→B 与 DELETE B→A 并发：统一锁顺序，撤销后调用者在锁内失效；任何路径都不能跨 user。
8. 30 天、7 天、15 分钟前/等于/后边界；锁等待期间过期；未来 authenticated_at 拒绝；reauth 不重置 30 天。
9. 同 username 不同拼写并发、多个 IP/组合、容量满、429、队列 2+10、断开连接和超时；所有 Argon2 调用均受预算限制。
10. 未知/停用/错密/无成员统一响应和等成本 verify 调用；token malformed/padding/非 canonical 拒绝；WEB 与 Bearer、ANDROID 与 Cookie、双凭证拒绝。
11. 真实本地 HTTPS 浏览器检查 __Host Cookie 属性、同源 fetch；缺失/null/恶意/相似域 Origin、form/text/plain、login CSRF 均拒绝。普通 app.inject 不能替代此浏览器证据。
12. DB 断开、Native FK/SESSION checks 校验失败、坏 PHC、参数校验异常均 fail closed，日志及响应无 credential 泄露；BIGINT 响应不丢精度。

## 8. P0 安全风险与实现阻断条件

以下是 Phase 1B 实现必须防住的风险，不代表已存在一个上线认证系统漏洞。

| P0 风险                                           | 必须落实的防线                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 旧密码或旧 session 在等待锁后继续授权             | 锁内 current read；比较完整 PHC、请求 token_hash、状态与新服务器时间         |
| logout-all/换密漏撤销或 touch/reauth 复活 session | 统一 user→session 锁序；撤销与新 session 原子提交；条件更新                  |
| CSRF 或 session fixation                          | 严格 Origin+JSON；成功登录生成新 token；固定 __Host Cookie；transport 不混用 |
| credential 泄露或跨用户会话操作                   | 白名单 DTO、日志脱敏、session ownership 条件；不回传 token/hash              |
| 密码爆破或 Argon2 耗尽内存                        | 三维限速、原子预留、全局 2 运算+10 队列、dummy 等成本路径                    |
| DB 不健康仍授权、时间配置导致延长寿命             | 使用实际连接健康门禁；服务器时间与 UTC 校验；DB 错误拒绝授权                 |

DESIGN_CHANGE_REQUIRED: NO。上述内容是原设计的必要实现细化；不需修改 PHASE-01-DESIGN.md 或现有 migration。若未来需求放宽 Origin、变更 transport、提供 revoke-all 后禁止重新口令登录的额外语义、或支持多实例限速，需另行审查。

## 外部核对与范围

本次对 Cookie、会话轮换、重新验证密码和 Origin 检查进行了官方安全资料核对：[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)。具体超时、限速参数和锁协议来源为项目已批准设计及本次实现细化。

Phase 1B.1 targeted 验证包括事务 retry/failure、Pino 实际输出、PHC 分类、proxy trust、Auth service/routes，以及使用两个真实 MySQL 连接和可控 barrier 的 login/logout-all、login/换密、交叉 session revoke、等待锁跨 expiry/idle timeout。真实 HTTPS 浏览器 Cookie 行为仍是后续 Web 认证验收项，不能由 `app.inject` 替代。未实现 Invitation、Role management、Phase 1C 或 Phase 2。
