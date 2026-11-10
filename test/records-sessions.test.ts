import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { type SessionInput, scopedTo } from '../src/db/scoped'
import app from '../src/index'
import { todayJst } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertSession } from './helpers/records'

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'records-sessions-alice' })
  bob = await loginAs(env, { subject: 'records-sessions-bob' })
  ids.work = await insertWork(env, { title: '進行ログテストの謎', kind: 'stroll' })
})

const get = (path: string, cookie = alice.cookie) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

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

type AttemptRow = {
  status: string
  purchased_on: string | null
  started_on: string | null
  finished_on: string | null
  updated_at: string
}

type SessionRow = {
  id: string
  attempt_id: string
  user_id: string
  played_on: string
  duration_sec: number | null
  progress_note: string | null
  companions: string | null
  memo: string | null
  venue_id: string | null
  location_text: string | null
}

const rowOf = (id: string) =>
  env.DB.prepare('SELECT * FROM attempt WHERE id = ?').bind(id).first<AttemptRow>()

const sessionsOf = async (attemptId: string) =>
  (
    await env.DB.prepare('SELECT * FROM session WHERE attempt_id = ? ORDER BY played_on')
      .bind(attemptId)
      .all<SessionRow>()
  ).results

const addLog = (id: string, over: Record<string, string> = {}, cookie = alice.cookie) =>
  post(
    `/records/${id}/sessions`,
    Object.entries({ played_on: '2026-11-03', outcome: 'keep', ...over }),
    cookie,
  )

const newAttempt = (status: string, over: { startedOn?: string; purchasedOn?: string } = {}) =>
  insertAttempt(env, { userId: alice.userId, workId: ids.work, status, ...over })

