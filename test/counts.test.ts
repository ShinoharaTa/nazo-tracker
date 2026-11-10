import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { bucket, countsFor } from '../src/db/counts'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { countLabel } from '../src/ui/labels'
import { loginAs } from './helpers/auth'
import { insertOrg, insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertWish } from './helpers/records'

const db = createDb(env.DB)

// 人数を数えるだけのユーザー（ログインはしない）
const insertUser = async (opts: { exclude?: boolean; deleted?: boolean } = {}) => {
  const id = ulid()
  await env.DB.prepare(
    'INSERT INTO user (id, display_name, exclude_from_counts, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      'counts',
      opts.exclude ? 1 : 0,
      '2026-01-01T00:00:00.000Z',
      opts.deleted ? '2026-02-01T00:00:00.000Z' : null,
    )
    .run()
  return id
}

const setExclude = (userId: string, v: 0 | 1) =>
  env.DB.prepare('UPDATE user SET exclude_from_counts = ? WHERE id = ?').bind(v, userId).run()

const countsOf = async (workId: string) => (await countsFor(db, [workId])).get(workId)

describe('bucket / countLabel', () => {
  it('0 は none、1〜4 は few、5 以上は実数', () => {
    expect(bucket(0)).toBe('none')
    expect(bucket(1)).toBe('few')
    expect(bucket(4)).toBe('few')
    expect(bucket(5)).toBe(5)
    expect(bucket(12)).toBe(12)
  })

  it('few は「少数」、実数は「n 人」、none は null', () => {
    expect(countLabel('none')).toBeNull()
    expect(countLabel('few')).toBe('少数')
    expect(countLabel(5)).toBe('5 人')
    expect(countLabel(12)).toBe('12 人')
  })
})

describe('countsFor', () => {
  it('cleared 4 人は few、failed の 5 人目で 5。同じユーザーの 2 件は 1 人、dropped だけは数えない', async () => {
    const w = await insertWork(env, { title: '人数テスト played' })
    const users = await Promise.all([1, 2, 3, 4].map(() => insertUser()))
    for (const u of users) await insertAttempt(env, { userId: u, workId: w, status: 'cleared' })
    // 1 人目の 2 回目
    await insertAttempt(env, { userId: users[0], workId: w, status: 'failed', attemptNo: 2 })
    // dropped / purchased / in_progress だけのユーザー
    for (const status of ['dropped', 'purchased', 'in_progress']) {
      await insertAttempt(env, { userId: await insertUser(), workId: w, status })
    }
    expect(await countsOf(w)).toEqual({ played: 'few', wish: 'none' })

    const fifth = await insertUser()
    await insertAttempt(env, { userId: fifth, workId: w, status: 'failed' })
    expect(await countsOf(w)).toEqual({ played: 5, wish: 'none' })

    // オプトアウトしたら few に戻り、戻すと 5
    await setExclude(fifth, 1)
    expect((await countsOf(w))?.played).toBe('few')
    await setExclude(fifth, 0)
    expect((await countsOf(w))?.played).toBe(5)
  })

  it('exclude_from_counts と退会済みのユーザーは、プレイ済みとマイリストの両方から外す', async () => {
    const w = await insertWork(env, { title: '人数テスト exclude' })
    for (let i = 0; i < 4; i++) {
      const u = await insertUser()
      await insertAttempt(env, { userId: u, workId: w, status: 'cleared' })
      await insertWish(env, u, w)
    }
    for (const opts of [{ exclude: true }, { deleted: true }]) {
      const u = await insertUser(opts)
      await insertAttempt(env, { userId: u, workId: w, status: 'cleared' })
      await insertWish(env, u, w)
    }
    expect(await countsOf(w)).toEqual({ played: 'few', wish: 'few' })
  })

  it('マイリスト 5 人は wish = 5', async () => {
    const w = await insertWork(env, { title: '人数テスト wish' })
    for (let i = 0; i < 5; i++) await insertWish(env, await insertUser(), w)
    expect(await countsOf(w)).toEqual({ played: 'none', wish: 5 })
  })

  it('無い id は { none, none }、空配列は空の Map', async () => {
    expect(await countsOf('no-such-work')).toEqual({ played: 'none', wish: 'none' })
    expect((await countsFor(db, [])).size).toBe(0)
  })

  it('100 件を超える id でもチャンクに分けて数える', async () => {
    const u = await insertUser()
    const ids: string[] = []
    for (let i = 0; i < 105; i++) ids.push(`chunk-missing-${i}`)
    const last = await insertWork(env, { title: '人数テスト chunk' })
    await insertWish(env, u, last)
    ids.push(last)
    const m = await countsFor(db, ids)
    expect(m.size).toBe(106)
    expect(m.get(last)).toEqual({ played: 'none', wish: 'few' })
    expect(m.get('chunk-missing-0')).toEqual({ played: 'none', wish: 'none' })
  })
})

