# Phase 6D3 — Private Original Download

日期：2026-09-28。性质：R3-IMPLEMENT。基线 `main` / `402e96790515cf2d2d253f998b68e41374e43988`。本 slice 只实现私有原文件 attachment；不实现 preview、Web 控件或 public original，不修改 schema/migration，也不表示 Phase 6D 完成或 production ready。

## Repository authorization

`MySqlAlbumRepository.prepareOriginalDownload()` 与 `recheckOriginalDownload()` 都使用新的 checked short transaction。事务锁序为 family → actor user/session/member → selected album → album grant → storage object → media item → exact album_media placement → source upload receipt。事务前对 album family、storage/source ID 的 unlocked 查询只定位锁目标；授权与 identity 判断全部在锁内基于 current rows 完成。

两次授权都在取得所需锁后读取 DB server time，并复用 `assertActor` 检查当前 WEB session、token hash、absolute/idle expiry、user/member disabled/left/revoked 状态；不要求 recent-auth。selected album 必须 current viewable，SUPER_ADMIN 没有 ACL bypass；placement 必须精确匹配 selected album。允许 PENDING/PROCESSING/READY/PARTIAL/FAILED original，BLOCKED 与未知状态 fail closed。

可信投影只返回 family/album/member/media ID、storage object ID、key version、SHA-256、byte size、source upload ID、source receipt filename 与 current-generation detected MIME。storage 必须 AVAILABLE、key version 1、positive size、32-byte SHA；source receipt 必须 COMPLETE，且 object/hash/size/offset 与 canonical storage identity 一致。没有 path、root、FD、storage key 或 derived path。

## Second authorization and races

初始事务 COMMIT 后释放全部 SQL locks，再取得 download lease 并执行 full verification。`OriginalReader.withVerifiedDownload()` 进入 callback 后，服务在一个新的短事务执行 recheck。recheck 重复当前 session/member/ACL/placement/media/storage/source 检查，并逐项比较 familyId、albumId、actorMemberId、mediaId、storageObjectId、keyVersion、sha256Hex、byteSize、sourceUploadId。header filename/MIME 来自成功 recheck 的 current projection。

第二次授权 COMMIT 是 linearization point。ACL revoke、placement removal、member disable/leave、session revoke、storage AVAILABLE→MISSING/CORRUPT 若先提交，本请求在 success headers 前失败；recheck 若先 COMMIT，当前传输可以完成，之后的请求重新授权并失败。COMMIT outcome unknown 不 replay，统一 503，且不提交 attachment headers/body。full hash 与网络传输期间不持 DB locks。

真实 MySQL synthetic race 测试使用每 repository instance 的 `ORIGINAL_DOWNLOAD_PREPARE` / `ORIGINAL_DOWNLOAD_RECHECK` hooks 和明确 barrier，覆盖 state-first 与 recheck-first 两种提交顺序；不使用 sleep 作为顺序证据。

## Capacity and storage composition

API-private limiter 是立即 `tryAcquire`、无 queue：每进程 2 个 active original downloads、每 `(familyId, actorMemberId)` 1 个。member key 只来自初始授权结果；active count 归零即删除 key。拒绝返回 429 与 `Retry-After: 1`。lease 从 initial auth 后持续覆盖 verification、recheck、pre-read、transfer 和 native cleanup，仅在最外层 finally、6D1 settlement 完成后幂等释放。

API composition 从已配置且 marker-bound 的 trusted storage root 构造一个 `OriginalReader`。READ_WRITE 和已有可信 root 的 READ_ONLY capability 都可尝试只读 reader；每次 original 仍进行 same-FD full verification。UNAVAILABLE 或 reader open failure 保持 route 存在但 storage operation fail closed 为 503。download limiter 不复用 `CapacityGate`。Fastify shutdown 先停止请求，再关闭 reader，随后关闭 root。

## Filename and MIME

filename 只来自 `media_items.source_upload_id → upload_sessions.original_filename`，但仍当作不可信 header text。单一 pure encoder 拒绝 malformed Unicode，取 `/`、`\` 后最后 component，移除原扩展，清理 Cc/Cf/bidi、CR/LF/NUL、quotes 与危险首尾 whitespace/dots，按 Unicode code-point boundary 将 stem 限制为 120 UTF-8 bytes。

ASCII `filename=` 固定为 `media-<mediaId>.<trusted-ext>`；`filename*=` 使用 UTF-8 RFC5987-style bytes，只保留收窄 attr-char，其他 byte 使用 uppercase `%HH`，包括 `%`、`'`、`*`。每个参数只出现一次，整个 Content-Disposition 不超过 512 bytes，否则退回 deterministic fallback。

detected MIME 仅在 `metadata_generation === generation` 时使用。allowlist 为 JPEG/PNG/WebP/GIF/HEIC/HEIF/MP4/QuickTime，并映射固定安全 extension；stale/null/unknown 使用 `application/octet-stream` / `.bin`。不信 reported MIME、请求 Content-Type 或 filename extension。

## HTTP sender and lifecycle

私有 route：`GET /api/v1/albums/:albumId/media/:mediaId/download/original`。Fastify route 设置 `exposeHeadRoute:false`；实际 HEAD 为 404/405 且不调用 repository/storage。query 必须为空。Range 不解析；所有可接受 Range 形式都忽略并返回完整 200，`Accept-Ranges:none`，没有 206、Content-Range、multipart、ETag 或 conditional response。

