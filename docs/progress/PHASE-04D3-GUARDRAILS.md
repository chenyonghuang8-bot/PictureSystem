# Phase 4D3-0 — Isolated Image Renderer / DerivedStore Guardrails

Status: **DESIGN APPROVED; implementation and capability validation pending.**

本文件是 Phase 4D3a/b/c 的增量安全设计。只授权后续按顺序实现与验收，不表示 renderer、DerivedStore 或 runtime isolation 已通过测试。本次只创建本文档，没有修改代码、数据库或 migration，没有运行媒体处理。

```text
PHASE_4D3_DESIGN_REVIEW
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: NO
D0_ISOLATION_BOUNDARY_EXTENSION_REQUIRED: YES
DERIVED_STORE_REQUIRED: YES
BINARY_OUTPUT_PROTOCOL_APPROVED: YES
IMAGE_RENDERER_CAPABILITY_GATE_REQUIRED: YES
HEIC_DERIVATIVES_ENABLED_IN_V1: NO
RAW_DNG_DERIVATIVES_ENABLED_IN_V1: NO
READY_FOR_PHASE_4D3_IMPLEMENTATION: YES
```

YES 仅表示可以开始 4D3a。4D3a、4D3b 的真实能力门禁通过后才可以接通 4D3c。`DESIGN_CHANGE_REQUIRED` 指本次明确批准的 D0 输出/进程加固、derived capability、共享容量 admission，以及第 22 节 stale filesystem candidate 语义；不是要求实施者再次自行设计。

## Evidence and scope

- [Phase 4 Guardrails](PHASE-04-GUARDRAILS.md) §§8、10–16：recipe、独立 writer、共享 capacity lock、PUBLISHING 意图与两次 SQL fence。
- [Phase 4A schema document](PHASE-04A-SCHEMA.md) 和 [实际 schema](../../packages/db/src/schema.ts)：本设计使用已存在的 `media_items`、`background_jobs`、`derived_assets`。4A 文档的“not executed”是历史准备状态；本轮按用户确认的已执行 0000–0003 工作，未连接 DB 重新核验。
- [media repository](../../packages/db/src/media-repository.ts) `createOrGetCanonicalMedia`、[4B tests](../../tests/integration/phase4b.test.ts)：family/storage canonical identity、首次 receipt provenance。
- [job repository](../../packages/db/src/job-repository.ts) `claimNext/heartbeat/retry/recoverExpiredLease`、[4C tests](../../tests/integration/phase4c.test.ts)：90s lease、epoch、最多 3 attempts、现有 backoff。recover 清除旧 lease，**下一次 claim** 才推进 epoch；不得改变为 recover 自身也增 epoch。
- [storage adapter](../../packages/storage/src/index.ts) `OriginalReader.withVerifiedOriginal/runFixedOriginalChild`、[native storage](../../packages/storage/native/storage_native.c) `open_verified_original/consume_original_handle`：marker-bound、full SHA/size、readonly/seekable single-use FD。
- [supervisor](../../packages/storage/native/original_probe_supervisor.c)：目前仅 64 KiB stdout、小 JSON、FD 4 liveness、close 4..1023、reap 后仍 kill PGID。
- [sandbox](../../packages/storage/native/original-probe.sb)、[OriginalReader tests](../../packages/storage/src/original-reader.test.ts)、[media runner](../../packages/media/src/index.ts)、[native metadata child](../../packages/storage/native/metadata_parser_child.m)：DEV sandbox 与 ImageIO FD-backed provider。
- [D1](PHASE-04D1-METADATA-PARSER.md)、[D2](PHASE-04D2-METADATA-PERSISTENCE.md)：当前 parser、持久化与 deferred 项。仓库没有独立命名的 D0/B/C 总结；相关证据以上述实现、测试和 D1/D2 引述为准，不假定缺失文档存在。
- [upload admission](../../apps/api/src/uploads/service.ts) `create/withAdmission`、[upload accounting](../../packages/db/src/upload-repository.ts) `admissionUsage/createUpload`：当前只有进程内 admission；不能用它证明跨 API/worker 预留安全。

范围仅 JPEG/PNG/WebP/GIF image derivatives。无 video、public media API、album_media、global GC、Production 操作。D2 的 CAPABILITY_DISABLED 清空字段、unhealthy-original 0-effects 及其 deferred 测试语义不在本次修改范围。

## 1. Recommended architecture

```text
checked DB lease/media/original identity
  -> OriginalReader -> VerifiedOriginalHandle
  -> fixed isolated native image child (one kind)
       FD 3 readonly original -> FD 4 bounded binary pipe
  -> trusted supervisor / bounded parent receiver
  -> DerivedStore owned temp
  -> structural verification + isolated full output decode + trusted SHA
  -> committed PUBLISHING intent
  -> native exclusive durable publish
  -> second fenced transaction: READY + aggregate job/media
```

选择 **A：专用 bounded binary pipe**。不选择 child write-only temp FD：即便没有 pathname，该 FD 仍允许 seek/truncate/继续写，增加 byte-cap、seal 和 crash 回收复杂性。管道仅赋予输出 bytes 的能力，只有可信 parent 持有 temp 的写能力。禁止 base64 JSON、扩大 metadata stdout、任意 output path。

每个 kind 启动一个进程，THUMBNAIL → PREVIEW 顺序执行。每次进程退出并 reap、验证和提交该 kind 后，才处理下一 kind。一个 kind 的失败不撤销已 READY 的另一 kind。

## 2. Renderer input

- 继续使用 storage 的 opaque `VerifiedOriginalHandle`，不增加公开 raw FD/path 接口。renderer API 接受该 handle 和服务端 registry 的 recipe/kind；不接受 filename、MIME、argv、env、executable/profile。
- storage 内部验证 regular/single-link/owner/mode/ACL/device/root marker、full server SHA-256、size、seekability；handoff 前复核 inode/size/mode/mtime，rewind。
- child 使用 FD 3 的 bounded `pread` provider；不使用 `/dev/fd/3`、`/proc/.../fd` 或真实 pathname 重新打开输入。dup 只发生在可信 launcher 内，为启动时固定 FD 映射服务。
- 每次 kind 使用新的 single-use handle；如复用一次 verification，其安全性必须由 storage 内部同 inode/snapshot/readonly handle 证明，不能由 media 缓存 raw FD。本版默认每 kind 重新验证。
- full hash 不得阻塞 coordinator 的 heartbeat/cancellation：通过 storage 内部受控异步 executor 执行，保持原有验证步骤；不将路径或原始 FD 交给 media。
- “不暴露路径”指不在 API/argv/env/control/log 提供原路径。不能声称 readonly FD 在所有 OS 上天然隐藏内核路径信息；即使 child 通过诊断 syscall 得知名称，path reopen 仍必须被 sandbox 拒绝。

