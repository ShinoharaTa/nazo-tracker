// ログインセッション（docs/auth.md §2・§7）。
// cookie には推測不能な token を署名付きで置き、session_token.id にはその SHA-256 だけを保存する。

import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import type { Db } from '../db/client'
import { sessionToken, user, type userRoles } from '../db/schema'
import type { AppEnv } from '../env'
import { randomToken, sha256Base64url } from '../lib/random'
import { addDays, nowIso } from '../lib/time'

export type SessionUser = {
  id: string
  displayName: string
  role: (typeof userRoles)[number]
}

export const SESSION_COOKIE = 'session'
export const SESSION_DAYS = 30
// 残りがこれ未満になったら SESSION_DAYS 延長する
export const SESSION_SLIDE_DAYS = 15

const cookieOptions = (c: Context<AppEnv>): CookieOptions => ({
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
  secure: c.env.APP_ORIGIN.startsWith('https:'),
})

// cookie から token を取り出す。cookie が無ければ undefined、署名が合わなければ false。
// hono は署名部の形が崩れた cookie を「無い」扱い（undefined）にするので、生の cookie の有無で false に寄せる
export const readSessionCookie = async (
  c: Context<AppEnv>,
): Promise<string | false | undefined> => {
  const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE)
  if (token === undefined && getCookie(c, SESSION_COOKIE) !== undefined) return false
  return token
}

export const writeSessionCookie = (c: Context<AppEnv>, token: string) =>
  setSignedCookie(c, SESSION_COOKIE, token, c.env.SESSION_SECRET, {
    ...cookieOptions(c),
    maxAge: SESSION_DAYS * 86_400,
  })

export const clearSessionCookie = (c: Context<AppEnv>) => {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c))
}

export const hashSessionToken = (token: string) => sha256Base64url(token)

// session 行を作り、cookie に入れる token を返す
export const createSession = async (
  db: Db,
  userId: string,
  userAgent: string | undefined,
): Promise<string> => {
  const token = randomToken(32)
  const now = nowIso()
  await db.insert(sessionToken).values({
    id: await hashSessionToken(token),
    userId,
    createdAt: now,
    expiresAt: addDays(now, SESSION_DAYS),
    uaHint: userAgent ? userAgent.slice(0, 120) : null,
  })
  return token
}

export const deleteSession = async (db: Db, id: string) => {
  await db.delete(sessionToken).where(eq(sessionToken.id, id))
}

// session_token JOIN user の 1 クエリ
export const findSession = async (db: Db, id: string) => {
  const rows = await db
    .select({
      id: sessionToken.id,
      expiresAt: sessionToken.expiresAt,
      userId: user.id,
      displayName: user.displayName,
      role: user.role,
      lastSeenAt: user.lastSeenAt,
      deletedAt: user.deletedAt,
    })
    .from(sessionToken)
    .innerJoin(user, eq(user.id, sessionToken.userId))
    .where(eq(sessionToken.id, id))
    .limit(1)
  return rows[0] ?? null
}
