import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAndVerifyIdToken } from '../src/auth/providers/google'
import app from '../src/index'
import { sha256Base64url } from '../src/lib/random'
import { loginAs, sessionCookieOf } from './helpers/auth'

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const on: Cloudflare.Env = {
  ...env,
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
}

const b64url = (v: unknown) =>
  btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// 署名は検証しない仕様なので、署名部は任意の文字列でよい
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.not-a-real-signature`

const claims = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 3600,
  sub: 'google-sub-1',
  nonce,
  ...extra,
})

const oauthCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((sc) => sc.startsWith('oauth=') && !sc.startsWith('oauth=;'))

// /auth/google を叩いて state・nonce・cookie を取り出す
const begin = async (e: Cloudflare.Env = on) => {
  const res = await app.request('/auth/google', {}, e)
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state') ?? ''
  const nonce = location.searchParams.get('nonce') ?? ''
  return { res, location, state, nonce, cookie: `oauth=${state}` }
}

const callback = (query: string, cookie?: string, e: Cloudflare.Env = on) =>
  app.request(`/auth/google/callback?${query}`, { headers: cookie ? { Cookie: cookie } : {} }, e)

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

describe('GET /auth/:provider', () => {
  it('GOOGLE_CLIENT_ID が未設定（wrangler.toml の既定値 ""）なら 503', async () => {
    expect(env.GOOGLE_CLIENT_ID).toBe('')
    const res = await app.request('/auth/google', {}, env)
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Google ログインは準備中です')
  })

  it('GOOGLE_CLIENT_SECRET が空でも 503', async () => {
    const res = await app.request('/auth/google', {}, { ...on, GOOGLE_CLIENT_SECRET: '' })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Google ログインは準備中です')
  })

  it('APP_ORIGIN の末尾の / は落として redirect_uri を作る', async () => {
    const { location } = await begin({ ...on, APP_ORIGIN: 'http://127.0.0.1:8787/' })
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8787/auth/google/callback',
    )
  })

  it.each(['/auth/twitter', '/auth/twitter/callback', '/auth/constructor'])(
    '未知のプロバイダ %s は 404',
    async (path) => {
      expect((await app.request(path, {}, on)).status).toBe(404)
    },
  )

  it('認可 URL へ 302。PKCE S256・scope=openid・nonce・redirect_uri を付け、oauth cookie と oauth_state を作る', async () => {
    const { res, location, state, nonce } = await begin()
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    const raw = res.headers.get('location') ?? ''
    expect(raw).toContain('code_challenge_method=S256')
    expect(raw).toContain('scope=openid')
    expect(raw).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Fauth%2Fgoogle%2Fcallback')
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const sc = oauthCookieOf(res)
    expect(sc).toMatch(new RegExp(`^oauth=${state};`))
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).toContain('Max-Age=600')
    expect(sc).not.toContain('Secure')

    const row = await stateRow(state)
    expect(row).toMatchObject({ provider: 'google', mode: 'login', nonce })
    // code_verifier は URL にも cookie にも出さず、challenge だけを渡す
    expect(raw).not.toContain(row?.code_verifier ?? '')
    expect(location.searchParams.get('code_challenge')).toBe(
      await sha256Base64url(row?.code_verifier ?? ''),
    )
  })

  it('ログイン中なら 302 /records（oauth_state は作らない）', async () => {
    const { cookie } = await loginAs(env, { subject: 'oauth-already' })
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_state').first<{
      n: number
    }>()
    const res = await app.request('/auth/google', { headers: { Cookie: cookie } }, on)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_state').first<{
      n: number
    }>()
    expect(after?.n).toBe(before?.n)
  })
})

describe('GET /auth/google/callback の失敗', () => {
  it('oauth cookie が無いと failed。D1 は触らないので oauth_state の行は残る', async () => {
    const { state } = await begin()
    const res = await callback(`state=${state}&code=c`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(await stateRow(state)).not.toBeNull()
  })

  it('oauth cookie が別の値なら failed。行は残る', async () => {
    const { state } = await begin()
    const other = await begin()
    const res = await callback(`state=${state}&code=c`, other.cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(await stateRow(state)).not.toBeNull()
  })

  it('state が無いと failed', async () => {
    const { cookie } = await begin()
    const res = await callback('code=c', cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('期限切れなら failed。行は DELETE RETURNING で消えている', async () => {
    const fetchSpy = mockToken({})
    const { state, cookie } = await begin()
    await env.DB.prepare('UPDATE oauth_state SET expires_at = ? WHERE state = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), state)
      .run()
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(await stateRow(state)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('同じ state で 2 回目は failed', async () => {
    const { state, nonce, cookie } = await begin()
    mockToken({ id_token: jwt(claims(nonce, { sub: 'twice' })) })
    const first = await callback(`state=${state}&code=c`, cookie)
    expect(first.headers.get('location')).toBe('/records')
    const second = await callback(`state=${state}&code=c`, cookie)
    expect(second.headers.get('location')).toBe('/login?error=failed')
  })

  it('?error=access_denied は /login?error=denied で、oauth cookie を消す。D1 の行は残る', async () => {
    const { state, cookie } = await begin()
    const res = await callback(`error=access_denied&state=${state}`, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=denied')
    expect(
      res.headers.getSetCookie().some((sc) => sc.startsWith('oauth=;') && /Max-Age=0/.test(sc)),
    ).toBe(true)
    expect(await stateRow(state)).not.toBeNull()
  })

  it('code が無ければ failed', async () => {
    const fetchSpy = mockToken({})
    const { state, cookie } = await begin()
    const res = await callback(`state=${state}`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('token 応答が JSON でなければ failed', async () => {
    const { state, cookie } = await begin()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>oops</html>'))
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('失敗時の console.error に code・id_token・access_token の値を出さない', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = 'secret-code-value'
    const accessToken = 'secret-access-token-value'

    // token endpoint が非 2xx（応答本文にもトークンらしき値を入れておく）
    const a = await begin()
    mockToken({ error: 'invalid_grant', access_token: accessToken }, 400)
    expect(
      (await callback(`state=${a.state}&code=${code}`, a.cookie)).headers.get('location'),
    ).toBe('/login?error=failed')

    // ID トークンが不正（nonce 不一致）
    const b = await begin()
    const idToken = jwt(claims('other-nonce'))
    mockToken({ access_token: accessToken, id_token: idToken })
    expect(
      (await callback(`state=${b.state}&code=${code}`, b.cookie)).headers.get('location'),
    ).toBe('/login?error=failed')

    expect(errors).toHaveBeenCalled()
    const out = errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n')
    for (const secret of [code, accessToken, idToken, ...idToken.split('.')]) {
      expect(out).not.toContain(secret)
    }
  })

  it('token endpoint が非 2xx なら failed', async () => {
    const { state, cookie } = await begin()
    mockToken({ error: 'invalid_grant' }, 400)
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('fetch が例外を投げたら failed', async () => {
    const { state, cookie } = await begin()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'))
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })

  it('ID トークンの nonce が oauth_state と違えば failed（identity は作らない）', async () => {
    const { state, cookie } = await begin()
    mockToken({ id_token: jwt(claims('other-nonce', { sub: 'bad-nonce' })) })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
    const row = await env.DB.prepare(
      "SELECT 1 FROM identity WHERE provider = 'google' AND subject = 'bad-nonce'",
    ).first()
    expect(row).toBeNull()
  })

  it('id_token が無ければ failed', async () => {
    const { state, cookie } = await begin()
    mockToken({ access_token: 'x' })
    const res = await callback(`state=${state}&code=c`, cookie)
    expect(res.headers.get('location')).toBe('/login?error=failed')
  })
})

describe('GET /auth/google/callback の成功', () => {
  it('token endpoint に PKCE の code_verifier を送り、identity と session を作って 302 /records。2 回目も /records', async () => {
    const sub = 'google-happy'
    const first = await begin()
    const row = await stateRow(first.state)
    const fetchSpy = mockToken({ access_token: 'at', id_token: jwt(claims(first.nonce, { sub })) })
    const res = await callback(`state=${first.state}&code=the-code`, first.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')

    // token endpoint への要求
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init?.method).toBe('POST')
    const body = new URLSearchParams(String(init?.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'http://127.0.0.1:8787/auth/google/callback',
      client_id: CLIENT_ID,
      client_secret: 'test-client-secret',
      code_verifier: row?.code_verifier,
    })

    // oauth cookie を消し、session cookie を出す。oauth_state は消える
    expect(
      res.headers.getSetCookie().some((sc) => sc.startsWith('oauth=;') && /Max-Age=0/.test(sc)),
    ).toBe(true)
    expect(sessionCookieOf(res)).not.toBeNull()
    expect(await stateRow(first.state)).toBeNull()

    const ident = await env.DB.prepare(
      "SELECT user_id FROM identity WHERE provider = 'google' AND subject = ?",
    )
      .bind(sub)
      .first<{ user_id: string }>()
    expect(ident).not.toBeNull()
    const sessions = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM session_token WHERE user_id = ?',
    )
      .bind(ident?.user_id)
      .first<{ n: number }>()
    expect(sessions?.n).toBe(1)
    const u = await env.DB.prepare('SELECT display_name, role FROM user WHERE id = ?')
      .bind(ident?.user_id)
      .first()
    expect(u).toEqual({ display_name: 'ななしさん', role: 'member' })

    // 2 回目は同じ user
    const second = await begin()
    mockToken({ id_token: jwt(claims(second.nonce, { sub })) })
    const res2 = await callback(`state=${second.state}&code=c2`, second.cookie)
    expect(res2.headers.get('location')).toBe('/records')
    const users = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identity WHERE provider = 'google' AND subject = ?",
    )
      .bind(sub)
      .first<{ n: number }>()
    expect(users?.n).toBe(1)

    // ログイン後の /settings では Google が連携済み、Discord は未連携
    const settings = await app.request(
      '/settings',
      { headers: { Cookie: sessionCookieOf(res2) ?? '' } },
      on,
    )
    const html = await settings.text()
    expect(html).toMatch(/<span>Google<\/span><span class="note">連携済み<\/span>/)
    expect(html).toMatch(/<span>Discord<\/span><span class="note">未連携<\/span>/)
  })

  it('ログイン中に callback に来たら session を張り替え、旧 session_token 行を消す', async () => {
    const { cookie: oldCookie, userId } = await loginAs(env, { subject: 'oauth-relogin' })
    const oldIds = (
      await env.DB.prepare('SELECT id FROM session_token WHERE user_id = ?')
        .bind(userId)
        .all<{ id: string }>()
    ).results.map((r) => r.id)
    expect(oldIds).toHaveLength(1)

    const { state, nonce, cookie } = await begin()
    mockToken({ id_token: jwt(claims(nonce, { sub: 'google-relogin' })) })
    const res = await callback(`state=${state}&code=c`, `${oldCookie}; ${cookie}`)
    expect(res.headers.get('location')).toBe('/records')
    const newCookie = sessionCookieOf(res)
    expect(newCookie).not.toBeNull()
    expect(newCookie).not.toBe(oldCookie)
    const left = await env.DB.prepare('SELECT 1 FROM session_token WHERE id = ?')
      .bind(oldIds[0])
      .first()
    expect(left).toBeNull()
  })

  it("OWNER_IDENTITIES = 'google:<sub>' なら owner になる", async () => {
    const sub = 'google-owner'
    const e = { ...on, OWNER_IDENTITIES: `google:${sub}` }
    const { state, nonce, cookie } = await begin(e)
    mockToken({ id_token: jwt(claims(nonce, { sub })) })
    const res = await callback(`state=${state}&code=c`, cookie, e)
    expect(res.headers.get('location')).toBe('/records')
    const u = await env.DB.prepare(
      "SELECT u.role FROM user u JOIN identity i ON i.user_id = u.id WHERE i.provider = 'google' AND i.subject = ?",
    )
      .bind(sub)
      .first<{ role: string }>()
    expect(u?.role).toBe('owner')
  })
})

describe('parseAndVerifyIdToken', () => {
  const ctx = { clientId: CLIENT_ID, nonce: 'n-1' }

  it('iss / aud / exp / nonce が合えば sub を返す。署名部は任意の文字列で通る', () => {
    expect(parseAndVerifyIdToken(jwt(claims('n-1')), ctx)).toBe('google-sub-1')
    const [h, p] = jwt(claims('n-1')).split('.')
    expect(parseAndVerifyIdToken(`${h}.${p}.`, ctx)).toBe('google-sub-1')
  })

  it("iss は 'accounts.google.com' も受け付ける", () => {
    expect(parseAndVerifyIdToken(jwt(claims('n-1', { iss: 'accounts.google.com' })), ctx)).toBe(
      'google-sub-1',
    )
  })

  it.each([
    ['iss', { iss: 'https://evil.example.com' }],
    ['aud', { aud: 'other-client' }],
    ['aud（配列）', { aud: [CLIENT_ID] }],
    ['exp（過去）', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['exp（無し）', { exp: undefined }],
    ['nonce', { nonce: 'n-2' }],
    ['sub（無し）', { sub: undefined }],
    ['sub（空）', { sub: '' }],
  ])('%s が崩れていたら null', (_, extra) => {
    expect(parseAndVerifyIdToken(jwt(claims('n-1', extra)), ctx)).toBeNull()
  })

  it.each([
    ['文字列でない', 123],
    ['2 分割', 'a.b'],
    ['payload が JSON でない', 'a.!!!.c'],
  ])('形が崩れていたら null（%s）', (_, token) => {
    expect(parseAndVerifyIdToken(token, ctx)).toBeNull()
  })

  it('oauth_state.nonce が NULL なら null', () => {
    expect(
      parseAndVerifyIdToken(jwt(claims('n-1')), { clientId: CLIENT_ID, nonce: null }),
    ).toBeNull()
  })
})

describe('/login のボタン', () => {
  it('GOOGLE_CLIENT_ID が無ければ Google は「準備中」で無効', async () => {
    const html = await (await app.request('/login', {}, env)).text()
    expect(html).not.toContain('href="/auth/google"')
    expect(html).toMatch(/aria-disabled="true" disabled="">Google でログイン（準備中）<\/button>/)
  })

  it('GOOGLE_CLIENT_SECRET が空でも「準備中」で無効', async () => {
    const html = await (await app.request('/login', {}, { ...on, GOOGLE_CLIENT_SECRET: '' })).text()
    expect(html).not.toContain('href="/auth/google"')
    expect(html).toContain('Google でログイン（準備中）')
  })

  it('GOOGLE_CLIENT_ID があれば /auth/google へのリンク。未設定の Discord は「準備中」', async () => {
    const html = await (await app.request('/login', {}, on)).text()
    expect(html).toContain('<a class="btn pri" href="/auth/google">Google でログイン</a>')
    expect(html).not.toContain('href="/auth/discord"')
    expect(html).toContain('Discord でログイン（準備中）')
  })
})
