# Phase 7D — Trash UI 安全设计与实施 handoff

日期：2026-10-02。设计基线：`b1764a16cec571be43a525a36559acd644e05324`（7C 本地 checkpoint，未 push）。本文件是限定范围 R3-DESIGN 结果，供 GPT-6.1 Sol / Medium 实施、Sol / High 独立审查；实施中改变下述不变量须返回 Astra。用户已授权继续此限定项目工作，无需因旧报告的“7D 尚未授权”历史标记再次询问。

本次只读核验源码并写此文档，没有修改生产代码、运行真实 purge、读取真实媒体、读个人记忆、访问 Production、执行 Git 写操作或执行测试。7B/7C 文档顶部完成与 closure 记录覆盖其后历史 STOP；这里不重开已关闭的 7C 问题，也不把历史测试记成本次验证。

## 1. 设计结论与边界

采用单条操作的 Web Trash 页面、私有查看器的“移入回收站”、恢复、到期后永久删除请求和本次请求状态卡。复用已批准的服务端 mutation/status 接口。仅新增私有详情的 revision/canTrash，以及 Trash 条目的永久删除资格枚举；不扩展公共 DTO，不为所有网格增加权限计算，不新增生命周期查询或 operation 查询接口。

保持：30 天保留期、DB 服务端时间、15 分钟 recent-auth（年龄必须 >=0 且 <15 分钟）、ADMIN/SUPER_ADMIN 手动永久删除、每个 live placement 的有效删除权限、选中可见 placement 的 Trash discovery、服务端最终复核、revision CAS、operation audit、L/R 锁及事务顺序、未知 COMMIT 不自动重放、7C 异步执行和恢复。角色永不绕过 placement ACL。

不新增 trashed thumbnail/preview/original serving；Trash 用类型图标和已有日期/ID，不展示残留缓存图片。不修改 schema、migration、worker、purge scheduler、storage/native、retention、public share 或 auth/session 模型。不做批量删除、“清空回收站”、撤销 purge、强制重试 BLOCKED、倒计时自动删除、跨重载任务历史或生产部署。

## 2. 已核实源码证据

