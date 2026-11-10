// 本人の統計（/stats）の集計。純関数で DB を触らない。入力は own().statsRows() の結果（docs/data-model.md §6）。
// 成功率の分母は cleared + failed。dropAsFail なら dropped も失敗側として分母に入れる

import type { OwnAttemptRow } from '../db/scoped'
import { isoToJstDate } from './time'

type Status = OwnAttemptRow['status']
type Kind = OwnAttemptRow['work']['kind']

export type StatsOptions = { dropAsFail: boolean; year: number }

// total = 分母（クリア＋失敗、dropAsFail なら＋断念）、cleared = クリア
export type RateRow = { total: number; cleared: number }

export type StatsSummary = {
  played: number
  cleared: number
  failed: number
  dropped: number
  // 0〜1。分母が 0 なら null
  rate: number | null
  // 作品ごとの代表（結果が付いた記録のうち attempt_no 最大、同値なら created_at 最大）だけで同じ式
  rateByWork: number | null
  backlog: number
}

export type Stats = {
  summary: StatsSummary
  // 難易度 1〜5 の 5 行固定（difficulty NULL は除外）
  byDifficulty: (RateRow & { label: string })[]
  // total ≥ 1 のみ。成功率 DESC, total DESC, ラベル ASC
  byGenre: (RateRow & { genreId: string; label: string })[]
  // total ≥ 1 のみ。kind は NULL（形式未設定）を含む
  byKind: (RateRow & { kind: Kind })[]
  // 1〜12 月の参加数（クリア・失敗・断念）
  monthly: number[]
}

// 挑戦した（結果が付いた）記録
export const isAttempted = (status: Status): boolean =>
  status === 'cleared' || status === 'failed' || status === 'dropped'

const inDenom = (status: Status, dropAsFail: boolean): boolean =>
  status === 'cleared' || status === 'failed' || (dropAsFail && status === 'dropped')

const rateOf = (rows: readonly OwnAttemptRow[], dropAsFail: boolean): RateRow => {
  let total = 0
  let cleared = 0
  for (const r of rows) {
    if (!inDenom(r.status, dropAsFail)) continue
    total++
    if (r.status === 'cleared') cleared++
  }
  return { total, cleared }
}

const ratio = ({ total, cleared }: RateRow): number | null => (total ? cleared / total : null)

// 作品ごとの代表 = 結果（クリア・失敗・断念）が付いた記録のうち attempt_no 最大（同値なら created_at 最大）。
// 最新が買った・進行中ならその前の結果を使い、結果が 1 件も無い作品は含めない
const latestPerWork = (rows: readonly OwnAttemptRow[]): OwnAttemptRow[] => {
  const latest = new Map<string, OwnAttemptRow>()
  for (const r of rows) {
    if (!isAttempted(r.status)) continue
    const cur = latest.get(r.workId)
    if (
      !cur ||
      r.attemptNo > cur.attemptNo ||
      (r.attemptNo === cur.attemptNo && r.createdAt > cur.createdAt)
    ) {
      latest.set(r.workId, r)
    }
  }
  return [...latest.values()]
}

export const summarize = (rows: readonly OwnAttemptRow[], dropAsFail: boolean): StatsSummary => {
  const count = (s: Status) => rows.filter((r) => r.status === s).length
  const cleared = count('cleared')
  const failed = count('failed')
  return {
    played: cleared + failed,
    cleared,
    failed,
    dropped: count('dropped'),
    rate: ratio(rateOf(rows, dropAsFail)),
    rateByWork: ratio(rateOf(latestPerWork(rows), dropAsFail)),
    backlog: count('purchased') + count('in_progress'),
  }
}

export const byDifficulty = (
  rows: readonly OwnAttemptRow[],
  dropAsFail: boolean,
): (RateRow & { label: string })[] =>
  [1, 2, 3, 4, 5].map((n) => ({
    label: `★${n}`,
    ...rateOf(
      rows.filter((r) => r.difficulty === n),
      dropAsFail,
    ),
  }))

// genres に rows に無い記録が混じっていても無視する（上限で切った分など）。
// labels は genre.id → 表示名（無い id は id のまま）
export const byGenre = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  labels: ReadonlyMap<string, string>,
  dropAsFail: boolean,
): (RateRow & { genreId: string; label: string })[] => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const grouped = new Map<string, OwnAttemptRow[]>()
  for (const g of genres) {
    const r = byId.get(g.attemptId)
    if (!r) continue
    const list = grouped.get(g.genreId) ?? []
    list.push(r)
    grouped.set(g.genreId, list)
  }
  return [...grouped]
    .map(([genreId, list]) => ({
      genreId,
      label: labels.get(genreId) ?? genreId,
      ...rateOf(list, dropAsFail),
    }))
    .filter((g) => g.total >= 1)
    .sort(
      (a, b) =>
        b.cleared / b.total - a.cleared / a.total ||
        b.total - a.total ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    )
}

// 並びは最初に現れた順（呼び出し側で並べ替える）
export const byKind = (
  rows: readonly OwnAttemptRow[],
  dropAsFail: boolean,
): (RateRow & { kind: Kind })[] => {
  const grouped = new Map<Kind, OwnAttemptRow[]>()
  for (const r of rows) {
    const list = grouped.get(r.work.kind) ?? []
    list.push(r)
    grouped.set(r.work.kind, list)
  }
  return [...grouped]
    .map(([kind, list]) => ({ kind, ...rateOf(list, dropAsFail) }))
    .filter((k) => k.total >= 1)
}

// 月は COALESCE(finished_on, started_on, created_at の JST 日付) の年月。日付が取れない行は数えない
export const monthly = (rows: readonly OwnAttemptRow[], year: number): number[] => {
  const counts = Array.from({ length: 12 }, () => 0)
  const prefix = `${year}-`
  for (const r of rows) {
    if (!isAttempted(r.status)) continue
    const on = r.finishedOn ?? r.startedOn ?? isoToJstDate(r.createdAt)
    if (!on?.startsWith(prefix)) continue
    const m = Number(on.slice(5, 7))
    if (m >= 1 && m <= 12) counts[m - 1]++
  }
  return counts
}

export const computeStats = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  genreLabels: ReadonlyMap<string, string>,
  { dropAsFail, year }: StatsOptions,
): Stats => ({
  summary: summarize(rows, dropAsFail),
  byDifficulty: byDifficulty(rows, dropAsFail),
  byGenre: byGenre(rows, genres, genreLabels, dropAsFail),
  byKind: byKind(rows, dropAsFail),
  monthly: monthly(rows, year),
})
