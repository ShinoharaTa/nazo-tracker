import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAndVerifyLineIdToken } from '../src/auth/providers/line'
import { findOAuthProvider, oauthProviders } from '../src/auth/providers/types'
import app from '../src/index'
import { sha256Base64url } from '../src/lib/random'
import { sessionCookieOf } from './helpers/auth'

const CLIENT_ID = '1234567890'
const on: Cloudflare.Env = {
  ...env,
  LINE_CLIENT_ID: CLIENT_ID,
  LINE_CLIENT_SECRET: 'test-line-secret',
}

const b64url = (v: unknown) =>
  btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// 署名は検証しない仕様なので、署名部は任意の文字列でよい
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.not-a-real-signature`

const claims = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: 'https://access.line.me',
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  sub: 'U0123456789abcdef0123456789abcdef',
  nonce,
  ...extra,
})

// /auth/line を叩いて state・nonce・cookie を取り出す
const begin = async (e: Cloudflare.Env = on) => {
  const res = await app.request('/auth/line', {}, e)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  const nonce = location.searchParams.get('nonce') ?? ''
  return { res, location, state, nonce, cookie: `oauth=${state}` }
}

const callback = (query: string, cookie?: string, e: Cloudflare.Env = on) =>
  app.request(`/auth/line/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} }, e)

const stateRow = (state: string) =>
  env.DB.prepare('SELECT * FROM oauth_state WHERE state = ?')
    .bind(state)
    .first<{ provider: string; code_verifier: string; mode: string; nonce: string | null }>()

// token endpoint を差し替える
const mockToken = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body, { status }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('oauthProviders', () => {
  it('line が登録されている', () => {
    expect(oauthProviders.line?.name).toBe('line')
    expect(findOAuthProvider('line')).toMatchObject({
      name: 'line',
      label: 'LINE',
      usesNonce: true,
      tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
    })
  })
})

describe('GET /auth/line', () => {
  it('LINE_CLIENT_ID が未設定（wrangler.toml の既定値 ""）なら 503', async () => {
    expect(env.LINE_CLIENT_ID).toBe('')
    const res = await app.request('/auth/line', {}, env)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('LINE ログインは準備中です')
  })

  it('LINE_CLIENT_SECRET が空でも 503', async () => {
    const res = await app.request('/auth/line', {}, { ...on, LINE_CLIENT_SECRET: '' })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('LINE ログインは準備中です')
  })

  it('認可 URL へ 302。PKCE S256・scope=openid・nonce・redirect_uri を付け、oauth_state を作る', async () => {
    const { res, location, state, nonce } = await begin()
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://access.line.me/oauth2/v2.1/authorize',
    )
    const raw = res.headers.get('location') ?? ''
    expect(raw).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fline%2Fcallback')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('scope')).toBe('openid')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const row = await stateRow(state)
    expect(row).toMatchObject({ provider: 'line', mode: 'login', nonce })
    expect(raw).not.toContain(row?.code_verifier ?? '')
    expect(location.searchParams.get('code_challenge')).toBe(
      await sha256Base64url(row?.code_verifier ?? ''),
    )
  })
})

