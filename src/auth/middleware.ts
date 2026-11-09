// 認証ミドルウェア（docs/auth.md §7）。

import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { createDb } from '../db/client'
import { sessionToken, user } from '../db/schema'
import type { AppEnv } from '../env'
import { addDays, isPast, nowIso } from '../lib/time'
import {
  clearSessionCookie,
  findSession,
  hashSessionToken,
  readSessionCookie,
  SESSION_DAYS,
  SESSION_SLIDE_DAYS,
  type SessionUser,
  writeSessionCookie,
} from './session'

// cookie → session → user。無効・期限切れ・退会済みは未ログイン扱いにして cookie を消す
export const attachUser = createMiddleware<AppEnv>(async (c, next) => {
  const secret = c.env.SESSION_SECRET
  if (!secret || secret.length < 32) {
    console.error('SESSION_SECRET が未設定か、32 文字未満です')
    return c.text('SESSION_SECRET が未設定か短すぎます', 500)
  }

  const db = createDb(c.env.DB)
  c.set('db', db)
  c.set('user', null)
  c.set('sessionId', null)

  const token = await readSessionCookie(c)
  if (token === undefined) return next()

  const id = token ? await hashSessionToken(token) : null
  const row = id ? await findSession(db, id) : null
  if (!token || !row || isPast(row.expiresAt) || row.deletedAt) {
    clearSessionCookie(c)
    return next()
  }

  const now = nowIso()
  // スライド延長。cookie の Max-Age も同じだけ延ばす
  if (Date.parse(row.expiresAt) - Date.now() < SESSION_SLIDE_DAYS * 86_400_000) {
    await db
      .update(sessionToken)
      .set({ expiresAt: addDays(now, SESSION_DAYS) })
      .where(eq(sessionToken.id, row.id))
    await writeSessionCookie(c, token)
  }
  // 最終アクセスは UTC の日付が変わったときだけ書く
  if (row.lastSeenAt?.slice(0, 10) !== now.slice(0, 10)) {
    await db.update(user).set({ lastSeenAt: now }).where(eq(user.id, row.userId))
  }

  c.set('user', { id: row.userId, displayName: row.displayName, role: row.role })
  c.set('sessionId', row.id)
  return next()
})

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('user')) {
    const m = c.req.method
    if (m === 'GET' || m === 'HEAD') return c.redirect('/login', 302)
    return c.text('ログインが必要です', 401)
  }
  await next()
})

// オーナー以外には存在を漏らさず 404
export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  const u = c.get('user')
  if (!u) return requireUser(c, next)
  if (u.role !== 'owner') return c.notFound()
  await next()
})

// JSON API 用。未ログイン・非オーナーとも JSON の 404（/login へは飛ばさない）
export const requireOwnerApi = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user')?.role !== 'owner') return c.json({ error: 'not_found' }, 404)
  await next()
})

// requireUser を通したルートで、ログイン中のユーザーを取り出す
export const currentUser = (c: Context<AppEnv>): SessionUser => {
  const u = c.get('user')
  if (!u) throw new Error('requireUser を通していないルートで currentUser が呼ばれた')
  return u
}
