CREATE TABLE `system_control_run_members` (
	`run_id` varchar(36) NOT NULL,
	`role` enum('API','DERIVATIVE','METADATA','PURGE') NOT NULL,
	`boot_id` varchar(36) NOT NULL,
	`process_id` varchar(36) NOT NULL,
	`epoch` bigint unsigned NOT NULL,
	`state` enum('REGISTERED','READY','CLEAN_CLOSED','FAULTED') NOT NULL,
	`ack_operation_id` varchar(36),
	`ack_fingerprint` binary(32),
	`closed_at` datetime(3),
	CONSTRAINT `system_control_run_members_run_id_role_pk` PRIMARY KEY(`run_id`,`role`),
	CONSTRAINT `uq_system_control_run_members_role` UNIQUE(`run_id`,`role`),
	CONSTRAINT `uq_system_control_run_members_boot` UNIQUE(`boot_id`),
	CONSTRAINT `uq_system_control_run_members_ack` UNIQUE(`ack_operation_id`),
	CONSTRAINT `chk_system_control_run_members_epoch` CHECK(`system_control_run_members`.`epoch`>0),
	CONSTRAINT `chk_system_control_run_members_ack` CHECK(`system_control_run_members`.`state`<>'CLEAN_CLOSED' OR (`system_control_run_members`.`ack_operation_id` IS NOT NULL AND `system_control_run_members`.`ack_fingerprint` IS NOT NULL AND `system_control_run_members`.`closed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `system_control_runs` (
	`id` varchar(36) NOT NULL,
	`epoch` bigint unsigned NOT NULL,
	`predecessor_id` varchar(36),
	`deployment_id` varchar(36) NOT NULL,
	`namespace_identity` binary(32) NOT NULL,
	`run_namespace_identity` binary(32) NOT NULL,
	`protocol_version` int unsigned NOT NULL,
	`config_digest` binary(32) NOT NULL,
	`phase` enum('PREPARING','ACTIVE','STOPPING','CLEAN','CONSUMED','RECOVERY_REQUIRED') NOT NULL,
	`expected_roles` varchar(48) NOT NULL,
	`owner_role` enum('API','PURGE') NOT NULL,
	`coordinator_process_id` varchar(36) NOT NULL,
	`coordinator_os_boot_id` varchar(36) NOT NULL,
	`coordinator_pid` int unsigned NOT NULL,
	`coordinator_start_sec` bigint unsigned NOT NULL,
	`coordinator_start_usec` int unsigned NOT NULL,
	`startup_operation_id` varchar(36) NOT NULL,
	`startup_fingerprint` binary(32) NOT NULL,
	`automatic` boolean NOT NULL DEFAULT false,
	`shutdown_operation_id` varchar(36),
	`shutdown_fingerprint` binary(32),
	`clean_requested_mode` enum('NORMAL','READ_ONLY','MAINTENANCE'),
	`clean_enforced_mode` enum('NORMAL','READ_ONLY','MAINTENANCE'),
	`clean_revision` bigint unsigned,
	`clean_health_generation` bigint unsigned,
	`member_manifest` binary(32),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`clean_at` datetime(3),
	CONSTRAINT `system_control_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_system_control_runs_epoch` UNIQUE(`epoch`),
	CONSTRAINT `uq_system_control_runs_predecessor` UNIQUE(`predecessor_id`),
	CONSTRAINT `uq_system_control_runs_startup` UNIQUE(`startup_operation_id`),
	CONSTRAINT `uq_system_control_runs_shutdown` UNIQUE(`shutdown_operation_id`),
	CONSTRAINT `chk_system_control_runs_identity` CHECK(`system_control_runs`.`epoch`>0 AND `system_control_runs`.`protocol_version`=1 AND `system_control_runs`.`coordinator_pid`>0 AND `system_control_runs`.`coordinator_start_sec`>0 AND `system_control_runs`.`coordinator_start_usec`<1000000),
	CONSTRAINT `chk_system_control_runs_clean` CHECK(`system_control_runs`.`phase` NOT IN ('CLEAN','CONSUMED') OR (`system_control_runs`.`shutdown_operation_id` IS NOT NULL AND `system_control_runs`.`shutdown_fingerprint` IS NOT NULL AND `system_control_runs`.`clean_requested_mode` IS NOT NULL AND `system_control_runs`.`clean_enforced_mode` IS NOT NULL AND `system_control_runs`.`clean_enforced_mode`=`system_control_runs`.`clean_requested_mode` AND `system_control_runs`.`clean_revision` IS NOT NULL AND `system_control_runs`.`clean_revision`>0 AND `system_control_runs`.`clean_health_generation` IS NOT NULL AND `system_control_runs`.`clean_health_generation`>0 AND `system_control_runs`.`member_manifest` IS NOT NULL AND `system_control_runs`.`clean_at` IS NOT NULL)),
	CONSTRAINT `chk_system_control_runs_owner` CHECK(FIND_IN_SET(`system_control_runs`.`owner_role`,`system_control_runs`.`expected_roles`)>0)
);
--> statement-breakpoint
ALTER TABLE `admin_audit_events` MODIFY COLUMN `action` enum('MEMBER_DISABLED','MEMBER_RESTORED','MEMBER_ROLE_CHANGED','INVITATION_CREATED','INVITATION_REVOKED','INVITATION_CONSUMED','GRANT_PROVISIONED','GRANT_REVOKED','CONTROL_REQUESTED','CONTROL_APPLIED','RECOVERY_REJECTED','HEALTH_LATCHED','OUTCOME_OBSERVED','BOOTSTRAP_APPLIED','RUN_STARTED','RUN_STOPPING','RUN_CLEAN_CLOSED','STARTUP_AUTO_CONFIRMED','STARTUP_RECHECK_REQUIRED') NOT NULL;--> statement-breakpoint
ALTER TABLE `system_control` ADD `current_run_id` varchar(36);--> statement-breakpoint
ALTER TABLE `system_control` ADD `run_epoch` bigint unsigned DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `system_control_run_members` ADD CONSTRAINT `system_control_run_members_run_id_system_control_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `system_control_runs`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `system_control_run_members` ADD CONSTRAINT `fk_run_members_boot` FOREIGN KEY (`boot_id`) REFERENCES `admin_runtime_observations`(`boot_id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `system_control_runs` ADD CONSTRAINT `system_control_runs_predecessor_id_system_control_runs_id_fk` FOREIGN KEY (`predecessor_id`) REFERENCES `system_control_runs`(`id`) ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE `system_control` ADD CONSTRAINT `system_control_current_run_id_system_control_runs_id_fk` FOREIGN KEY (`current_run_id`) REFERENCES `system_control_runs`(`id`) ON DELETE restrict ON UPDATE restrict;