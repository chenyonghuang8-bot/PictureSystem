# DATABASE_SCHEMA — MySQL 初版模型

这是逻辑模型，不代表所有字段在第一天都必须实现。

## users
全局账号。

关键字段：
- id
- username
- username_normalized UNIQUE
- password_hash
- display_name
- avatar_media_id nullable
- disabled_at

## families
虽然当前只有一个家庭，但保留 family 边界可以避免未来重构。

## family_members
用户与家庭关系。
- role: SUPER_ADMIN / ADMIN / MEMBER

## invitations
一次性邀请。
数据库只存 token hash，不存原始 token。

## sessions
opaque session。
数据库只存 session token hash。

## devices
Android push token 与设备信息。

## albums
相册。
- visibility FAMILY / CUSTOM
- owner_member_id

## album_members
细粒度权限：
- can_view
- can_upload
- can_edit
- can_delete
- can_manage_members

## storage_objects
物理原始文件。

同一 family 内：
`family_id + sha256 + byte_size` 唯一。

字段：
- storage_key
- original_filename
- mime_type
- extension
- byte_size
- sha256
- health_status

## media_items
用户看到的一条媒体记录。

一个 `media_item` 引用一个 `storage_object`。

包含：
- media_type PHOTO / VIDEO / OTHER
- captured_at
- uploaded_at
- uploaded_by_member_id
- width / height
- duration_ms
- description
- favorite candidate metadata
- trash fields

## media_metadata
扩展 EXIF。
建议将常用字段规范化，额外字段 JSON 保存。

## media_locations
- lat
- lng
- altitude
- country
- region
- city
- place_name

## album_media
多对多。

## user_favorites
个人收藏。

## family_featured
家庭精选。

## tags
family scope tag。

## media_tags
多对多。

## comments
媒体评论。

## upload_events
谁何时上传什么。
重复内容也可以记录 upload event。

## derived_assets
- THUMBNAIL
- PREVIEW
- VIDEO_POSTER
- FUTURE_TRANSCODE

可删除重建。

## background_jobs
MySQL-backed queue。

## media_location_projections (Phase 8 / migration 0008)

地点投影独立于 original，保存 `family_id`、`media_id`、`generation`、固定 `policy_version`、64位 SHA-256 `dataset_version`、唯一 H3 resolution 6 `h3_cell`、可空 `country_code` / `city_geoname_id`。不保存 GPS、EXIF、路径或可漂移的中心坐标；标签和中心由当前本地数据包及 cell 派生。

单列 unsigned BIGINT 自增 `id` 主键；唯一约束 `(family_id, media_id, policy_version, dataset_version)`；复合外键 `(family_id, media_id)` 指向 media_items，UPDATE/DELETE RESTRICT；cell 查询索引 `(family_id, policy_version, dataset_version, h3_cell, media_id)`。generation/policy >=1，dataset/cell/country SQL 形状 CHECK，city 非空要求 country 非空且 id>0；合法 H3/res6 由应用层进一步校验。

查询只使用固定当前版本，且要求投影 generation 和 metadata_generation 均等于媒体当前 generation，GPS pair 有效，并在聚合前执行既有相册 ACL 和 active 筛选。metadata 快照替换与投影清除/插入同事务；DB-only 回填使用 family → storage → media → projection 锁序及精确 CAS；purge 在删除 media_items 前清除投影子行。0000–0007 不变，工程 schema/migration 为权威；当前数据版本及操作说明见 `docs/progress/PHASE-08-LOCATION-DATA-OPERATIONS.md`。

## audit_logs
重要操作审计。

## system_settings
维护模式、read-only 等设置。

## backups
备份状态和 manifest。

## integrity_runs / integrity_issues
完整性检查。

## memories
缓存生成的“往年今日”等回忆集合。

## 重要规则

### 去重
只在 family 内进行。

### 删除
media_items 先 soft-delete。
只有 purge 后才减少 storage object 引用。
storage object reference = 0 才允许删除 physical original。

### 原始文件
不可修改。

### derived
可以重建。

### token
invitation/session 只存 hash。
