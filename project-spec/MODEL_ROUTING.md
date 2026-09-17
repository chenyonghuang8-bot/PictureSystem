# MODEL_ROUTING — V1.3 额度自适应策略

默认 Profile：`PLUS_ECONOMY`

## 1. 两个配置档

### PLUS_ECONOMY（默认）
适合当前 Plus：

- R0/R1 日常实现 → GPT-5.6 Terra
- R2 核心复杂实现 → GPT-5.6 Sol Medium
- R3 高风险设计/审查 → GPT-6 Astra Low
- R4 独立第二视角 → hardened `codex-bridge-chatgpt`

### PRO_BALANCED
只有用户明确说明已升级 Pro 后启用：

- 日常实现 → GPT-5.6 Sol Medium
- 机械/UI → Terra
- 高风险 → GPT-6 Astra Low
- 独立复核 → hardened Bridge

Pro 也继续遵守测试和上下文节流规则。

## 2. ROUTING DECISION

重要任务修改代码前必须输出：

```text
ROUTING DECISION
Profile: PLUS_ECONOMY / PRO_BALANCED
Risk: R0 / R1 / R2 / R3 / R4
Current Model: <可靠识别不到则 unknown>
Recommended Model: ...
Bridge: required / optional / no
Test Scope: targeted / milestone-full
Action: continue / pause-for-model-switch / invoke-bridge
Reason: ...
```

## 3. R0 / R1 — 默认 Terra

用于：
- UI / CSS
- CRUD
- 表单
- 普通 API
- 普通查询
- 文档
- fixtures
- 常规测试
- 普通 bug

如果当前已经在 Sol，不需要为了几分钟的小任务立即中断切换；下一轮任务再回 Terra。

## 4. R2 — 才升级 Sol Medium

满足任一项才进入 R2：
- 涉及 3 个以上核心 package
- 跨层状态/数据流复杂
- Terra 已尝试一次仍无法可靠解决
- Worker / Upload / Search 等核心复杂实现
- React Native 生命周期或后台上传复杂问题
- 跨层 integration bug

代码量大不等于 R2。

R2 完成后若剩余工作已机械化，提示：

```text
MODEL_DOWNGRADE_RECOMMENDED
Target: GPT-5.6 Terra
```

## 5. R3 — Astra Low，只做高风险

触发：
- Auth / password / session
- Authorization / permissions / 越权
- destructive migration
- upload atomicity
- media reference consistency
- permanent delete / purge
- backup / restore
- storage migration
- production deployment security
- secrets
- data corruption
- 连续两次普通修复失败

如果当前不是 Astra Low：

```text
MODEL_SWITCH_REQUIRED
Target: GPT-6 Astra
Reasoning: Low
Reason: ...
```

然后暂停。

Astra 用来：
- 分析
- 设计
- review
- 诊断

方案明确后，长时间编码优先回 Sol/Terra。

## 6. R4 — Bridge 是稀缺 review

必须实际调用 hardened `$codex-bridge-chatgpt` 的情况：

- 用户明确要求“本次调用 Bridge”
- Release Candidate
- Auth/Permission 最终设计仍有争议
- Backup/Restore/Storage 在 Astra review 后仍不确定
- Astra 后复杂 Bug 仍未解决
- 重大架构重构最终拍板

以下不进入 R4：
- Phase 0
- 普通 UI
- CRUD
- 常规测试
- 普通数据库表
- 仅因为“项目启用了 Bridge”
- 仅为了“多一层保险”

默认一个 milestone 最多一次 Bridge review。

## 7. 测试节流

开发中只跑 targeted tests：

```text
改 auth → auth unit + relevant integration
改 gallery → web typecheck + gallery tests
改 upload → upload/storage tests
```

不要每个小改都全仓：
- lint
- typecheck
- unit
- integration
- build
- e2e

只有 Phase/Milestone 结束时完整跑一次。

Release Candidate 再完整跑一次 + security review。

## 8. 上下文节流

不要每轮重新读取整个仓库。

优先顺序：
1. 相关 AGENTS 规则
2. 当前 Phase
3. git diff / git status
4. 相关 package
5. 上一个 Phase summary

只有架构改变时重读完整 ARCHITECTURE。

## 9. 输出节流

日常回复只需：
- ROUTING DECISION
- 3–6 行计划
- 修改结果
- 测试结果
- 阻塞项

不要每条命令都长篇解释。

## 10. Web 搜索

无需最新资料时不搜索 Web。
需要版本/API 时一次集中搜索，优先官方文档。

## 11. 5 小时额度保护

Codex 无法可靠读取剩余额度，由用户提供。

### 剩余 < 60%
- 默认 Terra
- 非必要不使用 Bridge
- Astra 只处理真正 R3
- targeted tests
- 不开启非必要重构

### 剩余 < 30%：CONSERVE
- 只完成当前最小切片
- Terra 为主
- 不开启新大型 Phase
- 不做非必要重构
- Bridge 仅安全阻塞时使用
- Phase quality gate 后停止

## 12. 当前项目建议

- Phase 0 → Terra
- 普通邀请/账号 UI → Terra
- Auth/Session 设计 → Astra Low review
- Auth 核心实现 → Sol Medium
- 相册 CRUD → Terra
- Permission engine → Astra Low 设计 + Sol 实现
- 普通照片 UI → Terra
- Upload UI → Terra
- Upload atomic finalize / dedupe → Sol，关键点 Astra review
- Backup / Restore → Astra 方案 + Sol 实现
- Release → Astra + Bridge
