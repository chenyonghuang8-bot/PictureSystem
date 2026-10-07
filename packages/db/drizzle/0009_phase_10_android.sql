CREATE TABLE `upload_album_targets` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`upload_session_id` bigint unsigned NOT NULL,
	`album_id` bigint unsigned NOT NULL,
	`state` enum('PENDING','APPLIED') NOT NULL DEFAULT 'PENDING',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`applied_at` datetime(3),
	CONSTRAINT `upload_album_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_upload_album_targets_identity` UNIQUE(`family_id`,`upload_session_id`,`album_id`),
	CONSTRAINT `chk_upload_album_targets_applied` CHECK((`upload_album_targets`.`state` = 'APPLIED' AND `upload_album_targets`.`applied_at` IS NOT NULL) OR (`upload_album_targets`.`state` = 'PENDING' AND `upload_album_targets`.`applied_at` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `client_operation_id` binary(16);--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD `client_operation_fingerprint` binary(32);--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `uq_upload_sessions_operation` UNIQUE(`family_id`,`created_by_member_id`,`client_operation_id`);--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `uq_upload_sessions_family_id` UNIQUE(`family_id`,`id`);--> statement-breakpoint
ALTER TABLE `upload_album_targets` ADD CONSTRAINT `fk_upload_album_targets_receipt` FOREIGN KEY (`family_id`,`upload_session_id`) REFERENCES `upload_sessions`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_album_targets` ADD CONSTRAINT `fk_upload_album_targets_album` FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `upload_sessions` ADD CONSTRAINT `chk_upload_sessions_operation_pair` CHECK ((`upload_sessions`.`client_operation_id` IS NULL AND `upload_sessions`.`client_operation_fingerprint` IS NULL) OR (`upload_sessions`.`client_operation_id` IS NOT NULL AND `upload_sessions`.`client_operation_fingerprint` IS NOT NULL));