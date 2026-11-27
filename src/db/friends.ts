// フレンド関係（friend_request / friendship / block / user.friend_code）の読み書き。
// 記録系ではないので scopedTo の外に置くが、全関数が第 2 引数に viewerId を取り、WHERE に必ず入れる。
// 記録の射影（フレンドの記録を読むこと）は src/db/scoped.ts の asFriendOf だけが行う。
// 退会済み（deleted_at あり）の行は書き換えない（退会でセッションは消えるので保険）。

import { and, eq, isNull, type SQL, sql } from 'drizzle-orm'
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core'
import { ulid } from '../lib/id'
import { FRIEND_CODE_LENGTH, randomCode } from '../lib/random'
import { addDays, nowIso } from '../lib/time'
import type { Db } from './client'
import { user } from './schema'

const self = (viewerId: string) => and(eq(user.id, viewerId), isNull(user.deletedAt))

const isUniqueViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes('UNIQUE constraint failed')

const writeCode = (db: Db, viewerId: string, code: string) =>
  db.update(user).set({ friendCode: code }).where(self(viewerId))

// 招待コードを新しく作る（作り直しも同じ。古いコードはその場で使えなくなる）。
// 80 bit なので衝突はまず起きないが、UNIQUE 違反なら 1 回だけ作り直す
export const setFriendCode = async (db: Db, viewerId: string): Promise<string> => {
  const code = randomCode(FRIEND_CODE_LENGTH)
  try {
    await writeCode(db, viewerId, code)
    return code
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
  }
  const retry = randomCode(FRIEND_CODE_LENGTH)
  await writeCode(db, viewerId, retry)
  return retry
}

// 招待を止める（friend_code = NULL）。届いている申請・フレンドはそのまま
export const clearFriendCode = async (db: Db, viewerId: string): Promise<void> => {
  await db.update(user).set({ friendCode: null }).where(self(viewerId))
}

// 申請の上限（docs/design.md §6.2）
// 1 人が直近 24 時間に送れる件数（取り消し・断られた分も数える）
export const REQUEST_DAILY_LIMIT = 20
// 同じ相手へ同じ向きに送れる間隔（状態を問わず、直近この日数に行があれば送れない）
export const REQUEST_RETRY_DAYS = 7
// pending の期限。過ぎた行は一覧・判定から外し、書き込みのついでに canceled へ
export const REQUEST_EXPIRE_DAYS = 30
// 受ける側に溜まっている有効な pending の上限
export const INCOMING_PENDING_LIMIT = 50

// 招待リンクを開いた人から見た招待者の状態（画面 /f/:code）。
// not_found は「コードが無い・退会済み・どちらかがブロック中」をまとめたもの（区別して返さない）
export type InviterState =
  | { kind: 'not_found' }
  | { kind: 'self' }
  | { kind: 'friends'; userId: string }
  // 相手からの pending（30 日以内）が届いている。outgoing より先に判定する
  // （自分の申請が断られて残っていても、届いた申請をリンクから承認できるように）
  | { kind: 'incoming'; userId: string; displayName: string; requestId: string }
  // 自分の申請が pending / declined で 30 日以内（断られたことは「申請中」と同じに見せる）
  | { kind: 'outgoing'; userId: string; displayName: string }
  | { kind: 'can_request'; userId: string; displayName: string }

// drizzle の batch は引数付きの生 SQL（db.run(sql`…`)）を受けられないので、条件付き INSERT を含む batch は
// D1 の batch を直接使う。sql`…` を D1 の文に変換する
const dialect = new SQLiteAsyncDialect()
const stmt = (db: Db, q: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(q)
  return db.$client.prepare(text).bind(...params)
}

// viewer と相手のどちらの向きにも block が無い（SQL の断片。u は相手の user 行の別名）
const noBlock = (viewerId: string) => sql`NOT EXISTS (
  SELECT 1 FROM block b
  WHERE (b.user_id = ${viewerId} AND b.blocked_user_id = u.id)
     OR (b.user_id = u.id AND b.blocked_user_id = ${viewerId}))`

