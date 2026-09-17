CREATE TABLE `album_members` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`album_id` bigint unsigned NOT NULL,
	`member_id` bigint unsigned NOT NULL,
	`can_view` boolean NOT NULL DEFAULT false,
	`can_upload` boolean NOT NULL DEFAULT false,
	`can_edit` boolean NOT NULL DEFAULT false,
	`can_delete` boolean NOT NULL DEFAULT false,
	`can_manage_members` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `album_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_album_members_album_member` UNIQUE(`album_id`,`member_id`),
	CONSTRAINT `chk_album_members_view_boolean` CHECK(`album_members`.`can_view` IN (0,1)),
	CONSTRAINT `chk_album_members_upload_boolean` CHECK(`album_members`.`can_upload` IN (0,1)),
	CONSTRAINT `chk_album_members_edit_boolean` CHECK(`album_members`.`can_edit` IN (0,1)),
	CONSTRAINT `chk_album_members_delete_boolean` CHECK(`album_members`.`can_delete` IN (0,1)),
	CONSTRAINT `chk_album_members_manage_members_boolean` CHECK(`album_members`.`can_manage_members` IN (0,1)),
	CONSTRAINT `chk_album_members_view_required` CHECK(`album_members`.`can_view` = 1 OR (`album_members`.`can_upload` = 0 AND `album_members`.`can_edit` = 0 AND `album_members`.`can_delete` = 0 AND `album_members`.`can_manage_members` = 0))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`owner_member_id` bigint unsigned NOT NULL,
	`name` varchar(128) NOT NULL,
	`description` varchar(2000),
	`visibility` enum('FAMILY','CUSTOM') NOT NULL DEFAULT 'CUSTOM',
	`revision` bigint unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`deleted_at` datetime(3),
	CONSTRAINT `albums_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_albums_family_id` UNIQUE(`family_id`,`id`),
	CONSTRAINT `chk_albums_revision` CHECK(`albums`.`revision` >= 1),
	CONSTRAINT `chk_albums_deleted_at` CHECK(`albums`.`deleted_at` IS NULL OR `albums`.`deleted_at` >= `albums`.`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `album_members` ADD CONSTRAINT `fk_album_members_album` FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `album_members` ADD CONSTRAINT `fk_album_members_member` FOREIGN KEY (`family_id`,`member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `albums` ADD CONSTRAINT `fk_albums_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `albums` ADD CONSTRAINT `fk_albums_owner_member` FOREIGN KEY (`family_id`,`owner_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_album_members_family_album` ON `album_members` (`family_id`,`album_id`);--> statement-breakpoint
CREATE INDEX `idx_album_members_family_member` ON `album_members` (`family_id`,`member_id`);--> statement-breakpoint
CREATE INDEX `idx_albums_family_deleted_id` ON `albums` (`family_id`,`deleted_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_albums_family_owner` ON `albums` (`family_id`,`owner_member_id`);
