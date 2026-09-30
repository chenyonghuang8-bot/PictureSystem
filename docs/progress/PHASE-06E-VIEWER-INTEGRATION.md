# Phase 6E — Viewer Integration

日期：2026-09-30。基线：`main` / HEAD 与 origin/main 均为 `e8c144108b5d7875b3e22fdb3821a83a8dc2509d`（Complete Phase 6D download validation）。本次完成私有 Web Viewer 集成，等待一次独立 review；不 stage、commit 或 push。

## Implementation

保留现有 Preview/thumbnail fallback、元数据、相册 placement、上一张/下一张与 Escape。Viewer 保存经过 schema 验证的 `GalleryMediaDetail`，以 familyId + selected albumId + mediaId 为 React session key。切换、关闭和卸载清除详情、草稿、评论与 pending 状态；异步响应有 mounted/request-sequence guard，迟到详情不更新新照片或父页面。不新增持久化浏览器存储或全局 cache。Timeline/AlbumDetail 通过小型 onDetail callback 同步当前页 favorite/featured 字段。

新增照片详情分组：favorite、family featured、tags、note、按需分页 comments、Original/Preview 下载。Featured/tags/note/comment mutation 控件使用服务端 capability；favorite 对所有成功 view-authorized detail 可操作；comment delete 只使用每条 DTO 的 `canDelete`。不在浏览器推断角色或 author ownership。Tags/note/comments 全部使用 React 文本渲染。

每类操作使用同步 ref guard 与组件 pending 状态防止重复提交，相关按钮禁用，其他控件保持可用。mutation 成功刷新当前 selected-album detail；tags 不创建全局 dictionary 或 rename UI。Comments 仅点击查看时通过 limit=20/cursor 加载，去重合并分页；POST 不自动 replay，delete 接受既有 204 响应。

Note 编辑捕获当前 detail.noteRevision，保存传 note + expectedRevision。真实 409 后只执行 GET 刷新，丢弃过期草稿并展示最新 note/revision；用户可重新进入编辑，不自动重试 PUT。所有错误转换为固定、安全的用户消息。

## Capability / download semantics

`MySqlAlbumRepository.getAlbumMedia()` 已在既有事务完成 view authorization；返回的 `canDownloadOriginal` / `canDownloadPreview` 从 false 改为 true，表示已实现功能可供该 private detail 尝试使用。它们不是下载授权来源或 storage-health/READY preflight；不增加 storage read，不复制下载授权查询。原有 download routes 保持 current-state prepare/recheck/integrity/limiter 检查。

下载为普通 same-origin anchor，使用经过 assertGalleryId 的 selected albumId/mediaId 路径，无 token、signed URL 或预下载请求。Viewer 不 fetch attachment，不调用 blob/arrayBuffer/base64，不将 Original 或 Preview 重新缓冲。服务端 attachment 直接交给浏览器下载管理器，失败可由浏览器展示服务端响应。Original/Preview service、download authorization functions 与 storage/native production source 均未改变。

PublicShare/PublicViewer 不使用新私有详情组件。public unit/API/MySQL/HTTPS 回归继续验证只展示 thumbnail/preview，无 favorite/featured/tags/note/comments 或 private download 控件。

## Responsive / focus

照片优先，详情放在图像下方的有限宽度暖白分组面板；input/textarea min-width=0，按钮和标签换行，文本可折行。390px mobile 真实验收确认 Viewer 无横向溢出且下载链接可见。进入 Viewer 聚焦关闭按钮，关闭恢复先前焦点；编辑备注聚焦 textarea。Escape 与点击导航保持，不增加输入时触发的箭头快捷键。

## Targeted evidence

现有 gallery component/client/API/public 与 6B/6C/MySQL public regression：9 files / 84 tests PASS，skip 0。扩展既有 authenticated-gallery.spec.ts，真实 HTTPS → Next rewrite → API → family_album_dev、真实登录与 Secure HttpOnly session Cookie；5/5 PASS，skip 0。

