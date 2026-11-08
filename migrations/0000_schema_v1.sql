CREATE TABLE `api_token` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`token_hash` text,
	`role` text,
	`scopes_json` text,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	CONSTRAINT "api_token_role_check" CHECK("role" IN ('agent'))
);
--> statement-breakpoint
CREATE TABLE `attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`work_id` text NOT NULL,
	`run_id` text,
	`status` text,
	`purchased_on` text,
	`attempt_no` integer,
	`started_on` text,
	`finished_on` text,
	`duration_sec` integer,
	`party_size` integer,
	`companions` text,
	`rating` integer,
	`difficulty` integer,
	`volume` integer,
	`memo` text,
	`spoiler_memo` text,
	`share_override` text,
	`source_ref` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attempt_status_check" CHECK("status" IN ('purchased', 'in_progress', 'cleared', 'failed', 'dropped')),
	CONSTRAINT "attempt_share_override_check" CHECK("share_override" IN ('hidden', 'status', 'rating', 'memo')),
	CONSTRAINT "attempt_rating_check" CHECK("rating" BETWEEN 1 AND 5),
	CONSTRAINT "attempt_difficulty_check" CHECK("difficulty" BETWEEN 1 AND 5),
	CONSTRAINT "attempt_volume_check" CHECK("volume" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `attempt_user_status_idx` ON `attempt` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `attempt_user_finished_on_idx` ON `attempt` (`user_id`,`finished_on`);--> statement-breakpoint
CREATE INDEX `attempt_user_work_idx` ON `attempt` (`user_id`,`work_id`);--> statement-breakpoint
CREATE INDEX `attempt_work_status_user_idx` ON `attempt` (`work_id`,`status`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attempt_user_source_ref_unique` ON `attempt` (`user_id`,`source_ref`);--> statement-breakpoint
CREATE TABLE `attempt_genre` (
	`attempt_id` text NOT NULL,
	`genre_id` text NOT NULL,
	`user_id` text,
	PRIMARY KEY(`attempt_id`, `genre_id`),
	FOREIGN KEY (`attempt_id`) REFERENCES `attempt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`genre_id`) REFERENCES `genre`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempt_genre_user_genre_idx` ON `attempt_genre` (`user_id`,`genre_id`);--> statement-breakpoint
CREATE TABLE `block` (
	`user_id` text,
	`blocked_user_id` text,
	`created_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `booth` (
	`id` text PRIMARY KEY NOT NULL,
	`market_edition_id` text,
	`organization_id` text,
	`name_as_listed` text,
	`booth_no` text,
	`detail_url` text,
	`days` text,
	FOREIGN KEY (`market_edition_id`) REFERENCES `market_edition`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `booth_market_edition_detail_url_unique` ON `booth` (`market_edition_id`,`detail_url`);--> statement-breakpoint
CREATE TABLE `booth_item` (
	`id` text PRIMARY KEY NOT NULL,
	`booth_id` text,
	`work_id` text,
	`title_as_listed` text,
	`price_yen` integer,
	FOREIGN KEY (`booth_id`) REFERENCES `booth`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`table_name` text,
	`row_id` text,
	`action` text,
	`before_json` text,
	`after_json` text,
	`actor` text,
	`proposal_id` text,
	`created_at` text,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `friend_request` (
	`id` text PRIMARY KEY NOT NULL,
	`from_user_id` text,
	`to_user_id` text,
	`status` text,
	`created_at` text,
	`responded_at` text,
	FOREIGN KEY (`from_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "friend_request_status_check" CHECK("status" IN ('pending', 'accepted', 'declined', 'canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friend_request_pending_unique` ON `friend_request` (`from_user_id`,`to_user_id`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE TABLE `friendship` (
	`user_lo` text NOT NULL,
	`user_hi` text NOT NULL,
	`created_at` text,
	PRIMARY KEY(`user_lo`, `user_hi`),
	FOREIGN KEY (`user_lo`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_hi`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "friendship_order_check" CHECK("user_lo" < "user_hi")
);
--> statement-breakpoint
CREATE TABLE `genre` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text,
	`sort_order` integer,
	`archived` integer,
	CONSTRAINT "genre_archived_check" CHECK("archived" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `identity` (
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`user_id` text,
	`created_at` text,
	`last_login_at` text,
	PRIMARY KEY(`provider`, `subject`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `image` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`attempt_id` text,
	`kind` text,
	`spoiler` integer,
	`r2_key` text,
	`thumb_r2_key` text,
	`width` integer,
	`height` integer,
	`bytes` integer,
	`content_type` text,
	`removed_at` text,
	`removed_reason` text,
	`created_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempt`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "image_kind_check" CHECK("kind" IN ('key_visual', 'clear_panel', 'other')),
	CONSTRAINT "image_spoiler_check" CHECK("spoiler" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `image_report` (
	`id` text PRIMARY KEY NOT NULL,
	`image_id` text,
	`reporter_user_id` text,
	`reason` text,
	`created_at` text,
	FOREIGN KEY (`image_id`) REFERENCES `image`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`name_norm` text,
	`site_url` text
);
--> statement-breakpoint
CREATE TABLE `market_edition` (
	`id` text PRIMARY KEY NOT NULL,
	`market_id` text,
	`label` text,
	`start_on` text,
	`end_on` text,
	`venue_id` text,
	`escape_id_url` text,
	`source_url` text,
	`external_key` text,
	FOREIGN KEY (`market_id`) REFERENCES `market`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `market_visit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`market_edition_id` text,
	`visited_on` text,
	`memo` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`market_edition_id`) REFERENCES `market_edition`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text,
	`code_verifier` text,
	`mode` text,
	`user_id` text,
	`expires_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "oauth_state_mode_check" CHECK("mode" IN ('login', 'link'))
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`slug` text,
	`site_url` text,
	`escape_id_url` text,
	`note` text,
	`merged_into_id` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`merged_into_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_escape_id_url_unique` ON `organization` (`escape_id_url`);--> statement-breakpoint
CREATE INDEX `organization_name_norm_idx` ON `organization` (`name_norm`);--> statement-breakpoint
CREATE TABLE `organization_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`name` text,
	`name_norm` text,
	`kind` text,
	`since` text,
	`until` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "organization_alias_kind_check" CHECK("kind" IN ('former_name', 'alt_spelling', 'label'))
);
--> statement-breakpoint
CREATE INDEX `organization_alias_name_norm_idx` ON `organization_alias` (`name_norm`);--> statement-breakpoint
CREATE TABLE `proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`kind` text,
	`target_table` text,
	`target_id` text,
	`confidence` real,
	`status` text,
	`fingerprint` text,
	`match_candidates_json` text,
	`created_by_token_id` text,
	`created_at` text,
	`reviewed_at` text,
	`reviewer_user_id` text,
	`review_note` text,
	`revert_until` text,
	FOREIGN KEY (`request_id`) REFERENCES `request`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_token_id`) REFERENCES `api_token`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "proposal_kind_check" CHECK("kind" IN ('create', 'update', 'link', 'merge', 'create_attempt_import')),
	CONSTRAINT "proposal_status_check" CHECK("status" IN ('pending', 'applied', 'auto_applied', 'rejected', 'superseded', 'suppressed'))
);
--> statement-breakpoint
CREATE INDEX `proposal_fingerprint_idx` ON `proposal` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `proposal_field` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text,
	`field` text,
	`old_value` text,
	`new_value` text,
	`source_id` text,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposal`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recovery_code` (
	`user_id` text,
	`code_hash` text,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rejection_memory` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`reason` text,
	`created_at` text
);
--> statement-breakpoint
CREATE TABLE `request` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_user_id` text,
	`kind` text,
	`payload_json` text,
	`status` text,
	`triage_note` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`requester_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "request_kind_check" CHECK("kind" IN ('new_work', 'fix_work', 'new_organization', 'new_shop', 'new_booth', 'new_room_venue', 'new_genre', 'import_trailcast', 'other')),
	CONSTRAINT "request_status_check" CHECK("status" IN ('open', 'triaged', 'rejected', 'processing', 'proposed', 'done', 'needs_info'))
);
--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`channel` text,
	`organization_id` text,
	`billed_as` text,
	`venue_id` text,
	`shop_id` text,
	`start_on` text,
	`end_on` text,
	`is_permanent` integer,
	`escape_id_url` text,
	`ticket_url` text,
	`price_yen` integer,
	`escape_type_raw` text,
	`note` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venue`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shop_id`) REFERENCES `shop`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_channel_check" CHECK("channel" IN ('performance', 'online', 'sale')),
	CONSTRAINT "run_is_permanent_check" CHECK("is_permanent" IN (0, 1)),
	CONSTRAINT "run_sale_shop_check" CHECK("channel" <> 'sale' OR "shop_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_escape_id_url_unique` ON `run` (`escape_id_url`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text,
	`user_id` text,
	`played_on` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`duration_sec` integer,
	`progress_note` text,
	`companions` text,
	`memo` text,
	`venue_id` text,
	`location_text` text,
	`created_at` text,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`venue_id`) REFERENCES `venue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_token` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`expires_at` text,
	`created_at` text,
	`ua_hint` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shop` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`kind` text,
	`url` text,
	`organization_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shop_kind_check" CHECK("kind" IN ('booth', 'official_store', 'physical_store', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shop_url_unique` ON `shop` (`url`);--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text,
	`domain` text,
	`method` text,
	`fetched_at` text,
	`content_hash` text,
	`excerpt` text,
	`robots_checked` integer,
	CONSTRAINT "source_method_check" CHECK("method" IN ('escape_mcp', 'webfetch', 'manual', 'pds')),
	CONSTRAINT "source_robots_checked_check" CHECK("robots_checked" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`role` text,
	`friend_code` text,
	`default_share_level` text DEFAULT 'status',
	`exclude_from_counts` integer DEFAULT 0,
	`created_at` text,
	`last_seen_at` text,
	`deleted_at` text,
	CONSTRAINT "user_role_check" CHECK("role" IN ('member', 'owner')),
	CONSTRAINT "user_default_share_level_check" CHECK("default_share_level" IN ('none', 'status', 'rating', 'memo')),
	CONSTRAINT "user_exclude_from_counts_check" CHECK("exclude_from_counts" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `venue` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`name_norm` text,
	`prefecture` text,
	`address` text,
	`organization_id` text,
	`merged_into_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_id`) REFERENCES `venue`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wishlist` (
	`user_id` text NOT NULL,
	`work_id` text NOT NULL,
	`memo` text,
	`created_at` text,
	PRIMARY KEY(`user_id`, `work_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `wishlist_work_idx` ON `wishlist` (`work_id`);--> statement-breakpoint
CREATE TABLE `work` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`title_norm` text,
	`kind` text,
	`primary_organization_id` text,
	`official_url` text,
	`description` text,
	`player_min` integer,
	`player_max` integer,
	`estimated_minutes` integer,
	`time_limit_minutes` integer,
	`first_released_on` text,
	`merged_into_id` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`primary_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_kind_check" CHECK("kind" IN ('hall', 'room', 'stroll', 'line', 'web', 'takeaway', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_official_url_unique` ON `work` (`official_url`);--> statement-breakpoint
CREATE INDEX `work_title_norm_idx` ON `work` (`title_norm`);--> statement-breakpoint
CREATE TABLE `work_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text,
	`title` text,
	`title_norm` text,
	`kind` text,
	FOREIGN KEY (`work_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_alias_kind_check" CHECK("kind" IN ('former_title', 'alt_spelling', 'subtitle'))
);
