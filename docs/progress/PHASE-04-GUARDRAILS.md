# Phase 4 — Media Processing Pipeline Guardrails

Status: R3-DESIGN completed; implementation has not started. This document is the Phase 4 implementation baseline. 本次只编写设计；未修改业务代码、数据库或 migration，未执行媒体处理或 cleanup。

```text
PHASE_4_GUARDRAILS
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: YES
MEDIA_ITEMS_REQUIRED: YES
DERIVED_ASSETS_TABLE_REQUIRED: YES
PROCESSING_JOBS_TABLE_REQUIRED: YES
VIDEO_TRANSCODE_IN_PHASE_4: NO
READY_FOR_PHASE_4_IMPLEMENTATION: YES
```

`DESIGN_CHANGE_REQUIRED: YES` 指本文件明确批准的增量：逻辑媒体与任务模型、finalize 的小型 DB 入队步骤、original 只读能力、独立 derived writer、跨上传/derived 的容量 admission。Phase 3 原始文件写锁、immutable/no-overwrite、事务失败策略继续有效。实现不得自行另选锁模型或降低隔离要求。READY 表示可按第 20 节开始 4A；解析器和文件写入必须先通过对应能力验收。

## 1. 本地证据与范围

审查依据：[AGENTS](../../AGENTS.md)、[产品媒体/去重要求](../../project-spec/PROJECT.md)、[架构](../../project-spec/ARCHITECTURE.md)、[Phase 4 路线](../../project-spec/ROADMAP.md)、[逻辑数据库方案](../../project-spec/database/DATABASE_SCHEMA.md)、[Phase 3 最终总结](PHASE-03-FINAL-SUMMARY.md)。实现定位：

- [schema](../../packages/db/src/schema.ts)：当前 9 张业务表；`storage_objects` 的 `(family_id, sha256, byte_size)` 唯一；`upload_sessions` 保存每次上传的 filename、uploader、COMPLETE receipt 和同家庭 storage FK。
- [completeFinalize](../../packages/db/src/upload-repository.ts)：当前在同一事务完成 storage object 与 receipt 更新；没有 media/job 创建。锁序是 family → actor user/session/member → upload → storage object。
- [transaction helper](../../packages/db/src/transaction.ts) 与 [checked connection](../../packages/db/src/connection.ts)：3 次总尝试、有界 jitter、rollback 失败销毁连接、COMMIT unknown 不重放、DB UTC/health 检查。
- [StorageRoot](../../packages/storage/src/index.ts) 与 [native open_root](../../packages/storage/native/storage_native.c)：当前打开 root 必须取得 `.writer.lock`，所有者为 API；只有 originals/uploads/temp 能力，没有可直接给 worker 的 original 只读句柄或 derived publisher。
- [startup recovery](../../apps/api/src/uploads/startup.ts) 和 [reconciler](../../apps/api/src/uploads/recovery.ts)：恢复、staging 清理仍由持 original writer lock 的协调进程负责。
- [worker](../../apps/worker/src/index.ts) 仅启动日志；[media package](../../packages/media/src/index.ts) 是占位；没有现成 queue 可复用。复用事务安全 helper，新增 MySQL queue，物理表名采用架构已有名称 `background_jobs`。
- lockfile 中 Sharp 是现有依赖链的一部分，不等于 worker 已声明、审核或验证其解码能力。本次 PATH 检查未找到 ffmpeg、ffprobe、ExifTool；没有安装软件或测试工具能力。

Phase 4 提供内部处理、受控 reprocess/reconciliation 和状态模型，不新增公开 media read/download/metadata URL，不实现相册媒体关系、AI、标签/评论、Trash、地图、动态照片配对、Android 或 Phase 5 UI。

## 2. Canonical media 与重复上传

最终规则：**同 family 的一个 canonical storage object 对应一个 media item**。`UNIQUE(family_id, storage_object_id)` 强制此规则；跨 family 始终不同 object/media/job/derived。

```text
多个 COMPLETE upload receipts
  └─ 同 family + storage_object_id
       ├─ 一个 storage_object（immutable bytes）
       └─ 一个 media_item（timeline/未来收藏、评论、Trash 的逻辑身份）
             ├─ 按 generation 的 background_jobs
             └─ 按 kind/recipe/generation 的 derived_assets
```

- receipt 是上传事件，不是逻辑照片。保留每次上传的 uploader、original filename、reported MIME、completed time；原字段继续是不可信展示 hint。
- media 的 `source_upload_id` 指首次成功完成的 receipt；历史 backfill 按 `(completed_at, id)` 升序选取。`uploaded_at` 取该 receipt 的 completed time。重复上传不改变 source、timeline fallback、metadata、generation 或首次上传人。
- filename/uploader 从 source receipt 关联获取，不复制进 storage object。需要按“所有曾上传者/文件名”搜索时关联全部 COMPLETE receipts；不能只查首次上传者。Phase 4 保留这些 receipts，不做自动裁剪；未来归档必须先迁移 provenance。
- 后续 `album_media` 关联 media id；重复上传加入相册是独立、重新授权的操作。Phase 4 不建立它，不推断“上传者拥有所有相册权限”。
- 未来 notes/comments/favorites/Trash 绑定 media id；同字节再上传不暗中创建第二条时间线或恢复已删除媒体。Trash/重新上传恢复语义留给相应 R3 设计，本阶段没有删除状态。
- receipt 的 client id/filename 不作为 dedupe 或 processor key。不同字节、相同 filename 是不同 media。

## 3. DB schema：三张新表

全部 InnoDB、项目现有 utf8mb4 collation；FK `RESTRICT/RESTRICT`，不引入级联删除。id/FK/generation/lease_epoch/byte_size 使用 `BIGINT UNSIGNED`，应用内部 BigInt、SQL/API 十进制 string，禁止经不安全 JS Number。所有时间采用 `DATETIME(3)`；实际瞬时时间由 DB UTC 提供。无时区拍摄日期按下述独立 local 字段处理。所有 ENUM 和 CHECK 在 Drizzle/SQL/snapshot/readiness 保持一致。

### 3.1 media_items

