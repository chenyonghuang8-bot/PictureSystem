# Phase 8 地图 / 地点 / 上传运行接线独立审查

2026-10-04 UTC。限定源码与验证审查；审查者未修改实现、测试、配置、历史文档或 migration，未执行 DDL、native rebuild、Git 写操作、Production 或真实媒体操作。仅新增本报告；诊断脚本与新日志保存在 `/tmp`。父代理提供的服务端路由记录为 `gpt-6-astra / low / default`，本报告据此继续 R3 复核，不依赖不可见的模型标签推断。

```text
ROUTING DECISION
Profile: PRO_STABLE
Risk: R3-DESIGN
Current Model: GPT-6 Astra Low (parent-supplied confirmed routing record)
Recommended Model: GPT-6 Astra Low
Test Scope: targeted
Action: continue
Reason: independent scoped implementation/security review

REVIEW: NEEDS_FIX
NEW_P0: 0
NEW_P1: 0
NEW_P2_CODE_FINDINGS: 2
PHASE_8_COMPLETE: NO
FULL_GATE_RUN_BY_REVIEWER: NO
PRODUCTION_READY: NO
```

没有在已审范围发现新的越权、精确 GPS 外发、Original 改写或未知提交盲重放问题。以下两项是可定位、可复现的实现问题；另有批准验收矩阵的证据缺口，不能从现有 PASS 推导全部覆盖。修复与必要补测后做限定复核，再由父代理执行最终完整 gate。本结论不重开已关闭非地点搜索或 Phase 7，不要求更换架构。

## 候选与变更指纹

- HEAD：`0c948451774efd10a293029e727b666758441436`。
- `git diff HEAD --binary` SHA-256：`8192782cfabb27ce91356507ef2c2c7cc06b354d89adecb54c89825266bc3772`。
- 审查开始时，tracked changed 与 nonignored untracked 文件合并、按路径排序，对每个文件取 SHA-256，生成 compact JSON `[{"path":...,"sha256":...},...]`：共 **74 文件**；该清单 SHA-256：`d7df09e0bd146480e3bbbc215c0374ad2aefe6310f8ec183796e5fc91de2294b`。清单：`/tmp/phase8-review-fingerprint.json`。包括资源数据与继承的 Web AGENTS/CLAUDE，不包括 ignored 构建物、缓存、`.env`；不对秘密文件取证或输出。
- 完成审查、写报告前重算：74 文件均无变化，tracked diff 指纹一致。本报告是唯一新增仓库交付文件。
- 0000–0007 migration SQL 的 `git diff --numstat HEAD` 为空；本轮没有执行 migration。live integration 的 readiness 检查通过当前 schema。

关键文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| apps/api/src/index.ts | `3dbf7632dfdde7dc06352fafe5107538571c7b5c3d9391119caa8bb5f8be7306` |
| apps/api/src/uploads/pipeline-reconciler.ts | `94cff43fcf5f224cc5e7f1a279c1659c564029c727bae26442b3c39feb028c62` |
| packages/db/src/upload-pipeline-reconciliation.ts | `4c19daa1488c09193866c7b2a45bebc9110c28669af62ec2404ea6249a1e3c8d` |
| apps/worker/src/metadata-main.ts | `ac05f138483a1ff1bc4e5b7742686b40d0edd246069c64d56a56ced1ba362aa1` |
| apps/web/components/gallery/location-map.tsx | `95e3b60729b6e5639de0b0d4e21d15e9d5288100737c449f63c8f931f8513aee` |
| apps/web/lib/gallery-paths.ts | `ae9baae15e918d38ef53741fdf9e8d6bbc83292cf62d6a22a71a7915dbf029bd` |
| packages/db/src/location-projection-repository.ts | `53d2b58e20067cf7cf5d6413ecbb9c9c054f590729993aa204e1cb9dab1a35d7` |
| packages/db/src/metadata-repository.ts | `ba65ba0d397d001c8fae60a154602ee257c4e642420a6b97a325ad571e23a20b` |
| packages/media/src/location-projection.ts | `1c3892d39968f13d74b8b35d15dc98f2b8a23b5221f34b4a8435dd2574835bfe` |
| packages/media/src/location-map.ts | `3e1eec1e866ff48639324f7f799ae3968dc876b4a71c05b02b978dfc361ce361` |

已读取仓库与 Web AGENTS、PROJECT 地图合同、ROADMAP Phase 8、Phase 8 plan、三个 location projection / derivative attachment / upload reconciliation guardrails、最新 MAP-PIPELINE-IMPLEMENTATION、相关 checkpoint/运行记录、实际 diff 与新增源码/测试。较旧文档的未批准地图状态由最新已批合同覆盖。

