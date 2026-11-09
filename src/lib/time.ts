// 日時は ISO 8601 の UTC 文字列（toISOString の形）。同じ形どうしなら文字列比較で前後が分かる

export const nowIso = (): string => new Date().toISOString()

export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso) + n * 86_400_000).toISOString()

export const isPast = (iso: string): boolean => Date.parse(iso) <= Date.now()
