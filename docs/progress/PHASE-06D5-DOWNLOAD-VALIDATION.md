# Phase 6D5 — Download Final Validation

日期：2026-09-30。基线：`main` / `6558748891cbf7fd83ca68d7052d1ab44c02a053`。本阶段是 Original + Preview download 的最终验证，不增加产品 capability、route、schema 或 migration。Phase 6D5 validation、Final Review targeted remediation 与最终独立 targeted re-review 均已完成并通过；本文件由 Phase 6D final checkpoint 固化。

## D5-SEC-01 finding

Phase 6D5 的确定性探针在 production `OriginalDownloadService` 上复现：post-header failure 等待 OriginalReader/storage cleanup 后调用 `response.destroy()`，但在底层 socket teardown 尚未 settlement 时即返回并释放 Original limiter。真实 Node `ServerResponse` 与 delayed `Duplex._destroy` 连续三轮分别保留约 262 KiB writable data；每轮旧 transport 未 close 时 limiter 已回到 0/0，新同成员操作可以进入。该问题定级为 blocking P2。

最终设计结论为 `ORIGINAL_LEASE_MUST_WAIT_FOR_TRANSPORT_CLOSE: YES`。post-header failure 必须同时等待 OriginalReader/native/storage scope settlement 与 captured response transport terminal settlement，之后才能释放 limiter。`destroy()` 和 `destroyed` 均不代表 settlement。

## Targeted remediation

Original service 在首次长 await 前捕获 response socket，并安装 durable response/socket close observer。失败 sender/read/timeout 先经 `withVerifiedDownload()` unwind，保持既有 cancel → active native settlement → join/close 顺序；外层 catch 随后安装局部 terminal waiter、发起 response destroy，并等待 captured socket `close`。没有 socket 时才以 response `close` 作为 fallback；真实 `writableFinished` 可以作为已成功完成。listener 在 destroy 前安装，已发生的 close 由 durable observed state 保留；destroy 同步抛错不视为 settlement，也没有超时后强制释放。

成功路径仍等待 response `finish` 与 storage scope cleanup，不等待 keep-alive socket close。pre-header JSON error、second authorization、selected-album ACL、MIME、filename、OriginalReader/native、256 KiB chunk、single read、Preview 和 public share 均未修改。Original limiter 仍为 process 2 / per member 1 / no queue。

## Deterministic lifecycle evidence

新增 Original-local test 使用 production Original service/sender/limiter、真实 Node `ServerResponse`、controlled `Duplex`、独立 native-cleanup barrier 和 delayed `_destroy` barrier。client abort、idle timeout、total timeout 与 real `_write` callback error 均证明：native cleanup pending 时 capacity 为 1/1；native cleanup settled、transport terminal pending 时仍为 1/1 且 release count 为 0；socket terminal 后 capacity 为 0/0 且 release count 为 1。write-error 可能由 Node writable 自行提前启动 `_destroy`，但 transport terminal 与 native cleanup 均先于 limiter release。

同成员第二请求在旧 transport teardown pending 时返回 429 / `Retry-After: 1`；terminal 后新请求成功。三轮 abort 只在前一轮 terminal settlement 后开始，`MAX_UNACCOUNTED_UNSETTLED_TRANSPORTS = 0`。正常成功保持 write/drain/finish 顺序，finish pending 时 capacity 为 1/1，finish 后 release exactly once，socket close 不是成功条件。binary failure 没有 JSON append，operation/terminal listeners 在 settlement 后移除。

独立 targeted security re-review 已确认 `D5_SEC_01_CLOSED: YES`、P0/P1/blocking P2 均为 0，并批准恢复剩余 Phase 6D5 validation。后续测试没有重构或回退该 remediation。

## Real HTTPS acceptance

新增 `tests/e2e-web/download-validation.spec.ts`，通过真实 `https://localhost:3443` Next dev HTTPS 前门、`/api/v1` rewrite、真实 API `:4400`、`family_album_dev`、临时受控 storage root 和真实 Secure Cookie login 验证下载。自签证书例外只存在于该 Node test client / Playwright context；应用 TLS 配置未修改。

