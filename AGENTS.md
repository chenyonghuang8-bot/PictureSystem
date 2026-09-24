# AGENTS.md — PictureSystem / Family Album

本文件是 Codex 在本项目中的最高开发约束之一。

项目：家庭相册系统  
仓库目录：`PictureSystem`

---

## 1. 项目文档位置

项目方案统一保存在 `project-spec/`：

- 产品需求：`project-spec/PROJECT.md`
- 技术架构：`project-spec/ARCHITECTURE.md`
- 开发路线：`project-spec/ROADMAP.md`
- 模型策略：`project-spec/MODEL_ROUTING.md`
- 上下文/额度策略：`project-spec/CONTEXT_BUDGET.md`
- UI 规范：`project-spec/UI_REFERENCE.md`
- 数据库设计：`project-spec/database/DATABASE_SCHEMA.md`
- App UI 参考图：`project-spec/ui/app-preview.png`
- Web UI 参考图：`project-spec/ui/web-preview.png`

实际数据库 Schema / Migration 工程文件保存在 `database/`、`packages/db/`。
阶段开发总结统一放在 `docs/progress/`。

---

## 2. Cursor 与 Codex 分工

Cursor 主要负责：

- 只读代码检查
- 配置/目录/依赖检查
- Code Review
- 安全问题初筛
- 生成检查报告

Codex 主要负责：

- 编写和修改代码
- Migration
- 测试
- 架构实现
- 修复已确认问题

除非用户明确要求，否则不要让 Codex 重复完成 Cursor 已做完的全仓检查。
优先读取 Cursor 报告和 `docs/progress/` 阶段总结。

---

## 3. 模型策略：减少切换，Sol 常驻

当前用户为 Pro。

默认 Profile：

`PRO_STABLE`

### 默认主力

除非命中特殊情况，默认长期使用：

`GPT-5.6 Sol / Medium`

适用于：

- 普通功能开发
- CRUD / 常规 API
- 核心业务实现
- 跨模块逻辑
- 测试与 Bug 修复
- 已由 Astra 批准安全方案后的高风险实现
- Phase 收尾和 Quality Gate 修复

目标：减少频繁切换造成的上下文漂移和实现风格变化。

### Spark：只在明确小任务使用

可选：

`GPT-5.3-Codex-Spark`

只用于非常明确、低风险、范围很小的任务：

- CSS / spacing / 文案
- 单个组件微调
- 明确重命名
- 小范围类型错误
- 单文件 targeted edit
- 已知修法的简单配置问题
- 小型测试补充

不要为了一个小任务强制切 Spark；当前已在 Sol 时可以继续完成。

Spark 禁止用于：

- Auth / Session / Permission
- Migration
- Upload atomicity
- Storage
- Backup / Restore
- 数据一致性
- 复杂并发
- 大型重构
- 安全终审

### Astra：只用于高风险设计与复核

使用：

`GPT-6 Astra / Low`

仅用于：

- Authentication / Session 安全设计
- Authorization / Permission 设计
- Transaction / Locking 策略设计
- 高风险 Migration 设计
- Storage / Backup / Restore 设计
- 数据一致性设计
- 高风险问题诊断
- P0/P1 安全问题方案确认
- Phase / Release 最终安全复核

Astra 不负责长时间机械实现。
Astra 完成方案后，实际实现回到 `GPT-5.6 Sol / Medium`。

### Terra

`GPT-5.6 Terra` 不作为必须切换的默认档位。
若用户明确要省额度，可用于低风险批量 UI / CRUD；否则继续 Sol Medium。

### Bridge

后续本项目不再使用 `codex-bridge-chatgpt`。

禁止：

- 自动调用 Bridge
- 输出 `BRIDGE_REQUIRED`
- 触发 Browser handoff
- 依赖 Bridge 完成安全审查

如果用户以后想用 ChatGPT 网页端做额外独立复核，由用户手动执行，不属于 Codex 自动工作流。

---

## 4. ROUTING DECISION

重要任务开始修改代码前，输出简洁：

```text
ROUTING DECISION
Profile: PRO_STABLE
Risk: NORMAL / R3-DESIGN / R3-IMPLEMENT
Current Model: <无法可靠确认则写 unknown>
Recommended Model: ...
Test Scope: targeted / milestone-full
Action: continue / pause-for-model-switch
Reason: ...
```

不要为了普通任务频繁建议切模型。

默认：

```text
Risk: NORMAL
Recommended Model: GPT-5.6 Sol Medium
Action: continue
```

---

