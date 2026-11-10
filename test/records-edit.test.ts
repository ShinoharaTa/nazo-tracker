import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { type AttemptPatch, scopedTo } from '../src/db/scoped'
import app from '../src/index'
import { todayJst } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertRun, insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertImage, insertSession } from './helpers/records'

const SPOILER = '答えは「あさがお」。'

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'records-edit-alice' })
  bob = await loginAs(env, { subject: 'records-edit-bob' })
  ids.work = await insertWork(env, { title: '編集テストの謎', kind: 'room' })
  ids.otherWork = await insertWork(env, { title: '別作品の謎' })
  ids.venue = await insertVenue(env, { name: '編集会場', prefecture: '東京都' })
  ids.run = await insertRun(env, {
    workId: ids.work,
    channel: 'performance',
    venueId: ids.venue,
    startOn: '2026-09-01',
    endOn: '2026-12-31',
  })
  ids.otherRun = await insertRun(env, { workId: ids.otherWork, channel: 'online' })
})

const get = (path: string, cookie = alice.cookie, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { Cookie: cookie, ...headers } }, env)

const post = (path: string, body: [string, string][], cookie = alice.cookie) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )

type Row = {
  status: string
  run_id: string | null
  purchased_on: string | null
  started_on: string | null
  finished_on: string | null
  duration_sec: number | null
  party_size: number | null
  companions: string | null
  rating: number | null
  difficulty: number | null
  volume: number | null
  memo: string | null
  spoiler_memo: string | null
  updated_at: string
}

const rowOf = (id: string) =>
  env.DB.prepare('SELECT * FROM attempt WHERE id = ?').bind(id).first<Row>()

const genresOf = async (id: string) =>
  (
    await env.DB.prepare(
      'SELECT genre_id, user_id FROM attempt_genre WHERE attempt_id = ? ORDER BY genre_id',
    )
      .bind(id)
      .all<{ genre_id: string; user_id: string }>()
  ).results

const countOf = async (table: string, id: string) =>
  (
    await env.DB.prepare(
      `SELECT count(*) AS n FROM ${table} WHERE ${table === 'attempt' ? 'id' : 'attempt_id'} = ?`,
    )
      .bind(id)
      .first<{ n: number }>()
  )?.n

const fullEdit = (over: Record<string, string> = {}): [string, string][] => {
  const base: Record<string, string> = {
    status: 'cleared',
    run_id: ids.run,
    purchased_on: '2026-08-20',
    started_on: '2026-09-10',
    finished_on: '2026-09-12',
    duration_min: '95',
    party_size: '4',
    companions: 'みお、けい',
    rating: '5',
    difficulty: '4',
    volume: '3',
    memo: '一行目\n二行目',
    ...over,
  }
  return [...Object.entries(base), ['genre', 'g_logic'], ['genre', 'g_coop']]
}

