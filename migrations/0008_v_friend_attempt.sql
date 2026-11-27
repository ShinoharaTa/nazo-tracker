-- フレンドに見せる記録の射影（docs/design.md §6、docs/auth.md §6）。v_attempt_enriched とは別の、列を絞った専用ビュー。
-- spoiler_memo・memo・rating・difficulty・volume・companions・party_size・purchased_on・attempt の id・session 由来の列（display_on を含む）は含めない。
-- share_override と created_at は絞り込みと並び順にだけ使う。クエリ側は必ず user_id と共有範囲で絞る（src/db/scoped.ts の asFriendOf）
-- 注意: attempt / work を作り直す migration を書くときは、先に DROP VIEW v_friend_attempt → 表の作り直し → CREATE VIEW（この定義）を同じ migration に入れる。
CREATE VIEW `v_friend_attempt` AS
SELECT a.user_id, a.work_id, a.status, a.started_on, a.finished_on,
       a.share_override, a.created_at,
       w.title AS work_title, w.kind AS work_kind
FROM attempt a JOIN work w ON w.id = a.work_id;
