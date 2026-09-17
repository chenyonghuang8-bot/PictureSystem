# PHASE 3 — Storage & Resumable Upload Guardrails

日期：2026-09-15。任务：R3-DESIGN。状态：设计完成，允许按第 19 节分步实现；尚未验证任何 Phase 3 运行时能力。

```text
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: YES
MEDIA_ITEMS_REQUIRED_IN_PHASE_3: NO
TUS_RECOMMENDED: YES
READY_FOR_PHASE_3_IMPLEMENTATION: YES
```

`DESIGN_CHANGE_REQUIRED: YES` 指本文件明确了旧方案未定的存储事务、协议安全例外和阶段边界，并修订了旧示例中的普通 rename/媒体记录流程；不改 Phase 1/2 的身份或相册权限语义。这些决定在本次设计中给出，实施者不得另选协议、锁或发布方式。

## 0. 依据、范围和现有实现

已读取根目录 AGENTS、PROJECT 上传/归属/去重/部署部分、ARCHITECTURE 上传/存储/原子化部分、ROADMAP Phase 3/4、逻辑 DATABASE_SCHEMA、Phase 2 最终总结，以及 storage、worker、API 认证边界、DB schema/transaction/connection/readiness 当前实现。

- [Phase 2 最终总结](PHASE-02-FINAL-SUMMARY.md) 已记录完整门禁通过。AGENTS 第 30 节仍停留在旧 Phase 1 blocker；本次以用户明确授权及最新总结为阶段事实，保留其余安全约束。
- [storage](../../packages/storage/src/index.ts) 目前只有占位导出；[worker](../../apps/worker/src/index.ts) 只有启动日志。当前没有可复用的文件持久化实现。
- [transaction](../../packages/db/src/transaction.ts) 提供三次总尝试、bounded jitter、rollback failure 丢弃连接、COMMIT unknown 不重放；Phase 3 继续复用。
- [HTTP guard](../../apps/api/src/auth/http.ts) 的写入 guard 当前同时要求可信 HTTPS Origin 和 JSON；tus PATCH 必须增加独立的、严格限定到 tus 路由的二进制协议 guard，不能直接移除现有检查。
- [schema](../../packages/db/src/schema.ts) 已有 family/member composite FK、BIGINT bigint 和二进制 hash 模式。新表沿用这些约定。

本阶段仅处理 `originals/`、`uploads/`、`temp/`，持久化物理对象及上传收据。不创建 media_items、album_media、processing jobs，不解码图片/视频，不做 EXIF、缩略图、转码、删除 original 或媒体下载 API。

旧 ROADMAP 中“上传目标相册授权”、旧 ARCHITECTURE 中“创建 media/album 关系并 enqueue job”延后到后续媒体接入阶段。Phase 3 上传成功只表示 storage ingest 完成；界面和 API 不得宣称已出现在相册/时间线。

## 1. Storage architecture 与核心不变量

采用本机 filesystem backend，API 内一个 StorageCoordinator 是 V1 唯一文件写入者。API route 只调用 service；service 调用 DB repository 和 packages/storage；route 不得操作绝对路径或 fs。

```text
Web tus client → Fastify protocol/auth guard → UploadService
                                             ├─ Phase 1 DB transaction helper
                                             └─ StorageCoordinator → LocalFilesystemStorage
                                                  ├─ uploads: resumable staging
                                                  ├─ temp: bounded chunk scratch
                                                  └─ originals: immutable final bytes
```

核心不变量：

1. DB `committed_offset` 只确认已持久化、连续无洞的前缀；文件长度不是自动可信的 offset。
2. `storage_objects.AVAILABLE` 和 `upload_sessions.COMPLETE` 只能在目标文件完成持久化屏障后于同一个 DB transaction 提交。
3. original 发布永不覆盖已有目标；发布后不再允许 write/truncate/rename-away/metadata rewrite。
4. 文件已存在而 DB 引用未提交是可恢复状态；DB 已确认成功而文件从未 durable 是实现错误。
5. fs 操作与网络流不能放入可自动重试的 transaction callback。事务重试只重读、校验和写 DB。
6. 上传资源归 family、操作权归原上传 member；object ID、hash、upload ID 都不是访问凭据。
7. 所有恢复/清理使用同一个 coordinator、路径验证和互斥规则。mtime 或 lease 过期不能授权第二个 writer。

Phase 3 worker 保持无存储写权限；启动恢复及周期 reconciliation 在持有 storage writer lock 的 API coordinator 中执行。独立 maintenance CLI 必须先停止该 writer 并取得同一锁。将来若拆多进程存储服务，应另做锁设计审查。

## 2. 上传协议：tus 1.0.0

最终选择 tus，而非自定义 offset 协议。使用维护中的 `@tus/server`，实现受本项目控制的 datastore/locker 适配层；禁止直接把默认 file-store 的 offset、元数据文件或清理行为作为第二权威来源。安装时固定与 Node 22.23.2 兼容的已审查版本和 lockfile，先验证 hook/stream/response 行为。

启用 tus core、creation、expiration；不广告 creation-with-upload、deferred-length、concatenation、checksum、termination。每个 PATCH 串行续传一个文件；多文件可有限并发。abort 使用应用 JSON endpoint，避免 tus termination 对“上传字节完成”的定义与 original 完成语义冲突。`Upload-Length` 必须在创建时给定；不接受无限流。

协议行为：

- OPTIONS 返回版本、明确支持的 extensions 和最大 size。
- 创建 POST 为 tus 空 body，返回 201、Location、Upload-Expires。不能发送 multipart/JSON body 冒充 tus。
- HEAD 返回 DB 的可信 offset、length、expires，禁止返回文件实际 speculative tail。
- PATCH 只接受 `application/offset+octet-stream`、`Tus-Resumable: 1.0.0`、有效整数 Upload-Offset；不做压缩请求体解码，拒绝非 identity Content-Encoding。
- offset 不相等返回 409 和当前可信 offset，无覆盖/补洞。旧 PATCH 重发也如此，客户端 HEAD 后再续传。
- 最后一块 PATCH 的 204 仅确认字节已接收；业务完成必须显式 JSON finalize 并查询 status。
- 不启用 tus 库自带 GET 下载，不允许路由兜底暴露 staging。

