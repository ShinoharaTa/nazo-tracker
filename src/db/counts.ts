// 作品ごとの匿名人数（docs/design.md §6.5、data-model.md §6「匿名の人数」）。
// 返すのは作品ごとの人数（実数）だけで、user_id や行は返さない。
// exclude_from_counts = 1 のユーザーと退会済み（deleted_at）のユーザーは数えない。

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Db } from './client'
import { attempt, user, wishlist } from './schema'

// 人数は 0 以上の整数
export type WorkCounts = { played: number; wish: number }

// D1 のバインド変数は 1 文 100 個まで。IN (...) はこの件数ずつに分ける（master.ts と同じ）
const IN_CHUNK = 90

const counted = () => and(eq(user.excludeFromCounts, 0), isNull(user.deletedAt))

// プレイ済み = cleared / failed の attempt を持つユーザー数。dropped / purchased / in_progress は含めない
const playedUsers = (db: Db, workIds: string[]) =>
  db
    .select({ workId: attempt.workId, n: sql<number>`count(DISTINCT ${attempt.userId})` })
    .from(attempt)
    .innerJoin(user, eq(user.id, attempt.userId))
    .where(
      and(
        inArray(attempt.workId, workIds),
        inArray(attempt.status, ['cleared', 'failed']),
        counted(),
      ),
    )
    .groupBy(attempt.workId)

const wishUsers = (db: Db, workIds: string[]) =>
  db
    .select({ workId: wishlist.workId, n: sql<number>`count(DISTINCT ${wishlist.userId})` })
    .from(wishlist)
    .innerJoin(user, eq(user.id, wishlist.userId))
    .where(and(inArray(wishlist.workId, workIds), counted()))
    .groupBy(wishlist.workId)

// 無い id・数える人がいない作品は { 0, 0 }
export const countsFor = async (db: Db, workIds: string[]): Promise<Map<string, WorkCounts>> => {
  const ids = [...new Set(workIds)]
  const played = new Map<string, number>()
  const wish = new Map<string, number>()
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const [p, w] = await db.batch([playedUsers(db, chunk), wishUsers(db, chunk)])
    for (const r of p) played.set(r.workId, r.n)
    for (const r of w) wish.set(r.workId, r.n)
  }
  const out = new Map<string, WorkCounts>()
  for (const id of ids) {
    out.set(id, { played: played.get(id) ?? 0, wish: wish.get(id) ?? 0 })
  }
  return out
}
