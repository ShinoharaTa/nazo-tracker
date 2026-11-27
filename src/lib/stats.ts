// 本人の統計（/stats）の集計。純関数で DB を触らない。入力は own().statsRows() の結果（docs/data-model.md §6）。
// 来場型（公演・ルーム）は成功率 = cleared / (cleared + failed)。それ以外（完了型）は成功率を出さず cleared の件数を見る

import { workKinds } from '../db/schema'
import type { OwnAttemptRow } from '../db/scoped'
import { isVisitKind } from '../ui/labels'
import { splitCompanions } from './companions'
import { isoToJstDate } from './time'

type Kind = OwnAttemptRow['work']['kind']

// today は今日の日付（JST、YYYY-MM-DD）。積み謎の経過日数に使う
export type StatsOptions = { year: number; today: string }

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

// 積み謎の 1 行。days は today − purchased_on の日数（purchased_on が無い・解釈できないなら null）
export type BacklogRow = {
  attemptId: string
  title: string
  purchasedOn: string | null
  days: number | null
}

// 平均は値がある行だけ。1 件も無ければ null
export type DoneAverageRow = {
  kind: DoneKind
  difficulty: number | null
  volume: number | null
}

// 件数の 1 行（ふりかえりの棒）
export type CountRow = { label: string; count: number }