tus 定义续传 offset 和请求方法，不替应用定义 original durability。库的 POST_FINISH 在响应后通知，不能用它独自实现“成功前持久化”。上述为本项目适配决定。[tus 规范](https://tus.io/protocols/resumable-upload)、[官方 Node server 接口](https://github.com/tus/tus-node-server/blob/main/packages/server/README.md)。

## 3. State machine 与元数据

| State      | 含义与允许操作                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------- |
| CREATED    | DB session 已建立、offset=0；可能尚待创建空 staging。恢复可补建；不表示已上传字节                 |
| UPLOADING  | 至少提交一块；offset 可等于 declared_size，仍需 finalize；允许 HEAD/PATCH/status/abort            |
| FINALIZING | 完整 size/hash 及发布意图已提交；禁止 PATCH、abort、自动 expiry；允许 status/认证后 finalize 重试 |
| COMPLETE   | durable original + storage FK + 原上传者/文件名收据已提交；只允许幂等查询/finalize，不允许 abort  |
| FAILED     | 不可恢复的 staging/校验问题；终态，使用新 upload 重传；不删除已发布 original                      |
| ABORTED    | 所有者撤销未进入 FINALIZING 的 staging；终态                                                      |
| EXPIRED    | 未完成会话超过固定有效期；终态                                                                    |

合法转换：CREATED → UPLOADING → FINALIZING → COMPLETE；CREATED/UPLOADING → FAILED/ABORTED/EXPIRED。FINALIZING 遇到暂时错误保持原状等待恢复；经明确完整性判定可 → FAILED，但磁盘 candidate 必须保留并审计。终态不能重新进入 UPLOADING。状态迁移用 expected state/offset 条件更新并检查 affectedRows=1；CHECK 不能替代转换逻辑。

session 固定有效期 7 天，创建后不滑动延长。空闲超过 24h 仅标记可观察，不据此删除仍未到期会话。DB server time 在锁后读取；FINALIZING 不受普通 upload expiry 清理。认证 session 自己的 30 天/7 天限制照常生效。

| 元数据                  | 最终规则                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| original filename       | 展示/收据字段；有效 Unicode、1–255 code points 且 UTF-8 ≤1024 bytes；拒绝 NUL、控制/双向控制字符；斜杠、点、全角字符绝不参与路径；展示必须文本转义 |
| reported MIME           | nullable，≤127 ASCII chars，禁止控制/CRLF；仅 hint，不用于授权、路径或响应 Content-Type                                                            |
| declared size           | 必填正十进制整数；创建时上限和配额预留；必须与最后实测完整长度相等                                                                                 |
| client hash             | Phase 3 输入白名单不接受；不能据此跳过上传或返回已有对象                                                                                           |
| capture hints/extension | Phase 3 不接受 capture hints；扩展名只属于 filename，不独立信任或决定文件类型                                                                      |
| actual size/SHA-256     | 从稳定 staging fd 全量读取计算，DB 保存 bigint/BINARY(32)                                                                                          |

`Upload-Metadata` 总长度 ≤4 KiB，字段名严格白名单 filename/filetype，禁止重复 key、非法 base64、非法 UTF-8；不回显任意 metadata。敏感 body 和 filename 不进入日志。

## 4. Path layout、平台能力与 immutable originals

仅使用配置传入的 root。DEV 为本机独立 `<MEDIA_ROOT>`（例如 `/path/to/family-album-data/dev`），未来 PROD 为外接 SSD 上的独立 `<MEDIA_ROOT>`（例如 `/Volumes/<external-ssd>/family-album-data/prod`）。两套 root 不得共用 originals。本次没有访问这些媒体目录。

最终布局：

```text
MEDIA_ROOT/
  .storage-root                 # 人工初始化的随机 volume/root 标识，非 secret
  .writer.lock                  # 稳定 inode，生命周期内绝不 unlink/recreate
  originals/<family-id>/<h0h1>/<h2h3>/<sha256-lowerhex>-<byte-size>
  uploads/<family-id>/<upload-id-lowerhex>/payload
  temp/chunks/<upload-id-lowerhex>/<request-id-lowerhex>
```

family/id/size 使用服务端 canonical 十进制或固定长度小写 hex。所有分量都是固定语法的内部标识。full hash 只作为内部对象 key，不返回客户端；同内容不同 family 生成不同实体文件，不跨 family hard-link。

物理 key 基于 family + server hash + size；DB storage object ID 是独立 BIGINT。filename 与两者彻底解耦。采用 hash key 是为了崩溃后可重复定位唯一 candidate，不需要依赖一次性随机 rename 结果。存储 key version 固定为 1，迁移到其他 backend 时由 provider 解析。

### 4.1 文件系统威胁边界

- 文件树由专用服务 UID 拥有，目录 0700、staging/scratch 0600，umask 077；发布前 fchmod 为 0400 并关闭全部 write fd。检查 ACL，不允许额外主体拥有写权限。
- root 及所有子目录不能是 symlink，不允许用户可写祖先目录、不允许 mount/subvolume 切换；原有 root marker 不匹配即 UNAVAILABLE，不能自动 mkdir 出一个“新的空盘”。
- 逐分量以已打开的 directory fd 做 `openat`/`mkdirat`/`unlinkat`，directory 要求 O_DIRECTORY/O_NOFOLLOW，文件使用 O_CREAT|O_EXCL|O_NOFOLLOW；fstat 验证 regular file、uid、mode、st_dev 和 nlink=1。
- 后续操作只用固定目录句柄和受验证单个 basename；不能检查 realpath 后再用未经固定的全路径打开。realpath/root containment 仅作启动辅助，禁止 startsWith(root) 授权。
- 拒绝现存 symlink、设备、FIFO、socket、异常 hard link；不跟随它们做 hash、读写或递归删除。请求 filename 无论如何编码都不能进入这些 syscall。
- 服务 UID 被攻陷或 root 任意改盘不在应用内可防范围；本设计防 HTTP 路径注入、预置恶意目录项和协作进程竞态，不能把 chmod 当 WORM 硬件。

### 4.2 macOS 最小原生能力边界

Node 22 的 fs 接口不能直接表达本设计要求的全部 dirfd/no-replace/full-sync 操作。packages/storage 内需要一个小型、无特权的 Darwin native adapter（绑定方式在实现中评估，不能通过 shell 拼路径）。仅包装目录句柄、受控文件打开/删除、flock、exclusive rename、full sync；不带网络、DB、权限业务。

发布最终使用同 filesystem 的 `renameatx_np(..., RENAME_EXCL)`，目标存在必须 EEXIST；绝不回退为普通 rename、copy-over 或 unlink-target。逐分量目录句柄已拒绝 symlink；系统支持时可附加 NOFOLLOW_ANY/RESOLVE_BENEATH，但不能假定所有 macOS 版本支持新增 flags。native 操作核验源 fd 的 dev/inode 与源 basename 一致。

先在隔离 synthetic 目录验证平台/volume 能力；不支持则上传写能力关闭并停止后续上传实现，进入 R3 复核，不能悄悄降级。这个适配层是原始文件安全所需的窄平台接口，不引入第二个存储服务。[Apple rename 定义](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/rename.2)、[Node 22 fs](https://nodejs.org/docs/latest-v22.x/api/fs.html)。

## 5. Size、容量、限流与错误

V1 初始默认（由可信 DEV 配置覆盖并在启动验证）：单文件 32 GiB；PATCH 最大 16 MiB；最多两个正在接收 body 的请求；单 member 最多 4 个 active uploads，单 family 最多 16；全局 active declared-size 预算 128 GiB；family 逻辑预算 256 GiB。所有大小始终使用 bigint 计算；调用要求 number 的 tus/Node 接口前显式安全范围断言，绝不将 BIGINT ID 转 number。

保留磁盘空间 `max(10 GiB, total-volume-bytes * 10%)`，外加 64 MiB scratch/元数据余量。以 statfs 可用空间（面向服务用户）为准，不以磁盘标称容量判断。每次创建和写块前验证：

```text
available >= reserve + outstanding-physical-commitments + scratch-budget + new-reservation
```

outstanding commitments 是已承诺而尚未持久化的剩余字节；未知 DB/文件状态按未释放计。新文件创建在 coordinator 短 admission mutex 内串行化预留并落 DB，避免两个请求同时消费同一空间。进程启动先从 DB 和磁盘重建账目才进入 READ_WRITE。单进程写入前提使此 mutex 有效；其他程序仍可用掉磁盘，实际写入错误始终是最终依据。

family 预算计 distinct storage object bytes（包括不健康对象）+ 所有未完成/待清理上传声明大小 + 可归属 orphan 占用；保守双计允许，少计不允许。只有可信完成/实际清理确认后释放预留；unknown commit 不释放。无需新增 quota 表或 Redis，使用当前受限规模的聚合查询和 coordinator 账目。未知 orphan 无法归属时计全局占用并阻止自动写入恢复。

每个 stream 独立累计实际读取字节，超过 chunk limit、remaining length 或 admission reservation 立即停止，返回 413，不提交 offset。Content-Length 不能绕过累计计数；不接受负数、指数、溢出、重复冲突长度 header。通过 backpressure 进行固定大小 buffer 流式处理。

短 write 必须循环直到完整，0-byte write 视为错误。ENOSPC、EDQUOT → 507 `INSUFFICIENT_STORAGE`；EIO、掉盘、sync failure → 503 `STORAGE_UNAVAILABLE` 并降级能力；库/驱动消息不透出。不能把“写调用成功、sync 失败”记为成功。

body idle timeout 30s、单 PATCH 总时间 120s；读取 body 前校验认证和资源归属、预留并发槽。create/finalize 控制请求初始限速 member 20/min、IP 60/min，PATCH/HEAD member 120/min，bounded map 与清理沿用安全限流模式；明确可信代理配置，默认不信任 XFF。达到上传并发上限 429/Retry-After，不开放无界等待队列。

## 6. Chunk write 和 resume correctness

所有针对同 upload 的 HEAD/PATCH/finalize/abort/recovery 通过同一个 upload mutex；不会与库再构造相反锁序的第二个 locker。coordinator 持有全生命周期的 root OS `flock(LOCK_EX|LOCK_NB)`，第二个 writer 无法启动；不能只靠 DB GET_LOCK 或过期 lease 防文件并发。

单块流程（upload mutex 覆盖全流程，DB 锁只覆盖短事务）：

1. T1 锁后认证、family/member/upload ownership、状态/expiry/offset 校验，读取当前 committed_offset；退出事务。到齐前绝不写 original。
2. body 接收到独立 scratch；实际长度 ≤16 MiB 且 ≤remaining；完整 body 后关闭 scratch writer。中断 body 只丢弃该 scratch，可信 offset 不变。
3. T2 在实际 append 前重新验证认证/状态/offset，退出事务。修复已确认的 speculative tail 后，从 staged offset 定位写入 scratch 内容，循环处理 partial write；不得 O_APPEND、不得跳过 offset 建洞。
4. 对 payload 做完整 durable barrier，再关闭 write fd。此时文件可能比 DB offset 长，但仍是不可见 staging。
5. T3 按锁序重读用户/session/member/upload，锁后重新读取 DB 时间，复核 token hash、client type、revoke、absolute/idle expiry、member active、upload expiry 和旧 offset；条件 UPDATE offset/state/updated_at，affectedRows=1；仅已提交才发送 204 和新 offset。
6. T3 明确 rollback/认证失效时，保持 upload mutex，重新从健康 DB 读当前提交 offset，按该值 truncate 尚未发布的 payload，再 sync。若 DB 不可用或 COMMIT unknown，先冻结此 upload；禁止猜旧 offset truncate，也不返回成功。
7. T3 commit 成功但响应丢失：HEAD 返回新 offset，旧 PATCH 重试 409；不得把重复 body 再追加。

T1/T2/T3 使用同一事务 helper；不得让 callback 捕获可重放的 append。T3 与 logout/disable 以 DB 锁提交顺序定义线性化点：若 revoke 先提交，T3 必须失败；若 T3 先提交，已接收该块合法，随后请求失败。跨 idle/absolute deadline 的等待用锁后新时间判定。

恢复时 file length > DB offset：在确认非 FINALIZING/COMPLETE 且 DB commit 结果已解析后裁剪额外尾部；file length < DB offset：标记 FAILED，不允许造零补齐或降低已确认 offset。检查长度不能证明无洞，连续写不变量及崩溃注入测试共同保证。HEAD 不能在未协调恢复时报告一个实际缺失的已确认前缀。

FINALIZING/COMPLETE 可能已经 rename 走 staging：HEAD 必须按状态解析可信 candidate/object，不能因 payload 不存在而误判丢失或补建空文件。FINALIZING 不再接受 PATCH；COMPLETE 的 HEAD 可报告已提交 length，但不提供下载。

## 7. SHA-256、去重与 logical media 边界

finalize 在 upload mutex 内、无 DB 长事务情况下，从关闭所有 writer 后的稳定 fd 全量流式 SHA-256；验证 fstat size=declared=offset，读满实际字节，读取前后 dev/inode/size 一致。客户端 hash 不参与结论。进程重启后必须重新全量计算，不能恢复未经认证的内存 hash 状态。

DB 使用独立的 `BINARY(32)` content hash custom type（32-byte Buffer），复用现有 binary 映射模式但不把字段命名为 tokenHash。唯一性 `(family_id, sha256, byte_size)`；不同 size 同 hash 不作为同对象。

最终语义选“共享 storage object，保留每次上传收据”。Phase 3 不创建第二个 media item，也不直接返回其他人的 logical media。每个完成的 upload_session 永久保留 uploader、filename、reported MIME、完成时间与 storage_object_id；它就是 Phase 3 的 durable upload event，不按 staging TTL 删除 COMPLETE rows。后续阶段可从这份收据幂等生成/复用 media_items 与上传关系。

同 family 第二次相同文件返回自己的 uploadId/COMPLETE，内部引用同一 storage object；不返回 deduped 标志、content hash、storage ID、首次上传者、其他文件名，避免变成隐藏 CUSTOM 内容查询 API。用户必须先完整上传，禁止 hash-existence endpoint。允许受限运行时间差，不提供“已知 hash 直接领取文件”能力。

去重命中还要确认已有文件安全、size/hash 匹配；本阶段每次复用全量重校验 existing file（小规模，正确性优先）。MISSING/CORRUPT 不能成功去重、不能覆盖修复；停止并告警，未来独立恢复流程处理。

## 8. Database schema（设计，不执行 DDL）

只新增两张表；InnoDB、utf8mb4_0900_ai_ci，UTC DATETIME(3)，严格 SQL mode；Native FK=1、session FK checks=1。所有 BIGINT UNSIGNED 通过 bigint/decimal string 映射，last insert id 使用 CAST AS CHAR。

### 8.1 storage_objects

| 字段        | 类型与约束                                                                           |
| ----------- | ------------------------------------------------------------------------------------ |
| id          | BIGINT UNSIGNED PK auto increment                                                    |
| family_id   | BIGINT UNSIGNED NOT NULL                                                             |
| sha256      | BINARY(32) NOT NULL                                                                  |
| byte_size   | BIGINT UNSIGNED NOT NULL，CHECK >0                                                   |
| key_version | SMALLINT UNSIGNED NOT NULL DEFAULT 1，CHECK =1                                       |
| state       | ENUM AVAILABLE/MISSING/CORRUPT NOT NULL；INSERT 显式 AVAILABLE，不提供默认 AVAILABLE |
| durable_at  | DATETIME(3) NOT NULL，首次 verified publication 时间，非 staging 创建时间            |
| verified_at | DATETIME(3) NOT NULL，最近完整校验时间                                               |
| created_at  | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)                                    |
| updated_at  | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)，沿用应用层更新                    |

