# ROADMAP — 开发路线

目标：避免一次性 Vibe Coding 把系统做散。

每个 Phase 都要完成验收后再进入下一阶段。

---

## Phase 0 — Repository & Foundation

### 目标
建立可运行、可测试、可持续开发的基础。

### 内容
- pnpm monorepo
- apps/web
- apps/api
- apps/worker
- apps/mobile
- shared packages
- ESLint
- TypeScript
- Prettier
- test runner
- Playwright
- env schema
- structured logging
- health endpoint
- DEV / PROD config model
- 检查本机 MySQL 版本

### 数据库
创建：
- family_album_dev
- dev application user

不要创建/修改 PROD，直到 Phase 0 完成并用户同意。

### 验收
- `pnpm install`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
全部通过。

---

## Phase 1 — Identity, Family, Invitations

### 内容
- users
- families
- family_members
- invitations
- sessions
- username normalize
- Argon2id
- login/logout
- session revoke
- invite link
- QR payload
- role checks

### E2E
- 管理员生成邀请
- 新成员设置 username/password
- 重复 username 被拒绝
- 密码 <8 被拒绝
- 登录成功
- 错误密码失败
- 停用成员无法登录

---

## Phase 2 — Albums & Permission Engine

### 内容
- albums
- album_members
- permission service
- owner
- family-visible / custom
- view/upload/edit/delete/manage_members

### E2E
建立三名不同权限成员并验证全部拒绝/允许路径。

---

## Phase 3 — Storage & Resumable Upload

### 内容
- StorageProvider
- LocalFilesystemStorage
- staging
- tus upload
- SHA-256
- content-addressed originals
- dedupe
- upload events
- atomic finalization

### 必须先使用测试图片。

### E2E
- 断网/中断后继续
- 重复文件不产生第二份 original
- DB 失败不会报告上传成功
- 未授权成员不能上传目标相册

---

## Phase 4 — Media Processing

### 内容
- EXIF
- timestamps
- GPS
- image dimensions
- Sharp thumbnails
- previews
- ffprobe
- video poster
- background_jobs worker
- retry/dead job

### 验收
derived 全删后可重新生成。

---

## Phase 5 — Core Web UI

严格按 `ui/web-preview.png`。

### 内容
- 左侧导航
- 顶部搜索
- 家庭头像
- 往年今日卡片
- 相册快捷卡
- 时间线
- masonry/grid
- right summary
- photo viewer
- responsive web

### 验收
视觉上与参考图保持同一设计语言。

---

## Phase 6 — Album Features

### 内容
- add/remove media
- one media many albums
- favorites
- family featured
- tags
- notes
- comments
- original download
- preview download

---

## Phase 7 — Trash

### 内容
- soft delete
- trash view
- restore
- admin permanent delete
- purge_after
- worker purge
- audit log

### E2E
不得误删共享 storage object。

---

## Phase 8 — Search & Map

### 内容
- filters
- filename
- member
- album
- tag
- time
- location
- favorites
- MapLibre
- marker cluster
- country/city grouping

---

## Phase 9 — Memories

V1：
- 往年今日
- 一年前的这周

不要引入 AI。

---

## Phase 10 — Android App

严格按 `ui/app-preview.png`。

### 内容
- login
- 照片时间线
- albums
- memories
- my
- search
- photo viewer
- upload queue
- upload progress
- retry
- choose albums
- push registration
- deep links for invitation

### 交付
签名 APK。

---

## Phase 11 — Admin

### 内容
- member management
- storage usage
- media counts
- worker status
- backups
- integrity status
- trash
- audit
- maintenance mode
- read-only mode

---

## Phase 12 — Import & Export

### 内容
- web bulk import
- local directory import CLI
- directory → album option
- export selected
- album ZIP background job

---

## Phase 13 — Backup & Recovery

### 内容
- hourly DB backup
- retention
- media backup manifest
- daily media backup
- encrypted offsite package
- restore CLI
- restore verification

### 必须做恢复演练
在干净 DEV 环境完整恢复一次。

---

## Phase 14 — Storage Migration

### 内容
CLI storage migration：
- preflight
- maintenance
- copy
- hash verify
- count verify
- switch
- health
- rollback

先在测试目录做演练。

---

## Phase 15 — Integrity & Read-only

### 内容
- monthly hash scan
- missing detection
- corruption detection
- storage mount health
- automatic read-only
- admin push

---

## Phase 16 — Production Hardening

### 内容
- security review
- rate limits
- headers
- secure cookies
- session revocation
- file type validation
- upload size limits
- path traversal tests
- permission matrix tests
- backup test
- restore test
- deployment rollback test

调用 `codex-bridge-chatgpt` 做 release review。

---

## Phase 17 — Production Deployment

只有满足以下条件才允许导入真实家庭照片：

- Critical E2E 全绿
- 备份成功
- 恢复演练成功
- Storage migration 演练成功
- 权限 review 通过
- Upload consistency review 通过
- HTTPS 正常
- PROD 与 DEV 完全隔离
- 用户明确批准

---

# V1.1

- RAW 更好预览
- 管理后台 storage migration
- 高级地图
- 更丰富导出
- 备份管理 UI
- Motion/Live Photo 改善
- 更丰富回忆

# V2

- 人脸聚类
- 人物命名
- 本地 image embeddings
- 语义搜索
- 自然语言搜索
- AI tags
- 智能旅行
- 成长回忆
- 智能精选
