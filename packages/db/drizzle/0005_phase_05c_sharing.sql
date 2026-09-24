CREATE TABLE `share_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`share_id` bigint unsigned NOT NULL,
	`event_type` enum('CREATE','ACCESS','REVOKE') NOT NULL,
	`actor_member_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `share_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_share_events_actor` CHECK((`share_events`.`event_type` IN ('CREATE','REVOKE') AND `share_events`.`actor_member_id` IS NOT NULL) OR (`share_events`.`event_type` = 'ACCESS' AND `share_events`.`actor_member_id` IS NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `shares` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`album_id` bigint unsigned NOT NULL,
	`token_hash` binary(32) NOT NULL,
	`created_by_member_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`revoked_by_member_id` bigint unsigned,
	CONSTRAINT `shares_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_shares_family_id` UNIQUE(`family_id`,`id`),
	CONSTRAINT `uq_shares_token_hash` UNIQUE(`token_hash`),
	CONSTRAINT `chk_shares_expiry` CHECK(`shares`.`expires_at` > `shares`.`created_at`),
	CONSTRAINT `chk_shares_revoke_pair` CHECK((`shares`.`revoked_at` IS NULL AND `shares`.`revoked_by_member_id` IS NULL) OR (`shares`.`revoked_at` IS NOT NULL AND `shares`.`revoked_by_member_id` IS NOT NULL)),
	CONSTRAINT `chk_shares_revoke_after_create` CHECK(`shares`.`revoked_at` IS NULL OR `shares`.`revoked_at` >= `shares`.`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `share_events` ADD CONSTRAINT `fk_share_events_share` FOREIGN KEY (`family_id`,`share_id`) REFERENCES `shares`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `share_events` ADD CONSTRAINT `fk_share_events_actor` FOREIGN KEY (`family_id`,`actor_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `shares` ADD CONSTRAINT `fk_shares_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `shares` ADD CONSTRAINT `fk_shares_album` FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `shares` ADD CONSTRAINT `fk_shares_creator` FOREIGN KEY (`family_id`,`created_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `shares` ADD CONSTRAINT `fk_shares_revoker` FOREIGN KEY (`family_id`,`revoked_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_share_events_share` ON `share_events` (`family_id`,`share_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shares_family_album_id` ON `shares` (`family_id`,`album_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_shares_expires` ON `shares` (`expires_at`,`id`);