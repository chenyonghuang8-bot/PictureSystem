# Phase 0.5 Inspection

ROUTING DECISION: R1 read-only inspection / report. Profile: `PLUS_ECONOMY`. Current runtime cannot switch models; no code was modified.

## Overall
PASS_WITH_WARNINGS

Phase 0 应用骨架（monorepo、质量门禁脚本、DEV 配置雏形、health smoke）看起来已经就位。进入 Phase 1 之前，仓库布局、Git、AGENTS 引用路径、Bridge 位置和本机 MySQL 版本仍需要 Codex 处理。本次只检查，未修改任何业务代码、数据库或系统软件。

## 1. Repository Root

检查对象：`/Users/toby/PictureSystem` 一级结构。

| 期望项 | 结果 |
| --- | --- |
| `AGENTS.md` | PRESENT |
| `README.md` | MISSING |
| `package.json` | PRESENT |
| `pnpm-lock.yaml` | PRESENT |
| `pnpm-workspace.yaml` | PRESENT |
| `tsconfig.base.json` | PRESENT |
| `eslint.config.mjs` | PRESENT |
| `playwright.config.ts` | PRESENT |
| `vitest.config.ts` | PRESENT |

当前根目录一级结构：

```text
.DS_Store
.env.example
.gitignore
.prettierignore
.prettierrc.json
AGENTS.md
apps/
database/
eslint.config.mjs
node_modules/
package.json
packages/
playwright.config.ts
pnpm-lock.yaml
pnpm-workspace.yaml
project-spec/
test-results/
tests/
tsconfig.base.json
vitest.config.ts
嘟嘟家庭相册/
```

备注：

- 根目录不是 Git 仓库（`git rev-parse` 失败）。
- `嘟嘟家庭相册/` 只有一个空的 `.git`（`main` 尚无 commit），不是项目源码树。
- 方案文件（`PROJECT.md` 等）不在根目录，而在 `project-spec/`。

## 2. Project Spec

`project-spec/` 一级目录树：

```text
.DS_Store
AGENTS.md
ARCHITECTURE.md
BRIDGE_POLICY.md
CHANGELOG.md
CODEX_START_PROMPT.md
CONTEXT_BUDGET.md
MODEL_ROUTING.md
PROJECT.md
README.md
ROADMAP.md
UI_REFERENCE.md
codex-routing.json
database/
skills/
ui/
vendor/
```

允许存在的方案内容：`PROJECT.md`、`ARCHITECTURE.md`、`ROADMAP.md`、`MODEL_ROUTING.md`、`BRIDGE_POLICY.md`、`CONTEXT_BUDGET.md`、`UI_REFERENCE.md`、`CHANGELOG.md`、`codex-routing.json`、`ui/`、`database/` 均存在。

不应重复存在的 Starter 内容：

| 路径 | 结果 |
| --- | --- |
| `project-spec/AGENTS.md` | PRESENT（与根目录 `AGENTS.md` 字节级 identical） |
| `project-spec/README.md` | PRESENT（根目录没有 README） |
| `project-spec/package.json` | ABSENT |
| `project-spec/apps/` | ABSENT |
| `project-spec/packages/` | ABSENT |
| `project-spec/node_modules/` | ABSENT |
| `project-spec/skills/` | PRESENT（含可执行 `codex-bridge-chatgpt` Skill） |
| `project-spec/vendor/` | PRESENT（含 hardened zip + checksums） |
| `project-spec/scripts/` | ABSENT |

额外重复：

- `project-spec/database/DATABASE_SCHEMA.md` 与根目录 `database/DATABASE_SCHEMA.md` identical
- `project-spec/database/schema.sql` 与根目录 `database/schema.sql` identical

结论：`project-spec` 仍保留一套 Starter 的 `AGENTS.md` / `README.md` / `skills/` / `vendor/`。只报告，未移动、未删除。

## 3. AGENTS References

读取根目录 `AGENTS.md`。其中引用按“仓库根相对路径”检查。

