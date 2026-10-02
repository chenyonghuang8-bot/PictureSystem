CREATE TABLE `audit_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`operation_id` varchar(36) NOT NULL,
	`purge_intent_id` bigint unsigned,
	`media_id` bigint unsigned NOT NULL,
	`storage_object_id` bigint unsigned NOT NULL,
	`actor_kind` enum('MEMBER','SYSTEM') NOT NULL,
	`actor_member_id` bigint unsigned,
	`action` enum('TRASH','RESTORE','PERMANENT_DELETE_REQUEST','PURGE_STARTED','PURGE_COMPLETED','PURGE_FAILED') NOT NULL,
	`lifecycle_revision` bigint unsigned NOT NULL,
	`transition_id` varchar(36) NOT NULL,
	`result_category` enum('SUCCESS','REFERENCE_CONFLICT','FILESYSTEM_UNCERTAIN','CAPACITY_UNAVAILABLE','TRANSIENT_DB','INVARIANT_VIOLATION') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_audit_logs_transition` UNIQUE(`family_id`,`operation_id`,`action`,`transition_id`),
	CONSTRAINT `chk_audit_logs_actor` CHECK((`audit_logs`.`actor_kind` = 'MEMBER' AND `audit_logs`.`actor_member_id` IS NOT NULL) OR (`audit_logs`.`actor_kind` = 'SYSTEM' AND `audit_logs`.`actor_member_id` IS NULL)),
	CONSTRAINT `chk_audit_logs_revision` CHECK(`audit_logs`.`lifecycle_revision` >= 1)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `purge_files` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`purge_intent_id` bigint unsigned NOT NULL,
	`file_kind` enum('ORIGINAL','DERIVED') NOT NULL,
	`original_singleton_slot` tinyint unsigned,
	`identity_key` binary(32) NOT NULL,
	`storage_object_id` bigint unsigned,
	`media_id` bigint unsigned,
	`content_sha256` binary(32),
	`byte_size` bigint unsigned NOT NULL,
	`root_marker_id` varchar(32) NOT NULL,
	`root_device` bigint unsigned NOT NULL,
	`quarantine_slot` binary(16),
	`quarantine_device` bigint unsigned,
	`quarantine_inode` bigint unsigned,
	`generation` bigint unsigned,
	`recipe_id` smallint unsigned,
	`derived_kind` enum('THUMBNAIL','PREVIEW','VIDEO_POSTER'),
	`producer_job_id` bigint unsigned,
	`producer_epoch` bigint unsigned,
	`stage` enum('CATALOGUED','QUARANTINED','UNLINK_ARMED','REMOVED','ABSENT_DERIVED') NOT NULL DEFAULT 'CATALOGUED',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purge_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_purge_files_identity` UNIQUE(`family_id`,`purge_intent_id`,`identity_key`),
	CONSTRAINT `uq_purge_files_original_singleton` UNIQUE(`family_id`,`purge_intent_id`,`original_singleton_slot`),
	CONSTRAINT `chk_purge_files_original_singleton` CHECK((`purge_files`.`file_kind` = 'ORIGINAL' AND `purge_files`.`original_singleton_slot` IS NOT NULL AND `purge_files`.`original_singleton_slot` = 1) OR (`purge_files`.`file_kind` = 'DERIVED' AND `purge_files`.`original_singleton_slot` IS NULL)),
	CONSTRAINT `chk_purge_files_size` CHECK(`purge_files`.`byte_size` > 0),
	CONSTRAINT `chk_purge_files_kind` CHECK((`purge_files`.`file_kind` = 'ORIGINAL' AND `purge_files`.`storage_object_id` IS NOT NULL AND `purge_files`.`content_sha256` IS NOT NULL AND `purge_files`.`generation` IS NULL AND `purge_files`.`recipe_id` IS NULL AND `purge_files`.`derived_kind` IS NULL AND `purge_files`.`producer_job_id` IS NULL AND `purge_files`.`producer_epoch` IS NULL AND `purge_files`.`stage` <> 'ABSENT_DERIVED') OR (`purge_files`.`file_kind` = 'DERIVED' AND `purge_files`.`media_id` IS NOT NULL AND `purge_files`.`generation` IS NOT NULL AND `purge_files`.`recipe_id` IS NOT NULL AND `purge_files`.`derived_kind` IS NOT NULL AND `purge_files`.`producer_job_id` IS NOT NULL AND `purge_files`.`producer_epoch` IS NOT NULL AND `purge_files`.`content_sha256` IS NOT NULL AND `purge_files`.`storage_object_id` IS NULL)),
	CONSTRAINT `chk_purge_files_quarantine` CHECK((`purge_files`.`stage` IN ('CATALOGUED','ABSENT_DERIVED') AND `purge_files`.`quarantine_slot` IS NULL AND `purge_files`.`quarantine_device` IS NULL AND `purge_files`.`quarantine_inode` IS NULL) OR (`purge_files`.`stage` IN ('QUARANTINED','UNLINK_ARMED','REMOVED') AND `purge_files`.`quarantine_slot` IS NOT NULL AND `purge_files`.`quarantine_device` IS NOT NULL AND `purge_files`.`quarantine_inode` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `purge_intents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`operation_id` varchar(36) NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`storage_object_id` bigint unsigned NOT NULL,
	`source_upload_id` bigint unsigned NOT NULL,
	`lifecycle_revision` bigint unsigned NOT NULL,
	`trashed_at` datetime(3) NOT NULL,
	`purge_after` datetime(3) NOT NULL,
	`requested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`request_source` enum('MANUAL','SCHEDULED') NOT NULL,
	`actor_member_id` bigint unsigned,
	`progress` enum('REQUESTED','DETACHED','FILES_REMOVED','COMPLETED') NOT NULL DEFAULT 'REQUESTED',
	`execution_state` enum('QUEUED','RUNNING','RETRY_WAIT','BLOCKED','DONE') NOT NULL DEFAULT 'QUEUED',
	`worker_id` binary(16),
	`lease_epoch` bigint unsigned NOT NULL DEFAULT 0,
	`locked_at` datetime(3),
	`heartbeat_at` datetime(3),
	`locked_until` datetime(3),
	`available_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 8,
	`failure_category` enum('REFERENCE_CONFLICT','FILESYSTEM_UNCERTAIN','CAPACITY_UNAVAILABLE','TRANSIENT_DB','INVARIANT_VIOLATION'),
	`completed_at` datetime(3),
	`original_bytes` bigint unsigned NOT NULL,
	`derived_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`released_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purge_intents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_purge_intents_family_id` UNIQUE(`family_id`,`id`),
	CONSTRAINT `uq_purge_intents_operation` UNIQUE(`family_id`,`operation_id`),
	CONSTRAINT `uq_purge_intents_lifecycle` UNIQUE(`family_id`,`media_id`,`lifecycle_revision`),
	CONSTRAINT `chk_purge_intents_revision` CHECK(`purge_intents`.`lifecycle_revision` >= 1),
	CONSTRAINT `chk_purge_intents_retention` CHECK((`purge_intents`.`trashed_at` + INTERVAL 30 DAY) IS NOT NULL AND `purge_intents`.`purge_after` = `purge_intents`.`trashed_at` + INTERVAL 30 DAY),
	CONSTRAINT `chk_purge_intents_lease` CHECK((`purge_intents`.`execution_state` = 'RUNNING' AND `purge_intents`.`worker_id` IS NOT NULL AND `purge_intents`.`locked_at` IS NOT NULL AND `purge_intents`.`heartbeat_at` IS NOT NULL AND `purge_intents`.`locked_until` IS NOT NULL AND `purge_intents`.`lease_epoch` >= 1) OR (`purge_intents`.`execution_state` <> 'RUNNING' AND `purge_intents`.`worker_id` IS NULL AND `purge_intents`.`locked_at` IS NULL AND `purge_intents`.`heartbeat_at` IS NULL AND `purge_intents`.`locked_until` IS NULL)),
	CONSTRAINT `chk_purge_intents_progress` CHECK((`purge_intents`.`progress` = 'COMPLETED' AND `purge_intents`.`execution_state` = 'DONE' AND `purge_intents`.`completed_at` IS NOT NULL) OR (`purge_intents`.`progress` <> 'COMPLETED' AND `purge_intents`.`execution_state` <> 'DONE' AND `purge_intents`.`completed_at` IS NULL)),
	CONSTRAINT `chk_purge_intents_attempts` CHECK(`purge_intents`.`max_attempts` >= 1 AND `purge_intents`.`attempts` <= `purge_intents`.`max_attempts`),
	CONSTRAINT `chk_purge_intents_bytes` CHECK(`purge_intents`.`original_bytes` > 0 AND `purge_intents`.`released_bytes` <= `purge_intents`.`original_bytes` + `purge_intents`.`derived_bytes`),
	CONSTRAINT `chk_purge_intents_times` CHECK(`purge_intents`.`requested_at` >= `purge_intents`.`trashed_at` AND `purge_intents`.`available_at` >= `purge_intents`.`requested_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `upload_sessions` DROP CONSTRAINT `chk_upload_sessions_finalize_state`;--> statement-breakpoint