describe('GET /auth/line/callback', () => {
  it('token endpoint に PKCE の code_verifier を送り、identity(line, sub) を作って初回は 302 /settings/name?welcome=1', async () => {
    const sub = 'U-line-happy'
    const { state, nonce, cookie } = await begin()
    const row = await stateRow(state)
    const fetchSpy = mockToken({ access_token: 'at', id_token: jwt(claims(nonce, { sub })) })
    const res = await callback(`state=${state}&code=the-code`, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/name?welcome=1')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.line.me/oauth2/v2.1/token')
    expect(init?.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:8787/auth/line/callback',
      client_id: CLIENT_ID,
      client_secret: 'test-line-secret',
      code_verifier: row?.code_verifier,
    })

    const ident = await env.DB.prepare(
      "SELECT user_id FROM identity WHERE provider = 'line' AND subject = ?",
    )
      .bind(sub)
      .first<{ user_id: string }>()
    expect(ident).not.toBeNull()

    // ログイン後の /settings では LINE が連携済み
    const settings = await app.request(
      '/settings',
      { headers: { Cookie: sessionCookieOf(res) ?? '' } },
      on,
    )
    const html = await settings.text()
    expect(html).toMatch(/<span>LINE<\/span><span class="note">連携済み<\/span>/)
    expect(html).toMatch(/<span>Google<\/span><span class="note">未連携<\/span>/)
  })

  it('ID トークンの nonce が oauth_state と違えば failed（identity は作らない）', async () => {
    const { state, cookie } = await begin()
    mockToken({ id_token: jwt(claims('other-nonce', { sub: 'U-bad-nonce' })) })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    const row = await env.DB.prepare(
      "SELECT 1 FROM identity WHERE provider = 'line' AND subject = 'U-bad-nonce'",
    ).first()
    expect(row).toBeNull()
  })

  it("OWNER_IDENTITIES = 'line:<sub>' なら owner になる", async () => {
    const sub = 'U-line-owner'
    const e = { ...on, OWNER_IDENTITIES: `line:${sub}` }
    const { state, nonce, cookie } = await begin(e)
    mockToken({ id_token: jwt(claims(nonce, { sub })) })
    const res = await callback(`state=${state}&code=c`, cookie, e)
    expect(res.headers.get('location')).toBe('/settings/name?welcome=1')
    const u = await env.DB.prepare(
      "SELECT u.role FROM user u JOIN identity i ON i.user_id = u.id WHERE i.provider = 'line' AND i.subject = ?",
    )
      .bind(sub)
      .first<{ role: string }>()
    expect(u?.role).toBe('owner')
  })
})

describe('parseAndVerifyLineIdToken', () => {
  const ctx = { clientId: CLIENT_ID, nonce: 'n-1' }

  it('iss / aud / exp / nonce が合えば sub を返す', () => {
    expect(parseAndVerifyLineIdToken(jwt(claims('n-1')), ctx)).toBe(
      'U0123456789abcdef0123456789abcdef',
    )
  })

  it.each([
    ['iss（別サイト）', { iss: 'https://evil.example.com' }],
    ['iss（Google）', { iss: 'https://accounts.google.com' }],
    ['iss（スキーム無し）', { iss: 'access.line.me' }],
    ['aud', { aud: 'other-channel' }],
    ['aud（配列）', { aud: [CLIENT_ID] }],
    ['exp（過去）', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['exp（無し）', { exp: undefined }],
    ['nonce', { nonce: 'n-2' }],
    ['sub（無し）', { sub: undefined }],
    ['sub（空）', { sub: '' }],
  ])('%s が崩れていたら null', (_, extra) => {
    expect(parseAndVerifyLineIdToken(jwt(claims('n-1', extra)), ctx)).toBeNull()
  })

  it('oauth_state.nonce が NULL なら null', () => {
    expect(
      parseAndVerifyLineIdToken(jwt(claims('n-1')), { clientId: CLIENT_ID, nonce: null }),
    ).toBeNull()
  })
})

describe('/login のボタン', () => {
  it('LINE_CLIENT_ID が無ければ LINE は「準備中」で無効', async () => {
    const html = await (await app.request('/login', {}, env)).text()
    expect(html).not.toContain('href="/auth/line"')
    expect(html).toMatch(/aria-disabled="true" disabled="">LINE でログイン（準備中）<\/button>/)
  })

  it('LINE_CLIENT_SECRET が空でも「準備中」で無効', async () => {
    const html = await (await app.request('/login', {}, { ...on, LINE_CLIENT_SECRET: '' })).text()
    expect(html).not.toContain('href="/auth/line"')
    expect(html).toContain('LINE でログイン（準備中）')
  })

  it('LINE_CLIENT_ID があれば /auth/line へのリンク', async () => {
    const html = await (await app.request('/login', {}, on)).text()
    expect(html).toContain('href="/auth/line">LINE でログイン</a>')
  })
})