## Findings

### P8-MAP-R1 — P2：metadata 停止信号之后仍会领取下一项任务

**位置：** `apps/worker/src/metadata-main.ts:51`–54；相关恢复循环 `apps/worker/src/metadata-driver.ts:63`–73。

**触发：** `while (!stopping)` 已进入，进程在 `await driver.recoverExpired()` 尚未返回时收到 SIGTERM/SIGINT。信号只把 `stopping` 设为 true；恢复返回后没有再检查，仍执行 `driver.runNext()`。恢复批次内部也没有停止选择检查，可能继续处理本批剩余恢复项。

**影响：** 用户要求停止后仍可新 claim、启动 native probe，并写 metadata/projection/downstream job。退出等待增加，若部署者因超时强杀，额外任务留下新的 RUNNING lease。这违反本批 stop-selection/drain 合同；现有 lease/fencing 仍有效，本审查未据此宣称数据损坏或越权。

**复现证据：** `/tmp/phase8-shutdown-diagnose.mjs` 直接打包当前 `metadata-main.ts`，仅用内存 collaborator 替换 DB/storage/driver，不改源文件、不接触媒体。mock recovery 期间同步投递 SIGTERM；输出严格为：

```text
RECOVERY_ENTER
STOP_DELIVERED
CLAIM_AFTER_STOP
READER_CLOSED
POOL_CLOSED
```

这是停止控制流的确定性复现，不冒充真实进程/native drain 验收。API derivative driver 已有相应停止检查，可复用其模式。

**最小修复：** recovery 返回后、每次新 claim 前检查 stop；恢复批次在每个独立恢复事务之间检查 stop。已开始的事务/probe 必须正常 settle 后再关 reader/pool，不能通过 abort 正在执行的 DB/native 操作实现停止。无需修改锁序、lease 或 schema。

**必要回归：** barrier 暂停 discovery/recovery，送达 SIGTERM，再放行；断言无后续 recovery selection/claim，原 in-flight 操作 settle 后仅关闭一次资源。另验证已有 probe 中的停止会 drain，空闲退出仍正常。

### P8-MAP-R2 — P2：合法近零视野边界被序列化为 API 拒绝的科学计数法

**位置：** `apps/web/lib/gallery-paths.ts:211`；API 合同 `packages/contracts/src/gallery.ts:340` 附近的 bbox regex；来源为 `location-map.tsx:342`–353 的浮点 bounds。

**触发：** 地图视野的一条经纬边界接近赤道/本初子午线，例如 west = `-0.0000001`。`bbox.join(',')` 使用 JavaScript 的数值字符串化，生成 `-1e-7`；严格 bbox schema 只接受普通十进制。

**影响：** 合法地图移动产生应用自己的 400 INVALID_REQUEST，地点图进入“地点暂不可用”，同一视野重试仍失败。与 OpenFreeMap 供应商超时无关；只影响特定边界，不能把它解释为此前 hosted-load 失败原因。

**复现证据：** 使用当前源码 `locationMapPath('1', {}, [-0.0000001,-10,10,10], 10)`，把所得 URL query 交给当前 `familyMapQuerySchema.safeParse`：

```json
{"bbox":"-1e-7,-10,10,10","accepted":false}
{"bbox":"-180,-90,180,90","accepted":true}
```

**最小修复：** 客户端统一按受限普通十进制序列化 bounds（保持反子午线与有限数值语义、总长度预算，避免 `-0` / exponent）；也可在合同中显式、安全地接受有限指数形式，但不应绕开范围/预算校验。不需要改变 H3/GPS 精度政策。

**必要回归：** 近零正负 longitude/latitude、普通边界、±180、反子午线；断言生产 URL 经实际 query schema 接受，浏览器移动后的地图请求返回正常。保留 NaN/Infinity/越界输入拒绝。

## 验证证据与尚未覆盖的批准矩阵

独立执行的定向命令包含以下 11 个文件（未运行全量 gate）：

```text
apps/api/src/uploads/pipeline-reconciler.test.ts
apps/worker/src/serial-job-loop.test.ts
apps/worker/src/image-derivative-driver.test.ts
apps/api/src/albums/location-routes.test.ts
packages/media/src/location-projection.test.ts
packages/contracts/src/location.test.ts
apps/web/lib/map-provider.test.ts
tests/integration/phase8-upload-pipeline.test.ts
tests/integration/phase8-location-metadata.test.ts
tests/integration/phase8-location.test.ts
tests/integration/phase4d3c-worker.test.ts
```

