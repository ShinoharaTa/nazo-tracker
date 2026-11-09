// 認証まわりのルート。OAuth の開始・戻りとログアウト

import { Hono } from 'hono'
import { redirectAfterLogin } from '../auth/login'
import { requireUser } from '../auth/middleware'
import { beginOAuth, completeOAuth, isProviderReady } from '../auth/oauth'
import { findOAuthProvider } from '../auth/providers/types'
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

auth.get('/:provider', async (c) => {
  const provider = findOAuthProvider(c.req.param('provider'))
  if (!provider) return c.notFound()
  if (!isProviderReady(c, provider)) return c.text(`${provider.label} ログインは準備中です`, 503)
  if (c.get('user')) return c.redirect('/records', 302)
  return beginOAuth(c, provider)
})

auth.get('/:provider/callback', async (c) => {
  const provider = findOAuthProvider(c.req.param('provider'))
  if (!provider) return c.notFound()
  const result = await completeOAuth(c, provider)
  if (!result.ok) return c.redirect(`/login?error=${result.error}`, 302)
  return redirectAfterLogin(c, result.isNew)
})

export default auth
