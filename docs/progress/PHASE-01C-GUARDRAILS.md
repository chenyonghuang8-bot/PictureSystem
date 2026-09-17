# PHASE_1C_GUARDRAILS

状态：安全设计与 implementation guardrails review 完成，尚未实现 Phase 1C。日期：2026-09-14。

```text
ROUTING DECISION
Profile: PRO_SPARK_BALANCED
Risk: R3-DESIGN
Current Model: GPT-6 Astra / Low（依据用户本次确认）
Recommended Model: GPT-6 Astra Low
Bridge: no
Test Scope: targeted
Action: continue
Reason: Phase 1C security design and implementation guardrails

DESIGN_CHANGE_REQUIRED: YES（本次收紧 ADMIN invitation revoke 权限；其余安全架构不变）
DATABASE_MIGRATION_REQUIRED: NO
```

本文件细化既有 Phase 1 安全架构，不改变五表、锁层级、session 协议或三角色模型。本次 role-boundary 复核收紧 ADMIN 的 invitation revoke 权限。依据为根目录 AGENTS.md、PHASE-01-DESIGN.md、Phase 1A/1B/1B.1 总结及相关源码。AGENTS.md 当前阶段段落仍写 Phase 1C BLOCKED；本次按用户最新明确授权进行设计审查，未把旧状态当作已完成的 Cursor re-review 证据。数据库环境依据用户及既有验证记录：MySQL 9.7.2、Native FK=1、session FK checks=1；本次没有连接数据库或重复执行测试。

## 最终角色边界裁决

PHASE_1C_ROLE_BOUNDARY_DECISION：本节及下文同步后的规则，取代旧设计和实现 Prompt 对以下两项的不同解释。

- MEMBER 不得撤销邀请；ADMIN 仅可撤销本家庭 MEMBER invitation，无论由本家庭哪位管理员签发；本家庭 ADMIN invitation 仅 SUPER_ADMIN 可撤销。SUPER_ADMIN 可撤销本家庭 MEMBER/ADMIN invitation。均要求有效身份及 recent-auth，不存在“自己创建所以可以越级撤销”的例外。
- 普通 API 不得创建、晋升、停用、恢复、降权或移除 SUPER_ADMIN 成员；SUPER_ADMIN 也不能通过普通 API 管理另一位 SUPER_ADMIN。本人正常登录、换密和 session 管理不受此成员管理禁令影响。
- 保留至少一名有效 SUPER_ADMIN 的系统不变量；本阶段通过禁止上述管理动作保护它，不以“当前有两名”为由开放操作。未来转移/恢复走单独审查的本机维护流程，不在 Phase 1C 实现。

撤销不会授予权限，不直接形成权限升级；但撤销 ADMIN invitation 能否决 SUPER_ADMIN 的招募决定并造成可用性干扰。记录操作者能保留审计归属，却不能替代权限检查。约 5 人家庭无需为此增加越级撤销或多 SUPER_ADMIN 管理机制。

Required changes to PHASE-01C-GUARDRAILS.md: YES。
Required database migration: NO。
Required API contract changes: YES（撤销接口的授权/403 行为约定收紧；路径及 JSON 字段不变。SUPER_ADMIN 管理禁令保持，未新增接口）。

## 1. 现有基础与接入要求

