CREATE TABLE `album_media` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`album_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `album_media_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_album_media_placement` UNIQUE(`family_id`,`album_id`,`media_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `album_media` ADD CONSTRAINT `fk_album_media_album` FOREIGN KEY (`family_id`,`album_id`) REFERENCES `albums`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `album_media` ADD CONSTRAINT `fk_album_media_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_album_media_media` ON `album_media` (`family_id`,`media_id`,`album_id`);