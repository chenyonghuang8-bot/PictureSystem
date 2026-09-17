# Phase 1 — Identity / Family / Invitation 安全与数据模型设计

状态：设计完成；Phase 1A 已实现并完成数据库验证，Phase 1B 尚未开始。日期：2026-09-14。

## 1. 范围与依据

仅设计 users、families、family_members、invitations、sessions，以及必要的认证协议。没有执行 migration、创建表、修改业务代码或调用 Bridge。不包含 Phase 2 相册权限实现。

当前环境：MySQL 9.7.2 LTS、family_album_dev；innodb_native_foreign_keys = ON、foreign_key_checks = 1。Phase 1A migration 已执行，Native FK runtime probe 正确返回 ERROR 1452，DB targeted tests PASS。此状态更新不改变以下设计约定。

ROUTING DECISION：PLUS_ECONOMY / R3；目标 GPT-6 Astra Low；执行依据为用户在模型确认提示后的“继续”，不宣称工具已验证模型身份；Bridge: no；Test Scope: targeted（设计一致性检查）。

本地依据：根目录 AGENTS.md，project-spec/PROJECT.md 账号/角色要求，ARCHITECTURE.md DB/Auth/Session 章节，ROADMAP.md Phase 1，database/DATABASE_SCHEMA.md，以及 packages/db、auth、contracts、permissions。设计时：DB 为连接工厂及空 schema；auth/permissions 为占位。当前 Phase 1A 已完成五表、Auth primitives 和错误契约；permissions 及 Phase 1B 尚未实现。

## 2. 通用 Schema 约定

下述字段是 Phase 1 推荐完整字段，不是可直接执行的 SQL。所有表使用 InnoDB；文本 utf8mb4；所有时间 DATETIME(3)、UTC。必填时间 created_at 默认 CURRENT_TIMESTAMP(3)，updated_at 默认同上且每次修改更新。其余时间显式赋值，不依赖客户端时钟。表中 NN = NOT NULL，NULL = 可空。id 全部 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY；API 序列化为十进制字符串，禁止转成可能丢精度的 JS number。

所有外键同为 BIGINT UNSIGNED，ON DELETE RESTRICT / ON UPDATE RESTRICT。Phase 1 停用而不物理删除用户/成员，保留用户名与审计归属。未来 avatar/media 外键不提前引入。

### users

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| id | 通用主键 | 全局用户 |
| username | VARCHAR(64) NN | trim 后的展示输入，保留大小写 |
| username_normalized | VARBINARY(512) NN | 规范化字符串的 UTF-8 字节 |
| password_hash | VARCHAR(255) ASCII NN | Argon2id PHC 编码，含版本、参数、salt |
| display_name | VARCHAR(128) NULL | 可选展示名 |
| password_changed_at | DATETIME(3) NN | 首次设置/实际换密时间，不因 rehash 改动 |
| disabled_at | DATETIME(3) NULL | 全局停用；无普通家庭管理 API 可设置 |
| created_at | DATETIME(3) NN / 当前时间 | 创建时间 |
| updated_at | DATETIME(3) NN / 当前时间 | 更新时间 |

UNIQUE uq_users_username_normalized(username_normalized)，完整字节索引，不加 family_id、不用前缀索引。不把用户名当外键；Phase 1 不开放改用户名。

### families

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| id | 通用主键 | 家庭边界 |
| name | VARCHAR(128) NN | 家庭显示名称，非全局唯一 |
| created_at | DATETIME(3) NN / 当前时间 | 创建时间 |
| updated_at | DATETIME(3) NN / 当前时间 | 更新时间 |

不持有 owner_user_id，管理身份来自 family_members，避免重复授权来源。Phase 1 仅本地 bootstrap 创建家庭，不开放创建家庭 API。家庭行也作为成员/邀请管理事务的串行化锁，5 人规模成本可忽略。

### family_members

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| id | 通用主键 | 稳定成员 ID |
| family_id | BIGINT UNSIGNED NN FK families.id | 所属家庭 |
| user_id | BIGINT UNSIGNED NN FK users.id | 所属用户 |
| role | ENUM('SUPER_ADMIN','ADMIN','MEMBER') NN / MEMBER | 家庭范围内角色 |
| joined_at | DATETIME(3) NN / 当前时间 | 首次加入 |
| disabled_at | DATETIME(3) NULL | 家庭范围停用 |
| left_at | DATETIME(3) NULL | 退出时间，Phase 1 不提供退出 API |
| updated_at | DATETIME(3) NN / 当前时间 | 更新时间 |

