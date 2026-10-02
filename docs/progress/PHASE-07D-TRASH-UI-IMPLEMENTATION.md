# Phase 7D — Trash UI implementation and review handoff

日期：2026-10-02。基线：`b1764a16cec571be43a525a36559acd644e05324`。实施依据：`PHASE-07D-TRASH-UI-DESIGN.md` 的 Astra 限定 handoff。初次 Sol High 独立审查为 NEEDS_FIX（F1 P1／F2 P2）；限定修复后的独立 targeted closure 已 PASS，F1/F2 均 CLOSED，详见 `PHASE-07D-INDEPENDENT-REVIEW.md` 文末。用户已授权本地限定 checkpoint，本文件随 `Complete Phase 7D trash UI`（this commit）记录；不 push，不宣布 Phase 7 或 Production 完成。

## Delivered scope

- 私有详情新增必填 decimal uint64 `lifecycleRevision`、`canTrash`。`getAlbumMedia` 在原事务中以固定相关 NOT EXISTS 查询全部 live placement 的有效删除权限；隐藏 placement 仅影响 boolean，角色不 bypass，deleted placement 不阻塞，最大 revision fail closed。公共／timeline／grid DTO 未添加这些字段。
- Trash capabilities 新增四态 `permanentDeleteEligibility`。同一 list 事务保存 `readServerTime` 的 now；角色、all-placement delete、revision 上限先于保留期，再检查 authenticatedAt 的负数及 15 分钟边界。canRestore 在最大 revision 时 false。没有改变 mutation authority。
- `/trash` 使用既有认证 SSR/no-store；列表仅类型、ID 和日期。分页去重；动作前从第一页刷新，必要时只读取此前已加载页数范围，丢弃旧 cursor。无缩略图／预览／Original URL 或字节请求。
- 私有 Viewer 独立“移入回收站”，打开确认时刷新 selected-album detail，冻结 revision/operationId，一次 POST；匹配 200 后关闭 Viewer、移除当前媒体显示、刷新列表。原“从相册移除”保留。pending/未知尝试期间阻止同目标相反操作；只读正面 ACTIVE 观察允许新的明确确认。401 清除 Viewer 和当前列表状态。
- Restore 单条明确确认，严格检查 media/state/revision+1，成功移除当前行并刷新。409 丢弃旧确认并 GET，不自增 revision 或自动重试。
- 永久删除有不可逆确认。REAUTH_REQUIRED 输入密码调用原 reauth；204/Set-Cookie 成功后只刷新，当前 READY 才显示第二次明确确认，绝不由 reauth 回调 POST。密码在提交时清空；失败／取消／组件卸载不保留，不写 URL/storage/log。
- 202 必须匹配 operationId；卡片独立于列表。采用设计允许的**用户主动串行 GET**，没有自动轮询、效果触发 POST、后台重新提交、跨重载存储或任务历史枚举。DONE 只有 COMPLETED 且 completedAt 非空才显示完成；FILES_REMOVED 不算完成。BLOCKED/DONE 停止进一步状态读取。
- 网络／5xx／400／无效成功 body 为 unknown，保留冻结尝试，禁用旧 revision 操作，仅允许 GET。status 404、列表缺席都不证明终态。正面读取到当前可操作目标后，允许重新打开确认；没有一键重试。actor/family key、当前 me 检查及 401 清空保护页面内卡片。

不变范围：schema/migration、15 分钟 recent-auth、30 天保留期、权限边界、media serving、7C worker/scheduler/storage/native 均未修改；不读取真实家庭媒体、不访问 Production、不启动物理 purge。7D 浏览器永久删除及生命周期响应是 mock，真实 API 仅用于认证、读取及既有 synthetic 回归。

## Actual validation

以下是本轮实际执行结果，不沿用 7C 外部报告：

| Check                              | Result                                                            |
| ---------------------------------- | ----------------------------------------------------------------- |
| Targeted unit/API                  | 8 files / 151 tests PASS，skip 0                                  |
| DEV MySQL selected integration     | 3 files / 42 tests PASS，skip 0                                   |
| HTTPS authenticated Web acceptance | 9/9 PASS，skip 0；新增 4 个 7D cases + 原 5 个回归                |
| Typecheck                          | contracts/db build 的 TypeScript 检查及 API/DB/Web typecheck PASS |
| Build                              | contracts、DB、API、Web PASS；`/trash` 为 dynamic route           |
| Targeted ESLint                    | changed TS/TSX source/test + 新 page，max-warnings=0 PASS         |
| Prettier                           | 本轮 affected files PASS                                          |
| Diff whitespace                    | `git diff --check` PASS                                           |

Unit/API 文件：`apps/web/lib/trash-client.test.ts`、`packages/db/src/trash-eligibility.test.ts`、`apps/web/components/gallery/gallery.test.ts`、`apps/api/src/albums/gallery-routes.test.ts`、`apps/api/src/albums/service.test.ts`、`apps/web/lib/gallery-client.test.ts`、`apps/web/lib/gallery-server.test.ts`、`apps/api/src/shares/public-service.test.ts`。

