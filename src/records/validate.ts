// 記録フォームの入力の検証（部品は src/lib/form.ts）。work_id の存在・未統合はルートで getWork を使って確かめる。

import { attemptStatuses } from '../db/schema'
import {
  type AttemptPatch,
  type SessionInput,
  type SessionOutcome,
  sessionOutcomes,
} from '../db/scoped'
import { date, done, type Form, field, int, oneOf, str } from '../lib/form'
import { type AttemptStatus, isVisitKind, statusesFor, type WorkKind } from '../ui/labels'

// q は検索語（400 で再描画したときの戻り先に引き継ぐだけ。保存しない）
export const newRecordFields = ['work_id', 'status', 'on', 'q'] as const

export type NewRecordInput = { status: AttemptStatus; on: string | null }

// 作品の形式 kind と、記録の今のステータス current（新規は無し）
export type StatusContext = { kind: WorkKind | null; current?: AttemptStatus }

// status は必須。作品の形式で選べないステータス（statusesFor に無いもの）は、今の値のままでなければ不可
const statusOf = (
  errors: string[],
  raw: string,
  { kind, current }: StatusContext,
): AttemptStatus => {
  if (raw === '') errors.push('ステータスを選んでください。')
  const status = field(errors, 'ステータス', raw, oneOf(attemptStatuses))
  if (status && status !== current && !statusesFor(kind).includes(status)) {
    errors.push(
      isVisitKind(kind)
        ? 'ルーム・公演では選べないステータスです。'
        : '持ち帰りでは選べないステータスです。',
    )
  }
  return status ?? attemptStatuses[0]
}

// 軽い記録（POST /records）。on は空なら NULL
export const parseNewRecord = (f: Form, ctx: StatusContext) => {
  const errors: string[] = []
  const status = statusOf(errors, f.status, ctx)
  const on = field(errors, '日付', f.on, date())
  return done<NewRecordInput>(errors, { status, on })
}

export const statusFields = ['status', 'on'] as const

// ステータス変更（POST /records/:id/status）。日付の書き先は own().setStatus が決める
export const parseStatus = (f: Form, ctx: StatusContext) => {
  const errors: string[] = []
  const status = statusOf(errors, f.status, ctx)
  const on = field(errors, '日付', f.on, date())
  return done<NewRecordInput>(errors, { status, on })
}

export const editRecordFields = [
  'status',
  'run_id',
  'purchased_on',
  'started_on',
  'finished_on',
  'duration_min',
  'party_size',
  'companions',
  'rating',
  'difficulty',
  'volume',
  'memo',
] as const

// 詳しい編集（POST /records/:id/edit）。runIds はその作品の run の id、genreIds は選べるジャンルの id。
// genre は同名 checkbox の値（重複は除く）
export const parseEditRecord = (
  f: Form,
  genre: readonly string[],
  {
    runIds,
    genreIds,
    ...ctx
  }: { runIds: readonly string[]; genreIds: readonly string[] } & StatusContext,
) => {
  const errors: string[] = []
  const status = statusOf(errors, f.status, ctx)
  let runId: string | null = null
  if (f.run_id !== '') {
    if (runIds.includes(f.run_id)) runId = f.run_id
    else errors.push('回の値が正しくありません。')
  }
  const purchasedOn = field(errors, '買った日', f.purchased_on, date())
  const startedOn = field(errors, '開始日', f.started_on, date())
  const finishedOn = field(errors, '終了日', f.finished_on, date())
  if (startedOn && finishedOn && startedOn > finishedOn) {
    errors.push('終了日は開始日以降にしてください。')
  }
  const durationMin = field(errors, '所要（分）', f.duration_min, int(1, 6000))
  const partySize = field(errors, '人数', f.party_size, int(1, 99))
  const companions = field(errors, '同行者', f.companions, str(200))
  const rating = field(errors, '評価', f.rating, int(1, 5))
  const difficulty = field(errors, '難易度', f.difficulty, int(1, 5))
  const volume = field(errors, '物量', f.volume, int(1, 5))
  const memo = field(errors, 'メモ', f.memo, str(4000, { multiline: true }))
  const genres = [...new Set(genre.map((g) => g.trim()).filter(Boolean))]
  if (genres.some((g) => !genreIds.includes(g))) errors.push('ジャンルの値が正しくありません。')
  return done<{ patch: AttemptPatch; genreIds: string[] }>(errors, {
    patch: {
      status,
      runId,
      purchasedOn,
      startedOn,
      finishedOn,
      durationSec: durationMin === null ? null : durationMin * 60,
      partySize,
      companions,
      rating,
      difficulty,
      volume,
      memo,
    },
    genreIds: genres,
  })
}

export const spoilerFields = ['spoiler_memo'] as const

// ネタバレメモ（POST /records/:id/spoiler/edit）。空は NULL
export const parseSpoiler = (f: Form) => {
  const errors: string[] = []
  const memo = field(errors, 'ネタバレメモ', f.spoiler_memo, str(4000, { multiline: true }))
  return done<string | null>(errors, memo)
}

export const sessionFields = [
  'played_on',
  'duration_min',
  'progress_note',
  'location_text',
  'companions',
  'memo',
  'outcome',
] as const

// 進行ログの追加（POST /records/:id/sessions）。played_on と outcome は必須
export const parseSession = (f: Form) => {
  const errors: string[] = []
  const playedOn = field(errors, '日付', f.played_on, date(), true)
  const durationMin = field(errors, '所要（分）', f.duration_min, int(1, 6000))
  const progressNote = field(errors, '進み具合', f.progress_note, str(200))
  const locationText = field(errors, '場所', f.location_text, str(200))
  const companions = field(errors, '同行者', f.companions, str(200))
  const memo = field(errors, 'メモ', f.memo, str(4000, { multiline: true }))
  if (f.outcome === '') errors.push('結果を選んでください。')
  const outcome = field(errors, '結果', f.outcome, oneOf(sessionOutcomes)) ?? 'keep'
  return done<{ session: SessionInput; outcome: SessionOutcome }>(errors, {
    session: {
      playedOn: playedOn ?? '',
      durationSec: durationMin === null ? null : durationMin * 60,
      progressNote,
      locationText,
      companions,
      memo,
    },
    outcome,
  })
}
