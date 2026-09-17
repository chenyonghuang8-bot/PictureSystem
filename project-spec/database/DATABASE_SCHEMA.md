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
