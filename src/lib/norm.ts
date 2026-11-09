// 名寄せ・検索用の正規化（docs/data-model.md §5）。name_norm / title_norm は INSERT / UPDATE 時にサーバーがこれで計算する。
// 結果に % _ \ は含まれない（どれも \p{P} / \p{S} で消える）ので、LIKE に渡すときエスケープは要らない。

export const norm = (s: string): string => {
  const t = s.normalize('NFKC').toLowerCase()
  // 空白・句読点・記号。「」『』【】・〜 は \p{P} に入る
  let u = t.replace(/[\s\p{P}\p{S}]/gu, '')
  // 記号だけの名前は記号を残す
  if (u === '') u = t.replace(/\s/gu, '')
  const v = u.replace(/(再演|再々演|20\d\d|第\d+弾)+$/u, '')
  // 「2026」だけの題名を空にしない
  return v === '' ? u : v
}
