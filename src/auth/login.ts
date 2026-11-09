// ログイン処理の中核。仮ログインも OAuth もここを呼ぶ（docs/auth.md §7）。

import { and, eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { identity, oauthState, sessionToken, user } from '../db/schema'
import type { AppEnv } from '../env'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import { createSession, deleteSession, writeSessionCookie } from './session'

// identity.provider に CHECK は付けず、コード側で縛る
export type Provider = 'dev' | 'google' | 'discord'

export const INITIAL_DISPLAY_NAME = 'ななしさん'

// OWNER_IDENTITIES（provider:subject のカンマ区切り）に完全一致で含まれるか
export const isOwnerIdentity = (
  ownerIdentities: string | undefined,
  provider: Provider,
  subject: string,
): boolean =>
  (ownerIdentities ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(`${provider}:${subject}`)

export const loginWithIdentity = async (
  c: Context<AppEnv>,
  { provider, subject }: { provider: Provider; subject: string },
): Promise<{ userId: string; isNew: boolean }> => {
  const db = c.get('db')
  const now = nowIso()

  // 1. identity → user。退会済みの user に残った identity は消して新規扱い
  let found = await db
    .select({ userId: user.id, role: user.role, deletedAt: user.deletedAt })
    .from(identity)
    .innerJoin(user, eq(user.id, identity.userId))
    .where(and(eq(identity.provider, provider), eq(identity.subject, subject)))
    .get()
  if (found?.deletedAt) {
    await db
      .delete(identity)
      .where(and(eq(identity.provider, provider), eq(identity.subject, subject)))
    found = undefined
  }

  const isNew = !found
  let userId: string
  let role: string
  if (found) {
    userId = found.userId
    role = found.role
  } else {
    userId = ulid()
    role = 'member'
    await db.batch([
      db.insert(user).values({
        id: userId,
        displayName: INITIAL_DISPLAY_NAME,
        role: 'member',
        createdAt: now,
      }),
      db.insert(identity).values({ provider, subject, userId, createdAt: now }),
    ])
  }

  // 2. オーナー昇格。自動降格はしない
  if (role !== 'owner' && isOwnerIdentity(c.env.OWNER_IDENTITIES, provider, subject)) {
    await db.update(user).set({ role: 'owner' }).where(eq(user.id, userId))
  }

  // 3. 最終ログイン・最終アクセス
  // 4. 期限切れ行の掃除（cron は作らない）
  await db.batch([
    db
      .update(identity)
      .set({ lastLoginAt: now })
      .where(and(eq(identity.provider, provider), eq(identity.subject, subject))),
    db.update(user).set({ lastSeenAt: now }).where(eq(user.id, userId)),
    db.delete(sessionToken).where(lt(sessionToken.expiresAt, now)),
    db.delete(oauthState).where(lt(oauthState.expiresAt, now)),
  ])

  // 5. セッション固定対策: 今の cookie の行を消し、必ず新しい token を発行する
  const current = c.get('sessionId')
  if (current) await deleteSession(db, current)
  const token = await createSession(db, userId, c.req.header('User-Agent'))
  await writeSessionCookie(c, token)
  c.set('sessionId', null)

  return { userId, isNew }
}

// PR-2 で /settings/name ができたら、新規ユーザー（isNew）は /settings/name?welcome=1 に切り替える
export const redirectAfterLogin = (c: Context<AppEnv>, _isNew: boolean) =>
  c.redirect('/records', 302)
