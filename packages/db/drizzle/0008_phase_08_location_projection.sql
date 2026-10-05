CREATE TABLE `media_location_projections` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`media_id` bigint unsigned NOT NULL,
	`generation` bigint unsigned NOT NULL,
	`policy_version` int unsigned NOT NULL,
	`dataset_version` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`h3_cell` varchar(15) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
	`country_code` varchar(2) CHARACTER SET ascii COLLATE ascii_bin,
	`city_geoname_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `media_location_projections_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_location_media_version` UNIQUE(`family_id`,`media_id`,`policy_version`,`dataset_version`),
	CONSTRAINT `chk_location_generation` CHECK(`media_location_projections`.`generation` >= 1),
	CONSTRAINT `chk_location_policy` CHECK(`media_location_projections`.`policy_version` >= 1),
	CONSTRAINT `chk_location_dataset` CHECK(`media_location_projections`.`dataset_version` REGEXP '^[0-9a-f]{64}$'),
	CONSTRAINT `chk_location_cell` CHECK(`media_location_projections`.`h3_cell` REGEXP '^[0-9a-f]{15}$'),
	CONSTRAINT `chk_location_country` CHECK(`media_location_projections`.`country_code` IS NULL OR `media_location_projections`.`country_code` REGEXP '^[A-Z]{2}$'),
	CONSTRAINT `chk_location_city` CHECK(`media_location_projections`.`city_geoname_id` IS NULL OR (`media_location_projections`.`country_code` IS NOT NULL AND `media_location_projections`.`city_geoname_id` > 0))
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `media_location_projections` ADD CONSTRAINT `fk_location_media` FOREIGN KEY (`family_id`,`media_id`) REFERENCES `media_items`(`family_id`,`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_location_cell` ON `media_location_projections` (`family_id`,`policy_version`,`dataset_version`,`h3_cell`,`media_id`);