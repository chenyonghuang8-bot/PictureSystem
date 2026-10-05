# Phase 8 最终总结

2026-10-04 UTC。HEAD：`0c948451774efd10a293029e727b666758441436`。本次完成用户批准的整个 Phase 8 搜索与地图批次，限定为 DEV synthetic 验收。保留全部既有未提交修改，无 commit、push、tag、部署或 Phase 9 工作。

```text
PHASE_8_COMPLETE: YES
PHASE_8_FINAL_QUALITY_GATE: PASS
SCOPED_INDEPENDENT_REVIEW: CLOSED
NEW_BLOCKING_FINDINGS: 0
PRODUCTION_READY: NO
NEXT_PHASE_STARTED: NO
```

## 完成范围

- 非地点搜索：时间、相册、收藏、首次来源文件名、上传者、标签 AND 组合，授权后的 options、keyset pagination 与 cursor scope；Web 搜索、Viewer 和历史导航接线。此前批准的非地点批次详见 `PHASE-08-NONLOCATION-SEARCH-BATCH.md`。
- 地点搜索与地图：固定 H3 res6 数公里粗化，bbox/count/cluster/labels 均从 cell 派生，不使用 exact GPS query。父聚合从 res6 派生并自适应变粗，最多 500 个完整结果而非截断。国家来自 coarse center 的本地 Natural Earth 10m v5.1.1，附近城市来自同国 GeoNames cities1000 最近点且距离不超过 50 km；这是附近城市，不是行政归属。unknown 不猜。
- Projection 按 current generation、policy、dataset gating、CAS/fencing 更新。新增 DEV `0008` migration；`0000`–`0007` SQL 与 HEAD 逐字节一致。服务端沿用既有照片 ACL，在过滤、聚合、计数之前执行，无管理员绕过。隐藏集合不改变无权结果。
- MapLibre 与配置化 OpenFreeMap，地区列表跳转、无 GPS、极区、反子午线、stale camera response、back/forward、logout/auth isolation、服务失效/禁用 fallback 有测试。API 为 private/no-store，无跨请求服务器 cache；GPS 不进入响应、前端、日志或 provider。外联仅限用户已批准的普通浏览区域/IP 披露，无公共 OSM 自动 fallback、批量瓦片抓取或付费账户。
- 真实新上传链路：TUS/finalize COMPLETE → API reconciliation（独立 T1 canonical/probe、T2 enqueue）→ 真实只读 native MEDIA_PROBE → metadata/projection/downstream → native derivative READY → 授权 API placement/map。实际进程 A 重启恢复测试没有手工 seed media/job/READY/album placement，也没有以旧 GPS 回填或 mock 代替上传证明。Original hash/inode 保持。
- 已补同 K 并发 dedup/native L-S、三页公平 advance 和 late low/high-water、projection 子行 purge/receipt retirement/backfill 等待、generation/trash-restore/lease 六个双锁序、metadata stop-selection，以及真实 owner render/publication 与 concurrent admission 的默认 keep-alive shutdown/drain。

运行方式与 dataset 校验/署名见 `PHASE-08-LOCATION-DATA-OPERATIONS.md`；实际接线见 `PHASE-08-MAP-PIPELINE-IMPLEMENTATION.md`。DEV runtime 为显式 opt-in，`.env.example` 默认 `DEV_MEDIA_PIPELINE_ENABLED=0`。本轮没有建立持久后台服务。

## 独立审查与边界

Astra Low 已完成限定独立审查及修复复核，见 `PHASE-08-MAP-PIPELINE-REVIEW-CLOSURE.md`。两个 P2（停止后继续 selection、近零 bbox exponent 编码）均 CLOSED；新增 response 完成后的 idle connection sweep PASS。活动请求、native/SQL work 先 settle/drain，再关闭 store/reader/gate/root，未改变批准的事务、权限或 storage 不变量。

独立复核的 31 direct + 8 browser PASS 是上一轮证据。本次完整 gate 的结果另列，不与重叠用例相加。真实硬件断电、SSD 拔出、所有可能的中断指令点/并发排列、长期无界流量和 Production 验证没有被这些定向矩阵覆盖。

## 本次完整 Quality Gate

所有日志保留在 ignored `.cache/phase8-final/`，最终机器证据与文件指纹为 `final-evidence.json`、`final-fingerprint.json`。

| Gate                                                          | 本次结果                                                               | 证据                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Format                                                        | PASS，最终修改后再次检查                                               | `format-last.log`                                                             |
| Lint                                                          | PASS，最终修改后再次检查                                               | `lint-last.log`                                                               |
| 全 workspace typecheck                                        | PASS；历史测试维护后 DB typecheck 再 PASS                              | `typecheck.log`、`db-types-after-test-fix.log`                                |
| Build                                                         | 全 workspace PASS，含 native build、API/worker/Web、mobile Expo export | `build.log`                                                                   |
| 全 unit/API/integration/MySQL race/native/fault/crash/browser | 154 files / 1620 tests PASS，skip=0                                    | `test-final.log`                                                              |
| API E2E                                                       | 5 PASS，skip=0，retries=0                                              | `api-e2e.log`                                                                 |
| Web HTTPS E2E                                                 | 20 PASS（gallery 10 + download 10），skip=0，retries=0                 | `web-https-e2e-final.log`                                                     |
| 当前 DB readiness                                             | `PHASE8_ALREADY_CURRENT_NO_DDL`                                        | `readiness.log`                                                               |
| 实际 dataset loader/checksums                                 | PASS，258 country features / 171102 cities                             | `dataset-check.json`                                                          |
| 本次真实 hosted basemap                                       | 36 external requests 全 200，无 Cookie/Authorization/Referer           | `basemap-proof.json`，原始 `.cache/phase8-map/evidence/basemap-requests.json` |
| `git diff --check`                                            | PASS                                                                   | `diff-check.log`                                                              |
| DEV fixture/进程清理                                          | PASS                                                                   | `cleanup.json`、`process-residue.log`                                         |

