import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { randomCode } from '../src/lib/random'
import { addDays, nowIso } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string, e: Cloudflare.Env = env) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, e)

const post = (path: string, cookie?: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: '',
    },
    env,
  )

// 招待者をログイン経由で作り、コードを直接入れる
const inviter = async (subject: string, name = `招待者-${subject}`) => {
  const u = await loginAs(env, { subject })
  const code = randomCode(16)
  await env.DB.prepare('UPDATE user SET friend_code = ?, display_name = ? WHERE id = ?')
    .bind(code, name, u.userId)
    .run()
  return { ...u, code, name }
}

// 申請の上限を試すための相手（ログインしない user 行だけ）
const insertUser = async (opts: { code?: string } = {}) => {
  const id = ulid()
  await env.DB.prepare(
    "INSERT INTO user (id, display_name, role, friend_code, created_at) VALUES (?, ?, 'member', ?, ?)",
  )
    .bind(id, `u-${id.slice(-6)}`, opts.code ?? null, nowIso())
    .run()
  return id
}

const insertRequest = async (
  from: string,
  to: string,
  status: 'pending' | 'accepted' | 'declined' | 'canceled',
  createdAt = nowIso(),
) => {
  const id = ulid()
  await env.DB.prepare(
    'INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, from, to, status, createdAt)
    .run()
  return id
}

const requestsBetween = (from: string, to: string) =>
  env.DB.prepare(
    'SELECT id, status FROM friend_request WHERE from_user_id = ? AND to_user_id = ? ORDER BY created_at',
  )
    .bind(from, to)
    .all<{ id: string; status: string }>()
    .then((r) => r.results)

const friendshipOf = (a: string, b: string) =>
  env.DB.prepare('SELECT user_lo, user_hi FROM friendship WHERE user_lo = ? AND user_hi = ?')
    .bind(a < b ? a : b, a < b ? b : a)
    .all<{ user_lo: string; user_hi: string }>()
    .then((r) => r.results)

const makeFriends = (a: string, b: string) =>
  env.DB.prepare('INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)')
    .bind(a < b ? a : b, a < b ? b : a, nowIso())
    .run()

const blockOf = (from: string, to: string) =>
  env.DB.prepare('INSERT INTO block (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)')
    .bind(from, to, nowIso())
    .run()

const expectInviteHeaders = (res: Response) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('x-robots-tag')).toBe('noindex')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
}

// D1 への問い合わせを数える env（prepare / batch / exec を数える）
const countingEnv = () => {
  let calls = 0
  const db = env.DB
  const DB = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop)
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        if (prop === 'prepare' || prop === 'batch' || prop === 'exec') calls++
        return v.apply(target, args)
      }
    },
  })
  return { env: { ...env, DB } as Cloudflare.Env, calls: () => calls }
}

const afterLoginCookieOf = (res: Response) =>
  res.headers.getSetCookie().find((s) => s.startsWith('after_login='))