`pnpm exec vitest run <上述文件> --reporter=dot`：**11 files PASS / 59 tests PASS / skip=0**，19.58s，exit 0。日志 `/tmp/phase8-review-targeted-live.log`。第一次默认沙箱连接 MySQL 返回 EPERM，4 suites 失败、35 tests 因 setup 失败跳过，记录 `/tmp/phase8-review-targeted.log`；经自动审批允许的本机 DEV/native 权限复跑后才取得上述 PASS。失败运行没有计入成功。候选的 12 files / 60 tests 是另一份原记录，不能与本轮相加。

核对真实上传测试 `phase8-upload-pipeline.test.ts:286`：真实认证 TUS POST/PATCH/finalize → COMPLETE（当时无 media）→ SIGKILL → 实际 reconciler 的 T1 后异常 → built API 重启发现 B → probe → 独立 native metadata → derivative READY。media/job/READY/placement 没有在这条 E2E 中手工 INSERT；album 与 placement 经现有 API。第二上传者 dedup 保持 canonical source，并未获得 CUSTOM album 地图计数。Original bytes/hash/inode 保持。物理连接 COMMIT 的提交/回滚响应丢失用例另外验证 T1/T2 与 projection 的新观察恢复。这是真实关键链证据，不是仅依赖候选报告。

源码核对通过的关键边界：

- res6 cell 是唯一精确 GPS 派生入口；标签、bbox、逻辑 parent、过滤和计数使用粗 cell。500 clusters 通过降 parent resolution 完整聚合，没有截断。国家未知/歧义未知与同国 50km 附近城市遵循最终 pinned policy。
- 查询复用 `buildFamilySearchQuery` 的 actor/live album ACL、active lifecycle、AND filters、去重；位置查询移除媒体分页后才聚合，无 ADMIN bypass；当前 generation/metadata/P/D join，无旧投影回退。API/BFF private no-store，没有跨请求位置结果缓存。
- metadata snapshot/projection invalidate+insert/downstream/probe completion 在同一现有 fenced transaction；backfill 锁序与 token CAS 包括 storage/generation/recipe/lifecycle/GPS，未知提交停止。purge 子表删除列表已纳入 projection。
- reconciler 使用 COMPLETE 权威发现、固定 high-water keyset、公平 advance、独立 L-S 和每次 fresh locking observation；T1/T2 独立，不外包围事务、不改 source，不复活 inactive、不重开 FAILED、不盲 replay unknown。
- API sole writer 共享 gate/reader，单 DerivedStore；启动后才启动 loops；异常停止两 loops，onClose 后 drain 再按顺序关资源。processor 新 catch 区域把 DB 异常传播与 storage 错误分开。

**以下是证据不足，不是已证明实现有相应竞态缺陷。Phase 8 最终验收前仍需补齐或由负责验收者明确记录未完成；不能用现有 59/60 PASS 宣称全部 guardrails 矩阵通过：**

1. **完整进程的 A 恢复路径**：现有 E2E 对 A 使用真实 reconciler 方法执行 T1，再由 built API 自动处理 B；没有一条独立用例从纯 COMPLETE/no media 直接启动 enabled built API 并全自动完成 A+B。最小补测保持同一真实 TUS fixture，去掉中间 helper 操作，重启直接到 READY。
2. **真实数据库 fairness 与并发 dedup**：>2 pages、低 ID poison/late COMPLETE/continuous high-water 目前是 `pipeline-reconciler.test.ts:199`、`:231` 的内存 mock；真实 dedup 用例按顺序上传，未 barrier 并发两个 receipt 的 T1/T2。增加最小实际 repo 分页+有界状态混合与同 K 双 receipt barrier，断言高 ID 进展、唯一 canonical/probe、source 稳定。不要重写 scheduler。
3. **生命周期/投影竞态**：已有 L-X 等待、已 trash/restore、stale token 和同 generation GPS replacement 双锁序；没有实际 purge retirement 对 reconciler、以及持 projection 子行的真实 purge 完成验收；generation、trash/restore、lease takeover 对 backfill 的全部双序 barrier 也没有齐备。优先补与新增 FK 删除和新 receipt observer 直接相交的 purge/retired 路径，再用最小双连接 barrier 验证剩余 fencing 假设，不能仅靠手动改状态后单次读取替代并发证明。
4. **拥有者停止/资源收尾**：unit SerialJobLoop 和 API idle SIGTERM/listen-failure 成功，不能证明 stop-during-native-render/publishing + 同 owner 上传 admission 并发。需要 barrier 证明不新 claim，当前 render/publication 与请求 settle 后再关共享 gate/store/root；未知 DB 错误路径不能追加补偿写。P8-MAP-R1 回归一并完成。