UNIQUE(family_id,user_id)；UNIQUE(family_id,id) 供复合外键引用；INDEX(user_id)。有效成员要求 disabled_at 和 left_at 均为空且 users.disabled_at 为空。恢复成员沿用原行与原 ID，不新插入。角色不可全局复用到其他家庭。

### invitations

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| id | 通用主键 | 管理用 ID，非凭证 |
| family_id | BIGINT UNSIGNED NN FK families.id | 固定目标家庭 |
| created_by_member_id | BIGINT UNSIGNED NN | 创建者成员 |
| role | ENUM('ADMIN','MEMBER') NN / MEMBER | 邀请授予的固定角色，禁止 SUPER_ADMIN |
| token_hash | BINARY(32) NN | SHA-256 digest |
| expires_at | DATETIME(3) NN | 绝对有效期 |
| used_at | DATETIME(3) NULL | 使用时间 |
| used_by_member_id | BIGINT UNSIGNED NULL | 使用结果成员 |
| revoked_at | DATETIME(3) NULL | 撤销时间 |
| revoked_by_member_id | BIGINT UNSIGNED NULL | 撤销操作者；系统自动撤销时可空 |
| created_at | DATETIME(3) NN / 当前时间 | 签发时间 |

UNIQUE(token_hash)；INDEX(family_id,created_at)；INDEX(expires_at)。创建者、使用者、撤销者均用 (family_id,member_id) → family_members(family_id,id) 复合 FK，并显式建立对应复合索引；使用者/撤销者可空。

CHECK(expires_at > created_at)；CHECK used_at 与 used_by_member_id 同时为空或同时非空；CHECK used_at 与 revoked_at 不能同时非空。有效状态派生，不再另存 status。到期或撤销只能重新签发，不复活旧 token。

### sessions

| 字段 | 类型 / 默认 | 用途 |
| --- | --- | --- |
| id | 通用主键 | 会话管理用 ID，非凭证 |
| user_id | BIGINT UNSIGNED NN FK users.id | 认证主体 |
| token_hash | BINARY(32) NN | SHA-256 digest |
| client_type | ENUM('WEB','ANDROID') NN | 约束传输方式 |
| device_label | VARCHAR(128) NULL | 用户可读标签，非安全判断依据 |
| authenticated_at | DATETIME(3) NN | 最近成功口令验证时间 |
| created_at | DATETIME(3) NN / 当前时间 | 首次签发 |
| last_seen_at | DATETIME(3) NN | 最近有效使用 |
| expires_at | DATETIME(3) NN | 固定绝对到期时间 |
| revoked_at | DATETIME(3) NULL | 一次性失效标记 |
| revoke_reason | ENUM('LOGOUT','USER_REVOKE','LOGOUT_ALL','PASSWORD_CHANGE','USER_DISABLED') NULL | 结构化原因 |

UNIQUE(token_hash)；INDEX(user_id,revoked_at,created_at)；INDEX(expires_at)。CHECK(expires_at > created_at)，CHECK last_seen_at >= created_at，CHECK revoked_at/revoke_reason 同时为空或同时非空。无 role 快照、明文 token、refresh token；默认不持久化完整 UA 或 IP。

## 3. Username normalization 与唯一性

算法版本 username-v1：先拒绝非字符串、非法 Unicode（孤立 surrogate）及原始请求超限；display = input.trim()；normalized = display.normalize('NFKC').toLowerCase()。不使用 locale-sensitive lowercase，不让 SQL LOWER() 承担规范化。display 限 1–64 Unicode code points；normalized 限 1–128 code points 且 UTF-8 ≤512 bytes；扩展后超限必须拒绝，不能截断。

规范化前后均拒绝内部空白、控制字符、格式控制/零宽字符；边界空白已 trim。允许 Unicode 字母、数字、组合标记及常见可见符号，页面严格转义。NFKC 后产生的边界/内部空白也拒绝，确保重复规范化稳定。密码不使用这套算法。