- users 的全局 VARBINARY username 唯一键、family_members 的 family/user 唯一键和 family/id 复合键、invitation BINARY(32) 唯一 hash、同家庭 creator/consumer/revoker FK 足够。invitation role ENUM 无 SUPER_ADMIN；used-pair、used-or-revoked、expiry、revoker-requires-revoked-at CHECK 保留。权限、single-use 与最后管理员不变量仍需事务执行，不能只依赖 FK/CHECK。
- packages/auth 已有独立 invitation token helper、username-v1、Argon2id v19 m65536/t6/p1、16-byte salt、32-byte hash。直接复用。API invitation hash 必须与 Auth 共用同一个 PasswordEngine/Argon2Limiter 实例（2 running、10 queued、5s queue timeout）；当前实例在 AuthService.create 内创建，实施时通过组合入口共享注入，禁止另建一个 limiter 或直接绕过 limiter 调 hashPassword。
- packages/permissions 仍为空占位。Phase 1C 增加家庭角色判断，不实现相册授权；不得把占位注释“Phase 2”解读为允许跳过本阶段 server-side enforcement。
- 复用 runTransaction 与健康连接获取逻辑。当前 checkedConnection 为 auth repository 私有辅助函数，需要抽取共享或等价安全封装；Native FK、SESSION FK checks、UTC、strict mode 任一异常均拒绝。不得改 GLOBAL 配置。
- 现有 API no-store hook 和 framework error handler 只匹配 /api/v1/auth/。Phase 1C 必须显式把 invitations/families 路由纳入同样的安全错误、缓存及日志策略，不能假设注册新 route 就自动覆盖。

## 2. Endpoints 与请求边界

下表路径均加 /api/v1。所有 IDs 使用受限 BIGINT UNSIGNED 十进制字符串，数据库 Buffer/BigInt 不直接序列化。输入/输出采用严格字段白名单，拒绝未知字段；不把 req.body spread 到 insert/update。

| Endpoint                                                  | 输入与权限                                                                                                  | 响应                                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| POST /families/:familyId/invitations                      | WEB session、本家庭 ADMIN+、recent-auth；body 仅 role（默认 MEMBER）、expiresInHours（整数 1–168，默认 48） | 201；id、role、expiresAt、一次性 invitationUrl；无 hash，无重复 raw-token 字段                                       |
| GET /families/:familyId/invitations                       | WEB session、本家庭 ADMIN+；受限 cursor/limit，默认 20、最多 100                                            | id、role、createdAt、expiresAt、派生状态；无 token/hash/link/签发者私人信息                                          |
| POST /families/:familyId/invitations/:invitationId/revoke | WEB session、recent-auth；ADMIN 仅 MEMBER invitation，SUPER_ADMIN 可 MEMBER/ADMIN；空 JSON                  | 授权后 204 幂等或已使用 409；ADMIN 撤销 ADMIN invitation 为 403；不覆盖撤销归属                                      |
| POST /invitations/preview                                 | body 仅 token；无登录要求                                                                                   | 200；familyName、role、expiresAt，且不返回签发者/成员/家庭内部 ID                                                    |
| POST /invitations/consume                                 | body 仅 token、username、password、可选 displayName                                                         | 201 空成功结果；不签发 session、不设置或清除 Cookie                                                                  |
| GET /families/:familyId/members                           | 有效本家庭成员                                                                                              | 分页最小成员身份、role、家庭成员状态；无 credential/global disabled 信息                                             |
| PATCH /families/:familyId/members/:memberId               | 有效本家庭管理者、recent-auth                                                                               | 仅允许 role=ADMIN/MEMBER 或 disabled:boolean；建议 strict union 每次只改一个维度，避免组合操作歧义；200 最小成员 DTO |

最后两个 endpoint 是原设计已有成员管理边界的明确化，未额外开放全局用户管理、家庭创建、成员物理删除、退出或 SUPER_ADMIN 转移 API。

所有 POST/PATCH/DELETE，包括 preview 和 consume，先执行精确 HTTPS Origin allowlist + JSON 门禁，禁止依赖 Host/XFF 构造 Origin。统一限制 body 为 16KiB；名称字段验证合法 Unicode 与 128 code points 上限，不允许 SQL 截断；password 使用原有 code-point/UTF-8 校验，绝不 trim/normalize。WEB 管理接口仅 Cookie，拒绝 Bearer/混用。公开邀请接口不从 Cookie 推断被邀请人身份、不自动关联现有账号；Authorization header 拒绝，浏览器附带 Cookie 不改变 token-only 新账号流程。

