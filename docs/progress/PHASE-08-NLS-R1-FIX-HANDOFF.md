# Phase 8 — NLS-R1 最小修复与 closure 交接

2026-10-02 UTC。HEAD仍为 `ac39e49f9d7cdc8a8cbe7052deebd2d1958c2823`，本轮不commit/push。依据独立 `PHASE-08-NONLOCATION-SEARCH-REVIEW.md` 唯一当前P2 **NLS-R1**，落实搜索分页拒绝cursor后的当前条件首屏恢复。状态：**FIX_IMPLEMENTED_TARGETED_PASS / INDEPENDENT_CLOSURE_PASS_CLOSED**，没有由实现方改写原NEEDS_FIX报告。

## 最小变更

`apps/web/lib/gallery-client.ts` 在status400时解析既有严格 `authErrorResponseSchema`；只有真实API扁平 `{code,message,requestId}` 且code为INVALID_REQUEST才区分为GalleryClientError(INVALID_REQUEST)。非合同400/未知code/坏JSON仍UNAVAILABLE，其他status既有映射保留；不改API错误或cursor合同。复核探针采用nested error的合成形状，实际routes发送flat envelope，本次回归使用实际合同，不能只让探针形状通过而遗漏真实400。

`timeline.tsx` 仅搜索分页（有filters和onRefresh）的对应错误路径清空items、cursor、openIndex，再调用现有SearchGallery当前filters首屏refresh。父组件移除旧页/Viewer，用相同filters与limit24发无cursor请求；不退回timeline、不再发送旧cursor。首屏如果仍400/网络失败，只显示错误和显式“重新查找”，不会自动刷新循环。旧timeline及普通网络错误/其他400仍保留原手动重试行为；401/abort/alive/actor/filter隔离不变。

本轮功能source仅2个文件；3个测试文件为gallery-client.test、search-browser.test、authenticated-gallery.spec。本次不改DB/schema/权限/锁/Auth/native/旧root，不加功能或新安全设计，不引入包。测试证据另目录 `.cache/phase8-nls-r1/`，保留原batch/review的证据字节。

## Fresh验收

| 检查                                                | 最终结果                                                   | 专属证据                                               |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| gallery client＋生产组件browser＋gallery回归        | 3 files / 33 tests PASS，skip0；browser16项（原11＋新增5） | tests-final.log                                        |
| 完整非地点搜索真实HTTPS＋旧v1恢复                   | 1 PASS，retries0/skip0                                     | https.log、https-run.json、web-log-regression.json/log |
| 定向format/lint/Web typecheck/Web build/diff check  | PASS                                                       | format.log、lint.log、typecheck.log、build.log         |
| DEV清理、专属root删除、任务服务停止、旧证据保留检查 | PASS                                                       | cleanup.json、fix-evidence.json                        |

本轮34项是针对修复的重验集合，与原135/独立136重叠，不累计作新增总数；没有重跑全仓gate或未改DB的1万fixture矩阵。

新增browser：canonical旧version1及version2错误scope，保留filename/uploader/tag/date/album/favorites条件；已有page且Viewer打开，400后先清空、只重启一次原条件首屏，获得正常新cursor可继续分页；恢复首屏仍400时两请求后停止；generic400/503保留旧页与手动重试，无首屏自动请求。全部既有401/迟到响应/actor切换/收藏/Trash/URL/options用例同轮通过。client严格区分已知flat400，非合同/坏JSON/其他status不会触发恢复。

HTTPS仅在一次**真实成功响应**的nextCursor注入合成old-v1，后续pagination400及恢复200都由真实API、真实cookie、当前六维filters执行，未mock错误/恢复数据。用gate保留在途分页以打开Viewer；真实400确认code=INVALID_REQUEST，释放后Viewer关闭、当前首屏恢复、总search请求3（初页/旧cursor一次/无cursor恢复一次），新首屏无下一页。真实API与Next日志检查含此旧cursor、新filter交通均未出现私有query/cursor；startup与stderr确实捕获。该场景是合成故障注入，未称为自然存在旧服务或生产升级验收。

初次browser fixture的收藏detail=false触发原onDetail刷新，造成多一次首屏；将已收藏fixture同步为true后修正。中间断言误用了Playwright matcher而处于Vitest、以及一个nested错误mock未改为flat，已修正，最终33/33来自修正后的源码，失败日志保留，不弱化服务端或客户端guard。

清理仅own synthetic记录/root/进程；MySQL9.7.2 nonroot，migration8项，23业务表0。Next生成next-env恢复基线。原batch与review原证据哈希逐项核对，受影响源文件另作fix manifest；无关Web AGENTS/CLAUDE保留。当前环境无额度读取工具，未执行reset/付费或限额重试；前次独立复核最后已知78%不冒充本轮fresh读数。收尾早于20:00UTC。

## 一次closure范围

独立复核只需NLS-R1：实际400合同区分、搜索分页清空/当前filter首屏/单次恢复、失败不循环、401/迟到处理及上述真实HTTPS证据。`fix-evidence.json` 与 `fix-manifest.json` 保存fresh日志/source hash、旧证据保留及清理。原批次其余复核结论沿用，不重开功能设计。请由协调方安排一次closure；实现方未宣称CLOSED/PASS独立安全签核。

```text
NLS_R1_FIX: IMPLEMENTED
NLS_R1_TARGETED_VALIDATION: PASS
NLS_R1_INDEPENDENT_CLOSURE: PASS_CLOSED
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```

## 正式closure后状态

19:09用户授权checkpoint前，独立 `PHASE-08-NLS-R1-CLOSURE.md` 已确认PASS/CLOSED，无当前blocker。原NEEDS_FIX报告与本文件当时的待closure/不commit语境保留；现在仅限定本地提交获授权，不push。收尾见 `PHASE-08-NONLOCATION-CHECKPOINT.md`，不重跑全Phase8 gate或追加功能。
