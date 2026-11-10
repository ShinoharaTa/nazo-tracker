-- 記録の表示列をまとめるビュー（data-model.md §6）。spoiler_memo は含めない。
-- display_on は一覧の日付スタブ（買った → 買った日、進行中 → 最新ログ日 → 開始日、
-- クリア・失敗・断念 → 終了日 → 最新ログ日 → 開始日）。クエリ側は必ず user_id で絞る（src/db/scoped.ts）
-- 注意: attempt / work / run / organization / venue / session を作り直す migration（drizzle-kit の __new_x）を書くときは、
-- 先に DROP VIEW v_attempt_enriched → 表の作り直し → CREATE VIEW（この定義）を同じ migration に入れる。
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