| 引用 | 结果 |
| --- | --- |
| `PROJECT.md` | BROKEN: `PROJECT.md`（实际在 `project-spec/PROJECT.md`） |
| `ARCHITECTURE.md` | BROKEN: `ARCHITECTURE.md`（实际在 `project-spec/ARCHITECTURE.md`） |
| `ROADMAP.md` | BROKEN: `ROADMAP.md`（实际在 `project-spec/ROADMAP.md`） |
| `MODEL_ROUTING.md` | BROKEN: `MODEL_ROUTING.md`（实际在 `project-spec/MODEL_ROUTING.md`） |
| `BRIDGE_POLICY.md` | BROKEN: `BRIDGE_POLICY.md`（实际在 `project-spec/BRIDGE_POLICY.md`） |
| `CONTEXT_BUDGET.md` | BROKEN: `CONTEXT_BUDGET.md`（实际在 `project-spec/CONTEXT_BUDGET.md`） |
| `UI_REFERENCE.md` | BROKEN: `UI_REFERENCE.md`（实际在 `project-spec/UI_REFERENCE.md`） |
| `ui/app-preview.png` | BROKEN: `ui/app-preview.png`（实际在 `project-spec/ui/app-preview.png`） |
| `ui/web-preview.png` | BROKEN: `ui/web-preview.png`（实际在 `project-spec/ui/web-preview.png`） |
| `skills/codex-bridge-chatgpt` | BROKEN: `skills/codex-bridge-chatgpt`（实际在 `project-spec/skills/codex-bridge-chatgpt`） |
| `docs/progress/PHASE-XX-SUMMARY.md` | BROKEN: `docs/progress/` 不存在 |

未修改任何引用。

## 4. MySQL

Client:
`/usr/local/mysql/bin/mysql` — `mysql  Ver 26.7.0 for macos15 on arm64 (MySQL Community Server - GPL)`

Server:
`/usr/local/mysql/bin/mysqld` — `/usr/local/mysql-26.7.0-macos15-arm64/bin/mysqld  Ver 26.7.0 for macos15 on arm64 (MySQL Community Server - GPL)`

Install:
Oracle/MySQL 官方包，路径 `/usr/local/mysql -> mysql-26.7.0-macos15-arm64`。Homebrew 已安装（`/opt/homebrew/bin/brew`，Homebrew 6.0.22），但 `brew list --versions` 中无 mysql/mariadb formula；`HOMEBREW_NO_AUTO_UPDATE=1 brew services list` 为空，无 brew 托管的 MySQL service。未启动、未升级、未改配置。

Running:
YES。存在 `_mysql` 用户进程：`/usr/local/mysql/bin/mysqld --user=_mysql --basedir=/usr/local/mysql --datadir=/usr/local/mysql/data`。另有 MySQL Workbench 进程。

Port 3306:
`lsof -nP -iTCP:3306 -sTCP:LISTEN` 对当前用户无 LISTEN 行（mysqld 以 `_mysql` 运行，无特权 `lsof` 看不到其 LISTEN）。间接证据：本机 MySQL Workbench 有到 `127.0.0.1:3306` 的 ESTABLISHED 连接，因此本地 3306 实际可连。Workbench 还存在到非 localhost 的 `:3306` 会话；未记录地址。未执行任何 SQL、未读取密码。

Suitable for project: NEEDS_REVIEW

原因：

- 项目目标是 MySQL 8.4 LTS（`AGENTS.md` / `project-spec/README.md`）。
- 本机精确版本是 Community Server **26.7.0**，不是 8.4。
- `AGENTS.md` 要求：版本不同先报告兼容性，不自动升级、不改全局 MySQL 配置。
- Phase 0 ROADMAP 要求创建 `family_album_dev` 与 DEV 应用用户；因禁止连库改库，本次无法验证是否已创建。

## 5. Monorepo

目录存在性：

```text
apps/web/      PRESENT  @family-album/web
apps/api/      PRESENT  @family-album/api
apps/worker/   PRESENT  @family-album/worker
apps/mobile/   PRESENT  @family-album/mobile
packages/      PRESENT  9 packages
```

packages：`auth`、`config`、`contracts`、`db`、`i18n`、`media`、`permissions`、`storage`、`ui-tokens`。名称均唯一，均为 `@family-album/*`。

`pnpm-workspace.yaml`：

```yaml
packages:
  - apps/*
  - packages/*
```

覆盖上述全部 workspace。`pnpm list -r --depth -1` 能解析 1 个 root + 4 apps + 9 packages。`pnpm-lock.yaml` 中内部依赖均为 `workspace:*` → `link:../../packages/...`，未见错误路径或无法解析的内部包。

内部依赖：

- `@family-album/web` → `@family-album/ui-tokens`
- `@family-album/mobile` → `@family-album/ui-tokens`
- `@family-album/api` → `@family-album/config`、`@family-album/contracts`
- `@family-album/worker` → `@family-album/config`

