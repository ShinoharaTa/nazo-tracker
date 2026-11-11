-- P4 補完パイプライン（data-model.md §4）。proposal / proposal_field は CHECK 追加のため作り直す（適用時点で両表は空の前提）。
-- drizzle-kit の生成から、INSERT … SELECT の列を旧表にある列だけに直している（新しい列は旧表に無い）。
CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_setting_key_check" CHECK("key" IN ('auto_apply'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`kind` text NOT NULL,
	`target_table` text NOT NULL,
	`target_id` text,
	`confidence` real,
	`status` text DEFAULT 'pending' NOT NULL,
	`fingerprint` text NOT NULL,
	`match_candidates_json` text,
	`created_by_token_id` text,
	`created_at` text NOT NULL,
	`reviewed_at` text,
	`reviewer_user_id` text,
	`review_note` text,
	`revert_until` text,
	`applied_json` text,
	`reverted_at` text,
	`reverted_by_user_id` text,
	`follow_up_of_id` text,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_token_id`) REFERENCES `api_token`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverted_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`follow_up_of_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_kind_check" CHECK("kind" IN ('create', 'update', 'link', 'merge', 'create_attempt_import')),
	CONSTRAINT "proposal_status_check" CHECK("status" IN ('pending', 'applied', 'auto_applied', 'rejected', 'superseded', 'suppressed', 'reverted'))
);
--> statement-breakpoint
INSERT INTO `__new_proposal`("id", "request_id", "kind", "target_table", "target_id", "confidence", "status", "fingerprint", "match_candidates_json", "created_by_token_id", "created_at", "reviewed_at", "reviewer_user_id", "review_note", "revert_until") SELECT "id", "request_id", "kind", "target_table", "target_id", "confidence", "status", "fingerprint", "match_candidates_json", "created_by_token_id", "created_at", "reviewed_at", "reviewer_user_id", "review_note", "revert_until" FROM `proposal`;--> statement-breakpoint
DROP TABLE `proposal`;--> statement-breakpoint
ALTER TABLE `__new_proposal` RENAME TO `proposal`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `proposal_pending_fingerprint_unique` ON `proposal` (`fingerprint`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `proposal_status_idx` ON `proposal` (`status`);--> statement-breakpoint
CREATE INDEX `proposal_target_table_target_idx` ON `proposal` (`target_table`,`target_id`);--> statement-breakpoint
CREATE INDEX `proposal_request_idx` ON `proposal` (`request_id`);--> statement-breakpoint
CREATE TABLE `__new_proposal_field` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`source_id` text,
	`confidence` real,
	`accepted` integer,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_field_confidence_check" CHECK("confidence" BETWEEN 0 AND 1),
	CONSTRAINT "proposal_field_accepted_check" CHECK("accepted" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_proposal_field`("id", "proposal_id", "field", "old_value", "new_value", "source_id") SELECT "id", "proposal_id", "field", "old_value", "new_value", "source_id" FROM `proposal_field`;--> statement-breakpoint
DROP TABLE `proposal_field`;--> statement-breakpoint
ALTER TABLE `__new_proposal_field` RENAME TO `proposal_field`;--> statement-breakpoint
CREATE INDEX `proposal_field_proposal_idx` ON `proposal_field` (`proposal_id`);--> statement-breakpoint
ALTER TABLE `request` ADD `question` text;--> statement-breakpoint
ALTER TABLE `request` ADD `reply` text;--> statement-breakpoint
ALTER TABLE `request` ADD `agent_note` text;--> statement-breakpoint
CREATE INDEX `request_requester_created_idx` ON `request` (`requester_user_id`,`created_at`);