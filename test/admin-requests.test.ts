import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { requestStatuses } from '../src/db/schema'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { canTransition, type RequestActor } from '../src/requests/transitions'
import { loginAs, ORIGIN } from './helpers/auth'

let owner = { cookie: '', userId: '' }
let member = { cookie: '', userId: '' }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'admin-requests-owner', owner: true })
  member = await loginAs(env, { subject: 'admin-requests-member' })
})

const get = (path: string, cookie: string | null = owner.cookie) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (path: string, body: Record<string, string>, cookie: string | null = owner.cookie) => {
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

let seq = 0
// created_at は呼んだ順に 1 秒ずつ進める（並び順のテスト用）
const insertRequest = async (
  r: { userId?: string | null; status?: string; title?: string; createdAt?: string } = {},
) => {
  const id = ulid()
  const at = r.createdAt ?? new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString()
  await env.DB.prepare(
    "INSERT INTO request (id, requester_user_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, 'new_work', ?, ?, ?, ?)",
  )
    .bind(
      id,
      r.userId === undefined ? member.userId : r.userId,
      JSON.stringify({ title: r.title ?? `依頼 ${id}` }),
      r.status ?? 'open',
      at,
      at,
    )
    .run()
  return id
}

type Row = { status: string; triage_note: string | null; question: string | null }
const rowOf = (id: string) =>
  env.DB.prepare('SELECT status, triage_note, question FROM request WHERE id = ?')
    .bind(id)
    .first<Row>()

const setStatus = (id: string, body: Record<string, string>) =>
  post(`/admin/requests/${id}/status`, body)

describe('canTransition（§1.5 の表を全組み合わせ）', () => {
  const allowed = new Set([
    'requester:needs_info>open',
    'owner:open>triaged',
    'owner:open>rejected',
    'owner:triaged>rejected',
    'owner:needs_info>rejected',
    'owner:processing>triaged',
    ...['open', 'triaged', 'processing', 'proposed', 'needs_info'].flatMap((f) => [
      `owner:${f}>needs_info`,
      `owner:${f}>done`,
    ]),
    'agent:open>processing',
    'agent:triaged>processing',
    'agent:processing>proposed',
    'agent:processing>needs_info',
    'agent:processing>triaged',
    'worker:proposed>done',
  ])
  const actors: RequestActor[] = ['requester', 'owner', 'agent', 'worker']
  for (const by of actors) {
    it(by, () => {
      for (const from of requestStatuses) {
        for (const to of requestStatuses) {
          expect([from, to, canTransition(from, to, by)]).toEqual([
            from,
            to,
            allowed.has(`${by}:${from}>${to}`),
          ])
        }
      }
    })
  }
})

describe('認可', () => {
  it('member は /admin/requests・詳細・status に 404', async () => {
    const id = await insertRequest()
    expect((await get('/admin/requests', member.cookie)).status).toBe(404)
    expect((await get(`/admin/requests/${id}`, member.cookie)).status).toBe(404)
    expect((await post(`/admin/requests/${id}/status`, { to: 'done' }, member.cookie)).status).toBe(
      404,
    )
    expect((await rowOf(id))?.status).toBe('open')
  })

  it('未ログインは GET 302 /login、POST 401', async () => {
    const res = await get('/admin/requests', null)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect((await post('/admin/requests/x/status', { to: 'done' }, null)).status).toBe(401)
  })

  it('無い id は 404', async () => {
    expect((await get('/admin/requests/nope')).status).toBe(404)
    expect((await setStatus('nope', { to: 'done' })).status).toBe(404)
  })
})

describe('一覧', () => {
  it('依頼者の表示名が出て、退会済みは「退会したユーザー」', async () => {
    const named = await insertRequest({ title: '名前付きの依頼' })
    const anon = await insertRequest({ userId: null, title: '退会者の依頼' })
    const h = await (await get('/admin/requests')).text()
    expect(h).toContain(`href="/admin/requests/${named}"`)
    expect(h).toContain(`href="/admin/requests/${anon}"`)
    expect(h).toContain('作品を追加 · 退会したユーザー')
    const name = await env.DB.prepare('SELECT display_name FROM user WHERE id = ?')
      .bind(member.userId)
      .first<{ display_name: string }>()
    expect(h).toContain(`作品を追加 · ${name?.display_name}`)
  })

  it('status でタブを切り替え、closed は done と rejected。未選別の件数をタブに出す', async () => {
    const done = await insertRequest({ status: 'done', title: '完了した依頼' })
    const rejected = await insertRequest({ status: 'rejected', title: '見送った依頼' })
    const triaged = await insertRequest({ status: 'triaged', title: '選別済みの依頼' })
    const closed = await (await get('/admin/requests?status=closed')).text()
    expect(closed).toContain(done)
    expect(closed).toContain(rejected)
    expect(closed).not.toContain(triaged)
    // 新しい順
    expect(closed.indexOf(rejected)).toBeLessThan(closed.indexOf(done))
    const t = await (await get('/admin/requests?status=triaged')).text()
    expect(t).toContain(triaged)
    expect(t).not.toContain(done)
    const { n } = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM request WHERE status = 'open'",
    ).first<{ n: number }>()) ?? { n: 0 }
    expect(t).toContain(`未選別 ${n}`)
  })

  it('open は古い順。不正な status は open', async () => {
    const a = await insertRequest()
    const b = await insertRequest()
    const h = await (await get('/admin/requests?status=xxx')).text()
    expect(h.indexOf(a)).toBeLessThan(h.indexOf(b))
  })

  it('/settings の管理節に「リクエスト」と未選別の件数', async () => {
    const h = await (await get('/settings')).text()
    expect(h).toContain('href="/admin/requests"')
    expect(h).toMatch(/未選別 \d+/)
    const m = await (await get('/settings', member.cookie)).text()
    expect(m).not.toContain('href="/admin/requests"')
  })
})

