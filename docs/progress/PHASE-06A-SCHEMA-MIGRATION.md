# Phase 6A — Schema & Migration 0006

日期：2026-09-27。范围：schema / migration / readiness / tests；没有 repository、service、API、Web 或 download implementation。

## Baseline and authority

- Branch：main；HEAD / phase-5-complete：`039e59ca129796d14c2a78f087c681e313fbdbc6`。
- 设计：`docs/progress/PHASE-06-DESIGN.md` 第 4 节；本轮用户明确授权通过 preflight 后执行 DEV migration。
- 开始时只有设计文档以及已知生成的 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md` 未跟踪；生成文件未修改。
- DEV：family_album_dev / MySQL 9.7.2 / non-root / native FK = 1 / foreign_key_checks = 1 / strict SQL mode。
- 迁移前 exact manifest 0000–0005 与完整物理 schema readiness PASS。
- 迁移前 users、families、family_members、albums、album_members、storage_objects、upload_sessions、media_items、album_media、derived_assets、background_jobs、shares、share_events 行数均 0。

## Migration artifacts

- `packages/db/drizzle/0006_phase_06_album_features.sql`。
- `packages/db/drizzle/meta/0006_snapshot.json`；prevId 连接原 0005 snapshot。
- `_journal.json` 仅追加 idx 6 / 0006。
- 0000–0005 SQL 未改；静态测试固化基线 SQL SHA-256 和 journal prefix，防止改写历史。
- Drizzle 生成 DDL 后为五个新表显式指定 InnoDB / utf8mb4 / utf8mb4_0900_ai_ci，与现有 migration 惯例一致。
- 无 trigger、procedure、CASCADE、DROP、TRUNCATE、旧列类型修改或数据回填。

## Exact schema

所有 id 是 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY；所有引用 ID 是 BIGINT UNSIGNED NOT NULL；created_at 是 DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)。所有 FK ON UPDATE/DELETE RESTRICT。

| Table           | Additional columns                                                            | Unique indexes                                                               | Supporting indexes                                                                                              |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| user_favorites  | family_id, member_id, media_id                                                | uq_user_favorites_identity(family_id,member_id,media_id)                     | idx_user_favorites_member_time(family_id,member_id,created_at,id); idx_user_favorites_media(family_id,media_id) |
| family_featured | family_id, media_id, featured_by_member_id                                    | uq_family_featured_identity(family_id,media_id)                              | idx_family_featured_time(family_id,created_at,id); idx_family_featured_actor(family_id,featured_by_member_id)   |
| tags            | family_id; name VARCHAR(64) NOT NULL; name_normalized VARBINARY(256) NOT NULL | uq_tags_identity(family_id,name_normalized); uq_tags_family_id(family_id,id) | unique indexes already support family/identity lookups                                                          |
| media_tags      | family_id, media_id, tag_id                                                   | uq_media_tags_identity(family_id,media_id,tag_id)                            | idx_media_tags_tag(family_id,tag_id,media_id)                                                                   |
| comments        | family_id, media_id, author_member_id; body VARCHAR(2000) NOT NULL            | none beyond PK                                                               | idx_comments_media_time(family_id,media_id,created_at,id); idx_comments_author(family_id,author_member_id)      |

总计：5 个 PK、5 个 secondary unique、7 个普通 secondary indexes。无 comment edited_at。

media_items 只追加：

- description VARCHAR(4000) NULL，默认 NULL。
- note_revision BIGINT UNSIGNED NOT NULL DEFAULT 1。
- 原有 generation、metadata、timeline、source_upload_id 和其他字段均未变。

### Foreign keys

8 个 composite FK + 1 个 family FK = 9：

- fk_user_favorites_member：(family_id,member_id) → family_members(family_id,id)。
- fk_user_favorites_media：(family_id,media_id) → media_items(family_id,id)。
- fk_family_featured_media：(family_id,media_id) → media_items(family_id,id)。
- fk_family_featured_actor：(family_id,featured_by_member_id) → family_members(family_id,id)。
- fk_tags_family：family_id → families(id)。
- fk_media_tags_media：(family_id,media_id) → media_items(family_id,id)。
- fk_media_tags_tag：(family_id,tag_id) → tags(family_id,id)。
- fk_comments_media：(family_id,media_id) → media_items(family_id,id)。
- fk_comments_author：(family_id,author_member_id) → family_members(family_id,id)。

### CHECK constraints

- chk_tags_name：CHAR_LENGTH(name) 1–64 且 OCTET_LENGTH(name) <= 256。
- chk_tags_normalized：OCTET_LENGTH(name_normalized) 1–256。
- chk_comments_body：CHAR_LENGTH(body) 1–2000 且 OCTET_LENGTH(body) <= 8000。
- chk_media_items_description：NULL 或 CHAR_LENGTH 1–4000 且 OCTET_LENGTH <= 16000。
- chk_media_items_note_revision：note_revision >= 1。

Schema 不试图用 collation 替代 tag normalization，不在 DB 编码当前 album visibility 或 admin/author 授权；这些留在 6B/6C。RESTRICT 不创建 Phase 7 purge/restore 行为。

## Execution and preservation

执行入口：`node --import tsx packages/db/scripts/migrate-phase-06.ts --apply`。

此 DEV-only wrapper 在同一连接核对 predecessor schema、exact journal、non-root、MySQL/FK/strict mode 后调用项目使用的 Drizzle mysql2 migrator。无 --apply 时仅 preflight；已应用0006时拒绝按 predecessor 重跑。

因既有业务数据为空，执行前创建一条 SQL-only synthetic canonical media 及其必要父行，模拟“迁移前已存在媒体”。迁移后检查：description=NULL、note_revision=1，原38个字段逐值相等，所有 protected table 行数不变。然后按确切 family/row IDs 清理，不删未知数据，不创建/访问实际 original 文件。

0006 DDL 和 journal 已完成一次。首次运行在后置 readiness 失败（旧行和默认值断言此前已通过），并执行了 synthetic cleanup。只读诊断显示：

1. MySQL 将 OCTET_LENGTH 显示为等价 LENGTH；readiness 当时未规范化这个字节长度别名。
2. SQL 将两列追加至表尾，Drizzle 声明原位于 mediaItems 中部，readiness 比较列顺序失败。

修复仅限 readiness 字节函数别名和 schema/snapshot 声明顺序；没有更改已执行0006 SQL、没有重跑 DDL、没有新增 migration。新测试证明 CHAR_LENGTH 不会被当成 LENGTH，实际约束语义漂移仍拒绝。

## Live probes and cleanup

`tests/integration/phase6-schema.test.ts`：每例独立 transaction，生成两个 synthetic family，所有结束路径 rollback；结束后检查该例所有新表/父表/用户行计数为0。

- 8 种 cross-family insert 均要求 ERROR 1452：favorite member/media、featured actor/media、media_tags media/tag、comments author/media。
- 4 种 unique 冲突均要求 ERROR 1062：favorite、featured、normalized tag、media/tag。
- 4 种 media RESTRICT、3 种仅被Phase6引用的member RESTRICT、1 种tag RESTRICT均要求 ERROR 1451。
- 空tag/name_normalized/comment/note与revision0触发 CHECK 3819；越长VARCHAR/VARBINARY在strict模式触发1406。
- utf8mb4 emoji最大长度、binary canonical bytes、不同family同normalized值、é/e与ß/ss二进制区别、note BIGINT >2^53 精确保留。
- note更新只改变note字段，原metadata/generation/timeline字段逐值不变。
- targeted Phase6 live 23例 + Phase5C sharing 4例：27/27 PASS，0 skipped。

## Historical regression maintenance

- 0003/0004/0005静态测试继续检查历史 snapshot/SQL，不再要求当前表永远只有旧列；0006测试精确验证全部旧列/旧表未变。
- Phase5C live suite 原setup删除shares/share_events及journal后重跑0005，不能兼容后续migration且不应触及既有分享数据。改为只读完整manifest/readiness和行数保持检查；原有4项synthetic FK/CHECK/unique/RESTRICT测试保留。
- readiness的PROJECT_TABLES纳入五个新表，缺表/partial schema仍fail closed。

## Validation

| Gate                          | Final result                                 |
| ----------------------------- | -------------------------------------------- |
| Phase6 migration/schema tests | 7/7 PASS                                     |
| Phase6 native MySQL probes    | 23/23 PASS                                   |
| pnpm lint                     | PASS, 0 errors/warnings                      |
| pnpm format:check             | PASS                                         |
| pnpm typecheck                | PASS                                         |
| pnpm test                     | 103 files, 733/733 PASS, 0 skipped           |
| pnpm test:integration         | 23 files, 196/196 PASS, 0 skipped            |
| pnpm build                    | PASS, workspace/native/Web/mobile/API/worker |
| git diff --check              | PASS                                         |

首次全量测试为732/733，唯一失败是0004测试要求当前media永远等于0003的38列；已修正历史断言后完整重跑733/733，不以targeted替代最终Gate。

最终只读核验：0000–0006共7条journal；连续两次readiness PASS，前后journal行完全一致；无0007。全部20个应用表行数均为0，包括新五表和synthetic父行。无真实媒体读写，无未知数据清理。

## Security and stop point

没有新增 original path/storage key/share-token relation；没有修改 API 或公开分享能力。Native FK负责家庭引用一致性，不代替后续服务端权限。未开始6B，未commit/push/tag。

P0/P1/P2/P3（本轮未解决项）：0/0/0/0。既有production rate limiting、persistent audit及生产存储验证缺口仍保留，不属于本阶段解决范围。

PHASE_06A_PASS: YES
MIGRATION_0006_APPLIED: YES
DESIGN_CHANGE_REQUIRED: NO
READY_FOR_PHASE_06B: YES

## Final-review P1 remediation — CHECK readiness (2026-09-28)

最终只读审查发现原 `normalizeCheck()` 删除全部括号，可能将
`CHAR_LENGTH(body) BETWEEN 1 AND 2000 AND LENGTH(body) <= 8000`
与 `(CHAR_LENGTH(body) BETWEEN 1 AND 2000 AND LENGTH(body)) <= 8000`
判为等价。后者允许空评论；现有 DEV CHECK 本身正确，缺陷在 drift detection。
因此上述首次 Gate 不代表该 P1 已通过；本节记录后续修复与重新验证。

修复采用限定 CHECK 语法的 tokenizer / structural parser，不做通用 SQL 等价推理：

- 保留 AND / OR / NOT、比较、BETWEEN、IN 的运算树；括号只在完整子表达式已解析后消除冗余，序列化重新显式括起运算节点。
- 精确支持 `MOD(identifier, integer)` / `identifier % integer`；不支持任意表达式参数的别名改写。
- 已观察到的 `OCTET_LENGTH(identifier)` / `LENGTH(identifier)` 合并；CHAR_LENGTH 保持不同。
- 仅支持既有 `_utf8mb4` 简单字符串 introducer 表示；保留字符串大小写、空白、点号及内容，不在字符串内部改写函数名。
- 保留 used_at / revoked_at 的整个已知表达式 De Morgan 映射；不做一般布尔代数变换。
- MySQL 负数边界 `-(840)` 与 `-840` 仅在整数 atom 上等价；不改写任意负号算术。
- 不支持的表达式保留原文，差异即拒绝；输入长度、token 数和解析嵌套均有限制。
- 不调整 column/index/FK 比较语义，不改 schema、任何 migration、API 或 storage。

新回归覆盖真实 comment CHECK 分组攻击、布尔/算术/NOT 分组、字符/字节函数区别、identifier/literal 漂移、字符串内容保持及既有结构 drift。现有测试的字符串替换改用真实大写 enum 字面值，以适应不再把字符串转小写的安全比较，原断言未削弱。

最终验证（本轮实际执行）：

- Targeted：4 files / 95 tests PASS，包括真实 DEV Phase 6 schema 23 probes。
- `pnpm lint`：PASS，0 errors/warnings（首次发现新 helper 一个多余正则转义，机械修复后重跑通过）。
- `pnpm format:check`：PASS。
- `pnpm typecheck`：PASS，全 workspace。
- `pnpm test`：104 files / 770 tests PASS，0 skipped。
- `pnpm test:integration`：23 files / 196 tests PASS，0 skipped。
- `pnpm build`：PASS，全 workspace / native / Web / mobile / API / worker。
- `git diff --check`：PASS。
- 最终 readonly DEV 检查：family_album_dev / MySQL 9.7.2 / non-root / Native FK=1 / foreign_key_checks=1；0000–0006 journal 7行且各 SQL hash/时间戳一致；readiness PASS；所有应用表合计0行。
- 最终 in-memory mutation probe：confirmed grouping attack REJECTED。

本轮新增或修改仅为 `check-expression.ts`、`check-expression.test.ts`、readiness 接入及其已有测试、本文档。既有未提交的 Phase 6A schema/migration/test 变更保留，没有在本轮修改。未 commit/push，未开始6B。

0006 冻结 SHA-256：`533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`。未重跑 migration，未创建0007。

P1_CLOSED: YES
READINESS_COMPARATOR_SAFE: YES（限定支持语法；未知差异拒绝）
MIGRATION_0006_FROZEN: YES
PHASE_06A_PASS: YES
READY_FOR_PHASE_06A_CHECKPOINT: YES
READY_FOR_PHASE_06B: YES（未开始）