| 位置                                                                       | 当前事实及影响                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/trash.ts`                                          | Trash body 为 selectedAlbumId + expectedLifecycleRevision + operationId；Restore/Permanent delete 不含 selectedAlbumId。revision 为十进制 uint64 字符串。Trash item 仅 canRestore，无缩略图。                |
| `packages/contracts/src/gallery.ts`                                        | 私有详情缺 lifecycleRevision/canTrash；mediaCommentSchema.canDelete 属于评论，不能用于媒体；公共 item 是私有 item 的基础，新增字段必须只落私有详情。                                                         |
| `packages/db/src/album-repository.ts:getAlbumMedia / mutateMediaState`     | 私有详情已在 family-first 当前 session/可见 selected placement 范围读取；能力目前仅管理精选、标签、备注、评论、下载。                                                                                        |
| `packages/db/src/trash-repository.ts:list / lockScope`                     | list 先按可见 live placement 过滤再 LIMIT，排除 purge_intent_id 非空；canRestore 是所有 live placement 有效 delete 的聚合，不泄露隐藏相册。lockScope 重新锁定并复核角色、session、当前权限、revision/audit。 |
| `packages/db/src/trash-repository.ts:requestPermanentDelete / purgeStatus` | 请求 CAS 递增 revision、写 intent/link/audit；到期由服务端判断。status 只允许当前 ADMIN/SUPER_ADMIN 查询自己 MANUAL 请求；404 不能证明未提交，scheduler 请求也不可经此接口查询。                             |
| `apps/api/src/trash/routes.ts`                                             | Trash/Restore 返回 200 lifecycle；永久删除返回 202 operationId；status GET 返回进度。所有响应 no-store；mutation 现有 Web cookie + trusted JSON origin。错误 body 只有安全 code/requestId。                  |
| `apps/api/src/trash/service.ts:safe / permanentDelete`                     | COMMIT_OUTCOME_UNKNOWN 只作内部 detail，route 不透出。永久删除已有只读确认路径，不能增加 POST 自动重放。客户端无法将普通 503 与未知提交区分。                                                                |
| `packages/db/src/media-lifecycle.ts`、7B summary                           | 普通媒体 serving/read 过滤 ACTIVE（trashed_at 和 purge_intent_id 均空）。禁止以 UI 需求放宽。                                                                                                                |
| `apps/api/src/auth/routes.ts:/auth/reauth`                                 | body `{password}`，成功 204，Set-Cookie 轮换；无 JSON token 响应。                                                                                                                                           |
| `apps/web/lib/gallery-client.ts`                                           | GET/send no-store + same-origin，send 已有 204 处理；网络错误/无效成功 body 都归 UNAVAILABLE，无法据此认定 mutation 没发生。                                                                                 |
| `apps/web/lib/gallery-placement.ts`                                        | 移除相册关系仍保留媒体及其他相册；必须保留旧行为，Trash 是不同的家庭媒体生命周期操作。                                                                                                                       |

## 3. 最小 API/DTO 补充

### 3.1 仅私有详情

在 `galleryMediaDetailSchema` 增加必填 `lifecycleRevision: unsignedBigIntStringSchema`，在 `privateMediaCapabilitiesSchema` 增加必填 `canTrash: boolean`。同步 DB 私有 detail record、service 白名单投影和严格契约 fixtures；不增加到 galleryMediaItem/publicGalleryMediaItem、family timeline 或 public response。

`canTrash` 的含义：当前已授权、ACTIVE 的 selected placement 详情中，对同 family/media 的每个未删除相册 placement 都具有有效 delete，且 revision 可递增。有效 delete 精确复用 7B 谓词：相册 owner，或 grant.can_delete=1 且（FAMILY 可见或 grant.can_view=1）。不能只看选中相册，不能根据 ADMIN/SUPER_ADMIN 推断，不能用 comments.canDelete 或 canEdit。

在现有 getAlbumMedia 事务内，通过固定 SQL 的相关 NOT EXISTS 聚合查询和 CAST revision AS CHAR 取得提示；只返回 boolean，不返回 placement identities/counts 或拒绝细节。保留已有 family-first 锁顺序，不为了提示引入全 placement 写锁、调用 mutation preflight 或添加 OS 锁。该提示允许随后的权限变化使其过期；最终权限仍只由原 mutation 决定。

网格不直接支持 Trash。先打开私有详情并获取新 DTO；来自 timeline 使用其已返回的 albumId，来自 album view 使用该路由 albumId，二者就是后续 selectedAlbumId。禁止猜测另一个相册或客户端搜索“更有权限”的相册来绕过 discovery。

### 3.2 Trash 条目能力

保留 canRestore，在其同一 strict capabilities 对象增加唯一必填字段：

```ts
permanentDeleteEligibility:
  | "NOT_ALLOWED"
  | "RETENTION_PENDING"
  | "REAUTH_REQUIRED"
  | "READY";
