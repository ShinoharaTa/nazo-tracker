// 同行者の自由入力を人ごとに分ける（表示時の集計用。保存はしない。docs/data-model.md §6）。
// 区切りは 、 , ， / ／ と空白（全角空白を含む）。空は捨て、1 記録の中の重複は 1 回にする
export const splitCompanions = (s: string | null): string[] => {
  if (!s) return []
  const names = s
    .split(/[、,，/／\s]+/u)
    .map((t) => t.trim())
    .filter((t) => t !== '')
  return [...new Set(names)]
}
