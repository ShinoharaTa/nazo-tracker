import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { countsFor } from '../src/db/counts'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertWork } from './helpers/master'
import { insertAttempt, insertWish } from './helpers/records'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (body: Record<string, string>, cookie?: string) =>
  app.request(
    '/settings/counts',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )

const excludeOf = (userId: string) =>
  env.DB.prepare('SELECT exclude_from_counts AS v FROM user WHERE id = ?')
    .bind(userId)
    .first<{ v: number }>()
    .then((r) => r?.v)

// /settings の「作品の人数に自分を含める」の note
const menuNote = async (cookie: string) => {
  const html = await (await get('/settings', cookie)).text()
  const m = html.match(
    /<a href="\/settings\/counts"><span>作品の人数に自分を含める<\/span><span class="note">([^<]*)<\/span><\/a>/,
  )
  return m?.[1]
}

describe('/settings/counts', () => {
  it('未ログインは GET が 302 /login、POST は 401', async () => {
    const res = await get('/settings/counts')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect((await post({ include: 'on' })).status).toBe(401)
  })

  it('GET は既定で Switch が on。/settings の note は「含める」', async () => {
    const { cookie } = await loginAs(env, { subject: 'sc-get' })
    const res = await get('/settings/counts', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toMatch(/<input type="checkbox" role="switch" class="sw" name="include" checked/)
    expect(html).toContain('5 人未満は「少数」と表示します。')
    expect(await menuNote(cookie)).toBe('含める')
  })

  it('include 無しで含めない、include=on で戻す。countsFor の結果もその場で変わる', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sc-post' })
    const w = await insertWork(env, { title: '設定テスト 人数' })
    await insertAttempt(env, { userId, workId: w, status: 'cleared' })
    await insertWish(env, userId, w)
    const db = createDb(env.DB)
    expect((await countsFor(db, [w])).get(w)).toEqual({ played: 'few', wish: 'few' })

    const off = await post({}, cookie)
    expect(off.status).toBe(302)
    expect(off.headers.get('location')).toBe('/settings')
    expect(await excludeOf(userId)).toBe(1)
    expect(await menuNote(cookie)).toBe('含めない')
    expect((await countsFor(db, [w])).get(w)).toEqual({ played: 'none', wish: 'none' })
    const page = await (await get('/settings/counts', cookie)).text()
    expect(page).not.toMatch(/name="include" checked/)

    const on = await post({ include: 'on' }, cookie)
    expect(on.status).toBe(302)
    expect(await excludeOf(userId)).toBe(0)
    expect(await menuNote(cookie)).toBe('含める')
    expect((await countsFor(db, [w])).get(w)).toEqual({ played: 'few', wish: 'few' })
  })

  it('他人の設定は変わらない', async () => {
    const a = await loginAs(env, { subject: 'sc-alice' })
    const b = await loginAs(env, { subject: 'sc-bob' })
    await post({}, a.cookie)
    expect(await excludeOf(a.userId)).toBe(1)
    expect(await excludeOf(b.userId)).toBe(0)
  })

  it('Origin が無い・違う POST は 403 で、設定は変わらない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sc-csrf' })
    const send = (headers: Record<string, string>) =>
      app.request(
        '/settings/counts',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookie,
            ...headers,
          },
          body: '',
        },
        env,
      )
    expect((await send({})).status).toBe(403)
    expect((await send({ Origin: 'https://evil.example' })).status).toBe(403)
    expect(await excludeOf(userId)).toBe(0)
  })

  it('ログイン中の /settings/* は Cache-Control: private, no-store', async () => {
    const { cookie } = await loginAs(env, { subject: 'sc-cache' })
    for (const p of ['/settings', '/settings/counts', '/settings/name', '/settings/delete']) {
      const res = await get(p, cookie)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    }
  })
})
