import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertWork } from './helpers/master'
import { insertAttempt, insertSession } from './helpers/records'

// 来場型（ルーム・公演）の作品はステータスが 予約済み / クリア / 失敗 だけ（issue #76）

let alice = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'records-visit-alice' })
  ids.room = await insertWork(env, { title: '来場型のルーム', kind: 'room' })
  ids.hall = await insertWork(env, { title: '来場型の公演', kind: 'hall' })
  ids.stroll = await insertWork(env, { title: '周遊型の謎', kind: 'stroll' })
  ids.takeaway = await insertWork(env, { title: '持ち帰りの謎', kind: 'takeaway' })
})

const get = (path: string) => app.request(path, { headers: { Cookie: alice.cookie } }, env)

const post = (path: string, body: Record<string, string>) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: alice.cookie,
      },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )

const rowOf = (id: string) =>
  env.DB.prepare('SELECT status, purchased_on FROM attempt WHERE id = ?')
    .bind(id)
    .first<{ status: string; purchased_on: string | null }>()

const sessionCount = async (id: string) =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM session WHERE attempt_id = ?')
      .bind(id)
      .first<{ n: number }>()
  )?.n

// ステータスの radio の value（出てくる順）
const statusValues = (html: string, name = 'status') =>
  [...html.matchAll(new RegExp(`name="${name}" value="([a-z_]+)"`, 'g'))].map((m) => m[1])

const newAttempt = (workId: string, status: string, over: { purchasedOn?: string } = {}) =>
  insertAttempt(env, { userId: alice.userId, workId, status, ...over })

describe('来場型の選択肢', () => {
  it('作成フォーム: room / hall は 3 択で「予約済み」', async () => {
    for (const work of [ids.room, ids.hall]) {
      const h = await (await get(`/records/new?work=${work}`)).text()
      expect(statusValues(h)).toEqual(['purchased', 'cleared', 'failed'])
      expect(h).toContain('>予約済み</label>')
      expect(h).not.toContain('>買った</label>')
      expect(h).toContain('予約済み → 参加予定日、成功・失敗 → 参加した日として保存します。')
      expect(h).not.toContain('進行中 → 始めた日')
    }
  })

  it('詳細のステータス変更・編集フォームも 3 択', async () => {
    const id = await newAttempt(ids.room, 'cleared')
    const detail = await (await get(`/records/${id}`)).text()
    expect(statusValues(detail)).toEqual(['purchased', 'cleared', 'failed'])
    expect(detail).toContain('>予約済み</label>')
    const edit = await (await get(`/records/${id}/edit`)).text()
    expect(statusValues(edit)).toEqual(['purchased', 'cleared', 'failed'])
  })

  it('cleared は「成功」（選択肢・チップ・作品詳細のあなたの記録）', async () => {
    const id = await newAttempt(ids.hall, 'cleared')
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<label for="status-cleared">成功</label>')
    expect(h).toContain('<span class="chip lg st-cleared">成功</span>')
    expect(h).not.toContain('>クリア<')
    const w = await (await get(`/works/${ids.hall}`)).text()
    expect(w).toContain('<span>成功</span>')
  })

  it('チップも「予約済み」', async () => {
    const id = await newAttempt(ids.hall, 'purchased')
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<span class="chip lg st-purchased">予約済み</span>')
  })

  it('既存の in_progress は選択肢に残す（ラベルは「進行中」のまま）', async () => {
    const id = await newAttempt(ids.room, 'in_progress')
    const h = await (await get(`/records/${id}`)).text()
    expect(statusValues(h)).toEqual(['purchased', 'in_progress', 'cleared', 'failed'])
    expect(h).toMatch(/value="in_progress" checked=""\/><label for="status-in_progress">進行中/)
    const edit = await (await get(`/records/${id}/edit`)).text()
    expect(statusValues(edit)).toEqual(['purchased', 'in_progress', 'cleared', 'failed'])
  })
})