64 MiB（67,108,864 bytes）Original fixture 按 256 KiB 小块生成并同步计算 authoritative SHA-256；客户端只增量计数与 hash，不做 whole-body concat。真实 HTTPS 成功响应验证了 exact length/hash、current JPEG MIME、safe `Content-Disposition`、private/no-store、nosniff、no-referrer、`Accept-Ranges: none` 和无 `Content-Range`。stale metadata MIME 真实回退为 `application/octet-stream` / `.bin`。prefix、suffix、multiple Range 对 Original 与 Preview 均返回完整 200；真实 HEAD 为 404/405 且不带 attachment metadata。

Content-Disposition 通过 network `rawHeaders` 验证仅一个 header、一个 `filename=`、一个 `filename*=`、无 CR/LF/header splitting、只采用 trusted extension 且不超过 512 bytes。fixture filename 同时覆盖 quote、slash、backslash、percent、apostrophe、asterisk、Unicode、emoji/non-BMP、path-like 与长合法值；CR/LF/NUL/bidi/control 的 upload-boundary rejection 由 storage validator tests 覆盖。

Preview 通过同一 HTTPS 前门验证 exact 4 MiB bytes/hash、`image/webp`、server-generated filename，且不包含 source filename。Original 与 Preview 都执行了 body-start 后真实 client connection abort；API safe log 观察到对应 `TRANSFER_FAILED`。该事件只会在 service 等待 native/storage cleanup 和 captured transport terminal 后返回，因此与 deterministic lifecycle barrier 共同证明 cleanup/terminal/limiter settlement；Original abort 后同用户完整 64 MiB 重下成功。Preview/Original 均无 JSON append 证据。pause/resume Original 期间，另一独立 HTTPS connection 的 `/api/v1/auth/me` 保持 200，恢复后 exact byte count/hash/complete；这属于 pause/resume acceptance，未声称直接观察 server `write=false`。

成功与 abort 前后比较了 Original/Preview SHA、device、inode、mode、nlink、size、mtime 和 canonical DB identity（storage/upload/media/placement/derived/job），未发现 download-side mutation、job enqueue/retry 或 source provenance 改变。API 以 `LOG_LEVEL=info` 运行，捕获日志不含 filename、实际 SHA、storage path、Cookie/session token、password 或 Authorization 字段。

真实 HTTPS download spec 现为 1 file / 10 tests PASS，完整 Web HTTPS 为 12/12 PASS，skip 0。联合 targeted native/download、Original/Preview route/lifecycle、6D3/6D4 real MySQL authorization/race/1205/linearization、public share、cleanup/sensitive-assertion 与 mixed service 为 20 files / 176 tests PASS，skip 0。

Public 回归继续确认 thumbnail/preview allowed、original forbidden；revoked/expired/invalid share denied，private session 不扩大 public DTO/capability，share token不能授权 private Original/Preview，private query 与 Bearer 混用 fail closed。public DTO 不包含 favorite/featured/tags/note/revision/comments/count/private capabilities/storage identity/path/hash。

## Final Review targeted remediation

### Cleanup ownership

Web acceptance 现在先在 canonical system temp 下用 `mkdtemp` 创建 direct-child run root，并写入 mode `0600` 的 current-run nonce marker。media root、API observation log 与 HTTPS certificate directory 都是该 exact run root 下的固定 child；global teardown 只接收完整 run metadata。清理前验证 normalized path、canonical parent、direct-child prefix、非 symlink 目录、marker nonce，以及三个 child 的 exact path/type。Playwright worker 只能继承同时匹配 marker 与 nonce 的当前运行；任意或不完整 env、同前缀但无 ownership marker 的既有目录均拒绝。

Focused negative tests覆盖 `..`/normalized escape、sibling prefix collision、target/child symlink、preexisting same-prefix、arbitrary env，以及 storage/log/certificate 外部路径；拒绝后验证外部目标仍存在。positive test证明本次创建的 storage/log/certificate tree 可完整删除。HTTPS launcher 对 configured certificate path 复核同一个 run-root marker，且不自行递归删除 configured path；唯一递归 owner 是 global teardown。

三个旧目录 `phase6d3-download-BlBUIB`、`phase6d4-CitWb7`、`phase6d4-dG9RdB` 没有新的 current-run ownership marker，故本次保持 untouched，不能把它们计入 current-run residue，也不声称 historical residue 为零。

### Sensitive assertion hygiene