ALTER TABLE `upload_sessions` DROP CONSTRAINT `chk_upload_sessions_complete`;--> statement-breakpoint
ALTER TABLE `upload_sessions` DROP CONSTRAINT `chk_upload_sessions_times`;--> statement-breakpoint
ALTER TABLE `storage_objects` MODIFY COLUMN `state` enum('AVAILABLE','MISSING','CORRUPT','PURGING') NOT NULL;--> statement-breakpoint
ALTER TABLE `upload_sessions` MODIFY COLUMN `state` enum('CREATED','UPLOADING','FINALIZING','COMPLETE','RETIRED','FAILED','ABORTED','EXPIRED') NOT NULL DEFAULT 'CREATED';--> statement-breakpoint
ALTER TABLE `media_items` ADD `lifecycle_revision` bigint unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_items` ADD `trashed_at` datetime(3);--> statement-breakpoint
ALTER TABLE `media_items` ADD `trashed_by_member_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `media_items` ADD `purge_after` datetime(3);--> statement-breakpoint
ALTER TABLE `media_items` ADD `purge_intent_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `retired_storage_object_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `retired_purge_id` bigint unsigned;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `retired_at` datetime(3);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `fk_audit_logs_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `fk_audit_logs_purge` FOREIGN KEY (`family_id`,`purge_intent_id`) REFERENCES `purge_intents`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `fk_audit_logs_actor` FOREIGN KEY (`family_id`,`actor_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `purge_files` ADD CONSTRAINT `fk_purge_files_intent` FOREIGN KEY (`family_id`,`purge_intent_id`) REFERENCES `purge_intents`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `purge_intents` ADD CONSTRAINT `fk_purge_intents_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `purge_intents` ADD CONSTRAINT `fk_purge_intents_actor` FOREIGN KEY (`family_id`,`actor_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_audit_logs_media_time` ON `audit_logs` (`family_id`,`media_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_purge_files_progress` ON `purge_files` (`family_id`,`purge_intent_id`,`stage`,`id`);--> statement-breakpoint
CREATE INDEX `idx_purge_intents_claim` ON `purge_intents` (`execution_state`,`available_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_purge_intents_lease` ON `purge_intents` (`execution_state`,`locked_until`,`id`);--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `chk_media_items_lifecycle_revision` CHECK (`media_items`.`lifecycle_revision` >= 1);--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `chk_media_items_trash_state` CHECK ((`media_items`.`trashed_at` IS NULL AND `media_items`.`trashed_by_member_id` IS NULL AND `media_items`.`purge_after` IS NULL AND `media_items`.`purge_intent_id` IS NULL) OR (`media_items`.`trashed_at` IS NOT NULL AND `media_items`.`trashed_by_member_id` IS NOT NULL AND `media_items`.`purge_after` IS NOT NULL AND (`media_items`.`trashed_at` + INTERVAL 30 DAY) IS NOT NULL AND `media_items`.`purge_after` = `media_items`.`trashed_at` + INTERVAL 30 DAY));--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `chk_upload_sessions_finalize_state` CHECK ((`upload_sessions`.`state` IN ('FINALIZING','COMPLETE','RETIRED') AND `upload_sessions`.`computed_sha256` IS NOT NULL AND `upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`committed_offset` = `upload_sessions`.`declared_size`) OR (`upload_sessions`.`state` IN ('CREATED','UPLOADING','ABORTED','EXPIRED') AND `upload_sessions`.`computed_sha256` IS NULL AND `upload_sessions`.`finalize_started_at` IS NULL) OR (`upload_sessions`.`state` = 'FAILED' AND ((`upload_sessions`.`computed_sha256` IS NULL AND `upload_sessions`.`finalize_started_at` IS NULL) OR (`upload_sessions`.`computed_sha256` IS NOT NULL AND `upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`committed_offset` = `upload_sessions`.`declared_size`))));--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `chk_upload_sessions_complete` CHECK ((`upload_sessions`.`state` = 'COMPLETE' AND `upload_sessions`.`storage_object_id` IS NOT NULL AND `upload_sessions`.`completed_at` IS NOT NULL AND `upload_sessions`.`terminal_at` IS NULL AND `upload_sessions`.`retired_storage_object_id` IS NULL AND `upload_sessions`.`retired_purge_id` IS NULL AND `upload_sessions`.`retired_at` IS NULL) OR (`upload_sessions`.`state` = 'RETIRED' AND `upload_sessions`.`storage_object_id` IS NULL AND `upload_sessions`.`completed_at` IS NOT NULL AND `upload_sessions`.`terminal_at` IS NULL AND `upload_sessions`.`retired_storage_object_id` IS NOT NULL AND `upload_sessions`.`retired_purge_id` IS NOT NULL AND `upload_sessions`.`retired_at` IS NOT NULL) OR (`upload_sessions`.`state` NOT IN ('COMPLETE','RETIRED') AND `upload_sessions`.`storage_object_id` IS NULL AND `upload_sessions`.`completed_at` IS NULL AND `upload_sessions`.`retired_storage_object_id` IS NULL AND `upload_sessions`.`retired_purge_id` IS NULL AND `upload_sessions`.`retired_at` IS NULL));--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `chk_upload_sessions_times` CHECK ((`upload_sessions`.`finalize_started_at` IS NULL OR `upload_sessions`.`finalize_started_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`completed_at` IS NULL OR `upload_sessions`.`completed_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`terminal_at` IS NULL OR `upload_sessions`.`terminal_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`staging_cleaned_at` IS NULL OR `upload_sessions`.`staging_cleaned_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`completed_at` IS NULL OR (`upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`completed_at` >= `upload_sessions`.`finalize_started_at`)) AND (`upload_sessions`.`retired_at` IS NULL OR (`upload_sessions`.`completed_at` IS NOT NULL AND `upload_sessions`.`retired_at` >= `upload_sessions`.`completed_at`)) AND (`upload_sessions`.`staging_cleaned_at` IS NULL OR `upload_sessions`.`state` IN ('COMPLETE','RETIRED','FAILED','ABORTED','EXPIRED')));--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `fk_media_items_trashed_by` FOREIGN KEY (`family_id`,`trashed_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `fk_media_items_purge_intent` FOREIGN KEY (`family_id`,`purge_intent_id`) REFERENCES `purge_intents`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `fk_upload_sessions_retired_purge` FOREIGN KEY (`family_id`,`retired_purge_id`) REFERENCES `purge_intents`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_media_items_trash_family` ON `media_items` (`family_id`,`trashed_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_media_items_purge_after` ON `media_items` (`purge_after`,`id`);