Integration 文件：`tests/integration/phase7b-trash-lifecycle.test.ts`（新增 2 个 7D read-only projection cases）、`phase6b-favorites-featured.test.ts`、`phase5c-public-share.test.ts`。原 suite 的 synthetic lifecycle/authorization/fencing/serving 回归保留；新增测试不执行 physical purge。角色、权限、revision >2^53／uint64 最大值和实际 list 的 retention/session hint 被验证。边界资格矩阵在 deterministic helper tests 中覆盖；不声称每个相等毫秒边界都单独通过 live-DB 并发测试。

Web 文件：`tests/e2e-web/authenticated-gallery.spec.ts`。7D cases 验证真实 reauth 204/cookie rotation + 第二次确认、未知 503/status404/正面读取、分页去重与后续页动作、Restore409/成功、401清空、浏览器时钟不启用删除、精确 selected album 与缓存显示移除、无 Trash 媒体字节请求、窄屏无横向溢出。原相册关系／分享／private/public Viewer／下载回归通过。真实永久删除与异步结果被 mock，不以 mock UI PASS 证明物理删除；7C crash/full purge suites 未运行。

本轮早期失败已修复：strict private DTO fixture 缺新字段及 mock fetch TypeScript tuple；browser fixture 最初遗漏 trashed_by_member_id 导致 CHECK 拒绝（无 partial lifecycle 写入）；一个 route handler 未收尾即关闭 browser 导致 disposed response。最终结果使用修复后的完整相关文件 run，不把失败/未运行当作通过。

Synthetic QA 截图：`test-results/phase7d-trash-mobile.png`（ignored test artifact），已目视检查暖白／绿色／圆角、三项窄屏导航与独立卡片。Next dev 生成的 next-env 类型路径已恢复至原 HEAD 内容；两个原有未跟踪 Web AGENTS/CLAUDE 文件 hash 与前轮快照一致。测试沿用 fixture-specific finally/global teardown；未清理未知历史数据或目录。

## Evidence limits / review focus（初次 handoff 历史，closure 由文末覆盖）

- 提示与 mutation 之间自然存在权限、session、revision 和 scheduler 竞态；最终旧 API 决定结果。请复核 SQL hint 谓词与原 7B 一致、没有 public DTO 扩展。
- 没有通用 lifecycle operation 查询：未知 Trash/Restore 可能持续 unresolved；列表缺席不能推断成功。私有 Viewer 尝试保存在组件内存，离开即丢失，不会自动重发；重新打开必须正面读取最新 ACTIVE 详情并明确确认。
- 请求卡仅页面内存，刷新／离开不能恢复；7C exclusive-owner 部署限制仍在，UI 不承诺 ETA、即时容量释放或安全擦除。
- 当前采用手动刷新，无自动轮询。UI E2E 没有穷尽所有网络中断、每个 modal Tab 路径、reauth 失败及每种 status组合；client transport/error tests 覆盖一般拒绝／未知分类，9 项浏览器结果不能解释为穷尽验收。
- Final functional/UI changes precede final unit/UI/build checks；DB projection 此后未改变，已执行 DEV integration 证据仍适用于该投影。Full milestone Quality Gate、独立审查与 Git checkpoint 未运行/未完成，本轮不作其通过声明。