未见重复 workspace 或 package name 冲突。`@family-album/db` 尚未被 apps 引用，符合 Phase 0 skeleton，不是损坏。

## 6. DEV / PROD Isolation

概念已经分开，但还是配置雏形，不是完整隔离。

env 文件：

- 仅有 `.env.example`
- 无 `.env` / `.env.prod` / `.env.local`
- `.env.example` 含 `APP_ENV=dev`、指向 `family_album_dev` 的 `DATABASE_URL` 占位符、`DEV_MEDIA_ROOT=./data/dev/media`、`DEV_TEMP_UPLOAD_ROOT=./data/dev/temp-uploads`
- 占位符密码，不是真实 secret：无 `SECRET_PRESENT`
- `.gitignore` 为 `.env*` + `!.env.example`；当前无 `.env` 可被跟踪。因根目录尚未 `git init`，跟踪状态本身还不成立。

database config：

- `packages/config` 有 `APP_ENV: dev | prod`，默认 `dev`
- `parseDatabaseUrl()` 强制 pathname 为 `/family_album_dev`，会拒绝 `family_album_prod`
- 该校验只出现在测试 / helper，API 启动路径 `loadApiEnv()` **不读取** `DATABASE_URL`
- `packages/db/drizzle.config.ts` 默认 `mysql://127.0.0.1:3306/family_album_dev`
- 未发现代码写死 production secret

media/storage path：

- `.env.example` 只定义 DEV 媒体目录
- 无 PROD 媒体路径 env
- `packages/storage` 仍是 Phase 3 占位
- `ARCHITECTURE.md` 要求 DEV/PROD 媒体目录分离；应用层尚未落地

风险结论：

- DEV 与 PROD 指向同一数据库：当前无 PROD 运行配置；helper 会拒绝 prod 库名。运行时尚未强制。**未见已发生的共用事实。**
- DEV 与 PROD 共用媒体目录：PROD 路径未定义，无法证实共用；也尚未落实分离。
- production secret 写死进代码：未发现。
- `.env` 被 Git 跟踪：无 `.env` 文件；根目录还不是 git repo。

## 7. Git / Ignore

`git status --short` 在项目根失败：`fatal: not a git repository`。

唯一发现的 git 元数据：`嘟嘟家庭相册/.git`，空仓库，无 commit。

`.gitignore` 已覆盖：

- `node_modules/`
- `test-results/`
- `coverage/`
- `playwright-report/`
- `.env` / `.env.*`（通过 `.env*`，并保留 `!.env.example`）
- `backups/`

建议补上（不要由 Cursor 改）：

- `media/`（现有的是 `media-data/`、`originals/`、`derived/`、`data/`）
- `uploads/`（现有的是 `temp-uploads/`）
- `temp/`（现有的是 `temp-uploads/`）
- 误创建的嵌套仓库目录 `嘟嘟家庭相册/`，避免以后被当成普通文件提交

`test-results/.last-run.json` 显示最近 e2e 为 `"status": "passed"`。该目录已被 ignore 规则覆盖，但根目录尚未初始化 Git。

## 8. Phase 0 Quality Gate

读取根 `package.json` scripts，**未重新跑全套测试**。

| 命令 | 结果 |
| --- | --- |
| install | 无 npm script `install`；等价命令是 `pnpm install`（`packageManager: pnpm@10.34.5`） |
| format:check | PRESENT：`prettier --check ...` |
| lint | PRESENT：`eslint . --max-warnings=0` |
| typecheck | PRESENT：`pnpm -r --if-present typecheck` |
| test | PRESENT：`vitest run --config vitest.config.ts` |
| build | PRESENT：`pnpm -r --if-present build` |
| test:e2e | PRESENT：`playwright test` |

另有 `test:integration`、`dev`、`format`。

用户提供的 Phase 0 执行结果（本次未复跑）：install / format:check / lint / typecheck / test / build / e2e `/health` smoke 均 ✅。本地旁证：`test-results/.last-run.json` 为 passed。

缺口（配置层，非本次复跑失败）：

- 无 `docs/progress/PHASE-00-SUMMARY.md`（`CONTEXT_BUDGET.md` 要求 Phase 完成后更新）
- Phase 0 ROADMAP 中的本机 MySQL 8.4 检查 / `family_album_dev` 创建无法从现有文件确认为已完成

## 9. UI References

只检查存在性和路径，未分析图片内容。