```

它是服务端提示，不是授权票据。按以下优先级在现有 list 事务内计算：

1. 当前 actor 非 ADMIN/SUPER_ADMIN，或 canRestore 的 all-live-placement delete 聚合为 false，或 revision 已是 uint64 最大值：NOT_ALLOWED。
2. 当前 DB 时间早于 purgeAfter：RETENTION_PENDING。
3. 当前 session.authenticatedAt 的年龄 <0 或 >=15 分钟：REAUTH_REQUIRED。
4. 其余 READY。

list 已限制可见、trashed、无 intent；保留其原 SQL 可见性与分页顺序。复用已有 lockFamily/lockActor/assertActor/readServerTime，保存当前事务的 DB now 用于判定，不能用应用 Date.now 或浏览器时钟。这里无需向客户端新增 serverNow/session 时间；purgeAfter 仅用于展示，跨越日期后客户端须 GET 刷新才能启用按钮。canRestore 在 revision 最大值时也保守返回 false，避免提示不可执行操作；不改变 mutation 溢出拒绝逻辑。

NOT_ALLOWED 只展示“当前不可永久删除”，不解释任何隐藏 placement。RETENTION_PENDING 展示“保留期未结束，可在所示时间之后刷新”；REAUTH_REQUIRED 展示“验证身份后永久删除”；READY 展示“永久删除”。同一次返回中权限/日期/recent-auth 提示一致，但任何提示都不是提交成功保证。缺失/无效新字段须 fail closed，不以本地默认 true 补齐。

本次不新增状态/错误码，不暴露 COMMIT 内部 detail，不扩展 purgeStatus 可见范围，也不暴露 scheduled intent ID。

兼容范围：现有 mutation 请求/响应和 status wire contract 不变；新增私有读取字段是同仓 API/Web/fixtures 同步更新的契约增量。旧客户端的 `.strict()` 会拒绝额外字段，因此不能声称新响应与旧 Web 二进制滚动兼容。DEV 同步构建/重启后验证；不把新字段做可选并默认授权，不把它们塞进公共基础 schema。独立旧客户端或分批生产部署兼容不在本次范围，若确有此需求先由协调方确定版本协商范围。

## 4. 页面与操作流程

### 4.1 入口、内容和图片

Web 现有 GalleryShell 增加回收站导航与 active 状态，页面使用当前认证家庭上下文和原有 SSR/no-store 模式；家庭 ID 不采用任意输入。沿用暖白、绿色、圆角、留白样式及现有可访问 dialog/error/live-region 习惯。

Trash 分页按原 nextCursor 获取，初始空页、加载失败、更多加载失败独立呈现。权限变化/操作后从第一页刷新并丢弃旧 cursor；按 mediaId 去重，不将分页缺席解释为已删除。行仅类型图标、timelineKey、trashedAt、purgeAfter、短 ID 和操作；不取路径、文件名、EXIF/GPS 或图片 URL。回收站页面不得发起任何媒体字节请求，不把从 gallery 带来的 data/blob/cache 图片带入。

### 4.2 移入回收站

查看器显示独立“移入回收站”，与“从此相册移除”分开。只有新私有详情 canTrash 为 true 才可确认；确认文案说明该媒体将从所有相册和普通浏览中隐藏，默认保留 30 天，期间可恢复；不承诺用户一直有恢复权限。不得改变 remove-placement 的既有保留媒体语义。

打开确认时刷新选中详情；捕获 familyId/mediaId/selectedAlbumId/revision，不得在 dialog 内切换目标。确认一次生成 crypto.randomUUID() operationId，冻结本次 payload，禁用重复点击，POST 现有 Trash route。200 且严格响应匹配 mediaId、state=TRASHED 和预期 revision+1 才显示已移入回收站。关闭查看器、清除该媒体相关客户端显示状态并刷新当前列表；不依赖跨页缓存继续显示原图。相册关系和 favorite/tag/note/comment 不由客户端删除。

### 4.3 恢复

仅 canRestore 可点击，一次明确点击发送已有 restore payload，不加 selectedAlbumId。成功必须为该 media 的 ACTIVE、revision+1；移除当前 Trash 行并刷新第一页，提示已恢复。恢复保留的关系由服务端负责，不逐相册重建。到期不等于 UI 必须禁用恢复：只要尚无 purge intent，原 Restore 接口仍可与 scheduler 竞争；服务端决定胜者。

### 4.4 永久删除和 reauth

先展示警示确认：“请求接受后无法恢复；后台处理，完成时间不确定”。可要求勾选明确确认，不以安全擦除或立即释放空间作承诺。

REAUTH_REQUIRED 时用户主动输入密码，POST 既有 `/api/v1/auth/reauth`；正确处理 204/Set-Cookie，使用 same-origin，密码仅在短暂组件内存，成功/失败/取消/卸载清除，禁止 URL/storage/log/telemetry。禁止读取 HttpOnly cookie、复制 token 或自建 recent-auth 判定。可复用 browserGallerySend 的 204 分支及接受 undefined 的 schema，不直接将空 body 交给 JSON parser。

reauth 成功后只做 GET 刷新 Trash 第一页及用户加载的必要后续页；找到同目标且资格 READY 才进入最终确认，展示当前 revision 和日期所代表的最新对象。没找到则停止，提示状态或权限已变化；不自动 POST，不自动全量扫描。用户完成第二次明确确认后，生成 operationId 并发送当前 revision 的永久删除请求。即使初始为 READY，也必须有最终不可逆确认。reauth 后 session 轮换产生的旧请求 401 不触发自动登录/POST 重放。

202 验证返回 operationId 与本次完全相同后，显示“永久删除请求已接受，等待后台处理”，移除旧 Trash 行并刷新；状态卡独立于 Trash 数据列表，不能随该行消失而丢失。请求已被接受即不可 Restore，不提供取消或撤销按钮。

## 5. 前端状态机及不确定结果

每个当前目标一次 mutation；请求 pending 期间禁用该目标所有相反操作。只在用户确认时发送 POST；不在 effect、mount、focus、重连、重载、retry library 或 reauth 回调中自动提交。

```text
IDLE -> CONFIRMING -> [REAUTH -> REFRESH -> CONFIRMING] -> SUBMITTING
SUBMITTING -> CONFIRMED (Trash/Restore 的有效 200)
SUBMITTING -> ACCEPTED -> STATUS (永久删除的有效 202)
SUBMITTING -> REJECTED (确定的 401/403/404/409)
SUBMITTING -> OUTCOME_UNKNOWN (网络/超时/abort/5xx/异常2xx或body校验失败；400见下表)
OUTCOME_UNKNOWN -> READ_REFRESH / STATUS_GET -> observed current state or unresolved
```

mutation 的网络错误、503 和成功响应 JSON/字段校验失败统一显示“结果尚不能确认，请刷新状态；不要重复提交”。前端 abort 只结束等待，不能撤销服务端操作。保留冻结 payload/operationId 和目标（组件或页面级内存），不生成另一个 ID 自动 retry，也不原样自动 retry。保留旧页面内容只能作为待确认提示，不能继续启用旧 revision 按钮。

| 结果              | UI 行为                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400               | 无效请求/契约提示，停止且不重发。当前 route 的 ZodError 也可能来自 mutation 后的响应校验，故不能仅凭 400 证明未提交；按 unknown 保留尝试并只读刷新。 |
| 401               | 清除敏感页面状态，提示重新登录；不得自动重发。                                                                                                       |
| 403               | 泛化权限/身份验证提示，GET 刷新；不能将全部 403 当作 recent-auth 失效并循环要密码。                                                                  |
| 404               | 对象不可见或状态变化；关闭旧操作能力并刷新，不宣称已永久删除。                                                                                       |
| 409               | 状态/revision/到期/operation 冲突；丢弃旧确认和 revision，刷新；不得自增 revision 重试。                                                             |
| 5xx/网络/异常成功 | 未知结果；只读协调，不乐观显示失败或成功，不回滚成可重复提交状态。                                                                                   |
| GET 失败          | 状态读取失败，保留“最后已知/未确认”标记；可手动重试 GET，不影响 mutation 次数。                                                                      |

Trash/Restore 未知结果没有既有 operation 查询接口。刷新普通详情或 Trash 页只报告正面观察：“目前在回收站”或“目前可见”，不能据此断言该 operation 成功；列表中没找到、某页没有或 detail 404 都不证明终态。如果正面读取到了目标当前状态及 revision，可关闭旧尝试，用户重新打开确认、发起新的明确操作，使用最新 revision 和新 operationId；CAS 防止仍在完成的旧请求覆盖新状态。不对 unresolved 目标提供一键 mutation retry。

永久删除未知结果优先 GET 本次 operationId。返回记录即证实 intent 存在，转 STATUS；404 仍可能是尚未提交、权限变化、actor 不同等，保持未确认。若新 Trash 读取正面找到仍可操作的该对象，可以按上一段的“重新确认”启动新动作；不能仅因 status 404 启动。即使旧请求随后提交，新请求也受 revision/intent CAS 约束。禁止使用系统 scheduler 或其他 actor 的请求作成功推断。

## 6. 异步 purge 展示

复用 GET `/api/v1/families/:familyId/purge-requests/:operationId`。仅查询本页面实际提交或接收 202 的 ID，不枚举历史。对每个卡片按用户主动刷新或有限 GET 轮询读取：串行、无重叠，可用 2/5/10/20/30 秒间隔最多 5 次，随后停在“仍在后台处理，可刷新”。页面隐藏/卸载、401/403/404、BLOCKED/DONE 时停止。轮询次数限制仅客户端体验，不修改 worker retry。

| executionState / progress           | 可显示的结论                                                          |
| ----------------------------------- | --------------------------------------------------------------------- |
| QUEUED                              | 已请求，等待后台处理。                                                |
| RUNNING                             | 后台处理中；progress 只映射粗粒度阶段，无虚构百分比/ETA。             |
| RETRY_WAIT                          | 后台暂缓，将按服务端规则处理；不提供重新提交。                        |
| BLOCKED                             | 后台处理受阻，需要维护检查；不会退回可恢复状态，不暴露路径/底层错误。 |
| DONE + COMPLETED + completedAt 非空 | 永久删除流程完成；不宣称安全擦除、备份中消失或可即时核实空间回收。    |
| 组合异常/读取失败                   | 无法确认最新状态；不得显示完成。                                      |

REQUESTED/DETACHED/FILES_REMOVED 都不是 COMPLETED；只因 Trash 列表消失不能显示完成。failureCategory 可映射安全通用文案，不显示驱动/parser/文件系统原始错误。

限定 UI 用页面级内存保存本次 operation 卡，logout/actor/family 切换清空；不存 password/token 或媒体内容。刷新/离开页面后不承诺找回卡片，服务端任务继续，不会因此重发。跨重载跟踪/历史/系统 scheduled 状态是后续产品范围，不为此扩张当前 API 或本地长期标识存储。

## 7. 实施清单与验收

Sol 只实施以下 slice：

1. contracts 私有 detail 与 Trash capability；DB 只读聚合/资格投影；service 白名单；现有 API fixtures 同步。
2. Web 私有查看器单条 Trash、Trash 页面/分页/恢复、明确永久删除确认、既有 reauth 接线、独立操作状态卡。
3. typed client 错误/未知状态与无自动 POST retry，访问无效/不完整 DTO fail closed；扩展现有测试框架。
4. targeted 验证和独立 Sol High 审查，写实际 7D 结果，停止等待下一范围指示；不以 7D 完成宣布 Phase 7/Production 完成。

写 Web 前读取其本地 AGENTS 指令和所指项目内 Next 文档；保留当前未跟踪 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md`，不改内容、不带入提交。若本地技能引用缺失，仅检查项目 `.agents/skills`，不访问个人记忆或启动 Bridge。

