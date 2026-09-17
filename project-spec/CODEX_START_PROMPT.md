# Codex 第一条开工 Prompt

请先完整阅读仓库根目录中的：

- README.md
- PROJECT.md
- ARCHITECTURE.md
- AGENTS.md
- ROADMAP.md
- UI_REFERENCE.md
- MODEL_ROUTING.md
- BRIDGE_POLICY.md
- database/DATABASE_SCHEMA.md
- database/schema.sql

并把 `ui/app-preview.png` 与 `ui/web-preview.png` 作为后续 UI 的权威视觉参考。

在执行 Phase 0 前：

1. 检查 `~/.codex/skills/codex-bridge-chatgpt` 是否存在。
2. 如果不存在，不要从网络下载 `main`；告诉用户可以运行仓库内：
   `bash scripts/install-codex-bridge-skill.sh`
3. 如果存在，运行其 `scripts/doctor.mjs --json`，报告 READY / fingerprint 状态。
4. 每个后续任务都遵守 `MODEL_ROUTING.md`；不要假装进行了当前客户端不支持的模型切换。

## 强制模型/Skill 路由规则

从本任务开始，每个重要任务都必须先输出：

```text
ROUTING DECISION
Risk: ...
Current Model: ...
Recommended Model: ...
Bridge: ...
Action: ...
Reason: ...
```

默认模型按 GPT-5.6 Sol Medium 处理。

如果任务命中 R3 且当前不是明确的 GPT-6 Astra Low：
- 不得修改代码
- 输出 `MODEL_SWITCH_REQUIRED`
- 停止并等待用户切换模型后回复“继续”

如果任务命中 R4：
- 输出 `BRIDGE_REQUIRED`
- 必须实际调用 `$codex-bridge-chatgpt`
- 不允许只口头建议

详细规则以 `MODEL_ROUTING.md` 和 `BRIDGE_POLICY.md` 为准。

现在只执行 **ROADMAP Phase 0 — Repository & Foundation**，不要提前实现业务功能。

要求：

1. 先检查当前机器环境，包括：
   - macOS / CPU architecture
   - Node
   - pnpm
   - Docker
   - MySQL 版本
   - Git
2. 不要自动升级 macOS、MySQL 或其他系统级软件。
3. 如果 MySQL 已安装，优先复用。目标数据库为 MySQL 8.4 LTS；若版本不同，先报告兼容性，不要自行升级。
4. 初始化 TypeScript pnpm monorepo：
   - apps/web
   - apps/api
   - apps/worker
   - apps/mobile
   - packages/db
   - packages/auth
   - packages/contracts
   - packages/storage
   - packages/media
   - packages/permissions
   - packages/config
   - packages/ui-tokens
   - packages/i18n
5. Web 使用 Next.js App Router。
6. Mobile 使用 Expo + React Native + Expo Router，但 Phase 0 只建立可运行骨架。
7. API 使用 Fastify + Zod。
8. DB 使用 Drizzle ORM + mysql2。
9. 建立 DEV 配置，但不要创建或修改 production 数据库。
10. 建立：
    - ESLint
    - TypeScript
    - formatter
    - unit test
    - integration test skeleton
    - Playwright skeleton
    - env validation
    - structured logging
    - `/health` endpoint
11. 创建 `.env.example`，绝不提交真实 secret。
12. 建立 Git ignore，明确忽略：
    - `.env*`（保留 example）
    - media data
    - backups
    - temp uploads
    - test output
13. 建立 UI design tokens，先从参考图提炼：
    - background
    - surface
    - text
    - muted text
    - green accent
    - radius
    - shadow
    - spacing
14. 不要在 Phase 0 实现：
    - Auth
    - Upload
    - Album
    - AI
    - Production deployment
15. 完成后必须运行：
    - lint
    - typecheck
    - tests
    - build
16. 最后输出：
    - 创建了哪些文件
    - 当前环境检测结果
    - MySQL 版本与建议
    - 运行命令
    - 测试结果
    - 尚未完成事项
17. 完成 Phase 0 后停止，不要自动进入 Phase 1。

如果你认为 Phase 0 的某项技术决策与 AGENTS.md 冲突，以 AGENTS.md 为准。


## V1.3 当前额度策略

默认 Profile：`PLUS_ECONOMY`

当前 Phase 0 推荐使用 GPT-5.6 Terra。
Phase 0 不属于 R4，不调用 Bridge；也不需要 Astra。

开发过程中只跑 targeted checks。
Phase 0 完成时才统一运行一次：
- lint
- typecheck
- unit
- integration
- build
- e2e smoke

遵守 `CONTEXT_BUDGET.md`，不要反复读取整个仓库。
