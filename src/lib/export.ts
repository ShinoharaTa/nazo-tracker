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

// wishlist は part 1 のときだけ渡す（null ならキーを出さない）
export const buildExportJson = (input: {
  exportedAt: string
  part: number
  parts: number
  spoiler: boolean
  attempts: OwnExportAttempt[]
  wishlist: OwnExportWish[] | null
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
          wishlist: input.wishlist.map((w) => ({
            work: workJson(w.work),
            memo: w.memo,
            created_at: w.createdAt,
          })),
        }
      : {}),
  })