describe('来場型のサーバー側の検証', () => {
  it('POST /records で in_progress / dropped → 400、作られない', async () => {
    for (const status of ['in_progress', 'dropped']) {
      const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempt').first<{
        n: number
      }>()
      const res = await post('/records', { work_id: ids.room, status, on: '2026-11-01' })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('ルーム・公演では選べないステータスです')
      const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempt').first<{
        n: number
      }>()
      expect(after?.n).toBe(before?.n)
    }
  })

  it('ステータス変更・編集で in_progress → 400、値は変わらない', async () => {
    const id = await newAttempt(ids.hall, 'purchased')
    const s = await post(`/records/${id}/status`, { status: 'in_progress', on: '' })
    expect(s.status).toBe(400)
    expect(await s.text()).toContain('ルーム・公演では選べないステータスです')
    const e = await post(`/records/${id}/edit`, { status: 'dropped' })
    expect(e.status).toBe(400)
    expect(await e.text()).toContain('ルーム・公演では選べないステータスです')
    expect((await rowOf(id))?.status).toBe('purchased')
  })

  it('今の値が in_progress なら、そのままの保存は通る', async () => {
    const id = await newAttempt(ids.room, 'in_progress')
    expect((await post(`/records/${id}/status`, { status: 'in_progress', on: '' })).status).toBe(
      302,
    )
    expect((await post(`/records/${id}/edit`, { status: 'in_progress' })).status).toBe(302)
    expect((await rowOf(id))?.status).toBe('in_progress')
  })
})