错误统一 {code,message,requestId}：无效/畸形 token、过期、已使用、撤销、签发者失权均为 400 INVALID_INVITATION；不区分详细原因。有效邀请下 username 冲突为 409 CONFLICT（账号不可用语义，不区分存在/停用）；不新增查重接口。无 session 为 401，已确认本家庭身份但能力不足或 recent-auth 不足为 403。无家庭权限、资源不存在、member/invitation 不属于路由家庭均为相同 404（可复用 FORBIDDEN 安全文案），不返回目标是否存在。DB/commit/资源故障为通用 503，限速 429+Retry-After。全部成功与失败响应 no-store。

## 3. Permission matrix

所有“是”均要求 actor.user 未全局停用，actor.member.disabled_at/left_at 为空，且 member.family_id 等于被操作家庭。recent-auth 为锁后服务器时间下 0 <= age < 15 分钟。角色来自实时数据库成员行，session 不保存快照。

| 行为（仅当前家庭）                                 | MEMBER | ADMIN           | SUPER_ADMIN     |
| -------------------------------------------------- | ------ | --------------- | --------------- |
| 查看家庭最小成员资料                               | 是     | 是              | 是              |
| 创建 MEMBER invitation                             | 否     | 是，recent-auth | 是，recent-auth |
| 创建 ADMIN invitation                              | 否     | 否              | 是，recent-auth |
| 列出家庭邀请                                       | 否     | 是              | 是              |
| 撤销未使用 MEMBER invitation                       | 否     | 是，recent-auth | 是，recent-auth |
| 撤销未使用 ADMIN invitation                        | 否     | 否              | 是，recent-auth |
| 停用/恢复 MEMBER                                   | 否     | 是，recent-auth | 是，recent-auth |
| 停用/恢复 ADMIN                                    | 否     | 否              | 是，recent-auth |
| MEMBER ↔ ADMIN                                     | 否     | 否              | 是，recent-auth |
| 管理自身角色/停用自身                              | 否     | 否              | 否              |
| 创建/晋升/降权/停用/恢复/移除 SUPER_ADMIN          | 否     | 否              | 否              |
| 修改全局 users.disabled_at、他人密码/全局 sessions | 否     | 否              | 否              |

撤销权限按锁定 invitation.role 判定：ADMIN 仅 MEMBER，SUPER_ADMIN 为 MEMBER/ADMIN。ADMIN 对 ADMIN invitation 返回 403 FORBIDDEN，即使邀请已撤销也不能以幂等为由跳过授权；任何人不能通过客户端 role 或 creator 字段覆盖此判断。授权仍先核实同家庭归属，跨家庭统一 404。列表权限不等于撤销权限。

判定目标操作权限使用其修改前 role；未知角色默认拒绝。停用/恢复只改本家庭 member 行，恢复沿用 ID，不清 left_at，不更改 role，不恢复已撤销邀请。left_at 非空拒绝恢复；未来重新加入另行设计。SUPER_ADMIN 无全局 bypass，也不能绕过未来 album permission。

## 4. 通用事务与锁顺序

固定：families（如适用）→ 已存在 users 数值 ID 升序 → sessions 数值 ID 升序 → family_members 数值 ID 升序 → invitations 数值 ID 升序。

管理写事务先锁路由 family，收集 actor/target/相关签发者等所需定位 ID，然后按层逐个主键锁定；定位预查不是授权。禁止 JOIN FOR UPDATE 让优化器任意决定跨表加锁顺序，禁止在 invitation 锁后补锁已有 user/member。多行不能仅凭 ORDER BY 宣称锁顺序保证。家庭锁持有到 commit/rollback，所有成员变更和邀请变更遵守同一协议。

所有授权读取使用 locking current read；不要在等待家庭锁前建立 REPEATABLE READ 快照，再拿该旧快照的成员计数做授权。锁后重新核对预查的所有 family/user/member/invitation 关联；关联不符拒绝。锁全部取得后另发 SELECT CURRENT_TIMESTAMP(3)，用于 session token/WEB/revoked/absolute/idle/user disabled、recent-auth、invitation expiry 的最终检查。

