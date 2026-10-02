# Phase 7D — 独立实现审查

日期：2026-10-02。基线和审查时 HEAD 均为 `b1764a16cec571be43a525a36559acd644e05324`。审查对象是该基线之上的未提交 7D 实现，包括新文件；读取了根 AGENTS、Web 本地 AGENTS/CLAUDE、7D 设计、实施报告、真实 diff 和相关服务端授权源码。项目 `.agents/skills` 不存在。没有使用 Bridge、个人记忆、外部资料或项目外业务文件。

**当前结论：PASS（F1/F2 targeted closure）。原 F1 P1、F2 P2 均 CLOSED；未发现具体直接回归，可作为 7D 限定 checkpoint 的独立审查依据。Phase 7 milestone full gate 尚未执行，不能宣告 Phase 7 或 Production 完成。** 初审 NEEDS_FIX 与复现证据保留于下文历史记录，最新 closure 见文末。 本任务只报告问题，没有修改实施文件或生产代码，没有 stage/commit/push，没有读取真实媒体、运行真实用户数据 purge 或访问 Production。原有未跟踪 Web AGENTS/CLAUDE 保留。未授权或进入下一 Phase。

## F1 — P1：最终确认未先验证页面 actor，旧确认可以由新账号提交（初审历史；现 CLOSED）

准确位置：`apps/web/components/gallery/trash-panel.tsx:224–235`；同因位置：`apps/web/components/gallery/trash-action.tsx:90–104`，`apps/web/components/gallery/viewer.tsx:122–124`。

`TrashPanel.ask` 会核对 `/auth/me`，但最终 `confirm` 不再核对身份，直接以 `credentials: same-origin` POST。成功之后 `refresh` 才调用 `checkIdentity`，因此发现账号变化时永久删除请求可能已经被接受。`visibilitychange` 只在页面变为可见时检查，不能涵盖可见页面上 Cookie 被另一个登录窗口或程序更新的情况。`TrashAction` 完全没有页面 userId/actor 核对，Viewer key 也只有 family/album/media；身份变化但媒体可见时旧确认仍保留。

可复现步骤：

1. A 在可见页面打开 READY 媒体的最终永久删除确认（或 Viewer Trash 确认）。
2. 保持页面可见，不触发 visibilitychange，将当前共享 Cookie 登录切换为 B；B 也具有该家庭/媒体的相应权限。后续 `/auth/me` 已返回 B。
3. 在旧页面按最终确认。客户端先提交一次 POST；服务端按请求携带的当前 Cookie 将 actor 识别为 B。回收站仅在成功后的 GET 才发现 B 与页面 userId 不同并清空。

纯 mock Chrome 组件复现：页面 userId=`7`，确认后 `/me` 当前 actor 改为 `8`。永久删除 POST=1，identity GET 从确认前 2 次增至 POST 后 3 次，清空发生在 POST 之后；Viewer Trash POST=1，identity GET=0。源码确认现有 API 对每次请求重新 authenticate，而 POST 使用当前浏览器 Cookie。

影响：跨账号复用旧页面的破坏性确认，与已批准的 actor/family 变化清空要求不符；有合法删除权限的 B 可能承接 A 打开的旧确认。**这不是服务端 ACL 越权**：B 无权限时旧 API 仍会拒绝，角色也没有绕过 placement ACL。问题是本次确认所属 actor 与提交 actor 不一致，且发现变化晚于不可逆请求。

最小修复：在最终 mutation 之前、同步重复点击锁内调用页面身份 guard；不同 userId/失去家庭 membership/401 时先清空确认与敏感状态并停止 POST。将原已认证 userId/身份 guard 接入 Viewer/TrashAction，在身份重核和组件 key 中包含 actor，确认期间身份变化废弃旧确认；异步回调也须忽略已失效页面身份。保留现有 wire contract、server authority、revision CAS 和 reauth 第二次确认，不修改权限/schema/auth 模型。此处只能缩小客户端身份变化窗口，不能把 GET 当作绑定未来 Cookie 的服务器授权票据。

修复验收：账号在 ask 前、ask 后 confirm 前、pending 期间变化；有/无同家庭权限的 B；同 user 的正常 reauth rotation。提交前已观察到的 actor 不匹配必须 POST=0、旧详情/卡片/确认清空；已 dispatch 的 pending POST 不能撤销，身份变化时必须隔离其迟到 UI 回调。正常 reauth 仍需要第二次明确确认。最终服务端授权照旧。

## F2 — P2：aria-modal 确认框没有实际隔离背景，busy 时焦点逃逸（初审历史；现 CLOSED）

