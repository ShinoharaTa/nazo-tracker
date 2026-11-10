// 本人の統計（/stats）の集計。純関数で DB を触らない。入力は own().statsRows() の結果（docs/data-model.md §6）。
// 来場型（公演・ルーム）は成功率 = cleared / (cleared + failed)。それ以外（完了型）は成功率を出さず cleared の件数を見る

import { workKinds } from '../db/schema'
import type { OwnAttemptRow } from '../db/scoped'
import { isVisitKind } from '../ui/labels'
import { isoToJstDate } from './time'

type Kind = OwnAttemptRow['work']['kind']

export type StatsOptions = { year: number }

// total = 分母（成功＋失敗）、cleared = 成功
export type RateRow = { total: number; cleared: number }

export type VisitKind = 'hall' | 'room'
// NULL（形式未設定）を含む
export type DoneKind = Exclude<Kind, VisitKind>

export type VisitSummary = {
  // 来場型の行数（全ステータス）
  records: number
  // cleared + failed
  played: number
  cleared: number
  failed: number
  // purchased
  reserved: number
  // in_progress + dropped（来場型では選べなくなった旧ステータス。どの集計にも入れない）
  excluded: number
  // 0〜1。played 0 なら null
  rate: number | null
  // 作品ごとの代表（cleared / failed の記録のうち attempt_no 最大、同値なら created_at 最大）だけで同じ式
  rateByWork: number | null
}

export type DoneSummary = {
  records: number
  cleared: number
  failed: number
  dropped: number
  inProgress: number
  // purchased のみ
  backlog: number
}

// 月別の系列。counts は 1〜12 月の 12 要素
export type MonthSeries<K> = { key: K; counts: number[] }[]

export type Stats = {
  visit: {
    summary: VisitSummary
    // 難易度 1〜5 の 5 行固定（difficulty NULL は除外）
    byDifficulty: (RateRow & { label: string })[]
    // total ≥ 1 のみ。成功率 DESC, total DESC, ラベル ASC
    byGenre: (RateRow & { genreId: string; label: string })[]
    // hall, room の 2 行固定
    byKind: (RateRow & { kind: VisitKind })[]
    // 常に成功・失敗の 2 系列、この順
    monthly: MonthSeries<'cleared' | 'failed'>
  }
  done: {
    summary: DoneSummary
    // cleared ≥ 1 のみ。workKinds 順、NULL が最後
    byKind: { kind: DoneKind; cleared: number }[]
    // その年に 1 件以上ある形式だけ、byKind と同じ順
    monthly: MonthSeries<DoneKind>
  }
}

export const splitByVisit = (
  rows: readonly OwnAttemptRow[],
): { visit: OwnAttemptRow[]; done: OwnAttemptRow[] } => {
  const visit: OwnAttemptRow[] = []
  const done: OwnAttemptRow[] = []
  for (const r of rows) (isVisitKind(r.work.kind) ? visit : done).push(r)
  return { visit, done }
}

// 分母は cleared + failed のみ（dropped / in_progress / purchased は入れない）
const isResult = (r: OwnAttemptRow): boolean => r.status === 'cleared' || r.status === 'failed'

const rateOf = (rows: readonly OwnAttemptRow[]): RateRow => {
  let total = 0
  let cleared = 0
  for (const r of rows) {
    if (!isResult(r)) continue
    total++
    if (r.status === 'cleared') cleared++
  }
  return { total, cleared }
}

const ratio = ({ total, cleared }: RateRow): number | null => (total ? cleared / total : null)

// 作品ごとの代表 = 成功・失敗が付いた記録のうち attempt_no 最大（同値なら created_at 最大）。
// 最新が予約済み・旧ステータスならその前の結果を使い、結果が 1 件も無い作品は含めない
const latestPerWork = (rows: readonly OwnAttemptRow[]): OwnAttemptRow[] => {
  const latest = new Map<string, OwnAttemptRow>()
  for (const r of rows) {
    if (!isResult(r)) continue
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

const countBy = (rows: readonly OwnAttemptRow[], s: OwnAttemptRow['status']) =>
  rows.filter((r) => r.status === s).length

// rows は来場型の記録
export const summarizeVisit = (rows: readonly OwnAttemptRow[]): VisitSummary => {
  const cleared = countBy(rows, 'cleared')
  const failed = countBy(rows, 'failed')
  return {
    records: rows.length,
    played: cleared + failed,
    cleared,
    failed,
    reserved: countBy(rows, 'purchased'),
    excluded: countBy(rows, 'in_progress') + countBy(rows, 'dropped'),
    rate: ratio(rateOf(rows)),
    rateByWork: ratio(rateOf(latestPerWork(rows))),
  }
}

// rows は完了型の記録
export const summarizeDone = (rows: readonly OwnAttemptRow[]): DoneSummary => ({
  records: rows.length,
  cleared: countBy(rows, 'cleared'),
  failed: countBy(rows, 'failed'),
  dropped: countBy(rows, 'dropped'),
  inProgress: countBy(rows, 'in_progress'),
  backlog: countBy(rows, 'purchased'),
})

export const byDifficulty = (rows: readonly OwnAttemptRow[]): (RateRow & { label: string })[] =>
  [1, 2, 3, 4, 5].map((n) => ({
    label: `★${n}`,
    ...rateOf(rows.filter((r) => r.difficulty === n)),
  }))

// genres に rows に無い記録が混じっていても無視する（上限で切った分・完了型の記録など）。
// labels は genre.id → 表示名（無い id は id のまま）
export const byGenre = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  labels: ReadonlyMap<string, string>,
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
      ...rateOf(list),
    }))
    .filter((g) => g.total >= 1)
    .sort(
      (a, b) =>
        b.cleared / b.total - a.cleared / a.total ||
        b.total - a.total ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    )
}