| 字段                                           | 定义与规则                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| id / family_id / storage_object_id             | 非空；id PK                                                                                              |
| source_upload_id                               | 非空，首次 COMPLETE receipt；不可被重复上传修改                                                          |
| uploaded_at                                    | 非空，首次 receipt.completed_at，immutable fallback                                                      |
| media_type                                     | UNKNOWN / IMAGE / VIDEO / OTHER，默认 UNKNOWN                                                            |
| detected_mime                                  | nullable VARCHAR(127)，只能写服务器格式映射的 MIME                                                       |
| processing_state                               | PENDING / PROCESSING / READY / PARTIAL / FAILED / BLOCKED                                                |
| generation                                     | 非空，初始 1；reprocess 单调 +1，溢出拒绝                                                                |
| recipe_id                                      | SMALLINT UNSIGNED，初始 1；服务端批准 recipe registry 的 key                                             |
| metadata_generation                            | nullable；表示已提交 metadata 所属 generation                                                            |
| raw_width / raw_height                         | nullable INT UNSIGNED，来自选定主图/主视频流                                                             |
| display_width / display_height                 | nullable INT UNSIGNED，应用 orientation/rotation/SAR 后的显示尺寸                                        |
| duration_ms                                    | nullable BIGINT UNSIGNED；有限、非负、最多 24h；不可信巨大数拒绝                                         |
| orientation                                    | nullable TINYINT UNSIGNED，只能 1–8；视频使用 rotation 字段                                              |
| video_rotation_degrees                         | nullable SMALLINT，只存规范化 0/90/180/270；不支持变换记 warning                                         |
| is_animated / motion_hint                      | BOOLEAN；motion_hint 仅表示检测到相关标记，不表示已配对/可播放                                           |
| captured_local_at                              | nullable DATETIME(3)，保留有效拍摄墙钟时间                                                               |
| captured_at_utc                                | nullable DATETIME(3)，只有可信显式 offset/UTC 来源才填写                                                 |
| captured_offset_minutes                        | nullable SMALLINT，-840..840；不存推测的 IANA timezone                                                   |
| captured_source                                | NONE / EXIF_ORIGINAL / EXIF_CREATE / XMP_ORIGINAL / XMP_CREATE / QUICKTIME_CREATION / CONTAINER_CREATION |
| captured_time_status                           | ABSENT / OFFSET_KNOWN / OFFSET_UNKNOWN；invalid 的原因用 warning                                         |
| timeline_key                                   | 非空 DATETIME(3)，排序键而非承诺为 UTC 的瞬时值；规则见第 7 节                                           |
| timeline_basis                                 | CAPTURE_LOCAL / UPLOAD_UTC                                                                               |
| gps_latitude / gps_longitude                   | nullable DECIMAL(9,6) / DECIMAL(10,6)，必须成对为空或成对有效                                            |
| camera_make / camera_model                     | nullable VARCHAR(128)，规范化控制字符/长度；不存序列号                                                   |
| video_codec / video_container / video_transfer | nullable VARCHAR(32)，服务端已知值映射；transfer 可为 SDR/PQ/HLG/UNKNOWN                                 |
| warning_flags                                  | BIGINT UNSIGNED，批准 bitset，初始 0；CHECK 不得有未定义位                                               |
| last_failure_code                              | nullable 受控 ENUM，见第 15 节；不存 Error message                                                       |
| created_at / updated_at                        | DB UTC 非空；保持项目应用层 updated_at 方式                                                              |

索引/FK：

1. UNIQUE `(family_id, storage_object_id)`；UNIQUE `(family_id, id)`。
2. timeline INDEX `(family_id, timeline_key, id)`；processing INDEX `(processing_state, id)`。
3. FK `(family_id, storage_object_id)` → storage_objects `(family_id, id)`。
4. FK `(family_id, source_upload_id, storage_object_id)` → upload_sessions `(family_id, id, storage_object_id)`。为此 migration **只新增** upload_sessions 上对应 UNIQUE，保留现有 CHECK/FK。该约束防 source receipt 指向另一家庭或另一个 object；来源必须 COMPLETE 还由现有 receipt CHECK 和创建事务验证共同保证。
5. CHECK generation/recipe >= 1；metadata_generation NULL 或 `1 <= metadata_generation <= generation`；尺寸每对成对存在且 >0；duration 限界；orientation/rotation 白名单；GPS 成对及范围；captured 字段与 status 配对；failure/warning 白名单。READY 要求 `metadata_generation = generation`，其跨表资产条件由事务验证。

不把任意 EXIF JSON、raw XMP、ICC blob、完整 ffprobe 输出放进 DB。可重复生成的数据仍有必要的 provenance/version，避免不知来源地覆盖人工编辑；人工 metadata override 不在本阶段。

### 3.2 derived_assets

| 字段                         | 定义与规则                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| id / family_id / media_id    | 非空；id PK；同 family FK → media_items                                                   |
| generation / recipe_id       | 非空；记录产物对应的处理版本                                                              |
| kind                         | THUMBNAIL / PREVIEW / VIDEO_POSTER                                                        |
| state                        | RESERVED / PUBLISHING / READY / MISSING / FAILED                                          |
| reserved_bytes               | 非空 BIGINT，创建时按 kind 的输出上限；清理确认后才释放                                   |
| byte_size / sha256           | nullable BIGINT / BINARY(32)；PUBLISHING/READY 必须有完整值                               |
| width / height / output_mime | nullable；PUBLISHING/READY 为经过校验的正数尺寸和 image/webp                              |
| producer_job_id              | 非空；FK `(family_id, media_id, producer_job_id)` → background_jobs 同 scope unique tuple |
| producer_lease_epoch         | nullable BIGINT；指定 `.tmp` 位置，绝不接受客户端值                                       |
| failure_code                 | nullable controlled ENUM                                                                  |
| published_at / cleaned_at    | nullable；cleaned_at 表示该记录相关文件已安全清除，不表示 original 删除                   |
| created_at / updated_at      | 非空                                                                                      |

UNIQUE `(family_id, media_id, generation, recipe_id, kind)`；INDEX `(state, id)`、`(family_id, cleaned_at, state, id)`。路径由字段构建，不存任意绝对路径或 client path。CHECK generation/recipe >0、digest/size 配对、size>0 且不大于批准 kind 上限、READY/PUBLISHING 完整性、READY 时 published_at 非空且 cleaned_at 为空、时间顺序。producer job 的 generation/recipe/type 与 kind 配对在锁后验证；CHECK 不能跨表，不能声称 DB 单独验证了这一点。

### 3.3 background_jobs（即 processing jobs table）

| 字段                                    | 定义与规则                                                     |
| --------------------------------------- | -------------------------------------------------------------- |
| id / family_id / media_id               | 非空；同 family FK → media_items                               |
| generation / recipe_id                  | 非空；所有结果带同一 generation fence                          |
| job_type                                | MEDIA_PROBE / IMAGE_DERIVATIVES / VIDEO_POSTER                 |
| state                                   | QUEUED / RUNNING / RETRY_WAIT / SUCCEEDED / FAILED / CANCELLED |
| attempts / max_attempts                 | TINYINT UNSIGNED，初始 0/3；0 <= attempts <= max_attempts <= 3 |
| available_at                            | 非空；基于 DB UTC                                              |
| locked_at / heartbeat_at / locked_until | nullable；RUNNING 时非空，其他状态全部为空                     |
| worker_id                               | nullable BINARY(16)，每次进程启动的随机身份；只供内部识别      |
| lease_epoch                             | 非空 BIGINT，初始 0，每次 claim +1；不能复用过期 epoch         |
| last_failure_code                       | nullable controlled ENUM                                       |
| created_at / updated_at / finished_at   | 前两项非空；finished_at 在终态非空                             |

UNIQUE `(family_id, media_id, generation, recipe_id, job_type)`；UNIQUE `(family_id, media_id, id)`；claim INDEX `(state, available_at, id)`；lease INDEX `(state, locked_until, id)`。CHECK RUNNING lease 字段配对、epoch>0、heartbeat>=locked_at、locked_until>heartbeat、终态时间配对、generation/recipe、attempt 范围及 failure code 白名单。不存任意 executable、shell、URL、JSON task payload；所有 handler 来自代码白名单。

