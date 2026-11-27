-- work_alias に UNIQUE(work_id, title_norm)、organization_alias に UNIQUE(organization_id, name_norm) を足す（#48）。表は作り直さない。
-- 既に重複している行があると CREATE UNIQUE INDEX が失敗するので、先に同じ (親 id, *_norm) の行を id が最小の 1 行だけ残して消す。
-- 別名の行を参照する子表は無い（FK も id の参照も無い）。
-- ここで消す重複行は change_log に残さない（同じ親に同じ表記が既にあり、失われる情報は種類・期間だけ）。
-- organization_alias_name_norm_idx（name_norm だけ）は名前での検索用で列が違うので残す。work_alias には既存のインデックスが無い。
DELETE FROM `organization_alias` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `organization_alias` GROUP BY `organization_id`, `name_norm`);--> statement-breakpoint
DELETE FROM `work_alias` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `work_alias` GROUP BY `work_id`, `title_norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_alias_org_name_norm_unique` ON `organization_alias` (`organization_id`,`name_norm`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_alias_work_title_norm_unique` ON `work_alias` (`work_id`,`title_norm`);
