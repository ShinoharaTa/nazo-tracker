// OAuth の共通処理（docs/auth.md §3・§7）。state は D1 の行と cookie の二重照合、PKCE は S256。
// code_verifier は D1 にしか置かない。アクセストークン・ID トークンは DB にもログにも書かない

import { and, eq, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'
import { oauthState } from '../db/schema'
import type { AppEnv } from '../env'
import { randomToken, sha256Base64url } from '../lib/random'
import { isPast } from '../lib/time'
import { loginWithIdentity } from './login'
import type { OAuthProvider } from './providers/types'

export const OAUTH_COOKIE = 'oauth'
export const OAUTH_STATE_MINUTES = 10

const cookieOptions = (c: Context<AppEnv>): CookieOptions => ({
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
  secure: c.env.APP_ORIGIN.startsWith('https:'),
})

// redirect_uri は Host ヘッダではなく APP_ORIGIN から組み立てる（末尾の / は落とす）
const redirectUriOf = (c: Context<AppEnv>, provider: OAuthProvider) =>
  `${c.env.APP_ORIGIN.replace(/\/+$/, '')}/auth/${provider.name}/callback`

// CLIENT_ID と CLIENT_SECRET の両方が入っていれば使える。
// どちらかが空なら /login のボタンは「準備中」、/auth/<provider> は 503
export const isProviderReady = (c: Context<AppEnv>, provider: OAuthProvider): boolean =>
  !!provider.clientId(c.env) && !!provider.clientSecret(c.env)

export const beginOAuth = async (c: Context<AppEnv>, provider: OAuthProvider) => {
  const clientId = provider.clientId(c.env)
  if (!clientId) throw new Error(`${provider.name} の CLIENT_ID が未設定`)

  const state = randomToken(32)
  const codeVerifier = randomToken(32)
  const codeChallenge = await sha256Base64url(codeVerifier)
  const nonce = provider.usesNonce ? randomToken(32) : null

  const db = c.get('db')
  const now = new Date()
  // 期限切れの行を掃除する（callback まで来なかった state が溜まらないように）
  await db.delete(oauthState).where(lt(oauthState.expiresAt, now.toISOString()))
  await db.insert(oauthState).values({
    state,
    provider: provider.name,
    codeVerifier,
    mode: 'login',
    userId: null,
    expiresAt: new Date(now.getTime() + OAUTH_STATE_MINUTES * 60_000).toISOString(),
    nonce,
  })
  setCookie(c, OAUTH_COOKIE, state, { ...cookieOptions(c), maxAge: OAUTH_STATE_MINUTES * 60 })

  return c.redirect(
    provider.authorizeUrl({
      clientId,
      redirectUri: redirectUriOf(c, provider),
      state,
      codeChallenge,
      nonce,
    }),
    302,
  )
}

export type OAuthResult =
  | { ok: true; userId: string; isNew: boolean }
  | { ok: false; error: 'denied' | 'failed' }

// 失敗の詳細は console.error にだけ出す。code・トークン・プロバイダの応答本文は出さない
const failed = (provider: OAuthProvider, reason: string): OAuthResult => {
  console.error(`OAuth ${provider.name}: ${reason}`)
  return { ok: false, error: 'failed' }
}

export const completeOAuth = async (
  c: Context<AppEnv>,
  provider: OAuthProvider,
): Promise<OAuthResult> => {
  const cookieState = getCookie(c, OAUTH_COOKIE)
  // callback では成否に関わらず oauth cookie を消す
  deleteCookie(c, OAUTH_COOKIE, cookieOptions(c))

  // ユーザーが同意画面で拒否した
  if (c.req.query('error') !== undefined) return { ok: false, error: 'denied' }

  // 1. state を cookie と照合。この段階では D1 を触らない（行は期限切れの掃除で消える）
  const state = c.req.query('state')
  if (!state || !cookieState || state !== cookieState) return failed(provider, 'state 不一致')
  const code = c.req.query('code')
  if (!code) return failed(provider, 'code が無い')

  // 2. 1 回限り。取り出しと同時に消す
  const row = await c
    .get('db')
    .delete(oauthState)
    .where(and(eq(oauthState.state, state), eq(oauthState.provider, provider.name)))
    .returning()
    .get()
  if (!row) return failed(provider, 'state の行が無い')
  if (isPast(row.expiresAt)) return failed(provider, 'state の期限切れ')
  if (row.mode !== 'login') return failed(provider, `未対応の mode: ${row.mode}`)

  const clientId = provider.clientId(c.env)
  const clientSecret = provider.clientSecret(c.env)
  if (!clientId || !clientSecret) return failed(provider, 'CLIENT_ID / CLIENT_SECRET が未設定')

  // 4〜5. token endpoint → subject。トークンはこのブロックを抜けたら捨てる
  let subject: string | null
  try {
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUriOf(c, provider),
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: row.codeVerifier,
      }).toString(),
    })
    if (!res.ok) return failed(provider, `token endpoint が ${res.status}`)
    const token: unknown = await res.json()
    subject = await provider.subjectOf(token, { clientId, nonce: row.nonce })
  } catch (e) {
    return failed(provider, `token の取得に失敗: ${e instanceof Error ? e.name : 'unknown'}`)
  }
  if (!subject) return failed(provider, 'subject を取り出せない（トークン検証の失敗）')

  // 6.
  const { userId, isNew } = await loginWithIdentity(c, { provider: provider.name, subject })
  return { ok: true, userId, isNew }
}