## 3. Binary output mechanism and protocol

新增独立 `image-render-v1` 协议，不改变 D1 metadata JSON 的含义和 64 KiB 上限。

- child binary FD 4 只输出**一张完整 WebP**；无自定义文件名、无多图 framing、无 metadata side channel。
- stdout 为一个 <=4 KiB 的 strict typed JSON terminal result：version、fixed mode、recipeId、kind、status、encodedBytes、width、height、固定 failure code。禁止任意额外字段/深层对象；不得包含 original hash/path/EXIF/GPS。
- stderr <=16 KiB，持续 drain、不回传或记录 raw 内容；本版成功要求 stderr 为空。
- supervisor 与 parent 分别独立计数，超过 kind cap 的第一个 byte 即失败；parent 最多写 cap bytes，不把 overflow byte 写入 temp。总 pipe backlog 有界，不能累计整个 original 或无限 Buffer 数组。
- supervisor 使用 nonblocking poll，持续处理 control/stderr/binary/liveness/deadline。parent 有界接收队列 <=256 KiB；背压时 supervisor 仍检查 deadline/liveness，不能阻塞于同步 `write`。
- 成功必须同时满足：exit=0、所有输出通道 EOF、恰好一个成功 JSON、实际接收 bytes=JSON encodedBytes=最终 temp stat size、大小在限内、后述文件验证通过。JSON 不是长度/内容的可信证明。
- truncated stream、额外 byte、第二份 JSON、无 EOF、成功 JSON+非零退出、协议混用全部拒绝；child 已退出不等于 pipes 已 drain。partial output 从不 publish。
- 单 attempt 两 kind 合计最多 4,718,592 bytes（512 KiB+4 MiB）；每 kind 独立 cap，不能挪用另一个 kind 预算。最多 3 attempts 仍受旧 temp 清理和相同 identity 限制；不允许额外“encoder 内部无限重试”。

## 4. Fixed FD map and ownership

| FD     | Trusted supervisor                                            | Renderer child                     |
| ------ | ------------------------------------------------------------- | ---------------------------------- |
| 0      | `/dev/null` read                                              | `/dev/null` read                   |
| 1      | bounded JSON control to parent                                | bounded control pipe to supervisor |
| 2      | bounded sanitized supervisor diagnostic                       | bounded stderr pipe to supervisor  |
| 3      | verified readonly original, close own duplicate after handoff | readonly seekable original         |
| 4      | bounded binary relay to parent                                | write end of dedicated binary pipe |
| 5      | parent-liveness read endpoint                                 | **closed**                         |
| others | only its explicitly owned private poll endpoints              | **closed at launch**               |

所有中间 FD 默认 CLOEXEC，只对明确的 child 0–4 做 dup/inherit；原 FD、父目录 FD、root FD、所有 OS lock FD、DB/socket FD、liveness FD 均不得进入 renderer。supervisor 的私有 pipe endpoints 也不能反向泄漏给 child。parent closes transferred input duplicate after spawn；supervisor closes unused ends immediately；child exit/reap closes child copies。

parent 死亡由 liveness EOF 触发 supervisor terminate/reap；child 不能保有 liveness writer，不能伪造 parent 仍活着。binary sink 关闭必须触发 cancel，不能忽略 EPIPE 继续工作。

## 5. Sandbox permission delta

保留窄 `IsolatedImageRenderer` backend abstraction；本版 backend 是 **macOS DEV-only**，固定 native supervisor + 固定 native child + 固定 profile。

- 唯一数据能力增量是 inherited binary pipe write；仍 deny filesystem write、network/DNS、root browse、other object/secret read、fork/exec/posix_spawn。
- 固定 system runtime/library readonly allowlist；libwebp 静态链接到 child，禁止通过 HOME、PATH、DYLD_*、plugin discovery 或用户 codec 搜索加载库。
- env 仅固定 LANG/必要 runtime 常量，不继承 process.env；cwd 固定为非敏感位置。root path 和 home 参数只存在可信 supervisor backend 内部，不进入 renderer argv/env/control。
- 不能把启动时允许 exec 固定 child 等同于 renderer 运行期间 deny exec。固定 child 的可信 bootstrap 在读取不可信 bytes **前**安装最终禁止所有 exec/fork 的收紧策略（macOS DEV backend 使用固定二阶段 sandbox policy）；失败即退出。自 exec、posix_spawn 也必须真实测试，不仅测试 `/bin/sh`。
- 二阶段限制须证明只收紧现有 sandbox。若当前 OS 不支持或真实 denial probes 失败，能力保持 disabled；不移除限制或用更宽 profile 通过测试。
- sandbox-exec/system.sb 是当前 DEV backend 的平台依赖，不是 production 隔离保证。os/build/profile 变化必须重新通过 gate。

## 6. Capability probes

capability result 绑定 renderer binary、libwebp build、OS/ImageIO build、profile、protocol 和 recipe registry fingerprint。未知 fingerprint、缺库、旧 gate 或 runtime denial drift 均不得启用。

必须用真实 child 验证：FD3 read/seek；FD4 binary output；original write/pwrite/truncate/chmod denied；原路径/第二 object/secret/derived browse/create denied；IPv4/IPv6/UDP/DNS denied；fork/self-exec/other-exec/posix_spawn denied；高编号 FD 不泄漏；overflow、control corruption、partial output、backpressure、timeout/crash、parent death 均 cancel+reap；original bytes/SHA/inode/mode/mtime 不变。

测试故障模式属于固定测试 binary/mode，不暴露为生产调用参数。capability probe 只能使用 synthetic root/secret/image，不触碰真实 MEDIA_ROOT。

## 7. Renderer technology

