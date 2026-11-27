-- work.kind に cafe（カフェ謎）・box（箱謎）を足す（#111）。CHECK を変えるため work を作り直す。
-- 注意: D1 は PRAGMA foreign_keys=OFF が効かない。work を参照する子表（attempt / booth_item / run / wishlist / work_alias /
-- work.merged_into_id）はすべて ON DELETE no action なので、DROP TABLE work で子の行は消えない（CASCADE は無い）。
-- DROP TABLE work は子の行の数だけ遅延 FK 違反を数える。数え戻しは「work という名前の表への INSERT」でしか起きないため、
-- drizzle-kit の __new_work → RENAME の順だと COMMIT で FOREIGN KEY constraint failed になる。
-- そこで work_old に退避 → DROP → 同じ名前 work で作り直して INSERT、の順にし、検査は defer_foreign_keys で COMMIT 時に回す。
-- INSERT … SELECT の列は 0000 の work の全 15 列（0002〜0005 で work の列は変わっていない）。
-- v_attempt_enriched は work を参照するので、先に DROP して最後に 0004 と同じ定義で作り直す。
-- リモート（--remote）で行がある状態での適用は未検証。本番が空のうちに適用する。行がある表の作り直しにこのやり方を使い回す前に検証する。
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
DROP VIEW `v_attempt_enriched`;--> statement-breakpoint
CREATE TABLE `work_old` AS SELECT "id", "title", "title_norm", "kind", "primary_organization_id", "official_url", "description", "player_min", "player_max", "estimated_minutes", "time_limit_minutes", "first_released_on", "merged_into_id", "created_at", "updated_at" FROM `work`;--> statement-breakpoint
DROP TABLE `work`;--> statement-breakpoint
CREATE TABLE `work` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`title_norm` text NOT NULL,
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`primary_organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into_id`) REFERENCES `work`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "work_kind_check" CHECK("kind" IN ('hall', 'room', 'stroll', 'line', 'web', 'takeaway', 'cafe', 'box', 'other'))
);
--> statement-breakpoint
INSERT INTO `work`("id", "title", "title_norm", "kind", "primary_organization_id", "official_url", "description", "player_min", "player_max", "estimated_minutes", "time_limit_minutes", "first_released_on", "merged_into_id", "created_at", "updated_at") SELECT "id", "title", "title_norm", "kind", "primary_organization_id", "official_url", "description", "player_min", "player_max", "estimated_minutes", "time_limit_minutes", "first_released_on", "merged_into_id", "created_at", "updated_at" FROM `work_old`;--> statement-breakpoint
DROP TABLE `work_old`;--> statement-breakpoint
CREATE UNIQUE INDEX `work_official_url_unique` ON `work` (`official_url`);--> statement-breakpoint
CREATE INDEX `work_title_norm_idx` ON `work` (`title_norm`);--> statement-breakpoint
-- v_attempt_enriched は 0004 と同じ定義
CREATE VIEW `v_attempt_enriched` AS
SELECT
  a.id, a.user_id, a.work_id, a.run_id, a.status, a.purchased_on, a.attempt_no,
  a.started_on, a.finished_on, a.duration_sec, a.party_size, a.companions,
  a.rating, a.difficulty, a.volume, a.memo, a.share_override, a.source_ref,
  a.created_at, a.updated_at,
  (SELECT MAX(s.played_on)    FROM session s WHERE s.attempt_id = a.id) AS last_played_on,
  (SELECT COUNT(*)            FROM session s WHERE s.attempt_id = a.id) AS session_count,
  (SELECT SUM(s.duration_sec) FROM session s WHERE s.attempt_id = a.id) AS session_duration_sec,
  CASE a.status
    WHEN 'purchased'   THEN a.purchased_on
    WHEN 'in_progress' THEN COALESCE((SELECT MAX(s.played_on) FROM session s WHERE s.attempt_id = a.id), a.started_on)
    ELSE COALESCE(a.finished_on, (SELECT MAX(s.played_on) FROM session s WHERE s.attempt_id = a.id), a.started_on)
  END AS display_on,
  w.title AS work_title, w.kind AS work_kind,
  o.id AS org_id, o.name AS org_name,
  r.channel AS run_channel, r.start_on AS run_start_on, r.end_on AS run_end_on,
  v.id AS venue_id, v.name AS venue_name, v.prefecture AS venue_prefecture
FROM attempt a
JOIN work w ON w.id = a.work_id
LEFT JOIN run r ON r.id = a.run_id
LEFT JOIN organization o ON o.id = COALESCE(r.organization_id, w.primary_organization_id)
LEFT JOIN venue v ON v.id = r.venue_id;
