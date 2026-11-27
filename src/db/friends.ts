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
  | { kind: 'outgoing'; userId: string; displayName: string; requestId: string }
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
    outgoing_id: string | null
    incoming_id: string | null
  }>(sql`SELECT u.id, u.display_name,
      NOT ${noBlock(viewerId)} AS blocked,
      ${isFriend(viewerId)} AS friends,
      (SELECT r.id FROM friend_request r
        WHERE r.from_user_id = ${viewerId} AND r.to_user_id = u.id
          AND r.status IN ('pending', 'declined') AND r.created_at > ${expire}
        ORDER BY r.created_at DESC LIMIT 1) AS outgoing_id,
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
  if (row.outgoing_id) return { kind: 'outgoing', ...who, requestId: row.outgoing_id }
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
// (3) 自分から相手への pending / declined があれば canceled に（断った申請が解除後に「申請中」として戻らないように）。
// 最後に friendship があれば true（すでにフレンドの二重承認も true）。無ければ false（呼び出し側で 404）
export const acceptRequest = async (
  db: Db,
  viewerId: string,
  requestId: string,
): Promise<boolean> => {
  const now = nowIso()
  const acceptedNow = sql`r.id = ${requestId} AND r.to_user_id = ${viewerId}
    AND r.status = 'accepted' AND r.responded_at = ${now}`
  const [, , , , friend] = await db.$client.batch<{ ok: number }>([
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
        WHERE from_user_id = ${viewerId} AND status IN ('pending', 'declined')
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
  return friend.results.length > 0
}

// 設定 → フレンドの一覧に出す相手（申請なら申請日 createdAt も）
export type FriendPerson = { userId: string; displayName: string }
export type RequestRow = FriendPerson & { requestId: string; createdAt: string }

// 届いた申請（自分宛ての pending で 30 日以内）。送り主が退会済み・どちらかがブロック中なら出さない。新しい順
export const listIncoming = async (db: Db, viewerId: string): Promise<RequestRow[]> => {
  const rows = await db.all<{
    id: string
    user_id: string
    display_name: string
    created_at: string
  }>(
    sql`SELECT r.id, u.id AS user_id, u.display_name, r.created_at
      FROM friend_request r JOIN user u ON u.id = r.from_user_id
      WHERE r.to_user_id = ${viewerId} AND r.status = 'pending'
        AND r.created_at > ${addDays(nowIso(), -REQUEST_EXPIRE_DAYS)}
        AND u.deleted_at IS NULL AND ${noBlock(viewerId)}
      ORDER BY r.created_at DESC, r.id DESC`,
  )
  return rows.map((r) => ({
    requestId: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    createdAt: r.created_at,
  }))
}

// 送った申請（自分からの pending / declined で 30 日以内。断られた分も「申請中」として出す）。
// 同じ相手に 2 行あり得る（断られて 7 日後に送り直した場合）ので、相手ごとに新しい 1 行だけ。新しい順
export const listOutgoing = async (db: Db, viewerId: string): Promise<RequestRow[]> => {
  const rows = await db.all<{
    id: string
    user_id: string
    display_name: string
    created_at: string
  }>(
    sql`SELECT r.id, u.id AS user_id, u.display_name, r.created_at
      FROM friend_request r JOIN user u ON u.id = r.to_user_id
      WHERE r.from_user_id = ${viewerId} AND r.status IN ('pending', 'declined')
        AND r.created_at > ${addDays(nowIso(), -REQUEST_EXPIRE_DAYS)}
        AND u.deleted_at IS NULL AND ${noBlock(viewerId)}
        AND NOT EXISTS (SELECT 1 FROM friend_request n
          WHERE n.from_user_id = r.from_user_id AND n.to_user_id = r.to_user_id
            AND n.status IN ('pending', 'declined') AND n.created_at > r.created_at)
      ORDER BY r.created_at DESC, r.id DESC`,
  )
  return rows.map((r) => ({
    requestId: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    createdAt: r.created_at,
  }))
}

// フレンドの相手側（u）。退会済み・どちらかがブロック中は除く（どちらも friendship は消えるので二重の保険）
const friendsOf = (viewerId: string) => sql`FROM friendship f
  JOIN user u ON u.id = CASE WHEN f.user_lo = ${viewerId} THEN f.user_hi ELSE f.user_lo END
  WHERE (f.user_lo = ${viewerId} OR f.user_hi = ${viewerId})
    AND u.deleted_at IS NULL AND ${noBlock(viewerId)}`

// フレンド一覧。表示名の昇順
export const listFriends = async (db: Db, viewerId: string): Promise<FriendPerson[]> => {
  const rows = await db.all<{ id: string; display_name: string }>(
    sql`SELECT u.id, u.display_name ${friendsOf(viewerId)} ORDER BY u.display_name, u.id`,
  )
  return rows.map((r) => ({ userId: r.id, displayName: r.display_name }))
}

// 解除・ブロックの確認画面に出す相手。今のフレンド（friend: true）か、自分に有効な pending を送ってきた人
// （friend: false。ブロックだけできる）。どちらでもなければ null（呼び出し側で 404）。条件は blockTarget と同じ
export const findManageTarget = async (
  db: Db,
  viewerId: string,
  userId: string,
): Promise<(FriendPerson & { friend: boolean }) | null> => {
  const row = await db.get<{ id: string; display_name: string; friend: number }>(
    sql`SELECT u.id, u.display_name, ${isFriend(viewerId)} AS friend FROM user u
      WHERE u.id = ${userId} AND u.id <> ${viewerId} AND u.deleted_at IS NULL
        AND ${noBlock(viewerId)}
        AND (${isFriend(viewerId)}
          OR EXISTS (SELECT 1 FROM friend_request r
            WHERE r.from_user_id = u.id AND r.to_user_id = ${viewerId}
              AND r.status = 'pending' AND r.created_at > ${addDays(nowIso(), -REQUEST_EXPIRE_DAYS)}))`,
  )
  return row ? { userId: row.id, displayName: row.display_name, friend: row.friend === 1 } : null
}

// 設定一覧の note 用（フレンドの人数、届いた申請の件数）。数え方は listFriends / listIncoming と同じ
export const friendCounts = async (
  db: Db,
  viewerId: string,
): Promise<{ friends: number; incoming: number }> => {
  const row = await db.get<{ friends: number; incoming: number }>(
    sql`SELECT (SELECT COUNT(*) ${friendsOf(viewerId)}) AS friends,
      (SELECT COUNT(*) FROM friend_request r JOIN user u ON u.id = r.from_user_id
        WHERE r.to_user_id = ${viewerId} AND r.status = 'pending'
          AND r.created_at > ${addDays(nowIso(), -REQUEST_EXPIRE_DAYS)}
          AND u.deleted_at IS NULL AND ${noBlock(viewerId)}) AS incoming`,
  )
  return { friends: row?.friends ?? 0, incoming: row?.incoming ?? 0 }
}

// 届いた申請を断る（自分宛ての pending で 30 日以内 → declined）。相手には知らせない（送った側は「申請中」のまま）。
// 該当が無ければ false（呼び出し側で 404）
export const declineRequest = async (
  db: Db,
  viewerId: string,
  requestId: string,
): Promise<boolean> => {
  const now = nowIso()
  const [, declined] = await db.$client.batch<{ id: string }>([
    stmt(db, expirePending(viewerId, now)),
    stmt(
      db,
      sql`UPDATE friend_request SET status = 'declined', responded_at = ${now}
        WHERE id = ${requestId} AND to_user_id = ${viewerId} AND status = 'pending'
          AND created_at > ${addDays(now, -REQUEST_EXPIRE_DAYS)}
        RETURNING id`,
    ),
  ])
  return declined.results.length > 0
}

// 送った申請を取り消す（自分からの pending / declined で 30 日以内 → canceled）。
// 同じ相手への有効な行が他にもあれば一緒に取り消す（一覧・招待リンクの画面で「申請中」が残らないように）。
// 該当が無ければ false（呼び出し側で 404）
export const cancelRequest = async (
  db: Db,
  viewerId: string,
  requestId: string,
): Promise<boolean> => {
  const now = nowIso()
  const expire = addDays(now, -REQUEST_EXPIRE_DAYS)
  const [, canceled] = await db.$client.batch<{ id: string }>([
    stmt(db, expirePending(viewerId, now)),
    stmt(
      db,
      sql`UPDATE friend_request SET status = 'canceled', responded_at = ${now}
        WHERE from_user_id = ${viewerId} AND status IN ('pending', 'declined')
          AND created_at > ${expire}
          AND to_user_id = (SELECT r.to_user_id FROM friend_request r
            WHERE r.id = ${requestId} AND r.from_user_id = ${viewerId}
              AND r.status IN ('pending', 'declined') AND r.created_at > ${expire})
        RETURNING id`,
    ),
  ])
  return canceled.results.length > 0
}

// フレンド解除（friendship を消すだけ。相手には知らせない）。フレンドでなければ false（呼び出し側で 404）
export const removeFriend = async (db: Db, viewerId: string, userId: string): Promise<boolean> => {
  const rows = await db.all<{ user_lo: string }>(
    sql`DELETE FROM friendship
      WHERE (user_lo = ${viewerId} AND user_hi = ${userId})
         OR (user_lo = ${userId} AND user_hi = ${viewerId})
      RETURNING user_lo`,
  )
  return rows.length > 0
}

// ブロックする（1 回の batch）。相手は「今のフレンド」か「自分に有効な pending を送ってきた人」だけで、
// 条件は block の INSERT ... SELECT に入れる。block 行がある（今入れた・前からある）ときだけ、
// friendship を消し、両方向の pending / declined を canceled にする。ブロックできなければ false（呼び出し側で 404）。
// 相手には知らせない（相手からは退会したときと同じ見え方。このファイルの一覧・判定は noBlock で外す）
const blockTarget = async (db: Db, viewerId: string, target: string): Promise<boolean> => {
  const now = nowIso()
  const expire = addDays(now, -REQUEST_EXPIRE_DAYS)
  const blocked = sql`EXISTS (SELECT 1 FROM block b
    WHERE b.user_id = ${viewerId} AND b.blocked_user_id = ${target})`
  const [, inserted, existing] = await db.$client.batch<{ blocked_user_id?: string; ok?: number }>([
    stmt(db, expirePending(viewerId, now)),
    stmt(
      db,
      sql`INSERT OR IGNORE INTO block (user_id, blocked_user_id, created_at)
          SELECT ${viewerId}, u.id, ${now} FROM user u
          WHERE u.id = ${target} AND u.id <> ${viewerId} AND u.deleted_at IS NULL
            AND (${isFriend(viewerId)}
              OR EXISTS (SELECT 1 FROM friend_request r
                WHERE r.from_user_id = u.id AND r.to_user_id = ${viewerId}
                  AND r.status = 'pending' AND r.created_at > ${expire}))
          RETURNING blocked_user_id`,
    ),
    stmt(db, sql`SELECT 1 AS ok WHERE ${blocked}`),
    stmt(
      db,
      sql`DELETE FROM friendship
          WHERE ${blocked}
            AND ((user_lo = ${viewerId} AND user_hi = ${target})
              OR (user_lo = ${target} AND user_hi = ${viewerId}))`,
    ),
    stmt(
      db,
      sql`UPDATE friend_request SET status = 'canceled', responded_at = ${now}
          WHERE ${blocked} AND status IN ('pending', 'declined')
            AND ((from_user_id = ${viewerId} AND to_user_id = ${target})
              OR (from_user_id = ${target} AND to_user_id = ${viewerId}))`,
    ),
  ])
  return inserted.results.length > 0 || existing.results.length > 0
}

// 届いた申請の送り主をブロックする（自分宛ての有効な pending の id）
export const blockRequester = async (
  db: Db,
  viewerId: string,
  requestId: string,
): Promise<boolean> => {
  const row = await db.get<{ from_user_id: string }>(
    sql`SELECT from_user_id FROM friend_request
      WHERE id = ${requestId} AND to_user_id = ${viewerId} AND status = 'pending'
        AND created_at > ${addDays(nowIso(), -REQUEST_EXPIRE_DAYS)}`,
  )
  return row ? blockTarget(db, viewerId, row.from_user_id) : false
}

// フレンドをブロックする
export const blockFriend = (db: Db, viewerId: string, userId: string): Promise<boolean> =>
  blockTarget(db, viewerId, userId)

// ブロック解除（自分の block 行を消すだけ。friendship は戻らない）。行が無ければ false（呼び出し側で 404）
export const unblock = async (db: Db, viewerId: string, userId: string): Promise<boolean> => {
  const rows = await db.all<{ blocked_user_id: string }>(
    sql`DELETE FROM block WHERE user_id = ${viewerId} AND blocked_user_id = ${userId}
      RETURNING blocked_user_id`,
  )
  return rows.length > 0
}

// 自分がブロック中の相手。表示名の昇順（退会した相手は退会処理で行ごと消える）
export const listBlocked = async (db: Db, viewerId: string): Promise<FriendPerson[]> => {
  const rows = await db.all<{ id: string; display_name: string }>(
    sql`SELECT u.id, u.display_name FROM block b JOIN user u ON u.id = b.blocked_user_id
      WHERE b.user_id = ${viewerId} AND u.deleted_at IS NULL
      ORDER BY u.display_name, u.id`,
  )
  return rows.map((r) => ({ userId: r.id, displayName: r.display_name }))
}
