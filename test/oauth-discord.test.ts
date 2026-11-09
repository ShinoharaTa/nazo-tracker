import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'
import { sha256Base64url } from '../src/lib/random'
import { sessionCookieOf } from './helpers/auth'

const CLIENT_ID = '123456789012345678'
const on: Cloudflare.Env = {
  ...env,
  DISCORD_CLIENT_ID: CLIENT_ID,
  DISCORD_CLIENT_SECRET: 'test-discord-secret',
}

const TOKEN_URL = 'https://discord.com/api/oauth2/token'
const ME_URL = 'https://discord.com/api/users/@me'

const oauthCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((sc) => sc.startsWith('oauth=') && !sc.startsWith('oauth=;'))

// /auth/discord を叩いて state・cookie を取り出す
const begin = async (e: Cloudflare.Env = on) => {
  const res = await app.request('/auth/discord', {}, e)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  return { res, location, state, cookie: `oauth=${state}` }
}

const callback = (query: string, cookie?: string, e: Cloudflare.Env = on) =>
  app.request(`/auth/discord/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} }, e)

const stateRow = (state: string) =>
  env.DB.prepare('SELECT * FROM oauth_state WHERE state = ?').bind(state).first<{
    provider: string
    code_verifier: string
    mode: string
    nonce: string | null
  }>()

const token = (extra: Record<string, unknown> = {}) => ({
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 604800,
  refresh_token: 'rt',
  scope: 'identify',
  ...extra,
})

// token endpoint と /users/@me を差し替える。外部へは通信しない
const mockDiscord = ({
  tokenBody = token(),
  tokenStatus = 200,
  meBody = { id: 'discord-id-1', username: 'someone' } as unknown,
  meStatus = 200,
}: {
  tokenBody?: unknown
  tokenStatus?: number
  meBody?: unknown
  meStatus?: number
} = {}) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url === TOKEN_URL) return Response.json(tokenBody, { status: tokenStatus })
    if (url === ME_URL) return Response.json(meBody, { status: meStatus })
    throw new Error(`unexpected fetch: ${url}`)
  })

const identityOf = (subject: string) =>
  env.DB.prepare("SELECT user_id FROM identity WHERE provider = 'discord' AND subject = ?")
    .bind(subject)
    .first<{ user_id: string }>()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /auth/discord', () => {
  it('DISCORD_CLIENT_ID が未設定（wrangler.toml の既定値 ""）なら 503', async () => {
    expect(env.DISCORD_CLIENT_ID).toBe('')
    const res = await app.request('/auth/discord', {}, env)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Discord ログインは準備中です')
  })

  it('DISCORD_CLIENT_SECRET が空でも 503', async () => {
    const res = await app.request('/auth/discord', {}, { ...on, DISCORD_CLIENT_SECRET: '' })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Discord ログインは準備中です')
  })

  it('認可 URL へ 302。PKCE S256・scope=identify・prompt=none を付け、nonce は付けない。oauth_state.nonce は NULL', async () => {
    const { res, location, state } = await begin()
    expect(`${location.origin}${location.pathname}`).toBe('https://discord.com/oauth2/authorize')
    const raw = res.headers.get('location') ?? ''
    expect(raw).toContain('code_challenge_method=S256')
    expect(raw).toContain('scope=identify')
    expect(raw).toContain('prompt=none')
    expect(raw).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fdiscord%2Fcallback')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.has('nonce')).toBe(false)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const sc = oauthCookieOf(res)
    expect(sc).toMatch(new RegExp(`^oauth=${state};`))
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Max-Age=600')

    const row = await stateRow(state)
    expect(row).toMatchObject({
      provider: 'discord',
      mode: 'login',
      nonce: null,
    })
    expect(raw).not.toContain(row?.code_verifier ?? '')
    expect(location.searchParams.get('code_challenge')).toBe(
      await sha256Base64url(row?.code_verifier ?? ''),
    )
  })
})

describe('GET /auth/discord/callback の失敗', () => {
  it('Google の state では通らない（provider も照合する）', async () => {
    const res = await app.request(
      '/auth/google',
      {},
      {
        ...on,
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 'g',
      },
    )
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const fetchSpy = mockDiscord()
    const cb = await callback(`state=${state}&code=c`, `oauth=${state}`)
    expect(cb.headers.get('location')).toBe('/login?error=failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('code が無ければ failed', async () => {
    const fetchSpy = mockDiscord()
    const { state, cookie } = await begin()
    const res = await callback(`state=${state}`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('?error=access_denied は /login?error=denied', async () => {
    const { state, cookie } = await begin()
    const res = await callback(`error=access_denied&state=${state}`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=denied')
  })

  it('token 応答が JSON でなければ failed', async () => {
    const { state, cookie } = await begin()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>oops</html>'))
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('token endpoint が非 2xx なら failed（/users/@me は呼ばない）', async () => {
    const { state, cookie } = await begin()
    const fetchSpy = mockDiscord({
      tokenBody: { error: 'invalid_grant' },
      tokenStatus: 400,
    })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['scope に identify が無い', token({ scope: 'email guilds' })],
    ['scope が無い', token({ scope: undefined })],
    ['token_type が Bearer でない', token({ token_type: 'Basic' })],
    ['access_token が無い', token({ access_token: undefined })],
  ])('%s なら failed（/users/@me は呼ばない）', async (_, tokenBody) => {
    const { state, cookie } = await begin()
    const fetchSpy = mockDiscord({ tokenBody })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('/users/@me が非 2xx なら failed', async () => {
    const { state, cookie } = await begin()
    mockDiscord({ meBody: { message: '401: Unauthorized' }, meStatus: 401 })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it.each([
    ['id が無い', { username: 'someone' }],
    ['id が空', { id: '' }],
    ['id が文字列でない', { id: 123 }],
    ['JSON が配列', []],
  ])('/users/@me の %s なら failed', async (_, meBody) => {
    const { state, cookie } = await begin()
    mockDiscord({ meBody })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('/users/@me の fetch が例外を投げたら failed', async () => {
    const { state, cookie } = await begin()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === TOKEN_URL) return Response.json(token())
      throw new TypeError('network')
    })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('失敗時の console.error に code・access_token の値を出さない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = 'secret-code-value'
    const accessToken = 'secret-access-token-value'

    // token endpoint が非 2xx（応答本文にもトークンらしき値を入れておく）
    const a = await begin()
    mockDiscord({
      tokenBody: { error: 'invalid_grant', access_token: accessToken },
      tokenStatus: 400,
    })
    expect(
      (await callback(`state=${a.state}&code=${code}`, a.cookie)).headers.get('location'),
    ).toBe('/login?error=failed')

    // /users/@me が非 2xx
    const b = await begin()
    mockDiscord({
      tokenBody: token({ access_token: accessToken }),
      meStatus: 401,
    })
    expect(
      (await callback(`state=${b.state}&code=${code}`, b.cookie)).headers.get('location'),
    ).toBe('/login?error=failed')

    expect(errors).toHaveBeenCalled()
    const out = errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    for (const secret of [code, accessToken]) {
      expect(out).not.toContain(secret)
    }
  })
})

describe('GET /auth/discord/callback の成功', () => {
  it('token endpoint に PKCE の code_verifier を送り、/users/@me を Bearer で呼び、identity(discord, id) を作って 302 /records', async () => {
    const id = '987654321098765432'
    const { state, cookie } = await begin()
    const row = await stateRow(state)
    const fetchSpy = mockDiscord({
      tokenBody: token({ access_token: 'the-access-token', scope: 'identify' }),
      meBody: {
        id,
        username: 'should-not-be-saved',
        global_name: 'もっと名前',
      },
    })
    const res = await callback(`state=${state}&code=the-code`, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0]
    expect(tokenUrl).toBe(TOKEN_URL)
    expect(tokenInit?.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:8787/auth/discord/callback',
      client_id: CLIENT_ID,
      client_secret: 'test-discord-secret',
      code_verifier: row?.code_verifier,
    })
    const [meUrl, meInit] = fetchSpy.mock.calls[1]
    expect(meUrl).toBe(ME_URL)
    expect(new Headers(meInit?.headers).get('Authorization')).toBe('Bearer the-access-token')

    expect(sessionCookieOf(res)).not.toBeNull()
    expect(await stateRow(state)).toBeNull()

    const ident = await identityOf(id)
    expect(ident).not.toBeNull()
    // username は保存しない。表示名は既定値のまま
    const u = await env.DB.prepare('SELECT display_name, role FROM user WHERE id = ?')
      .bind(ident?.user_id)
      .first()
    expect(u).toEqual({ display_name: 'ななしさん', role: 'member' })

    // scope に他の値が並んでいても identify があれば通る。2 回目は同じ user
    const second = await begin()
    mockDiscord({
      tokenBody: token({ scope: 'email identify' }),
      meBody: { id },
    })
    const res2 = await callback(`state=${second.state}&code=c2`, second.cookie)
    expect(res2.headers.get('location')).toBe('/records')
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identity WHERE provider = 'discord' AND subject = ?",
    )
      .bind(id)
      .first<{ n: number }>()
    expect(n?.n).toBe(1)

    // ログイン後の /settings では Discord が連携済み、Google は未連携
    const settings = await app.request(
      '/settings',
      { headers: { Cookie: sessionCookieOf(res2) ?? '' } },
      on,
    )
    const html = await settings.text()
    expect(html).toMatch(/<span>Discord<\/span><span class="note">連携済み<\/span>/)
    expect(html).toMatch(/<span>Google<\/span><span class="note">未連携<\/span>/)
  })

  it("OWNER_IDENTITIES = 'discord:<id>' なら owner になる", async () => {
    const id = '111111111111111111'
    const e = { ...on, OWNER_IDENTITIES: `discord:${id}` }
    const { state, cookie } = await begin(e)
    mockDiscord({ meBody: { id } })
    const res = await callback(`state=${state}&code=c`, cookie, e)
    expect(res.headers.get('location')).toBe('/records')
    const u = await env.DB.prepare(
      "SELECT u.role FROM user u JOIN identity i ON i.user_id = u.id WHERE i.provider = 'discord' AND i.subject = ?",
    )
      .bind(id)
      .first<{ role: string }>()
    expect(u?.role).toBe('owner')
  })
})

describe('/login のボタン', () => {
  it('DISCORD_CLIENT_ID が無ければ Discord は「準備中」で無効', async () => {
    const html = await (await app.request('/login', {}, env)).text()
    expect(html).not.toContain('href="/auth/discord"')
    expect(html).toMatch(/aria-disabled="true" disabled="">Discord でログイン（準備中）<\/button>/)
  })

  it('DISCORD_CLIENT_SECRET が空でも「準備中」で無効', async () => {
    const html = await (
      await app.request('/login', {}, { ...on, DISCORD_CLIENT_SECRET: '' })
    ).text()
    expect(html).not.toContain('href="/auth/discord"')
    expect(html).toContain('Discord でログイン（準備中）')
  })

  it('設定済みなら /auth/discord へのリンク', async () => {
    const html = await (await app.request('/login', {}, on)).text()
    expect(html).toContain('<a class="btn" href="/auth/discord">Discord でログイン</a>')
    expect(html).toContain('Google でログイン（準備中）')
  })
})