describe('進行ログの追加 /records/:id/sessions', () => {
  it('GET はフォーム（日付は今日・結果は進行中のまま）を出す', async () => {
    const id = await newAttempt('in_progress')
    const res = await get(`/records/${id}/sessions/new`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain(`action="/records/${id}/sessions"`)
    expect(html).toContain(`name="played_on" value="${todayJst()}" required=""`)
    expect(html).toMatch(/name="outcome" value="keep" checked=""/)
    expect(html).toMatch(/name="outcome" value="cleared"(?! checked)/)
    expect(html).toContain('進行中のまま')
    expect(html).not.toContain('value="failed"')
  })

  it('全項目を送る → 302、session が 1 行（user_id = alice、venue_id NULL）', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-10-01' })
    const res = await addLog(id, {
      duration_min: '90',
      progress_note: '第3章まで',
      location_text: '横浜',
      companions: 'みお',
      memo: '一行目\n二行目',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/records/${id}`)
    const rows = await sessionsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: alice.userId,
      played_on: '2026-11-03',
      duration_sec: 5400,
      progress_note: '第3章まで',
      location_text: '横浜',
      companions: 'みお',
      memo: '一行目\n二行目',
      venue_id: null,
    })
  })

  it('purchased に keep → in_progress、started_on = played_on', async () => {
    const id = await newAttempt('purchased', { purchasedOn: '2026-10-01' })
    const before = (await rowOf(id))?.updated_at ?? ''
    expect((await addLog(id, { outcome: 'keep' })).status).toBe(302)
    const row = await rowOf(id)
    expect(row).toMatchObject({
      status: 'in_progress',
      started_on: '2026-11-03',
      purchased_on: '2026-10-01',
      finished_on: null,
    })
    expect((row?.updated_at ?? '') > before).toBe(true)
  })

  it('in_progress に keep → 開始日は残す', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-10-01' })
    await addLog(id, { outcome: 'keep' })
    expect(await rowOf(id)).toMatchObject({ status: 'in_progress', started_on: '2026-10-01' })
  })

  it('in_progress に cleared → cleared、finished_on = played_on', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-10-01' })
    await addLog(id, { outcome: 'cleared', played_on: '2026-11-03' })
    expect(await rowOf(id)).toMatchObject({
      status: 'cleared',
      started_on: '2026-10-01',
      finished_on: '2026-11-03',
    })
  })

  it('purchased（finished_on あり）に keep → in_progress、finished_on は NULL', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'purchased',
      finishedOn: '2026-10-20',
    })
    await addLog(id, { outcome: 'keep' })
    expect(await rowOf(id)).toMatchObject({ status: 'in_progress', finished_on: null })
  })

  it('cleared（開始日 NULL）に終了日より後の日付で keep → status 不変、開始日は終了日を超えない', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      finishedOn: '2026-10-20',
    })
    await addLog(id, { outcome: 'keep', played_on: '2026-11-03' })
    expect(await rowOf(id)).toMatchObject({
      status: 'cleared',
      started_on: '2026-10-20',
      finished_on: '2026-10-20',
    })
  })

  it('cleared（開始日あり）に keep → 開始日は早い方のまま', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      startedOn: '2026-10-01',
      finishedOn: '2026-10-20',
    })
    await addLog(id, { outcome: 'keep', played_on: '2026-11-03' })
    expect(await rowOf(id)).toMatchObject({ started_on: '2026-10-01', finished_on: '2026-10-20' })
    await addLog(id, { outcome: 'keep', played_on: '2026-09-15' })
    expect(await rowOf(id)).toMatchObject({ started_on: '2026-09-15', finished_on: '2026-10-20' })
  })

  it('purchased に dropped → dropped、finished_on と started_on = played_on', async () => {
    const id = await newAttempt('purchased')
    await addLog(id, { outcome: 'dropped', played_on: '2026-11-04' })
    expect(await rowOf(id)).toMatchObject({
      status: 'dropped',
      started_on: '2026-11-04',
      finished_on: '2026-11-04',
    })
  })

  it.each([
    ['played_on 無し', { played_on: '' }, '日付を入力してください。'],
    ['played_on が実在しない日', { played_on: '2026-02-30' }, '日付は YYYY-MM-DD'],
    ['outcome 無し', { outcome: '' }, '結果を選んでください。'],
    ['outcome=failed', { outcome: 'failed' }, '結果の値が正しくありません。'],
    ['duration_min=0', { duration_min: '0' }, '所要（分）は 1〜6000'],
  ])('%s → 400、送信値を埋め戻し、行は増えない', async (_, over, message) => {
    const id = await newAttempt('in_progress')
    const res = await addLog(id, { progress_note: '途中', ...over })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain(message)
    expect(html).toContain('name="progress_note" value="途中"')
    expect(await sessionsOf(id)).toHaveLength(0)
    expect((await rowOf(id))?.status).toBe('in_progress')
  })

  it('body の attempt_id / venue_id は無視する（他人の記録に書かない・venue_id は NULL）', async () => {
    const mine = await newAttempt('in_progress')
    const bobs = await insertAttempt(env, {
      userId: bob.userId,
      workId: ids.work,
      status: 'in_progress',
    })
    const venue = await insertVenue(env, { name: '混ぜた会場' })
    const res = await addLog(mine, { attempt_id: bobs, venue_id: venue, user_id: bob.userId })
    expect(res.status).toBe(302)
    const rows = await sessionsOf(mine)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: alice.userId, venue_id: null })
    expect(await sessionsOf(bobs)).toHaveLength(0)
  })

  it('progress_note・memo の <script> はエスケープして出す', async () => {
    const id = await newAttempt('in_progress')
    await addLog(id, { progress_note: '<script>alert(1)</script>', memo: '<script>x</script>' })
    const html = await (await get(`/records/${id}`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('Origin 無しの POST → 403、行は増えない', async () => {
    const id = await newAttempt('in_progress')
    const res = await app.request(
      `/records/${id}/sessions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: alice.cookie,
        },
        body: new URLSearchParams({ played_on: '2026-11-03', outcome: 'keep' }).toString(),
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await sessionsOf(id)).toHaveLength(0)
  })

  it('bob が alice の記録に GET / POST → 404、行は増えない', async () => {
    const id = await newAttempt('purchased')
    expect((await get(`/records/${id}/sessions/new`, bob.cookie)).status).toBe(404)
    expect((await addLog(id, { outcome: 'cleared' }, bob.cookie)).status).toBe(404)
    expect(await sessionsOf(id)).toHaveLength(0)
    expect((await rowOf(id))?.status).toBe('purchased')
  })

  it('無い id → 404', async () => {
    expect((await addLog('nope')).status).toBe(404)
  })
})