PK(id)；UNIQUE `uq_storage_objects_family_id(family_id,id)`；UNIQUE `uq_storage_objects_family_hash_size(family_id,sha256,byte_size)`；INDEX `idx_storage_objects_state_verified(state,verified_at,id)`。FK family_id → families.id，RESTRICT/RESTRICT。

CHECK `chk_storage_objects_size`、`chk_storage_objects_key_version`、`chk_storage_objects_verified`（verified_at >= durable_at）。durable_at 可以早于 created_at，因为先落盘再插入 DB；不要加反向错误 CHECK。

不保存用户 filename/MIME、不保存绝对路径、不保存 ref_count。storage key 由 key_version/family/hash/size 纯函数生成；不接受客户端 storage_key。物理 identity 字段不可 UPDATE；state 仅受健康校验控制。AVAILABLE 只是 durable bytes、未验证媒体类型，不等于媒体解码安全。

### 8.2 upload_sessions

| 字段                 | 类型与约束                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| id                   | BIGINT UNSIGNED PK auto increment，仅内部使用                                              |
| public_id            | BINARY(16) NOT NULL，crypto.randomBytes(16)，URL 严格 32 lowercase hex；非 bearer secret   |
| family_id            | BIGINT UNSIGNED NOT NULL                                                                   |
| created_by_member_id | BIGINT UNSIGNED NOT NULL                                                                   |
| original_filename    | VARCHAR(255) NOT NULL，应用另外执行 byte/code-point 限制                                   |
| reported_mime        | VARCHAR(127) NULL，应用 ASCII/控制字符限制                                                 |
| declared_size        | BIGINT UNSIGNED NOT NULL                                                                   |
| committed_offset     | BIGINT UNSIGNED NOT NULL DEFAULT 0                                                         |
| state                | ENUM CREATED/UPLOADING/FINALIZING/COMPLETE/FAILED/ABORTED/EXPIRED NOT NULL DEFAULT CREATED |
| computed_sha256      | BINARY(32) NULL，仅 server hash；finalize intent 后冻结                                    |
| finalize_started_at  | DATETIME(3) NULL                                                                           |
| storage_object_id    | BIGINT UNSIGNED NULL，仅 COMPLETE 填写                                                     |
| completed_at         | DATETIME(3) NULL                                                                           |
| terminal_at          | DATETIME(3) NULL，仅 FAILED/ABORTED/EXPIRED                                                |
| failure_code         | VARCHAR(48) NULL，服务端枚举短码；仅 FAILED 非 NULL，绝不存原始错误                        |
| expires_at           | DATETIME(3) NOT NULL                                                                       |
| staging_cleaned_at   | DATETIME(3) NULL，物理清理确认；COMPLETE 去重 loser 也可能有 staging                       |
| created_at           | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)                                          |
| updated_at           | DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)，应用更新                                |

