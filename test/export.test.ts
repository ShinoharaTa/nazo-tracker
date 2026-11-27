import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { todayJst } from '../src/lib/time'
import { loginAs } from './helpers/auth'
import { insertOrg, insertRun, insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertSession, insertWish } from './helpers/records'

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env)

const json = async (path: string, cookie: string) => {
  const res = await get(path, { Cookie: cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    version: number
    part: number
    parts: number
    includes_spoiler: boolean
    attempts: Record<string, unknown>[]
    wishlist?: Record<string, unknown>[]
  }
}

const sessionsOf = (a: Record<string, unknown> | undefined) =>
  (a?.sessions ?? []) as (Record<string, unknown> & { id: string })[]

// 記録を n 件まとめて入れる（1 件ずつだと 501 件で遅い）
const insertManyAttempts = async (userId: string, workId: string, n: number) => {
  const now = '2026-02-01T00:00:00.000Z'
  const stmt = env.DB.prepare(
    "INSERT INTO attempt (id, user_id, work_id, status, attempt_no, created_at, updated_at) VALUES (?, ?, ?, 'cleared', ?, ?, ?)",
  )
  await env.DB.batch(
    Array.from({ length: n }, (_, i) => stmt.bind(ulid(), userId, workId, i + 1, now, now)),
  )
}

describe('/settings/export', () => {
  it('未ログインは画面も data.json も 302 /login', async () => {
    for (const path of ['/settings/export', '/settings/export/data.json?part=1']) {
      const res = await get(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
  })

  it('Authorization 付きは cookie があっても 403', async () => {
    const { cookie } = await loginAs(env, { subject: 'ex-bearer' })
    for (const path of ['/settings/export', '/settings/export/data.json?part=1']) {
      const res = await get(path, { Cookie: cookie, Authorization: 'Bearer x' })
      expect(res.status).toBe(403)
    }
  })

  it('設定の MenuItem がリンクになっている', async () => {
    const { cookie } = await loginAs(env, { subject: 'ex-menu' })
    const html = await (await get('/settings', { Cookie: cookie })).text()
    expect(html).toContain('<a href="/settings/export"><span>自分のデータをエクスポート</span></a>')
  })

  it('画面に件数と part のリンク。spoiler=1 でチェックが入り、リンクに引き継ぐ', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'ex-page' })
    const w = await insertWork(env, { title: 'エクスポート 画面' })
    const a = await insertAttempt(env, { userId, workId: w, status: 'cleared' })
    await insertSession(env, { attemptId: a, userId, playedOn: '2026-03-01' })
    await insertWish(env, userId, w)

    const plain = await get('/settings/export', { Cookie: cookie })
    expect(plain.status).toBe(200)
    expect(plain.headers.get('cache-control')).toBe('private, no-store')
    const html = await plain.text()
    expect(html).toContain('<span>記録</span><span class="note">1 件</span>')
    expect(html).toContain('<span>進行ログ</span><span class="note">1 件</span>')
    expect(html).toContain('<span>マイリスト</span><span class="note">1 件</span>')
    expect(html).toContain('href="/settings/export/data.json?part=1"')
    expect(html).toContain('人に渡すファイルには入れないでください。')
    expect(html).not.toMatch(/name="spoiler" value="1" checked/)

    const sp = await (await get('/settings/export?spoiler=1', { Cookie: cookie })).text()
    expect(sp).toMatch(/name="spoiler" value="1" checked/)
    expect(sp).toContain('href="/settings/export/data.json?part=1&amp;spoiler=1"')
  })

  it('0 件でも part 1 は 200 で空配列。ヘッダ（no-store・noindex・attachment・ファイル名）', async () => {
    const { cookie } = await loginAs(env, { subject: 'ex-empty' })
    const res = await get('/settings/export/data.json?part=1', { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    const ymd = todayJst().replaceAll('-', '')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="nazo-data-${ymd}-p1.json"`,
    )
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      version: 1,
      part: 1,
      parts: 1,
      includes_spoiler: false,
      attempts: [],
      wishlist: [],
    })
    expect(typeof body.exported_at).toBe('string')
  })

  it('他人の記録・進行ログ・マイリストが 1 行も混ざらない', async () => {
    const me = await loginAs(env, { subject: 'ex-me' })
    const other = await loginAs(env, { subject: 'ex-other' })
    const w = await insertWork(env, { title: 'エクスポート 他人' })
    const mine = await insertAttempt(env, { userId: me.userId, workId: w, status: 'cleared' })
    const theirs = await insertAttempt(env, {
      userId: other.userId,
      workId: w,
      status: 'failed',
      memo: '他人のメモ',
      spoilerMemo: '他人のネタバレ',
    })
    await insertSession(env, { attemptId: theirs, userId: other.userId, playedOn: '2026-03-02' })
    await insertGenre(env, theirs, other.userId, 'g_logic')
    await insertWish(env, other.userId, w)

    const body = await json('/settings/export/data.json?part=1&spoiler=1', me.cookie)
    expect(body.attempts.map((a) => a.id)).toEqual([mine])
    expect(body.attempts[0]?.sessions).toEqual([])
    expect(body.attempts[0]?.genres).toEqual([])
    expect(body.wishlist).toEqual([])
    const text = JSON.stringify(body)
    expect(text).not.toContain(theirs)
    expect(text).not.toContain('他人の')

    const page = await (await get('/settings/export', { Cookie: me.cookie })).text()
    expect(page).toContain('<span>記録</span><span class="note">1 件</span>')
    expect(page).toContain('<span>進行ログ</span><span class="note">0 件</span>')
    expect(page).toContain('<span>マイリスト</span><span class="note">0 件</span>')
  })

  it('spoiler=1 無しでは spoiler_memo のキーも本文も無く、有りでは入る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'ex-spoiler' })
    const w = await insertWork(env, { title: 'エクスポート ネタバレ' })
    await insertAttempt(env, {
      userId,
      workId: w,
      status: 'cleared',
      spoilerMemo: '答えはカレンダー',
    })
    await insertAttempt(env, { userId, workId: w, status: 'failed', attemptNo: 2 })

    const plain = await get('/settings/export/data.json?part=1', { Cookie: cookie })
    const text = await plain.text()
    expect(text).not.toContain('spoiler_memo')
    expect(text).not.toContain('答えはカレンダー')
    expect(JSON.parse(text).includes_spoiler).toBe(false)

    const body = await json('/settings/export/data.json?part=1&spoiler=1', cookie)
    expect(body.includes_spoiler).toBe(true)
    expect(body.attempts.map((a) => a.spoiler_memo)).toEqual(['答えはカレンダー', null])
    expect(body.attempts.every((a) => 'spoiler_memo' in a)).toBe(true)
  })

  it('記録の項目・進行ログ・ジャンルが正しい記録にぶら下がる。wishlist は part 1', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'ex-shape' })
    const org = await insertOrg(env, { name: 'エクスポート団体' })
    const w1 = await insertWork(env, { title: 'エクスポート 形 1', kind: 'hall', orgId: org })
    const w2 = await insertWork(env, { title: 'エクスポート 形 2', kind: 'takeaway' })
    const venue = await insertVenue(env, { name: 'エクスポート会場', prefecture: '東京都' })
    const run = await insertRun(env, { workId: w1, channel: 'performance', venueId: venue })
    const a1 = await insertAttempt(env, {
      userId,
      workId: w1,
      runId: run,
      status: 'cleared',
      finishedOn: '2026-03-10',
      partySize: 4,
      companions: 'A、B',
      rating: 5,
      difficulty: 3,
      volume: 2,
      memo: 'メモ 1',
    })
    const a2 = await insertAttempt(env, { userId, workId: w2, status: 'in_progress' })
    await insertGenre(env, a1, userId, 'g_coop')
    await insertGenre(env, a1, userId, 'g_logic')
    await insertGenre(env, a2, userId, 'g_story')
    const s2 = await insertSession(env, {
      attemptId: a1,
      userId,
      playedOn: '2026-03-10',
      memo: '2 回目',
    })
    const s1 = await insertSession(env, {
      attemptId: a1,
      userId,
      playedOn: '2026-03-09',
      durationSec: 3600,
      progressNote: '半分',
    })
    const s3 = await insertSession(env, { attemptId: a2, userId, playedOn: '2026-03-11' })
    await insertWish(env, userId, w2, '2026-01-05T00:00:00.000Z')

    const body = await json('/settings/export/data.json?part=1', cookie)
    const [x1, x2] = body.attempts
    expect(body.attempts.map((a) => a.id)).toEqual([a1, a2])
    expect(x1).toMatchObject({
      work: { id: w1, title: 'エクスポート 形 1', kind: 'hall', organization: 'エクスポート団体' },
      run_id: run,
      venue: { name: 'エクスポート会場', prefecture: '東京都' },
      status: 'cleared',
      attempt_no: 1,
      finished_on: '2026-03-10',
      party_size: 4,
      companions: 'A、B',
      rating: 5,
      difficulty: 3,
      volume: 2,
      memo: 'メモ 1',
      source_ref: null,
      // genre.sort_order 順（論理 2 → 協力 7）
      genres: ['論理', '協力'],
    })
    expect(sessionsOf(x1).map((s) => s.id)).toEqual([s1, s2])
    expect(sessionsOf(x1)[0]).toEqual({
      id: s1,
      played_on: '2026-03-09',
      started_at: null,
      ended_at: null,
      duration_sec: 3600,
      progress_note: '半分',
      companions: null,
      memo: null,
      location_text: null,
      created_at: expect.any(String),
    })
    expect(x2).toMatchObject({
      work: { id: w2, kind: 'takeaway', organization: null },
      run_id: null,
      venue: null,
      genres: ['ストーリー'],
    })
    expect(sessionsOf(x2).map((s) => s.id)).toEqual([s3])
    expect(body.wishlist).toEqual([
      {
        work: { id: w2, title: 'エクスポート 形 2', kind: 'takeaway', organization: null },
        memo: null,
        created_at: '2026-01-05T00:00:00.000Z',
      },
    ])
  })

  it('501 件で parts=2、part=2 に 1 件で wishlist キー無し。part=3・0・abc・無しは 404', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'ex-parts' })
    const w = await insertWork(env, { title: 'エクスポート 501' })
    await insertManyAttempts(userId, w, 501)
    await insertWish(env, userId, w)

    const page = await (await get('/settings/export', { Cookie: cookie })).text()
    expect(page).toContain('href="/settings/export/data.json?part=2"')
    expect(page).not.toContain('part=3')

    const p1 = await json('/settings/export/data.json?part=1', cookie)
    expect(p1).toMatchObject({ part: 1, parts: 2 })
    expect(p1.attempts).toHaveLength(500)
    expect(p1.wishlist).toHaveLength(1)
    const ids = p1.attempts.map((a) => a.id as string)
    expect(ids).toEqual([...ids].sort())

    const res = await get('/settings/export/data.json?part=2', { Cookie: cookie })
    expect(res.headers.get('content-disposition')).toMatch(/-p2\.json"$/)
    const p2 = (await res.json()) as { part: number; parts: number; attempts: { id: string }[] }
    expect(p2).toMatchObject({ part: 2, parts: 2 })
    expect(p2.attempts).toHaveLength(1)
    expect(p2.attempts[0]?.id > (ids.at(-1) ?? '')).toBe(true)
    expect('wishlist' in p2).toBe(false)

    for (const q of ['?part=3', '?part=0', '?part=abc', '?part=1.5', '?part=01', '']) {
      const r = await get(`/settings/export/data.json${q}`, { Cookie: cookie })
      expect(r.status, q).toBe(404)
    }
  })
})