准确位置：`apps/web/components/gallery/lifecycle-dialog.tsx:24–49`；相关位置：`apps/web/app/styles.css:920–929`、`apps/web/components/gallery/trash-panel.tsx:348–352`。

确认框是普通 fixed section，`aria-modal=true` 不会使背景 inert；覆盖全屏的 box-shadow 也没有命中区域。背景按钮在 choice 非空时仍可用。因此弹窗可见时，鼠标点击其外侧的“恢复”会触发 `ask`，把现有永久删除确认替换为恢复确认。pending 后 Cancel/Confirm 均 disabled，焦点 trap 找不到任何可聚焦节点，既没有可聚焦容器兜底，也没有在焦点脱离后捕获；Tab 能跳到背景导航。

Chrome 纯 mock 复现：永久删除确认打开时，背景“恢复”按钮中心的 `elementFromPoint` 仍命中 BUTTON；实际点击后 dialog 从“永久删除确认”变成“恢复媒体”，POST=0。挂起永久删除 POST 时按 Tab，activeElement 为背景 `A#outside`，`closest('[role=dialog]')=null`。

影响：键盘/辅助技术体验不符合声明的 modal 行为；确认目标/操作可在背景点击中被替换；pending 用户可导航离开未确定操作。此次未观察到重复 POST，也不把离开后卡片不保留这一明确设计限制重新列为问题。

最小修复：使用真正 modal 的原生 dialog/showModal，或完整 backdrop + 背景 inert + dialog 焦点管理；busy 时提供可聚焦容器兜底，阻止 Tab 逃逸；choice 存在时阻止背景 ask 改写它，保留显式 Cancel 与提交后的未知结果流程。增加 pending Tab/Shift+Tab、框外点击、多目标确认及 reauth 第二次确认焦点用例。

## 已核对且未发现新增缺陷的边界

- 新 canTrash 与原 7B all-live-placement 有效 delete 谓词一致：owner 或 can_delete 且 FAMILY 可见/can_view；ADMIN/SUPER_ADMIN 不 bypass，deleted album 不阻塞。隐藏 placement 只投影 boolean，无身份或数量返回。
- 私有 detail 保留 decimal uint64 revision 精度，最大值 fail closed；公共 DTO 没有这些新字段。
- Trash 四态资格以同事务 DB 时间判定，权限/角色/revision 优先，30 天和 recent-auth 年龄负数/15 分钟边界不变；原 mutation 最终重授权与 CAS 未改变。
- reauth 成功只刷新再展示第二次明确确认，没有自动永久删除；密码提交时清空，没有新增持久化/日志。一般 403 没有自动密码循环。
- mutation 无自动重发；400、5xx、网络失败、无效成功 body 保守 unknown；409 废弃旧确认并 GET。unknown 下必须正面读取和重新明确确认；列表缺席/status404 不证明成功。
- 202 卡片独立于列表；DONE + COMPLETED + completedAt 才显示完成，FILES_REMOVED 不是完成；手动 GET 采用 readLock 串行。无 trashed 媒体 URL/byte 请求功能、路径/EXIF/GPS/驱动错误投影。
- 实际 diff 没有 schema/migration、30 天 retention、15 分钟 recent-auth、serving、7C worker/scheduler/storage/native 改动。

这些是本次限定检查结论，不是全仓或 Production 安全证明。

## 本次实际验证与限制

| 检查                                              | 本次结果                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| 定向 unit/API：实施报告所列 8 文件                | 151/151 PASS，skip 0                                                              |
| DEV MySQL `phase7b-trash-lifecycle.test.ts -t 7D` | 2 PASS，19 个明确按 filter 排除；不当作全文件 PASS                                |
| DEV MySQL 同文件不带 filter 重跑                  | 21/21 PASS，skip 0；包含新增投影和既有权限/CAS/serving/fencing 回归，无物理 purge |
| Chrome 独立组件 synthetic/mock 诊断               | 4 个复現场景完成，确认 F1/F2；这是缺陷证据，不是验收 PASS                         |
| `git diff --check`                                | PASS                                                                              |

Unit/API 实际命令：

```sh
pnpm exec vitest run --config vitest.config.ts apps/web/lib/trash-client.test.ts packages/db/src/trash-eligibility.test.ts apps/web/components/gallery/gallery.test.ts apps/api/src/albums/gallery-routes.test.ts apps/api/src/albums/service.test.ts apps/web/lib/gallery-client.test.ts apps/web/lib/gallery-server.test.ts apps/api/src/shares/public-service.test.ts
pnpm exec vitest run --config vitest.config.ts tests/integration/phase7b-trash-lifecycle.test.ts
node test-results/phase7d-review/run.mjs
```