## 5. R3 高风险任务规则

R3 包括但不限于：

- Authentication
- Password hashing
- Session
- Authorization
- Album permissions
- 越权风险
- destructive migration
- Upload atomic finalize
- 媒体引用一致性
- 永久删除 / Trash purge
- Backup / Restore
- Storage migration
- Production deployment security
- Secrets
- 数据损坏
- 复杂事务竞态

### 5.1 R3-DESIGN

新的高风险设计、安全方案、事务/锁策略或最终安全复核：

必须使用 `GPT-6 Astra / Low`。

如果当前不是 Astra Low：

```text
MODEL_SWITCH_REQUIRED
Target: GPT-6 Astra
Reasoning: Low
Reason: R3 security design/review required
```

然后等待用户切换。

### 5.2 R3-IMPLEMENT

若同时满足：

1. Astra 已完成设计或安全复核；
2. Astra 已给出明确 guardrails / patch plan；
3. 当前实现只是在落实已批准方案；
4. 不需要重新设计 schema、权限边界、transaction/locking 或安全模型；

则使用：

`GPT-5.6 Sol / Medium`

此时：

```text
Risk: R3-IMPLEMENT
Recommended Model: GPT-5.6 Sol Medium
Action: continue
```

若实现时发现必须改变已批准的：

- transaction / locking strategy
- permission boundary
- auth/session model
- database schema
- security invariant

立即停止：

```text
R3_DESIGN_REVIEW_REQUIRED
Target: GPT-6 Astra Low
Reason: ...
```

不得由 Sol 自行改变安全设计。

---

## 6. 安全审查工作流

高风险功能推荐流程：

```text
Astra Low
→ 安全设计 / Guardrails
→ Sol Medium
→ 实现
→ targeted tests
→ Cursor
→ 只读 Review
→ 必要时 Astra Low
→ blocker re-review
→ Full Quality Gate
```

不再使用 Bridge。

P0/P1 必须处理。
P2/P3 若明确不阻塞当前 Phase，可记录后继续。

---

## 7. 原始媒体最高原则

> Original media is immutable.

原始照片和视频一旦持久化，禁止：

- 覆盖
- 就地旋转
- 压缩覆盖
- 修改 EXIF
- 转码后覆盖原文件
- 因生成缩略图而修改 original

thumbnail / preview / video poster / transcode / AI embedding / metadata cache 都属于 Derived Asset。

Derived 可以删除并重建；Original 不可以。

---

## 8. Production 媒体隐私

Codex 默认不得：

- 读取真实家庭照片/视频
- 将 Production media 作为测试 fixture
- 把真实照片发送给 AI 或第三方网站
- 把 Production media 复制到 DEV

DEV 只能使用 synthetic fixture、测试图片或公开授权测试文件。

---

## 9. DEV / PROD 隔离

DEV 和 PROD 必须独立：

- Database
- Credentials
- Media path
- Upload temp
- Backup
- Config
- Ports / services（适用时）

禁止共用原始媒体目录。
Codex 默认只操作 DEV。
任何 Production 操作必须由用户明确批准。

---

## 10. 当前 MySQL 环境

数据库基线：

`MySQL Community Server 9.7.2 LTS`

平台：

`macOS / Apple Silicon arm64`

路径：

```text
/usr/local/mysql/bin/mysql
/usr/local/mysql/bin/mysqld
```

当前 DEV 数据库：

`family_album_dev`

已确认：

- DATABASE_URL 已配置
- 应用数据库用户非 root
- `innodb_native_foreign_keys = ON`
- `foreign_key_checks = 1`
- Phase 1A migration 已执行
- FK runtime probe 已正确返回 ERROR 1452
- CHECK constraints 已验证
- BINARY / VARBINARY round-trip PASS
- BIGINT exact string handling PASS

未经用户批准不要升级/降级 MySQL、安装另一套 MySQL、修改全局配置或 root 密码。

---

## 11. 数据库规则

数据库技术：

- MySQL
- Drizzle ORM
- mysql2

Schema 修改必须通过：

- Drizzle schema
- versioned migration
- migration review

禁止：

- 直接删库重建 Production
- 手工改 PROD schema 后不创建 migration
- 使用 root 作为应用账号
- 用 `database/schema.sql` 代替 migration 历史

Codex 当前只允许操作 `family_album_dev`。

---

## 12. 用户账号规则

登录：账号 + 密码。

username：

- 全系统唯一
- trim
- Unicode NFKC normalize
- lowercase normalized value 用于唯一性判断

`Dad` 与 `dad` 视为同一账号。

