# CHANGELOG

## V1.3

- 默认 Profile 改为 `PLUS_ECONOMY`。
- R0/R1 使用 Terra，R2 才升级 Sol Medium。
- Astra 仅用于 R3 高风险设计/审查。
- Bridge 收紧为真正的 R4 独立 review。
- 新增 `CONTEXT_BUDGET.md`。
- 开发中使用 targeted tests；完整质量门禁只在 Phase/Milestone 结束执行。
- 增加剩余额度低于 60% / 30% 时的节流规则。
- 预留 `PRO_BALANCED`，升级 Pro 后可直接切换。

## V1.2

- 默认模型策略改为 GPT-5.6 Sol Medium 常驻。
- 不再要求低风险任务频繁切 Luna/Terra。
- 增加每个重要任务强制 `ROUTING DECISION`。
- R3 高风险任务若不在 Astra Low，必须暂停并输出 `MODEL_SWITCH_REQUIRED`。
- R4 必须实际调用 `$codex-bridge-chatgpt`，不能只口头建议。
- Bridge fail-closed 后禁止自动 repair/resubmit。
- 高风险工作结束后建议降回 Sol Medium。
- 保留 hardened Bridge 固定版本与 fingerprint 验证。