header commit 顺序是 full same-FD verification → second auth COMMIT → abort check → first `readNext()` 成功且有 bytes → socket writable check → `reply.hijack()` / 200 headers。必需 headers 为 exact Content-Length、allowlisted/fallback Content-Type、safe Content-Disposition、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Accept-Ranges: none`、`Referrer-Policy: no-referrer`。

sender 始终一个 native read in flight；每个 chunk 的 write callback 完成，且 write 返回 false 时 drain 也完成后，才请求下一 chunk。临时 drain/error/close/abort listeners 每次 settlement 后移除。final:true chunk 写完后 end 并等待 finish，不额外 read。headers 后的 read/timeout/socket failure destroy response，不进入 JSON handler；SUCCESS 只在 final write、finish 和 6D1 callback/cleanup 都成功后记录。

operation-level AbortController 汇聚 client abort、premature response close/error、verification 120s、idle 60s、total transfer 1h 与 internal failure。idle 只在 chunk 成功写入后 reset，backpressure 等待计入 idle。所有 timers/listeners 在 finally 清理；abort 后等待 6D1 in-flight read/cancel/close settlement，避免 read/close race。

## Validation evidence

所有媒体与 DB fixture 均为 synthetic；未读取真实家庭媒体。

- filename/MIME/limiter/sender/timeout/route/public/native targeted：PASS。
- original-download unit HTTP：4 files / 38 tests PASS。
- expanded album/public/native targeted：14 files / 123 tests PASS。
- Phase 6D3 real MySQL + real production `OriginalReader.withVerifiedDownload`：1 file / 11 tests PASS。
- real DB matrix：ACL、placement、member disable/leave、session revoke、storage MISSING/CORRUPT、SUPER_ADMIN hidden、BLOCKED、current/stale/null MIME、state-first 与 recheck-first PASS。
- preservation：original bytes/hash/inode/device/mode/nlink/size/mtime、storage identity、source_upload_id、media state、placement row count、derived row count unchanged；download-side DB mutation none；synthetic residue 0。

Final lint/format/typecheck/unit/integration/build/E2E/readiness evidence is recorded in the task result after the final document change and is not predeclared here.

## Boundaries and deferred items

- Preview attachment: NOT IMPLEMENTED (Phase 6D4).
- Web controls/capabilities: NOT IMPLEMENTED; `canDownloadOriginal` / `canDownloadPreview` remain false.
- Public original: FORBIDDEN; public response DTO/mapper unchanged and exact whitelist regression retained.
- Range/resume, transfer-time per-chunk authorization, durable audit and persistent production rate limiting remain deferred by design.
- Existing production deployment, real power-loss/SSD disconnect and platform fixture items remain inherited.
- Phase 6D complete: NO.
- Production ready: NO.

## Independent-review remediation

独立安全复核后的定向修复将 operation AbortController 与 request/response listeners 提前到 initial authorization 之前。initial auth 完成后、capacity acquire 前及 storage admission 前都会同步检查当前 request/response/socket 状态，因此认证或初始授权等待期间已经发生的 disconnect 不会启动 full verification。已进入 `withVerifiedDownload` 的 abort 仍等待 storage/native settlement 后才释放 lease。

真实 MySQL race matrix 现在经过实际 private route、`OriginalDownloadService` 与真实 `MySqlAlbumRepository`，只用受控 opaque reader 暂停 verification。ACL revoke、placement removal、member disable/leave、session revoke、storage MISSING/CORRUPT 均先通过 family-lock transaction 明确 COMMIT，再释放 verification；测试逐项确认 second-auth 目标错误分类、source read 为零、无 attachment success header、无 original body、storage cleanup 完成及 process/member lease 归零。recheck-first 测试确认 mutation 的 family-lock query 已 dispatch 且尚未取得锁，再让 second auth COMMIT；当前 HTTP 返回 exact bytes，mutation 随后提交，下一请求失败。

MIME allowlist lookup 改为 own-property 检查；`__proto__`、`constructor`、`toString` 均确定回退到 `application/octet-stream` / `.bin`。

Remediation targeted evidence：original-download unit/API 4 files / 44 tests PASS；Phase 6D3 real MySQL integration 1 file / 11 tests PASS。完整 final gates 只在最后一次代码、测试和本文档修改后记录于任务结果。

第二轮定向修复将 MySQL recheck-first 证据推进到 server-observable lock wait：test-only repository event 记录 second-auth connection ID，competing mutation记录自身 connection ID。在 second-auth 仍停于 pre-COMMIT barrier 时，同一 mutation transaction 对相同 family `FOR UPDATE` 必须收到 MySQL `ER_LOCK_WAIT_TIMEOUT` / errno 1205；随后立即重发相同锁请求，再释放 second-auth barrier。测试以服务器错误而非时间流逝或 Promise pending 作为 lock-wait PASS 条件，并明确记录 second-auth COMMIT、mutation COMMIT 的先后顺序。

controlled reader 现在将 scope cleanup start、可控 settlement barrier 与 settlement complete 分开记录。代表性 state-first rejection 和 recheck-first success 都在 cleanup 尚未 settlement 时确认 process/member capacity 仍为 1/1，释放 cleanup 后才观察到 capacity release 和 0/0；七项 state-first matrix 继续保留 no-header、zero source read、目标 second-auth branch、cleanup 与最终 capacity 断言。

## Final security review and checkpoint status

Phase 6D3 implementation complete。最终独立安全复审 PASS：P0 = 0、P1 = 0、blocking P2 = 0、non-blocking P2 = 0、P3 = 0；SEC-01、SEC-02、SEC-03 均已关闭，无剩余 remediation。最终 targeted evidence 为 7 files / 66 tests PASS、skip 0；完整 final gates 为 118 files / 943 tests PASS，DEV MySQL integration 26 files / 249 tests PASS，API E2E 5/5，authenticated HTTPS Web E2E 2/2，migration readiness PASS。

本 checkpoint 只完成 Phase 6D3 私有 original download。Phase 6D4 未开始，Phase 6 尚未完成，production ready 仍为 NO。