describe('GET /f/:code（未ログイン）', () => {
  it('固定文と「ログインする」、after_login cookie。招待者の名前は出さず、D1 を引かない', async () => {
    const inv = await inviter('fi-anon', '秘密の招待者')
    const counted = countingEnv()
    const res = await get(`/f/${inv.code}`, undefined, counted.env)
    expect(res.status).toBe(200)
    expectInviteHeaders(res)
    const html = await res.text()
    expect(html).toContain('NAZO LOG のフレンド招待リンクです。ログインすると、申請を送れます。')
    expect(html).toContain('href="/login"')
    expect(html).not.toContain('秘密の招待者')
    expect(counted.calls()).toBe(0)

    const sc = afterLoginCookieOf(res)
    expect(sc).toBeDefined()
    expect(decodeURIComponent((sc as string).split(';')[0].slice('after_login='.length))).toBe(
      `/f/${inv.code}`,
    )
    expect(sc).toMatch(/HttpOnly/i)
    expect(sc).toMatch(/SameSite=Lax/i)
    expect(sc).toMatch(/Max-Age=600/)
    expect(sc).toMatch(/Path=\//)
  })

  it('存在しないコードでも同じ 200・同じ本文', async () => {
    const inv = await inviter('fi-anon-same')
    const a = await (await get(`/f/${inv.code}`)).text()
    const res = await get(`/f/${randomCode(16)}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(a)
  })

  it('書式違いは 404（cookie も置かない）', async () => {
    const res = await get('/f/short')
    expect(res.status).toBe(404)
    expectInviteHeaders(res)
    expect(afterLoginCookieOf(res)).toBeUndefined()
  })

  it('POST /f/:code/request は 401、Bearer は 403', async () => {
    const inv = await inviter('fi-anon-post')
    const res = await post(`/f/${inv.code}/request`)
    expect(res.status).toBe(401)
    expectInviteHeaders(res)
    const bearer = await app.request(
      `/f/${inv.code}`,
      { headers: { Authorization: 'Bearer nzt_dummy' } },
      env,
    )
    expect(bearer.status).toBe(403)
  })
})

describe('GET /f/:code（ログイン済み）', () => {
  it('書式違い・無いコード・退会済み・ブロック（両方向）は同じ 404 で本文が同一', async () => {
    const me = await loginAs(env, { subject: 'fi-404-me' })
    const bodies: string[] = []
    const check = async (path: string) => {
      const res = await get(path, me.cookie)
      expect(res.status).toBe(404)
      expectInviteHeaders(res)
      bodies.push(await res.text())
    }
    await check('/f/0000000000000000')
    await check(`/f/${randomCode(16)}`)

    const gone = await inviter('fi-404-gone')
    await env.DB.prepare('UPDATE user SET deleted_at = ? WHERE id = ?')
      .bind(nowIso(), gone.userId)
      .run()
    await check(`/f/${gone.code}`)

    const blockedByMe = await inviter('fi-404-b1')
    await blockOf(me.userId, blockedByMe.userId)
    await check(`/f/${blockedByMe.code}`)

    const blocksMe = await inviter('fi-404-b2')
    await blockOf(blocksMe.userId, me.userId)
    await check(`/f/${blocksMe.code}`)

    expect(bodies[0]).toContain('この招待リンクは使えません。')
    for (const b of bodies) expect(b).toBe(bodies[0])
  })

  it('自分のコードは 302 /settings/friends、フレンド済みは 302 /friends/:userId', async () => {
    const me = await inviter('fi-self')
    const self = await get(`/f/${me.code}`, me.cookie)
    expect(self.status).toBe(302)
    expect(self.headers.get('location')).toBe('/settings/friends')

    const other = await inviter('fi-friend')
    await makeFriends(me.userId, other.userId)
    const res = await get(`/f/${other.code}`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/friends/${other.userId}`)
  })

  it('申請前は招待者名・注記・自分の表示名・「申請する」が出る', async () => {
    const me = await loginAs(env, { subject: 'fi-can' })
    const inv = await inviter('fi-can-inv', 'まねく')
    const res = await get(`/f/${inv.code}`, me.cookie)
    expect(res.status).toBe(200)
    expectInviteHeaders(res)
    const html = await res.text()
    expect(html).toContain('まねくさんにフレンド申請を送りますか？')
    expect(html).toContain('フレンドに見えるのは、作品名・ステータス・日付だけです。')
    expect(html).toContain('あなたの表示名: ななしさん')
    expect(html).toContain('href="/settings/name"')
    expect(html).toContain(`action="/f/${inv.code}/request"`)
  })

  it('相手から申請が届いていれば「〇〇さんから申請が届いています。」', async () => {
    const me = await loginAs(env, { subject: 'fi-incoming' })
    const inv = await inviter('fi-incoming-inv', 'とどく')
    await insertRequest(inv.userId, me.userId, 'pending')
    const html = await (await get(`/f/${inv.code}`, me.cookie)).text()
    expect(html).toContain('とどくさんから申請が届いています。')
    expect(html).not.toContain('申請する')
  })
})

describe('POST /f/:code/request', () => {
  it('申請する → pending が 1 行、画面は「申請中」。もう一度押しても増えない', async () => {
    const me = await loginAs(env, { subject: 'fi-send' })
    const inv = await inviter('fi-send-inv', 'おくる')
    const res = await post(`/f/${inv.code}/request`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/f/${inv.code}`)
    expectInviteHeaders(res)
    expect(await requestsBetween(me.userId, inv.userId)).toMatchObject([{ status: 'pending' }])

    const html = await (await get(`/f/${inv.code}`, me.cookie)).text()
    expect(html).toContain('おくるさんに申請を送ってあります。承認されるとフレンドになります。')

    const again = await post(`/f/${inv.code}/request`, me.cookie)
    expect(again.status).toBe(302)
    expect(await requestsBetween(me.userId, inv.userId)).toHaveLength(1)
  })

  it('断られた（declined）申請も送った側には「申請中」のまま', async () => {
    const me = await loginAs(env, { subject: 'fi-declined' })
    const inv = await inviter('fi-declined-inv', 'ことわる')
    await insertRequest(me.userId, inv.userId, 'declined')
    const html = await (await get(`/f/${inv.code}`, me.cookie)).text()
    expect(html).toContain('ことわるさんに申請を送ってあります。')
  })

  it('無いコード・ブロック中は 404 で行が増えない', async () => {
    const me = await loginAs(env, { subject: 'fi-post-404' })
    expect((await post(`/f/${randomCode(16)}/request`, me.cookie)).status).toBe(404)
    expect((await post('/f/bad/request', me.cookie)).status).toBe(404)
    const inv = await inviter('fi-post-404-inv')
    await blockOf(inv.userId, me.userId)
    expect((await post(`/f/${inv.code}/request`, me.cookie)).status).toBe(404)
    expect(await requestsBetween(me.userId, inv.userId)).toHaveLength(0)
  })

  it('自分のコードは 302 /settings/friends で行を作らない', async () => {
    const me = await inviter('fi-post-self')
    const res = await post(`/f/${me.code}/request`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expect(await requestsBetween(me.userId, me.userId)).toHaveLength(0)
  })

  it('直近 24 時間に 20 件送っていると 21 件目は拒否。24 時間より前の分は数えない', async () => {
    const me = await loginAs(env, { subject: 'fi-daily' })
    const old = addDays(nowIso(), -1.05)
    for (let i = 0; i < 20; i++) await insertRequest(me.userId, await insertUser(), 'canceled', old)
    const a = await inviter('fi-daily-a')
    expect((await post(`/f/${a.code}/request`, me.cookie)).status).toBe(302)
    expect(await requestsBetween(me.userId, a.userId)).toHaveLength(1)

    // 今の 1 件 + 直近 19 件 = 20 件
    for (let i = 0; i < 19; i++) await insertRequest(me.userId, await insertUser(), 'canceled')
    const b = await inviter('fi-daily-b')
    const res = await post(`/f/${b.code}/request`, me.cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('申請できませんでした。時間をおいてお試しください。')
    expect(await requestsBetween(me.userId, b.userId)).toHaveLength(0)
  })

  it('同じ相手への取り消し済みの申請が 7 日以内なら拒否、8 日前なら通る', async () => {
    const me = await loginAs(env, { subject: 'fi-retry' })
    const recent = await inviter('fi-retry-recent')
    await insertRequest(me.userId, recent.userId, 'canceled', addDays(nowIso(), -6))
    expect((await post(`/f/${recent.code}/request`, me.cookie)).status).toBe(400)
    expect(await requestsBetween(me.userId, recent.userId)).toHaveLength(1)

    const older = await inviter('fi-retry-older')
    await insertRequest(me.userId, older.userId, 'canceled', addDays(nowIso(), -8))
    expect((await post(`/f/${older.code}/request`, me.cookie)).status).toBe(302)
    expect((await requestsBetween(me.userId, older.userId)).map((r) => r.status)).toEqual([
      'canceled',
      'pending',
    ])
  })

  it('30 日を過ぎた自分の pending は申請のついでに canceled になり、新しく送れる', async () => {
    const me = await loginAs(env, { subject: 'fi-expire' })
    const inv = await inviter('fi-expire-inv', 'きげん')
    await insertRequest(me.userId, inv.userId, 'pending', addDays(nowIso(), -31))
    const html = await (await get(`/f/${inv.code}`, me.cookie)).text()
    expect(html).toContain('きげんさんにフレンド申請を送りますか？')
    expect((await post(`/f/${inv.code}/request`, me.cookie)).status).toBe(302)
    expect((await requestsBetween(me.userId, inv.userId)).map((r) => r.status)).toEqual([
      'canceled',
      'pending',
    ])
  })

  it('相手宛ての有効な pending が 50 件あれば拒否（受け側の上限の文言）', async () => {
    const me = await loginAs(env, { subject: 'fi-full' })
    const inv = await inviter('fi-full-inv')
    for (let i = 0; i < 50; i++) await insertRequest(await insertUser(), inv.userId, 'pending')
    const res = await post(`/f/${inv.code}/request`, me.cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('この相手は今は申請を受け付けられません。')
    expect(await requestsBetween(me.userId, inv.userId)).toHaveLength(0)
  })

  it('Promise.all で 5 本同時に送っても 1 行だけ', async () => {
    const me = await loginAs(env, { subject: 'fi-race' })
    const inv = await inviter('fi-race-inv')
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(`/f/${inv.code}/request`, me.cookie)),
    )
    for (const r of results) expect([302, 400]).toContain(r.status)
    expect(await requestsBetween(me.userId, inv.userId)).toHaveLength(1)
  })

  it('相手からの pending があれば承認として扱い、friendship が出来て accepted になる', async () => {
    const me = await loginAs(env, { subject: 'fi-reverse' })
    const inv = await inviter('fi-reverse-inv')
    await insertRequest(inv.userId, me.userId, 'pending')
    const res = await post(`/f/${inv.code}/request`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/f/${inv.code}`)
    expect(await requestsBetween(inv.userId, me.userId)).toMatchObject([{ status: 'accepted' }])
    expect(await requestsBetween(me.userId, inv.userId)).toHaveLength(0)
    expect(await friendshipOf(me.userId, inv.userId)).toHaveLength(1)
    // 以後は「フレンド済み」
    const after = await get(`/f/${inv.code}`, me.cookie)
    expect(after.headers.get('location')).toBe(`/friends/${inv.userId}`)
  })
})

describe('after_login（ログイン後の戻り先）', () => {
  const loginWith = (subject: string, value: string) =>
    loginAs(env, { subject, cookie: `after_login=${encodeURIComponent(value)}` })

  const expectCleared = (res: Response) => {
    const sc = afterLoginCookieOf(res)
    expect(sc).toBeDefined()
    expect(sc).toMatch(/Max-Age=0/)
  }

  it('書式どおりの /f/<code> なら、新規ユーザーでもそこへ戻り、cookie は消える', async () => {
    const code = randomCode(16)
    const { res } = await loginWith('fi-al-ok', `/f/${code}`)
    expect(res.headers.get('location')).toBe(`/f/${code}`)
    expectCleared(res)
  })

  it('GET /f/:code で置かれた cookie をそのまま渡すとそこへ戻る', async () => {
    const code = randomCode(16)
    const sc = afterLoginCookieOf(await get(`/f/${code}`)) as string
    const { res } = await loginAs(env, { subject: 'fi-al-flow', cookie: sc.split(';')[0] })
    expect(res.headers.get('location')).toBe(`/f/${code}`)
  })

  for (const [i, value] of [
    '//evil.example',
    '/records',
    '/f/short',
    `/f/${'a'.repeat(16)}/request`,
    `https://evil.example/f/${'a'.repeat(16)}`,
  ].entries()) {
    it(`${value} は無視して既定の戻り先。cookie は消える`, async () => {
      const { res } = await loginWith(`fi-al-bad-${i}`, value)
      expect(res.headers.get('location')).toBe('/settings/name?welcome=1')
      expectCleared(res)
    })
  }

  it('cookie が無ければ今までどおり（既存ユーザーは /records）', async () => {
    const first = await loginAs(env, { subject: 'fi-al-none' })
    expect(afterLoginCookieOf(first.res)).toBeUndefined()
    const { res } = await loginAs(env, { subject: 'fi-al-none' })
    expect(res.headers.get('location')).toBe('/records')
  })
})