Owner/admin 真实 UI：favorite toggle、featured toggle、tag add/remove、note save、另一真实 writer 制造 CAS 409（页面仅一次 PUT，GET 展示最新 note）、comment create/delete（request barrier 连续两次 requestSubmit 仅一次 POST）、小型 synthetic Original/Preview 浏览器 download event 成功。viewer-only：edit/featured hidden、favorite/comment allowed、他人评论无 delete、downloads enabled。hidden selected album detail 为 404。迟到旧 detail 用确定性屏障验证丢弃。desktop/mobile/public 原有流程通过。

HTTPS 启动前需重建被修改的 `@family-album/db`，因为 API 使用 dist export；首次新 UI download link 验收暴露旧 dist 的 false capability，重建后通过。首次受限沙箱 DEV MySQL 的 EPERM 已在授权环境重跑成功，不作为测试 skip。

新增测试文件：0；扩展 gallery.test.ts、gallery-client.test.ts、share.test.ts、gallery-routes.test.ts、phase6c-tags-notes-comments.test.ts 和 authenticated-gallery.spec.ts。新 production component viewer-details.tsx 用于将表单/评论操作与原有 Viewer image/placement 生命周期分离。

## Final gates / residue

最后一次 functional/test 修改之后：lint、format check、typecheck、build 全部 PASS；完整 Vitest 124 files / 1009 tests PASS，skip 0；独立 DEV MySQL integration/race 28 files / 279 tests PASS，skip 0；API E2E 5/5 PASS；完整 HTTPS Web E2E 15/15 PASS（本次 Viewer 5、既有 download 10），skip 0；migration readiness 1 file / 23 tests PASS；git diff --check PASS。format gate 的首次失败是一处新增 public test 断言换行，机械格式修正后 lint/format 重跑 PASS，未改变测试语义。后续只有本文档更新与 next-env.d.ts 的生成引用恢复；LAST_FUNCTIONAL_OR_TEST_CHANGE_PRECEDES_FINAL_GATES: YES，FULL_GATE_EVIDENCE_STALE: NO。

新 HTTPS fixtures 的 afterAll 在真实事务中删除 comments/media_tags/tags/user_favorites/family_featured、share/media/storage/upload/album/session/member/user/family，并断言 family/user/album/media/share/session 均为 0。独立只读 DEV 核对 synthetic username/family-name 计数亦为 0。current-run temp root/media/log/cert 由既有 nonce ownership teardown 清理；本阶段 run-prefix 目录最终为 0，4000/4400/3443 无监听，test API/HTTPS launcher 无进程残留。未知历史目录保持 untouched。

0006 SHA 保持 `533b8f57d98dd10251d770326cd7df1d22481b087eb23c46edd7ec2a493017e4`，0007 absent，schema/migration/journal/snapshot unchanged。next-env.d.ts 与 HEAD 一致，两个本地 AGENTS.md/CLAUDE.md exception 保留未跟踪；Git index 为空，HEAD/origin/main 未变。

## Deferred / decision

独立 Phase 6E review 与 checkpoint 待用户后续请求。普通 attachment navigation 不提供 richer client error overlay；不重复声明 64 MiB streaming revalidation。Production、Phase 6F 及既有 deployment/rate-limit/durable audit/platform deferred 不在本次范围。

PHASE_6_COMPLETE: NO。PRODUCTION_READY: NO。READY_FOR_PHASE_06E_CHECKPOINT: NO。READY_FOR_PHASE_06F: NO。

PHASE_06E_IMPLEMENTATION_PASS: YES。READY_FOR_PHASE_06E_INDEPENDENT_REVIEW: YES。实施过程中未解决 finding：P0=0、P1=0、blocking P2=0、non-blocking P2=0、P3=0；这不是独立 review 结论。STAGE_PERFORMED: NO。COMMIT_PERFORMED: NO。PUSH_PERFORMED: NO。
