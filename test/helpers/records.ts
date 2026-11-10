// テスト補助。記録系の行を D1 に直接 INSERT する。id は ulid()。ユーザーは loginAs で作る

import { ulid } from '../../src/lib/id'

type Env = Cloudflare.Env

// created_at は呼ぶたびに 1 ms ずつ進める（一覧の並びを決めるため）
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const nextIso = () => {
  clock += 1
  return new Date(clock).toISOString()
}

const insert = async (env: Env, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
    .bind(...cols.map((c) => row[c] ?? null))
    .run()
}

export const insertAttempt = async (
  env: Env,
  a: {
    userId: string
    workId: string
    status: string
    attemptNo?: number
    runId?: string
    purchasedOn?: string
    startedOn?: string
    finishedOn?: string
    durationSec?: number
    partySize?: number
    companions?: string
    rating?: number
    difficulty?: number
    volume?: number
    memo?: string
    spoilerMemo?: string
  },
): Promise<string> => {
  const id = ulid()
  const now = nextIso()
  await insert(env, 'attempt', {
    id,
    user_id: a.userId,
    work_id: a.workId,
    run_id: a.runId,
    status: a.status,
    attempt_no: a.attemptNo ?? 1,
    purchased_on: a.purchasedOn,
    started_on: a.startedOn,
    finished_on: a.finishedOn,
    duration_sec: a.durationSec,
    party_size: a.partySize,
    companions: a.companions,
    rating: a.rating,
    difficulty: a.difficulty,
    volume: a.volume,
    memo: a.memo,
    spoiler_memo: a.spoilerMemo,
    created_at: now,
    updated_at: now,
  })
  return id
}

export const insertSession = async (
  env: Env,
  s: {
    attemptId: string
    userId: string
    playedOn: string
    durationSec?: number
    progressNote?: string
    memo?: string
  },
): Promise<string> => {
  const id = ulid()
  await insert(env, 'session', {
    id,
    attempt_id: s.attemptId,
    user_id: s.userId,
    played_on: s.playedOn,
    duration_sec: s.durationSec,
    progress_note: s.progressNote,
    memo: s.memo,
    created_at: nextIso(),
  })
  return id
}

export const insertGenre = (env: Env, attemptId: string, userId: string, genreId: string) =>
  insert(env, 'attempt_genre', { attempt_id: attemptId, genre_id: genreId, user_id: userId })

// createdAt を渡すとその値で入れる（並び・日付表示のテスト用）
export const insertWish = (env: Env, userId: string, workId: string, createdAt?: string) =>
  insert(env, 'wishlist', { user_id: userId, work_id: workId, created_at: createdAt ?? nextIso() })

// image の最小行（R2 には置かない。r2_key はダミー）
export const insertImage = async (env: Env, attemptId: string, userId: string): Promise<string> => {
  const id = ulid()
  await insert(env, 'image', {
    id,
    user_id: userId,
    attempt_id: attemptId,
    kind: 'other',
    r2_key: `test/${id}`,
    bytes: 1,
    content_type: 'image/webp',
    created_at: nextIso(),
  })
  return id
}
