CREATE TABLE `families` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`name` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `families_id` PRIMARY KEY(`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `family_members` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`role` enum('SUPER_ADMIN','ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
	`joined_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`disabled_at` datetime(3),
	`left_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `family_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_family_members_family_user` UNIQUE(`family_id`,`user_id`),
	CONSTRAINT `uq_family_members_family_id` UNIQUE(`family_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`created_by_member_id` bigint unsigned NOT NULL,
	`role` enum('ADMIN','MEMBER') NOT NULL DEFAULT 'MEMBER',
	`token_hash` binary(32) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`used_at` datetime(3),
	`used_by_member_id` bigint unsigned,
	`revoked_at` datetime(3),
	`revoked_by_member_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_invitations_token_hash` UNIQUE(`token_hash`),
	CONSTRAINT `chk_invitations_expiry` CHECK(`invitations`.`expires_at` > `invitations`.`created_at`),
	CONSTRAINT `chk_invitations_used_pair` CHECK((`invitations`.`used_at` IS NULL AND `invitations`.`used_by_member_id` IS NULL) OR (`invitations`.`used_at` IS NOT NULL AND `invitations`.`used_by_member_id` IS NOT NULL)),
	CONSTRAINT `chk_invitations_used_or_revoked` CHECK(NOT (`invitations`.`used_at` IS NOT NULL AND `invitations`.`revoked_at` IS NOT NULL)),
	CONSTRAINT `chk_invitations_revoker_requires_revoked_at` CHECK(`invitations`.`revoked_by_member_id` IS NULL OR `invitations`.`revoked_at` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`token_hash` binary(32) NOT NULL,
	`client_type` enum('WEB','ANDROID') NOT NULL,
	`device_label` varchar(128),
	`authenticated_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_seen_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`revoke_reason` enum('LOGOUT','USER_REVOKE','LOGOUT_ALL','PASSWORD_CHANGE','USER_DISABLED'),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_sessions_token_hash` UNIQUE(`token_hash`),
	CONSTRAINT `chk_sessions_expiry` CHECK(`sessions`.`expires_at` > `sessions`.`created_at`),
	CONSTRAINT `chk_sessions_last_seen` CHECK(`sessions`.`last_seen_at` >= `sessions`.`created_at`),
	CONSTRAINT `chk_sessions_revoked_pair` CHECK((`sessions`.`revoked_at` IS NULL AND `sessions`.`revoke_reason` IS NULL) OR (`sessions`.`revoked_at` IS NOT NULL AND `sessions`.`revoke_reason` IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `users` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`username_normalized` varbinary(512) NOT NULL,
	`password_hash` varchar(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`display_name` varchar(128),
	`password_changed_at` datetime(3) NOT NULL,
	`disabled_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_users_username_normalized` UNIQUE(`username_normalized`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `family_members` ADD CONSTRAINT `family_members_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `family_members` ADD CONSTRAINT `family_members_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_family_id_families_id_fk` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `fk_invitations_creator_member` FOREIGN KEY (`family_id`,`created_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `fk_invitations_used_by_member` FOREIGN KEY (`family_id`,`used_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `fk_invitations_revoked_by_member` FOREIGN KEY (`family_id`,`revoked_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_family_members_user` ON `family_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_invitations_family_created` ON `invitations` (`family_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_invitations_expires` ON `invitations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_invitations_family_creator` ON `invitations` (`family_id`,`created_by_member_id`);--> statement-breakpoint
CREATE INDEX `idx_invitations_family_used_by` ON `invitations` (`family_id`,`used_by_member_id`);--> statement-breakpoint
CREATE INDEX `idx_invitations_family_revoked_by` ON `invitations` (`family_id`,`revoked_by_member_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user_revoked_created` ON `sessions` (`user_id`,`revoked_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);
