# Phase 8 网页整批规划流程复盘

2026-10-04 UTC。仅记录本批可核对的事实，供用户决定是否沿用流程；未启动下一阶段，也未调用 Bridge/browser handoff。

网页 Chat 完成整批规划，父代理核对后由用户批准合同。实施沿用固定 H3 res6、附近城市而非行政归属、ACL 前置、provider 外联边界和版本校验合同，没有重新做纯规划。这样给地图/API/数据集实施提供了统一边界；能否减少总耗时或额度，缺少可比测量，不能据此量化。

本地源码与真实运行补出了规划不能替代的事实：原 COMPLETE upload 缺少运行中 canonical/probe/下游接线；metadata 与 derivative owner 没有完整启动链。经补充 Astra guardrails 后实现唯一 API writer 的 reconciliation、metadata driver 和 derivative runtime attachment，以真实新上传及进程重启跑到 READY/map，而非用已有 GPS 回填或 mock 交付。

实际数据验证发现 Natural Earth DBF 尾部 NUL padding 导致草稿 importer 把国家全部映射为 unknown。修正 normalization v2、重新生成 pinned bundle/版本，并用实际 dataset 测试。交接中的旧 v1 cached manifest 证据明确过时，未复用为最终校验。

独立审查发现停止后的 selection 和近零 bbox exponent 两项 P2；补交叉矩阵时默认 keep-alive 暴露 shutdown drain 等待问题。修复后由原 Astra 审查者限定复核 CLOSED，并保留失败日志及屏障/硬件覆盖的边界。完整 gate 又发现旧 migration 测试固定 journal=8、HTTPS fixture 的共享 IP 限流窗口；限定修复测试/工具后重新跑相关完整 gate，未放宽产品权限或限流。

本批流程的有效分工是：已批准的批次合同确定目标与隐私边界；本地源码、真实数据和 DEV runtime 确认实现；独立审查与最后统一 gate 收口。外部 basemap 后续成功只证明后续窗口成功，不能倒推旧失败原因。证据数量也不能将重叠 targeted/完整 gate 用例累加。

最终产出与本轮实测见 `PHASE-08-FINAL-SUMMARY.md`；用户可据此评估流程。没有可靠的 Fast/普通速度、token、费用或净节省时间对照，故不作节省承诺。
