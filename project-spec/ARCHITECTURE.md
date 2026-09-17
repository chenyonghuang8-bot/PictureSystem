# ARCHITECTURE — 技术架构

## 1. 总体原则

这个系统规模很小：约 5 个用户、初期约 1 万张照片。

因此架构目标不是“云原生”，而是：
- 简单
- 稳定
- 可恢复
- 可维护
- 易于 Codex 理解
- 尽量少的基础服务

V1 明确不引入：
- Kubernetes
- Elasticsearch
- MinIO
- Redis（除非后续有明确必要）
- 微服务拆分

## 2. 推荐技术栈

### Monorepo
- pnpm workspace
- TypeScript

目录建议：

```text
family-album/
├─ apps/
│  ├─ mobile/
│  ├─ web/
│  ├─ api/
│  └─ worker/
├─ packages/
│  ├─ db/
│  ├─ auth/
│  ├─ contracts/
│  ├─ storage/
│  ├─ media/
│  ├─ permissions/
│  ├─ config/
│  ├─ ui-tokens/
│  └─ i18n/
├─ infra/
│  ├─ docker/
│  ├─ caddy/
│  ├─ backup/
│  └─ scripts/
├─ tests/
│  ├─ fixtures/
│  └─ e2e/
├─ docs/
└─ AGENTS.md
```

## 3. Web

- Next.js App Router
- TypeScript
- React
- Tailwind CSS
- UI tokens 与预览图保持一致

截至 2026-09，Next.js 16.3.3 是 Active LTS 安全版本。
初始化时可以使用 16.3.x，但必须锁定确切版本并提交 lockfile。

普通 Web 和管理后台共用一个应用。
管理员根据权限显示额外路由与导航。

## 4. Android App

- Expo SDK 57
- React Native
- Expo Router
- TypeScript

第一目标 Android。
通过本地/EAS 构建签名 APK 给家庭成员安装。

iPad 暂不作为 V1 原生交付目标。

## 5. API

- Node.js
- Fastify
- Zod
- REST `/api/v1/...`

原因：
- 移动端需要稳定 API
- 文件上传/下载独立于 Next.js 页面生命周期
- Fastify 轻量且适合 TypeScript
- 避免一开始 GraphQL 复杂度

## 6. 数据库

数据库：
- MySQL 9.7.2 LTS
- innodb_native_foreign_keys = ON；foreign_key_checks = 1（DB health/preflight 不满足时 fail closed）

用户已经在 Mac mini 安装 MySQL。

Phase 0 必须先执行：
```bash
mysql --version
```

如果版本兼容：
- 优先复用现有 MySQL
- 创建独立 `family_album_dev` / `family_album_prod`
- 创建独立数据库账号
- 不使用 root 作为应用账号

ORM：
- Drizzle ORM
- mysql2 driver
- Drizzle migrations

所有 schema 修改必须有 migration。

## 7. 数据库隔离建议

```text
family_album_dev
family_album_prod
```

账号示例：

```text
family_album_dev_user
family_album_prod_user
```

PROD 用户不得拥有全局管理权限。

## 8. 后台任务

由于数据库采用 MySQL，不使用 pg-boss。

V1 使用 MySQL 自身实现小型 durable job queue：
- `background_jobs` 表
- Worker 轮询
- transaction
- `SELECT ... FOR UPDATE SKIP LOCKED`
- lease / locked_until
- retries
- exponential backoff
- dead-letter 状态

MySQL 的 `SKIP LOCKED` 可用于避免多个会话访问 queue-like table 时的锁竞争。

这个项目任务量很小，因此比额外部署 Redis + BullMQ 更合适。

如果后续任务吞吐量显著增加，再迁移到 Redis/BullMQ。

## 9. Worker 任务类型

- EXTRACT_METADATA
- GENERATE_THUMBNAIL
- GENERATE_PREVIEW
- GENERATE_VIDEO_POSTER
- PURGE_TRASH
- BUILD_EXPORT
- IMPORT_DIRECTORY
- VERIFY_MEDIA
- BACKUP_DATABASE
- BACKUP_MEDIA_MANIFEST
- GENERATE_MEMORY
- SEND_PUSH

## 10. 上传

采用 tus resumable upload。

服务端：
- `@tus/server`
- `@tus/file-store` 或自定义 temporary store

客户端：
- Web 使用 tus-js-client / Uppy
- React Native 使用兼容 tus client 或封装原生上传队列

流程：

```text
客户端
  ↓
tus temporary upload
  ↓
上传完成
  ↓
计算 SHA-256
  ↓
验证 MIME / size
  ↓
检查家庭内重复
  ↓
atomic move 到 content-addressed original storage
  ↓
数据库 transaction
  ↓
enqueue metadata/thumbnail jobs
```

严禁边上传边直接写最终 original 路径。

## 11. 原始媒体存储

采用本地文件系统，不使用 MinIO。

抽象接口：

```ts
interface StorageProvider {
  putOriginal(...)
  openOriginal(...)
  exists(...)
  verify(...)
  move(...)
  deleteDerived(...)
}
```

实现：
- `LocalFilesystemStorage`

未来可扩展：
- NASStorage
- S3Storage

业务层不得直接拼磁盘绝对路径。

## 12. Content-addressed storage

示例：

```text
/data/originals/ab/cd/abcdef...original
/data/derived/ab/cd/<media-id>/thumb.webp
/data/derived/ab/cd/<media-id>/preview.webp
```