describe('日付の逆転防止（started_on <= finished_on）', () => {
  it('started 11-05 の進行中に played_on 11-01 で cleared → started / finished とも 11-01、/edit で保存できる', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-11-05' })
    await addLog(id, { outcome: 'cleared', played_on: '2026-11-01' })
    expect(await rowOf(id)).toMatchObject({
      status: 'cleared',
      started_on: '2026-11-01',
      finished_on: '2026-11-01',
    })
    expect((await get(`/records/${id}/edit`)).status).toBe(200)
    const res = await post(`/records/${id}/edit`, [
      ['status', 'cleared'],
      ['started_on', '2026-11-01'],
      ['finished_on', '2026-11-01'],
      ['memo', '保存できる'],
    ])
    expect(res.status).toBe(302)
    expect((await rowOf(id))?.started_on).toBe('2026-11-01')
  })

  it('keep で played_on が開始日より前 → 開始日を下げる', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-11-05' })
    await addLog(id, { outcome: 'keep', played_on: '2026-11-02' })
    expect((await rowOf(id))?.started_on).toBe('2026-11-02')
  })

  const setStatus = (id: string, status: string, on: string) =>
    post(`/records/${id}/status`, [
      ['status', status],
      ['on', on],
    ])

  it('ステータス変更で cleared（on が開始日より前）→ 開始日を下げる', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-11-05' })
    expect((await setStatus(id, 'cleared', '2026-11-01')).status).toBe(302)
    expect(await rowOf(id)).toMatchObject({ started_on: '2026-11-01', finished_on: '2026-11-01' })
  })

  it('ステータス変更で cleared（開始日 NULL）→ 開始日は NULL のまま', async () => {
    const id = await newAttempt('purchased')
    await setStatus(id, 'cleared', '2026-11-01')
    expect(await rowOf(id)).toMatchObject({ started_on: null, finished_on: '2026-11-01' })
  })

  it('ステータス変更で in_progress（on が開始日より前 / 後）→ 早い方', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-11-05' })
    await setStatus(id, 'in_progress', '2026-11-08')
    expect((await rowOf(id))?.started_on).toBe('2026-11-05')
    await setStatus(id, 'in_progress', '2026-11-02')
    expect((await rowOf(id))?.started_on).toBe('2026-11-02')
  })
})

describe('全経路で started_on <= finished_on', () => {
  const setStatus = (id: string, status: string, on: string) =>
    post(`/records/${id}/status`, [
      ['status', status],
      ['on', on],
    ])
  // [種類, 値, 日付]。status はステータス変更、それ以外は進行ログの結果
  const steps: [kind: 'status' | 'log', value: string, on: string][] = [
    ['log', 'keep', '2026-11-20'],
    ['log', 'keep', '2026-11-03'],
    ['log', 'cleared', '2026-11-01'],
    ['log', 'keep', '2026-11-10'],
    ['status', 'dropped', '2026-10-30'],
    ['log', 'keep', '2026-11-12'],
    ['status', 'in_progress', '2026-10-25'],
    ['log', 'dropped', '2026-10-20'],
    ['status', 'failed', ''],
    ['log', 'keep', '2026-12-01'],
    ['status', 'cleared', '2026-10-10'],
    ['log', 'keep', '2026-10-05'],
    ['status', 'purchased', '2026-11-20'],
    ['log', 'keep', '2026-11-21'],
    ['log', 'cleared', '2026-11-02'],
    ['status', 'in_progress', ''],
    ['log', 'dropped', '2026-12-05'],
  ]

  it.each(['purchased', 'in_progress', 'cleared', 'failed', 'dropped'])(
    '作成（%s, 2026-11-05）→ ステータス変更・進行ログを重ねても逆転しない',
    async (status) => {
      const created = await post('/records', [
        ['work_id', ids.work],
        ['status', status],
        ['on', '2026-11-05'],
      ])
      expect(created.status).toBe(302)
      const id = (created.headers.get('Location') ?? '').split('?')[0].split('/').pop() ?? ''
      const check = async (label: string) => {
        const r = await rowOf(id)
        if (r?.started_on && r.finished_on) {
          expect(
            r.started_on <= r.finished_on,
            `${label}: ${r.started_on} > ${r.finished_on}`,
          ).toBe(true)
        }
      }
      await check('作成')
      for (const [kind, value, on] of steps) {
        const res =
          kind === 'status'
            ? await setStatus(id, value, on)
            : await addLog(id, { outcome: value, played_on: on })
        expect(res.status).toBe(302)
        await check(`${kind} ${value} ${on}`)
      }
    },
  )
})

describe('own().addSession', () => {
  const db = createDb(env.DB)
  const input: SessionInput = {
    playedOn: '2026-11-05',
    durationSec: null,
    progressNote: null,
    locationText: null,
    companions: null,
    memo: null,
  }

  it('別経路で削除済みの記録 → false（FK で落ちない）、session も作らない', async () => {
    const id = await newAttempt('in_progress')
    await env.DB.prepare('DELETE FROM attempt WHERE id = ?').bind(id).run()
    expect(await scopedTo(db, alice.userId).own().addSession(id, input, 'cleared')).toBe(false)
    expect(await sessionsOf(id)).toHaveLength(0)
  })

  it('他人の記録 → false、session も attempt も不変', async () => {
    const id = await newAttempt('in_progress')
    expect(await scopedTo(db, bob.userId).own().addSession(id, input, 'cleared')).toBe(false)
    expect(await sessionsOf(id)).toHaveLength(0)
    expect((await rowOf(id))?.status).toBe('in_progress')
  })
})