Auth.authenticate 仅用于入口拒绝和定位，不能替代管理事务内锁 caller user/session、核对请求 token hash 和有效状态。消费属于 invitation capability 流程，没有 caller session，不锁签发人的 session，也不要求邀请签发后签发人持续登录或 recent-auth。

复用现有 runTransaction：仅已完整回滚的 ER_LOCK_DEADLOCK 最多 2 次额外重试，10–50ms/25–100ms jitter，等待前释放；每次健康连接、锁和授权重新获取。lock timeout 不重试，rollback/连接不明确则销毁；COMMIT 不明绝不重放。事务回调不能发成功日志、HTTP 响应或其他外部副作用。已验证输入、预计算 PHC 可在本次请求的已回滚尝试之间复用，但数据库授权结论不可复用。

新 user/member 插入是既有消费协议允许的创建动作，不是倒序锁定其他已存在主体；唯一索引/FK 隐式锁可能造成跨家庭死锁，仍由同一 helper 处理，必须真实 DB 测试。不得声称显式锁排序排除了所有 InnoDB 死锁。

## 5. Invitation transaction

### Create / list / preview / revoke

创建：严格输入 → 外层身份与限速 → 生成独立随机 token → transaction 锁 family、actor user、actor session、actor member → 锁后时间与实时授权/recent-auth → 插入绑定 family/member/role/hash 和显式 createdAt/expiresAt → 明确 commit 后才返回链接。role 是请求候选值，必须经服务端矩阵批准；familyId 仅定位，createdByMemberId 从 actor 推导。期限固定，不提供修改 endpoint。

列表只查所属家庭并分页，派生 USED/REVOKED/EXPIRED/PENDING；若签发者已失权但尚未批量撤销，展示不可用而非有效 PENDING。preview 以 hash 定位，核对 token、邀请状态及签发者 user/member 当前状态和授予能力；只读，不写 used_at，不自动执行清理。预览不保证稍后的消费会成功。只读授权应让身份条件和数据查询处于同一有效查询视图，避免先授权再无条件查询泄露。

撤销：family → actor user → actor session → actor member → 本家庭 invitation；最终检查 recent-auth 和实时角色，按 invitation.role 授权（ADMIN 仅 MEMBER，SUPER_ADMIN 可 MEMBER/ADMIN），再判断状态。授权后 used 返回 409，revoked 返回 204 且不覆盖；包括过期但尚未使用邀请在内均可标记 revoked。revoked_at 与 revoked_by_member_id 同次更新；系统自动撤销允许后者 NULL。系统在既有停用/降权事务内自动撤销邀请是独立安全副作用，不是手动 revoke 权限的旁路。

### Consume（仅创建新账号）

1. Origin/JSON/body、IP 限速、token canonical、username-v1/password/displayName 校验。按 hash 预查仅获得 invitation/family/creator 定位；无效预查直接统一拒绝。有效候选才在事务外通过共享 Argon2 engine hash，限制无效 token 的计算消耗。
2. runTransaction：先锁 invitation 指向的 family；锁 creator user；无 session 层；锁 creator family_member；锁 invitation。检查锁定行关联与原 hash 完全一致，creator 未停用/退出且当前仍能授予该 role。
3. 最后单独取服务器时间；检查 unused、unrevoked、now < expires_at。失败不写任何业务行。签发者当前失去授予能力时邀请失效；普通 API 不提供 SUPER_ADMIN→ADMIN。未来经审查维护流程造成该变化时，消费复核同样拒绝旧 ADMIN invitation。任何本阶段允许的停用/降权事务按下节主动撤销，恢复不会复活。
4. INSERT 新 users，username_normalized 为规范化 UTF-8 Buffer；仅识别 username 唯一键冲突为 CONFLICT，其他 DB 异常为 503。不得 UPSERT、查到旧 user 就复用、修改旧密码或创建旧账号的第二家庭 membership。
5. INSERT family_members，family/role 均来自锁定 invitation，joined_at 用服务器时间。以生成的精确字符串 ID 条件更新 invitation：hash 匹配、unused、unrevoked、expires_at > 检查时间；同写 used_at 和 used_by_member_id，affectedRows 必须 1，否则全部回滚。
6. 明确 commit 后成功，sessions 行数不变。任何 insert/update/FK/username 失败均无 orphan user/member、invitation 未消费。AUTO_INCREMENT 间隙不是孤儿数据。