describe('Cache-Control', () => {
  it('/admin/requests 以下は一覧・詳細・400 とも private, no-store', async () => {
    const id = await insertRequest()
    const responses = [
      await get('/admin/requests'),
      await get('/admin/requests?status=closed'),
      await get(`/admin/requests/${id}`),
      await setStatus(id, { to: 'rejected', note: '' }),
    ]
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    }
  })
})

describe('選別', () => {
  it('open → triaged（メモ任意）、メモを保存', async () => {
    const id = await insertRequest()
    const res = await setStatus(id, { to: 'triaged', note: '後で調べる' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/requests/${id}?saved=1`)
    expect(await rowOf(id)).toMatchObject({ status: 'triaged', triage_note: '後で調べる' })
    const id2 = await insertRequest()
    expect((await setStatus(id2, { to: 'triaged' })).status).toBe(302)
    expect(await rowOf(id2)).toMatchObject({ status: 'triaged', triage_note: null })
  })

  it('rejected はメモ必須', async () => {
    const id = await insertRequest()
    const res = await setStatus(id, { to: 'rejected', note: '' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('見送る理由をメモに書いてください（依頼者には見えません）。')
    expect((await rowOf(id))?.status).toBe('open')
    expect((await setStatus(id, { to: 'rejected', note: '重複' })).status).toBe(302)
    expect(await rowOf(id)).toMatchObject({ status: 'rejected', triage_note: '重複' })
  })

  it('needs_info は質問必須。依頼者の詳細に質問が出て、選別メモは出ない', async () => {
    const id = await insertRequest()
    await setStatus(id, { to: 'triaged', note: '依頼者に見せないメモ' })
    const empty = await setStatus(id, { to: 'needs_info', question: '' })
    expect(empty.status).toBe(400)
    expect(await empty.text()).toContain('質問を入力してください。')
    const long = await setStatus(id, { to: 'needs_info', question: 'あ'.repeat(1001) })
    expect(long.status).toBe(400)
    expect((await rowOf(id))?.status).toBe('triaged')
    expect(
      (await setStatus(id, { to: 'needs_info', question: '公演の URL はありますか' })).status,
    ).toBe(302)
    expect(await rowOf(id)).toMatchObject({
      status: 'needs_info',
      question: '公演の URL はありますか',
    })
    const h = await (await get(`/requests/${id}`, member.cookie)).text()
    expect(h).toContain('公演の URL はありますか')
    expect(h).not.toContain('依頼者に見せないメモ')
    // オーナーの詳細には出る
    const o = await (await get(`/admin/requests/${id}`)).text()
    expect(o).toContain('依頼者に見せないメモ')
    expect(o).toContain('公演の URL はありますか')
  })

  it('needs_info のまま質問をし直すと前の返信を消す。open からの質問では返信を残す', async () => {
    const id = await insertRequest({ status: 'needs_info' })
    await env.DB.prepare("UPDATE request SET question = '一つ目', reply = '前の返信' WHERE id = ?")
      .bind(id)
      .run()
    expect((await setStatus(id, { to: 'needs_info', question: '二つ目' })).status).toBe(302)
    const row = await env.DB.prepare('SELECT status, question, reply FROM request WHERE id = ?')
      .bind(id)
      .first()
    expect(row).toEqual({ status: 'needs_info', question: '二つ目', reply: null })
    expect(await (await get(`/requests/${id}`, member.cookie)).text()).not.toContain('前の返信')
    const o = await insertRequest()
    await env.DB.prepare("UPDATE request SET reply = '残る返信' WHERE id = ?").bind(o).run()
    expect((await setStatus(o, { to: 'needs_info', question: '追加の質問' })).status).toBe(302)
    expect(
      (await env.DB.prepare('SELECT reply FROM request WHERE id = ?').bind(o).first())?.reply,
    ).toBe('残る返信')
  })

  it('done にできる。done からは何も変えられない', async () => {
    const id = await insertRequest({ status: 'proposed' })
    expect((await setStatus(id, { to: 'done' })).status).toBe(302)
    for (const to of ['needs_info', 'done', 'triaged', 'rejected', 'open']) {
      const res = await setStatus(id, { to, note: 'x', question: 'x' })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('この状態からは変えられません。')
    }
    expect((await rowOf(id))?.status).toBe('done')
  })

  it('triaged・needs_info からも見送れる。processing・proposed からは 400', async () => {
    for (const status of ['triaged', 'needs_info']) {
      const id = await insertRequest({ status })
      expect((await setStatus(id, { to: 'rejected', note: '見送り' })).status).toBe(302)
      expect(await rowOf(id)).toMatchObject({ status: 'rejected', triage_note: '見送り' })
    }
    for (const status of ['processing', 'proposed']) {
      const id = await insertRequest({ status })
      expect((await setStatus(id, { to: 'rejected', note: '見送り' })).status).toBe(400)
      expect((await rowOf(id))?.status).toBe(status)
    }
  })

  it('表に無い遷移は 400（triaged → triaged、open → open、不正値）', async () => {
    const t = await insertRequest({ status: 'triaged' })
    expect((await setStatus(t, { to: 'triaged' })).status).toBe(400)
    const o = await insertRequest()
    expect((await setStatus(o, { to: 'open' })).status).toBe(400)
    expect((await setStatus(o, { to: 'processing' })).status).toBe(400)
    expect((await setStatus(o, { to: '' })).status).toBe(400)
    expect((await rowOf(t))?.status).toBe('triaged')
    expect((await rowOf(o))?.status).toBe('open')
  })

  it('processing は「選別済みに戻す」だけ出し、triaged に戻せる', async () => {
    const id = await insertRequest({ status: 'processing' })
    const h = await (await get(`/admin/requests/${id}`)).text()
    expect(h).toContain('選別済みに戻す')
    expect(h).not.toContain('選別済みにする')
    expect(h).not.toContain('value="rejected"')
    expect((await setStatus(id, { to: 'triaged' })).status).toBe(302)
    expect((await rowOf(id))?.status).toBe('triaged')
  })

  it('open の詳細は 選別・質問・完了・見送り のフォームと、空の提案一覧', async () => {
    const id = await insertRequest()
    const h = await (await get(`/admin/requests/${id}?saved=1`)).text()
    expect(h).toContain('保存しました')
    expect(h).toContain('選別済みにする')
    expect(h).not.toContain('選別済みに戻す')
    for (const to of ['triaged', 'needs_info', 'done', 'rejected']) {
      expect(h).toContain(`name="to" value="${to}"`)
    }
    expect(h).toContain('提案はまだありません。')
  })
})