describe('進行ログの表示', () => {
  it('ログ 2 件の進行中: display_on は最新ログ日、件数と合計時間、日目', async () => {
    const id = await newAttempt('in_progress', { startedOn: '2026-10-01' })
    await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-04',
      durationSec: 3600,
      progressNote: '第1章まで',
    })
    await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-11',
      durationSec: 5400,
      progressNote: '第2章まで',
    })
    const v = await env.DB.prepare(
      'SELECT display_on, session_count, session_duration_sec FROM v_attempt_enriched WHERE id = ?',
    )
      .bind(id)
      .first()
    expect(v).toEqual({ display_on: '2026-10-11', session_count: 2, session_duration_sec: 9000 })
    const html = await (await get(`/records/${id}`)).text()
    expect(html).toContain('第2章まで · 2 日目')
    expect(html).toContain('2時間30分')
    expect(html).toContain(`href="/records/${id}/sessions/new"`)
    expect(html.match(/class="log"/g)).toHaveLength(2)
    expect(html.indexOf('第2章まで</b>')).toBeLessThan(html.indexOf('第1章まで</b>'))
    expect(html).not.toContain('<details class="older">')
  })

  it('6 件以上は新しい 5 件を出し、残りを <details> に畳む', async () => {
    const id = await newAttempt('in_progress')
    for (let d = 1; d <= 7; d++) {
      await insertSession(env, {
        attemptId: id,
        userId: alice.userId,
        playedOn: `2026-10-0${d}`,
        progressNote: `ログ${d}`,
      })
    }
    const html = await (await get(`/records/${id}`)).text()
    const [open, folded] = html.split('<details class="older">')
    expect(open.match(/class="log"/g)).toHaveLength(5)
    expect(open).toContain('ログ3</b>')
    expect(open).not.toContain('ログ2</b>')
    expect(folded).toContain('古い進行ログ 2 件を表示')
    expect(folded).toContain('ログ2</b>')
    expect(folded).toContain('ログ1</b>')
  })
})

describe('進行ログの削除 /records/:id/sessions/:sid/delete', () => {
  it('削除 → 302、行が消え、記録の status / 日付は不変', async () => {
    const id = await insertAttempt(env, {
      userId: alice.userId,
      workId: ids.work,
      status: 'cleared',
      startedOn: '2026-10-01',
      finishedOn: '2026-10-11',
    })
    const sid = await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-11',
    })
    const html = await (await get(`/records/${id}`)).text()
    expect(html).toContain(`action="/records/${id}/sessions/${sid}/delete"`)
    expect(html).toContain('<summary class="note">削除</summary>')
    expect(html).toContain('10/11 のログを削除')
    const res = await post(`/records/${id}/sessions/${sid}/delete`, [])
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/records/${id}`)
    expect(await sessionsOf(id)).toHaveLength(0)
    expect(await rowOf(id)).toMatchObject({
      status: 'cleared',
      started_on: '2026-10-01',
      finished_on: '2026-10-11',
    })
  })

  it('Origin 無しの POST → 403、行は残る', async () => {
    const id = await newAttempt('in_progress')
    const sid = await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-11',
    })
    const res = await app.request(
      `/records/${id}/sessions/${sid}/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: alice.cookie },
        body: '',
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await sessionsOf(id)).toHaveLength(1)
  })

  it('bob → 404、行は残る', async () => {
    const id = await newAttempt('in_progress')
    const sid = await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-11',
    })
    expect((await post(`/records/${id}/sessions/${sid}/delete`, [], bob.cookie)).status).toBe(404)
    expect(await sessionsOf(id)).toHaveLength(1)
  })

  it('別の記録のログ id・無いログ id → 404、行は残る', async () => {
    const a = await newAttempt('in_progress')
    const b = await newAttempt('in_progress')
    const sid = await insertSession(env, {
      attemptId: b,
      userId: alice.userId,
      playedOn: '2026-10-11',
    })
    expect((await post(`/records/${a}/sessions/${sid}/delete`, [])).status).toBe(404)
    expect((await post(`/records/${a}/sessions/nope/delete`, [])).status).toBe(404)
    expect(await sessionsOf(b)).toHaveLength(1)
  })
})