测试 helper 只向失败面暴露固定 category；secret、captured log、Cookie、password、share/session token、SHA/path sentinel 不传给 matcher diff。Set-Cookie 先解析为 cookie name/value-nonempty/Secure/HttpOnly/SameSite/Path/Domain-absent 等安全字段；实际 Cookie 只在请求内部复用。故障回归用 synthetic sentinel 主动触发 absent/equality helper，确认 Error message 仅含安全 category 且不含 sentinel。相关 public-share token assertions 同步改为 boolean 或 category-only helper。

最终单点修复进一步移除了 share create unit/route test 中仍会把 raw token 放入对象 diff 的断言。创建结果现在只比较 `shareId`、`albumId`、`expiresAt` 等非敏感 projection；token 格式、相等性及 hash 关联只通过 boolean/category-only helper 验证。新增回归让内部对象保留 synthetic token、故意令无敏感字段不匹配，并确认失败消息只含安全 category、projection keys 不含 token。D6-FINAL-02 remediation 已完成，等待最终 single-finding independent re-review。

### Real HTTPS authorization matrix

真实 `https://localhost:3443` → Next rewrite → API → DEV MySQL 路径以真实账号密码登录并取得 Secure Cookie。小型 synthetic Original/Preview fixture 覆盖：selected-album owner、FAMILY non-owner、explicit `can_view`、CUSTOM no-view、SUPER_ADMIN no-view、cross-family、no placement、only-visible-in-other-album、member disabled、member left、user disabled、revoked session 和 BLOCKED media。Original FAMILY 与 Preview FAMILY 都实际返回成功。disable/leave/user-disable/session-revoke 均先成功登录，再提交状态变更，再用既有 Cookie 请求；denial 不带 attachment metadata。64 MiB fixture仍只用于 large Original streaming acceptance。

### Mixed-service evidence

真实 MySQL repository、实际 `OriginalDownloadService` / `PreviewDownloadService` 和 production limiter 同时运行。controlled reader/send barriers 证明同一 member 的 1 Original + 2 Preview 同时占用各自 1/1 与 2/2，额外同类请求分别 429；prepare 与 second-auth 事务在 storage/send barrier 暂停时仍允许独立 family-lock transaction 完成。先释放 Preview 后 Original counter 保持占用；再释放 Original 后全部归零，无 sleep ordering proof。另一个并发成功案例使用 real native `OriginalReader` 与 real Preview `CapacityGate.readDerivedFinal`，两类 bytes 都 exact。controlled barrier 证明 settlement/counter 顺序；real-storage case证明两条实际 storage path 可并行成功，二者不混写为同一证据。

### Evidence layers

- Real HTTPS：Secure Cookie、真实登录授权矩阵、headers/Range/HEAD、64 MiB、abort、pause/resume。
- Real MySQL race：state-first 与 recheck-first、不同 connection IDs、真实 1205、second-auth COMMIT linearization。
- Real storage/native：same-FD Original、bounded sequential reads、real OriginalReader + Preview CapacityGate mixed success。
- Controlled service lifecycle：native/transport barriers、post-header settlement、limiter release 与 mixed counter independence。

## Final gate evidence

最后一次 functional/test change 之后：lint、format check、typecheck、build 全部 PASS；完整 Vitest 为 124 files / 1004 tests PASS、skip 0；独立 integration 为 28 files / 279 tests PASS、skip 0；API Playwright E2E 为 5/5 PASS；authenticated Web + HTTPS download Playwright 为 12/12 PASS、skip 0，其中 `download-validation.spec.ts` 为 10/10 PASS；Phase 6 migration readiness 为 1 file / 23 tests PASS、skip 0；`git diff --check` PASS。后续只有本证据文档更新、Web build/dev 自动生成文件恢复与只读 repository/residue 核对，因此 full gate evidence 不陈旧。

## Status

D5-SEC-01、D6-FINAL-01、D6-FINAL-02、D6-FINAL-03 均已修复并通过独立定向复审。最终安全审查结果为 P0 = 0、P1 = 0、blocking P2 = 0、non-blocking P2 = 0、P3 = 0，`PHASE_06D_FINAL_SECURITY_REVIEW_PASS: YES`，`REMEDIATION_REQUIRED: NO`。

本文件随 `Complete Phase 6D download validation` checkpoint 确认 `PHASE_06D_COMPLETE: YES` 与 `READY_FOR_PHASE_6E_DESIGN: YES`。`PHASE_6_COMPLETE: NO`、`PRODUCTION_READY: NO`；Phase 6E implementation 尚未开始。
