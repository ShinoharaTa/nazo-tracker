// 日時は ISO 8601 の UTC 文字列（toISOString の形）。同じ形どうしなら文字列比較で前後が分かる

export const nowIso = (): string => new Date().toISOString()

export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString()

export const isPast = (iso: string): boolean => Date.parse(iso) <= Date.now()

// ISO の UTC 日時 → JST の日付 YYYY-MM-DD。解釈できない文字列は null
export const isoToJstDate = (iso: string): string | null => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t + 9 * 3_600_000).toISOString().slice(0, 10)
}

// 今日の日付（JST）を YYYY-MM-DD で。run の start_on / end_on と文字列比較する
export const todayJst = (): string =>
  new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)