密码：

- 最少 8 位
- 不强制大小写/数字/特殊字符
- 使用 Argon2id
- 禁止明文保存

当前 Argon2id 参数：

```text
memoryCost = 65536 KiB
timeCost = 6
parallelism = 1
hashLength = 32 bytes
Argon2id v=19
```

---

## 13. Permission 必须服务端执行

所有查看、下载、上传、编辑、删除、成员管理、管理后台、Invitation、Role change 必须在 API 服务端授权。

客户端隐藏按钮不是安全措施。

---

## 14. Session / Auth 安全原则

必须保持：

- 256-bit opaque token
- DB 只保存 SHA-256 token hash
- Web Cookie：`__Host-family_session`
- Secure / HttpOnly / SameSite=Lax / Path=/
- no Domain
- Origin exact allowlist
- JSON Content-Type guard
- Cookie / Bearer 混用拒绝
- absolute expiry
- idle timeout
- recent-auth
- logout / logout-all
- reauth token rotation
- password change session revoke
- server-time-after-lock
- bounded deadlock retry
- rollback failure connection discard
- COMMIT outcome unknown 不 replay

修改这些不变量前必须进入 R3-DESIGN。

---

## 15. Invitation / Role 安全原则

最终 Phase 1 权限边界：

### MEMBER

- 不能邀请
- 不能管理成员

### ADMIN

- 可以邀请 MEMBER
- 可以撤销 MEMBER invitation
- 可以 disable / restore MEMBER
- 不能管理 ADMIN
- 不能操作 SUPER_ADMIN

### SUPER_ADMIN

- 可以管理 MEMBER / ADMIN
- 可以创建 MEMBER / ADMIN invitation
- 可以撤销 MEMBER / ADMIN invitation

普通 API 永远禁止：

- 创建 SUPER_ADMIN
- 晋升到 SUPER_ADMIN
- disable SUPER_ADMIN
- restore SUPER_ADMIN
- downgrade SUPER_ADMIN
- remove SUPER_ADMIN

SUPER_ADMIN transfer/recovery 以后通过独立审查的本机维护流程实现。

---

## 16. 媒体写入必须原子化

上传最终成功至少要求：

1. 文件完整上传
2. staging 完成
3. hash 计算完成
4. original 安全持久化
5. DB transaction 成功
6. metadata/reference 创建完成

禁止数据库报告成功但原始媒体尚未可靠落盘。

---

## 17. 去重

V1 使用 SHA-256 完全文件去重。

只在同一个 family 内进行。
禁止跨家庭 dedupe。

---

## 18. 删除规则

普通删除进入 Trash，默认保留 30 天。

永久删除必须：

- 权限检查
- 引用检查
- Audit log
- 确认没有其他媒体引用 Storage Object

不得因为删除相册关系而误删原始媒体。

---

## 19. 不过度设计

当前规模约 5 人、初期约 1 万张照片。

未经明确必要性，不增加：

- Kubernetes
- Kafka
- Elasticsearch
- MinIO
- Redis
- 微服务
- 复杂分布式架构

新增基础服务前必须解释问题、必要性和长期维护成本。

---

## 20. 测试策略

开发过程默认 targeted tests。

示例：

```text
改 auth → auth unit + auth integration
改 gallery → gallery tests + web typecheck
改 upload → upload + storage tests
```

不要每个小改都跑完整 Quality Gate。

以下情况才跑完整：

- Phase / Milestone 完成
- Release Candidate
- 用户明确要求

完整 Quality Gate：

```text
format
lint
typecheck
unit/API
integration
MySQL race tests
build
e2e
```

真实 MySQL integration/race tests 不允许因 `.env` 未加载而 silently skip。

---

## 21. 上下文与连续性

默认优先保持同一个 Sol Medium 开发线程，减少无意义模型切换。

不要每轮重新全文读取 PROJECT / ARCHITECTURE / ROADMAP / DATABASE_SCHEMA / UI_REFERENCE。

优先读取：

1. `AGENTS.md`
2. 当前 Phase summary
3. 当前安全/Guardrails 文档
4. 相关 package
5. 相关 diff / changed files
6. Cursor 检查报告

每个 Phase 完成后创建 `docs/progress/PHASE-XX-SUMMARY.md`。

---

## 22. UI 规则

App 权威视觉参考：

`project-spec/ui/app-preview.png`

Web 权威视觉参考：

`project-spec/ui/web-preview.png`

整体风格：

