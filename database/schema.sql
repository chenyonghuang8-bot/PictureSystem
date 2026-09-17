-- Family Album V1 — MySQL 8.4 schema draft
-- This is an initial baseline for Codex to convert into Drizzle migrations.
-- Do not apply to production without review.

CREATE DATABASE IF NOT EXISTS family_album_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE family_album_dev;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  username_normalized VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NULL,
  disabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username_normalized (username_normalized)
) ENGINE=InnoDB;

CREATE TABLE families (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE family_members (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('SUPER_ADMIN','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_family_member (family_id, user_id),
  CONSTRAINT fk_family_members_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_family_members_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  created_by_member_id BIGINT UNSIGNED NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitation_token_hash (token_hash),
  CONSTRAINT fk_invitations_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_invitations_creator FOREIGN KEY (created_by_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash BINARY(32) NOT NULL,
  device_label VARCHAR(128) NULL,
  ip_last VARBINARY(16) NULL,
  user_agent VARCHAR(512) NULL,
  last_seen_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token_hash (token_hash),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  platform ENUM('ANDROID','IOS','WEB') NOT NULL,
  push_token VARCHAR(512) NULL,
  device_name VARCHAR(128) NULL,
  last_seen_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_devices_user (user_id),
  UNIQUE KEY uq_devices_push_token (push_token),
  CONSTRAINT fk_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE albums (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  owner_member_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  visibility ENUM('FAMILY','CUSTOM') NOT NULL DEFAULT 'FAMILY',
  cover_media_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_albums_family (family_id),
  CONSTRAINT fk_albums_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_albums_owner FOREIGN KEY (owner_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE album_members (
  album_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT TRUE,
  can_upload BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  can_manage_members BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (album_id, member_id),
  CONSTRAINT fk_album_members_album FOREIGN KEY (album_id) REFERENCES albums(id),
  CONSTRAINT fk_album_members_member FOREIGN KEY (member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE storage_objects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  sha256 BINARY(32) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  original_filename VARCHAR(512) NOT NULL,
  extension VARCHAR(32) NULL,
  mime_type VARCHAR(255) NOT NULL,
  health_status ENUM('OK','MISSING','CORRUPT','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_storage_object_content (family_id, sha256, byte_size),
  UNIQUE KEY uq_storage_key (storage_key),
  CONSTRAINT fk_storage_objects_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB;

CREATE TABLE media_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  storage_object_id BIGINT UNSIGNED NOT NULL,
  media_type ENUM('PHOTO','VIDEO','OTHER') NOT NULL,
  uploaded_by_member_id BIGINT UNSIGNED NOT NULL,
  captured_at DATETIME(3) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  duration_ms BIGINT UNSIGNED NULL,
  description TEXT NULL,
  deleted_at DATETIME(3) NULL,
  deleted_by_member_id BIGINT UNSIGNED NULL,
  purge_after DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_storage_object (family_id, storage_object_id),
  KEY idx_media_timeline (family_id, captured_at, uploaded_at),
  KEY idx_media_deleted (family_id, deleted_at),
  CONSTRAINT fk_media_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_media_storage FOREIGN KEY (storage_object_id) REFERENCES storage_objects(id),
  CONSTRAINT fk_media_uploader FOREIGN KEY (uploaded_by_member_id) REFERENCES family_members(id),
  CONSTRAINT fk_media_deleted_by FOREIGN KEY (deleted_by_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE media_metadata (
  media_id BIGINT UNSIGNED NOT NULL,
  camera_make VARCHAR(128) NULL,
  camera_model VARCHAR(128) NULL,
  lens_model VARCHAR(128) NULL,
  orientation SMALLINT NULL,
  raw_exif JSON NULL,
  PRIMARY KEY (media_id),
  CONSTRAINT fk_media_metadata_media FOREIGN KEY (media_id) REFERENCES media_items(id)
) ENGINE=InnoDB;

CREATE TABLE media_locations (
  media_id BIGINT UNSIGNED NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  altitude DECIMAL(10,2) NULL,
  country VARCHAR(128) NULL,
  region VARCHAR(128) NULL,
  city VARCHAR(128) NULL,
  place_name VARCHAR(255) NULL,
  PRIMARY KEY (media_id),
  KEY idx_media_locations_country_city (country, city),
  CONSTRAINT fk_media_locations_media FOREIGN KEY (media_id) REFERENCES media_items(id)
) ENGINE=InnoDB;

CREATE TABLE album_media (
  album_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  added_by_member_id BIGINT UNSIGNED NOT NULL,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (album_id, media_id),
  KEY idx_album_media_media (media_id),
  CONSTRAINT fk_album_media_album FOREIGN KEY (album_id) REFERENCES albums(id),
  CONSTRAINT fk_album_media_media FOREIGN KEY (media_id) REFERENCES media_items(id),
  CONSTRAINT fk_album_media_added_by FOREIGN KEY (added_by_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE user_favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, media_id),
  CONSTRAINT fk_user_favorites_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_user_favorites_media FOREIGN KEY (media_id) REFERENCES media_items(id)
) ENGINE=InnoDB;

CREATE TABLE family_featured (
  family_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NOT NULL,
  added_by_member_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (family_id, media_id),
  CONSTRAINT fk_featured_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_featured_media FOREIGN KEY (media_id) REFERENCES media_items(id),
  CONSTRAINT fk_featured_member FOREIGN KEY (added_by_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(128) NOT NULL,
  name_normalized VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tag_name (family_id, name_normalized),
  CONSTRAINT fk_tags_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB;

CREATE TABLE media_tags (
  media_id BIGINT UNSIGNED NOT NULL,
  tag_id BIGINT UNSIGNED NOT NULL,
  added_by_member_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (media_id, tag_id),
  CONSTRAINT fk_media_tags_media FOREIGN KEY (media_id) REFERENCES media_items(id),
  CONSTRAINT fk_media_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id),
  CONSTRAINT fk_media_tags_member FOREIGN KEY (added_by_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  media_id BIGINT UNSIGNED NOT NULL,
  author_member_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  deleted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_comments_media (media_id, created_at),
  CONSTRAINT fk_comments_media FOREIGN KEY (media_id) REFERENCES media_items(id),
  CONSTRAINT fk_comments_author FOREIGN KEY (author_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE upload_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  member_id BIGINT UNSIGNED NOT NULL,
  media_id BIGINT UNSIGNED NULL,
  client_upload_id VARCHAR(128) NOT NULL,
  original_filename VARCHAR(512) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  status ENUM('STARTED','UPLOADING','PROCESSING','COMPLETED','FAILED','DEDUPED') NOT NULL,
  error_code VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_upload_client_id (family_id, client_upload_id),
  KEY idx_upload_events_member (member_id, created_at),
  CONSTRAINT fk_upload_events_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_upload_events_member FOREIGN KEY (member_id) REFERENCES family_members(id),
  CONSTRAINT fk_upload_events_media FOREIGN KEY (media_id) REFERENCES media_items(id)
) ENGINE=InnoDB;

CREATE TABLE derived_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  media_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('THUMBNAIL','PREVIEW','VIDEO_POSTER','TRANSCODE') NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  byte_size BIGINT UNSIGNED NULL,
  width INT UNSIGNED NULL,
  height INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_derived_media_kind (media_id, kind),
  CONSTRAINT fk_derived_media FOREIGN KEY (media_id) REFERENCES media_items(id)
) ENGINE=InnoDB;

CREATE TABLE background_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue VARCHAR(64) NOT NULL DEFAULT 'default',
  job_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('READY','RUNNING','RETRY','SUCCEEDED','DEAD') NOT NULL DEFAULT 'READY',
  priority INT NOT NULL DEFAULT 0,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by VARCHAR(128) NULL,
  locked_until DATETIME(3) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_jobs_claim (status, queue, available_at, priority, id)
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NULL,
  actor_member_id BIGINT UNSIGNED NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(128) NULL,
  result ENUM('SUCCESS','FAILURE') NOT NULL,
  ip VARBINARY(16) NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_family_created (family_id, created_at),
  KEY idx_audit_actor_created (actor_member_id, created_at),
  CONSTRAINT fk_audit_family FOREIGN KEY (family_id) REFERENCES families(id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_member_id) REFERENCES family_members(id)
) ENGINE=InnoDB;

CREATE TABLE system_settings (
  family_id BIGINT UNSIGNED NOT NULL,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  storage_read_only BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (family_id),
  CONSTRAINT fk_system_settings_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB;

CREATE TABLE backups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  backup_type ENUM('DATABASE','MEDIA','FULL') NOT NULL,
  status ENUM('RUNNING','SUCCEEDED','FAILED') NOT NULL,
  path VARCHAR(1024) NULL,
  manifest_sha256 BINARY(32) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  error_message TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_backups_family_started (family_id, started_at),
  CONSTRAINT fk_backups_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB;

CREATE TABLE integrity_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  family_id BIGINT UNSIGNED NOT NULL,
  status ENUM('RUNNING','SUCCEEDED','FAILED') NOT NULL,
  checked_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  missing_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  corrupt_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_integrity_family_started (family_id, started_at),
  CONSTRAINT fk_integrity_family FOREIGN KEY (family_id) REFERENCES families(id)
) ENGINE=InnoDB;

CREATE TABLE integrity_issues (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id BIGINT UNSIGNED NOT NULL,
  storage_object_id BIGINT UNSIGNED NOT NULL,
  issue_type ENUM('MISSING','HASH_MISMATCH','READ_ERROR') NOT NULL,
  details TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_integrity_issues_run (run_id),
  CONSTRAINT fk_integrity_issues_run FOREIGN KEY (run_id) REFERENCES integrity_runs(id),
  CONSTRAINT fk_integrity_issues_storage FOREIGN KEY (storage_object_id) REFERENCES storage_objects(id)
) ENGINE=InnoDB;