```text
PHASE_07D_IMPLEMENTATION_READY_FOR_REVIEW: YES
PHASE_07D_INDEPENDENT_REVIEW_PASS: NO (initial NEEDS_FIX; targeted closure pending)
PHASE_07D_CHECKPOINT: NOT_PERFORMED
SCHEMA_CHANGED: NO
MIGRATION_CHANGED: NO
TRASHED_SERVING_CHANGED: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

## F1/F2 targeted remediation — 2026-10-02（提交 closure 前历史记录）

依据 `PHASE-07D-INDEPENDENT-REVIEW.md`。已读取完整报告、原四场景 `test-results/phase7d-review/results.json`（actor-change POST=1、背景点击改变确认、busy focus落到背景）并与源码核对；没有改写原审查 harness 或将其缺陷结果说成新验收。本轮以同类受控浏览器场景加入 checked-in 回归。修复是原 Astra actor/session 和确认流程的落实，不修改 server authority、wire contract、schema、retention、serving 或 purge。

F1：新增 `requireLifecycleActor(userId,familyId)`，比较既有 strict `/auth/me` 当前 user及membership与服务器页面的认证快照。Trash 最终确认和 reauth 在同步重复点击锁内、POST前调用guard；失败废弃确认且不发送mutation。Viewer从SSR经Timeline/AlbumDetail接收原userId，component/page key包含actor；TrashAction在打开确认及最终POST前核对actor。观察到mismatch/membership丢失/401时，先使identity失效并清空旧确认、尝试、详情/列表/卡片。成功和失败的迟到mutation响应同样先重核actor，避免向新actor显示旧页面操作结果；卸载/失效回调不继续更新状态。same-user reauth rotation不会被当作不同actor。

限制：这些GET不能绑定后续Cookie或提供服务器授权票据。guard之后、POST实际携带Cookie之前仍有自然窗口；已经发出的POST不能由UI撤销。回归将pending身份变化的期望明确为POST已发出1次、迟到结果不更新旧UI，不错误承诺POST=0。服务端依旧按实际Cookie重新授权。

F2：普通section改为原生`dialog.showModal()`，使用真正的top-layer与backdrop隔离背景；choice存在时背景ask也拒绝重写确认。dialog提供tabIndex容器兜底、focusin约束及Tab/Shift+Tab循环；busy将焦点移至容器，Escape/cancel不会关闭pending确认。正常Cancel/卸载close恢复原焦点，reauth刷新后的最终确认仍有modal内焦点。

本轮实际验证（最终代码修改后）：

- 定向10 files / 175 tests PASS，skip0：原实施8文件，加`apps/web/components/gallery/share.test.ts`及新`lifecycle-browser.test.ts`。
- 新Chrome纯mock组件回归18项：Trash/Viewer × ask前/confirm前 × B有/无membership（8）；401/membership丢失（4）；pending成功/失败时actor切换（4）；多目标背景点击、busy Tab/Shift+Tab/Escape（1）；same-user reauth + 第二次确认/focus（1）。后端业务路由全部拦截；没有API/worker或真实mutation。pending ordering使用真实路由dispatch promise，不靠sleep推断。
- 真实HTTPS关联Web文件9/9 PASS，skip0：正常reauth204/Set-Cookie、第二次确认、未知结果/分页/恢复及原相册/Viewer/分享/下载回归均保持。7D永久删除依旧mock，无physical purge。
- Web typecheck及本次影响TS/TSX的ESLint max-warnings=0 PASS；本轮文件Prettier及diff检查通过。最终 Web production build PASS，`/trash` 保持 dynamic；next-env 已回到原 HEAD，无 generated diff。
- 不重跑DB/native/7C crash/full milestone gates：此次仅客户端actor guard、modal与props/fixtures接线，DB投影/权限没有再次修改。原DB验证不转记为本轮新结果。

修复触及：`trash-client.ts`、`trash-panel.tsx`、`trash-action.tsx`、`lifecycle-dialog.tsx`、`viewer.tsx`、`timeline.tsx`、`album-detail.tsx`、`app/page.tsx`、`app/albums/[albumId]/page.tsx`、`styles.css`；props fixture同步`gallery.test.ts`/`share.test.ts`。新checked-in synthetic host为`tests/fixtures/phase7d-ui.tsx`，browser regression为`apps/web/components/gallery/lifecycle-browser.test.ts`。此文档追加实际证据，原审查文件保留。

```text
PHASE_07D_F1_F2_REMEDIATION_READY_FOR_CLOSURE: YES
PHASE_07D_TARGETED_CLOSURE_PASS: NOT_RUN
PHASE_07D_READY_FOR_CHECKPOINT: NO (independent closure pending)
SCHEMA_OR_AUTHORITY_CHANGED: NO
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
STAGE_PERFORMED: NO
COMMIT_PERFORMED: NO
PUSH_PERFORMED: NO
```

## Independent closure and scoped local checkpoint — 2026-10-02

UTC 2026-10-02T13:25:04Z 开始本轮 checkpoint/gate。依据独立审查文末最新结论，F1 P1/F2 P2 均 CLOSED，限定实施审查 PASS，无新增直接回归 finding。该结论为独立任务证据，不转记为本轮新测试执行。原审查的6文件58测试（包括18个Chrome synthetic/mock用例）及静态检查仅覆盖 targeted closure；Phase 7 milestone full gate 和最终安全复核仍待本轮及协调方完成。

核对 HEAD `b1764a16cec571be43a525a36559acd644e05324`、19个已跟踪修改与12个7D新文件，符合报告的实施/修复范围。自 closure 后本任务未改任何功能或测试；本轮仅同步本实施文档。未获得 closure 时点的逐文件 hash manifest，因此不能以路径/统计机械证明所有字节自 closure 起未变；没有识别到介入功能改动，后续 fresh full gate 验证 checkpoint。记录当前源码 manifest 并在文档同步前后比较，确认本轮没有功能变化。

本地 checkpoint 仅纳入7D实现、测试、设计、实施与独立审查文档，共31文件。保留未跟踪 `apps/web/AGENTS.md`、`apps/web/CLAUDE.md`，排除 ignored 诊断产物；schema、migration、lockfile均无修改。不会push或启动下阶段。完整 milestone 验证结果另记录于 `PHASE-07-MILESTONE-VALIDATION.md`，避免将历史结果冒充新执行。

```text
PHASE_07D_TARGETED_CLOSURE_PASS: YES (independent review record)
PHASE_07D_F1: CLOSED
PHASE_07D_F2: CLOSED
PHASE_07D_CHECKPOINT: this commit
PHASE_7_MILESTONE_GATE: PENDING
PHASE_7_FINAL_SECURITY_REVIEW: PENDING
PHASE_7_COMPLETE: NO
PRODUCTION_READY: NO
PUSH_PERFORMED: NO
```