索引：PK(id)；UNIQUE `uq_upload_sessions_public_id(public_id)`；INDEX `idx_upload_sessions_family_creator_state(family_id,created_by_member_id,state,id)`；INDEX `idx_upload_sessions_state_expiry(state,expires_at,id)`；INDEX `idx_upload_sessions_family_object(family_id,storage_object_id)`；INDEX `idx_upload_sessions_cleanup(state,staging_cleaned_at,id)`。

FK：family_id → families.id；(family_id,created_by_member_id) → family_members(family_id,id)；(family_id,storage_object_id) → storage_objects(family_id,id)。均 RESTRICT/RESTRICT；不 cascade 删除收据或 original。共 4 个新 FK（storage 1、upload 3），另有 1 个新表间同 family FK 包含在这 4 个内。

必须生成以下具名 CHECK（SQL 用显式 IS NULL/IS NOT NULL，避免 UNKNOWN 绕过）：

- `chk_upload_sessions_size_offset`：declared_size>0 AND committed_offset<=declared_size。
- `chk_upload_sessions_expiry`：expires_at>created_at。
- `chk_upload_sessions_created`：CREATED ⇒ offset=0。
- `chk_upload_sessions_uploading`：UPLOADING ⇒ offset>0。
- `chk_upload_sessions_finalize_pair`：computed_sha256 与 finalize_started_at 同空/同非空。
- `chk_upload_sessions_finalize_state`：FINALIZING/COMPLETE ⇒ hash/start 非空且 offset=declared；CREATED/UPLOADING/ABORTED/EXPIRED ⇒ 两者为空；FAILED 允许保留已冻结 hash/start，并要求存在时 offset=declared。
- `chk_upload_sessions_complete`：COMPLETE ⇒ object/completed 非空且 terminal 为空；其他 state ⇒ object/completed 均空。
- `chk_upload_sessions_terminal`：FAILED/ABORTED/EXPIRED ⇔ terminal_at 非空。
- `chk_upload_sessions_failure`：FAILED ⇔ failure_code 非空（应用白名单，DB 再限制允许的短码）。
- `chk_upload_sessions_times`：所有非空 start/completed/terminal/cleaned 时间 >= created_at；completed>=finalize_started_at；staging_cleaned_at 非空只允许 COMPLETE/FAILED/ABORTED/EXPIRED。