Dad / dad / 全角 Ｄａｄ 合并；é 与 e 不合并；组合/预组字符经 NFKC 合并。不是完整 Unicode case folding：ß 与 ss、不同希腊 sigma 可能不同；跨文字系统同形字不自动合并。界面同时显示 username 与 display_name，避免仅凭昵称识别管理员。

把 UTF-8 Buffer 写入 VARBINARY(512)，查询同样绑定 Buffer。这样数据库不额外套用 accent-insensitive collation，将 e 与 é 错误合并。应用预查仅用于体验，数据库 UNIQUE 才是并发裁决；duplicate-key 转稳定业务错误。固定 Node/Unicode 运行时版本并保存规范化测试向量；更换规则前离线检测碰撞，不静默重算。

## 4. 密码与 Auth flow

密码为 8–256 Unicode code points，UTF-8 ≤1024 bytes；拒绝非法 Unicode，不 trim、不 NFKC、不截断，保留空格与大小写。不加字符组合限制。建议用户使用长口令；8 位是用户确认的最低产品规则，不代表对所有威胁都足够强。

Argon2id v=19，推荐起点 memoryCost=65536 KiB（64 MiB）、timeCost=3、parallelism=1、salt=16 随机 bytes、hashLength=32 bytes。保存 PHC 全串，用库 verify/needsRehash，不手写密码比较。该起点高于 OWASP 最低 19 MiB/t=2/p=1；须在 M4 与实际库上测量延迟/并发内存后定稿，目标单次约 200–500ms，不宣称已跑 benchmark。[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

流程：请求大小/类型校验 → 限速 → username-v1 → 按唯一键查询 → Argon2 verify → 事务内锁用户并重新检查停用、password_hash 是否仍为刚验证的值 → 写 session → 提交成功后返回凭证。未知账号执行固定的等成本 dummy hash 校验；停用账号和错误密码给相同 401。hash 校验在事务外完成，避免长时间持锁。并发换密导致 hash 改变则拒绝本次签发，要求重试登录。没有有效家庭成员时也拒绝签发，响应不泄露原因。

成功登录生成全新 token，不复用客户端携带的 session，防 session fixation。合适时 rehash，条件更新防覆盖并发换密。没有公开注册、username availability、密码找回或管理员代登录端点。

## 5. Session flow

使用 Node crypto.randomBytes(32)：256-bit CSPRNG。客户端为无 padding 的 base64url，严格 43 字符；解析后必须恰为 32 bytes，重编码结果必须一致，拒绝非规范编码。hash=SHA-256(raw bytes)，DB 存 32-byte Buffer，不存 64 字符 hex。session 与 invitation 独立随机生成，分别查表，不能互换；随机 token 不需要 Argon2 或额外盐。

建议绝对有效期 30 天、空闲有效期 7 天，二者都由服务器验证；这是家庭使用场景的产品取舍，可配置。expires_at 不滑动延长；空闲用 last_seen_at，最多每 5 分钟条件写一次，可能比精确空闲期限最多早失效约 5 分钟。updated last_seen 不得清除 revoked_at，不得延长 expires_at。过期条件为 now >= deadline。

每个受保护请求查 session 和 users；要求 hash 存在、revoked_at 空、绝对/空闲均未到期、用户未停用。每个家庭请求额外查实时 family_members。不缓存授权结果；DB 不可用返回 503 并拒绝访问。撤销无需 JWT denylist 或缓存失效机制。

Web Cookie：__Host-family_session，Secure、HttpOnly、SameSite=Lax、Path=/、无 Domain；Max-Age ≤绝对剩余有效期。Web 登录/注册响应正文不带 token。浏览器请求走同源 API；所有写操作（包括 login/consume）检查可信 Origin，JSON Content-Type；允许来源使用精确 allowlist，拒绝 null/不可信 Origin，拒绝带凭证的跨站 CORS。SameSite 不是唯一 CSRF 防线。将来 Bearer 通道不依赖 Cookie；同时携带两种凭证直接拒绝，WEB token 不接受 Bearer，ANDROID token 不接受 Cookie。生产只经 HTTPS；DEV 用本地 HTTPS 完整验证安全 Cookie，不悄悄关闭 Secure。

Android 后续使用安全存储，Authorization: Bearer；禁止 AsyncStorage、URL、日志存 token。Phase 1 可先只开放 WEB 签发，ANDROID 值为预留；开放 Android 通道必须补传输与 CSRF 边界测试。

单 session revoke：按 session.id + user_id 条件更新 revoked_at/reason，重复调用幂等；logout 总是清理 Cookie，但数据库撤销失败返回服务不可用，不能宣称跨设备已失效。revoke-all 和换密：锁 users 行，再更新全部 sessions；登录插入也锁同一 users 行，定义提交先后顺序，防漏掉并发签发。换密校验当前密码、换 hash、撤销所有旧 session、创建替代 session 在同一事务内完成；网络响应丢失时重新登录。

撤销提交后新认证检查必拒绝；不能追回已经授权并返回的数据。邀请/角色/成员停用等关键写操作在其事务中重新锁 session、检查权限，和撤销操作确定顺序。常规读不承诺撤销能中止所有在途响应。

高权限动作需要 authenticated_at 在 15 分钟内，否则要求重新认证。reauth 验证密码后轮换 session token，并保持原 created_at/expires_at，更新 authenticated_at；并发 reauth 仅一次成功。服务端 token 永远不进入日志。[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

## 6. Invitation flow

token 同样 randomBytes(32)、base64url 43 字符、SHA-256(raw bytes) → BINARY(32)。默认有效期 48 小时；签发时可选 1–168 小时，签发后不修改。服务器从经过授权的路由家庭和签发者决定 family_id/role；消费请求不接受客户端 role/family_id。

创建事务检查有效签发者及 recent auth，插入 hash 后只在成功创建的响应返回一次原文链接；列表不回显 hash 或链接，不可从 DB 恢复 token。二维码客户端本地生成，内容与链接相同，不向二维码服务发送。链接形如 https://受信站点/join#token=…：fragment 不进入 HTTP URL；页面读入内存后 replaceState 清除地址中的 token，不写本地持久存储。页面禁第三方资源/分析，Referrer-Policy: no-referrer；发送 JSON POST 时请求 body 必须从日志中排除，响应 Cache-Control: no-store。

preview 是 POST，返回最少家庭名称/目标角色/到期时间，不消费 token；失效情况统一 INVALID_INVITATION，不暴露签发者信息。GET 链接、扫码、邮件/聊天预取均不消费。

consume 必须 transaction：

1. 校验请求、限速、预查 token；在锁外完成 Argon2 hash。预查不能替代事务内检查。
2. 锁目标 families 行；按固定顺序锁签发者 users/family_members，再锁 invitation 行 FOR UPDATE，重新检查 hash、未使用、未撤销、未到期、签发者仍具备授予该 role 的权限。
3. 插入 users（UNIQUE 并发裁决）、family_members，条件更新 invitation used_at/used_by_member_id；受影响行必须恰为 1。
4. 提交后返回创建成功，用户再登录。为降低 token 响应丢失复杂性，消费不自动签发 session。

任一步失败全部回滚，不能留下孤儿用户/成员或消耗掉失败注册的邀请。两次并发消费仅一次成功；重复用户名的失败不消耗邀请；成功但响应丢失则重试提示邀请不可用，用户用刚设密码登录。数据库状态不明确时不盲目重试写入。

revoke 与 consume 都先锁同一家庭行并锁 invitation；谁先提交决定结果。使用过的邀请不能转撤销，返回稳定冲突；已撤销幂等成功。签发者降权/停用时同一家庭事务批量撤销其未使用邀请，消费时仍复核权限作第二道保证。[MySQL locking reads](https://dev.mysql.com/doc/refman/9.7/en/innodb-locking-reads.html)

Phase 1 邀请只用于创建新全局账号。已存在 username 不凭邀请复用旧账号、不覆盖密码；现有账号加入第二家庭的认证后接受流程推迟，不以注册错误处理偷偷实现。

## 7. Role boundary 与 bootstrap

| 操作（仅所属家庭） | MEMBER | ADMIN | SUPER_ADMIN |
| --- | --- | --- | --- |
| 查看自己的身份/家庭、管理本人 session | 是 | 是 | 是 |
| 发 MEMBER 邀请、列出/撤销家庭邀请 | 否 | 是 | 是 |
| 发 ADMIN 邀请 | 否 | 否 | 是 |
| 停用/恢复普通 MEMBER | 否 | 是 | 是 |
| 修改 MEMBER/ADMIN 角色、停用 ADMIN | 否 | 否 | 是 |
| 通过 API 创建/晋升/停用 SUPER_ADMIN | 否 | 否 | 否 |
| 更改他人密码、撤销其他家庭成员 session | 否 | 否 | 否 |

SUPER_ADMIN 也是家庭内角色，不是全局绕过开关，不绕过将来的相册权限。ADMIN 不可管理同级 ADMIN、自身升级或 SUPER_ADMIN；所有授权在服务器，拒绝未知字段、防 mass assignment。停用成员只影响该家庭，不能误改全局 users.disabled_at。普通跨家庭访问统一 404，不泄露资源存在。

bootstrap 仅本机交互式 CLI，无 HTTP route、无“第一个访问者成为管理员”、无默认口令。仅在明确 DEV 数据库、非 root 的专用账号、已完成 migration 且 users/families/family_members 全为空时允许；初始化 family 和唯一 SUPER_ADMIN 在一个事务内完成。锁使用同一专用连接持有命名锁（数据库范围固定名称、超时失败即退出），确保并发 bootstrap 串行；所有未来 bootstrap 入口必须使用该锁。再次执行即使管理员被停用也拒绝，不把恢复当初始化。

CLI 口令以无回显 TTY 输入并二次确认，不用 argv、日志或 shell history；与普通注册共用规范化和 Argon2 参数。初始化凭据仍来自本地 secret 配置，不使用 MySQL root。生产 bootstrap 需独立授权，现设计不提供生产执行命令。

SUPER_ADMIN 转移/恢复不做 Phase 1 API，未来单独审查本机维护流程；不能通过邀请获得该角色。最后有效 SUPER_ADMIN 不可经任何应用写路径被停用、降权或移除，相关事务须锁家庭行验证。拥有本机 OS/数据库写权限者处于可信运维边界，应用不能防止其直接篡改数据库。

## 8. 限速、防枚举及其他风险

单 API 进程起步：有界内存桶，登录同时检查规范化 username（存在与否一样）、来源 IP、username+IP；建议每 username 15 分钟最多 10 次失败、每 IP 15 分钟 50 次尝试、每组合 15 分钟 5 次失败；每 IP 1 分钟最多 10 次突发。到阈值 429 + Retry-After，窗口自然恢复，不永久锁账号。成功仅清组合失败桶，不清 IP 总量。预留并发尝试名额，避免并行请求穿过阈值；Argon2 全局并发最多 2，等待队列最多 10，超出返回可重试状态。

preview/consume 单 IP 每 15 分钟 30 次，共用注册 Argon2 并发预算；reauth 走与登录相同口令失败预算，防旁路。桶 key 使用进程随机密钥 HMAC 后的 username/IP，不在日志写原值；最多 10000 桶、TTL 与定时清理，达到容量拒绝分配新桶，不淘汰正在限速的键。仅信任配置的反代地址，直连忽略伪造 X-Forwarded-For。

限制：内存桶重启清空、多进程不共享；Phase 1 固定单实例，可接受有限 DEV 验证；上线或多实例前必须落实持久限速（MySQL 专用表及独立 migration 或已配置网关策略），不能声称当前五表即可提供重启持久限速。不引入 Redis。账号级阈值可能被用于短时拒绝服务，应监控并可调，不能靠永久账号锁解决。

登录不存在/错密/停用统一 401 及文案；保持等成本 hash 路径，但不承诺严格恒定网络耗时。注册用户名冲突只在有效邀请之后返回“账号不可用”，不区分停用/存在；不提供公开查重接口。有效邀请持有人仍可试探用户名，这是显式残余风险，以限速约束。[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

认证失败/登录/撤销/邀请创建与消费/成员变更输出结构化安全事件：事件名、时间、请求 ID、非敏感主体 ID、结果码；禁止 body、Cookie、Authorization、原文 token、hash、密码及带 token URL。耐久审计存储后续独立设计，当前不假装已有 audit_logs 实现。

## 9. MySQL 9.7.2 LTS 兼容性与 Migration 安全

设计使用常规 InnoDB、BIGINT UNSIGNED、DATETIME(3)、ENUM、BINARY/VARBINARY、CHECK、UNIQUE/FK；当前 MySQL 9.7.2 LTS 已完成 Phase 1A 验证，要求 innodb_native_foreign_keys = ON、foreign_key_checks = 1。username 唯一索引最多 512 bytes，hash 唯一索引 32 bytes，均避免大文本索引与前缀截断；后续 migration 仍须验证实际实例兼容性。

VARBINARY 比较精确字节且不补零；BINARY(32) 会补零，因此应用必须先验证 SHA-256 输出恰 32 bytes，不能依赖数据库拒绝短 digest。Drizzle 如缺合适内置类型，需小范围 customType 映射 Buffer 并测试字节往返，不用字符串 collation 模拟。[MySQL binary types](https://dev.mysql.com/doc/refman/9.7/en/binary-varbinary.html)

mysql2 使用参数绑定、禁 multipleStatements，BIGINT 以字符串/BigInt 映射；连接级 UTC 与严格 SQL mode 验证，禁止 silently truncate。Phase 1A 已通过真实连接、二进制往返、BIGINT 与 CHECK/FK 验证；后续变更仍须测试。

所有关键写事务固定顺序：家庭行（如适用）→ 已存在 users 按 ID 排序 → sessions 按 ID → family_members 按 ID → invitations。单 session revoke 不再反向请求用户/家庭锁；全局停用必须先锁用户、撤销 session，不在该事务追加家庭锁。事务内再检查到期、session 与角色；死锁只对明确已回滚的事务做至多 2 次带抖动重试，提交结果不明不得自动重放。

实现时先生成 Drizzle schema + versioned SQL + migration tests，经 review 再按用户授权执行。创建顺序 users → families → family_members → invitations/sessions；不执行历史完整 schema.sql，避免提前创建 Phase 2+ 表。运行前确认 DATABASE() 为 family_album_dev、CURRENT_USER() 非 root、权限仅目标库；应用账号仅必要 DML，DDL 使用单独受限 migrator，不提升 API 运行账号。无 DATABASE_URL 时 fail closed，移除当前 Drizzle 默认 URL 回退是待实现项。

先 dry-run/审阅 SQL，检查是否已有同名表/历史 migration，存在不符结构则停止对比，不用 IF NOT EXISTS 掩盖漂移。保存迁移前 DEV 备份与 schema 清单；用隔离临时测试 schema 验证并发、约束与驱动，不能拿 production 或清空 DEV 做测试。

MySQL DDL 可隐式提交；单条 atomic DDL 不代表整个 migration 文件可 ROLLBACK。部分失败记录实际已完成步骤，使用 forward-fix；不删库重建、不自动 DROP 新表（可能已有数据）。重复运行应由 migration journal 判定，不盲重放成功 DDL。[MySQL implicit commit](https://dev.mysql.com/doc/refman/9.7/en/implicit-commit.html)

## 10. API 契约清单

所有前缀 /api/v1；统一错误结构 {code,message,requestId}，无内部 SQL/堆栈。响应 Cache-Control: no-store。

| 方法 / 路径 | 权限与行为 |
| --- | --- |
| POST /auth/login | username/password；限速，Web Cookie |
| GET /auth/me | 有效 session；本人信息及有效家庭成员身份 |
| POST /auth/logout | 当前 session 幂等撤销与清 Cookie |
| POST /auth/logout-all | recent auth，撤销本人全部 session |
| POST /auth/reauth | 验证本人密码并轮换 token |
| POST /auth/password | 当前密码+新密码，原子换密并撤销旧会话 |
| GET /auth/sessions | 本人设备标签、时间、ID，无 hash/token |
| DELETE /auth/sessions/:sessionId | 本人；不可按任意 ID 撤销他人；幂等 |
| GET /families/:familyId/members | 有效本家庭成员；最小身份字段 |
| PATCH /families/:familyId/members/:memberId | recent auth，按矩阵仅 role/disabled；严格字段白名单 |
| POST /families/:familyId/invitations | ADMIN+，recent auth，授予级别检查；一次返回链接 |
| GET /families/:familyId/invitations | ADMIN+；派生状态，无 token/hash |
| POST /families/:familyId/invitations/:invitationId/revoke | ADMIN+，recent auth，幂等撤销 |
| POST /invitations/preview | token JSON，仅元数据，不消费 |
| POST /invitations/consume | token/username/password/displayName；事务创建账号和成员 |

所有 route ID 只用于定位，不能当授权证据。邀请 role 默认 MEMBER，显式只允许 MEMBER/ADMIN；consume 拒绝 role 字段。没有 /register 或公网 /bootstrap。

## 11. 必须覆盖的测试

- Normalization：Dad/dad/全角、组合字符、é/e、ß/ss、首尾/内部空白、零宽/控制字符、孤立 surrogate、NFKC 长度扩展、字节边界、幂等；并发相同规范化用户名仅一条成功。
- Password：7/8/256/257 code points、空格不 trim、UTF-8 上限；PHC 参数、随机 salt、不出现明文；unknown-user dummy verify；rehash 不覆盖并发换密；压力下并发/队列受限。
- Token：32-byte RNG、43 字符 canonical 编码、畸形/短长 token 拒绝；hash 32-byte 往返；跨类型 token 不通用；JSON/日志/URL/cache 无泄露。
- Session：正确/错误/不存在/停用登录；绝对及空闲边界；撤销幂等、立即再请求失败、revoke-all 对并发 login 的顺序、换密与登录竞态、在途请求边界；session 列表/删除不能越权；DB 不可用 fail closed；WEB/Bearer 混用拒绝。
- Cookie/CSRF：真实浏览器本地 HTTPS 验证 Secure/HttpOnly/SameSite/Path/no Domain；不可信 Origin 的 login/consume/写请求失败；GET 无副作用；过期 Cookie 清除；HTTP smoke 不能替代这组测试。
- Invitation：有效创建/过期/撤销/使用、GET/preview 不消费、并发 consume 恰一成功；username 冲突及任意写失败全回滚；revoke/consume 竞态；签发者降权/停用后旧邀请失效；请求篡改 role/family 无效；提交后网络中断可正常登录。
- Role：三角色允许/拒绝矩阵、跨家庭同 ID、管理员管理同级/自升/伪造 SUPER_ADMIN 拒绝、成员停用即时失权、不能停用最后 SUPER_ADMIN、恢复不改变其他家庭身份。
- Bootstrap：空库一次成功，重复/并发调用仅一次成功；非空/部分初始化/管理员停用均拒绝；错误数据库、root、非 TTY、密码不匹配失败；无网络 bootstrap route，无默认口令。
- 限速：未知与已知用户名一致、各种规范化拼写共享桶、代理头伪造、并发预留、到期恢复、容量上限、重启限制被记录、reauth 不可绕过。
- Migration：MySQL 9.7.2 实例中完整唯一索引/二进制 round-trip/CHECK/FK/同家庭复合约束、BIGINT 超 JS 安全整数、UTC 精度、重复执行 journal、部分 DDL 失败 forward-fix 演练；不得写 production。

## 12. Phase 1 实现顺序与停止点

1. 先实现 username/token/error 契约与测试向量；确定 Argon2 库并在 M4 benchmark，形成参数证据。
2. 编写五表 Drizzle schema、migration SQL 和约束测试；修正 DEV 配置失败关闭；经 review 后在获授权环境执行 migration。
3. 本地一次性 bootstrap，验证并发与非空拒绝；创建测试家庭和合成账号。
4. 登录/session middleware、Cookie/CSRF、限速、session 管理与换密，完成并发撤销测试。
5. 家庭角色检查与管理边界、邀请签发/preview/事务消费/revoke；网页邀请入口与本地 QR。
6. Phase 1 全量 lint/typecheck/unit/integration/build/e2e 验收，形成 summary 后停止；不进入 Phase 2。

当前结论：设计可作为实现基线。Phase 1A 已完成 MySQL 9.7.2 Native FK、DDL/驱动往返验证及 Argon2 benchmark。参数定稿为 Argon2id v=19、memoryCost=65536 KiB、timeCost=6、parallelism=1、saltLength=16 bytes、hashLength=32 bytes；依据 M4 的 t=3 ≈100.3ms、t=6 ≈200.9ms。第 4 节保留设计时的起点记录，实际实现使用此处定稿参数。浏览器 HTTPS/Cookie、事务竞态和限速负载属于尚未实现的后续工作。