describe('人数の表示', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const org = await insertOrg(env, { name: '人数表示テスト団' })
    ids.org = org
    ids.few = await insertWork(env, { title: '人数表示 少数の作品', orgId: org })
    ids.none = await insertWork(env, { title: '人数表示 誰もいない作品', orgId: org })
    ids.wishOnly = await insertWork(env, { title: '人数表示 マイリストだけ' })
    for (let i = 0; i < 4; i++) {
      await insertAttempt(env, { userId: await insertUser(), workId: ids.few, status: 'cleared' })
    }
    await insertWish(env, await insertUser(), ids.wishOnly)
    ids.five = await insertWork(env, { title: '人数表示 ちょうど 5 人' })
    for (let i = 0; i < 5; i++) {
      await insertAttempt(env, { userId: await insertUser(), workId: ids.five, status: 'failed' })
    }
    ids.venue = await insertVenue(env, { name: '人数表示テスト会場' })
  })

  const html = async (path: string) => {
    const res = await app.request(path, {}, env)
    expect(res.status).toBe(200)
    return res.text()
  }

  // 作品 1 件分の ticket（<a …href="/works/:id">…</a>）
  const ticketOf = (page: string, workId: string) => {
    const m = page.match(
      new RegExp(`<a class="ticket[^"]*" href="/works/${workId}">[\\s\\S]*?</a>`),
    )
    expect(m).not.toBeNull()
    return m?.[0] ?? ''
  }

  it('/works: 少数の作品に chip、誰もいない作品には chip が無い', async () => {
    const page = await html(`/works?q=${encodeURIComponent('人数表示')}`)
    expect(ticketOf(page, ids.few)).toContain('<span class="chip">プレイ済み 少数</span>')
    expect(ticketOf(page, ids.none)).not.toContain('class="chip"')
    // マイリスト人数は一覧に出さない
    expect(ticketOf(page, ids.wishOnly)).not.toContain('class="chip"')
  })

  it('/orgs/:id の作品一覧（右ページ）にも chip が付く', async () => {
    const page = (await html(`/orgs/${ids.org}`)).split('class="page pane-r"')[1] ?? ''
    expect(ticketOf(page, ids.few)).toContain('プレイ済み 少数')
    expect(ticketOf(page, ids.none)).not.toContain('class="chip"')
  })

  it('/works/:id: 4 人は「少数」で、生の数値を出さない', async () => {
    const page = await html(`/works/${ids.few}`)
    expect(page).toContain('<b>少数</b>')
    expect(page).not.toContain('>4<')
    expect(page).not.toContain('4 人')
    // マイリストは none なので .num が 1 つだけ
    expect(page.match(/class="num"/g)?.length).toBe(1)
    expect(page).not.toContain('まだ記録はありません')
  })

  it('/works/:id: 両方 none なら「まだ記録はありません」で .nums を出さない', async () => {
    const page = await html(`/works/${ids.none}`)
    expect(page).toContain('まだ記録はありません')
    expect(page).not.toContain('class="nums"')
  })

  it('/works/:id: マイリストだけの作品は .num がマイリストの 1 つ', async () => {
    const page = await html(`/works/${ids.wishOnly}`)
    expect(page.match(/class="num"/g)?.length).toBe(1)
    expect(page).toMatch(/<span>マイリスト<\/span><b>少数<\/b>/)
  })

  it('/works/:id: 5 人ちょうどは実数で「5 人」', async () => {
    const page = await html(`/works/${ids.five}`)
    expect(page).toMatch(/<span>プレイ済み<\/span><b>5 人<\/b>/)
    const list = await html(`/works?q=${encodeURIComponent('ちょうど 5 人')}`)
    expect(ticketOf(list, ids.five)).toContain('<span class="chip">プレイ済み 5 人</span>')
  })

  it('詳細ページ左の作品一覧（/works/:id・/orgs/:id・/venues/:id）にも chip が付く', async () => {
    for (const path of [`/works/${ids.none}`, `/orgs/${ids.org}`, `/venues/${ids.venue}`]) {
      const left = (await html(path)).split('class="page pane-r"')[0]
      expect(ticketOf(left, ids.few)).toContain('<span class="chip">プレイ済み 少数</span>')
      expect(ticketOf(left, ids.none)).not.toContain('class="chip"')
    }
  })

  it('/works/:id の人数表示はログインの有無で変わらない', async () => {
    const { cookie } = await loginAs(env, { subject: 'counts-viewer' })
    // 人数の部分（.num と「まだ記録はありません」）と一覧の chip
    const countsPart = (page: string) => [
      ...(page.match(/<div class="num"><span>[^<]*<\/span><b>[^<]*<\/b><\/div>/g) ?? []),
      ...(page.match(/<p class="note">まだ記録はありません<\/p>/g) ?? []),
      ...(page.match(/<span class="chip">プレイ済み [^<]*<\/span>/g) ?? []),
    ]
    for (const id of [ids.few, ids.none, ids.wishOnly, ids.five]) {
      const anon = await html(`/works/${id}`)
      const res = await app.request(`/works/${id}`, { headers: { Cookie: cookie } }, env)
      expect(res.status).toBe(200)
      const authed = await res.text()
      expect(countsPart(anon).length).toBeGreaterThan(0)
      expect(countsPart(authed)).toEqual(countsPart(anon))
    }
  })
})