const isFriend = (viewerId: string) => sql`EXISTS (
  SELECT 1 FROM friendship f
  WHERE (f.user_lo = ${viewerId} AND f.user_hi = u.id)
     OR (f.user_lo = u.id AND f.user_hi = ${viewerId}))`

// 期限切れの pending を canceled にする（viewer が送った・受けた行だけ）。
// pending の UNIQUE(from, to) に期限切れの行が残ると次の申請が入らないので、申請の INSERT より先に流す
const expirePending = (viewerId: string, now: string) =>
  sql`UPDATE friend_request SET status = 'canceled', responded_at = ${now}
    WHERE status = 'pending' AND created_at <= ${addDays(now, -REQUEST_EXPIRE_DAYS)}
      AND (from_user_id = ${viewerId} OR to_user_id = ${viewerId})`

export const findInviter = async (
  db: Db,
  viewerId: string,
  code: string,
): Promise<InviterState> => {
  const expire = addDays(nowIso(), -REQUEST_EXPIRE_DAYS)
  const row = await db.get<{
    id: string
    display_name: string
    blocked: number
    friends: number
    outgoing: number
    incoming_id: string | null
  }>(sql`SELECT u.id, u.display_name,
      NOT ${noBlock(viewerId)} AS blocked,
      ${isFriend(viewerId)} AS friends,
      EXISTS (SELECT 1 FROM friend_request r
        WHERE r.from_user_id = ${viewerId} AND r.to_user_id = u.id
          AND r.status IN ('pending', 'declined') AND r.created_at > ${expire}) AS outgoing,
      (SELECT r.id FROM friend_request r
        WHERE r.from_user_id = u.id AND r.to_user_id = ${viewerId}
          AND r.status = 'pending' AND r.created_at > ${expire}) AS incoming_id
    FROM user u
    WHERE u.friend_code = ${code} AND u.deleted_at IS NULL`)
  if (!row || row.blocked) return { kind: 'not_found' }
  if (row.id === viewerId) return { kind: 'self' }
  if (row.friends) return { kind: 'friends', userId: row.id }
  const who = { userId: row.id, displayName: row.display_name }
  if (row.incoming_id) return { kind: 'incoming', ...who, requestId: row.incoming_id }
  if (row.outgoing) return { kind: 'outgoing', ...who }
  return { kind: 'can_request', ...who }
}

export type SendResult = { ok: true } | { ok: false; reason: 'receiver_full' | 'unknown' }