数据版本 SHA-256：`b91de06689ac1ecd6b7910e0fbdc1289cef8c63ba390bb00732ae19dcf9695ed`，policy=1，h3-js=4.5.0。实际 loader 验证 normalized files 与 manifest/source pin；本轮没有重新下载源 archives。Natural Earth 为 public domain；GeoNames 为 CC-BY-4.0，已保存 attribution。

全 `pnpm test` 包含真实 MySQL integration/race 及 Phase 8 上传 11、location metadata 8、location 9、map browser 8 用例；它没有因环境未加载而 silently skip。HTTPS gallery/download 从新服务和专用 synthetic root/cert 启动；新上传至地图的实际 API/runtime 证明与 MapLibre 浏览器证明分开执行，本轮没有声称存在同一个 HTTPS Chrome 上传至地图用例。

### 失败记录与限定修复

初次失败原始日志保留，没有改写为 PASS：

1. `lint.log`：11 errors 来自 ignored `.cache` 历史 diagnostic scripts。仅在 `eslint.config.mjs` 全局 ignores 加 `.cache/**`，不排除任何产品源码。
2. `test.log`：154 files 中 4 failed；1577 PASS、2 failed、41 skipped（setup 失败）。原因是旧测试把当前 journal 固定为 8，或用当前 schema 验证历史 post-0007 snapshot。`phase7-migration.test.ts` 采用严格的 Phase 8 predecessor snapshot 验证历史 schema；三个 Phase 7 integration 文件从 manifest 获取当前 migration count，仍执行真实严格 readiness。旧 migration 字节、历史约束及 runtime schema 均未修改。随后完整 `pnpm test` 重跑 1620 PASS、skip=0。
3. `web-https-e2e.log`：gallery 第 9 项真实 login 返回 429（8 PASS、1 failed、1 未运行）。增加一个非地点搜索用例后，同一 loopback IP 的 login/reauth 累积碰到既有 10 次/60 秒限制。仅在 fixture 第 9 项登录前等待现有窗口结束，并给这项 fixture 等待时间预算；未改 auth/rate limit、没有失败重试。随后完整 HTTPS 两套 20 PASS。
4. `cleanup-initial.log`：自建 `/tmp` 脚本 `.ts` 在 CJS 处理下不支持 top-level await；改为 `.mts` 后只读 cleanup 核验 PASS。不是应用错误。

这次 full gate 只新增 6 个维护路径：ESLint config、上述 4 个旧 migration 测试文件、HTTPS gallery fixture。没有修改独立审查后产品安全逻辑。完整 build 和 workspace typecheck 在这些测试/工具维护之前通过；DB typecheck、完整 tests、HTTPS E2E、最终 format/lint 在各自相关修改之后通过，产品 build inputs 未再变动。HTTPS dev server 自动把 `next-env.d.ts` 的生成类型路径切到 `.next/dev/types`；核对仅此两行后恢复为 gate 起点/HEAD 的 build 类型路径，不保留生成噪声。文档最后写入并另行检查格式。

## 指纹与清理

- gate 起点 81 文件 compact JSON SHA-256：`a54dd1e3370bf5529f41a37596a6d9b034b7a5091dca4ce2a84c8dd1c9b21a81`；独立复核前 80 文件全部与起点对应文件一致，新增为 closure 报告。
- 最终 tracked changed + nonignored untracked 的逐文件 SHA-256、排序清单 SHA、binary diff SHA、起点差异均保存在 `final-evidence.json`。文档不自嵌自己的最终 hash，避免循环。
- 无关 `apps/web/AGENTS.md` / `CLAUDE.md` 和 pinned dataset 保持原 hash；既有未提交修改保留。`0000`–`0007` frozen SQL 校验见 `frozen-migrations.json`。
- DEV 核验为 `family_album_dev` / MySQL 9.7.2 / non-root / native FK=1 / FK checks=1。只查自建 fixture 标识：runtime/location/metadata families 和 runtime users 剩余均为 0；3443/4000/4400 无 listener，实际测试服务残留为 0。各 HTTPS/native fixture ownership teardown 成功，专用 system tmp root/cert 已清理；没有扫描或清理别人的 tmp、home ACL 或真实媒体。

## 未执行和后续评估

本次没有 Production、真实照片、真实硬件断电/拔盘、Android APK/设备运行（仅 Expo export build）、已部署 reverse proxy/CSP 全环境认证、视频 GPS extraction、街道/行政城市地理编码或 Phase 9 AI/回忆。既有 Production rate limiting、persistent audit 与硬件/部署待验项不由本 DEV gate 关闭。

Phase 8 批次在批准范围内完成，无剩余本批阻塞项。停止于此，交用户评估新网页规划流程；不自动进入下一阶段。
