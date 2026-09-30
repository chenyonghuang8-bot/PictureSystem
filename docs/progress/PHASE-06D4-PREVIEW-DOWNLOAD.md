# Phase 6D4 — Private Preview Download

日期：2026-09-30。性质：R3-IMPLEMENT。基线 `main` / `bd332a6c0f52fa6ac0dbcc948458586d2e6d1c1d`。本 slice 只实现 selected-album 私有 PREVIEW attachment；不修改 schema/migration，不开启 Gallery capability，不实现 Web 控件、public original、Range、regeneration、Phase 6D5 或 Phase 6E。

## Implemented

私有路由为 `GET /api/v1/albums/:albumId/media/:mediaId/download/preview`。它只接受既有 WEB session Cookie；`Authorization` 混用仍拒绝，params 和 query 均严格校验，Fastify 自动 HEAD 被关闭。Range 被忽略并返回完整 200，成功响应固定 `image/webp`、安全 attachment filename、exact Content-Length、`private, no-store`、`nosniff`、`no-referrer` 和 `Accept-Ranges: none`。

`MySqlAlbumRepository.preparePreviewDownload()` 和 `recheckPreviewDownload()` 使用两个独立 checked short transaction。两次均按 family → actor user/session/member → selected album → grant → canonical original storage → media → exact placement → current PREVIEW 锁序检查 current WEB session、成员、selected-album ACL、placement、AVAILABLE storage、非 BLOCKED/已知 media state、media generation/recipe 1，以及同 generation/recipe 的完整 READY WebP row。SUPER_ADMIN 不绕过 ACL。第二次事务 successful COMMIT 是 authorization linearization point；identity drift 拒绝当前请求，不自动切换或重读新 preview。

事务间释放全部 DB locks，再通过既有 `CapacityGate.withLock()` / `readDerivedFinal()` 读取 trusted identity。读取前要求 `0 < byteSize <= reservedBytes <= 4,194,304`；最终 Buffer 再独立验证 exact length、4 MiB cap 和 SHA-256。API 不接收或暴露 raw path、root、FD 或 FileHandle，不读取 original，不 fallback，不 enqueue、repair 或更改 media/derived 状态。

Preview 专用 limiter 为 process 4、每 `(familyId, actorMemberId)` 2、无 queue，拒绝为 429 / `Retry-After: 1`。lease 覆盖 gate wait、同步 native read settlement、Buffer verification、second auth、write/backpressure，以及 success response finish 或 failure transport terminal settlement。失败路径在首次长 await 前保存 socket 并安装 close observer；发送失败时先安装局部 terminal waiter，再发起 destroy，并在真实 socket `close`（无 socket 时为 response `close`）后清理 listener 和释放 lease。`destroy()` / `destroyed` 本身不视为 settlement。发送 idle/total budgets 为 30/120 秒；已进入的同步 native read不可抢占，abort 后等待真实调用返回并丢弃结果。

## Dynamically tested

- Preview unit/API、limiter、HEAD、Range、Buffer length/hash、COMMIT-unknown、authentication disconnect、gate-wait abort、write/finish capacity lifetime、idle/total post-header termination：PASS。Client abort、idle timeout、total timeout 和 write error 使用真实 Node `ServerResponse`、受控 `Duplex` 与 delayed `_destroy` barrier，动态证明 teardown pending 时 process/member capacity 仍为 1、release count 为 0；socket terminal 后 capacity 为 0、release count 为 1，且未追加 JSON。
- Original header/limiter/sender/route、existing derived serving 和 public share boundary targeted regressions：PASS。
- DEV `family_album_dev` synthetic integration 使用真实 `CapacityGate.readDerivedFinal()` 返回有效 synthetic WebP exact bytes；没有使用真实家庭媒体。
- Selected-album matrix覆盖 owner、FAMILY member、explicit can_view、CUSTOM no-view、SUPER_ADMIN no-view、cross-family、no placement、BLOCKED、missing/old-generation/old-recipe/non-READY/cleaned preview。
- State-first matrix覆盖 ACL、placement、member disabled/left、session revoke、user disabled、storage state、BLOCKED、generation、READY invalidation、derived hash/size identity、media recipe；均先真实 COMMIT，再命中 second-auth 拒绝，无 attachment body，capacity 最终释放。
- Recheck-first ACL 与 generation 使用 test-only pre-COMMIT barrier、独立 connection ID 和真实 MySQL 1205 lock-wait 证据，确认 second-auth COMMIT → mutation COMMIT；当前 request 成功，下一 request 失败。
- Test-only configured recipe seam 验证 read 期间 recipe drift fail closed；未增加 production 配置 mutation API。
- Preservation 围绕真实 HTTP success 动态比较 original bytes/hash/inode/device/mode/nlink/size/mtime、storage identity/state、source upload、media generation/recipe/state、exact placement、derived identity/state/hash/producer/publish/cleaned 字段和 background job identity/state。
- 真实 storage negatives覆盖 absent、wrong size、wrong SHA、oversized、symlink entry 和 unsupported recipe；不触发 repair 或 original read。

## Code-reviewed boundaries

成功 headers 晚于 bounded read、最终 Buffer integrity、second-auth COMMIT 和 live-socket check。headers 后 failure 只 destroy response，不追加 JSON。日志白名单只记录 request/family/album/media/member ID、PREVIEW、result、duration 和 bytes；没有 path、hash、filename、EXIF/GPS、Cookie、Authorization、token 或 raw storage/DB error。Gallery detail 的 `canDownloadOriginal` / `canDownloadPreview` 仍为 false，public share service/DTO/authorization 未改变。

## Validation state

Targeted unit/public/original/storage：10 files / 82 tests PASS，skip 0。Combined real MySQL original/preview/existing-derived integration：3 files / 35 tests PASS，skip 0。Phase 6D4 dedicated integration：19 tests PASS，且每次 suite cleanup 动态断言 synthetic family residue 为 0。

最终 Quality Gate：lint PASS；format PASS；typecheck PASS；unit/API/real DEV MySQL integration/native storage 共 121 files / 985 tests PASS，skip 0；独立 integration/race 27 files / 268 tests PASS，skip 0；Phase 6 schema/migration readiness 23 tests PASS；build PASS；E2E 5/5 PASS；authenticated HTTPS Web E2E 2/2 PASS；`git diff --check` PASS。首次受限沙箱运行因 MySQL、Unix socket 与 macOS native isolation 的 `EPERM/status 84` 失败，按仓库要求在非沙箱环境重跑后上述门禁全部通过；该次环境失败不计为实现失败。

最终定向安全复审：SEC-01 CLOSED；P0 = 0，P1 = 0，blocking P2 = 0；final targeted security re-review PASS。

## Deferred / not claimed

Production deployment、persistent rate limiting、durable audit、production access-log redaction、power-loss/SSD 和既有平台 fixture 项保持 deferred。Phase 6D4 仅在本 checkpoint commit/push 成功后 COMPLETE；Phase 6D5/6E 未开始。Phase 6 未完成，production ready 为 NO。