预计 13 个新 CHECK（storage 3、upload 10）；实施中需核对生成 DDL 数量及语义，不能仅对数量测试。跨表的 hash/size 相等、状态转换、权限和磁盘存在性不能用这些 CHECK 证明，必须由锁后 repository 校验。

没有 media_items 的 Phase 3 仍能正确表达 dedupe 和上传归属。完成收据是未来 media pipeline 的持久输入；后续创建 media_items 必须以 upload ID 幂等关联，不能只凭首次上传 metadata 覆盖其他上传者记录。

## 9. Atomic finalize 与 fsync/durability

### 9.1 最终协议

取得 upload mutex，先做短事务基础认证、ownership 和状态校验；状态 COMPLETE 时核对 storage 健康状态后做已授权幂等查询，不重新创建引用。其他状态确认 offset=size，停止所有写入。首次 finalize 的 hash 在事务外计算；重试 FINALIZING 时，若 staging 已移走，使用该行冻结的 hash/size 定位 candidate，重新完整核验，不能要求客户端重传或建立空 staging。随后取得 `(family_id,sha256,size)` 的 hash mutex（进程内，受全局唯一 writer 保证），持有到最终状态确定或进入冻结恢复。

1. **T-intent**：锁 family → user → auth session → family_member → upload_session；锁后 fresh DB time 复核当前认证、归属、active、expiry、offset/state；首次 UPDATE FINALIZING + server hash + finalize_started_at。重试已有 FINALIZING 则核对冻结意图，不重置 hash/start、不重新套用普通 upload expiry。只在已知 commit 成功后继续。若 commit unknown，暂停，用新连接解析 intent 是否提交，不盲目 publish。
2. **核对目标**：通过 canonical key 查文件和 storage row。已有健康对象时校验其 bytes；没有对象时使用当前 immutable staging。全程无 DB 行锁，持有 upload/hash mutex，读取 stream 受全局 hash 并发上限 1 约束。
3. **准备发布**：fstat regular/owner/nlink/size，hash 已匹配；chmod 0400，文件 sync/full-sync，关闭 write fd。创建目标目录时同步新目录及其父目录。不得复制到另一个 filesystem；EXDEV 直接失败。
4. **无覆盖发布**：exclusive rename 到目标；EEXIST 必须重新打开已有目标并核验，不能把它当自动去重成功，更不能覆盖。目标 bytes 不一致则完整性事件，保持 candidate，拒绝完成。
5. **持久化命名空间**：fsync source 和 destination 目录（及新建父目录），再对同 volume 的已打开目标 fd 执行 F_FULLFSYNC 屏障；核验 root/volume identity 仍一致。任何 sync 错误都不能进入成功 DB commit。
6. **T-complete**：按既有 auth 锁序 + upload → storage 锁序重读状态；锁后新 server time 复核当前请求 token、session/user/member 有效，检查 intent/hash/size。FINALIZING 已在 expiry 前接受意图，不因普通 upload expiry 中断，但认证 expiry 始终检查。SELECT/INSERT 唯一 storage object（AVAILABLE）并写 upload storage FK/COMPLETE/completed_at。检查条件更新 affectedRows=1；二者同事务提交。
7. 已知 commit 成功才返回完成；随后清理 loser staging/scratch，更新 staging_cleaned_at；清理失败不会撤销已完成 original，只告警并重试清理。

T-complete 内只处理 DB；其输入 durability receipt 为进程内服务生成且仅在持有 writer/upload/hash mutex 时有效，不能来自客户端或持久化缓存。无 writer 的 mutex 间隙、重启、volume 变化后必须重新验证文件并执行所需屏障。

授权在 T-complete 失效：不创建成功引用；final 文件保留为可恢复 candidate，用户重新登录且同一 member 有效后可重试。恢复进程不得凭旧认证代替用户自动将其置 COMPLETE。

### 9.2 持久化承诺

顺序是 payload durable → final namespace durable → DB COMPLETE commit。macOS 普通 fsync 不等于驱动缓存已清空；本设计要求 native full-sync 屏障，包含已 fsync 的目录元数据。库不支持、filesystem 不支持、调用失败都 fail closed，不能在 catch 中忽略。

这保证应用采取平台提供的持久化操作，不承诺坏硬件、控制器谎报或物理损坏时永不丢失；外接盘必须重新通过能力/掉线测试。DB 连接健康之外，写入 readiness 还需只读检查 InnoDB commit durability 配置（至少 innodb_flush_log_at_trx_commit=1；binlog 若用于恢复还要评估 sync_binlog=1），不自动修改全局变量。未满足时禁止上传完成写入。

[Apple fsync 说明](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html) 与本机 SDK fcntl 手册支持 full-sync 区分；必须在目标盘执行 synthetic capability tests。SIGKILL 测试验证进程崩溃，不等于完成断电验证。

## 10. Concurrency/locking 与相同内容竞争

锁层次：root OS exclusive writer lock（进程生命周期）→ admission 短锁或 upload mutex → 必要时 hash mutex → 短 DB transaction。admission 锁不等待 upload/hash 锁；不能持 DB 行锁再等待 mutex。每个操作最多持一个 upload mutex，hash owner 不反向等待另一个 upload。

DB 顺序保留 Phase 1/2：families → users 数值 ID → sessions 数值 ID → family_members 数值 ID → albums → album_members；Phase 3 不锁 albums，追加 upload_sessions 数值 ID → storage_objects。hash 全量读取、网络 body、fsync 都在 DB transaction 外。所有事务锁后再读 server time，重试重新授权。

两台设备同 family 同 hash：先分别安全接收/hash，随后 hash mutex 串行发布。winner 建一个 canonical original + storage row；loser 校验复用，自己的上传收据依然完整；unique(family,hash,size) 是 DB 最后防线。如果出现预期外 duplicate/deadlock，已确认 rollback 后重读并校验；不运行第二套 retry。

