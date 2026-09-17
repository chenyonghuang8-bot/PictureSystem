# Family Album — Codex Starter Pack

这是家庭相册系统的正式开工包。请先阅读以下文件，再开始编码：

1. `PROJECT.md` — 已确认的产品范围与业务规则
2. `ARCHITECTURE.md` — 技术架构与关键工程决策
3. `AGENTS.md` — Codex 必须遵守的开发规则
4. `ROADMAP.md` — 分阶段开发路线和验收标准
5. `database/DATABASE_SCHEMA.md` — 初版数据模型说明
6. `database/schema.sql` — MySQL 8.4 初版 schema 草案
7. `UI_REFERENCE.md` — UI 视觉基准和实现约束
8. `MODEL_ROUTING.md` — 根据任务风险与 Plus 额度自动选择 Luna / Terra / Sol / Astra / Bridge
9. `BRIDGE_POLICY.md` — hardened Bridge 的安装、安全和脱敏规则
10. `skills/codex-bridge-chatgpt/` — 已安全审计的 hardened Skill
11. `CODEX_START_PROMPT.md` — 第一条可以直接发送给 Codex 的 Prompt

## 当前已确认的关键决策

- 家庭内部使用，约 5 人，预计初期 1 万张照片以内。
- Android 是主要移动端；iPad 暂不做原生分发。
- Web 同时承担普通家庭相册和管理员后台。
- Mac mini M4 24×7 自托管。
- 数据库使用 MySQL，目标基线 MySQL 8.4 LTS。
- 账号 + 密码登录；账号全局唯一；密码至少 8 位，不要求大小写/数字/特殊符号组合。
- 仅邀请加入，不开放公众注册。
- 原始媒体不可修改（immutable）。
- 照片、视频、HEIC、RAW/DNG、4K/HDR/HEVC 原文件保存。
- V1 做文件级 SHA-256 完全去重。
- App Push 通知；不做短信和邮件。
- UI 必须以 `ui/app-preview.png` 与 `ui/web-preview.png` 为视觉基准。
- DEV / PROD 隔离，Codex 默认不得访问生产家庭照片。
- 重要流程必须有自动化测试与 E2E。

## 开工方式

把整个目录复制到 Codex 工作区，先发送 `CODEX_START_PROMPT.md` 中的内容。

不要一次性实现全部功能。严格按 `ROADMAP.md` 的 Phase 顺序推进。


## 安装 hardened codex-bridge-chatgpt

包内已经包含之前安全审计后的 Skill，不需要重新从 GitHub `main` 下载。

```bash
bash scripts/install-codex-bridge-skill.sh
```

安装脚本会备份旧 Skill，并运行 Doctor 验证 hardened fingerprint。

安装后新开一个 Codex 任务。

模型和 Bridge 路由规则见：
- `MODEL_ROUTING.md`
- `BRIDGE_POLICY.md`

## V1.2 路由机制

V1.2 不再追求“所有任务自动切模型”。

稳定策略：

```text
默认：GPT-5.6 Sol Medium
高风险 R3：暂停并要求切 GPT-6 Astra Low
独立复核 R4：必须实际调用 hardened codex-bridge-chatgpt
```

Codex 在重要任务开始前必须显示 `ROUTING DECISION`。

这样即使客户端不支持 agent 自动切换底层模型，也不会在错误模型上静默执行高风险修改。


## V1.3 — Plus 经济模式

默认：
- Terra：日常开发
- Sol Medium：核心复杂逻辑
- Astra Low：高风险分析/审查
- hardened Bridge：R4 独立复核

同时加入：
- targeted tests
- scoped context
- Phase summary
- 额度低于 60% / 30% 的节流规则

以后明确升级 Pro 后，将 `codex-routing.json` 的 profile 改为 `PRO_BALANCED` 即可。
