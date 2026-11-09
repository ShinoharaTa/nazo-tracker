// 利用者のデータを読む唯一の入口（docs/auth.md §6 実装上の規約）。
// own() は本人の行だけ、asFriendOf() は friendship / block を確かめてから射影だけを返す。
// 記録系テーブルをこのファイル以外から import しないことは scripts/check-scoped.mjs で検査する。

import { and, eq, or } from 'drizzle-orm'
import type { Db } from './client'
import { block, friendship, user, type userRoles } from './schema'

export type OwnProfile = {
  id: string
  displayName: string
  role: (typeof userRoles)[number]
  friendCode: string | null
  excludeFromCounts: boolean
  createdAt: string
}

export type OwnRepo = {
  profile(): Promise<OwnProfile>
  updateDisplayName(name: string): Promise<void>
}

// P1 は箱だけ。P8 で射影を返すメソッドを足す
export type FriendRepo = {
  readonly targetUserId: string
  readonly level: 'status'
}

export type Scoped = {
  readonly viewerId: string
  own(): OwnRepo
  asFriendOf(targetUserId: string): Promise<FriendRepo | null>
}

const ownRepo = (db: Db, viewerId: string): OwnRepo => ({
  async profile() {
    const row = await db
      .select({
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        friendCode: user.friendCode,
        excludeFromCounts: user.excludeFromCounts,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, viewerId))
      .get()
    if (!row) throw new Error('viewer の user 行が無い')
    return { ...row, excludeFromCounts: row.excludeFromCounts === 1 }
  },

  // WHERE は viewerId 固定。ほかの行は更新できない
  async updateDisplayName(name: string) {
    await db.update(user).set({ displayName: name }).where(eq(user.id, viewerId))
  },
})

export const scopedTo = (db: Db, viewerId: string): Scoped => ({
  viewerId,
  own: () => ownRepo(db, viewerId),

  // friendship があり、どちらの向きにも block が無いときだけ返す。満たさなければ null（呼び出し側が 404 にする）
  async asFriendOf(targetUserId: string) {
    if (targetUserId === viewerId) return null
    const [lo, hi] = viewerId < targetUserId ? [viewerId, targetUserId] : [targetUserId, viewerId]
    const [friend, blocked] = await db.batch([
      db
        .select({ userLo: friendship.userLo })
        .from(friendship)
        .where(and(eq(friendship.userLo, lo), eq(friendship.userHi, hi)))
        .limit(1),
      db
        .select({ userId: block.userId })
        .from(block)
        .where(
          or(
            and(eq(block.userId, viewerId), eq(block.blockedUserId, targetUserId)),
            and(eq(block.userId, targetUserId), eq(block.blockedUserId, viewerId)),
          ),
        )
        .limit(1),
    ])
    if (friend.length === 0 || blocked.length > 0) return null
    return { targetUserId, level: 'status' }
  },
})
