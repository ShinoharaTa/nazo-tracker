// 退会（docs/auth.md §6）。本人の行を物理削除し、user 行は匿名化して残す。
// user 行は change_log.actor_user_id / proposal.reviewer_user_id の FK 先なので消さない。

import { eq, or } from 'drizzle-orm'
import type { Db } from '../db/client'
import {
  attempt,
  attemptGenre,
  block,
  friendRequest,
  friendship,
  identity,
  image,
  imageReport,
  marketVisit,
  oauthState,
  recoveryCode,
  request,
  session,
  sessionToken,
  user,
  wishlist,
} from '../db/schema'
import { nowIso } from '../lib/time'

export const DELETED_DISPLAY_NAME = '退会したユーザー'

// FK の参照元から順に消す。1 回の batch（D1 では 1 トランザクション）で行う
export const deleteAccount = async (db: Db, userId: string) => {
  // TODO(P9): image の R2 実体（r2_key / thumb_r2_key）も削除する
  await db.batch([
    db.delete(imageReport).where(eq(imageReport.reporterUserId, userId)),
    db.delete(image).where(eq(image.userId, userId)),
    db.delete(session).where(eq(session.userId, userId)),
    db.delete(attemptGenre).where(eq(attemptGenre.userId, userId)),
    db.delete(attempt).where(eq(attempt.userId, userId)),
    db.delete(wishlist).where(eq(wishlist.userId, userId)),
    db.delete(marketVisit).where(eq(marketVisit.userId, userId)),
    db.delete(friendship).where(or(eq(friendship.userLo, userId), eq(friendship.userHi, userId))),
    db
      .delete(friendRequest)
      .where(or(eq(friendRequest.fromUserId, userId), eq(friendRequest.toUserId, userId))),
    db.delete(block).where(or(eq(block.userId, userId), eq(block.blockedUserId, userId))),
    db.delete(recoveryCode).where(eq(recoveryCode.userId, userId)),
    db.delete(oauthState).where(eq(oauthState.userId, userId)),
    db.delete(sessionToken).where(eq(sessionToken.userId, userId)),
    db.delete(identity).where(eq(identity.userId, userId)),
    db.update(request).set({ requesterUserId: null }).where(eq(request.requesterUserId, userId)),
    db
      .update(user)
      .set({ deletedAt: nowIso(), displayName: DELETED_DISPLAY_NAME, friendCode: null })
      .where(eq(user.id, userId)),
  ])
}
