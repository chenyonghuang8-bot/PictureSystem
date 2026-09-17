CREATE TABLE `storage_objects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`sha256` binary(32) NOT NULL,
	`byte_size` bigint unsigned NOT NULL,
	`key_version` smallint unsigned NOT NULL DEFAULT 1,
	`state` enum('AVAILABLE','MISSING','CORRUPT') NOT NULL,
	`durable_at` datetime(3) NOT NULL,
	`verified_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `storage_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_storage_objects_family_id` UNIQUE(`family_id`,`id`),
	CONSTRAINT `uq_storage_objects_family_hash_size` UNIQUE(`family_id`,`sha256`,`byte_size`),
	CONSTRAINT `chk_storage_objects_size` CHECK(`storage_objects`.`byte_size` > 0),
	CONSTRAINT `chk_storage_objects_key_version` CHECK(`storage_objects`.`key_version` = 1),
	CONSTRAINT `chk_storage_objects_verified` CHECK(`storage_objects`.`verified_at` >= `storage_objects`.`durable_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` binary(16) NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`created_by_member_id` bigint unsigned NOT NULL,
	`original_filename` varchar(255) NOT NULL,
	`reported_mime` varchar(127),
	`declared_size` bigint unsigned NOT NULL,
	`committed_offset` bigint unsigned NOT NULL DEFAULT 0,
	`state` enum('CREATED','UPLOADING','FINALIZING','COMPLETE','FAILED','ABORTED','EXPIRED') NOT NULL DEFAULT 'CREATED',
	`computed_sha256` binary(32),
	`finalize_started_at` datetime(3),
	`storage_object_id` bigint unsigned,
	`completed_at` datetime(3),
	`terminal_at` datetime(3),
	`failure_code` varchar(48),
	`expires_at` datetime(3) NOT NULL,
	`staging_cleaned_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `upload_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_upload_sessions_public_id` UNIQUE(`public_id`),
	CONSTRAINT `chk_upload_sessions_size_offset` CHECK(`upload_sessions`.`declared_size` > 0 AND `upload_sessions`.`committed_offset` <= `upload_sessions`.`declared_size`),
	CONSTRAINT `chk_upload_sessions_expiry` CHECK(`upload_sessions`.`expires_at` > `upload_sessions`.`created_at`),
	CONSTRAINT `chk_upload_sessions_created` CHECK(`upload_sessions`.`state` <> 'CREATED' OR `upload_sessions`.`committed_offset` = 0),
	CONSTRAINT `chk_upload_sessions_uploading` CHECK(`upload_sessions`.`state` <> 'UPLOADING' OR `upload_sessions`.`committed_offset` > 0),
	CONSTRAINT `chk_upload_sessions_finalize_pair` CHECK((`upload_sessions`.`computed_sha256` IS NULL AND `upload_sessions`.`finalize_started_at` IS NULL) OR (`upload_sessions`.`computed_sha256` IS NOT NULL AND `upload_sessions`.`finalize_started_at` IS NOT NULL)),
	CONSTRAINT `chk_upload_sessions_finalize_state` CHECK((`upload_sessions`.`state` IN ('FINALIZING','COMPLETE') AND `upload_sessions`.`computed_sha256` IS NOT NULL AND `upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`committed_offset` = `upload_sessions`.`declared_size`) OR (`upload_sessions`.`state` IN ('CREATED','UPLOADING','ABORTED','EXPIRED') AND `upload_sessions`.`computed_sha256` IS NULL AND `upload_sessions`.`finalize_started_at` IS NULL) OR (`upload_sessions`.`state` = 'FAILED' AND ((`upload_sessions`.`computed_sha256` IS NULL AND `upload_sessions`.`finalize_started_at` IS NULL) OR (`upload_sessions`.`computed_sha256` IS NOT NULL AND `upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`committed_offset` = `upload_sessions`.`declared_size`)))),
	CONSTRAINT `chk_upload_sessions_complete` CHECK((`upload_sessions`.`state` = 'COMPLETE' AND `upload_sessions`.`storage_object_id` IS NOT NULL AND `upload_sessions`.`completed_at` IS NOT NULL AND `upload_sessions`.`terminal_at` IS NULL) OR (`upload_sessions`.`state` <> 'COMPLETE' AND `upload_sessions`.`storage_object_id` IS NULL AND `upload_sessions`.`completed_at` IS NULL)),
	CONSTRAINT `chk_upload_sessions_terminal` CHECK((`upload_sessions`.`state` IN ('FAILED','ABORTED','EXPIRED') AND `upload_sessions`.`terminal_at` IS NOT NULL) OR (`upload_sessions`.`state` NOT IN ('FAILED','ABORTED','EXPIRED') AND `upload_sessions`.`terminal_at` IS NULL)),
	CONSTRAINT `chk_upload_sessions_failure` CHECK((`upload_sessions`.`state` = 'FAILED' AND `upload_sessions`.`failure_code` IS NOT NULL) OR (`upload_sessions`.`state` <> 'FAILED' AND `upload_sessions`.`failure_code` IS NULL)),
	CONSTRAINT `chk_upload_sessions_times` CHECK((`upload_sessions`.`finalize_started_at` IS NULL OR `upload_sessions`.`finalize_started_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`completed_at` IS NULL OR `upload_sessions`.`completed_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`terminal_at` IS NULL OR `upload_sessions`.`terminal_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`staging_cleaned_at` IS NULL OR `upload_sessions`.`staging_cleaned_at` >= `upload_sessions`.`created_at`) AND (`upload_sessions`.`completed_at` IS NULL OR (`upload_sessions`.`finalize_started_at` IS NOT NULL AND `upload_sessions`.`completed_at` >= `upload_sessions`.`finalize_started_at`)) AND (`upload_sessions`.`staging_cleaned_at` IS NULL OR `upload_sessions`.`state` IN ('COMPLETE','FAILED','ABORTED','EXPIRED')))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `storage_objects` ADD CONSTRAINT `fk_storage_objects_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `fk_upload_sessions_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `fk_upload_sessions_creator_member` FOREIGN KEY (`family_id`,`created_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `fk_upload_sessions_storage_object` FOREIGN KEY (`family_id`,`storage_object_id`) REFERENCES `storage_objects`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_storage_objects_state_verified` ON `storage_objects` (`state`,`verified_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_family_creator_state` ON `upload_sessions` (`family_id`,`created_by_member_id`,`state`,`id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_state_expiry` ON `upload_sessions` (`state`,`expires_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_family_object` ON `upload_sessions` (`family_id`,`storage_object_id`);--> statement-breakpoint
CREATE INDEX `idx_upload_sessions_cleanup` ON `upload_sessions` (`state`,`staging_cleaned_at`,`id`);
