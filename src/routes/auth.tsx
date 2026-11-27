// 認証まわりのルート。OAuth の開始・戻りとログアウト

import { type Context, Hono } from 'hono'
import { redirectAfterLogin } from '../auth/login'
import { requireUser } from '../auth/middleware'
import { beginOAuth, completeOAuth, isProviderReady } from '../auth/oauth'
import { findOAuthProvider } from '../auth/providers/types'
import { clearSessionCookie, deleteSession, deleteUserSessions } from '../auth/session'
import type { AppEnv } from '../env'
import { allow } from '../lib/rate-limit'

const auth = new Hono<AppEnv>({ strict: false })

// レート制限の key に使う IP。CF-Connecting-IP だけを見る。無ければ null（制限しない。ローカルとテスト）
const ipOf = (c: Context<AppEnv>): string | null => c.req.header('CF-Connecting-IP') || null

// GET では受けない。CSRF は index.ts の csrf ミドルウェアで検査する
auth.post('/logout', requireUser, async (c) => {
  const id = c.get('sessionId')
  if (id) await deleteSession(c.get('db'), id)
  clearSessionCookie(c)
  return c.redirect('/login', 302)
})

// 自分の session_token を全端末分消す
auth.post('/logout/all', requireUser, async (c) => {
  const user = c.get('user')
  if (user) await deleteUserSessions(c.get('db'), user.id)
  clearSessionCookie(c)
  return c.redirect('/login', 302)
})

auth.get('/:provider', async (c) => {
  const provider = findOAuthProvider(c.req.param('provider'))
  if (!provider) return c.notFound()
  if (!isProviderReady(c, provider)) return c.text(`${provider.label} ログインは準備中です`, 503)
  if (c.get('user')) return c.redirect('/records', 302)
  const ip = ipOf(c)
  // 制限に掛かったときはログイン画面に戻して「アクセスが集中しています」を出す（oauth_state に書かない）
  if (!(await allow(c.env.AUTH_LIMITER, ip ? `begin:${ip}` : null))) {
    return c.redirect('/login?error=busy', 302)
  }
  return beginOAuth(c, provider)
})

auth.get('/:provider/callback', async (c) => {
  const provider = findOAuthProvider(c.req.param('provider'))
  if (!provider) return c.notFound()
  // 制限に掛かったときは開始と同じくログイン画面に戻す（oauth_state も token endpoint も触らない）
  const ip = ipOf(c)
  if (!(await allow(c.env.AUTH_LIMITER, ip ? `cb:${ip}` : null))) {
    console.error(`OAuth ${provider.name}: レート制限`)
    return c.redirect('/login?error=busy', 302)
  }
  const result = await completeOAuth(c, provider)
  if (!result.ok) return c.redirect(`/login?error=${result.error}`, 302)
  return redirectAfterLogin(c, result.isNew)
})

export default auth
