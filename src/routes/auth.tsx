// 認証まわりのルート。P1-1 ではログアウトのみ

import { Hono } from 'hono'
import { requireUser } from '../auth/middleware'
import { clearSessionCookie, deleteSession } from '../auth/session'
import type { AppEnv } from '../env'

const auth = new Hono<AppEnv>({ strict: false })

// GET では受けない。CSRF は index.ts の csrf ミドルウェアで検査する
auth.post('/logout', requireUser, async (c) => {
  const id = c.get('sessionId')
  if (id) await deleteSession(c.get('db'), id)
  clearSessionCookie(c)
  return c.redirect('/login', 302)
})

export default auth
