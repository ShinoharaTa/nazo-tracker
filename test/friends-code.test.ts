import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { FRIEND_CODE_RE, randomCode } from '../src/lib/random'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (path: string, cookie?: string, origin: string | null = ORIGIN) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(origin ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: '',
    },
    env,
  )

const codeOf = (userId: string) =>
  env.DB.prepare('SELECT friend_code AS v FROM user WHERE id = ?')
    .bind(userId)
    .first<{ v: string | null }>()
    .then((r) => r?.v)

const expectPrivate = (res: Response) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('x-robots-tag')).toBe('noindex')
}

describe('randomCode', () => {
  it('16 文字で、文字種は l・o・0・1 を除いた 32 種だけ', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const code = randomCode(16)
      expect(code).toHaveLength(16)
      expect(code).toMatch(FRIEND_CODE_RE)
      for (const ch of code) seen.add(ch)
    }
    expect([...seen].sort().join('')).toBe('23456789abcdefghijkmnpqrstuvwxyz')
  })

  it('書式の正規表現は文字種外・長さ違いを弾く', () => {
    expect(FRIEND_CODE_RE.test('abcdefghijkmnpqr')).toBe(true)
    for (const bad of [
      'abcdefghijkmnpq',
      'abcdefghijkmnpqrs',
      'abcdefghijkmnpql',
      'abcdefghijkmnpq0',
      'ABCDEFGHIJKMNPQR',
    ]) {
      expect(FRIEND_CODE_RE.test(bad)).toBe(false)
    }
  })
})

describe('/settings/friends', () => {
  it('未ログインは GET が 302 /login、POST は 401', async () => {
    const res = await get('/settings/friends')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect((await post('/settings/friends/code')).status).toBe(401)
    expect((await post('/settings/friends/code/delete')).status).toBe(401)
  })

  it('既定は未発行。説明と「招待リンクを作る」、注記が出る。応答は private, no-store と noindex', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'fc-default' })
    expect(await codeOf(userId)).toBeNull()
    const res = await get('/settings/friends', cookie)
    expect(res.status).toBe(200)
    expectPrivate(res)
    const html = await res.text()
    expect(html).toContain('リンクを知っている人だけが、あなたにフレンド申請できます。')
    expect(html).toContain('招待リンクを作る')
    expect(html).toContain('フレンドに見えるのは、作品名・ステータス・日付だけです。')
    expect(html).not.toContain('/f/')
    expect(html).not.toContain('data-copy')
  })

  it('作る → 書式どおりのコードが入り、画面に URL とコピー・作り直す・止めるが出る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'fc-create' })
    const res = await post('/settings/friends/code', cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expectPrivate(res)
    const code = await codeOf(userId)
    expect(code).toMatch(FRIEND_CODE_RE)

    const html = await (await get('/settings/friends', cookie)).text()
    expect(html).toContain(`value="${env.APP_ORIGIN}/f/${code}"`)
    expect(html).toMatch(/<input type="text" id="friend-invite-url" value="[^"]+" readonly/)
    expect(html).toContain('data-copy="friend-invite-url"')
    expect(html).toContain('リンクを作り直す')
    expect(html).toContain('招待を止める')
    expect(html).not.toContain('招待リンクを作る')
  })

  it('作り直す → 値が変わる。止める → NULL', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'fc-rotate' })
    await post('/settings/friends/code', cookie)
    const first = await codeOf(userId)
    await post('/settings/friends/code', cookie)
    const second = await codeOf(userId)
    expect(second).toMatch(FRIEND_CODE_RE)
    expect(second).not.toBe(first)

    const res = await post('/settings/friends/code/delete', cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expectPrivate(res)
    expect(await codeOf(userId)).toBeNull()
    const html = await (await get('/settings/friends', cookie)).text()
    expect(html).toContain('招待リンクを作る')
    expect(html).not.toContain(second as string)
  })

  it('他人のコードは変わらない', async () => {
    const a = await loginAs(env, { subject: 'fc-other-a' })
    const b = await loginAs(env, { subject: 'fc-other-b' })
    await post('/settings/friends/code', b.cookie)
    const bCode = await codeOf(b.userId)

    await post('/settings/friends/code', a.cookie)
    expect(await codeOf(b.userId)).toBe(bCode)
    await post('/settings/friends/code/delete', a.cookie)
    expect(await codeOf(b.userId)).toBe(bCode)
    expect(await codeOf(a.userId)).toBeNull()
  })

  it('Origin の無い POST は 403 で、コードは変わらない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'fc-csrf' })
    expect((await post('/settings/friends/code', cookie, null)).status).toBe(403)
    expect(await codeOf(userId)).toBeNull()
    await post('/settings/friends/code', cookie)
    const code = await codeOf(userId)
    expect((await post('/settings/friends/code/delete', cookie, null)).status).toBe(403)
    expect(await codeOf(userId)).toBe(code)
  })

  it('agent トークン（Bearer）は 403', async () => {
    const res = await app.request(
      '/settings/friends',
      { headers: { Authorization: 'Bearer nzt_dummy' } },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('設定一覧の「フレンド」は 1 項目で /settings/friends へ。「招待リンクをコピー」は無い', async () => {
    const { cookie } = await loginAs(env, { subject: 'fc-menu' })
    const html = await (await get('/settings', cookie)).text()
    expect(html).toContain(
      '<a href="/settings/friends"><span>フレンド</span><span class="note">0 人</span></a>',
    )
    expect(html).not.toContain('招待リンクをコピー')
  })
})
