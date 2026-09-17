# CONTEXT_BUDGET — 上下文与额度控制

## 1. 不重复读取整个项目

每轮优先读取：
- 相关 AGENTS 规则
- 当前 ROADMAP Phase
- 相关 package
- 当前 git diff

不要默认全文重读 PROJECT / ARCHITECTURE / DATABASE_SCHEMA / UI_REFERENCE。

## 2. 每个 Phase 创建摘要

完成后更新：

`docs/progress/PHASE-XX-SUMMARY.md`

内容仅包括：
- 已完成内容
- 最终技术决策
- 关键文件
- migrations
- 测试结果
- 未解决问题
- 下一阶段入口

后续优先从摘要恢复上下文。

## 3. Debug 扩张顺序

第一次失败：
- error
- 相关代码
- 最小修复

第二次失败：
- 扩大相关上下文

确认复杂：
- Terra → Sol

不要一遇到报错就扫描整个 repo 或升级 Astra。

## 4. 测试

小改：targeted。
Phase：全量一次。
Release：全量 + security review。

## 5. Bridge Context Packet

Bridge 只发送：
- 问题
- 最小相关代码
- failing tests
- constraints
- sanitized logs

不要发送整个 repo。

## 6. UI

已存在 `ui/app-preview.png`、`ui/web-preview.png`。

第一次提取 design tokens 后，普通 UI 开发优先读 tokens 和组件规范。
只有视觉偏差 review 时重新查看完整参考图。