只有三个新增表，不建 media_metadata、media_locations、upload_events、album_media、tags/comments/faces/Trash 表。本阶段已有 receipts 足够保存上传历史。

## 4. 从 COMPLETE 入队与历史数据接入

最终选择：**扩展现有 completeFinalize 的短 DB transaction**，不在 finalize 执行 parser/Sharp/FFmpeg。

1. Phase 3 已完成 SHA、durable original publish、锁后授权/完整性复核。
2. 同一 transaction 将 receipt 更新为 COMPLETE，创建/复用 media，首次创建时 enqueue generation 1 的 MEDIA_PROBE。
3. family 和 storage unique key 串行化同家庭重复上传。existing media 只读取复用，不重置 generation/state，也不重复 enqueue。
4. 新的 media/job 插入导致等待后，必须再次读取 DB server time 并复核 Phase 3 caller/session/ownership 和 object state，再 COMMIT。不能把新增等待放在最后一次 auth 检查之后。
5. COMMIT unknown 继续沿用 Phase 3 行为：不成功响应、不删除 original、不自动重放。下一次认证后的 finalize retry 查询 COMPLETE/object/media/job 后返回真实结果；COMPLETE 分支也能幂等补齐尚未接入的历史 media。

另有内部、分页的 backfill/repair：查 COMPLETE receipt 中尚无 media 的 object，按 family 串行短事务锁定；同 object 选择最早 `(completed_at,id)` source；确认 object AVAILABLE；创建同一 media/job 唯一键。无需 HTTP，也无需启动旧 upload 的 session。DB 不健康/不完整查询时停止。不能仅在进程内发 enqueue event；不能以递增 receipt-id 水位作为唯一发现机制（旧 receipt 可能较晚才 COMPLETE）。

历史 backfill 不是 migration DML：0003 只建结构/索引，部署后由受控 DEV 命令或 worker 注册循环执行。先通过完整 manifest/schema readiness，遇到 MISSING/CORRUPT object 保留 receipt 并报告，恢复健康后再接入。首次接入不改变 original 或已批准的相册权限。

## 5. Jobs 与逻辑状态机

合并用户列出的 MEDIA_PROBE、IMAGE_METADATA、VIDEO_PROBE 为 **MEDIA_PROBE**：先安全 magic sniff，再只进入对应的 metadata probe。它写一次受限 metadata，成功后原子 enqueue IMAGE_DERIVATIVES 或 VIDEO_POSTER。避免同一 metadata 被两个 job 互相覆盖。

IMAGE_DERIVATIVES 一次 job 顺序生成 THUMBNAIL/PREVIEW；成功的 kind 可在后续 retry 复用。VIDEO_POSTER 只生成一张 poster。无 transcode、无所有帧、无独立 EXIF 循环任务。

media.processing_state 是 **当前 generation 的汇总**，不是 original health：

| 状态       | 定义                                                                  |
| ---------- | --------------------------------------------------------------------- |
| PENDING    | 当前 generation 尚未开始，含排队/backoff                              |
| PROCESSING | 有有效 RUNNING lease；stale projection 由 recovery 校正               |
| READY      | probe 完成，当前类型所要求的全部资产 READY，object 仍 AVAILABLE       |
| PARTIAL    | 类型/metadata 或至少一个可用资产已确认，但其余能力不可用/任务终态失败 |
| FAILED     | 无法可信识别/解析，且当前 generation 没有可用处理结果                 |
| BLOCKED    | 原始存储 MISSING/CORRUPT、root/DB readiness 不满足，禁止继续处理      |

optional GPS/拍摄时间缺失只产生 warning，不阻止 READY。unsupported HEIC/RAW 可为 PARTIAL；损坏媒体编码和 storage SHA mismatch 是两个不同概念，前者绝不把 storage object 自动标 CORRUPT。即使 media FAILED/PARTIAL，AVAILABLE original 的保存及未来经授权访问均不受影响。未来读取必须另查 storage health，不能仅依赖可能暂时滞后的 media 汇总。

所有状态/metadata/jobs/asset 引用提交均锁 media 行、使用当前 generation/recipe，避免 lost update。执行中的旧 generation 不能覆盖新 generation；聚合只统计当前 generation。任何文件/CPU 工作不在 DB transaction 内。

## 6. MIME 与格式支持边界

从固定 read-only original FD 读取至多 64 KiB 做受限 magic/container sniff；不得据此单独判“安全”。之后使用批准的 decoder/probe 验证。只调一个匹配的处理链，避免把任意输入轮流交给所有工具。SVG/PDF/HTML、playlist、archives、可执行文件、未知格式均 original-preservation-only，不交 Sharp 的宽泛 loader。reported_mime 与 extension 不参与路由、命令或输出路径。

| 格式                  | metadata/probe                             | thumbnail/preview                                         | poster / 最终策略                            |
| --------------------- | ------------------------------------------ | --------------------------------------------------------- | -------------------------------------------- |
| JPEG / PNG / WebP     | 是，真实 bytes + Sharp/受限 EXIF           | 是，限尺寸/资源                                           | 保留 original                                |
| GIF / animated WebP   | 是；animation 标记有界                     | 仅第 0 帧静态图；不展开所有帧                             | 动画 original 不变                           |
| HEIC                  | container + EXIF 可用时提取                | 只有已安装 build 的 HEVC 解码 synthetic probe PASS 才开启 | 缺能力 PARTIAL，不伪称完整支持               |
| RAW / DNG             | ExifTool allowlist 字段，机型/子格式按能力 | Phase 4 不做完整 RAW 解码，也不抽任意内嵌预览             | original + metadata，PARTIAL                 |
| MP4 / MOV，H.264      | ffprobe 受限字段                           | 无视频 preview 文件                                       | 一个 poster                                  |
| HEVC/H.265，4K        | 对真实安装 decoder 验证                    | 无 transcode                                              | 能力可用才 poster，否则 PARTIAL              |
| HDR PQ/HLG            | 保留 transfer/primaries 受限信息           | 无 original 改写                                          | 验证过的 tone-map→SDR poster；缺能力 PARTIAL |
| unknown / unsupported | UNKNOWN/OTHER 与稳定 failure code          | 不生成假图                                                | 只保留 original                              |

