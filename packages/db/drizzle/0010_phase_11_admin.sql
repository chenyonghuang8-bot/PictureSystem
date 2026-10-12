CREATE TABLE `admin_audit_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`scope` enum('SYSTEM','FAMILY') NOT NULL,
	`family_id` bigint unsigned,
	`actor_kind` enum('SYSTEM','MEMBER') NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_member_id` bigint unsigned,
	`actor_role` enum('SUPER_ADMIN','ADMIN','MEMBER'),
	`action` enum('MEMBER_DISABLED','MEMBER_RESTORED','MEMBER_ROLE_CHANGED','INVITATION_CREATED','INVITATION_REVOKED','INVITATION_CONSUMED','GRANT_PROVISIONED','GRANT_REVOKED','CONTROL_REQUESTED','CONTROL_APPLIED','RECOVERY_REJECTED','HEALTH_LATCHED','OUTCOME_OBSERVED','BOOTSTRAP_APPLIED') NOT NULL,
	`target_type` enum('MEMBER','INVITATION','GRANT','CONTROL') NOT NULL,
	`target_id` bigint unsigned,
	`operation_id` varchar(36) NOT NULL,
	`transition_token` varchar(36) NOT NULL,
	`result_category` enum('SUCCESS','REJECTED','RECOVERY_REQUIRED','COMMIT_UNKNOWN','UNAVAILABLE') NOT NULL,
	`revision` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `admin_audit_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_admin_audit_events_transition` UNIQUE(`operation_id`,`transition_token`),
	CONSTRAINT `chk_admin_audit_events_scope` CHECK((`admin_audit_events`.`scope` = 'SYSTEM' AND `admin_audit_events`.`family_id` IS NULL) OR (`admin_audit_events`.`scope` = 'FAMILY' AND `admin_audit_events`.`family_id` IS NOT NULL)),
	CONSTRAINT `chk_admin_audit_events_actor` CHECK((`admin_audit_events`.`actor_kind` = 'SYSTEM' AND `admin_audit_events`.`actor_user_id` IS NULL AND `admin_audit_events`.`actor_member_id` IS NULL AND `admin_audit_events`.`actor_role` IS NULL) OR (`admin_audit_events`.`actor_kind` = 'MEMBER' AND `admin_audit_events`.`actor_user_id` IS NOT NULL AND `admin_audit_events`.`actor_member_id` IS NOT NULL AND `admin_audit_events`.`actor_role` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `admin_runtime_observations` (
	`role` enum('API','DERIVATIVE','METADATA','PURGE') NOT NULL,
	`boot_id` varchar(36) NOT NULL,
	`received_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_successful_at` datetime(3),
	`control_revision` bigint unsigned NOT NULL,
	`state` enum('STARTING','IDLE','RUNNING','PAUSED','RECOVERY_REQUIRED','STOPPED') NOT NULL,
	`reason_code` varchar(48) NOT NULL,
	`completed_units` bigint unsigned NOT NULL DEFAULT 0,
	`exited_at` datetime(3),
	CONSTRAINT `admin_runtime_observations_boot_id` PRIMARY KEY(`boot_id`),
	CONSTRAINT `chk_admin_runtime_observations_revision` CHECK(`admin_runtime_observations`.`control_revision` >= 1),
	CONSTRAINT `chk_admin_runtime_observations_exit` CHECK((`admin_runtime_observations`.`state` = 'STOPPED' AND `admin_runtime_observations`.`exited_at` IS NOT NULL) OR (`admin_runtime_observations`.`state` <> 'STOPPED' AND `admin_runtime_observations`.`exited_at` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `system_admin_grants` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`member_id` bigint unsigned NOT NULL,
	`family_id` bigint unsigned NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`revision` bigint unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `system_admin_grants_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_system_admin_grants_binding` UNIQUE(`user_id`,`member_id`,`family_id`),
	CONSTRAINT `chk_system_admin_grants_revision` CHECK(`system_admin_grants`.`revision` >= 1)
);
--> statement-breakpoint
CREATE TABLE `system_control` (
	`id` tinyint unsigned NOT NULL,
	`deployment_id` varchar(36) NOT NULL,
	`namespace_identity` binary(32),
	`requested_mode` enum('NORMAL','READ_ONLY','MAINTENANCE') NOT NULL DEFAULT 'READ_ONLY',
	`enforced_mode` enum('NORMAL','READ_ONLY','MAINTENANCE') NOT NULL DEFAULT 'READ_ONLY',
	`transition_state` enum('STABLE','DRAINING','RESUMING','RECOVERY_REQUIRED') NOT NULL DEFAULT 'RECOVERY_REQUIRED',
	`revision` bigint unsigned NOT NULL DEFAULT 1,
	`health_generation` bigint unsigned NOT NULL DEFAULT 1,
	`fault_latched` boolean NOT NULL DEFAULT true,
	`reason_code` varchar(48) NOT NULL DEFAULT 'NOT_INITIALIZED',
	`active_operation_id` varchar(36),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `system_control_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_system_control_singleton` CHECK(`system_control`.`id` = 1),
	CONSTRAINT `chk_system_control_revision` CHECK(`system_control`.`revision` >= 1 AND `system_control`.`health_generation` >= 1),
	CONSTRAINT `chk_system_control_stable` CHECK(`system_control`.`transition_state` <> 'STABLE' OR `system_control`.`requested_mode` = `system_control`.`enforced_mode`),
	CONSTRAINT `chk_system_control_protected` CHECK((`system_control`.`transition_state` <> 'RECOVERY_REQUIRED' AND `system_control`.`fault_latched` = 0) OR `system_control`.`enforced_mode` <> 'NORMAL'),
	CONSTRAINT `chk_system_control_initialized` CHECK(`system_control`.`enforced_mode` <> 'NORMAL' OR (`system_control`.`namespace_identity` IS NOT NULL AND `system_control`.`fault_latched` = 0))
);
--> statement-breakpoint
CREATE TABLE `system_control_operations` (
	`id` varchar(36) NOT NULL,
	`kind` enum('MODE','RECHECK','BOOTSTRAP') NOT NULL,
	`fingerprint` binary(32) NOT NULL,
	`actor_user_id` bigint unsigned,
	`actor_member_id` bigint unsigned,
	`actor_family_id` bigint unsigned,
	`session_id` bigint unsigned,
	`client_type` enum('WEB','ANDROID'),
	`grant_id` bigint unsigned,
	`expected_revision` bigint unsigned NOT NULL,
	`requested_mode` enum('NORMAL','READ_ONLY','MAINTENANCE') NOT NULL,
	`status` enum('PENDING','APPLIED','REJECTED','RECOVERY_REQUIRED') NOT NULL DEFAULT 'PENDING',
	`result_revision` bigint unsigned,
	`reason_code` varchar(48) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `system_control_operations_id` PRIMARY KEY(`id`),
	CONSTRAINT `chk_system_control_operations_actor` CHECK((`system_control_operations`.`kind` = 'BOOTSTRAP' AND `system_control_operations`.`actor_user_id` IS NULL AND `system_control_operations`.`actor_member_id` IS NULL AND `system_control_operations`.`actor_family_id` IS NULL AND `system_control_operations`.`session_id` IS NULL AND `system_control_operations`.`client_type` IS NULL AND `system_control_operations`.`grant_id` IS NULL) OR (`system_control_operations`.`kind` <> 'BOOTSTRAP' AND `system_control_operations`.`actor_user_id` IS NOT NULL AND `system_control_operations`.`actor_member_id` IS NOT NULL AND `system_control_operations`.`actor_family_id` IS NOT NULL AND `system_control_operations`.`session_id` IS NOT NULL AND `system_control_operations`.`client_type` IS NOT NULL AND `system_control_operations`.`grant_id` IS NOT NULL)),
	CONSTRAINT `chk_system_control_operations_revision` CHECK(`system_control_operations`.`expected_revision` >= 1 AND (`system_control_operations`.`result_revision` IS NULL OR `system_control_operations`.`result_revision` >= 1)),
	CONSTRAINT `chk_system_control_operations_finish` CHECK((`system_control_operations`.`status` IN ('PENDING','RECOVERY_REQUIRED') AND `system_control_operations`.`finished_at` IS NULL) OR (`system_control_operations`.`status` IN ('APPLIED','REJECTED') AND `system_control_operations`.`finished_at` IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE `family_members` ADD CONSTRAINT `uq_family_members_binding` UNIQUE(`family_id`,`id`,`user_id`);--> statement-breakpoint
ALTER TABLE `system_admin_grants` ADD CONSTRAINT `fk_system_admin_grants_member` FOREIGN KEY (`family_id`,`member_id`,`user_id`) REFERENCES `family_members`(`family_id`,`id`,`user_id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX `idx_admin_audit_events_scope_time` ON `admin_audit_events` (`scope`,`family_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_admin_runtime_observations_role_time` ON `admin_runtime_observations` (`role`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_system_control_operations_pending` ON `system_control_operations` (`status`,`created_at`);
--> statement-breakpoint
INSERT INTO `system_control` (`id`,`deployment_id`,`requested_mode`,`enforced_mode`,`transition_state`,`revision`,`health_generation`,`fault_latched`,`reason_code`) VALUES (1,'00000000-0000-0000-0000-000000000000','READ_ONLY','READ_ONLY','RECOVERY_REQUIRED',1,1,true,'NOT_INITIALIZED');