COMMIT unknown 永不自动重放整个操作、不自动删除文件。新连接只能解析结果；无法确定就 503、保持冻结。客户端重试按同 upload ID/state 继续显式幂等协议；这是已查明状态后的恢复，不是重发未知的 COMMIT。

超时/客户端断开不能提前释放仍有 I/O 的 mutex。取消后先停止并 await/drain 当前 stream/native operation，关闭 fd，再进入恢复或释放锁；不能让旧写入在新请求开始后继续。响应断开时尚未开始 T-complete 则保留 intent 并停止完成提交；已经发送 COMMIT 则按结果/unknown 协议解析，不以断网推断 rollback。

仅靠 MySQL named lock/lease 不能隔离已失去 DB 连接但仍写磁盘的旧进程。本设计选 OS writer lock + 单进程多个 upload mutex，专门关闭这个窗口；不引入 Redis/distributed filesystem lock。

## 11. Crash recovery / reconciliation

写服务启动先取得 root lock、核对 marker/volume、MySQL health 与当前完整 migration readiness，进入 UNAVAILABLE/恢复中；完成账目和未决 offset 恢复后再 READ_WRITE。周期任务同样取得对应 mutex，禁止仅凭“超过几分钟”抢占 writer。

| 观察到的状态                                 | 必须行为                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CREATED offset=0 无 payload                  | 未过期时可安全 O_EXCL 补建空 payload；过期按 EXPIRED 处理                                    |
| UPLOADING payload 长于 committed_offset      | 解析 commit 结果后，exclusive mutex 下裁剪 staging 尾部、sync；不能裁剪 original             |
| UPLOADING payload 短于 offset/缺失           | FAILED，保留诊断；禁止补洞/把 offset 回退装作成功                                            |
| FINALIZING + staging 存在 + final 不存在     | 保留/hash 重校验；等待有效原上传者请求重试，不能使用旧 session 代授权                        |
| FINALIZING + final 存在 + storage row 不存在 | 视为持久化意图支持的 candidate；核验/保留，认证后重试建引用                                  |
| storage AVAILABLE + upload COMPLETE          | 核对 file，清理残余 staging；重试返回同 upload 完成结果                                      |
| final 存在但 DB 完全无对应意图/对象          | 登记 sanitized integrity event，保留文件；禁止自动删除、导入可见媒体或跨 family 采用         |
| storage row 存在但 final 缺失                | 先排除掉盘；确认正确 volume 后标 MISSING，read/dedupe 失败；禁止新建同名空文件               |
| final bytes/hash 不匹配                      | 标 CORRUPT，停止复用/读取，禁止上传路径覆盖修复                                              |
| staging/scratch 无 DB session                | root lock + 完整健康 DB 查询确认，再经 24h grace 与二次扫描，仅清理指定 staging/scratch 文件 |
| stale UPLOADING                              | 未过 7 天可 resume；过期事务置 EXPIRED 后清理；不因重启重置 expiry                           |
| FINALIZING 长时间停滞                        | 记录 stuck 告警与待恢复状态，保留 intent/file；不自动转 EXPIRED/删除 candidate               |

final 无 DB row 但有同 family 的可信 FINALIZING 意图时，另一合法完整上传可在 hash mutex 下逐字节 hash 验证后采用同一 candidate。不存在可信意图时需维护审查，不自动认领来历不明文件。

orphan final 本阶段的 reconciliation 是发现、核验、保留和安全重新关联，**不包含自动 original GC**。空间不足不能成为删除它的理由。原上传者停用后 candidate 可以长期保留并计容量；后续维护回收另审。

恢复不得扫描 Production、跟 symlink、按用户 filename 定位、调用 bootstrap 或执行未审查 migration。DB 不可用时所有可能删除/裁剪/发布动作停止。

## 12. Abort、expiry 和 temp cleanup

abort 只允许 active 原上传 member，且 state 为 CREATED/UPLOADING；认证/归属和锁后时间均重新检查。持 upload mutex 先事务置 ABORTED，再精确 unlink payload/scratch、fsync 父目录，最后写 staging_cleaned_at。中途崩溃由清理重试完成。

重复 ABORTED 对已授权调用者幂等成功；FINALIZING/COMPLETE 返回 409 `UPLOAD_NOT_ABORTABLE`。没有任何从 upload → storage object → unlink original 的调用路径。终态 receipt 和 FK 不删除。

expiry 采用同样先 state 后清理协议。cleanup 与 chunk/finalize 使用同一个 mutex；活动请求不能被后台删除。清理不做宽泛 recursive rm，仅对服务生成、已验证的 exact entries 操作。temp 是单块短时 scratch，不存最终完整副本、derived 或 processing 输出；uploads 是可信 staging 前缀。两者都有独立配额。

## 13. Storage capabilities / read-only

接口始终返回 READ_WRITE / READ_ONLY / UNAVAILABLE 与公开短 reason：

- READ_WRITE：root/volume/locks、权限、atomic publish、sync、容量、DB 条件满足。
- READ_ONLY：已知有效盘可安全读取，但写入被维护模式/权限/安全余量关闭；拒绝 create/PATCH/finalize/abort 的变更及 cleanup。应用普通 metadata 浏览保持可用。
- UNAVAILABLE：掉盘、marker 不符、路径/完整性异常、未完成必要恢复或能力未知；不假装读取成功，禁止写入和自动建立替代目录。

没有路径 fallback 到工作目录、系统 temp 或内置盘。外接 SSD 恢复后须人工/受控 preflight 确认同 volume/root，再恢复能力，不能仅因目录重新出现自动 RW。

StorageProvider 概念接口（设计签名，不是本次实现）：

```ts
interface StorageProvider {
  capabilities(): Promise<StorageCapabilities>;
  createUpload(identity: InternalUploadIdentity): Promise<void>;
  writeChunk(input: VerifiedChunkWrite): Promise<DurablePrefixReceipt>;
  statUpload(identity: InternalUploadIdentity): Promise<StagedStat>;
  hashUpload(identity: InternalUploadIdentity): Promise<VerifiedContent>;
  finalizeUpload(intent: VerifiedFinalizeIntent): Promise<DurableObjectReceipt>;
  openOriginal(
    object: AuthorizedInternalObject,
  ): Promise<ReadonlyOriginalHandle>;
  abortUpload(identity: TerminalStagingIdentity): Promise<void>;
  verify(object: InternalObjectIdentity): Promise<IntegrityResult>;
  reconcile(plan: ValidatedRecoveryPlan): Promise<RecoveryResult>;
}
```

