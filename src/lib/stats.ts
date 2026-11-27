// 本人の統計（/stats）の集計。純関数で DB を触らない。入力は own().statsRows() の結果（docs/data-model.md §6）。
// 来場型（公演・ルーム）は成功率 = cleared / (cleared + failed)。それ以外（完了型）は成功率を出さず cleared の件数を見る

import { workKinds } from '../db/schema'
import type { OwnAttemptRow } from '../db/scoped'
import { isVisitKind } from '../ui/labels'
import { splitCompanions } from './companions'
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
  // attempt_no >= 2 の cleared + failed
  retries: number
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

export type GenreRateRow = RateRow & { genreId: string; label: string; best: boolean }

// rating は分母に入った記録（成功・失敗）のうち rating がある行の平均。1 件も無ければ null
export type OrgRateRow = RateRow & { orgId: string; label: string; rating: number | null }

// 月別の系列。counts は 1〜12 月の 12 要素
export type MonthSeries<K> = { key: K; counts: number[] }[]

export type Stats = {
  visit: {
    summary: VisitSummary
    // 難易度 1〜5 の 5 行固定（difficulty NULL は除外）
    byDifficulty: (RateRow & { label: string })[]
    // total ≥ 1 のみ。成功率 DESC, total DESC, ラベル ASC。
    // best は total ≥ 5 の行のうち成功率が最高の 1 行（同率は並びの先頭）だけ、その成功率が 50% 以上のとき true
    byGenre: GenreRateRow[]
    // 物量 1〜5 の 5 行固定（volume NULL は除外）
    byVolume: (RateRow & { label: string })[]
    // work.org ごと。total ≥ 3 のみ、成功率 DESC, total DESC, 名前 ASC、上位 10
    byOrg: OrgRateRow[]
    // 同行者（splitCompanions で分割）ごと。total ≥ 3 のみ、並びは byOrg と同じ、上位 10
    byCompanion: (RateRow & { label: string })[]
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
    retries: rows.filter((r) => isResult(r) && r.attemptNo >= 2).length,
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

export const byVolume = (rows: readonly OwnAttemptRow[]): (RateRow & { label: string })[] =>
  [1, 2, 3, 4, 5].map((n) => ({
    label: `量 ${n}`,
    ...rateOf(rows.filter((r) => r.volume === n)),
  }))

const byLabel = (a: { label: string }, b: { label: string }) =>
  a.label < b.label ? -1 : a.label > b.label ? 1 : 0

// 成功率 DESC, total DESC, ラベル ASC（total ≥ 1 の行だけを渡す）
const byRate = <T extends RateRow & { label: string }>(a: T, b: T): number =>
  b.cleared / b.total - a.cleared / a.total || b.total - a.total || byLabel(a, b)

// 得意の母数と、得意と言える成功率の下限（docs/visual-design.md §4.5。仮の値）
const bestMinTotal = 5
const bestMinRate = 0.5
// 団体別・同行者別に出す母数と行数
const groupMinTotal = 3
const groupLimit = 10

// genres に rows に無い記録が混じっていても無視する（上限で切った分・完了型の記録など）。
// labels は genre.id → 表示名（無い id は id のまま）
export const byGenre = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  labels: ReadonlyMap<string, string>,
): GenreRateRow[] => {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const grouped = new Map<string, OwnAttemptRow[]>()
  for (const g of genres) {
    const r = byId.get(g.attemptId)
    if (!r) continue
    const list = grouped.get(g.genreId) ?? []
    list.push(r)
    grouped.set(g.genreId, list)
  }
  const sorted = [...grouped]
    .map(([genreId, list]) => ({
      genreId,
      label: labels.get(genreId) ?? genreId,
      ...rateOf(list),
    }))
    .filter((g) => g.total >= 1)
    .sort(byRate)
  // sorted は成功率の降順なので、total ≥ 5 の最初の行がその中の最高
  const top = sorted.findIndex((g) => g.total >= bestMinTotal)
  const best = top >= 0 && sorted[top].cleared / sorted[top].total >= bestMinRate ? top : -1
  return sorted.map((g, i) => ({ ...g, best: i === best }))
}

// 団体は id でまとめる（名前は最初に出た行のもの）。団体が無い作品の記録は数えない
export const byOrg = (rows: readonly OwnAttemptRow[]): OrgRateRow[] => {
  const grouped = new Map<string, { label: string; rows: OwnAttemptRow[] }>()
  for (const r of rows) {
    const org = r.work.org
    if (!org) continue
    const g = grouped.get(org.id) ?? { label: org.name, rows: [] }
    g.rows.push(r)
    grouped.set(org.id, g)
  }
  return [...grouped]
    .map(([orgId, g]) => {
      const rated = g.rows.filter(isResult).flatMap((r) => (r.rating === null ? [] : [r.rating]))
      return {
        orgId,
        label: g.label,
        ...rateOf(g.rows),
        rating: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null,
      }
    })
    .filter((g) => g.total >= groupMinTotal)
    .sort(byRate)
    .slice(0, groupLimit)
}

export const byCompanion = (rows: readonly OwnAttemptRow[]): (RateRow & { label: string })[] => {
  const grouped = new Map<string, OwnAttemptRow[]>()
  for (const r of rows) {
    for (const name of splitCompanions(r.companions)) {
      const list = grouped.get(name) ?? []
      list.push(r)
      grouped.set(name, list)
    }
  }
  return [...grouped]
    .map(([label, list]) => ({ label, ...rateOf(list) }))
    .filter((g) => g.total >= groupMinTotal)
    .sort(byRate)
    .slice(0, groupLimit)
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
      byVolume: byVolume(visit),
      byOrg: byOrg(visit),
      byCompanion: byCompanion(visit),
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