describe('詳しい編集 /records/:id/edit', () => {
  it('GET はフォームに今の値・回・ジャンルを出し、ネタバレメモは出さない', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      runId: ids.run,
      durationSec: 5400,
      difficulty: 2,
      spoilerMemo: SPOILER,
    })
    await insertGenre(env, id, alice.userId, 'g_story')
    const res = await get(`/records/${id}/edit`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`action="/records/${id}/edit"`)
    expect(html).toContain(`<option value="${ids.run}" selected="">`)
    expect(html).toContain('公演 · 編集会場 · 2026-09-01〜2026-12-31')
    expect(html).not.toContain(ids.otherRun)
    expect(html).toContain('name="duration_min" value="90"')
    expect(html).toMatch(/name="genre" value="g_story" checked=""/)
    expect(html).toMatch(/name="genre" value="g_logic"(?! checked)/)
    expect(html).not.toContain(SPOILER)
    expect(html).not.toContain('spoiler_memo')
  })

  it('全項目を送る → 302 ?saved=1、行と attempt_genre が更新される', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    await insertGenre(env, id, alice.userId, 'g_story')
    const before = await rowOf(id)
    const res = await post(`/records/${id}/edit`, fullEdit())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/records/${id}?saved=1`)
    const r = await rowOf(id)
    expect(r).toMatchObject({
      status: 'cleared',
      run_id: ids.run,
      purchased_on: '2026-08-20',
      started_on: '2026-09-10',
      finished_on: '2026-09-12',
      duration_sec: 95 * 60,
      party_size: 4,
      companions: 'みお、けい',
      rating: 5,
      difficulty: 4,
      volume: 3,
      memo: '一行目\n二行目',
    })
    expect((r?.updated_at ?? '') > (before?.updated_at ?? '')).toBe(true)
    expect(await genresOf(id)).toEqual([
      { genre_id: 'g_coop', user_id: alice.userId },
      { genre_id: 'g_logic', user_id: alice.userId },
    ])
    const detail = await (await get(`/records/${id}?saved=1`)).text()
    expect(detail.match(/class="gtag"/g)?.length).toBe(2)
    expect(detail).toContain('保存しました')
  })

  it('空欄は NULL、ジャンルを全部外すと 0 行', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      finishedOn: '2026-09-01',
      rating: 3,
      memo: 'あり',
    })
    await insertGenre(env, id, alice.userId, 'g_story')
    const res = await post(`/records/${id}/edit`, [['status', 'failed']])
    expect(res.status).toBe(302)
    const r = await rowOf(id)
    expect(r).toMatchObject({
      status: 'failed',
      run_id: null,
      finished_on: null,
      rating: null,
      memo: null,
      duration_sec: null,
    })
    expect(await genresOf(id)).toEqual([])
  })

  it.each([
    ['開始日 > 終了日', { started_on: '2026-09-13', finished_on: '2026-09-12' }],
    ['別作品の run', { run_id: '' }],
    ['rating=6', { rating: '6' }],
    ['status 無し', { status: '' }],
    ['不正な日付', { purchased_on: '2026-02-30' }],
    ['duration_min=0', { duration_min: '0' }],
  ] as [string, Record<string, string>][])('%s → 400、行は不変', async (_, over) => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      memo: '元のメモ',
    })
    const body = fullEdit(over.run_id === '' ? { run_id: ids.otherRun } : over)
    const res = await post(`/records/${id}/edit`, body)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('role="alert"')
    // 送信値を埋め戻す
    expect(html).toContain('value="みお、けい"')
    expect((await rowOf(id))?.memo).toBe('元のメモ')
    expect(await genresOf(id)).toEqual([])
  })

  it('未知の genre → 400', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
    })
    const res = await post(`/records/${id}/edit`, [
      ['status', 'cleared'],
      ['genre', 'zzz'],
    ])
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('ジャンルの値が正しくありません。')
    expect(await genresOf(id)).toEqual([])
  })

  it('bob が alice の id に GET / POST → 404、行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      memo: 'alice のメモ',
    })
    expect((await get(`/records/${id}/edit`, bob.cookie)).status).toBe(404)
    const res = await post(`/records/${id}/edit`, fullEdit(), bob.cookie)
    expect(res.status).toBe(404)
    const r = await rowOf(id)
    expect(r).toMatchObject({ status: 'in_progress', memo: 'alice のメモ' })
    expect(await genresOf(id)).toEqual([])
  })

  it('Origin が別オリジンの POST → 403、行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      memo: '元のメモ',
    })
    const res = await app.request(
      `/records/${id}/edit`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: alice.cookie,
        },
        body: new URLSearchParams(fullEdit()).toString(),
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await rowOf(id)).toMatchObject({ status: 'in_progress', memo: '元のメモ' })
    expect(await genresOf(id)).toEqual([])
  })

  it('今の run_id が作品の回に無くても選択肢に出し、そのまま保存できる', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      runId: ids.otherRun,
    })
    const html = await (await get(`/records/${id}/edit`)).text()
    expect(html).toContain(`<option value="${ids.otherRun}" selected="">`)
    const res = await post(`/records/${id}/edit`, fullEdit({ run_id: ids.otherRun }))
    expect(res.status).toBe(302)
    expect((await rowOf(id))?.run_id).toBe(ids.otherRun)
  })
})

describe('own().updateAttempt', () => {
  const db = createDb(env.DB)
  const patch: AttemptPatch = {
    status: 'cleared',
    runId: null,
    purchasedOn: null,
    startedOn: null,
    finishedOn: null,
    durationSec: null,
    partySize: null,
    companions: null,
    rating: null,
    difficulty: null,
    volume: null,
    memo: '書き換え',
  }

  it('別経路で削除済みの記録 → false（FK で落ちない）、attempt_genre も作らない', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    await env.DB.prepare('DELETE FROM attempt WHERE id = ?').bind(id).run()
    const ok = await scopedTo(db, alice.userId)
      .own()
      .updateAttempt(id, patch, ['g_logic', 'g_coop'])
    expect(ok).toBe(false)
    expect(await countOf('attempt', id)).toBe(0)
    expect(await genresOf(id)).toEqual([])
  })

  it('他人の記録 → false、行も attempt_genre も不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      memo: 'alice のメモ',
    })
    await insertGenre(env, id, alice.userId, 'g_story')
    const ok = await scopedTo(db, bob.userId).own().updateAttempt(id, patch, ['g_logic'])
    expect(ok).toBe(false)
    expect(await rowOf(id)).toMatchObject({ status: 'in_progress', memo: 'alice のメモ' })
    expect(await genresOf(id)).toEqual([{ genre_id: 'g_story', user_id: alice.userId }])
  })
})

describe('ステータス変更 /records/:id/status', () => {
  const setStatus = (id: string, status: string, on = '', cookie = alice.cookie) =>
    post(
      `/records/${id}/status`,
      [
        ['status', status],
        ['on', on],
      ],
      cookie,
    )

  it('in_progress → cleared（on あり）で finished_on = on', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      startedOn: '2026-10-01',
    })
    const res = await setStatus(id, 'cleared', '2026-11-02')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/records/${id}`)
    expect(await rowOf(id)).toMatchObject({
      status: 'cleared',
      started_on: '2026-10-01',
      finished_on: '2026-11-02',
    })
  })

  it('cleared → in_progress で finished_on NULL、started_on は既存を残す', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      startedOn: '2026-10-01',
      finishedOn: '2026-10-03',
    })
    expect((await setStatus(id, 'in_progress', '2026-11-05')).status).toBe(302)
    expect(await rowOf(id)).toMatchObject({
      status: 'in_progress',
      started_on: '2026-10-01',
      finished_on: null,
    })
  })

  it('on 空で cleared → finished_on = 今日、既存の finished_on は残す', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    await setStatus(id, 'cleared')
    expect((await rowOf(id))?.finished_on).toBe(todayJst())
    const id2 = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'failed',
      finishedOn: '2026-09-09',
    })
    await setStatus(id2, 'cleared')
    expect(await rowOf(id2)).toMatchObject({ status: 'cleared', finished_on: '2026-09-09' })
  })

  it('purchased（purchased_on NULL、on 空）→ purchased_on = 今日', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'dropped',
      finishedOn: '2026-09-09',
    })
    await setStatus(id, 'purchased')
    expect(await rowOf(id)).toMatchObject({
      status: 'purchased',
      purchased_on: todayJst(),
      finished_on: null,
    })
  })

  it('status 無し / 不正な日付 → 400 で詳細を再描画（ネタバレ本文は出さない）、行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
      spoilerMemo: SPOILER,
    })
    const res = await setStatus(id, '')
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('ステータスを選んでください。')
    expect(html).not.toContain(SPOILER)
    const res2 = await setStatus(id, 'cleared', '2026-13-01')
    expect(res2.status).toBe(400)
    expect(await res2.text()).toMatch(
      /id="status-cleared" name="status" value="cleared" checked=""/,
    )
    expect((await rowOf(id))?.status).toBe('in_progress')
  })

  it('bob → 404、行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    expect((await setStatus(id, 'cleared', '2026-11-02', bob.cookie)).status).toBe(404)
    expect(await rowOf(id)).toMatchObject({ status: 'in_progress', finished_on: null })
  })
})