原始文件路径基于 content hash。

数据库保存真实扩展名、MIME、文件名、大小、hash。

## 13. 原子写入

必须：

1. 写入 staging
2. flush/close
3. 计算 hash
4. 检查目标是否存在
5. 在同一 filesystem 使用 atomic rename/move
6. 数据库 transaction 创建引用
7. enqueue derived jobs

数据库失败后允许产生 orphan storage object，但必须有 cleanup/reconciliation job。

绝不允许 DB 已标记“成功”但最终媒体文件尚未安全落盘。

## 14. 去重边界

只在同一 `family_id` 内去重。

不要做全局跨家庭 dedupe，因为未来可能产生隐私侧信道。

唯一键：
- `family_id`
- `sha256`
- `byte_size`

重复上传：
- 复用 media/storage object
- 记录 upload event
- 添加目标 album membership
- 不重复显示到 timeline

## 15. 身份认证

采用 opaque session，不用复杂 OAuth/JWT 体系。

登录成功：
- 生成随机 256-bit session token
- 客户端只拿原始 token
- DB 只存 SHA-256(token)
- Web 存 Secure + HttpOnly + SameSite cookie
- Android 存系统 secure storage
- API 支持 Cookie 或 Bearer session token

优势：
- 撤销简单
- 5 人规模查询成本可忽略
- 不需要 refresh token 旋转复杂度

Session 必须支持：
- revoke
- device label
- last_seen_at
- expires_at

## 16. 密码

- 最小 8 字符
- 最大建议 256 字符
- 不要求复杂度组合
- Argon2id
- 登录限速
- username + IP 双维度限速
- 错误信息不暴露账号是否存在

## 17. 用户名

允许用户自由选择，但：
- trim
- Unicode NFKC
- lowercase 归一化
- `username_normalized` 唯一
- 原始 `username` 用于展示

建议长度 1–64 字符，避免异常输入。

## 18. 权限

所有权限判断必须在 API 服务端执行。

客户端隐藏按钮不是安全措施。

Permission service 独立 package：
```text
packages/permissions
```

统一函数：
- canViewMedia
- canUploadToAlbum
- canEditAlbum
- canDeleteMedia
- canManageAlbumMembers
- canAdminSystem

## 19. 图片处理

- Sharp/libvips
- 默认输出 WebP preview/thumbnail
- 保留 EXIF 原始信息
- 不覆盖 original

## 20. 视频

- ffprobe 读取元数据
- FFmpeg 生成 poster
- V1 不强制转码所有视频
- 浏览器/Android 不兼容的格式可显示“下载原文件”或后续异步兼容转码

不要为了 V1 自动重编码所有 4K HDR 视频。

## 21. 地图

- MapLibre GL
- tile provider 可配置
- GPS 数据保存在自己的 DB
- 不向地图供应商上传照片

## 22. Push

- Android：FCM
- 服务端保存 device token
- 不把敏感媒体信息放入 Push payload

## 23. 外网入口

第一优先：
- 域名
- Caddy HTTPS
- 家庭网络公网 IPv4 或可用 IPv6

如果家庭网络是 CGNAT：
- 使用廉价 VPS gateway
- WireGuard：VPS ↔ Mac mini
- Caddy/反代入口在 VPS
- 家庭成员不安装 VPN

不把 Cloudflare Tunnel 作为 4K 视频等大量媒体的默认生产通道。

## 24. Docker

应用服务可使用 Docker Compose：
- web
- api
- worker
- caddy

MySQL 优先复用 Mac mini 已安装实例。

容器访问宿主 MySQL时，在 macOS 使用：
```text
host.docker.internal
```

如果现有 MySQL 环境难以隔离，则允许改用单独的 MySQL 9.7.2 Docker container，但必须先向用户说明原因。

## 25. DEV / PROD

示例：

```text
/Users/.../family-album-data/dev
/Volumes/FamilyAlbum/.../prod
```

严禁两个环境共享 originals。

## 26. Backup

数据库：
- `mysqldump` 或 MySQL Shell dump
- 每小时
- 加密/压缩后归档

媒体：
- 每日增量复制到独立备份盘
- manifest + SHA-256

iCloud：
- 只放加密后的灾备归档
- 不把工作目录直接同步进 iCloud Drive

## 27. Storage migration

V1 CLI：

```bash
pnpm family-album storage:migrate --target /Volumes/FamilyAlbum
```

流程：
- maintenance mode
- preflight
- copy
- hash verify
- count verify
- switch config
- health check
- rollback on failure

## 28. Read-only mode

如果 storage health check 失败：
- 全局 `storage_read_only = true`
- 拒绝上传
- 拒绝删除
- 拒绝会改变媒体文件的操作
- 允许登录/浏览 metadata
- Push 管理员

## 29. Testing

每个重要变更执行：
- lint
- typecheck
- unit tests
- integration tests
- build
- E2E

Web E2E：Playwright。

关键场景：
- invite
- signup
- login
- permission deny
- upload resume
- upload dedupe
- timeline
- album permission
- trash
- restore
- admin
- read-only behavior

## 30. AI

V1 不实现 AI。

但是设计上不要阻止后续添加：
- face embeddings
- media embeddings
- ai tags
- semantic search

未来 AI 默认在 Mac mini M4 本地执行。