诊断 harness、最终输出保留在 ignored `test-results/phase7d-review/{entry.tsx,run.mjs,results.json}`。它用项目现有 React/组件/CSS，经现有 esbuild 打包，在独立 headless Chrome 中由本地 route 拦截页面和全部业务 API。没有启动 API/worker/Next 服务或发送真实 mutation；actor 切换是 `/me`/mock actor 的模拟，不声称本次完成了真实跨 Cookie 账号切换或后端越权复现。源码的 current-cookie authenticate 控制流提供补充证据。

初始 DEV TCP 连接被 workspace sandbox 的 EPERM 阻止；经自动批准的仅 DEV synthetic 定向命令成功后才记 PASS。Chrome 同样需要批准启动。诊断初稿曾因非 secure context、等待已被身份清理的卡片、strict detail fixture 缺 preview 超时，已修正 harness 并以最终完整四场景输出为证据；这些初稿失败不记通过。没有限额/额度耗尽事件，没有重置或付费操作。

实施报告的 3 文件/42 integration、HTTPS Web 9/9、typecheck/build/lint/format 属于原实施证据；本次未独立复跑全部上述项目，不将它们转记为本次 PASS。未执行 full milestone gate、7C crash/物理 purge 全套、真实 power-loss 或 Production 验证。

## 初审 Checkpoint 与后续 gate（历史；由下方 closure 覆盖）

F1 修复及独立 blocker re-review 前不建议 checkpoint。F2 应随这次确认流修复并做键盘/背景点击复核；无需为了这两个客户端问题重设计服务端权限或 purge。修复后先运行受影响 unit/UI tests 与相关 typecheck/lint/format，再做限定独立复核。只有协调方进入 Phase 7 milestone closure 时运行项目完整 Quality Gate：format、lint、typecheck、unit/API、真实 DEV integration/races、build、API/Web E2E；不能以 7D targeted PASS 替代。若 Phase 7 closure 要求 7C native/crash gate，仍按其已批准清单执行 synthetic 验证。现有 Production deferrals 和明确产品限制保持，不据此进入 Production 或新 Phase。