StorageProvider 不自行决定用户权限或提交 DB；UploadService/coordinator 负责编排。readonly handle 不含 write/truncate/rename/delete。不暴露通用 move、putOriginal(overwrite)、deleteOriginal；未来读媒体必须先经过对应媒体/相册权限服务。Phase 3 无公共 storage list/read/download endpoint。

## 14. Auth、IDOR、Origin 与 file type

create 只要求有效用户/session + active family membership，所有角色一致；不要求 recent-auth，不提前依赖 album。route familyId 由服务器锁后归属检查；不接受 body 中的 memberId/role/storage key/albumId。

所有 HEAD/PATCH/status/finalize/abort：先基础认证，再按 public_id 定位并在锁后确认同 family 且 created_by_member_id=当前 member。其他 member（包括 ADMIN/SUPER_ADMIN）、跨 family、缺失统一 404；不能因 ID 难猜而放松检查。原上传者换浏览器/重新登录可 resume，session 本身必须当前有效；不把 upload 固定绑定某个已过期 auth session。

Web 继续 Secure/HttpOnly/SameSite=Lax Cookie；拒绝 Authorization 或 Cookie/Bearer 混用。tus 外层 guard 必须在原始流交给库之前执行，并将验证 context 以内部对象传递，不能从客户端 header 重建授权身份。

- JSON finalize/abort 复用现有 exact HTTPS Origin + JSON guard。
- tus POST/PATCH 有独立 exact Origin 检查，必须有允许的 HTTPS Origin；PATCH 另外强制 tus headers 和二进制 Content-Type；POST body 长度为 0。此例外只注册到 tus 路由，不降低其他 JSON API。
- HEAD/status 若携带 Origin 同样校验；全部返回 Cache-Control:no-store。credentialed CORS 只给 exact allowlist，Vary:Origin，禁止 wildcard；Location 使用配置中的可信 API origin，不能用任意 Host/X-Forwarded-Host 拼接。
- OPTIONS 无需 auth，只返回通用协议能力，不查 upload 存在性；允许的方法/header 和 expose offset/length/location/expires 明确白名单。
- 未来 Android Bearer 单独实现经过审核的 client-type 路由适配；Phase 3 不能因为 Android 支持 tus 而提前接收未实现的 Bearer 登录通道。

文件类型最终选择：Phase 3 接收限额内任意非空 bytes 作为未分类 object。不基于可伪造扩展名/MIME 做“安全”判断，不启动 media decoder/解压/脚本执行；JPEG/PNG/WebP/GIF/HEIC/RAW/DNG/MP4/MOV/HEVC 因此不会被浅 magic allowlist 误拒。文件不托管为静态 URL、不 inline 浏览器打开、不由服务器执行。后续媒体 pipeline 做受限 sniff/解析和支持格式拒绝；AVAILABLE 不承诺是有效图片。允许 arbitrary bytes 的空间滥用用认证、大小、限流和配额控制。

## 15. API contracts

| Endpoint                                    | 输入/结果                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OPTIONS /api/v1/uploads/tus[/:uploadId]     | 通用 tus capability，204                                                                              |
| POST /api/v1/families/:familyId/uploads/tus | tus Upload-Length + bounded Metadata，空 body；201 + 可信 Location                                    |
| HEAD /api/v1/uploads/tus/:uploadId          | 当前 owner auth；200 + committed offset/length/expiry，空 body                                        |
| PATCH /api/v1/uploads/tus/:uploadId         | tus offset + bounded binary stream；204 仅在 durable prefix 与 DB offset 已提交                       |
| GET /api/v1/uploads/:uploadId               | 最小 status：uploadId/state/declaredSize/committedOffset/expiresAt/completedAt/允许公开的 failureCode |
| POST /api/v1/uploads/:uploadId/finalize     | strict JSON {}；仅已知完成返回 200 COMPLETE；处理中超时/中断不返回业务成功，使用 status 与同 ID 重试  |
| POST /api/v1/uploads/:uploadId/abort        | strict JSON {}；成功 204；FINALIZING/COMPLETE 409                                                     |

V1 finalize 使用单次受认证请求编排，不增加后台自动 COMPLETE 或 202 工作队列。处理时间上限默认 15 分钟，达到上限安全停止并返回 503/Retry-After；原始请求断开后仍需完成 I/O drain/commit 结果解析。客户端从 status 查状态并 authenticated finalize 重试。全量 hash 前状态可能仍为 UPLOADING、offset=length，意图提交后才显示 FINALIZING；status 走受认证短 DB 快照，无需等待长 hash mutex。HEAD/PATCH 的等待队列必须有限，不能让慢 hash 堆满请求。

所有 JSON 大小/offset 采用十进制 string，tus headers canonical 十进制。错误 body 使用稳定 code/message/requestId；HEAD 不返回 JSON body。401 UNAUTHENTICATED、404 NOT_FOUND、409 OFFSET_MISMATCH/UPLOAD_STATE_CONFLICT、410 UPLOAD_EXPIRED（仅确认 owner 后）、413 UPLOAD_TOO_LARGE、415 INVALID_CONTENT_TYPE、429 RATE_LIMITED、503 STORAGE_UNAVAILABLE/OUTCOME_UNKNOWN、507 INSUFFICIENT_STORAGE。协议版本错误遵从 tus 412。底层路径/hash/driver error/stack 不在响应中。

POST create 响应丢失可能留下一个 CREATED 会话，不以 filename 去重；允许客户端新建，由严格 active quota/TTL 回收旧会话。UI 保存每个 tus Location 与本地文件关联，不跨账号共享 fingerprint；不记录服务器 credential。

## 16. Audit/logging

实现事件：upload_created/chunk_committed/upload_finalize_started/upload_completed/upload_failed/upload_aborted/upload_expired/storage_capability_changed/storage_integrity_issue/recovery_action。

白名单：event、requestId、upload public ID、family/member ID、byte counts、state、duration、reasonCode。原上传者与每次完成存 upload_sessions；日志不替代 durable receipt。

禁止 filename、reported MIME、绝对路径、raw/full/短 hash、file/chunk body、Upload-Metadata、Cookie、Authorization、credential body、原始 driver/syscall Error。tus 自带日志必须适配/禁用，确保 logger 输出和异常路径测试覆盖，不能只配置 Pino redaction 就允许整包 request。

Phase 3 不新增 persistent audit storage；后续安全事件存储继续列为 production gap。测试日志使用 synthetic 内容标记，断言所有路径（含库错误和恢复）均不泄漏。

## 17. Migration plan

