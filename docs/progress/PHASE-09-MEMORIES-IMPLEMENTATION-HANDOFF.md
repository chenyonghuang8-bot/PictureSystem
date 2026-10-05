# Phase 9 Memories implementation handoff

日期：2026-10-05。状态：实现候选与定向验收完成，等待父代理一次独立审查；全 Phase 9 Quality Gate 尚未运行。本批未 commit/push/deploy，不进入 Phase 10。

基线 HEAD：`979d6eb063a1137387ded31330ea3a3a6cd99436`（已发布的 Phase 8）。本批按 `PHASE-09-MEMORIES-IMPLEMENTATION-GUARDRAILS.md` 的 Astra 批准方案实施。没有数据库 schema、migration、索引、存储事务、权限边界或 Auth/Session 设计变更。Web AGENTS/CLAUDE 属于既有无关未跟踪文件，未修改。

## 实现

- Contracts：固定 Asia/Shanghai、memories-v1、往年今日和一年前的这周；严格查询和独立 cursor DTO。往年今日按同月日的历史年份，2 月 29 日仅匹配真实闰日；一年前的这周先按日历减一年并夹取日期，再求周一至下周一半开区间。
- DB：每个请求在既有 checked transaction 中 family lock → actor lock → 一次 SQL serverNow → 当前 actor 验证 → 日历和查询。合并首页预览的两个卡片共享同一上下文。内部测试时钟不开放 HTTP 或环境变量入口。
- 查询：literal DATE(captured_local_at)，没有拍摄日期时用 canonical DATE(uploaded_at)。先限定当前授权、active IMAGE、READY、current metadata generation、recipe 1、AVAILABLE original、coherent COMPLETE source receipt、当前有效 PREVIEW 和 THUMBNAIL，再去重、选最小可见 album、排序和 limit+1。ADMIN/SUPER_ADMIN 无绕过。默认 48，最大 100；预览各 6。
- API：GET memories 与 memories/preview；独立 canonical base64url/UTF-8/严格 JSON cursor，SHA scope 绑定 actor/family/kind/anchor/zone/policy/limit。当前授权先于过期 anchor 的 409。保留实际既有扁平错误 envelope `{code,message,requestId}`；guardrails 对旧 envelope 的描述不适用于实际源码，没有重设计错误响应。
- Web：首页双卡片、回忆导航与完整分页、拍摄/上传日期标签、复用 PhotoGrid 和 Viewer。API/proxy/动态页面不缓存，无跨请求 server cache。
- 客户端：epoch、Abort 和保守 monotonic 请求起点 deadline；late 200/409/午夜 timer 共用一次自动 bootstrap 预算。内容在 actor/family/kind 切换、auth loss、挂起、unmount 时清空；处理 visibility、persisted pageshow、popstate 重新验证。普通首次 pageshow 不重复 activate，修复了首轮浏览器测试发现的重复请求和预算重置。无回忆照片在 SSR provisional 阶段输出。原有浏览器验收是模拟 persisted pageshow + 同文档 history；真实跨文档 BFCache 与实际可见性后续补测见 closure handoff。
- Viewer 既有 403 detail 失败现在与 404 一样清空详情和显示不可用，不改授权决策。Gallery client 401 发出窄 `family-auth-lost` 通知供同页回忆清空。
- 新的 Playwright 回忆配置仅启动既有 owned synthetic DEV harness 与实际 pipeline。总 Web suite runner 对回忆 suite 使用同样配置。

## 定向证据（本轮实际执行，不累加重叠旧轮计数）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Calendar/cursor/API/session/gallery regression | 7 files / 41 PASS / 0 skip | `.cache/phase9/unit-final.log` |
| Chrome Memories browser | 1 file / 5 PASS / 0 skip | `.cache/phase9/browser-resume-elevated.log` |
| 真实 Chrome BFCache / visibility / no-store 重载补测 | 1 file / 5 PASS / 0 skip | `.cache/phase9/real-bfcache-final.log`、`real-bfcache-proof.json`；限度见 closure handoff |
| DEV MySQL query/auth/date/pagination matrix | 1 file / 7 PASS / 0 skip | `.cache/phase9/mysql-final.log` |
| Real HTTPS synthetic upload → metadata/native READY → placement API → Home/full page/Viewer | 1 PASS，58.5s（总 1.1m），重复验收通过 | `.cache/phase9/https-upload-proof.json`，`https-upload-final.log` |
| 10k first/deep page EXPLAIN ANALYZE，两个种类 | PASS；每次返回 ≤49，无新索引 | `.cache/phase9/explain-10k.json` |
| `pnpm lint` | PASS | 本轮工具 exit 0 |
| `pnpm format:check` | PASS | 本轮工具 exit 0 |
| `pnpm typecheck` 全工作区 | PASS | 本轮工具 exit 0，包括 API/Web/DB/contracts/worker/mobile |
| API、DB、contracts build | PASS | `.cache/phase9/api-build.log`、先前构建记录；最后 DB build exit 0 |
| Web production build | PASS | 本轮工具 exit 0，新增 memories/page 和两个动态代理路由均输出 |
| `git diff --check` | PASS | 本轮工具 exit 0 |