describe('ネタバレメモ /records/:id/spoiler/edit', () => {
  it('GET は 3 ヘッダ付きで textarea に本文', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      spoilerMemo: SPOILER,
    })
    const res = await get(`/records/${id}/spoiler/edit`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('vary')).toContain('X-Requested-With')
    expect(await res.text()).toMatch(
      /<textarea name="spoiler_memo"[^>]*>答えは「あさがお」。<\/textarea>/,
    )
  })

  it('POST で保存 → 302 /records/:id、空で NULL になり件数が メモ 0', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
    })
    const res = await post(`/records/${id}/spoiler/edit`, [['spoiler_memo', '新しい\nネタバレ']])
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/records/${id}`)
    expect((await rowOf(id))?.spoiler_memo).toBe('新しい\nネタバレ')
    const detail = await (await get(`/records/${id}`)).text()
    expect(detail).not.toContain('新しい')
    expect(detail).toContain('メモ 1')

    expect((await post(`/records/${id}/spoiler/edit`, [['spoiler_memo', '  ']])).status).toBe(302)
    expect((await rowOf(id))?.spoiler_memo).toBeNull()
    expect(await (await get(`/records/${id}`)).text()).toContain('メモ 0')
  })

  it('長すぎる → 400 に 3 ヘッダ、行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      spoilerMemo: SPOILER,
    })
    const res = await post(`/records/${id}/spoiler/edit`, [['spoiler_memo', 'あ'.repeat(4001)]])
    expect(res.status).toBe(400)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect((await rowOf(id))?.spoiler_memo).toBe(SPOILER)
  })

  it('bob → GET / POST とも 404、本文を出さず行は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      spoilerMemo: SPOILER,
    })
    const res = await get(`/records/${id}/spoiler/edit`, bob.cookie)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SPOILER)
    expect(
      (await post(`/records/${id}/spoiler/edit`, [['spoiler_memo', 'x']], bob.cookie)).status,
    ).toBe(404)
    expect((await rowOf(id))?.spoiler_memo).toBe(SPOILER)
  })
})

describe('削除 /records/:id/delete', () => {
  const withChildren = async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
    })
    await insertSession(env, { attemptId: id, userId: alice.userId, playedOn: '2026-10-01' })
    await insertSession(env, { attemptId: id, userId: alice.userId, playedOn: '2026-10-02' })
    await insertGenre(env, id, alice.userId, 'g_logic')
    return id
  }

  it('GET は確認ページ（進行ログの件数・確認チェック）', async () => {
    const id = await withChildren()
    const res = await get(`/records/${id}/delete`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('進行ログ 2 件')
    expect(html).toContain('name="confirm" value="yes"')
    expect(html).toContain(`action="/records/${id}/delete"`)
  })

  it('confirm=yes → 302 /records、attempt / session / attempt_genre が 0 行', async () => {
    const id = await withChildren()
    const res = await post(`/records/${id}/delete`, [['confirm', 'yes']])
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')
    expect(await countOf('attempt', id)).toBe(0)
    expect(await countOf('session', id)).toBe(0)
    expect(await countOf('attempt_genre', id)).toBe(0)
    expect((await get(`/records/${id}`)).status).toBe(404)
  })

  it('image 行のある記録の削除 → image も 0 行', async () => {
    const id = await withChildren()
    await insertImage(env, id, alice.userId)
    const res = await post(`/records/${id}/delete`, [['confirm', 'yes']])
    expect(res.status).toBe(302)
    expect(await countOf('image', id)).toBe(0)
    expect(await countOf('attempt', id)).toBe(0)
  })

  it('confirm 無し → 400、行は残る', async () => {
    const id = await withChildren()
    const res = await post(`/records/${id}/delete`, [])
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('「確認しました」にチェックしてください。')
    expect(await countOf('attempt', id)).toBe(1)
    expect(await countOf('session', id)).toBe(2)
  })

  it('bob → 404、行は残る', async () => {
    const id = await withChildren()
    expect((await get(`/records/${id}/delete`, bob.cookie)).status).toBe(404)
    expect((await post(`/records/${id}/delete`, [['confirm', 'yes']], bob.cookie)).status).toBe(404)
    expect(await countOf('attempt', id)).toBe(1)
    expect(await countOf('session', id)).toBe(2)
    expect(await countOf('attempt_genre', id)).toBe(1)
  })
})

describe('詳細ページのリンク', () => {
  it('編集・削除・ネタバレ編集・ステータス変更フォーム、?created=1 の .hint', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    const html = await (await get(`/records/${id}?created=1`)).text()
    expect(html).toContain(`href="/records/${id}/edit"`)
    expect(html).toContain(`href="/records/${id}/delete"`)
    expect(html).toContain(`href="/records/${id}/spoiler/edit"`)
    expect(html).toContain(`action="/records/${id}/status"`)
    expect(html).toMatch(/id="status-in_progress" name="status" value="in_progress" checked=""/)
    expect(html).toMatch(/class="hint"[\s\S]*?href="\/records\/[0-9A-Z]+\/edit"/)
  })
})

describe('未ログイン', () => {
  it('GET は 302 /login、POST は 401', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
    })
    for (const p of ['edit', 'spoiler/edit', 'delete']) {
      const res = await app.request(`/records/${id}/${p}`, {}, env)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
    for (const p of ['edit', 'status', 'spoiler/edit', 'delete']) {
      const res = await app.request(
        `/records/${id}/${p}`,
        {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'confirm=yes&status=cleared',
        },
        env,
      )
      expect(res.status).toBe(401)
    }
    expect(await countOf('attempt', id)).toBe(1)
  })
})