// ふりかえり（?view=all）の KPI。played = 来場型の cleared + failed と完了型の cleared
export type LookbackSummary = {
  played: number
  // sessionDurationSec ?? durationSec の合計（値がある記録だけ）と、その記録数
  durationSec: number
  timedRecords: number
  // attempt_no >= 2 の記録数（全ステータス）
  retries: number
}

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
    // purchased のみ。purchased_on ASC（NULL は最後）、同じ日は created_at ASC、上位 10
    backlogOldest: BacklogRow[]
    // cleared ≥ 1 の形式だけ、byKind と同じ順
    averages: DoneAverageRow[]
  }
  // 来場型・完了型の両方
  all: {
    summary: LookbackSummary
    // 遊んだ数が 1 件以上の年だけ、新しい年が上
    byYear: { year: number; count: number }[]
    // 評価 1〜5 の 5 行固定（rating NULL は除外。全ステータス）
    byRating: CountRow[]
    // run.venue.prefecture がある記録だけ。件数 DESC, 名前 ASC、上位 10
    byPrefecture: CountRow[]
    // 都道府県が分かる記録の数（上位 10 で切る前）
    prefectureRecords: number
    // 同行者（splitCompanions で分割）ごとの記録数（全ステータス）。並びは byPrefecture と同じ、上位 10
    companions: CountRow[]
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

const backlogLimit = 10

const dayMs = 86_400_000

// YYYY-MM-DD どうしの日数差（to − from）。解釈できなければ null
const daysBetween = (from: string, to: string): number | null => {
  const d = (Date.parse(to) - Date.parse(from)) / dayMs
  return Number.isNaN(d) ? null : Math.round(d)
}

// rows は完了型の記録（来場型の purchased = 予約済みは呼び出し側で除く）。today は JST の今日
export const backlogOldest = (rows: readonly OwnAttemptRow[], today: string): BacklogRow[] =>
  rows
    .filter((r) => r.status === 'purchased' && !isVisitKind(r.work.kind))
    .sort((a, b) => {
      if (a.purchasedOn !== b.purchasedOn) {
        if (a.purchasedOn === null) return 1
        if (b.purchasedOn === null) return -1
        return a.purchasedOn < b.purchasedOn ? -1 : 1
      }
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    })
    .slice(0, backlogLimit)
    .map((r) => ({
      attemptId: r.id,
      title: r.work.title,
      purchasedOn: r.purchasedOn,
      days: r.purchasedOn === null ? null : daysBetween(r.purchasedOn, today),
    }))

const avgOf = (xs: readonly (number | null)[]): number | null => {
  const vs = xs.filter((x): x is number => x !== null)
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
}

// cleared の記録を形式ごとに。平均難易度・平均物量は値がある行だけ
export const doneAverages = (rows: readonly OwnAttemptRow[]): DoneAverageRow[] => {
  const grouped = new Map<DoneKind, OwnAttemptRow[]>()
  for (const r of rows) {
    if (r.status !== 'cleared' || isVisitKind(r.work.kind)) continue
    const k = r.work.kind as DoneKind
    const list = grouped.get(k) ?? []
    list.push(r)
    grouped.set(k, list)
  }
  return sortDoneKinds(grouped.keys()).map((kind) => {
    const list = grouped.get(kind) ?? []
    return {
      kind,
      difficulty: avgOf(list.map((r) => r.difficulty)),
      volume: avgOf(list.map((r) => r.volume)),
    }
  })
}

// 月別・年別の基準日 = COALESCE(finished_on, started_on, created_at の JST 日付)
const baseDateOf = (r: OwnAttemptRow): string | null =>
  r.finishedOn ?? r.startedOn ?? isoToJstDate(r.createdAt)

// 基準日の年月（1〜12）。year 外・日付が取れない行は null
const monthOf = (r: OwnAttemptRow, year: number): number | null => {
  const on = baseDateOf(r)
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

// 遊んだ = 来場型の cleared / failed、完了型の cleared
const isPlayed = (r: OwnAttemptRow): boolean =>
  r.status === 'cleared' || (r.status === 'failed' && isVisitKind(r.work.kind))

// rows は来場型・完了型の両方
export const summarizeLookback = (rows: readonly OwnAttemptRow[]): LookbackSummary => {
  let durationSec = 0
  let timedRecords = 0
  for (const r of rows) {
    // 進行ログがあればその合計を優先する
    const sec = r.sessionDurationSec ?? r.durationSec
    if (sec === null) continue
    durationSec += sec
    timedRecords++
  }
  return {
    played: rows.filter(isPlayed).length,
    durationSec,
    timedRecords,
    retries: rows.filter((r) => r.attemptNo >= 2).length,
  }
}

// 遊んだ記録を基準日の年ごとに。基準日が取れない行は数えない
export const playedByYear = (rows: readonly OwnAttemptRow[]): { year: number; count: number }[] => {
  const counts = new Map<number, number>()
  for (const r of rows) {
    if (!isPlayed(r)) continue
    const on = baseDateOf(r)
    if (!on || !/^\d{4}-/.test(on)) continue
    const y = Number(on.slice(0, 4))
    counts.set(y, (counts.get(y) ?? 0) + 1)
  }
  return [...counts].map(([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year)
}

export const byRating = (rows: readonly OwnAttemptRow[]): CountRow[] =>
  [1, 2, 3, 4, 5].map((n) => ({
    label: `★${n}`,
    count: rows.filter((r) => r.rating === n).length,
  }))

// 件数 DESC, ラベル ASC、上位 groupLimit
const topCounts = (counts: ReadonlyMap<string, number>): CountRow[] =>
  [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || byLabel(a, b))
    .slice(0, groupLimit)

export const byPrefecture = (
  rows: readonly OwnAttemptRow[],
): { rows: CountRow[]; records: number } => {
  const counts = new Map<string, number>()
  let records = 0
  for (const r of rows) {
    const pref = r.run?.venue?.prefecture
    if (!pref) continue
    records++
    counts.set(pref, (counts.get(pref) ?? 0) + 1)
  }
  return { rows: topCounts(counts), records }
}

export const companionCounts = (rows: readonly OwnAttemptRow[]): CountRow[] => {
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const name of splitCompanions(r.companions)) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return topCounts(counts)
}

// マイリストのいちばん古い登録（created_at、ISO）から today（JST）までの日数。無ければ null
export const wishlistOldestDays = (
  oldestCreatedAt: string | null,
  today: string,
): number | null => {
  if (oldestCreatedAt === null) return null
  const on = isoToJstDate(oldestCreatedAt)
  return on === null ? null : daysBetween(on, today)
}

// 来場型を記録しない人が空の画面に着かないよう、来場型 0 件・完了型ありなら done
export const defaultView = (stats: Stats): 'visit' | 'done' =>
  stats.visit.summary.records === 0 && stats.done.summary.records > 0 ? 'done' : 'visit'

export const computeStats = (
  rows: readonly OwnAttemptRow[],
  genres: readonly { attemptId: string; genreId: string }[],
  genreLabels: ReadonlyMap<string, string>,
  { year, today }: StatsOptions,
): Stats => {
  const { visit, done } = splitByVisit(rows)
  const prefecture = byPrefecture(rows)
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
      backlogOldest: backlogOldest(done, today),
      averages: doneAverages(done),
    },
    all: {
      summary: summarizeLookback(rows),
      byYear: playedByYear(rows),
      byRating: byRating(rows),
      byPrefecture: prefecture.rows,
      prefectureRecords: prefecture.records,
      companions: companionCounts(rows),
    },
  }
}
