import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { todayJst } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'
import { insertAttempt } from './helpers/records'

let alice = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'records-create-alice' })
  const org = await insertOrg(env, { name: '記録作成テスト団' })
  ids.org = org
  ids.work = await insertWork(env, { title: 'WORDEAL 記録作成', kind: 'room', orgId: org })
  ids.work2 = await insertWork(env, { title: '二作目の記録作成', kind: 'stroll' })
  ids.target = await insertWork(env, { title: '統合先の記録作成' })
  ids.merged = await insertWork(env, { title: '統合元の記録作成', mergedIntoId: ids.target })
  ids.existing = await insertWork(env, { title: '既存記録ありの作品' })
  ids.existingAttempt = await insertAttempt(env, {
    userId: alice.userId,
    workId: ids.existing,
    status: 'cleared',
    finishedOn: '2026-09-01',
  })
})

const get = (path: string, cookie = alice.cookie) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

const post = (body: Record<string, string>, cookie: string | null = alice.cookie) => {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (cookie) headers.Cookie = cookie
  return app.request(
    '/records',
    { method: 'POST', headers, body: new URLSearchParams(body).toString() },
    env,
  )
}

type Row = {
  status: string
  attempt_no: number
  purchased_on: string | null
  started_on: string | null
  finished_on: string | null
  user_id: string
  run_id: string | null
}

const rowOf = (id: string) =>
  env.DB.prepare(
    'SELECT status, attempt_no, purchased_on, started_on, finished_on, user_id, run_id FROM attempt WHERE id = ?',
  )
    .bind(id)
    .first<Row>()

// 302 の Location から作った記録の id を取り出す
const createdId = (res: Response): string => {
  const loc = res.headers.get('location') ?? ''
  const m = /^\/records\/([0-9A-Z]+)\?created=1$/.exec(loc)
  if (!m) throw new Error(`unexpected location: ${loc}`)
  return m[1]
}

