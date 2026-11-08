import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { hashSessionToken } from '../src/auth/session'
import app from '../src/index'
import { loginAs, ORIGIN, sessionCookieOf } from './helpers/auth'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const logout = (headers: Record<string, string>) =>
  app.request(
    '/auth/logout',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    },
    env,
  )

// cookie（session=<token>.<署名> を URL エンコードしたもの）から token を取り出す
const tokenOf = (cookie: string) => {
  const v = decodeURIComponent(cookie.slice('session='.length))
  return v.slice(0, v.lastIndexOf('.'))
}

const sessionRows = (userId: string) =>
  env.DB.prepare('SELECT id, expires_at FROM session_token WHERE user_id = ?')
    .bind(userId)
    .all<{ id: string; expires_at: string }>()
    .then((r) => r.results)

// Set-Cookie で session を消しているか
const clearsSession = (res: Response) =>
  res.headers.getSetCookie().some((sc) => sc.startsWith('session=;') && /Max-Age=0/.test(sc))

const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()

describe('未ログイン', () => {
  it('/records は 302 /login', async () => {
    const res = await get('/records')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('/works は 200', async () => {
    expect((await get('/works')).status).toBe(200)
  })

  it('POST /auth/logout は 401', async () => {
    const res = await logout({ Origin: ORIGIN })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('ログインが必要です')
  })

  it('/ は 302 /login', async () => {
    const res = await get('/')
    expect(res.headers.get('location')).toBe('/login')
  })
})

describe('ログイン後', () => {
  it('cookie の属性', async () => {
    const { res } = await loginAs(env, { subject: 'attr' })
    const sc = res.headers
      .getSetCookie()
      .find((s) => s.startsWith('session=') && !s.startsWith('session=;'))
    expect(sc).toMatch(/Max-Age=2592000/)
    expect(sc).toMatch(/Path=\//)
    expect(sc).toMatch(/HttpOnly/)
    expect(sc).toMatch(/SameSite=Lax/)
    // APP_ORIGIN が http: なので Secure は付けない
    expect(sc).not.toMatch(/Secure/)
  })

  // PR-2 で初回は /settings/name?welcome=1 に切り替える
  it('初回も 2 回目も /records へ', async () => {
    const first = await loginAs(env, { subject: 'redir' })
    expect(first.res.headers.get('location')).toBe('/records')
    const second = await loginAs(env, { subject: 'redir' })
    expect(second.res.headers.get('location')).toBe('/records')
  })

  it('/records は 200、/settings に表示名が出る', async () => {
    const { cookie } = await loginAs(env, { subject: 'member1' })
    expect((await get('/records', cookie)).status).toBe(200)
    const html = await (await get('/settings', cookie)).text()
    expect(html).toContain('ななしさん')
  })

  it('/ と /login は /records へ', async () => {
    const { cookie } = await loginAs(env, { subject: 'member2' })
    expect((await get('/', cookie)).headers.get('location')).toBe('/records')
    expect((await get('/login', cookie)).headers.get('location')).toBe('/records')
  })

  it('owner なら「管理」節が出る、member なら出ない', async () => {
    const owner = await loginAs(env, { subject: 'boss', owner: true })
    expect(await (await get('/settings', owner.cookie)).text()).toContain('管理（オーナーのみ）')
    const role = await env.DB.prepare('SELECT role FROM user WHERE id = ?')
      .bind(owner.userId)
      .first<{ role: string }>()
    expect(role?.role).toBe('owner')

    const member = await loginAs(env, { subject: 'notboss' })
    expect(await (await get('/settings', member.cookie)).text()).not.toContain(
      '管理（オーナーのみ）',
    )
  })

  it('OWNER_IDENTITIES から外しても自動降格しない', async () => {
    const { userId } = await loginAs(env, { subject: 'once-owner', owner: true })
    await loginAs(env, { subject: 'once-owner', owner: false })
    const row = await env.DB.prepare('SELECT role FROM user WHERE id = ?')
      .bind(userId)
      .first<{ role: string }>()
    expect(row?.role).toBe('owner')
  })

  it('/settings のログアウトは /auth/logout へ POST する form', async () => {
    const { cookie } = await loginAs(env, { subject: 'member3' })
    const html = await (await get('/settings', cookie)).text()
    expect(html).toContain('<form method="post" action="/auth/logout"><button type="submit">')
  })
})

describe('session id はハッシュで保存する', () => {
  it('DB の id は cookie の token の SHA-256 で、token そのものとは一致しない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'hash' })
    const token = tokenOf(cookie)
    const [row] = await sessionRows(userId)
    expect(row.id).not.toBe(token)
    expect(cookie).not.toContain(row.id)
    expect(row.id).toBe(await hashSessionToken(token))
  })
})

describe('無効な cookie', () => {
  it.each([
    // 署名の形は保ったまま値を変える（hono の署名検証で false になる）
    [
      '署名が合わない',
      (c: string) =>
        `session=${encodeURIComponent(`${'A'.repeat(43)}.${decodeURIComponent(c.slice(8)).split('.').pop()}`)}`,
    ],
    // 署名部の形が崩れている（hono は cookie が無い扱いにする）
    ['署名部が壊れている', (c: string) => `${c.slice(0, -4)}AAAA`],
  ])('%s cookie は未ログイン扱い + cookie 削除', async (_, breakIt) => {
    const { cookie } = await loginAs(env, { subject: 'tamper' })
    const res = await get('/records', breakIt(cookie))
    expect(res.status).toBe(302)
    expect(clearsSession(res)).toBe(true)
  })

  it('存在しない id は未ログイン扱い + cookie 削除', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'ghost' })
    await env.DB.prepare('DELETE FROM session_token WHERE user_id = ?').bind(userId).run()
    const res = await get('/records', cookie)
    expect(res.status).toBe(302)
    expect(clearsSession(res)).toBe(true)
  })

  it('expires_at が過去なら未ログイン扱い + cookie 削除', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'expired' })
    await env.DB.prepare('UPDATE session_token SET expires_at = ? WHERE user_id = ?')
      .bind(daysFromNow(-1), userId)
      .run()
    const res = await get('/records', cookie)
    expect(res.status).toBe(302)
    expect(clearsSession(res)).toBe(true)
  })

  it('退会済み（deleted_at あり）の user は未ログイン扱い', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'gone' })
    await env.DB.prepare('UPDATE user SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), userId)
      .run()
    const res = await get('/records', cookie)
    expect(res.status).toBe(302)
    expect(clearsSession(res)).toBe(true)
  })
})