两次消费在 family/invitation 上串行：只允许一次成功。提交成功但响应丢失时，重试为统一 INVALID_INVITATION；客户端提示尝试用刚设置的 username/password 登录，不查验 token 来“找回”账号或返回登录凭证。COMMIT 不明返回 503，同样不自动重放；既有登录可恢复确认。创建邀请响应丢失时无法恢复 raw token，管理员通过列表识别并撤销不需要的邀请后重建，不增加明文存储或幂等凭据表。

## 6. 成员变更与最后 SUPER_ADMIN

member role/disabled 事务：锁 family → 相关 actor/target users 升序 → caller session → actor/target members 升序 → 目标签发的全部未使用、未撤销 invitations 升序；然后新服务器时间复核 actor/session/recent-auth、目标原 role 和矩阵，再写 member 与批量 revoke。

任何降权或停用在同一事务撤销目标签发的全部未使用邀请，即使某些 MEMBER invitation 在降权后的角色看来仍可签发，也保持原设计的彻底撤销语义。used 行不更新；自动撤销可用 revoked_by_member_id=NULL。恢复/晋升不复活邀请。全局 users.disabled_at 不由此接口修改；若未来全局停用，消费仍检查 creator.user 状态，跨家庭批量清理另审。

有效 SUPER_ADMIN = role=SUPER_ADMIN 且 member.disabled_at/left_at、user.disabled_at 均为空。普通 API 一律禁止修改 SUPER_ADMIN 目标，即使存在两个也拒绝。因此本阶段不提供可能把最后一位移除的操作，不用计数“允许删一个”。可以在家庭管理事务内检查至少一位有效 SUPER_ADMIN，已损坏为零时 fail closed，交本机维护流程，不自动选举或 bootstrap。

如需上述健康计数，先在持有 family 锁下定位该家庭 SUPER_ADMIN users，把它们纳入 users 升序锁集合，再在 member 层纳入相应 member 锁，以锁内状态计算；不能锁 member 后再 JOIN 锁 user。未来允许转移/降权/全局停用的流程必须独立审查所有受影响家庭的不变量；当前 schema 不提供跨行 CHECK 保证，不能对任意手工 SQL 声称安全。

未来维护流程应有显式本机运维授权、目标库/家庭确认、备份与安全审计，不能只凭持有 invitation 或能访问 HTTP 发起。正常转移需要验证现有管理员和接任账号，再在遵守锁层级的事务中建立有效接任者并处理原角色，提交时至少保留一位；丢失全部管理凭据时需独立身份/运维恢复审查，无默认恢复密码或通用后门。恢复工具必须与空库 bootstrap 分离。Phase 1C 不交付该工具，也不宣称已解决忘记密码恢复；正式交付前应安排恢复流程及演练。禁止日常 API 修改 SUPER_ADMIN 可防止误操作锁死，不能替代凭据丢失的运维恢复。

consume vs disable/downgrade：消费先 commit 则新成员合法成立，后续变更不追溯删除已经入群成员；变更先 commit 则邀请失效、消费拒绝。revoke vs consume 同理。两者必须测试两个方向。

## 7. Bootstrap CLI

仅本机显式 DEV CLI；无 HTTP route、默认密码、argv/env 管理员密码输入或 first-visitor 机制。连接凭据仍来自既有 DEV secret 配置，绝不打印 DATABASE_URL。数据库必须 family_album_dev，CURRENT_USER 非 root，连接目标为本机 DEV；验证 Native FK/SESSION FK、UTC、strict mode、已审查 migration journal/hash 与五表结构已就绪，不执行 DDL。