// 申請を送る。条件は全部 1 文の INSERT ... SELECT ... WHERE に入れ、入った行数で成否を決める
// （同時に押されても判定と INSERT の間に割り込まれない）。
// 相手から自分への有効な pending があるときも入れない（両方向の pending を作らない）。
// 0 行なら状態を引き直し、相手からの申請が届いていれば承認として扱う（同時に申請し合った場合）。
// それ以外で特定できる理由は受け側の上限だけで、残りは unknown
export const sendRequest = async (db: Db, viewerId: string, code: string): Promise<SendResult> => {
  const now = nowIso()
  const expire = addDays(now, -REQUEST_EXPIRE_DAYS)
  const insert = sql`INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at)
    SELECT ${ulid()}, ${viewerId}, u.id, 'pending', ${now}
    FROM user u
    WHERE u.friend_code = ${code} AND u.deleted_at IS NULL AND u.id <> ${viewerId}
      AND ${noBlock(viewerId)}
      AND NOT ${isFriend(viewerId)}
      AND NOT EXISTS (SELECT 1 FROM friend_request r
        WHERE r.from_user_id = ${viewerId} AND r.to_user_id = u.id
          AND r.created_at > ${addDays(now, -REQUEST_RETRY_DAYS)})
      AND NOT EXISTS (SELECT 1 FROM friend_request r
        WHERE r.from_user_id = u.id AND r.to_user_id = ${viewerId}
          AND r.status = 'pending' AND r.created_at > ${expire})
      AND (SELECT COUNT(*) FROM friend_request r
        WHERE r.from_user_id = ${viewerId} AND r.created_at > ${addDays(now, -1)})
        < ${REQUEST_DAILY_LIMIT}
      AND (SELECT COUNT(*) FROM friend_request r
        WHERE r.to_user_id = u.id AND r.status = 'pending' AND r.created_at > ${expire})
        < ${INCOMING_PENDING_LIMIT}
    RETURNING id`
  let inserted = 0
  try {
    const [, rows] = await db.$client.batch<{ id: string }>([
      stmt(db, expirePending(viewerId, now)),
      stmt(db, insert),
    ])
    inserted = rows.results.length
  } catch (e) {
    // pending の UNIQUE(from, to)。条件の NOT EXISTS で先に弾くので通常は来ない
    if (!isUniqueViolation(e)) throw e
  }
  if (inserted > 0) return { ok: true }
  const state = await findInviter(db, viewerId, code)
  if (state.kind === 'incoming' && (await acceptRequest(db, viewerId, state.requestId))) {
    return { ok: true }
  }
  const full = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n
    FROM friend_request r JOIN user u ON u.id = r.to_user_id
    WHERE u.friend_code = ${code} AND u.id <> ${viewerId}
      AND r.status = 'pending' AND r.created_at > ${expire}`)
  return {
    ok: false,
    reason: (full?.n ?? 0) >= INCOMING_PENDING_LIMIT ? 'receiver_full' : 'unknown',
  }
}

// 届いた申請を承認する（1 回の batch）。(1) 自分宛ての有効な pending を、送り主が退会しておらず
// 双方向に block が無いときだけ accepted に、
// (2) その行が今の時刻で accepted になっていて双方向に block が無ければ friendship を作り、
// (3) 自分から相手への pending があれば canceled に。friendship が出来なければ false（呼び出し側で 404）
export const acceptRequest = async (
  db: Db,
  viewerId: string,
  requestId: string,
): Promise<boolean> => {
  const now = nowIso()
  const acceptedNow = sql`r.id = ${requestId} AND r.to_user_id = ${viewerId}
    AND r.status = 'accepted' AND r.responded_at = ${now}`
  const [, accepted, , , friend] = await db.$client.batch<{ id?: string; ok?: number }>([
    stmt(db, expirePending(viewerId, now)),
    stmt(
      db,
      sql`UPDATE friend_request SET status = 'accepted', responded_at = ${now}
        WHERE id = ${requestId} AND to_user_id = ${viewerId} AND status = 'pending'
          AND created_at > ${addDays(now, -REQUEST_EXPIRE_DAYS)}
          AND EXISTS (SELECT 1 FROM user u
            WHERE u.id = friend_request.from_user_id AND u.deleted_at IS NULL
              AND ${noBlock(viewerId)})
        RETURNING id`,
    ),
    stmt(
      db,
      sql`INSERT OR IGNORE INTO friendship (user_lo, user_hi, created_at)
        SELECT MIN(r.from_user_id, r.to_user_id), MAX(r.from_user_id, r.to_user_id), ${now}
        FROM friend_request r JOIN user u ON u.id = r.from_user_id
        WHERE ${acceptedNow} AND u.deleted_at IS NULL AND ${noBlock(viewerId)}`,
    ),
    stmt(
      db,
      sql`UPDATE friend_request SET status = 'canceled', responded_at = ${now}
        WHERE from_user_id = ${viewerId} AND status = 'pending'
          AND to_user_id = (SELECT r.from_user_id FROM friend_request r WHERE ${acceptedNow})`,
    ),
    stmt(
      db,
      sql`SELECT 1 AS ok FROM friend_request r
        JOIN friendship f ON f.user_lo = MIN(r.from_user_id, r.to_user_id)
          AND f.user_hi = MAX(r.from_user_id, r.to_user_id)
        WHERE r.id = ${requestId} AND r.to_user_id = ${viewerId}`,
    ),
  ])
  return accepted.results.length > 0 && friend.results.length > 0
}