真实上传验收使用两张自建历史 EXIF JPEG，没有手工 seed media/job，也没有公开测试时钟。登录、TUS finalize、metadata 子进程、native derivatives、READY、相册 placement 均实际执行；Original SHA 和 inode 前后不变。拍摄日期与 server anchor 取自真实 API。测试只操作 owned DEV family/user 与系统 tmp fixture。DB 查询矩阵的手插 synthetic rows 只证明查询，未充当上传端到端证据。

MySQL 矩阵包括 owner/FAMILY/explicit grant、grant revoke、隐藏集合对 preview/hasMore 不影响、三种角色无 bypass、相同 timeline key 稳定分页和 last-emitted cursor、页间 placement 删除、current user/member/session disable/revoke 优先于过期响应、重新计算 SHA 的过去/未来 anchor、闰日和跨年周、无日期 canonical UTC fallback。过滤矩阵包括 PENDING/PROCESSING/PARTIAL/FAILED/BLOCKED、VIDEO、recipe、stale assets、缺任一派生、尺寸超限、PUBLISHING、source hash 不一致、MISSING original、Trash/purge intent、deleted album。数据库禁止的 READY stale metadata 和 thumbnail reservation 超限通过实际 CHECK 拒绝验证，没有关闭 CHECK/FK。

## 失败、修复和检查限度

初轮 browser 2 PASS/3 FAIL：普通初始 pageshow 重复启动；已修复并重跑 5 PASS。Chrome 沙箱运行失败于 EPERM，不能算通过或产品失败；沙箱外的合成定向 Chrome 通过。HTTPS 沙箱 API 启动失败，沙箱外验收通过。前期/补充 MySQL fixture 曾因现存 CHECK、必填字段、dist 错误类身份而失败；修正 fixture/build/import 后最后 7 PASS，原始失败记录保留。

额外探索命令 `pnpm exec tsc --noEmit -p tsconfig.vitest.json` 不是项目正式类型 gate，失败：根测试集合包含既有 NODE_ENV/Timeout 类型和 mysql2 根模块解析等诊断。修复本批测试类型 imports 为 DB package 的 type-only exports 后，本批 memories/phase9 文件诊断为 0；其余既有诊断未扩展修复。该额外命令不能报告 PASS，完整输出在 `.cache/phase9/optional-root-test-tsc.log`。正式 `pnpm typecheck` PASS。

本轮没有复审 Phase 7，没有再跑全 Phase 8 gate，没有 Production/真实媒体操作，没有新增服务或公网外联策略。Next dev 生成的 next-env.d.ts 已恢复基线构建 paths。测试 cleanup 只处理 owned family IDs；没有 home ACL 修改或删除别人的 tmp。

后续独立审查已确认无源码 P0/P1，额外根测试 tsc 基线与候选均 201 条诊断、无新增错误位置；该额外检查仍记 FAIL，非本批引入，不扩范围修复。审查唯一 P2-01 真实生命周期证据缺口已补测，见 `PHASE-09-MEMORIES-BFCACHE-CLOSURE-HANDOFF.md`。原审查者 closure 和全 Phase 9 gate 仍待完成。

## 父代理下一步

请对最终候选做一次独立只读审查，重点检查 transaction/current auth 顺序、displayable SQL 完整性、cursor/409 优先级、共享 bootstrap 预算与浏览器恢复、真实 pipeline 证据。解决审查 blocker 后再运行一次全 Phase 9 gate，并形成最终阶段总结。独立审查及全 gate 尚未完成，因此当前不声明 Phase 9 COMPLETE 或 production ready。

候选 SHA 指纹与 evidence 摘要：`.cache/phase9/final-candidate-fingerprint.json`。审批过的 guardrails 保持原文。