stdin 与 stdout 必须 TTY。无回显读取密码并二次输入确认，Ctrl-C/错误恢复终端状态；禁止 shell history、日志、PHC 或密码回显。username-v1/密码规则和最终 Argon2 参数完全共享。交互与 hash 在取得 DB 锁前完成，避免人工输入长期占锁；成功仅输出安全的创建 IDs/状态。

并发协议：同一专用连接持有固定命名锁 family_album_dev.bootstrap.v1，有限等待（例如 5s），GET_LOCK 只有 1 通过，0/NULL 均失败。取得锁后、在事务内重新确认 users/families/family_members 全为空；任一非空、部分初始化或旧管理员停用都拒绝。新建 family → user → SUPER_ADMIN member 在一个事务内，明确 commit 后才成功；不创建 session/invitation。新行不存在时不能靠行锁替代此命名锁。

继续使用 runTransaction 的唯一重试机制：每次 attempt 的 acquire 获取专用健康连接并取得命名锁，失败时清理连接；terminal commit/rollback 后在该连接释放命名锁，再释放连接。现 helper 只有 acquire 钩子，可增加异步、保证执行的连接清理生命周期钩子，而不新增 retry engine。清理失败销毁连接；COMMIT 不明仍销毁，不重放。不能提前在 callback finally 中释放命名锁，也不能让 pool 归还仍持有命名锁的连接。明确 commit 成功后若仅 RELEASE_LOCK 失败，业务提交仍成功，销毁连接并报告安全清理事件，不谎称事务回滚。

