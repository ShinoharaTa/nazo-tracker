-- マスタの画像（作品の OGP 画像・団体のロゴ）の URL と取得元のページ、「画像を載せない」（#150、docs/design.md §3.4.2）。
-- ADD COLUMN だけで、表は作り直さない（ビュー v_attempt_enriched / v_friend_attempt に触れない）。
-- image_blocked の 0 / 1 は validators が保証する（CHECK を付けると drizzle-kit が表の作り直しを生成するので付けない）。
ALTER TABLE `work` ADD `image_url` text;--> statement-breakpoint
ALTER TABLE `work` ADD `image_page_url` text;--> statement-breakpoint
ALTER TABLE `work` ADD `image_blocked` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organization` ADD `logo_url` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `logo_page_url` text;--> statement-breakpoint
ALTER TABLE `organization` ADD `image_blocked` integer DEFAULT 0 NOT NULL;
