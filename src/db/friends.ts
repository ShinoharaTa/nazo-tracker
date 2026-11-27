// フレンド関係（friend_request / friendship / block / user.friend_code）の読み書き。
// 記録系ではないので scopedTo の外に置くが、全関数が第 2 引数に viewerId を取り、WHERE に必ず入れる。
// 記録の射影（フレンドの記録を読むこと）は src/db/scoped.ts の asFriendOf だけが行う。
// 退会済み（deleted_at あり）の行は書き換えない（退会でセッションは消えるので保険）。

const self = (viewerId: string) => and(eq(user.id, viewerId), isNull(user.deletedAt))

import { and, eq, isNull } from 'drizzle-orm'
import { FRIEND_CODE_LENGTH, randomCode } from '../lib/random'
import type { Db } from './client'
import { user } from './schema'

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
