-- ジャンルの初期値（data-model.md §3 genre）
INSERT OR IGNORE INTO `genre` (`id`, `label`, `sort_order`, `archived`) VALUES
  ('g_hirameki', 'ひらめき', 1, 0),
  ('g_logic', '論理', 2, 0),
  ('g_volume', '物量', 3, 0),
  ('g_story', 'ストーリー', 4, 0),
  ('g_explore', '探索', 5, 0),
  ('g_onebig', '大謎一発', 6, 0),
  ('g_coop', '協力', 7, 0),
  ('g_experience', '体験・演出', 8, 0);
