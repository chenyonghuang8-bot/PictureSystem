# Phase 8 — NLS-R1 独立定点 closure

2026-10-02 UTC，基线 `ac39e49f9d7cdc8a8cbe7052deebd2d1958c2823`。

**NLS-R1/P2：CLOSED。定点复核：PASS。** 本批次唯一必须修复的搜索游标恢复问题已关闭；本次没有发现直接回归 blocker。原非地点搜索限定复核的其余结论沿用，不是全仓或整个 Phase8 完成签核。

## 范围与实现核实

读取 FIX-HANDOFF、fix-evidence、fix-manifest、真实 diff、实际错误 schema、相关生产组件及测试。仅核实 NLS-R1：已知分页400分类、清理/保留筛选/单次首屏恢复、失败停止及401/迟到响应。未修改实现、API、DB、权限、锁、存储或现有 root。

- `gallery-client.ts` 只在 HTTP400 且既有 strict flat `{code,message,requestId}` 合同通过、code 为 INVALID_REQUEST 时分类为 INVALID_REQUEST。未知code、额外/缺失字段、坏JSON或非合同400继续 UNAVAILABLE；其他HTTP状态的映射保留。没有将500/503或proxy失败视为无效cursor，也没有解析/输出错误body中的私人数据。
- `timeline.tsx` 只在搜索分页有 filters/onRefresh 时触发新分支。先清空 items/cursor/openIndex，再调用已有父组件 refresh。无条件搜索的空filters对象仍属于搜索；旧 timeline 没有此分支。普通失败保留已有页面与手动重试，401仍清理并通知登录丢失。
- 父组件使用 `latest.current` 与原 limit24 请求无cursor的当前条件首屏，保留filename/uploader/tag/date/album/favorites及URL，不退回timeline。旧Timeline卸载，Viewer随页清理；恢复后新页面按新cursor继续。首屏错误仅显示错误与显式“重新查找”，不会递归触发自动恢复。
- 新分支位于已有 alive/aborted 检查之后。筛选/actor变更卸载旧Timeline并abort分页；父首屏请求仍校验alive、abort与generation。旧分页400和迟到首屏成功/失败不能跨身份/条件调用有效恢复或回填旧页面。既有迟到响应、actor切换与401浏览器用例同轮通过。

原复核独立合成探针使用了 nested error 形状，它不是实际 API 错误合同。此次核对实际 flat schema/route，并用实际合同重新验收；修复保留对 nested/generic400 的普通失败行为是正确的。没有要求实现仅为旧探针接受非合同响应。原报告/证据保留，不改写历史结论。

## 独立执行与证据

独立核对 8 个fix source/test/doc、12 个fix证据、18个未受影响batch文件、2个保留局部指令及17个原batch证据哈希；开始和收尾均匹配。原NEEDS_FIX报告字节保持不变。实际功能修复只涉及 gallery-client、Timeline 两个文件；测试/交接文档变更符合范围。

本次 fresh 重跑，证据位于 `.cache/phase8-nls-r1-closure/`：

| 范围                                                     | 结果                     | 证据                                    |
| -------------------------------------------------------- | ------------------------ | --------------------------------------- |
| gallery-client、SearchGallery生产组件浏览器、gallery回归 | 3 files / 33 PASS，skip0 | `tests.log`                             |
| 完整非地点真实HTTPS及NLS-R1旧游标恢复                    | 1 PASS，skip0/retries0   | `https.log`、`https-status.json`        |
| DEV/临时root/端口与原证据保留                            | PASS                     | `cleanup.json`、`closure-evidence.json` |

browser16项包含新增5项：旧v1、v2错误scope均清旧页/Viewer且仅恢复当前条件首屏；恢复得到新cursor后继续分页；首屏再次400后停止自动请求；generic400/503仍保留重试。恢复请求与原首屏query严格相等，未遗漏任何筛选。旧cursor只发送一次。

fresh HTTPS 测试仅向真实成功DTO注入旧v1 cursor；下一次400 INVALID_REQUEST及恢复200均由实际API、HTTPS Cookie和当前全组filters返回。打开的Viewer在400后关闭，search请求恰为初页/旧cursor/同条件无cursor恢复3次。恢复首屏仍保留正确结果和输入。故障注入使用专属合成数据，没有把此场景称为自然生产升级验证。

实际Next/API日志检查通过，SSR/分页/无效query/旧cursor均未进入原始日志；startup与stderr确实捕获。本次未改代理，沿用前轮失败日志复核，不再重开无关问题。

独立fresh34项与实现方34项/此前135和136存在重叠，不累计为新增总数。format/lint/Web typecheck/build 的原日志及hash已核对，本轮没有重新运行全仓门禁或未受影响的MySQL搜索/10k性能矩阵。直接diff check通过。

## 清理、checkpoint和停止

独立只读DEV检查：MySQL9.7.2、non-root、8项迁移，23业务表全部0。fresh专属HTTPS root已删除，3443/4400/3544/45999均无监听；原fix回执/日志和next-env按字节恢复。未读真实媒体/个人文件、未改ACL或existing storage root，仅写本closure与ignored合成证据。

最后已读额度codex weekly used79%，reset时间戳仍1791340206，未确认发生更早重置或耗尽；未用重置卡或额外付费。本轮19:10 UTC前收口，早于20:00硬停止。

批次可更新为 `NONLOCATION_SEARCH_REVIEW_PASS_NLS_R1_CLOSED`；**当前已批准非地点批次没有剩余复核blocker**。Checkpoint落地仍需协调方按用户Git授权选择文件并更新状态，本复核不自动commit/push。既有PERF-E1/P3保持非阻塞待办，不触发新审查轮次。地图/GPS、其他Phase8工作和Production验证不在本次范围，整个Phase8仍未完成。

```text
NLS_R1: CLOSED
NLS_R1_INDEPENDENT_CLOSURE: PASS
NONLOCATION_SEARCH_REQUIRED_FIX_REMAINING: NONE
NONBLOCKING_BACKLOG: PERF_E1_P3_DATE_DEEP_EVIDENCE
FRESH_TARGETED_TESTS: 34_PASS_SKIP0
IMPLEMENTATION_MODIFIED_BY_REVIEW: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