HEIC 的实际能力取决于 libvips/libheif/codec build，不能由文件扩展名或 npm 安装成功推断；需固定工具版本、构建特征和 synthetic samples。[Sharp 安装说明](https://sharp.pixelplumbing.com/install/)、[HEIF 输出/codec 说明](https://sharp.pixelplumbing.com/api-output/)。不在本次自动安装全局 codec。

Motion/Live Photo：仅存 `motion_hint` boolean；保留全部原始 bytes，包括 JPEG appended payload。单独上传的 MOV/JPEG 各按 canonical object 建 media，不自动配对，不存未经需要的设备标识/配对 UUID，不宣称动态播放已支持。

## 7. Metadata、captured time、GPS、orientation

### 7.1 Extraction

图片使用 Sharp probe 尺寸/type；ExifTool 只读提取受控 EXIF/XMP 字段。每次独立进程、禁用自动配置加载（固定 `-config ''`）、固定 tag allowlist、numeric GPS/Orientation、JSON 最大 64 KiB。禁止 client flags、`-@` 参数文件、写入选项、raw metadata 全量输出、外部 sidecar 自动发现。完整 XML/XMP 只在隔离 parser 内处理，不在 API 解析实体或访问外部 URL。配置/参数组合须用实际版本验证。[ExifTool application documentation](https://exiftool.org/exiftool_pod.html)。

字符串限制 Unicode/UTF-8 长度、移除控制/双向格式字符；camera make/model 仅展示数据，永不进入文件路径/SQL拼接/命令。工具 JSON 仍视为不可信输入，通过 contracts 严格字段、深度、条数、数值范围校验；不直接 spread 到 DB。

### 7.2 Captured time 的唯一规则

图片优先级：EXIF DateTimeOriginal + 同源 SubSec/OffsetTimeOriginal → XMP DateTimeOriginal（同一字段内 offset）→ EXIF CreateDate + 同源 offset → XMP CreateDate → upload completion。忽略文件 mtime、GPS 推算 timezone、服务端 timezone、通用 ModifyDate。

视频优先：明确带 offset 的 QuickTime creationdate → 明确 UTC/offset 的 container creation_time → 无 offset 的批准 creation date（保留 local）→ upload completion。不得静默开启“把所有 QuickTime 整数日期当 UTC”的推断；含义不能确定时标 OFFSET_UNKNOWN。视频创建时间可能是导出时间，保留 source 不声称一定是真实拍摄瞬间。

- 严格验证 Gregorian 日期、月份/天数/闰年、时分秒和 subsecond；不允许 JS Date 自动进位，不对无 offset 字符串调用依赖本机时区的 Date parser。
- sane bounds：1900-01-01 起，至 source receipt.completed_at 的 UTC 日历值 +48h；超界丢弃该候选并 warning，尝试下一来源。不能检测所有“合法但设备钟错误”的值，不按上传时间静默校正。
- 缺失/非法 offset：有效 local 日期可保留为 OFFSET_UNKNOWN，非法 offset 记 warning；不生成 captured_at_utc。显式 offset 只能 -14:00..+14:00，边界小时 14 的分钟必须 00；UTC 转换结果也须在 sane bounds。
- `captured_local_at` 保存原始 local 日历字段；已知 offset 才填 `captured_offset_minutes`、`captured_at_utc`。没有 offset 不假定上海/UTC，也不从 GPS 反推。
- **timeline_key = 有效 captured_local_at，否则 uploaded_at 的 UTC 日历字段**；timeline_basis 区分二者。它是产品按拍摄日历排序的稳定键，不是统一 UTC 时间轴；跨时区无 offset 的真实先后无法证明。SQL keyset 使用 `(timeline_key,id)`，界面日后必须保留 uncertainty；真正瞬时值另存 captured_at_utc。
- 全部无效则 captured 字段 NULL/status ABSENT，timeline 使用首次 upload time。reprocess 可改提取结果但永不改 original，未来人工时间修订需独立 override 设计。

### 7.3 GPS 与方向

GPS 先验证 finite、DMS/ref 合法再转十进制；lat -90..90、lon -180..180，NaN/Infinity、缺半对或矛盾 hemisphere 全对丢弃并 warning，不无限 retry。保存六位小数；不保存所有 GPS tags，不 reverse-geocode，不打印坐标。

原始 orientation 只接受 1..8；缺失为 NULL，生成时按 1；非法记 warning 并按 1。derived 执行完整 mirror/rotate 映射，不只处理 90°。raw dimensions 与 display dimensions 分开；orientation 5..8 交换宽高。视频 rotation/矩阵和 sample aspect ratio 受限解析；只支持经过测试的标准正交变换，复杂矩阵输出 unavailable，不能任意拼 filter。original 的方向 tag 和容器始终不变。

## 8. 图片派生与 Sharp 边界

recipe 1 只生成两种 WebP：

| kind      | 最大包围盒 | 规则                             | 编码/字节上限       |
| --------- | ---------- | -------------------------------- | ------------------- |
| THUMBNAIL | 480×480    | inside、保持比例、无裁剪、无放大 | quality 75，512 KiB |
| PREVIEW   | 2560×2560  | inside、保持比例、无放大         | quality 82，4 MiB   |

先做 orientation，再转标准 sRGB，移除 EXIF/XMP/GPS/原 ICC（必要色彩转换后）及 animation payload；只输出静态 WebP。透明度保留；不保留 metadata 的 `withMetadata/keepMetadata`。参数、encoder/decoder 版本、色彩转换、orientation 和尺寸算法共同构成 recipe；build 变动不得偷偷继续写同一 recipe。WebP 满足现有 Web/未来 Android 方向，AVIF/几十种规格不在 Phase 4。

每个 decoder 子进程 `limitInputPixels = 50_000_000`、单边 <=16,384、image original <=512 MiB、`unlimited=false`、`animated=false`、`page=0/pages=1`、失败阈值明确为损坏即拒绝。metadata probe 也在隔离进程并设限；声明尺寸和实际 decode 结果均校验。禁止对完整超大 original `readFile→Buffer`。RAW/DNG 不进入普通 TIFF 解码分支。有关 constructor 像素/page 开关以 [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/) 为依据。

`sharp.concurrency(1)`；cache 关闭或固定很小预算（V1 关闭），一个 job 的两种输出顺序生成。pixel/header 限制、cache、V8 heap limit 都不能单独证明 native 内存有硬上限；还有第 12 节的进程资源控制。[Sharp global properties](https://sharp.pixelplumbing.com/api-utility/)。

输出超字节上限停止并记 OUTPUT_LIMIT；不无限降 quality 重试。encoder 结果由可信协调器做 bounded 长度/格式/尺寸/hash 校验后才发布；任何失败不影响原始对象状态。

## 9. 视频 probe/poster 与 FFmpeg 边界

V1 只处理本地自包含 MP4/MOV。ffprobe 固定 `show_entries` allowlist、JSON <=64 KiB、最多检查 16 个 stream 的受限输出；只选确定的主 video stream（default disposition 优先，再最小 index，排除 attached picture），忽略 subtitle/data/attachment。宽高、duration、codec、rotation、transfer 都经过范围检查。

poster 时间：duration 有效时 `min(duration_seconds * 0.1, 3)`，确保小于 duration；无/零 duration 则尝试第一帧一次。只取一帧、最长边 1280、不放大、去音频/subtitle/data，输出 WebP quality 80、<=1 MiB。EOF/损坏/无帧是受控失败；不得遍历整个视频寻找成功帧。

rotation 只执行一次；明确控制工具自动旋转，避免与应用手工旋转重复。PQ/HLG 通过固定、测试过的 tone-map/filter recipe 输出 SDR；缺 zscale/tonemap/decoder 能力则 poster unavailable，保留 HDR original。无完整播放兼容转码、HLS、低码率 preview 或硬件加速隐式 fallback。

调用要求：

- 固定已批准 executable 绝对路径与版本，`spawn/execFile` argv array、`shell:false`、stdin 关闭；不让 PATH/client 决定二进制；不记录完整 argv。
- 输入来自 storage 开出的 **seekable read-only FD**。优先已验证的 `fd:` + 独立 `fd` option，不能拼 `fd:3` 假定其支持。禁止用 `pipe:` 冒充可 seek 输入；缺能力不得 fallback 到 client filename。[FFmpeg protocols](https://ffmpeg.org/ffmpeg-protocols.html)。
- input protocol allowlist 只含所需 `fd`，output 只含 `pipe`；禁止 http/https/tcp/udp/concat/concatf/subfile/data/crypto/playlist 等。强制 MOV demuxer 范围；不让任意识别类型启用其它 demuxer。
- 显式 `enable_drefs=0`、`use_absolute_path=0`、`export_all=0`、`export_xmp=0`；不读外部 tracks/sidecar。协议白名单不是文件读取 sandbox。[MOV 安全选项](https://www.ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp)。
- 固定 probe budget（probesize 8 MiB、analyzeduration 5s），wall timeout probe 20s/poster 60s；以外部 watchdog 为准。一个 input、一个映射 stream、一个 frame；禁止任意 filter expression/concat list、硬件设备、raw user metadata interpolation。
- decode/filter threads=1、关闭 stdin 交互、限制单次 allocation（若实际 build 支持）；它们不等于总 RSS 限制。stderr 内存 cap 16 KiB，超量终止；不打印 raw stderr，stdout cap 按 JSON/图像类型分别执行。stdout/stderr 被持续 drain，不能因管道堵塞漏掉 timeout。
- 所有 option 必须对固定版本 capability probe 验证，未知 option 失败即关闭相应能力，不删安全参数“试到成功”。

## 10. Storage capabilities、path 与写锁扩展

**当前 `StorageRoot.open()` 不可由 worker 原样调用**：它会与 API 的原始写锁竞争。增加三个窄能力：

1. `OriginalReader`：打开已有 marker-bound root，仅 pin root/originals dirfd，O_RDONLY/O_NOFOLLOW 逐分量打开指定 `(family,sha,size)` original；检查 regular/uid/mode/nlink/device/marker/实际 size。无 initialize、mkdir、chmod、rename、unlink、staging 访问，无 `.writer.lock` 竞争。
2. `DerivedStore`：只 pin `MEDIA_ROOT/derived`；独立 `.derived-writer.lock`，一个 V1 coordinator 在整个生命周期独占；用原 root marker + derived marker + 同 volume 验证。第二个 worker coordinator 不得绕过锁启动文件写入。维护 CLI 先停该 coordinator 再取同锁。API 的 `.writer.lock` 继续只管 Phase 3 域。
3. 共享短 `.capacity.lock`：第 13 节容量预留跨 API/worker 串行化；独立稳定 inode，绝不 unlink/recreate。

derived 初始化仅显式 DEV provisioning，在既有 root 身份验证后创建并 sync；worker 常规启动不自动创建丢失 root、不“修复”错误 mount。原有 native APIs 不增加 generic overwrite 参数；为 derived 增加目的专用入口，native 层也验证 path class。不能只在 TS 层改 regex 就让 destructive primitives 接受任意相对路径。

固定布局：

```text
MEDIA_ROOT/
  .storage-root / .writer.lock                 # Phase 3 原有
  .capacity.lock                              # 新增，短预留锁
  originals/ uploads/ temp/                    # Phase 3 域不变
  derived/
    .derived-root / .derived-writer.lock
    <family-id>/<media-id>/r<recipe>/g<generation>/<kind>.webp
    .tmp/<job-id>/e<lease-epoch>/<kind>.part
```

所有组件来自服务端 strict decimal/kind registry；不包含 filename、MIME、raw SHA、metadata 或客户端路径。固定 dirfd + O_NOFOLLOW/O_EXCL、single link、same filesystem、owner/ACL/permissions 和 root identity 检查沿用 Phase 3 原则；reader/derived handles 不能互换。temp 也属于 derived 域，不进入 Phase 3 temp/chunks，不被 Phase 3 cleanup 扫描。

render child 不拿 root dirfd、writer-lock fd、DB connection 或 publish/delete 能力。只拿一个已验证的 readonly original FD，以及 stdout/stderr pipes；产物由 parent 有界接收写入独占 temp。不能 hard-link original 当 temp。子进程退出后所有文件写 fd 关闭，parent 才进入 publish。原图 full SHA 检查采用异步流或独立 trusted hash executor，不在 API/worker 主事件循环同步阻塞。

## 11. Derived atomic publish、crash 与 reprocess

每个 kind 的步骤：

1. 已确认 claim/generation/lease + quota reservation；先恢复或精确清理前一 attempt 的 temp，禁止叠加未记账的 attempt 文件。
2. 以 exact job/epoch/kind 创建 O_EXCL temp；父进程在 byte cap 内接收子进程输出；验证输出，计算 SHA/size，flush、关闭 write fd。
3. 短事务在锁后读取 DB time，复核当前 generation、job lease、original AVAILABLE，将 asset 记 PUBLISHING，持久保存 size/hash/dimensions/producer epoch。事务失败不发布；unknown commit 先停，之后只读查明 intent。
4. 事务外用 derived 专用 native publish，同 filesystem 原子 no-clobber rename，sync 文件和目录。固定同 generation 的文件不 overwrite；新 recipe/reprocess 使用新 generation，可升级而不覆盖旧版本。
5. 第二个短事务重新验证 lease/generation/object，标 asset READY，再按所有 required kinds 聚合 job/media 状态。任一步不满足，文件不作为已提交 READY 暴露。

崩溃恢复：

- temp-only：derived writer lock + healthy DB 查询定位 job/epoch。活跃 lease 绝不清；失效 attempt 精确验证/清理后才重新 render。旧 coordinator child 只持 pipe，无 publish 能力，parent 死亡后不能继续写 canonical 文件。
- PUBLISHING + final 存在：核对已持久的 size/hash/format，读取 current lease/generation 后在新合法 recovery transaction 接纳；final 不存在而 temp 匹配则恢复 publish。无 intent/不匹配文件不得当成功缓存；隔离该 asset、停止其写入，计 quota 并报告。
- publish→DB failure/unknown：不 replay 文件动作、不删除已发布文件；重新查询真实 DB intent，再恢复。DB 不可用时禁 cleanup 和新 admission。
- READY 文件缺失/损坏：仅 derived 记 MISSING/FAILED，original state 不变；受控 reprocess 新 generation。不能发送空 thumbnail、拿任意其它 media 产物顶替。

重建采用本机内部 reprocess 操作，参数只有 family/media/批准 recipe（无 path/command），同事务 generation+1、创建 probe job。相同 active generation 的重复请求复用任务；不能把 attempts 清零做无限自动 retry。旧任务由 generation fence 拒绝提交并取消；先终止本地对应 child 并确认退出。每 media 最多保留当前和上一个 generation；再重建前必须清理更老、无引用、无活跃 lease 的 exact derived 记录/文件，清理失败保留账目并拒绝增加第三份。历史 jobs 随已安全清理的过期 generation 有界裁剪，顺序先 assets 后 jobs。没有 original delete 路径。

“derived 全删后可重建”验收使用 **synthetic derived-only root**：把资产状态置为缺失/触发受控 reconciliation 后新 generation 重建；不得用它授权真实 root 的 recursive rm。原始 SHA 前后完全相同。

## 12. Worker isolation、claim、lease 与资源

### 12.1 执行边界

apps/worker 是独立 trusted coordinator，只有它持 derived writer lock 和 checked DB pool；API 只做 finalize 小型入队事务。所有 Sharp、ExifTool、ffprobe、ffmpeg 在独立受限子进程运行。worker 的 hash 使用异步流/专门 executor，heartbeat 和取消不能被同步 native 调用卡住。

固定 macOS sandbox profile 必须限制：禁止网络、读取 env/credentials/用户目录、写 original、任意其它文件读写、fork 任意子进程/工具。只放行 pinned input FD、所需 runtime/library 只读文件和结果管道；启动继承 env 白名单，绝不传整个 process.env/DB URL。可评估当前机器存在的 sandbox-exec，但**存在二进制不等于隔离已验证**；必须用真实子进程测试 deny-network、deny-secret-read、deny-original-write 和 seekable FD。profile/launcher 在 4A 固定并审查，不能传客户端 profile/path。能力缺失则 parser 不启动、CAPABILITY_UNAVAILABLE；不以关闭 sandbox 作为 fallback。

文件 chmod 0400 和只读 FD 不能单独防同 UID compromised parser 重新打开原路径；因此不把子进程隔离退化成“spawn 就安全”。系统管理员/服务 UID 全面攻陷仍在原 threat model 之外。

### 12.2 Claim 与事务锁序

queue claim 是独立短 job-only transaction：`state IN (QUEUED, RETRY_WAIT)`、available_at<=DB time、attempts<max，使用匹配索引和 `ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`；取锁后另查 DB time 再判条件；设 RUNNING、attempts+1、worker_id、epoch+1、locked_at/heartbeat_at/locked_until，commit 后才能继续。`SKIP LOCKED` 用于 queue，不用它读取授权/完整业务快照；实际 execution plan 和多连接行为需验证。[MySQL locking reads](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html)。

claim transaction **不持 job 锁再向上锁 media/family**。claim COMMIT unknown 时不启动 parser；待连接健康后通过 worker id/epoch 查明是否已取得租约。随机 worker id 不是 auth token，不写普通日志。

后续业务事务顺序：

```text
必要的进程/namespace writer lock
→ capacity admission lock（仅需要预留时；不得持 DB 锁再等待它）
→ families
→ users → sessions → family_members（仅用户发起路径，按 ID）
→ albums → album_members（若未来必要；Phase 4 没有该关联）
→ upload_sessions（若需要来源，按 ID）
→ storage_objects → media_items → background_jobs → derived_assets（各按 ID）
```

只使用需要的节点。worker 不伪造 session/member，也不持 job 锁调用上传服务；claim/heartbeat 是不再取得任何上游锁的 job-only 例外。队列完成、reprocess、汇总均先 media 再 job/asset。所有要决定有效性的 DB time 在所需锁获取后另查；恢复条件 UPDATE affectedRows 必须为 1。事务调用现有 runCheckedTransaction；已有有界 deadlock retry/rollback discard/COMMIT-unknown 策略不另建一套。

### 12.3 Lease 与 crash

- lease 90s；每 10s heartbeat，按 job id + RUNNING + worker id + epoch + generation 和尚未过期进行条件更新，使用锁后 DB time；不可复活已过期 lease。
- claim 后再以完整锁序检查 media generation、probe dependency、object state、资源预约；无能力不启动 decoder。每个 media 的 generation 内只有一个 stage 能运行，MEDIA_PROBE 完成后才出现后续 job。
- lease 丢失/DB 暂失连接：立即取消本地 child，等待进程退出；不发布/提交结果。不靠 lease 过期就让仍持 OS writer lock 的第二个 coordinator接管文件写入。
- recovery 在取得独占 derived writer lock 后，job-only 锁后确认 expired RUNNING，将其转 RETRY_WAIT 或 attempts 耗尽 FAILED，清 lease；不能只看 locked_at/主机时钟。
- 同一机器 V1 一个 derived coordinator；多个 MySQL claim 客户端仍须证明同 job 只能一个 lease。增加多个真正 filesystem writer 不属于本设计，不通过移除 OS lock 扩容。
- max job wall budget 20min（包含 full original hash，单次 hash deadline 15min）；各 parser 更短独立 timeout。heartbeat 不延长 job 总期限。SIGTERM 后 1s 强制终止进程组并 reap；避免孤儿处理进程无限运行。

### 12.4 M4 / 24GB 默认配置

初始 heavy jobs 总并发 **1**；image=1/video=1 是类别上限且共享总量，不是同时跑两个。一个 image job 的两种资产顺序生成；ffmpeg/sharp native threads=1。poll 1s（空队列有界 jitter），每批 claim 1，recovery/registration 分页 32，不缓存无界任务列表。

image 子进程 wall 30s，ExifTool 15s，ffprobe 20s，poster 60s；RSS 2 GiB 阈值，100ms 监控，超限 kill；Node JS heap<=256MiB。native launcher 设置平台支持且实测有效的 CPU、file-size、FD、core-dump limits；图像/视频输出另由父进程严格 byte cap 保证。`RLIMIT_AS/RSS` 在 macOS 上的实际支持/效果必须测试，不能宣称 V8/cache/watchdog 是 native 硬内存隔离。[Apple setrlimit](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setrlimit.2.html)。

这些限制防有界格式中的已知大尺寸/多帧耗尽；RSS watchdog 有采样窗口，不能证明任意 native 漏洞都不会瞬时 OOM。Production 接入前要用实际解析器 build 完成内存峰值/恶意输入压力及隔离验证；若该部署要求硬 memory containment 而当前平台做不到，则相应 parser 保持关闭或另行 R3 评审执行环境。不得在实现报告虚构 macOS 硬 RSS 保证。

## 13. Derived quota 与跨进程容量预留

独立 derived budget：family 默认 32 GiB、global 64 GiB；上限包括当前/旧 generation、待清理/失败/PUBLISHING/temp，不能只 SUM READY。原 Phase 3 family 256 GiB originals/staging quota 保持；derived 有单独 family 上限，两者共享物理盘 free-space safety。

- asset 在开始 render 前按 kind 最大 byte cap 预留，成功后记实际字节；FAILED/lease expired/COMMIT unknown 不释放尚可能占用的空间。清理 confirmed 才释放；前一 attempt 未清理，不开新 attempt temp。
- DB 记录预算 + bounded derived scan accounting；无记录文件也占实际容量。扫描不完整、unsafe entry、DB 不可用时 derived admission fail closed。目录采用已有分页/generation 检测原则，不能固定 1000 截断后当完整。
- **API create-upload 和 worker derived-reservation 都取得共享 capacity OS lock**，读取最新 DB future reservations、statfs、所需新预留并提交 reservation 后释放。原 in-process admission 保留局部用途，但不是跨进程保护。
- 公式：freeAvailable >= `max(10 GiB, total/10) + Phase3 scratch reserve + upload reservedFuture + derived conservative outstanding reservation + requestedNewReservation`。written bytes 已反映在 statfs；允许保守双计，不允许忽略未决 reservation。新 reserved asset 要先写 DB 再开始任何输出。
- 两个 namespace writer 保持各自生命周期锁；capacity lock 只短持，不跨 render/hash，不反向等待 upload/hash mutex。所有初始化该锁的进程验证同 marker/device/稳定 inode；不能给 API 和 worker 各建一把同名不同 inode 的锁。
- chunk append/derived write 继续检查剩余空间和 byte cap；不以 admission 预测保证系统其他程序永不耗盘。ENOSPC 受控失败，不能变成 original corruption/delete。

这是 Phase 4 必须实现的 admission 扩展。若只给 worker 单独 statfs 而不协调已有上传预留，不能通过容量验收。

## 14. Original integrity 与权限

处理前确认 object AVAILABLE、root 身份正确；从同一固定 original FD full server SHA/size 验证后 rewind 并传给 parser。不使用 client hash。每个 stage 前独立确认来源；处理完成提交前锁后再次查 object AVAILABLE/root identity，禁止用启动时的旧健康状态作最终依据。

明确 SHA/size mismatch 可通过现有受控 integrity reporting 路径标 CORRUPT；在健康 root 下确认不存在才能报 MISSING。临时 IO/拔盘/DB unavailable 不直接判永久缺失。任何 integrity 异常阻止 derived READY；已有 derived 也不能让未来读取绕过 object health。格式 parser 失败仅是 processing failure，不能标 original CORRUPT。

worker 内部跨 media 执行不需要 album permission，但所有 job/media/object/asset 查询和 FK 都携带 family scope。错误关联被拒绝；不得把“系统处理成功”当客户端读取凭证。Phase 4 不提供可绕过 Phase 2 的静态 derived 目录、公共 URL 或 metadata read API。后续 Phase 5 读取必须先定义 album/media visibility，特别不能通过同 storage/media dedupe 暴露 CUSTOM album、GPS、filename 或 uploader。SUPER_ADMIN 仍没有 album bypass。

## 15. Failure、retry 与 logging

批准的 failure code 集合：`UNSUPPORTED_FORMAT`、`CAPABILITY_UNAVAILABLE`、`MALFORMED_MEDIA`、`INPUT_LIMIT`、`OUTPUT_LIMIT`、`PROCESS_TIMEOUT`、`RESOURCE_LIMIT`、`TEMPORARY_IO`、`STORAGE_UNAVAILABLE`、`ORIGINAL_MISSING`、`ORIGINAL_CORRUPT`、`DERIVED_INTEGRITY`、`WORKER_LOST`、`DB_UNAVAILABLE`、`COMMIT_OUTCOME_UNKNOWN`。DB ENUM、contracts 与 worker 白名单同源；扩展 code 走版本化 schema 审查，不落任意字符串。

- permanent：unsupported、malformed、input/output limit，直接 FAILED；probe 有有效基础结果则 media PARTIAL。CAPABILITY_UNAVAILABLE 不自动循环，安装/版本更新后受控 reprocess。
- transient：temporary IO、timeout、worker crash、短暂 DB 故障；最多 3 次总尝试，1st→2nd 30–45s，2nd→3rd 120–150s jitter，DB available_at。资源限制连续发生不得调大限制无限 retry；耗尽为 terminal FAILED。
- ORIGINAL_MISSING/CORRUPT/root unavailable：BLOCKED，待 Phase 3 明确健康恢复后受控 requeue；不靠定时重新尝试数百次读取故障盘。
- DB transaction deadlock retry 与 job retry 是两层不同含义：前者仅重试已 rollback 的短 SQL；后者重新执行幂等 job。文件动作从不进 transaction callback；COMMIT unknown 不计为“已回滚，可以重放”。
- 日志白名单：event、familyId/mediaId/jobId、kind、recipe/generation、attempt、受控 code、耗时/字节数/状态。事件包括 media_registered、job_claimed/completed/failed、lease_lost、derived_published/recovered/cleaned、processing_blocked。
- 禁止 filename、拍摄时间/GPS/相机序列号、source/derived absolute path、原始 SHA、原始 Error/stack、完整 command、raw JSON/stderr、Cookie/Authorization/credential body。普通生产日志不带 parser debug；需要 debug 时独立有界脱敏入口，无自动 dump。

## 16. Idempotency / failure recovery 必须成立

| 竞争或故障                          | 要求                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| 两个 duplicate uploads 完成         | 两条 receipts，一个 media，当前 generation 一个 probe job      |
| 两客户端 claim 同 job               | 只有一个 RUNNING lease/epoch；另一个 skip 或无任务             |
| job claim COMMIT unknown            | 未查明前零 parser spawn/文件发布                               |
| heartbeat 过期后旧 worker 返回      | 条件更新失败；无 metadata/READY 覆盖                           |
| reprocess vs old generation         | 旧结果不得进入当前 generation；旧文件受 quota/cleanup 管理     |
| temp render crash                   | 无 canonical 半文件，恢复不复用半文件                          |
| publish 成功 DB 未提交              | 可信 PUBLISHING intent + full output verify 后恢复；no-clobber |
| completion COMMIT unknown           | 查询实际记录；不重放 IO、不先删除 final                        |
| 同 image job 第二个 kind 失败       | 第一个 READY 可复用；不重复记录、无无限 attempt 文件           |
| original health 处理期间变坏        | 当前输出不得标可服务 READY；original 不被 processor 改写       |
| derived disk/cleanup failure        | 不释放不可信空间；新 admission 受阻，original 独立保持         |
| API upload 与 worker 同时近满盘预留 | 共享锁+最新 reservation 使最多安全预算内的一方成功             |

## 17. Security test matrix

只使用可审计 synthetic/公开授权样本，所有 DB/文件 fixtures 精确清理，测试结束 residue=0。阶段实现 targeted；最终 Gate 不 skip 可执行必测项。缺 HEIC/HEVC 能力时测试“明确 PARTIAL/禁用”分支必须执行，不能 skip 后宣称 decoder PASS。

1. **Schema/history**：新三表及 source receipt 同 object/family FK、asset/job scope、unique、CHECK、BIGINT>2^53、UTC/local date round trip；完整 manifest readiness，Phase 1 bootstrap generic history regression；迁移前后 Phase 1–3 结构未漂移。
2. **Identity/trigger**：首次/重复/跨家庭同字节、不同 filename/uploader、两个并发 finalize、历史晚完成 receipt/backfill、入队 DB rollback/unknown；无重复 media/jobs，不改变首次 provenance。
3. **Image**：JPEG/PNG/WebP/GIF，animated first-frame、HEIC 正反 capability、RAW/DNG metadata-only、超尺寸/像素 bomb、伪造小 header/实际大 decode、truncated/corrupt/混合容器、超大 ICC/EXIF/XMP、orientation 1..8 及非法值。
4. **Metadata/time/GPS**：未知字段不入库、超过输出预算；缺 timezone、非法 offset、闰日/自动进位陷阱、1900/未来边界、相互冲突 tag、server TZ 改变结果不变、QuickTime UTC 不确定、GPS NaN/越界/半对、valid zero coordinate、字符串控制字符。derived 重新读取不得含原 GPS/EXIF。
5. **Video**：valid MP4/MOV、真实 H.265 decode capability、4K、PQ/HLG tone-map/缺 filter、极短/零/未知 duration、rotation/SAR、附带图片 vs 主流、过多 streams、corrupt/moov bomb、超大 stderr/stdout、timeout、外部 drefs、协议 URL/concat/playlist、shell metacharacters；零网络和零外部文件读取。
6. **Sandbox/process**：child 读测试 secret/write synthetic original/网络请求均被拒；不继承 DB env、root/lock fd；seekable input 能力、CPU/memory/FD/output 上限、timeout→kill→reap、父进程 crash 时 child 无 publish 能力；绝不只用 mocked spawn 证明隔离。
7. **Paths/publish**：client filename path traversal/NUL/protocol 均不影响 key；symlink/hardlink/FIFO/device、root/mount 替换、derived→original 路径攻击在 native 层拒绝；no-clobber、不同 generation、损坏 existing candidate、late-page unsafe entry、>1250 entries scan。
8. **Jobs/concurrency**：真实 MySQL duplicate claim、lease/wait 跨截止时间、deadlock bounded retry、rollback failure discard、COMMIT unknown no IO replay、crash/reclaim、同 media generation fences、permanent failure零自动 retry、attempt 上限。claim 用实际 EXPLAIN/两个连接验证，不以 mock 或 sleep 未完成作为唯一锁证据。
9. **Fault injection**：temp fsync 前/后、PUBLISHING commit 前/后、rename 后/READY commit 前 SIGKILL；DB unavailable、unknown commit、output hash mismatch；分别启动 actual recovery，验证未丢失 original、无半图 READY、残留计账及可重试。
10. **Quota**：ready/failed/old generation/temp/orphan/COMMIT unknown 全计账；cleanup failure 不释放；API upload+derived 并发 near-cap；statfs 低空间/ENOSPC；无穷 reprocess 被 retention/quota 阻止。
11. **Immutability**：每个 supported/unsupported/failure/retry 样本 processing 前后 original SHA/size 相同；不改变权限/mtime/EXIF/容器（允许只读访问的 atime 改变）；可删 synthetic derived 后重建同 source、同 recipe 输出等价。
12. **权限/日志 regression**：family mismatch job/source/asset 被拒；无公共 metadata/derived route；实际 logger sink 无 metadata/credential/token/path/hash/raw error，现有 Auth/Album/Upload regression 通过。

## 18. P0/P1 设计风险与实现阻断条件

| 风险                                                       | 等级                          | 必须措施/证明                                                     |
| ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| 任意 original 写入、generic overwrite/cleanup 逃出 derived | P0                            | 分离 capability + native path class + sandbox + SHA 前后测试      |
| shell/protocol/外部 track 注入、parser 读取 secrets/网络   | P1，若造成执行或原始损坏升 P0 | argv白名单、FD输入、demuxer/protocol限制、真实隔离测试            |
| bomb/多帧/无限 stderr/无限任务耗尽机器                     | P1                            | 输入/输出/像素/进程/并发/重试限制；公开实测 memory 能力缺口       |
| lease-only filesystem takeover、stale generation 写入      | P1                            | 独占 derived writer、epoch+generation fence、旧child无publish能力 |
| 先 enqueue 再 commit 丢 job，retry 重放文件动作            | P1                            | 同事务入队、唯一码、SQL与IO分开、unknown outcome reconciliation   |
| API/worker 各自 admission 导致超额预留                     | P1                            | 共享 capacity lock、持久预留、失败残留继续计账                    |
| parser失败把原文件删除/标存储损坏                          | P1                            | processing vs storage 独立、只接受可信完整性证据                  |
| dedupe/read路径造成 CUSTOM 或跨家庭泄漏                    | P1                            | scope FK、无公开读接口、未来读必须重新授权                        |

以上措施属于本阶段验收要求，不是提前认定已实现。真实 power-loss/SSD disconnect、persistent audit/rate-limit 仍延续 Phase 3 的 Production 验证清单；本阶段不能因此宣称生产就绪。

## 19. Migration 与发布策略

计划单个 `0003_phase_04_media_processing.sql`：新增 media_items/background_jobs/derived_assets，按依赖顺序建表；只给 upload_sessions 加 source FK 所需复合 UNIQUE。无删除/重命名旧表、无修改 0000/0001/0002、无导入 database/schema.sql，无标签/Trash/album_media。

Drizzle schema、SQL、snapshot、journal、通用 PROJECT_TABLES/readiness 同步。先 review 再由用户单独批准执行；preflight 验证 family_album_dev、MySQL 9.7.2、non-root、Native FK、foreign_key_checks、现有 manifest 0000..0002 精确完整，新表不存在。迁移后的 readiness 使用当前完整 manifest，不能再次写死 migration count/latest phase。实际检查 source FK、job/asset scope FK 和 CHECK 的 ERROR；不能只看 SHOW CREATE。

部署顺序：停止相关写进程 → 受审查迁移 → 部署理解新 schema 的 API/worker → readonly readiness → synthetic capability/处理测试 → 明确启用 DEV worker。历史 COMPLETE 注册/backfill 之后执行，不混入 DDL。禁 worker 在旧 API 不参与 shared capacity admission 时写 derived。回滚代码不能直接忽略 ahead journal；按既有 fail-closed readiness 处理，不通过删 journal 回退。

## 20. 推荐实现顺序与停止点

1. **4A — Schema / capabilities**：三表、migration 草案和 tests；OriginalReader/DerivedStore/shared capacity lock 的窄 native 设计落地；sandbox、工具版本/FD/resource capability 的 synthetic probe。migration 单独暂停审查/执行。不运行真实处理，任何隔离能力不满足保持 parser disabled。
2. **4B — Durable jobs / media registration**：completeFinalize 小型入队、duplicate/backfill；MySQL claim/heartbeat/retry/generation fences、quota/recovery skeleton；先真实 race/commit-unknown 测试。
3. **4C — Image pipeline**：受限 metadata/time/GPS、JPEG/PNG/WebP/GIF、HEIC capability 和 RAW metadata-only；两个版本化 WebP、atomic publish/crash recovery。
4. **4D — Video pipeline**：固定 ffprobe/ffmpeg、MP4/MOV probe/poster、HEVC/HDR capability；不 transcode。
5. **4E — Reprocess / reconciliation / final review**：derived-only repair/cleanup、quota/retention、恢复/不可变性/race tests；独立安全审查、blocker修复、完整 Gate 后再决定 Phase 5。

若实现需要改变本文件 canonical media、租约/锁序、sandbox边界、capacity admission、atomic publish 或 schema：输出 R3_DESIGN_REVIEW_REQUIRED，不以“方便实现”替换规则。本文件不授权运行 migration、Production 操作或进入 Phase 5。
