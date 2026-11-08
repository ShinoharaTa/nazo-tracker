ALTER TABLE `api_token` ADD `created_at` text NOT NULL;--> statement-breakpoint
CREATE INDEX `change_log_table_name_row_idx` ON `change_log` (`table_name`,`row_id`);--> statement-breakpoint
CREATE INDEX `friendship_user_hi_idx` ON `friendship` (`user_hi`);--> statement-breakpoint
CREATE UNIQUE INDEX `image_report_image_reporter_user_unique` ON `image_report` (`image_id`,`reporter_user_id`);--> statement-breakpoint
CREATE INDEX `proposal_status_idx` ON `proposal` (`status`);--> statement-breakpoint
CREATE INDEX `proposal_target_table_target_idx` ON `proposal` (`target_table`,`target_id`);--> statement-breakpoint
CREATE INDEX `request_status_idx` ON `request` (`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_friend_request` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` text NOT NULL,
	`to_user_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`responded_at` text,
	FOREIGN KEY (`from_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "friend_request_status_check" CHECK("status" IN ('pending', 'accepted', 'declined', 'canceled')),
	CONSTRAINT "friend_request_self_check" CHECK("from_user_id" <> "to_user_id")
);
--> statement-breakpoint
INSERT INTO `__new_friend_request`("id", "from_user_id", "to_user_id", "status", "created_at", "responded_at") SELECT "id", "from_user_id", "to_user_id", "status", "created_at", "responded_at" FROM `friend_request`;--> statement-breakpoint
DROP TABLE `friend_request`;--> statement-breakpoint
ALTER TABLE `__new_friend_request` RENAME TO `friend_request`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `friend_request_pending_unique` ON `friend_request` (`from_user_id`,`to_user_id`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `friend_request_to_status_idx` ON `friend_request` (`to_user_id`,`status`);