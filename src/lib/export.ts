// 自分のデータのエクスポート（docs/data-model.md §7）の組み立て。純関数。
// ネタバレメモを含み得るので UI 部品には渡さず、ここで直列化して応答にする

import type { OwnExportAttempt, OwnExportWish } from '../db/scoped'

// 記録 0 件でも part 1 は空のファイルとして出す
export const partsOf = (attempts: number, perPart: number): number =>
  Math.max(1, Math.ceil(attempts / perPart))

// 1 始まりの整数で parts 以下なら番号、それ以外は null（呼び出し側が 404 にする）
export const parsePart = (raw: string | undefined, parts: number): number | null => {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return null
  const n = Number(raw)
  return n <= parts ? n : null
}

// nazo-<種類>-<YYYYMMDD(JST)>-p<N>.<ext>。todayJst は YYYY-MM-DD
export const exportFilename = (kind: string, todayJst: string, part: number, ext: string) =>
  `nazo-${kind}-${todayJst.replaceAll('-', '')}-p${part}.${ext}`

const workJson = (w: OwnExportAttempt['work']) => ({
  id: w.id,
  title: w.title,
  kind: w.kind,
  organization: w.org?.name ?? null,
})

const attemptJson = (a: OwnExportAttempt) => ({
  id: a.id,
  work: workJson(a.work),
  run_id: a.runId,
  venue: a.venue ? { name: a.venue.name, prefecture: a.venue.prefecture } : null,
  status: a.status,
  attempt_no: a.attemptNo,
  purchased_on: a.purchasedOn,
  started_on: a.startedOn,
  finished_on: a.finishedOn,
  duration_sec: a.durationSec,
  party_size: a.partySize,
  companions: a.companions,
  rating: a.rating,
  difficulty: a.difficulty,
  volume: a.volume,
  genres: a.genres,
  memo: a.memo,
  // キーごと出さない（spoiler: false のとき null のキーも残さない）
  ...('spoilerMemo' in a ? { spoiler_memo: a.spoilerMemo ?? null } : {}),
  source_ref: a.sourceRef,
  created_at: a.createdAt,
  updated_at: a.updatedAt,
  sessions: a.sessions.map((s) => ({
    id: s.id,
    played_on: s.playedOn,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    duration_sec: s.durationSec,
    progress_note: s.progressNote,
    companions: s.companions,
    memo: s.memo,
    location_text: s.locationText,
    created_at: s.createdAt,
  })),
})

// wishlist は part 1 のときだけ渡す（null なら wishlist / wishlist_truncated のキーを出さない）。
// truncated は EXPORT_WISHLIST_LIMIT で切れたとき true
export const buildExportJson = (input: {
  exportedAt: string
  part: number
  parts: number
  spoiler: boolean
  attempts: OwnExportAttempt[]
  wishlist: { items: OwnExportWish[]; truncated: boolean } | null
}): string =>
  JSON.stringify({
    version: 1,
    exported_at: input.exportedAt,
    part: input.part,
    parts: input.parts,
    includes_spoiler: input.spoiler,
    attempts: input.attempts.map(attemptJson),
    ...(input.wishlist
      ? {
          wishlist: input.wishlist.items.map((w) => ({
            work: workJson(w.work),
            memo: w.memo,
            created_at: w.createdAt,
          })),
          wishlist_truncated: input.wishlist.truncated,
        }
      : {}),
  })

// CSV の列。text は表計算ソフトの数式実行対策をする列（数値・日付・id・列挙値は付けない）
type CsvColumn<T> = { name: string; text?: boolean; value: (row: T) => string | number | null }

// = + - @（全角の ＝ ＋ － ＠ も）・タブ・CR・LF で始まる文字列は数式として実行され得るので、先頭に ' を足す
const FORMULA_START = /^[=+\-@＝＋－＠\t\r\n]/

// RFC 4180: , " CR LF を含むセルは " で囲み、中の " は "" にする。null は空セル
const csvCell = (value: string | number | null, text: boolean): string => {
  if (value === null) return ''
  let s = String(value)
  if (text && FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

// UTF-8 の BOM 付き、行末は CRLF（最終行にも付ける）
export const toCsv = <T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string => {
  const lines = [
    columns.map((c) => csvCell(c.name, false)).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(c.value(r), c.text === true)).join(',')),
  ]
  return `﻿${lines.map((l) => `${l}\r\n`).join('')}`
}