最低验收（使用 synthetic fixtures，不能真实 purge）：

- 私有 detail revision 精确字符串（>2^53、uint64 边界），只读提示无隐藏 placement 泄露；public DTO 无新增字段。选中可见但另一个 hidden/live placement 不可删时 canTrash=false；ADMIN/SUPER_ADMIN 同样受限，deleted placement 不阻塞。
- Trash eligibility 角色 × all-placement 权限 × purgeAfter 前/等于/后 × recent-auth 年龄负数/零/<15m/等于15m/>15m；DB 时间控制，改变客户端时钟不能启用删除。revision 最大值 fail closed。资格字段不改变原 mutation 授权。
- stale canTrash/canRestore/READY 后权限撤回、session 过期、生命周期变化、scheduler intent 竞争仍由原 API 拒绝；新 UI 不绕过 409/404，不伪称完成。
- Trash/Restore 正常成功 payload 精确、selectedAlbumId 来源正确、旧 remove-placement 行为和文案保留；同一确认多次点击/React effect 不多发 POST。
- 204 reauth 成功、失败、取消及 cookie 轮换；验证后只刷新且必须再次确认。403 不自动密码循环；密码清理及无日志/持久化。
- pending 后网络断开/timeout/abort、503、无效 2xx body 均 unknown，mutation count 仍为1；永久删除 status 200/404/503 与跨页未找到处理正确。新操作只能基于正面最新状态和明确确认。
- 202 后列表消失但卡片留存；QUEUED/RUNNING/RETRY_WAIT/BLOCKED/DONE 显示正确；FILES_REMOVED 不显示完成；轮询上限/卸载停止/GET 不重叠/无 POST replay。
- Trash 页无 thumbnail/preview/original 请求，包括从 gallery 来的缓存图；原 serving 对 TRASHED 仍拒绝。登录/家庭切换不会展示前一个用户任务卡。
- Web 空/加载/失败/分页、键盘 dialog/focus、screen-reader 状态、移动窄屏；占位图不会误导为媒体预览。