const visitKinds: readonly VisitKind[] = ['hall', 'room']

export const visitByKind = (rows: readonly OwnAttemptRow[]): (RateRow & { kind: VisitKind })[] =>
  visitKinds.map((kind) => ({ kind, ...rateOf(rows.filter((r) => r.work.kind === kind)) }))

// 完了型の形式の並び: workKinds 順、NULL（形式未設定）が最後
const doneKindOrder = (k: DoneKind): number =>
  k === null ? workKinds.length : workKinds.indexOf(k)

const sortDoneKinds = (kinds: Iterable<DoneKind>): DoneKind[] =>
  [...kinds].sort((a, b) => doneKindOrder(a) - doneKindOrder(b))

export const doneByKind = (
  rows: readonly OwnAttemptRow[],
): { kind: DoneKind; cleared: number }[] => {
  const counts = new Map<DoneKind, number>()
  for (const r of rows) {
    if (r.status !== 'cleared' || isVisitKind(r.work.kind)) continue
    const k = r.work.kind as DoneKind
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return sortDoneKinds(counts.keys()).map((kind) => ({ kind, cleared: counts.get(kind) ?? 0 }))
}

// 月は COALESCE(finished_on, started_on, created_at の JST 日付) の年月（1〜12）。year 外・日付が取れない行は null
const monthOf = (r: OwnAttemptRow, year: number): number | null => {
  const on = r.finishedOn ?? r.startedOn ?? isoToJstDate(r.createdAt)
  if (!on?.startsWith(`${year}-`)) return null
  const m = Number(on.slice(5, 7))
  return m >= 1 && m <= 12 ? m : null
}

const emptyMonths = () => Array.from({ length: 12 }, () => 0)

// 成功は成功の系列、失敗は失敗の系列に数える。それ以外のステータスは数えない
export const visitMonthly = (
  rows: readonly OwnAttemptRow[],
  year: number,
): MonthSeries<'cleared' | 'failed'> => {
  const series = { cleared: emptyMonths(), failed: emptyMonths() }
  for (const r of rows) {
    if (r.status !== 'cleared' && r.status !== 'failed') continue
    const m = monthOf(r, year)
    if (m !== null) series[r.status][m - 1]++
  }
  return [
    { key: 'cleared', counts: series.cleared },
    { key: 'failed', counts: series.failed },
  ]
}

// cleared だけを形式ごとに数える。その年に 0 件の形式は系列に出さない
export const doneMonthly = (
  rows: readonly OwnAttemptRow[],
  year: number,
): MonthSeries<DoneKind> => {
  const series = new Map<DoneKind, number[]>()
  for (const r of rows) {
    if (r.status !== 'cleared' || isVisitKind(r.work.kind)) continue
    const m = monthOf(r, year)
    if (m === null) continue
    const k = r.work.kind as DoneKind
    const counts = series.get(k) ?? emptyMonths()
    counts[m - 1]++
    series.set(k, counts)
  }
  return sortDoneKinds(series.keys()).map((key) => ({ key, counts: series.get(key) ?? [] }))
}

// 来場型を記録しない人が空の画面に着かないよう、来場型 0 件・完了型ありなら done
export const defaultView = (stats: Stats): 'visit' | 'done' =>
  stats.visit.summary.records === 0 && stats.done.summary.records > 0 ? 'done' : 'visit'

export const computeStats = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  genreLabels: ReadonlyMap<string, string>,
  { year }: StatsOptions,
): Stats => {
  const { visit, done } = splitByVisit(rows)
  return {
    visit: {
      summary: summarizeVisit(visit),
      byDifficulty: byDifficulty(visit),
      // visit 側の rows だけを渡すので、完了型の記録に付いたジャンルは落ちる
      byGenre: byGenre(visit, genres, genreLabels),
      byKind: visitByKind(visit),
      monthly: visitMonthly(visit, year),
    },
    done: {
      summary: summarizeDone(done),
      byKind: doneByKind(done),
      monthly: doneMonthly(done, year),
    },
  }
}