未重新运行 format/lint/typecheck/build；已核对候选相应日志及最后修改记录，相关 built API/worker/DB 文件时间晚于对应 runtime 源码；本轮源码指纹未变化。`git diff --check` 独立通过。真实电源中断、SSD 拔出、Production、本次未新增的历史风险都不在本次验证承诺内。

## OpenFreeMap：失败保留与诊断边界

**原候选最终浏览器结果仍为 22 PASS / 1 FAIL。** `.cache/phase8-map/evidence/pipeline-browser-final.log` 的失败确实是在 15 秒 deadline 后出现“底图暂不可用”，不能改记 PASS；后续成功是新的独立观察。

本次没有替换 provider、自动降级到公共 OSM、批量下载 tiles，或发送真实坐标/照片。`/tmp/phase8-map-diagnose.mjs` 用当前真实 Web 组件、同一 worker 文件、独立 headless Chrome 临时 profile 和 synthetic 本地 API response，在请求开始前记录 URL/status/timing/失败类别。诊断日志 `/tmp/phase8-map-diagnostic.json` 与 `/tmp/phase8-map-diagnostic.log`：

- 本地 worker.mjs/shared.mjs：200，约 0.27/0.29s。
- `https://tiles.openfreemap.org/styles/liberty`：200，约 2.05s；planet：200，约 2.32s。
- sprites/raster/vector/font 依次 200；共 **36 个外部请求**，无 Referer/Cookie/Authorization。
- 约 **4.56s**：fallback=0、canvas=1、marker=1；无 CSP、MAP_RESOURCE_REFUSED、初始化或 worker 错误。
- 唯一 console 404 的 URL 被具体定位为 fixture 的 `http://localhost/api/v1/media/11/derived/thumbnail`，不是 OpenFreeMap 资源，也不是本次 favicon。旧 resume 文档把该诊断泛称 favicon，不能沿用成已验证事实。

随后不改测试，执行：

```text
pnpm exec vitest run apps/web/components/gallery/location-browser.test.ts \
  -t 'uses real hosted interactive basemap' --reporter=dot
```

**1 selected test PASS / 6 intentionally unselected tests skipped**，5.58s，exit 0；`/tmp/phase8-review-hosted.log`。这是单用例新窗口 PASS，不是 7/7 或原 23 项全部通过；最终 full gate 必须记录其自己真实结果。

**可以排除到的边界：** 同一源码在当前窗口能完成真实 hosted load，worker URL/资源同源策略/MapLibre 初始化不存在本次可复现的固定失败。测试 harness 返回 HTML 时没有 CSP，实际源码检索也未发现新增 CSP 配置，所以原 harness 失败不能归因为一个未证实的应用 CSP 拦截。成功诊断没有真实 Next 页面部署、反向代理的额外 CSP；不能据此认证所有部署环境。

**不能倒推的原因：** 旧失败日志只含笼统 404 和 deadline 移除 map 后的 ERR_ABORTED，缺少当时逐请求 URL/status/timing、pending 阶段。无法区分当时是供应商/CDN、网络链路、浏览器资源调度/渲染迟滞，或超过 15 秒的正常慢加载；ERR_ABORTED 本身是超时主动取消的后果，不是网络故障证明。当前成功支持“间歇性外部加载条件”假说，但不证明供应商曾宕机。不要仅为消灭失败增加超时或改成功断言。未来如再失败，保留 deadline 前未完成 URL、timing、map error 与实际页面 CSP 响应；同时保留 fallback/region/retry 的独立用例。

## 给实现者的一批收口动作

1. 修复 P8-MAP-R1 / R2，并增加上述精确回归；在已批护栏内完成即可，无需再次选择产品方案或重设计事务。
2. 补充与新接线直接有关的真实 A 启动、fairness/dedup/lifecycle 和 owner drain 证据，清楚标注 mock、真实 DB、真实 native 与进程级验证的区别。
3. 限定复核修复 diff 与新证据，然后执行 Phase 8 full gate；真实 provider 若再失败仍报告失败及诊断，不用 deterministic style 成功替代。

审查结束后停止，不宣布 Phase 8 完成，不进入下一 Phase、不 commit/push/tag/deploy。