**唯一 V1 选择：固定 Objective-C/C native child，ImageIO/CoreGraphics FD-backed decode/transform，pinned libwebp encoder。**

复用 D1 已存在的 `CGDataProvider`/`pread` 输入模式，但不修改 D1 metadata outcome。ImageIO 支持从 provider 创建 source 和按 index 生成缩小图；需要显式 transform/尺寸选项，不能把默认行为作为方向保证。[Apple ImageIO guide](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/ImageIOGuide/imageio_source/ikpg_source.html)

WebP 编码用 libwebp advanced encoder 的 writer callback 写 FD4；不使用返回无界内存结果的 convenience encoder。固定 quality/method/thread/alpha 配置并校验配置。可信端 byte cap 独立于 encoder callback。[WebP API](https://developers.google.com/speed/webp/docs/api)、[upstream encoder interface](https://github.com/webmproject/libwebp/blob/main/src/webp/encode.h)

不依赖未验证的 ImageIO WebP encoder；不引入 Node/sharp/libvips runtime、CLI converter 或宽 loader fallback。新增依赖仅为 child 私有的 libwebp 固定 release+checksum+license/build manifest；实施时选取受支持修复版本并锁定，不能下载 floating main 或自动安装系统软件。本轮未安装依赖、未声称当前机具备 encoder。

若该固定技术无法在已批准 FD/sandbox/资源条件下通过四种格式测试，则保持对应 capability disabled并报告；不得自行更换处理框架。

## 8. Supported-format matrix

| Original | Decoder eligibility                   | Thumbnail/Preview | Enable condition                                                             |
| -------- | ------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| JPEG     | exact bytes classifier + ImageIO JPEG | planned YES       | real positive/corrupt/orientation/resource probes                            |
| PNG      | exact PNG classifier                  | planned YES       | alpha、profile、truncation probes；APNG 按单首帧策略或明确拒绝，不能静默全帧 |
| WebP     | bounded RIFF classifier + ImageIO     | planned YES       | static+animated first-display-frame probes                                   |
| GIF      | bounded GIF classifier + ImageIO      | planned YES       | logical canvas/subrectangle/transparency/first-frame probes                  |
| HEIC     | 不进入 D3 renderer                    | NO                | V1 disabled；以后独立 codec/HDR/10-bit/orientation/恶意样本/资源/隔离 gate   |
| RAW/DNG  | 不进入 D3 renderer                    | NO                | V1 disabled；不抽 embedded preview，不打开 TIFF/RAW broad loader             |

planned YES 不表示本轮 capability PASS。未来启用 HEIC/RAW 要再次 R3 审批 recipe/decoder 范围；metadata PARTIAL 不是 derivative permission。

## 9. Resource limits

| Resource                              | Fixed V1 limit                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| original bytes                        | 512 MiB                                                                                                                                 |
| raw width/height and logical canvas   | each <=16,384, product <=50,000,000 with checked arithmetic                                                                             |
| decoded image/frame count             | exactly index 0, at most one decoded/display frame                                                                                      |
| accepted declared animation frames    | <=256；bounded structural inspection 超限/无法确定安全边界则 INPUT_LIMIT                                                                |
| structural inspection                 | <=65,536 records、<=4 MiB inspected header/ancillary bytes；payload 跳过使用验证过的 offset/length，禁止无界 frame/property enumeration |
| FD provider cumulative returned bytes | <=2 GiB per render；checked offsets，防无限重复读                                                                                       |
| render wall                           | <=30s per kind, monotonic supervisor deadline                                                                                           |
| output validation wall                | <=10s per kind, same isolation constraints                                                                                              |
| CPU                                   | native hard CPU limit 30s per render / 10s validation，设置与执行效果须实测                                                             |
| RSS                                   | 2 GiB watchdog threshold, <=100ms sampling；**不是 kernel hard RSS guarantee**                                                          |
| child open FD budget                  | 64 after explicit close-all-except；runtime需求超过即 capability失败                                                                    |
| core dumps                            | disabled                                                                                                                                |
| concurrent heavy jobs                 | 1；两 kind 和验证子进程串行                                                                                                             |
| encoder threads/cache                 | libwebp thread_level=0；ImageIO cache关闭；不并发启动 decoder                                                                           |
| parent binary queue                   | <=256 KiB；另有 OS pipe bounded buffers                                                                                                 |
| total job                             | 既有20min；full original hash单次15min；heartbeat 10s / lease 90s                                                                       |

structural/header limits先于 full decode，实际 decoded geometry 再检查。不要先调用无界 CGImageSourceGetCount 再检查 frame cap。ImageIO内部 native 分配/线程不能靠 API开关证明有硬上限；恶意输入峰值与 watchdog必须实测，缺 production硬 containment仍是 production gap。不要把 RLIMIT_FSIZE 当作 pipe byte cap。

## 10. Thumbnail recipe

Registry identity `(recipe_id=1, kind=THUMBNAIL)`：最大 480×480，inside，保持比例、不裁剪、不放大，WebP lossy quality=75，encoded <=524,288 bytes。

EXIF 1–8完整 mirror/rotation且只应用一次；缺失/非法按已批准 metadata语义取1，不写回 original。方向先于 resize，5–8交换宽高。target dimensions由 display尺寸计算：`scale=min(1,480/w,480/h)`，每边 `max(1,floor(side*scale))`；实现用checked integer计算避免浮点边界漂移。像素模板测试确认 mirror、位置和视觉尺寸。

## 11. Preview recipe and versioning

Registry identity `(recipe_id=1, kind=PREVIEW)`：最大2560×2560，其余几何规则同上，quality=82，encoded <=4,194,304 bytes。

共同固定：standard sRGB、8-bit RGBA、alpha保留（alpha_quality=100）；正确从 CoreGraphics premultiplied buffer转成 encoder要求的 straight alpha；透明区域RGB归零以获得稳定输出；encoder method=4、lossless=0、thread_level=0、默认preset及其余显式冻结参数列入build manifest。resize kernel/rounding/color conversion同属recipe。

只向encoder传像素，不传 source metadata；不mux EXIF/XMP/GPS/相机/原ICC/动画/embedded thumbnail。最终无metadata orientation，视觉已转正。超size直接 OUTPUT_LIMIT，不降quality循环。

recipe 1在第一次真实derived写入前固定实现fingerprint；同recipe不能静默换OS decoder/encoder/build行为。升级时新recipe且新generation，历史fingerprint保留；旧job遇到不支持recipe失败关闭。此规则不要求DB新字段：代码registry+部署manifest管理fingerprint，DB仍用recipe_id。不承诺不同OS/build位级确定性；同identity已发布文件永不被重编码结果替换。

## 12. Animation policy

GIF/animated WebP只输出第0个**display canvas**的静态图，不输出动画、不依次decode所有frame。处理logical canvas、首帧offset、透明背景，不能把subrectangle误当整幅图。PNG动画输入也不得导致implicit multi-frame processing。

通过有界container检查确认尺寸/帧数/offset，再只请求index0。duration、loop、后续帧内容不进入derived。ImageIO若为了index0仍发生超预算工作，由timeout/RSS/provider限制终止；不提高限制。

## 13. DerivedStore API and authority

放在 `packages/storage`，native 独立 `derived_root_t`/magic与私有pin的derived dirfd，不用 `StorageRoot` handle假扮DerivedStore。建议窄接口：

- `openExisting(rootIdentity)`：验证原marker、derived marker、root/derived device+inode、owner/mode/ACL，取得lifetime `.derived-writer.lock`；普通启动不provision。
- `createTemp(reservationCapability)` → opaque `DerivedTempSink`；只有实现内可取得write FD。
- `appendBounded(sink, bytes)`、`sealTemp(sink)` → readonly `SealedDerivedOutput`；写句柄全部关闭，fstat/identity复核。
- `inspectCanonical(DerivedIdentity)`、`withSealedOutputForValidation(handle, ...)`：仅read-only、不暴露path/FD。
- `publishExclusive(sealed, publishPermit)`：只允许匹配完整identity、已确认PUBLISHING intent的单次permit；native执行fixed derived path与no-clobber。
- `cleanupOwnedTemp(exactAttemptIdentity)`：只处理已确认不活跃的本scope temp；对live/unknown scope拒绝。
- `scanAccountingPage(cursor)`、`verifyIdentity()`、`close()`；cursor为opaque internal token，不含private original hash。

`CapacityGate`为storage内独立窄能力，仅root/marker/shared lock/statfs/只读derived accounting；API不需要取得derived writer。DB reserve/release由repository执行，DerivedStore不拥有DB凭据或独立retry engine。

public API不接受relative/absolute filename、delete(prefix)、arbitrary FD或native function参数。TS opaque品牌和native类型检查同时存在；不能仅靠字符串regex隔离。

## 14. Namespace / destructive primitive decision

```text
MEDIA_ROOT/.capacity.lock
MEDIA_ROOT/derived/.derived-root
MEDIA_ROOT/derived/.derived-writer.lock
MEDIA_ROOT/derived/<family>/<media>/r<recipe>/g<generation>/<kind>.webp
MEDIA_ROOT/derived/.tmp/<job>/e<epoch>/<kind>.part
```

kind固定映射 `thumbnail/preview`；recipe正整数SMALLINT；其它IDs/generation/epoch严格canonical unsigned decimal，在BIGINT范围内，禁止`..`、leading sign/zero歧义、NUL。即使temp路径不含family，capability与DB必须绑定family/media/job/generation/recipe/kind/epoch全tuple。

native逐分量openat+NOFOLLOW、pin parent、same-device、regular/single-link/owner/ACL/mode/inode重查。DerivedStore不得操作originals/uploads/Phase3 temp；允许删除的只有`.tmp`精确文件，canonical本阶段没有replace/delete API。

**P2裁决：**新derived destructive primitives必须在native层强制path class，并且根handle物理pin在derived子树；不调用Phase3 generic `removeFile/truncateFile`。旧Phase3 primitive自身的defense-in-depth P2继续deferred，不能宣称新增DerivedStore已修复旧入口，也不为此重写Phase3。

## 15. Temp / seal / output validation

1. 必须先有commit已确认的DB reservation，才创建exact temp：O_CREAT|O_EXCL|O_NOFOLLOW|CLOEXEC，0600，同volume、单link。存在旧temp先进入recovery，不随机换名规避冲突。
2. 可信receiver bounded append，不给child任何temp FD。低空间/ENOSPC取消child，不publish。
3. 等child退出、reap和所有通道drain后，flush temp；封闭全部write FD，改为0400（仅derived），得到不可写sealed capability。
4. trusted side计算实际SHA-256/size并验证WebP RIFF总长度、chunk边界/overflow/padding、单静态image、无EXIF/XMP/ICCP/ANIM/ANMF/未知chunk。recipe1只接受encoder实际批准的VP8/VP8X+ALPH结构；RIFF length必须exact匹配文件，无trailing bytes。header几何与recipe上界/expected target一致。[WebP container specification](https://developers.google.com/speed/webp/docs/riff_container)
5. 另启固定 `verify-output` 隔离mode，从DerivedStore的readonly sealed-output handle映射FD3（此mode没有binary FD4），完整decode该实际输出，验证无truncation、尺寸一致。native decoder不进入trusted Node进程。输出最多4KiB validation JSON，大小<=4MiB、像素<=2560²、10s timeout，失败关闭。
6. 重新确认sealed inode/size/mode/mtime未变，将可信SHA/size/验证尺寸用于PUBLISHING。renderer自报digest无需输出；即使提供也不接受为权威。

验证器只能接收另一种opaque `SealedDerivedOutput`，不能把任意文件伪装成VerifiedOriginalHandle。容器验证并不能证明任意遭攻陷renderer生成的像素一定忠实；orientation/alpha/color/source correspondence由固定程序与golden synthetic tests证明，不能只相信JSON中的`orientationApplied=true`。

## 16. Shared capacity lock / rollout

`.capacity.lock`是稳定inode的0600 regular file，no symlink/ACL、同device、单link、所有进程验证同root marker/inode；绝不unlink/recreate。独立显式DEV provisioning：停止相关writer，验证已有root，创建/sync derived marker/lock/capacity lock；不改original布局或内容。

顺序：各自lifetime writer lock → 局部operation serialization → `.capacity.lock` → family →（必要actor/upload）→ storage → media → job → assets。不得持DB锁等待OS lock，不得持capacity lock再等待另一namespace的writer/上传mutex。锁等待必须有界且异步，不阻塞heartbeat。同进程共用lock FD的请求仍须由per-root mutex串行，不能假定flock会隔离同一open-file description的两个调用。

API upload admission和worker reserve/release/reconcile使用同一CapacityGate。critical section只包含当前账目/statfs/完整inventory有效性复核+短reservation transaction；不跨full hash/render/codec。派生namespace create/rename/unlink的短动作也经capacity gate序列化，支持一致的accounting inventory；不能在SQL retry callback里做这些动作。

startup/read-only paged inventory可在transaction外进行。最终admission取capacity lock后必须验证inventory完整且目录generation未变，DB状态是新的；失效则释放锁重扫，不使用stale/partial scan。已登记temp的增长由完整reservation覆盖，无需逐byte锁。遇unsafe/无法归属文件或超时不放行admission；不把>1000条截断当扫描完成。

必须先部署参与同一gate的API和worker，再启用derived writes。旧API仍运行时禁止启用worker。worker不能替旧API做一次statfs就声称一致。capacity相关改动是本次明确批准的Phase3 admission扩展，不修改其upload/original lifecycle、hash、no-overwrite或256GiB quota。

## 17. Durable reservations and accounting — no migration

**选择DB reservation，不选择仅memory/filesystem reservation。**现有`derived_assets`已足够：

- render前创建/复用同identity的RESERVED，`reserved_bytes=kind cap`、producer job/current epoch、`cleaned_at=NULL`；commit unknown禁止创建temp，待readiness恢复读实际row。
- `reserved_bytes`在本版保持kind cap，不写0（现有CHECK要求>=1）；释放用清理确认、state和`cleaned_at`表达。
- 每identity仅一个未清理attempt；旧epoch temp未精确清理/恢复前不改producer epoch、不另开新temp。PUBLISHING intent有payload时不得被新attempt覆盖。
- steady READY且只有唯一canonical时按actual `byte_size`计derived quota；RESERVED/PUBLISHING/FAILED/MISSING且未cleaned时保守按cap计。已cleaned且确认无任何相关文件才计0。
- filesystem inventory按dev/inode/exact identity归并，row charge至少为该identity所有实际文件之和；额外/未知文件另计、阻断新admission待检查。正常rename移动一个inode，不能把temp+final当两份；若确实同时存在两个文件，不能只计一份cap。
- canonical READY、历史generation、失败残留、old-epoch temp、COMMIT unknown都纳入。logical计账对同一物理文件不重复累计DB byte_size与scan size。

Derived family <=32GiB、global <=64GiB。Phase3 family256GiB仍是其canonical originals + retained staging + future reservation，derived独立限额。

物理盘admission继续使用原Guardrails的保守公式：

```text
freeAvailable >= max(10GiB, total/10)
               + existing Phase3 scratch reserve (64MiB)
               + upload reservedFuture
               + unsettled derived reservation caps
               + requested NEW reservation
```

canonical original、已写staging、READY derived、已写temp已体现在statfs，不把这些总量再全加一次。未决derived cap可能包含已写部分；这是有意保守余量，不是logical quota双计，禁止反过来扣掉未确认空间。新row若已经计入查询，requested delta不能重复加。

upload chunk的future→written转换沿用Phase3 accounting；original finalize既有rename/no-clobber不复制额外full original。若实现发现另一条路径会创建新增full copy，不能默认为64MiB scratch已覆盖，必须停止复核。失效状态/cleanup失败不假装空间释放。

清理时先确认无活跃child/lease且exact文件安全删除并sync，再在capacity gate内短SQL标cleaned。delete成功但SQL失败只会保守保留预留；重启以absence+identity证据完成释放，不永久泄漏。DB不可用/未知COMMIT时保留账目，停止新写；不需要也不允许0004。

## 18. Derived publish protocol

每kind：

1. current claim + metadata_generation=current generation + probe SUCCEEDED + object AVAILABLE + recipe/capability/root健康；先recover同identity，再reserve。
2. render、seal、full output verification全部在DB transaction外完成。
3. 取短capacity gate，短事务按完整锁序复核所有fences，锁后另取DB time，写PUBLISHING、trusted size/SHA/dims/MIME、producer epoch。commit确认前无publish。
4. commit后立即核对本地cancel/root/writer状态，使用one-shot permit调用native exclusive publish；不经过await-heavy work。no-clobber renameatx_np，同device，NOFOLLOW/RESOLVE_BENEATH，sealed inode与named entry一致。EEXIST进入verify/recovery，绝不覆盖。
5. sync file、source/destination directories并确认durability，短capacity section结束。任何rename/sync不确定性按“可能已发布”处理，不blind retry/unlink。
6. 第二个短transaction重新取得相关锁和**新的DB time**，复核当前epoch/generation/recipe/object+root验证凭证，将asset READY；最后kind满足全部required条件时同transaction完成job/media。

phase3原始publish函数不加generic target参数；新的primitive只能作用于derived。full codec/hash不在capacity lock或SQL locks内。同步小文件flush可能阻塞，必须异步native执行并保留外部监督，不能把它当跨DB/FS原子保证。

## 19. DB/filesystem ordering and fences

`runCheckedTransaction`仍是唯一SQL事务机制。业务锁序family → storage_object → media_item → background_job → derived_assets（assets按ID）；claim/heartbeat保持既有job-only例外。文件操作从不进入可自动deadlock重试的callback。

每次改变asset/media/job均要求：

```text
family_id + media_id + job_id + job_type=IMAGE_DERIVATIVES
media.generation = job.generation = requested generation
media.recipe_id = job.recipe_id = requested recipe
media.metadata_generation = current generation
job.state=RUNNING + worker_id + lease_epoch + locked_until > fresh DB time
asset identity + producer_job_id + allowed prior state + producer_lease_epoch
canonical storage association + family + AVAILABLE (success path)
```

第一次创建row/接管recovery对旧producer epoch有专门比较条件，不能用`UPDATE ... WHERE id=?`覆盖旧意图。每个条件UPDATE必须affectedRows=1；0为失权，任何部分SQL修改rollback。任意1062不得吞，只识别并重新读取完整derived identity唯一键冲突。

READY/job-success前验证实际canonical；先READY后文件落盘禁止。job完成不能先单独调用`jobRepository.complete`再更新media：最后asset READY、job SUCCEEDED、media汇总必须一个transaction。

## 20. Crash windows and recovery

| Window                              | Durable DB / filesystem possibility           | Required recovery                                                                                             |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A: temp完整、intent前crash          | RESERVED；partial或完整temp                   | writer独占+DB确定旧lease失效；精确cleanup/sync；保留reservation到确认；重新render                             |
| B: PUBLISHING commit、rename前crash | payload/epoch intent；sealed temp             | full verify intent+temp；新current lease事务接纳/换producer epoch后再发新publish permit；无有效lease不publish |
| C: rename成功、READY前crash         | PUBLISHING；canonical可能durable              | 不删完整文件；full size/hash/format/decode与原intent匹配后，current lease/generation/object复核，恢复READY    |
| D1: reserve/intent COMMIT unknown   | 是否有row/intent不明                          | 不spawn/不publish；健康连接读取精确identity；未查明不replay或release                                          |
| D2: READY COMMIT unknown            | canonical存在；DB可能READY/SUCCEEDED          | 不重做IO；读取asset/job/media整体状态；已提交则成功，否则current lease恢复；无权限零写                        |
| E: job completion failure           | 前一kind可READY；最后kind可能PUBLISHING/READY | 复核全部required files；合法retry只做缺失步骤；不把partial job标SUCCEEDED                                     |
| unknown/mismatch canonical          | 无可信payload或hash/size不符                  | DERIVED_INTEGRITY，隔离该identity、计账、禁止overwrite/delete；报告维护，不自动当缓存                         |

恢复保留旧PUBLISHING hash/size直到验证结束，不能先改row再“验证新意图”。adopt将producer epoch换成新current epoch，但不改变asset identity、payload或source provenance。job attempts耗尽/terminal且没有合法lease时不绕过4C：保留候选与账目，后续独立受控reprocess处理。

只做known-identity recovery与必需accounting scan，不做global destructive scanner。已经READY却missing/corrupt可标MISSING/FAILED（现有code），不修改original health，不在同key覆盖重建；未来新generation恢复。

## 21. Epoch / generation fencing

在prepare、reservation、PUBLISHING、READY、job/media汇总重复fence，不以初始prepare代替后续验证。job heartbeat沿用4C的owner/epoch/expiry条件；DB断连或heartbeat=0立即cancel child并reap，无新publish许可。

reclaim后的A所有DB mutation=0，B在合法new lease下才可adopt/commit。同generation recovery可以接纳先前有效lease产生且已核验的完整输出；这是B重新授权的结果，不是A复活。generation/recipe变更后绝不把旧asset写入当前汇总。

## 22. Stale-worker filesystem semantics — explicit decision

**不承诺“lease一过期，文件系统绝不出现任何新目录项”。**事务外rename无法与MySQL lease原子绑定；反复check也仍有check→syscall窗口。

唯一规则：

- 在authoritative pre-publish fence时已stale，或在native dispatch前已观察到失权：禁止publish，只有owned temp待清理。
- 在成功PUBLISHING commit之后、rename之前才失权/lease过期，允许这一已获准的one-shot rename留下**不可服务、不可覆盖、可恢复、继续计账的canonical candidate**。必须有先前可信PUBLISHING payload，key完整包含generation/recipe/kind。
- A不能将candidate READY或job complete；第二次fence必须返回0。不得把“文件存在”当成功或返回公开URL。
- B只有取得同root独占derived writer、确认旧执行已终止，才能恢复或发布；不能仅凭DB lease抢走OS writer。A仍持锁时B不得文件写。同一coordinator进程内还须per-identity operation gate，cancel并join旧render/IO后才能让B接管，不能让旧异步continuation与B并行。新generation key不同，不会覆盖。
- 同generation B须核验candidate与原intent，再在B自己的current lease事务adopt。不同generation只保留旧candidate计账，D3不删除它。未知/不匹配candidate不接纳。

这是对之前“stale worker不得publish”的严格字面表述的**明确限定**，保留“stale worker不得提交、覆盖或服务结果”的安全不变量。若产品要求连这种uncommitted candidate也绝对不出现，需要另一个DB/FS协调设计；本次不虚称已做到。

## 23. derived_assets state machine

只用真实enum：`RESERVED/PUBLISHING/READY/MISSING/FAILED`。无PENDING/CLEANED asset state。

| Transition                        | Required evidence                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| absent → RESERVED                 | canonical unique identity、current job、capacity admission、cap reservation                  |
| RESERVED → PUBLISHING             | sealed validated payload、current lease/gen、confirmed commit                                |
| PUBLISHING → READY                | actual durable canonical matched、fresh fence、published_at=DB time、cleaned_at=NULL         |
| RESERVED → FAILED                 | current fenced failure；保留reservation，清理确认前cleaned_at=NULL                           |
| PUBLISHING → FAILED               | 仅已查明candidate状态的受控failure；不能未知结果时丢掉intent；保留payload供诊断/恢复         |
| READY → MISSING/FAILED            | 健康root下确认缺失/损坏，保持既有payload证据、controlled failure；original不变               |
| cleaned failed attempt → RESERVED | 同job合法retry、无相关残留，current epoch，清旧payload/published_at/failure，cleaned_at=NULL |

`reserved_bytes`始终合法且payload<=reservation。PUBLISHING/READY完整字段、failureCode与state、timestamps遵守已有9个CHECK；release不能写reserved_bytes=0。partial completion不新建重复row。producer composite FK只校验family/media，job type/gen/recipe/epoch额外在transaction里检查。

## 24. Multi-output job / media semantics

对已获准的IMAGE：**THUMBNAIL与PREVIEW两者都required**。

- 两者current identity READY且canonical验证通过、metadata current、object AVAILABLE：job SUCCEEDED，media READY，清failure。
- 第一kind READY、第二kind可重试错误：保留第一kind；job RETRY_WAIT，media PENDING。retry复用第一kind，只做第二kind。
- 任一required kind永久失败或attempt耗尽：job FAILED；因为当前D2 metadata有效，media PARTIAL，保留所有已READY资产和metadata。不能job PARTIAL或错误SUCCEEDED。
- processing状态仅描述current generation；D3不得重写metadata snapshot或更改D2 PARTIAL是否enqueue的行为。
- root/original unavailable停止工作；若DB健康且同family/media/current generation/current lease仍可确认，D3单独的fenced failure transaction将job FAILED并记录已有ORIGINAL_MISSING/ORIGINAL_CORRUPT/STORAGE_UNAVAILABLE，media BLOCKED，保留metadata/asset证据与reservation，不自动requeue。该failure分支不要求object AVAILABLE，但不能改变storage_objects health。若DB/lease authority不明则零写，留恢复，不捏造已提交状态；不修改D2自身的0-effects行为。

## 25. Failure / retry / idempotency

复用4C attempts、30–45s/120–150s jitter、max3和现有transaction policy；需要atomic asset/media/job更新时复用或提取同源纯backoff逻辑，不复制第二套scheduler。

- permanent：UNSUPPORTED_FORMAT、MALFORMED_MEDIA、INPUT_LIMIT、OUTPUT_LIMIT、CAPABILITY_UNAVAILABLE；不自动反复调整参数。
- transient：TEMPORARY_IO、PROCESS_TIMEOUT、RESOURCE_LIMIT、WORKER_LOST、短暂DB故障；最多既有attempts。COMMIT_OUTCOME_UNKNOWN先查明，不直接新attempt或文件replay。
- DERIVED_INTEGRITY、unsafe root/path、unknown canonical：停止相关写入，不能用普通retry覆盖；故障必须保留证据和计账。
- 若重新render有不同bytes，不覆盖已发布同identity；存在可信matched canonical优先复用。无有效intent不信任existing file。
- fail/retry也验证current owner/epoch/gen；stale错误不应把B的job标FAILED。cleanup失败不得catch-and-ignore释放预留。

## 26. Reprocess / history

generation+1总是新filesystem与DB identity；recipe变更同时新generation。历史job/asset不改写成新generation，不reset旧job attempts。4D3不实现reprocess API或global GC。

已有Guardrails的retention/quota边界继续有效：如果外部已批准流程申请超出保留代数，而更老记录尚未安全清理，则拒绝新admission；D3不为绕过quota擅自删除history/original。

## 27. READ_ONLY / UNAVAILABLE

READ_ONLY只允许inspect/核验/accounting；禁止render-temp/reserve新写/publish/destructive cleanup/provision。UNAVAILABLE fail closed，禁止fallback到系统tmp或创建另一个root。恢复必须验证同marker/device/inode。

worker仅持OriginalReader不代表已获得READ_WRITE状态：DerivedStore/CapacityGate须实现与Phase3相同保守root健康判定，并持续结合DB readiness/object state。无法确认API侧storage capability异常的证据时禁derived写，不能把“reader open成功”当写入门禁。

## 28. Original preservation

任何新增renderer、validator、DerivedStore均无original write/delete/rename/chmod接口；child无root/original parent FD，writer仅derived pinned根。处理前后synthetic original完整bytes/SHA/size/path/inode/mode/mtime必须相同；atime可由只读OS访问改变。

parser/renderer格式失败只影响processing，不标storage CORRUPT。无receipt/source_upload_id/hash/storage_path修改。D3b允许共享容量admission接线，不改变Phase3 immutable model。

## 29. FD allowlist hardening decision

**本阶段必须修复，不继续defer。**新FD4输出使close(4..1023)不可沿用。

macOS启动实现采用平台已验证的close-all-except机制；优先 `POSIX_SPAWN_CLOEXEC_DEFAULT` +显式0–4 file actions，由可信supervisor建立child group与资源限制后启动固定sandbox launcher。不能只设置新FD的CLOEXEC而信任其它遗留FD。平台机制不可用时必须有完整、失败关闭的native FD枚举关闭方案，不回退固定1024上界。Apple维护的进程实现也使用该close-default机制。[Swift Foundation Process](https://github.com/swiftlang/swift-corelibs-foundation/blob/main/Sources/Foundation/Process.swift)

launch-time继承allowlist与runtime库自行打开的系统readonly FD分开核验。测试parent人为创建非CLOEXEC的FD1024以上、DB socket、lock、secret文件，全部不得到child；只测试FD4不算通过。shared launcher加固需要D0/D1回归，不修改其业务结果。

## 30. PGID / termination hardening decision

**本阶段必须修复。**保存明确`childUnreaped`状态；只有owned child尚未reap时允许针对其pid/pgid发signal。`waitpid`成功或ECHILD后禁止任何kill(-pid)，避免PID/PGID reuse窗口。

失败/timeout/liveness EOF：SIGTERM，最多1s grace，仍未reap则SIGKILL，然后等待reap；drain/close所有pipe，终止Promise在资源回收后完成。正常退出必须bounded drain到EOF，再返回结果。fork/exec denial保证没有可逃逸descendant；如果实际probe发现能spawn/脱组，gate失败，不能以blind post-reap kill补救。

真实parent-death、child-crash、ignore-TERM、slow sink测试必须证明无进程/FD残留。supervisor自身被不可捕获SIGKILL时不宣称OS自动reap其child；child不持写文件/锁，父receiver死亡导致pipe关闭，CPU限制提供额外终止边界。Production需要更强整组lifecycle管理，不能把DEV liveness当该保证。

## 31. Required test matrix

所有runtime验证留给实现阶段，synthetic fixtures、真实native child/FS/MySQL，多连接race用明确barrier/query-arrival证据，不以短sleep“尚未完成”代替锁证明。

| Group           | Required checks                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| formats/recipes | 四种格式每kind；无EXIF；alpha/颜色；非正方形orientation1–8重点5/6/7/8；首帧subrectangle/canvas；输出无EXIF/GPS/ICC/animation；尺寸/quality registry；HEIC/RAW明确disabled                                                                          |
| bombs/protocol  | max input/dim/pixel边界；伪小header实际大图；多帧超限；metadata/record预算；错length/多JSON/trailing bytes；binary/control/stderr flood；slow sink/timeout；完整decode验证truncated输出                                                            |
| isolation       | FD3 read/seek、FD4 output；write/truncate/chmod/reopen original拒绝；其它object/root/secret/network/DNS/fork/self-exec/posix_spawn拒绝；高FDallowlist；parent death、crash、reap/PGID tests                                                        |
| storage         | wrong marker/device/owner/ACL；symlink temp/destination/parent swap、hardlink/FIFO；O_EXCL；existing canonical equal/mismatch；no-clobber；same generation duplicate、new gen/recipe separated；READ_ONLY/UNAVAILABLE；native derived→original攻击 |
| DB/fence        | current success、cross-family/producer mismatch、expired-before-publish零IO；render后B reclaim导致A零DB；pre-fence后expiry只可留下candidate且零READY；generation bump旧candidate不污染当前；锁后时间；1062分类                                     |
| recovery        | SIGKILL在seal/intent commit/rename/READY commit两侧；reserve/intent/READY COMMIT unknown；真实restart known recovery；job completion rollback；preview失败保留thumb；wrong hash不覆盖                                                              |
| capacity        | API+worker两真实进程near-full并发；仅一方admission；family/global/physical边界；oldgen/failed/unknown残留；cleanup失败不释放；delete后DB failure恢复；>1250条分页；scan不完整拒绝；第二writer启动拒绝                                              |
| invariants      | original before/after bytes/SHA/inode/mode/mtime/path；receipt不变；max3/backoff不变；history保留；synthetic DB/derived/temp/process/FD residue=0                                                                                                  |
| regression      | D0/D1/D2 targeted、4A schema/readiness、4B canonical、4C lease、Phase3 storage/upload admission；scoped typecheck/lint/format；日志sink无敏感数据                                                                                                  |

stale窗口必须分两种断言：**fence前失权=>canonical不存在**；**fence后才失权=>允许matched uncommitted candidate，但A READY/job rows=0**。不能用前一种测试宣称消除了后一种窗口。

## 32. P0/P1 design risks and remaining limits

| Risk if control omitted           | Level | Approved control / implementation gate                                             |
| --------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| original写入或derived cleanup逃逸 | P0    | readonly FD+sandbox+native pinned path class+immutability probes                   |
| secret/network/继承FD泄漏         | P1    | clean env、full FD allowlist、真实denials、无child root/lock/DB能力                |
| binary/decode/动画无限资源        | P1    | 独立byte caps、single frame、input/header/CPU/wall bounds、RSS watchdog+声明其限制 |
| stale READY/generation覆盖        | P1    | double fenced DB、immutable versioned no-clobber、独占writer、candidate recovery   |
| READY半文件或未知commit被重放     | P1    | seal/validate/sync、PUBLISHING intent、second transaction、unknown outcome只读查明 |
| crash残留导致超额预留             | P1    | shared capacity lock、DB reservation、完整inventory、cleanup confirmed release     |

以上设计控制明确后，**未解决的设计P0/P1为0**；所有runtime gates目前未执行，不能据此把之前implementation blocker标成代码已修复。

仍保留的P2/Production限制：macOS DEV sandbox与native瞬时RSS边界；真实power-loss/SSD断连；persistent audit/rate limiting；Phase3旧generic destructive primitive path-class defense-in-depth；D2既有P2。本次不宣称修复。FD allowlist和post-reap PGID从deferred提升为4D3a必做。

## 33. Implementation split and expected files

**推荐并要求分三步交付，每步报告后停止。**

1. **4D3a — Renderer isolation/binary capability**：fixed native renderer+libwebp build manifest、独立binary protocol、FD/PGID hardening、sealed-output verifier、format/resource/golden tests。只synthetic sink，不接通DB/正式derived publish。D0/D1/D2回归必须通过。
2. **4D3b — DerivedStore/capacity/publish**：explicit DEV provisioning、native path-class handles、temp/seal/no-clobber、DB reservations、shared API/worker CapacityGate、accounting/known recovery基础；真实跨进程admission和crash tests。此步完成前worker不得写正式derived。
3. **4D3c — Image derivative worker/repository**：复用4C claim，新增fenced asset/job/media transaction、两kind orchestration、failure/known recovery、真实MySQL与FS竞态/故障注入。通过后再做4D3独立review，不进入video/Phase5。

预计实现触及（本次均未改）：

- `packages/storage/src/index.ts` 或局部新 `derived-store.ts/capacity.ts`：opaque capability/public narrow API。
- `packages/storage/native/storage_native.c` 或新derived native单元：独立handle/path class、锁、temp/publish/accounting；不增加original破坏能力。
- `packages/storage/native/original_probe_supervisor.c`、新增image supervisor/profile：有界二进制relay、FD/PGID加固，保持D1控制协议。
- `packages/media/native/image_renderer_child.m`、局部build脚本/dependency manifest：fixed ImageIO/libwebp renderer与output verifier。
- `packages/media/src`：capability-gated renderer、固定recipe registry、strict control/output validation。
- `packages/db/src/derived-repository.ts`（新增）、必要同源job backoff helper：reservation/PUBLISHING/READY/aggregation/recovery；无schema/migration修改。
- `apps/worker/src/image-derivatives.ts`（新增）：顺序调度/cancel/heartbeat/recovery/log白名单。
- `apps/api/src/uploads/service.ts`、相关admission接口：只接入共享capacity gate和derived outstanding；不改storage lifecycle。
- 对应unit/native/integration/race/fault-injection tests及阶段文档。

若implementation发现无法满足固定FD输入、无path fallback、二阶段no-exec、no-clobber、DB reservation或stale candidate边界，必须停止R3复核；不得自行改schema/0003、发明0004、放宽sandbox或把未通过capability标为支持。

## Final decision

```text
DESIGN_CHANGE_REQUIRED: YES
DATABASE_MIGRATION_REQUIRED: NO
D0_ISOLATION_BOUNDARY_EXTENSION_REQUIRED: YES
DERIVED_STORE_REQUIRED: YES
BINARY_OUTPUT_PROTOCOL_APPROVED: YES
IMAGE_RENDERER_CAPABILITY_GATE_REQUIRED: YES
HEIC_DERIVATIVES_ENABLED_IN_V1: NO
RAW_DNG_DERIVATIVES_ENABLED_IN_V1: NO
READY_FOR_PHASE_4D3_IMPLEMENTATION: YES
```

这是设计许可，不是runtime PASS。下一步仅4D3a；本轮不开始实现。