describe('未ログイン', () => {
  it('GET /records/new?work=x は 302 /login', async () => {
    const res = await app.request('/records/new?work=x', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('POST /records は 401', async () => {
    const res = await post({ work_id: ids.work, status: 'cleared' }, null)
    expect(res.status).toBe(401)
  })
})

describe('POST /records', () => {
  it('cleared + on → 302 /records/<id>?created=1、finished_on と attempt_no=1', async () => {
    const res = await post({ work_id: ids.work, status: 'cleared', on: '2026-11-01' })
    expect(res.status).toBe(302)
    const row = await rowOf(createdId(res))
    expect(row).toMatchObject({
      status: 'cleared',
      attempt_no: 1,
      finished_on: '2026-11-01',
      purchased_on: null,
      started_on: null,
      user_id: alice.userId,
      run_id: null,
    })
  })

  it('同じ作品にもう 1 回 → attempt_no=2', async () => {
    const res = await post({ work_id: ids.work, status: 'failed', on: '2026-11-02' })
    expect(res.status).toBe(302)
    expect((await rowOf(createdId(res)))?.attempt_no).toBe(2)
  })

  it('purchased → purchased_on、in_progress → started_on', async () => {
    const p = await post({ work_id: ids.work2, status: 'purchased', on: '2026-10-01' })
    expect(await rowOf(createdId(p))).toMatchObject({
      purchased_on: '2026-10-01',
      started_on: null,
      finished_on: null,
    })
    const s = await post({ work_id: ids.work2, status: 'in_progress', on: '2026-10-02' })
    expect(await rowOf(createdId(s))).toMatchObject({
      purchased_on: null,
      started_on: '2026-10-02',
      finished_on: null,
    })
  })

  it('on 空 → 日付 NULL で通る', async () => {
    const res = await post({ work_id: ids.work2, status: 'dropped', on: '' })
    expect(res.status).toBe(302)
    expect(await rowOf(createdId(res))).toMatchObject({
      status: 'dropped',
      purchased_on: null,
      started_on: null,
      finished_on: null,
    })
  })

  it('status 無し → 400、フォームを再描画（作品カードと送信値）', async () => {
    const res = await post({ work_id: ids.work, on: '2026-11-05' })
    expect(res.status).toBe(400)
    const h = await res.text()
    expect(h).toContain('ステータスを選んでください。')
    expect(h).toContain('WORDEAL 記録作成')
    expect(h).toContain('value="2026-11-05"')
    expect(h).toContain(`name="work_id" value="${ids.work}"`)
  })

  it('不正な status → 400', async () => {
    const res = await post({ work_id: ids.work, status: 'zzz' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('ステータスの値が正しくありません。')
  })

  it('on=2026-13-01 → 400、選んだ status は残す', async () => {
    const res = await post({ work_id: ids.work, status: 'cleared', on: '2026-13-01' })
    expect(res.status).toBe(400)
    const h = await res.text()
    expect(h).toContain('日付は YYYY-MM-DD の形の実在する日付にしてください。')
    expect(h).toMatch(/<input type="radio" id="new-status-cleared"[^>]*checked/)
  })

  it('統合済み work → 400、行は作らない', async () => {
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempt WHERE work_id IN (?, ?)')
      .bind(ids.merged, ids.target)
      .first<{ n: number }>()
    const res = await post({ work_id: ids.merged, status: 'cleared' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('作品が見つからないか、統合済みです。')
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM attempt WHERE work_id IN (?, ?)')
      .bind(ids.merged, ids.target)
      .first<{ n: number }>()
    expect(after?.n).toBe(before?.n)
  })

  it('無い work / work_id 無し → 400', async () => {
    expect((await post({ work_id: 'nope', status: 'cleared' })).status).toBe(400)
    expect((await post({ status: 'cleared' })).status).toBe(400)
  })
})

describe('GET /records/new', () => {
  it('q 無しは登録の新しい順の作品を、/records/new?work= のリンクで出す', async () => {
    const res = await get('/records/new')
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('action="/records/new"')
    expect(h).toContain(`href="/records/new?work=${ids.work}"`)
    expect(h).not.toContain(`href="/works/${ids.work}"`)
  })

  it('?q=WORDEAL で該当作品へのリンク', async () => {
    const h = await (await get(`/records/new?q=${encodeURIComponent('WORDEAL')}`)).text()
    expect(h).toContain(`href="/records/new?q=WORDEAL&amp;work=${ids.work}"`)
    expect(h).not.toContain(`work=${ids.work2}"`)
  })

  it('?q=…&work=<id> のフォームは戻り先に q を引き継ぐ', async () => {
    const q = encodeURIComponent('記録 作成')
    const h = await (await get(`/records/new?q=${q}&work=${ids.work}`)).text()
    expect(h).toContain(`<a class="back" href="/records/new?q=${q}"`)
    const plain = await (await get(`/records/new?work=${ids.work}`)).text()
    expect(plain).toContain('<a class="back" href="/records/new"')
    expect(plain).not.toContain('name="q"')
  })

  it('フォームは hidden の q を送り、400 の再描画でも戻り先に q を残す', async () => {
    const q = '記録 作成'
    const h = await (await get(`/records/new?q=${encodeURIComponent(q)}&work=${ids.work}`)).text()
    expect(h).toContain(`<input type="hidden" name="q" value="${q}"/>`)
    const res = await post({ work_id: ids.work, q })
    expect(res.status).toBe(400)
    const r = await res.text()
    expect(r).toContain(`<a class="back" href="/records/new?q=${encodeURIComponent(q)}"`)
    expect(r).toContain(`<input type="hidden" name="q" value="${q}"/>`)
  })

  it('0 件は一致なしの文言', async () => {
    const h = await (
      await get(`/records/new?q=${encodeURIComponent('存在しない作品名zzz')}`)
    ).text()
    expect(h).toContain(
      '「存在しない作品名zzz」に一致する作品はありません。作品の追加リクエストは P4 で入ります。',
    )
  })

  it('?work=<id> は軽い記録のフォーム（status 未選択、日付は今日）', async () => {
    const res = await get(`/records/new?work=${ids.work2}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('action="/records"')
    expect(h).toContain(`name="work_id" value="${ids.work2}"`)
    expect(h).toContain(`value="${todayJst()}"`)
    expect(h).not.toMatch(/name="status" value="[a-z_]+" checked/)
    expect(h).toContain(`href="/works/${ids.work2}"`)
  })

  it('?work=<統合済み A> → 302 ?work=B', async () => {
    const res = await get(`/records/new?work=${ids.merged}&q=x`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/records/new?work=${ids.target}`)
  })

  it('?work=<無い id> → 404', async () => {
    const res = await get('/records/new?work=nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('<a class="back" href="/records/new"')
  })

  it('既存の記録があれば件数と最新へのリンク', async () => {
    const h = await (await get(`/records/new?work=${ids.existing}`)).text()
    expect(h).toContain('この作品の記録が 1 件あります')
    expect(h).toContain(`href="/records/${ids.existingAttempt}"`)
    expect(h).toContain('新しい挑戦として追加します。')
  })
})