describe('セッション固定対策', () => {
  it('同じ subject で 2 回ログインしても user は 1 行、1 回目の session 行は消える', async () => {
    const first = await loginAs(env, { subject: 'twice' })
    const second = await loginAs(env, { subject: 'twice', cookie: first.cookie })
    expect(second.userId).toBe(first.userId)
    expect(second.cookie).not.toBe(first.cookie)

    const users = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM identity WHERE provider = 'dev' AND subject = 'twice'",
    ).first<{ n: number }>()
    expect(users?.n).toBe(1)

    const rows = await sessionRows(first.userId)
    expect(rows.map((r) => r.id)).toEqual([await hashSessionToken(tokenOf(second.cookie))])
    expect((await get('/records', first.cookie)).status).toBe(302)
    expect((await get('/records', second.cookie)).status).toBe(200)
  })
})

describe('スライド延長', () => {
  it('残り 10 日なら 30 日後に延長し、cookie も出し直す', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'slide' })
    await env.DB.prepare('UPDATE session_token SET expires_at = ? WHERE user_id = ?')
      .bind(daysFromNow(10), userId)
      .run()
    const res = await get('/records', cookie)
    expect(res.status).toBe(200)
    const [row] = await sessionRows(userId)
    const left = Date.parse(row.expires_at) - Date.now()
    expect(left).toBeGreaterThan(29.9 * 86_400_000)
    expect(left).toBeLessThanOrEqual(30 * 86_400_000)
    expect(sessionCookieOf(res)).toBe(cookie)
  })

  it('残り 20 日なら変えない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'noslide' })
    const exp = daysFromNow(20)
    await env.DB.prepare('UPDATE session_token SET expires_at = ? WHERE user_id = ?')
      .bind(exp, userId)
      .run()
    const res = await get('/records', cookie)
    expect(res.status).toBe(200)
    const [row] = await sessionRows(userId)
    expect(row.expires_at).toBe(exp)
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe('ログアウト', () => {
  it('session 行が消え、以後 302 /login', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'bye' })
    const res = await logout({ Origin: ORIGIN, Cookie: cookie })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect(clearsSession(res)).toBe(true)
    expect(await sessionRows(userId)).toEqual([])
    expect((await get('/records', cookie)).status).toBe(302)
  })

  it('Origin も Sec-Fetch-Site も無いと 403', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csrf' })
    const res = await logout({ Cookie: cookie })
    expect(res.status).toBe(403)
    expect(await sessionRows(userId)).toHaveLength(1)
  })

  it('別オリジンの Origin は 403', async () => {
    const { cookie } = await loginAs(env, { subject: 'csrf2' })
    const res = await logout({ Cookie: cookie, Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })

  it('Sec-Fetch-Site: same-origin なら通る', async () => {
    const { cookie } = await loginAs(env, { subject: 'csrf3' })
    const res = await logout({ Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })
    expect(res.status).toBe(302)
  })

  it('GET では受けない', async () => {
    const { cookie } = await loginAs(env, { subject: 'getout' })
    expect((await get('/auth/logout', cookie)).status).toBe(404)
  })
})