| 参考图 | 根路径 | 实际路径 |
| --- | --- | --- |
| App UI | MISSING `ui/app-preview.png` | PRESENT `project-spec/ui/app-preview.png` |
| Web UI | MISSING `ui/web-preview.png` | PRESENT `project-spec/ui/web-preview.png` |

`project-spec/UI_REFERENCE.md` 与根 `AGENTS.md` 都写的是 `ui/app-preview.png`、`ui/web-preview.png`（未带 `project-spec/` 前缀）。

## 10. Bridge Duplication

发现的 `codex-bridge-chatgpt` 位置：

- 根目录 `skills/`：**不存在**
- 根目录 `vendor/`：**不存在**
- `scripts/install-codex-bridge-skill.sh`：**不存在**
- `project-spec/skills/codex-bridge-chatgpt/`：完整 Skill（`SKILL.md`、`scripts/`、`references/`、`agents/`）
- `project-spec/vendor/codex-bridge-chatgpt-hardened-skill.zip`
- `project-spec/vendor/BRIDGE_CHECKSUMS.txt`（含声明的 archive SHA-256 与 fingerprint `ac0ab9cde3d90cd612a448dd352a64b4dc50f98287f7cede7313da80eeb9db49`）

结论：可执行 Skill **没有**在仓库根保留一份；唯一副本在 `project-spec/`，这正是不应重复存放的 Starter 可执行 Skill。未安装、未运行 Doctor、未修改 Bridge。

## Issues for Codex

P0:
- 让根目录 `AGENTS.md` 的方案引用变为真实路径：把 `PROJECT.md`、`ARCHITECTURE.md`、`ROADMAP.md`、`MODEL_ROUTING.md`、`BRIDGE_POLICY.md`、`CONTEXT_BUDGET.md`、`UI_REFERENCE.md`、`ui/*.png` 放到根（或改 AGENTS 引用为 `project-spec/...`）。当前全部 BROKEN。
- 在真正的项目根 `/Users/toby/PictureSystem` 初始化 Git；不要使用空的嵌套仓库 `嘟嘟家庭相册/.git`。处理该误创建目录（移出工作区或纳入 ignore），避免以后污染提交。
- 按 `AGENTS.md` / `BRIDGE_POLICY.md` 在仓库根保留唯一一份 hardened `skills/codex-bridge-chatgpt`（及需要的 `vendor/`）。不要从 upstream `main` 安装。随后从 `project-spec` 去掉可执行 Skill 副本，避免两套。

P1:
- 补根目录 `README.md`（可基于 `project-spec/README.md`，但路径要改成当前仓库布局）。
- 清理 `project-spec` 中不应重复的 Starter 文件：`AGENTS.md`、`README.md`、`skills/`、`vendor/`（在根目录就位之后）。`database/` 与根目录完全重复，决定只保留一处。
- 就本机 MySQL **26.7.0** vs 目标 **8.4 LTS** 向用户确认：继续用现有 Community Server，还是另用隔离的 8.4。不要自动升级或改全局配置。
- 用户确认后，用专用 DEV 流程检查/创建 `family_album_dev` 与 DEV 应用用户；不要碰 PROD，不要用临时 SQL 改生产。
- 补 `docs/progress/PHASE-00-SUMMARY.md`。
- 加强 DEV/PROD 隔离：`loadApiEnv` 纳入 `DATABASE_URL` / 媒体路径；PROD 路径单独配置；运行时拒绝 DEV 误连 PROD。
- `.gitignore` 建议增加 `media/`、`uploads/`、`temp/`，以及误创建的嵌套 git 目录。

P2:
- `parseDatabaseUrl()` 尚未接到 API/worker 启动路径。
- `@family-album/db` 尚未被 apps 依赖（Phase 1 再接线即可）。
- 无 npm script 名 `install`；若希望文档对称可加说明，不必强行加 script。
- 多处 `.DS_Store`。

## Recommended Next Step

NO

原因：Phase 0 代码质量门禁从配置和既有结果看已经具备，但 Codex 进入 Phase 1（Identity / Family / Invitations）前会先读 `MODEL_ROUTING.md`、`PROJECT.md`、`ARCHITECTURE.md`、`ROADMAP.md`。这些文件按 `AGENTS.md` 的根路径全部 BROKEN；Git 也未在项目根初始化；Bridge Skill 不在规定位置；本机 MySQL 不是 8.4 LTS。应先让 Codex 做一轮 **Phase 0.5 布局修复**（只改仓库结构/文档路径/Git/Bridge 位置，不实现 Phase 1 业务），确认引用 VALID 后再进入 Phase 1。
