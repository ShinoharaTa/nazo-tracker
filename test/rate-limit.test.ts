import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { allow } from '../src/lib/rate-limit'
import { loginAs, ORIGIN } from './helpers/auth'

const IP = '203.0.113.7'

// 偽の limiter。呼ばれた key を記録し、success を固定で返す
const fakeLimiter = (success: boolean) => {
  const keys: string[] = []
  const limiter: RateLimit = {
    limit: async ({ key }) => {
      keys.push(key)
      return { success }
    },
  }
  return { limiter, keys }
}

const throwingLimiter: RateLimit = {
  limit: async () => {
    throw new Error('boom')
  },
}

const google: Cloudflare.Env = {
  ...env,
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
}

const b64url = (v: unknown) =>
  btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// 署名は検証しない仕様なので、署名部は任意の文字列でよい（test/oauth-google.test.ts と同じ）
const idToken = (nonce: string, sub: string) =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: 'https://accounts.google.com',
    aud: google.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub,
    nonce,
  })}.not-a-real-signature`

// 開始はヘッダ無し（制限なし）で済ませ、正しい state・nonce を用意する
const startGoogle = async () => {
  const started = await app.request('/auth/google', {}, google)
  const location = new URL(started.headers.get('location') ?? '')
  return {
    state: location.searchParams.get('state') ?? '',
    nonce: location.searchParams.get('nonce') ?? '',
  }
}

const callback = (state: string, limiter: RateLimit) =>
  app.request(
    `/auth/google/callback?code=c&state=${state}`,
    { headers: { Cookie: `oauth=${state}`, 'CF-Connecting-IP': IP } },
    { ...google, AUTH_LIMITER: limiter },
  )

const stateCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_state').first<{ n: number }>())?.n ?? 0

const stateRow = (state: string) =>
  env.DB.prepare('SELECT state FROM oauth_state WHERE state = ?').bind(state).first()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('allow', () => {
  it('limiter 未定義・key が null は素通しで、limiter を呼ばない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    expect(await allow(undefined, 'k')).toBe(true)
    expect(await allow(limiter, null)).toBe(true)
    expect(keys).toEqual([])
  })

  it('limit() の success をそのまま返す', async () => {
    expect(await allow(fakeLimiter(true).limiter, 'k')).toBe(true)
    expect(await allow(fakeLimiter(false).limiter, 'k')).toBe(false)
  })

  it('limit() が throw したら console.error して素通し', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await allow(throwingLimiter, 'k')).toBe(true)
    expect(spy).toHaveBeenCalled()
  })
})

describe('GET /auth/:provider', () => {
  const begin = (e: Cloudflare.Env, headers: Record<string, string> = { 'CF-Connecting-IP': IP }) =>
    app.request('/auth/google', { headers }, e)

  it('制限に掛かると 302 /login?error=busy で、oauth_state に行が増えない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    const before = await stateCount()
    const res = await begin({ ...google, AUTH_LIMITER: limiter })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=busy')
    expect(await stateCount()).toBe(before)
    expect(keys).toEqual([`begin:${IP}`])
  })

  it('制限内なら従来どおり 302（認可 URL）', async () => {
    const { limiter, keys } = fakeLimiter(true)
    const res = await begin({ ...google, AUTH_LIMITER: limiter })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\//)
    expect(keys).toEqual([`begin:${IP}`])
  })

  it('CF-Connecting-IP が無ければ limiter を呼ばずに素通し', async () => {
    const { limiter, keys } = fakeLimiter(false)
    const res = await begin({ ...google, AUTH_LIMITER: limiter }, {})
    expect(res.status).toBe(302)
    expect(keys).toEqual([])
  })

  it('limit() が throw しても素通し', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await begin({ ...google, AUTH_LIMITER: throwingLimiter })
    expect(res.status).toBe(302)
  })

  it('存在しない provider は 404、準備中は 503 で、limiter を呼ばない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    expect(
      (
        await app.request(
          '/auth/nope',
          { headers: { 'CF-Connecting-IP': IP } },
          { ...google, AUTH_LIMITER: limiter },
        )
      ).status,
    ).toBe(404)
    expect((await begin({ ...env, AUTH_LIMITER: limiter })).status).toBe(503)
    expect(keys).toEqual([])
  })
})

describe('GET /auth/:provider/callback', () => {
  it('制限に掛かると 302 /login?error=busy で、oauth_state を消費せず外部 fetch も呼ばない', async () => {
    const { state } = await startGoogle()
    expect(await stateRow(state)).not.toBeNull()

    const { limiter, keys } = fakeLimiter(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await callback(state, limiter)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=busy')
    expect(keys).toEqual([`cb:${IP}`])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await stateRow(state)).not.toBeNull()
  })

  it('制限内なら従来どおり token endpoint を呼んでログインし、oauth_state を消費する', async () => {
    const { state, nonce } = await startGoogle()
    const { limiter, keys } = fakeLimiter(true)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ id_token: idToken(nonce, 'rate-limit-cb-allowed') }))
    const res = await callback(state, limiter)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/name?welcome=1')
    expect(keys).toEqual([`cb:${IP}`])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await stateRow(state)).toBeNull()
  })

  it('limit() が throw しても素通し', async () => {
    const { state, nonce } = await startGoogle()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ id_token: idToken(nonce, 'rate-limit-cb-throw') }),
    )
    const res = await callback(state, throwingLimiter)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/name?welcome=1')
  })

  it('存在しない provider は 404 で、limiter を呼ばない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    const res = await app.request(
      '/auth/nope/callback',
      { headers: { 'CF-Connecting-IP': IP } },
      { ...google, AUTH_LIMITER: limiter },
    )
    expect(res.status).toBe(404)
    expect(keys).toEqual([])
  })
})

describe('/api/agent/*', () => {
  let ownerCookie = ''

  beforeAll(async () => {
    ownerCookie = (await loginAs(env, { subject: 'rate-limit-owner', owner: true })).cookie
  })

  // テストごとに専用のトークンを画面から発行する（last_used_at の検証を実行順に依存させない）
  const issue = async (name: string) => {
    const res = await app.request(
      '/admin/tokens',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: ownerCookie,
        },
        body: new URLSearchParams({ name, days: '90' }).toString(),
      },
      env,
    )
    const token = /nzt_[A-Za-z0-9_-]{43}/.exec(await res.text())?.[0]
    if (!token) throw new Error('平文が表示されていない')
    return token
  }

  const lastUsedAt = async (name: string) =>
    (
      await env.DB.prepare('SELECT last_used_at FROM api_token WHERE name = ?')
        .bind(name)
        .first<{ last_used_at: string | null }>()
    )?.last_used_at

  const call = (
    token: string,
    limiter: RateLimit,
    headers: Record<string, string> = { 'CF-Connecting-IP': IP },
  ) =>
    app.request(
      '/api/agent/requests',
      { headers: { Authorization: `Bearer ${token}`, ...headers } },
      { ...env, AGENT_LIMITER: limiter },
    )

  it('制限に掛かると 429 JSON・Retry-After: 60 で、requireAgent の D1 読みが走らない', async () => {
    const token = await issue('rate-limit-denied')
    const { limiter, keys } = fakeLimiter(false)
    const res = await call(token, limiter)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expect(keys).toEqual([`agent:${IP}`])
    expect(await lastUsedAt('rate-limit-denied')).toBeNull()
  })

  it('制限内なら従来どおり認証して 200', async () => {
    const token = await issue('rate-limit-allowed')
    const { limiter, keys } = fakeLimiter(true)
    const res = await call(token, limiter)
    expect(res.status).toBe(200)
    expect(keys).toEqual([`agent:${IP}`])
    expect(await lastUsedAt('rate-limit-allowed')).not.toBeNull()
  })

  it('CF-Connecting-IP が無ければ limiter を呼ばずに素通し', async () => {
    const token = await issue('rate-limit-no-ip')
    const { limiter, keys } = fakeLimiter(false)
    const res = await call(token, limiter, {})
    expect(res.status).toBe(200)
    expect(keys).toEqual([])
  })

  it('limit() が throw しても素通し', async () => {
    const token = await issue('rate-limit-throw')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call(token, throwingLimiter)
    expect(res.status).toBe(200)
    expect(await lastUsedAt('rate-limit-throw')).not.toBeNull()
  })
})

describe('制限を掛けない入口', () => {
  it('/_dev/login と POST /requests では limiter を呼ばない', async () => {
    const auth = fakeLimiter(false)
    const agent = fakeLimiter(false)
    const limited = { ...env, AUTH_LIMITER: auth.limiter, AGENT_LIMITER: agent.limiter }
    const headers = {
      Origin: ORIGIN,
      'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': IP,
    }
    const login = await app.request(
      '/_dev/login',
      {
        method: 'POST',
        headers,
        body: new URLSearchParams({ subject: 'rate-limit-dev' }).toString(),
      },
      { ...limited, AUTH_DEV_LOGIN: '1' },
    )
    expect(login.status).toBe(302)
    const cookie = (
      login.headers.getSetCookie().find((sc) => sc.startsWith('session=')) ?? ''
    ).split(';')[0]

    const res = await app.request(
      '/requests',
      {
        method: 'POST',
        headers: { ...headers, Cookie: cookie },
        body: new URLSearchParams({ kind: 'other', note: 'レート制限のテスト' }).toString(),
      },
      limited,
    )
    expect(res.status).toBe(302)
    expect(auth.keys).toEqual([])
    expect(agent.keys).toEqual([])
  })
})
