CREATE TABLE `comments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`author_member_id` bigint unsigned NOT NULL,
	`body` varchar(2000) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_comments_body` CHECK(CHAR_LENGTH(`comments`.`body`) BETWEEN 1 AND 2000 AND OCTET_LENGTH(`comments`.`body`) <= 8000)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `family_featured` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`featured_by_member_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `family_featured_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_family_featured_identity` UNIQUE(`family_id`,`media_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `media_tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`tag_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_media_tags_identity` UNIQUE(`family_id`,`media_id`,`tag_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`name` varchar(64) NOT NULL,
	`name_normalized` varbinary(256) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tags_identity` UNIQUE(`family_id`,`name_normalized`),
	CONSTRAINT `uq_tags_family_id` UNIQUE(`family_id`,`id`),
	CONSTRAINT `chk_tags_name` CHECK(CHAR_LENGTH(`tags`.`name`) BETWEEN 1 AND 64 AND OCTET_LENGTH(`tags`.`name`) <= 256),
	CONSTRAINT `chk_tags_normalized` CHECK(OCTET_LENGTH(`tags`.`name_normalized`) BETWEEN 1 AND 256)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `user_favorites` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`member_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_favorites_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_user_favorites_identity` UNIQUE(`family_id`,`member_id`,`media_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `media_items` ADD `description` varchar(4000);--> statement-breakpoint
ALTER TABLE `media_items` ADD `note_revision` bigint unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `fk_comments_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `fk_comments_author` FOREIGN KEY (`family_id`,`author_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `family_featured` ADD CONSTRAINT `fk_family_featured_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `family_featured` ADD CONSTRAINT `fk_family_featured_actor` FOREIGN KEY (`family_id`,`featured_by_member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `media_tags` ADD CONSTRAINT `fk_media_tags_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `media_tags` ADD CONSTRAINT `fk_media_tags_tag` FOREIGN KEY (`family_id`,`tag_id`) REFERENCES `tags`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `fk_tags_family` FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `user_favorites` ADD CONSTRAINT `fk_user_favorites_member` FOREIGN KEY (`family_id`,`member_id`) REFERENCES `family_members`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `user_favorites` ADD CONSTRAINT `fk_user_favorites_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_comments_media_time` ON `comments` (`family_id`,`media_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_comments_author` ON `comments` (`family_id`,`author_member_id`);--> statement-breakpoint
CREATE INDEX `idx_family_featured_time` ON `family_featured` (`family_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_family_featured_actor` ON `family_featured` (`family_id`,`featured_by_member_id`);--> statement-breakpoint
CREATE INDEX `idx_media_tags_tag` ON `media_tags` (`family_id`,`tag_id`,`media_id`);--> statement-breakpoint
CREATE INDEX `idx_user_favorites_member_time` ON `user_favorites` (`family_id`,`member_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_user_favorites_media` ON `user_favorites` (`family_id`,`media_id`);--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `chk_media_items_description` CHECK (`media_items`.`description` IS NULL OR (CHAR_LENGTH(`media_items`.`description`) BETWEEN 1 AND 4000 AND OCTET_LENGTH(`media_items`.`description`) <= 16000));--> statement-breakpoint
ALTER TABLE `media_items` ADD CONSTRAINT `chk_media_items_note_revision` CHECK (`media_items`.`note_revision` >= 1);
