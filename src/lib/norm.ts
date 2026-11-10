// 名寄せ・検索用の正規化（docs/data-model.md §5）。name_norm / title_norm は INSERT / UPDATE 時にサーバーがこれで計算する。
// LIKE に渡すときのエスケープは呼び出し側（src/db/master.ts）で行う。記号だけの名前は % _ \ が残りうる。

export const norm = (s: string): string => {
  const t = s.normalize('NFKC').toLowerCase()
  // 【…】は中身ごと除去（【追加公演】など）。「」『』は括弧文字だけ下で消える
  // 空白・句読点・記号。「」『』【】・〜 は \p{P} に入る
  let u = t.replace(/【[^】]*】/gu, '').replace(/[\s\p{P}\p{S}]/gu, '')
  // 記号だけの名前は記号を残す
  if (u === '') u = t.replace(/\s/gu, '')
  const v = u.replace(/(再演|再々演|20\d\d|第\d+弾)+$/u, '')
  // 「2026」だけの題名を空にしない
  return v === '' ? u : v
}
