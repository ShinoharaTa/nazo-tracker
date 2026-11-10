import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'
import { insertAttempt, insertWish } from './helpers/records'

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
let carol = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'wishlist-alice' })
  bob = await loginAs(env, { subject: 'wishlist-bob' })
  carol = await loginAs(env, { subject: 'wishlist-carol' })
  ids.org = await insertOrg(env, { name: 'マイリストテスト団' })
  ids.work = await insertWork(env, { title: 'マイリストの謎', kind: 'room', orgId: ids.org })
  ids.target = await insertWork(env, { title: 'マイリスト統合先' })
  ids.merged = await insertWork(env, { title: 'マイリスト統合元', mergedIntoId: ids.target })
  // carol: 先に played（alice ではなく carol の cleared）、後に fresh を登録
  ids.played = await insertWork(env, { title: 'クリア済みの謎', orgId: ids.org })
  ids.fresh = await insertWork(env, { title: 'まだ遊んでない謎' })
  await insertAttempt(env, {
    userId: carol.userId,
    workId: ids.played,
    status: 'cleared',
    finishedOn: '2026-10-01',
  })
  // bob の記録は carol の印に影響しない
  await insertAttempt(env, { userId: bob.userId, workId: ids.fresh, status: 'cleared' })
  await insertWish(env, carol.userId, ids.played)
  await insertWish(env, carol.userId, ids.fresh)
})

const get = (path: string, cookie = alice.cookie) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

const post = (path: string, body: Record<string, string>, cookie: string | null = alice.cookie) => {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (cookie) headers.Cookie = cookie
  return app.request(
    path,
    { method: 'POST', headers, body: new URLSearchParams(body).toString() },
    env,
  )
}

const wishCount = async (userId: string, workId: string) => {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ? AND work_id = ?',
  )
    .bind(userId, workId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

// /records?tab=wish の各行の作品 id（表示順）
const wishWorkIds = (h: string) =>
  [...h.matchAll(/<a class="ticket" href="\/works\/([0-9A-Z]+)">/g)].map((m) => m[1])

describe('POST /records/wishlist', () => {
  it('追加 → 行ができ、作品ページが「マイリストから外す」に変わる', async () => {
    const before = await (await get(`/works/${ids.work}`)).text()
    expect(before).toContain('action="/records/wishlist"')
    expect(before).toContain('マイリストに追加')
    expect(before).not.toContain('マイリストから外す')

    const res = await post('/records/wishlist', { work_id: ids.work, back: 'work' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/works/${ids.work}`)
    expect(await wishCount(alice.userId, ids.work)).toBe(1)

    const after = await (await get(`/works/${ids.work}`)).text()
    expect(after).toContain('action="/records/wishlist/delete"')
    expect(after).toContain('マイリストから外す')
  })

  it('2 回目も 302（重複エラーにならない）で行は 1 つのまま', async () => {
    const res = await post('/records/wishlist', { work_id: ids.work, back: 'work' })
    expect(res.status).toBe(302)
    expect(await wishCount(alice.userId, ids.work)).toBe(1)
  })

  it('bob には影響しない', async () => {
    expect(await wishCount(bob.userId, ids.work)).toBe(0)
    const h = await (await get(`/works/${ids.work}`, bob.cookie)).text()
    expect(h).toContain('マイリストに追加')
    expect(h).not.toContain('マイリストから外す')
    const list = await (await get('/records?tab=wish', bob.cookie)).text()
    expect(wishWorkIds(list)).not.toContain(ids.work)
  })

  it('back=wish は /records?tab=wish へ。それ以外の値は作品ページへ', async () => {
    const wish = await post('/records/wishlist', { work_id: ids.target, back: 'wish' })
    expect(wish.headers.get('Location')).toBe('/records?tab=wish')
    const other = await post('/records/wishlist', {
      work_id: ids.target,
      back: 'https://example.com/',
    })
    expect(other.headers.get('Location')).toBe(`/works/${ids.target}`)
  })

  it('統合済み・無い work は 404 で行を作らない', async () => {
    expect((await post('/records/wishlist', { work_id: ids.merged })).status).toBe(404)
    expect(await wishCount(alice.userId, ids.merged)).toBe(0)
    expect((await post('/records/wishlist', { work_id: 'NOPE' })).status).toBe(404)
    expect((await post('/records/wishlist', {})).status).toBe(404)
  })

  it('未ログインは 401', async () => {
    expect((await post('/records/wishlist', { work_id: ids.work }, null)).status).toBe(401)
    expect((await post('/records/wishlist/delete', { work_id: ids.work }, null)).status).toBe(401)
  })

  it('未ログインの作品ページは /login へのリンク', async () => {
    const h = await (await app.request(`/works/${ids.work}`, {}, env)).text()
    expect(h).toContain('<a class="btn" href="/login">マイリストに追加</a>')
    expect(h).not.toContain('action="/records/wishlist"')
  })
})

describe('POST /records/wishlist/delete', () => {
  it('外す → 行が消え、作品ページが「マイリストに追加」に戻る', async () => {
    await post('/records/wishlist', { work_id: ids.work, back: 'work' })
    await insertWish(env, bob.userId, ids.work)
    const res = await post('/records/wishlist/delete', { work_id: ids.work, back: 'wish' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/records?tab=wish')
    expect(await wishCount(alice.userId, ids.work)).toBe(0)
    // bob の行は残る
    expect(await wishCount(bob.userId, ids.work)).toBe(1)
    const h = await (await get(`/works/${ids.work}`)).text()
    expect(h).toContain('マイリストに追加')
    expect(h).not.toContain('マイリストから外す')
  })

  it('登録していない作品を外しても 302', async () => {
    const res = await post('/records/wishlist/delete', { work_id: ids.fresh, back: 'work' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/works/${ids.fresh}`)
  })

  it('統合済み work は 404', async () => {
    expect((await post('/records/wishlist/delete', { work_id: ids.merged })).status).toBe(404)
  })
})

describe('GET /records?tab=wish', () => {
  it('登録の新しい順。記録ありは最新のステータス chip、無ければ「未プレイ」', async () => {
    const h = await (await get('/records?tab=wish', carol.cookie)).text()
    expect(wishWorkIds(h)).toEqual([ids.fresh, ids.played])
    expect(h.match(/class="chip st-cleared"/g)).toHaveLength(1)
    expect(h.match(/<span class="mark">未プレイ<\/span>/g)).toHaveLength(1)
    expect(h).toContain('マイリストテスト団')
    expect(h).toMatch(/登録 \d{4}-\d{2}-\d{2}/)
    // 各行に外すボタン（back=wish）
    expect(h.match(/action="\/records\/wishlist\/delete"/g)).toHaveLength(2)
    expect(h).toContain('name="back" value="wish"')
    expect(h).toContain('<a class="fchip on" href="/records?tab=wish" aria-current="page">')
  })

  it('unplayed=1 は記録の無い作品だけ', async () => {
    const h = await (await get('/records?tab=wish&unplayed=1', carol.cookie)).text()
    expect(wishWorkIds(h)).toEqual([ids.fresh])
    expect(h).toContain(
      '<a class="fchip on" href="/records?tab=wish&amp;unplayed=1" aria-current="page">',
    )
  })

  it('空なら既存の文言', async () => {
    const { cookie } = await loginAs(env, { subject: 'wishlist-empty' })
    const e = await (await get('/records?tab=wish', cookie)).text()
    expect(wishWorkIds(e)).toEqual([])
    expect(e).toContain('マイリストは空です。')
  })
})