运行影响到的 contracts/API/DB projection 和 Web client/UI tests、相关 lint/typecheck；真实 MySQL 用既有 DEV fixture 验证新增只读资格与 CAS/权限回归，不能因环境未加载 silently skip。7D UI E2E 的异步 purge 使用现有接口 mock/受控 intent fixture 验证状态，不启动真实物理 purge 或 7C crash 全套。只有协调方进入 milestone closure 时再按项目规则运行 full gate；本文件不是已执行测试证据。

## 8. 风险、剩余决策和完成标准

本限定 slice 没有必须由产品补答才能实施的业务决策：保留期不变、占位图、单条动作、有限状态卡都是既有能力上的保守 UI。以下能力不能由 Sol 擅自推导：立即永久删除（绕过30天）、Trash 图片可见性、批量清空、scheduled purge 历史、跨重载任务跟踪、撤销/重试 BLOCKED。如果协调方要求其中任何一项，需明确新增范围；涉及授权/storage/retention 的变更返回 Astra。

主要剩余风险是提示与提交之间自然竞态，以及没有通用 lifecycle operation 查询导致未知结果可能保持 unresolved。此设计选择如实展示并以 CAS 和服务端复核兜底，不增加新的授权面。7C exclusive-owner 部署限制仍可能使请求排队很久，UI 不承诺 ETA；7C 原生产资格 deferral 保持未关闭。

```text
PHASE_07D_DESIGN_READY_FOR_SOL: YES (this bounded design)
PHASE_07D_IMPLEMENTED: NO
SCHEMA_OR_MIGRATION_CHANGE_APPROVED: NO
TRASHED_SERVING_APPROVED: NO
PERMISSION_OR_RETENTION_RELAXATION_APPROVED: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```