MySQL 命名锁不随 commit/rollback 自动释放，连接终止才自动释放；命名锁死锁错误不能当 InnoDB 已回滚死锁重试。[MySQL locking functions](https://dev.mysql.com/doc/refman/9.7/en/locking-functions.html)

两个 CLI：首个成功后第二个即使取得锁也因非空拒绝。COMMIT 不明时 CLI 明确报告需只读核查，不自动再执行；已提交后的任何重跑仍拒绝。bootstrap 不是恢复工具；任意本机管理员清空数据库不属于应用能防止的边界。未来任何可创建首个 family/user 的入口必须遵守这一协议。

## 8. Token / URL / QR

invitation token = randomBytes(32) → canonical unpadded base64url 恰 43 字符；严格解码 32 bytes、重编码一致；SHA-256(raw bytes) 恰 32-byte Buffer 写 BINARY(32)，不 hash base64 文本。Session/Invitation 只能查各自表，无跨类型 fallback。

链接固定为配置的可信 HTTPS origin + /join#token=...；origin 必须经过独立配置校验，不能使用请求 Host/forwarded-host 或客户端 returnUrl。原文链接只在 create 明确成功后返回一次，管理列表不可恢复。

后续 Web 页面：最早读取 fragment 到内存并 replaceState 清除，再做网络请求/渲染；不写 localStorage/sessionStorage、监控、错误报告或历史状态。fragment 不发送给 HTTP 服务端，但浏览器扩展/页面脚本/截图/分享仍能读取，持有者可使用邀请。页面及 API 设置 no-store、Referrer-Policy:no-referrer，禁止第三方 analytics/fonts/scripts/QR 服务，QR 本地生成整个链接。建议 CSP 限制同源资源、frame-ancestors 'none'，不使用 service worker 缓存 join/凭据响应。GET /join、扫码和 preview 永不消费；只有显式提交 POST consume 才消费。

## 9. 限速、Audit 与日志

preview/consume 共用每 IP 15 分钟 30 次尝试预算，先计数后 DB/Argon；沿用可信代理策略、HMAC key、有界 10000 桶/TTL/容量拒绝，不能根据 token 有效与否分配无限桶。管理邀请/成员写操作增加 actor+family 有界请求预算（本阶段基线 15 分钟 30 次），成功/失败都计数，防批量签发与锁资源耗尽。所有 API Argon 运算共用现有并发池。单进程内存限速重启重置仍是既有 DEV 限制，上线前持久化/网关方案另行完成。

事件：invitation.create、invitation.revoke、invitation.consume、invitation.auto_revoke、member.role_change、member.disable、member.restore、bootstrap.create；失败同事件名加 resultCode/errorCategory。安全字段白名单：event、server timestamp、requestId/CLI operationId、允许时 actorUserId/actorMemberId、familyId、invitationId/targetMemberId、roleBefore/roleAfter、resultCode/errorCategory。公开无效 token 不记录对应主体、用户名或原始 IP。

不记录 raw token、token hash、PHC/password、Cookie/Authorization/Set-Cookie、request body、邀请链接、SQL/driver Error/parser stack。新增 invitationUrl/link/token 等实际字段路径 redaction，并以真实 Pino 输出验证；现有 password redaction 不代表任意新邀请字段已被覆盖。框架自动请求日志仅记录路由模板或无 query 的路径，防 query 误传 token 被拒绝前已写日志；reverse proxy 同样排除敏感 query/body。

成功事件在明确 commit 后发一次，deadlock 尝试不发成功。COMMIT 不明只记 COMMIT_OUTCOME_UNKNOWN，不声称成功/失败的业务结果。结构化日志与 DB commit 非原子，不能承诺耐久或 exactly-once 审计；原设计已延期专用审计存储，本阶段不为此新增 audit 表。

## 10. Targeted race 与安全测试要求

本次裁决要求新增/更新以下测试：MEMBER 撤销全部拒绝；ADMIN 可撤销本家庭任意签发者的 MEMBER invitation、对 ADMIN invitation（含已撤销）统一 403；SUPER_ADMIN 可撤销两种等级；跨家庭仍为 404。验证先授权再幂等/used 状态处理、撤销 actor 归属不变、角色伪造无效，以及 ADMIN 在等待锁时降权后不得撤销。

SUPER_ADMIN 测试使用一个及两个有效 SUPER_ADMIN fixture，分别尝试自操作与同级停用/恢复/降权；普通 API 全部拒绝，角色/状态不变。两条真实 MySQL 连接并发尝试停用或降权两个 SUPER_ADMIN，结果应全部拒绝、两位均保留，不能把“允许一个成功”写成验收条件。移除 endpoint 不存在时验证不能经其他接口执行删除，不为测试增加删除 API。家庭无有效 SUPER_ADMIN 的损坏状态验证管理写入 fail closed、bootstrap 不充当恢复；未来转移/恢复 race 不纳入本阶段实现。

实现阶段才执行。真实 MySQL 9.7.2、synthetic fixture、两个独立连接、可控 barrier，并证明竞争请求已到达等待位置；不要仅 sleep 猜测顺序。失败清理仅本测试 IDs，不清空 DEV。

| 场景                                                         | 必须证明                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| consume vs consume，同 token 不同 username                   | 恰一个 commit，另一个 INVALID_INVITATION，仅一组 user/member/used-pair                             |
| consume vs revoke，两个方向                                  | 消费先成功则 revoke 冲突；revoke 先则无新用户                                                      |
| consume vs inviter disabled/role downgrade，两个方向         | 变更先则拒绝；消费先合法保留；降权/恢复不复活邀请                                                  |
| 不同邀请并发同 normalized username（同/跨家庭）              | UNIQUE 裁决一组 user/member；失败邀请仍可用；Dad/dad/全角等向量                                    |
| 每步写入失败/duplicate/FK/commit 前故障                      | 无 orphan、无已失败消费标记；不得复用旧账号或覆盖密码                                              |
| session revoke/reauth vs create/revoke/member patch          | 锁内重验旧 hash 与 session，失效方不得写入；两种 commit 顺序                                       |
| 等待锁跨 invitation/session absolute/idle/recent 边界        | 用取得全部锁后的时间正确拒绝                                                                       |
| last SUPER_ADMIN 双停用/降权/移除请求                        | 普通 API 均拒绝，唯一有效管理员仍在；两个管理员 fixture 也不开放修改 SUPER_ADMIN                   |
| two simultaneous bootstrap                                   | 恰一个成功；第二个拒绝；部分非空/停用管理员/非 TTY/root/错库/未迁移/确认不符均拒绝                 |
| bootstrap rollback/retry/commit unknown/锁释放失败           | 命名锁生命周期正确，无泄漏、无不明提交重放，无密码输出                                             |
| cross-family member/invitation ID 与请求 familyId 不一致     | 与不存在资源同一 404，不修改任何目标                                                               |
| ADMIN self-escalation、同级管理、SUPER_ADMIN mass assignment | strict contract/实时授权拒绝，包括嵌套字段、未知字段、role=SUPER_ADMIN                             |
| create/list/preview/consume 与 token transport               | 48h/1h/168h、0/169/非整数拒绝；preview 不消费、不泄露签发人；consume 不 Set-Cookie、不新增 session |
| 无效/expired/revoked/used/失权 token                         | 一致错误；合法邀请下 username 冲突不泄露账号状态                                                   |
| retry/commit loss + Pino/HTTP evidence                       | 最大 3 次、jitter、坏连接销毁、无成功日志/Cookie重放、无 credential/parser 泄露                    |
| Argon 与 IP/resource budget                                  | login+consume 总运行不超过 2；proxy 伪造不绕过桶，队列/桶满 fail closed                            |

完整 allow/deny 权限矩阵逐项 unit tests；成员禁用只影响当前家庭；SUPER_ADMIN 不能 bypass album-policy stub。真实 HTTPS join/fragment 清除/QR 本地生成/无第三方请求留 Web slice 验证，不用 app.inject 宣称浏览器验收。

## 11. P0 风险与实现顺序

P0 阻断：token 可重用；orphan/用户名冲突仍消费；角色或 family mass assignment；签发者失权后邀请复活；跨家庭目标写入；最后 SUPER_ADMIN 被普通 API 操作；锁顺序倒置或旧时间授权；bootstrap 重跑/并发创建两个首管；COMMIT 不明重放；credential 日志泄露；共享 Argon budget 被旁路。出现无法按本文件解决的设计矛盾时输出 R3_DESIGN_REVIEW_REQUIRED。

1. 严格 invitation/member contracts、permission matrix 单测；共享 checked connection/PasswordEngine、错误与日志门禁接入，不改变原有 Auth 行为。
2. bootstrap CLI 与同一 transaction helper 的连接生命周期支持；仅 synthetic 隔离测试，不自动为用户执行正式 bootstrap。
3. invitation create/list/preview/revoke，先验证授权、状态机、token/link 输出与限速。
4. consume transaction 与并发/失败注入测试，验证不签发 session。
5. member list/patch、自动撤销、最后 SUPER_ADMIN 防线与全部角色/跨家庭测试。
6. targeted auth/contracts/permissions/DB/API/logging/typecheck/lint/format；Cursor 只读复核。Web join/QR 后续 Terra slice 和真实 HTTPS 验收独立安排，Phase 1C 结束后停止。

设计采用每次请求服务端授权、默认拒绝与 locking current read，技术语义核对：[OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)、[MySQL locking reads](https://dev.mysql.com/doc/refman/9.7/en/innodb-locking-reads.html)。具体权限、期限、锁协议与恢复规则以本项目已批准设计及本文件为准。

本次仅更新设计文档，未修改业务代码、数据库或 migration，未调用 Bridge，未进入 Phase 2。DESIGN_CHANGE_REQUIRED: YES（仅 ADMIN invitation revoke 权限收紧）；DATABASE_MIGRATION_REQUIRED: NO。上述角色边界已完成本次设计裁决，可作为后续 R3-IMPLEMENT 的唯一基线。
