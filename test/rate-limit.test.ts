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

  it('制限に掛かると 429・Retry-After: 60 で、oauth_state に行が増えない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    const before = await stateCount()
    const res = await begin({ ...google, AUTH_LIMITER: limiter })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(await res.text()).toBe(
      'アクセスが続いています。1 分ほど待ってから、もう一度お試しください。',
    )
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
  it('制限に掛かると 302 /login?error=failed で、oauth_state を消費せず外部 fetch も呼ばない', async () => {
    // 開始はヘッダ無し（制限なし）で済ませ、正しい state と cookie を用意する
    const started = await app.request('/auth/google', {}, google)
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? ''
    expect(await stateRow(state)).not.toBeNull()

    const { limiter, keys } = fakeLimiter(false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request(
      `/auth/google/callback?code=c&state=${state}`,
      { headers: { Cookie: `oauth=${state}`, 'CF-Connecting-IP': IP } },
      { ...google, AUTH_LIMITER: limiter },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(keys).toEqual([`cb:${IP}`])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await stateRow(state)).not.toBeNull()
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
  let token = ''

  beforeAll(async () => {
    const { cookie } = await loginAs(env, { subject: 'rate-limit-owner', owner: true })
    const res = await app.request(
      '/admin/tokens',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: new URLSearchParams({ name: 'rate-limit-cli', days: '90' }).toString(),
      },
      env,
    )
    token = /nzt_[A-Za-z0-9_-]{43}/.exec(await res.text())?.[0] ?? ''
    expect(token).not.toBe('')
  })

  const lastUsedAt = async () =>
    (
      await env.DB.prepare('SELECT last_used_at FROM api_token WHERE name = ?')
        .bind('rate-limit-cli')
        .first<{ last_used_at: string | null }>()
    )?.last_used_at

  const call = (limiter: RateLimit) =>
    app.request(
      '/api/agent/requests',
      { headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': IP } },
      { ...env, AGENT_LIMITER: limiter },
    )

  it('制限に掛かると 429 JSON・Retry-After: 60 で、requireAgent の D1 読みが走らない', async () => {
    const { limiter, keys } = fakeLimiter(false)
    const res = await call(limiter)
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expect(keys).toEqual([`agent:${IP}`])
    expect(await lastUsedAt()).toBeNull()
  })

  it('制限内なら従来どおり認証して 200', async () => {
    const { limiter, keys } = fakeLimiter(true)
    const res = await call(limiter)
    expect(res.status).toBe(200)
    expect(keys).toEqual([`agent:${IP}`])
    expect(await lastUsedAt()).not.toBeNull()
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