拟新增 `packages/db/drizzle/0002_phase_03_storage_uploads.sql`，仅 storage_objects、upload_sessions 及本节对应索引/FK/CHECK；先创建 storage_objects 后 upload_sessions。文件名/序号须以实施时当前 journal 校验，不能覆盖已有 migration。

同步 Drizzle schema、生成 SQL、snapshot/meta；review 通过后停在 MIGRATION_READY 等用户授权。preflight：DEV DB=family_album_dev、MySQL 9.7.2、non-root、Native FK/FK checks=1、Phase 1/2 完整 journal、现有 schema match、新表均不存在。不得 import database/schema.sql。

通用 readiness helper 的 schema collection 当前列举七张业务表：新表必须加入同一 Drizzle-derived collection，不能新增第二套手写 schema manifest。执行前 preflight 校验旧 manifest/schema，执行后 readiness 校验新 manifest/schema；不能用尚未执行的新 manifest 导致无法合法 preflight。

验收包括复合 FK 的跨 family INSERT/UPDATE ERROR 1452、所有 CHECK invalid rows、binary hash round-trip、BIGINT exact string、unique dedupe 竞态及 snapshot 一致性。所有测试 synthetic、清理 fixtures，不 bootstrap。DDL 不跨 fs 做 transaction，也不因迁移创建任何 original。

## 18. Test matrix 与 P0/P1 风险

| 范围           | 必须证据                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path           | ../、绝对路径、NUL/Unicode/编码分隔符 filename 不影响 path；中间/末端 symlink、目录交换、pre-existing target、hard link/FIFO 拒绝；root 相似前缀不可穿越                              |
| Native/volume  | O_EXCL、dirfd traversal、RENAME_EXCL EEXIST 不覆盖、same-volume、EXDEV 拒绝、file/dir/full-sync 失败、root marker/mount 更换、第二进程 writer 拒绝                                    |
| Upload         | normal/断网/resume、完整/不完整 body、短 write/0-byte write、wrong offset/overlap/hole、duplicate retry、两 PATCH 同 offset 只有一个提交                                              |
| Limits         | 声明小/实际大、Content-Length 缺失/欺骗/冲突、大小溢出、chunk/body timeout、并发 admission、reservation 重启重建、ENOSPC/partial write/sync failure                                   |
| Hash/type      | 已知 SHA-256 fixtures、false client hash 不被采用、空文件拒绝、支持目标 bytes 不因扩展名拒绝、上传内容从不解码/执行/静态公开                                                          |
| Dedupe         | 同 family 同 bytes 一个 storage row/一个 final；两个 upload 收据；不同 family 两个物理对象；existing file 损坏不复用；dedupe 响应不泄漏他人 metadata                                  |
| Chunk crash    | append 前、partial append、sync 后 DB 前、commit 后响应前 SIGKILL；恢复 offset/尾部一致；unknown commit 不 truncate 已提交 bytes                                                      |
| Finalize crash | intent 前后、rename 前、rename 后 DB 前、dir sync 失败、DB rollback、COMMIT response 丢失；无假 COMPLETE、无 overwrite、重试稳定                                                      |
| Auth race      | body/hash/lock wait 期间 revoke/rotation/password-change/member-disable/idle/absolute expiry；commit 前重新验证；不同 owner/ADMIN/SUPER_ADMIN/cross-family 一律不能 resume/abort/read |
| Abort race     | abort vs chunk、abort vs finalize，两种顺序；FINALIZING/COMPLETE 从不删 original；cleanup vs live writer 不抢占                                                                       |
| Recovery       | stale upload、DB session 无文件、orphan staging、orphan final、DB outage、同 volume 恢复、未确认 volume 不标全库 MISSING、不使用旧 session 自动完成                                   |
| DB             | 同 family FK/check/unique、hash Buffer、BIGINT>2^53、state 更新 affectedRows、deadlock bounded retry、rollback failure discard、commit unknown no replay                              |
| Protocol/HTTP  | 真 tus client Web resume；Origin/null Origin、CSRF、CORS、Cookie/Bearer conflict、proxy spoof、库 GET 下载被拒；真实 HTTPS Cookie 上传                                                |
| Logs           | 实际 Pino/tus/native adapter 输出不含 secret/content/filename/path/hash；只输出短 error code                                                                                          |

race tests 必须用真实 MySQL 两连接 + 受控 query-arrival/lock-wait 信号，filesystem 操作另有可控屏障；sleep 后“未完成”不能作为唯一锁证据。临时 DB/文件 fixtures 的清理是测试 harness 专用显式权限，不能复用成 runtime original-delete API。

P0 实现阻断条件：普通 rename 覆盖、路径逃逸、原文件可写、文件尚未 durable 就提交 COMPLETE、跨 family 复用/公开原文件。任何一项出现立即停止实施并复核。

P1 实现阻断条件：offset 长度推断/并发写洞、I/O 进入 transaction retry、commit unknown 自动删/重放、清理正在 finalize 文件、旧认证在长流后被继续信任、metadata/body 日志泄漏、用可失效 DB lease 代替 writer lock、容量无限接收。

本次设计未发现需要改变 Phase 1/2 权限模型的事项。尚未做 native/APFS 能力验证、断电验证、真实 tus/HTTPS E2E；这些是后续实现验收，不能用本文或前两阶段 PASS 代替。persistent audit、production 限流、硬件可靠性和后续媒体安全解析也不能宣称已交付。

## 19. Implementation order 与停止点

1. **3A：平台与路径最小 slice**。native adapter、root marker/权限/volume 检查、OS writer lock、exclusive publish/full-sync 的 synthetic capability tests。失败即停，不采用普通 rename fallback。
2. **3B：DB/contract**。两张新表、state/error/schema tests、Drizzle snapshot、通用 readiness 更新；生成 migration 后 review → MIGRATION_READY → 等执行授权。
3. **3C：受认证 tus staging**。严格 protocol guard、datastore、流限制、容量预留、chunk durable offset、resume/auth/crash tests。不得在此步宣称 original finalize 完成。
4. **3D：finalize/dedupe/recovery**。intent、hash mutex、无覆盖 durable publish、DB completion、unknown commit 解析、abort/expiry/cleanup；真实 race + 子进程 kill tests。
5. **3E：最终验证**。storage capability/read-only、日志、HTTPS tus E2E、MySQL/FK/CHECK/并发、故障注入；targeted 通过后实施 review、安全复核及完整 Phase 3 gate。

本次只新增此设计文档；未修改业务代码、数据库或 migration，未开始上传实现，未进入 Phase 4。实施中若无法满足平台屏障、身份锁序或回收不变量，输出 `R3_DESIGN_REVIEW_REQUIRED`，不能自行改安全模型。