describe('来場型の進行ログ', () => {
  it('詳細に「進行ログ」の節とボタンが出ない', async () => {
    const id = await newAttempt(ids.room, 'cleared')
    const h = await (await get(`/records/${id}`)).text()
    expect(h).not.toContain('<h2>進行ログ</h2>')
    expect(h).not.toContain(`/records/${id}/sessions/new`)
  })

  it('既存の進行ログがあれば節と一覧・削除は出し、「＋ 進行ログ」だけ出さない', async () => {
    const id = await newAttempt(ids.room, 'in_progress')
    const sid = await insertSession(env, {
      attemptId: id,
      userId: alice.userId,
      playedOn: '2026-10-05',
      progressNote: '形式変更前のログ',
    })
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<h2>進行ログ</h2>')
    expect(h).toContain('形式変更前のログ')
    expect(h).toContain(`action="/records/${id}/sessions/${sid}/delete"`)
    expect(h).not.toContain(`/records/${id}/sessions/new`)
    const del = await post(`/records/${id}/sessions/${sid}/delete`, {})
    expect(del.status).toBe(302)
    expect(await sessionCount(id)).toBe(0)
  })

  it('GET /records/:id/sessions/new → 詳細へ 302', async () => {
    const id = await newAttempt(ids.room, 'cleared')
    const res = await get(`/records/${id}/sessions/new`)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/records/${id}`)
  })

  it('POST /records/:id/sessions → 400、ログは足されない', async () => {
    const id = await newAttempt(ids.hall, 'purchased')
    const res = await post(`/records/${id}/sessions`, { played_on: '2026-11-03', outcome: 'keep' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('ルーム・公演には進行ログがありません')
    expect(await sessionCount(id)).toBe(0)
    expect((await rowOf(id))?.status).toBe('purchased')
  })
})

describe('来場型の予約済みの日付', () => {
  it('詳細の kv・ステータス変更・編集フォームのラベルが「参加予定日」', async () => {
    const id = await newAttempt(ids.room, 'purchased', { purchasedOn: '2026-12-24' })
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<dt>参加予定日</dt><dd>2026-12-24</dd>')
    expect(h).toContain('<label class="field">参加予定日<input type="date" name="on"')
    expect(h).not.toContain('<dt>買った日</dt>')
    const edit = await (await get(`/records/${id}/edit`)).text()
    expect(edit).toContain('参加予定日<input type="date" name="purchased_on"')
  })

  it('作成フォームの 400 の再描画（purchased）も「参加予定日」', async () => {
    const res = await post('/records', { work_id: ids.room, status: 'purchased', on: 'x' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain(
      '<label class="field">参加予定日<input type="date" name="on"',
    )
  })

  it('未来の参加予定日で保存できる（purchased_on）', async () => {
    const res = await post('/records', { work_id: ids.hall, status: 'purchased', on: '2027-03-01' })
    expect(res.status).toBe(302)
    const id = (res.headers.get('Location') ?? '').match(/\/records\/([^?]+)/)?.[1] ?? ''
    expect(await rowOf(id)).toMatchObject({ status: 'purchased', purchased_on: '2027-03-01' })
  })

  it('クリア済みの記録の買った日はそのまま「買った日」', async () => {
    const id = await newAttempt(ids.room, 'cleared', { purchasedOn: '2026-10-01' })
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<dt>買った日</dt><dd>2026-10-01</dd>')
  })
})

describe('持ち帰り', () => {
  it('選択肢は failed を除く 4 つ、ラベルは今のまま', async () => {
    const h = await (await get(`/records/new?work=${ids.takeaway}`)).text()
    expect(statusValues(h)).toEqual(['purchased', 'in_progress', 'cleared', 'dropped'])
    expect(h).toContain('>買った</label>')
    expect(h).toContain('>クリア</label>')
    expect(h).toContain(
      '買った → 買った日、進行中 → 始めた日、クリア・断念 → 終わった日として保存します。',
    )
  })

  it('failed の作成・ステータス変更・編集 → 400', async () => {
    const res = await post('/records', { work_id: ids.takeaway, status: 'failed', on: '' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('持ち帰りでは選べないステータスです')
    const id = await newAttempt(ids.takeaway, 'in_progress')
    const s = await post(`/records/${id}/status`, { status: 'failed', on: '' })
    expect(s.status).toBe(400)
    expect(await s.text()).toContain('持ち帰りでは選べないステータスです')
    const e = await post(`/records/${id}/edit`, { status: 'failed' })
    expect(e.status).toBe(400)
    expect((await rowOf(id))?.status).toBe('in_progress')
  })

  it('既存の failed は選択肢に残り、そのままの保存は通る', async () => {
    const id = await newAttempt(ids.takeaway, 'failed')
    const h = await (await get(`/records/${id}`)).text()
    expect(statusValues(h)).toEqual(['purchased', 'in_progress', 'cleared', 'failed', 'dropped'])
    expect(h).toMatch(/value="failed" checked=""\/><label for="status-failed">失敗/)
    expect((await post(`/records/${id}/status`, { status: 'failed', on: '' })).status).toBe(302)
  })
})

describe('周遊型は今のまま', () => {
  it('5 択で「買った」、in_progress を作れて、進行ログが出る', async () => {
    const h = await (await get(`/records/new?work=${ids.stroll}`)).text()
    expect(statusValues(h)).toEqual(['purchased', 'in_progress', 'cleared', 'failed', 'dropped'])
    expect(h).toContain('>買った</label>')
    expect(h).toContain(
      '買った → 買った日、進行中 → 始めた日、クリア・失敗・断念 → 終わった日として保存します。',
    )
    expect(h).not.toContain('>予約済み</label>')
    const res = await post('/records', { work_id: ids.stroll, status: 'in_progress', on: '' })
    expect(res.status).toBe(302)
    const id = (res.headers.get('Location') ?? '').match(/\/records\/([^?]+)/)?.[1] ?? ''
    const detail = await (await get(`/records/${id}`)).text()
    expect(detail).toContain('<h2>進行ログ</h2>')
    expect(
      (await post(`/records/${id}/sessions`, { played_on: '2026-11-03', outcome: 'keep' })).status,
    ).toBe(302)
  })

  it('周遊型の purchased の日付ラベルは「買った日」', async () => {
    const id = await newAttempt(ids.stroll, 'purchased', { purchasedOn: '2026-10-01' })
    const h = await (await get(`/records/${id}`)).text()
    expect(h).toContain('<dt>買った日</dt><dd>2026-10-01</dd>')
    expect(h).not.toContain('参加予定日')
  })
})