```text
PHASE_07D_INDEPENDENT_REVIEW_PASS: NO
OPEN_P0: 0
OPEN_P1: 1
OPEN_P2: 1
PHASE_07D_READY_FOR_CHECKPOINT: NO (fix and blocker re-review required)
MILESTONE_FULL_GATE_THIS_REVIEW: NOT_RUN
PRODUCTION_READY: NO
PRODUCTION_CODE_CHANGED_BY_REVIEW: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

## F1/F2 targeted closure — 2026-10-02

本轮只复核原 findings 和修复直接影响；读取实施文档新增 remediation 记录、真实修复源码、SSR actor props/key 接线、原生 modal、checked-in synthetic host 与 browser 回归，没有重启全仓审计。基线/HEAD 仍为 `b1764a16cec571be43a525a36559acd644e05324`，实现仍未提交。下列当前结论覆盖上方初审历史的 OPEN/NEEDS_FIX/checkpoint NO。

### F1 — CLOSED

- `trash-panel.tsx:228` 的最终确认在同步锁内先 `checkIdentity`，观察到 401、不同 userId 或 family membership 丢失即失效、清空并停止 POST；reauth 同样在 POST 前核对，并在成功后刷新，再由用户第二次明确确认。
- `trash-action.tsx:79/117` 在读详情/打开确认、最终 POST 前核对 actor；详情成功返回后再次核对。`trash-client.ts:150` 用 strict `/auth/me` 结果比较页面原始 userId 与 family membership，没有自行生成授权票据。
- SSR Home/AlbumDetail 将认证 userId 传入 Timeline/AlbumDetail/Viewer/TrashAction；父页及 Viewer session key 包含 userId，组件卸载/失效后回调通过 alive/invalidIdentity 检查。观察到身份变化后旧详情、列表、选择和尝试清空。
- mutation 成功和失败迟到时均重核 actor。18 项 browser 回归中的提交前账号切换/401/membership 丢失均为 POST=0；成功/失败 pending 的 mutation dispatch 使用 promise 屏障，变化发生于 dispatch 之后，POST=1 且不展示迟到成功、未知状态或状态卡。这与“已发 POST 不可撤销”一致。

本轮没有复现原“确认前 actor 已改变但完全不检查便发 POST”的缺陷。**身份 GET 不能原子绑定后续 Cookie，检查成功之后到请求实际发送之间仍存在窗口**；服务端继续按实际 Cookie/session/ACL/retention/revision 授权。此限制不是忽略旧 bug 的免责声明：原 bug 所要求的提交前检查已实现并实测；本轮没有以该限制推导“客户端绝不会跨 actor 发出请求”，也不要求新增服务端 actor-bound ticket 或改变已批准 wire contract。pending 后清空 UI 不表示服务端撤销或 purge 失败。

### F2 — CLOSED

`lifecycle-dialog.tsx:14` 使用原生 `dialog.showModal()` 和真实 top-layer/backdrop；组件 choice 非空时背景 ask 也拒绝重写。`tabIndex=-1` 为 busy 提供容器焦点，focusin 约束与 Tab/Shift+Tab 兜底覆盖无可聚焦按钮状态，native cancel 事件在 busy 时阻止关闭。真实 Chrome 回归已确认：框外第二目标“恢复”坐标命中 DIALOG，点击不改变原目标/操作；pending 连续 Tab/Shift+Tab 焦点保持 DIALOG，Escape 不关闭、不产生额外 POST；same-user reauth 后第二次确认保持 modal 内焦点且 POST 仍为0直至显式确认。

没有发现该修复造成的具体直接功能/安全回归。这个判断限定在 actor guard、mutation 未知/迟到结果、props/key 和 modal 控制流，不是新一轮全仓安全复核。

### 本轮独立执行证据

| 检查                                                 | 本轮结果                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| 6 个直接相关 unit/browser 文件                       | 58/58 PASS，skip 0；包括 checked-in 18 项 Chrome synthetic/mock 回归 |
| Web typecheck                                        | PASS                                                                 |
| 修复源文件、browser test、synthetic host 定向 ESLint | PASS，max-warnings=0                                                 |
| 同范围 Prettier                                      | PASS                                                                 |
| `git diff --check`                                   | PASS                                                                 |

实际测试命令：

```sh
pnpm exec vitest run --config vitest.config.ts apps/web/components/gallery/lifecycle-browser.test.ts apps/web/lib/trash-client.test.ts apps/web/components/gallery/gallery.test.ts apps/web/components/gallery/share.test.ts apps/web/lib/gallery-client.test.ts apps/web/lib/gallery-server.test.ts
pnpm --filter @family-album/web typecheck
```

browser 以现有 Chrome 运行，全部页面/业务 API 被 synthetic route 拦截，不启动真实 API、Next 或 worker，不读真实媒体、不发送真实 lifecycle/purge。启动 Chrome 的定向命令经自动批准执行；本轮没有测试失败或额度耗尽，没有重置卡/额外付费。Web AGENTS/CLAUDE SHA-256 与初审记录相同，保留未跟踪状态。只更新此审查文档，生产代码、实施文档、checked-in tests 均未由本审查修改。

实施任务报告的 10 文件/175 测试、HTTPS Web 9/9、Web build 为实施方证据；本轮独立执行的就是上表6文件58测试和静态检查，不转记更大范围结果。SSR actor 接线已源码核对并通过 Web typecheck；本轮没有新跑真实跨 Cookie 账号切换、HTTPS Web E2E、DB/native/7C crash/full gate。上轮独立 DEV lifecycle 21/21 只保留为上轮证据，修复没有改变其 DB 授权投影。

### 当前 checkpoint 与剩余 gate

原两项 findings 均关闭，**7D 限定 checkpoint 审查条件已满足**。若协调方按现有授权执行 checkpoint，须仍仅纳入本次审查范围及必要 tests/docs，排除未跟踪 Web AGENTS/CLAUDE 和 ignored 诊断产物；有新的功能/测试改动需按影响补验证。本结论不执行或替代 stage/commit/push 授权。

**Phase 7 milestone 完成仍需 full Quality Gate**：format、lint、typecheck、unit/API、真实 DEV integration/race、build、API/Web E2E，以及 Phase 7 closure 清单要求的 synthetic native/crash/fault-injection 验证与最终安全复核。原 7C 的历史 full gate 不能覆盖未提交7D增量，targeted closure 也不能替代 milestone gate。保持 Production deferrals、原始媒体/serving/权限/schema/15min recent-auth/30d retention/purge 不变量；不得据此宣布 Production ready、真实 purge 合格或进入下一 Phase。

```text
PHASE_07D_INDEPENDENT_REVIEW_PASS: YES (bounded implementation + F1/F2 closure)
PHASE_07D_F1_STATUS: CLOSED
PHASE_07D_F2_STATUS: CLOSED
NEW_DIRECT_REGRESSION_FINDINGS: 0
OPEN_P0: 0
OPEN_P1: 0
OPEN_P2_FROM_THIS_REVIEW: 0
PHASE_07D_READY_FOR_CHECKPOINT: YES (review condition only; no Git write performed)
MILESTONE_FULL_GATE_THIS_REVIEW: NOT_RUN
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
PRODUCTION_CODE_CHANGED_BY_REVIEW: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```