- 现代极简
- 温暖
- 照片优先
- 暖白背景
- 绿色 Accent
- 圆角
- 轻阴影
- 大量留白

不要改成 Material Dashboard、蓝灰企业后台或强 BI 风格。

App 主要导航：

```text
照片
相册
回忆
我的
```

Web：左侧导航 + 中央照片区域 + 右侧辅助信息。

---

## 23. Android 优先

V1 原生移动端优先 Android。

iPad 暂不作为原生 V1 交付目标。

---

## 24. Git 当前策略

当前用户暂时不处理 Git。

不要自动执行：

- git init
- git add
- git commit
- git push
- 创建 remote
- 删除嵌套 `.git`

除非用户明确要求。

---

## 25. 系统软件规则

未经用户明确批准，不要：

- 升级 macOS
- 升级/降级 MySQL
- 安装另一套 MySQL
- 修改 MySQL 全局配置
- 自动安装 Docker
- 修改路由器
- 开公网端口
- 自动购买域名
- 修改系统级服务

---

## 26. Secrets

Secrets 放 `.env` 或以后确定的 Secret Store。

禁止提交或输出：

- password
- DATABASE_URL
- token
- secret
- private key
- Cookie
- Authorization

`.env.example` 只能包含变量名和示例值，不得包含真实 secret。

---

## 27. 日志

禁止日志输出：

- password
- currentPassword
- newPassword
- raw session token
- invitation token
- token hash
- Cookie
- Authorization
- database password
- raw driver/parser credential error
- private media contents
- 不必要的私人 EXIF/GPS

Auth/Security 日志必须使用字段白名单。

---

## 28. 工作方式

每个开发任务：

1. 读取最少必要上下文
2. 输出简短 ROUTING DECISION
3. 给出最多 3～6 条计划
4. 实现最小完整 slice
5. 跑 targeted tests
6. 简洁汇报结果
7. 高风险新设计才切 Astra
8. 已批准高风险方案继续用 Sol
9. 不擅自进入下一 Phase

完成一个 Phase 后停止等待用户批准。

---

## 29. 不允许擅自进行的操作

未经用户明确允许，不要：

- 进入 Production
- 导入真实家庭照片
- 删除 Production 数据
- 修改 MySQL root 密码
- 升级数据库
- 创建公网入口
- 自动上传备份到 iCloud
- 使用真实照片做测试
- 自动进入下一 Phase
- 自动初始化 Git
- 自动调用任何 Bridge / Browser handoff

---

## 30. 当前项目状态

```text
Phase 1: COMPLETE
Phase 2: COMPLETE
Phase 3: COMPLETE
Phase 4: IMPLEMENTATION COMPLETE THROUGH API SERVING
READY_FOR_PHASE_4: YES
PHASE_4_PRODUCTION_READY: NO
PHASE_4_READY_FOR_COMPLETION: NO
```

Phase 3 Final Quality Gate：Format、Lint、Typecheck、Unit/API、DEV MySQL integration/race、native storage、fault-injection/crash、Build、E2E 均 PASS；Phase 3 测试 skip = 0。Phase 3 安全审查原三个 P1 均 CLOSED，新 P0/P1 = 0。完整结果和仍需 Production 验证的项目见 `docs/progress/PHASE-03-FINAL-SUMMARY.md`。

Phase 4 implementation complete through API Serving。当前 HEAD 是 `38b401d`，migration journal 是 `0000`–`0004`。`docs/progress/PHASE-04-FINAL-SUMMARY.md` 不存在。

Completed:

- Media processing pipeline
- Renderer
- Verifier
- Publish
- Recovery
- Worker
- READY transaction
- album_media visibility
- Derived API serving

Final validation at `38b401d`：`pnpm lint` PASS，`pnpm format:check` PASS，`pnpm typecheck` PASS，`pnpm test` PASS，81 files，620 tests。`FINAL_VALIDATION_STABILIZED: YES`。

Deferred:

- production deployment validation
- real power loss validation
- SSD disconnect validation
- production rate limiting
- persistent audit storage
- open P2/P3：uid-mismatch 与 cross-device fixture、verifier production deadline 与 DEV fixture 的差异、identical sealed temp 不自动进入 READY，以及 storage `READ_ONLY` 时 derived serving 返回 `503`。Phase 4C/D2 parallel claim collision 已由 `38b401d` 的 integration test isolation 关闭，不再作为未关闭缺陷。

不得自动进入 Phase 5，不得打 `phase-4-complete` tag，不得把 Phase 4 写成 fully production ready。后续不再使用 `codex-bridge-chatgpt`。