const workColumns = <T>(work: (row: T) => OwnExportAttempt['work']): CsvColumn<T>[] => [
  { name: 'work_id', value: (r) => work(r).id },
  { name: 'work_title', text: true, value: (r) => work(r).title },
  { name: 'work_kind', value: (r) => work(r).kind },
  { name: 'org_name', text: true, value: (r) => work(r).org?.name ?? null },
]

// 記録。spoiler: true のときだけ spoiler_memo 列を出す。genres は ' | ' 区切り
export const attemptsCsv = (attempts: OwnExportAttempt[], spoiler: boolean): string => {
  const spoilerColumn: CsvColumn<OwnExportAttempt>[] = spoiler
    ? [{ name: 'spoiler_memo', text: true, value: (a) => a.spoilerMemo ?? null }]
    : []
  const columns: CsvColumn<OwnExportAttempt>[] = [
    { name: 'id', value: (a) => a.id },
    ...workColumns<OwnExportAttempt>((a) => a.work),
    { name: 'run_id', value: (a) => a.runId },
    { name: 'venue_name', text: true, value: (a) => a.venue?.name ?? null },
    { name: 'venue_prefecture', text: true, value: (a) => a.venue?.prefecture ?? null },
    { name: 'status', value: (a) => a.status },
    { name: 'attempt_no', value: (a) => a.attemptNo },
    { name: 'purchased_on', value: (a) => a.purchasedOn },
    { name: 'started_on', value: (a) => a.startedOn },
    { name: 'finished_on', value: (a) => a.finishedOn },
    { name: 'duration_sec', value: (a) => a.durationSec },
    { name: 'party_size', value: (a) => a.partySize },
    { name: 'companions', text: true, value: (a) => a.companions },
    { name: 'rating', value: (a) => a.rating },
    { name: 'difficulty', value: (a) => a.difficulty },
    { name: 'volume', value: (a) => a.volume },
    { name: 'genres', text: true, value: (a) => a.genres.join(' | ') },
    { name: 'memo', text: true, value: (a) => a.memo },
    ...spoilerColumn,
    { name: 'source_ref', text: true, value: (a) => a.sourceRef },
    { name: 'created_at', value: (a) => a.createdAt },
    { name: 'updated_at', value: (a) => a.updatedAt },
  ]
  return toCsv(columns, attempts)
}

type SessionCsvRow = OwnExportAttempt['sessions'][number] & { attemptId: string }

const sessionColumns: CsvColumn<SessionCsvRow>[] = [
  { name: 'id', value: (s) => s.id },
  { name: 'attempt_id', value: (s) => s.attemptId },
  { name: 'played_on', value: (s) => s.playedOn },
  { name: 'started_at', value: (s) => s.startedAt },
  { name: 'ended_at', value: (s) => s.endedAt },
  { name: 'duration_sec', value: (s) => s.durationSec },
  { name: 'progress_note', text: true, value: (s) => s.progressNote },
  { name: 'companions', text: true, value: (s) => s.companions },
  { name: 'memo', text: true, value: (s) => s.memo },
  { name: 'location_text', text: true, value: (s) => s.locationText },
  { name: 'created_at', value: (s) => s.createdAt },
]

// part の記録に属する進行ログ。並びは記録の順（attempt.id ASC）→ 記録の中は played_on ASC
export const sessionsCsv = (attempts: OwnExportAttempt[]): string =>
  toCsv(
    sessionColumns,
    attempts.flatMap((a) => a.sessions.map((s) => ({ ...s, attemptId: a.id }))),
  )

const wishColumns: CsvColumn<OwnExportWish>[] = [
  ...workColumns<OwnExportWish>((w) => w.work),
  { name: 'memo', text: true, value: (w) => w.memo },
  { name: 'created_at', value: (w) => w.createdAt },
]

export const wishlistCsv = (items: OwnExportWish[]): string => toCsv(wishColumns, items)
