import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { nowIso } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertWork } from './helpers/master'

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'requests-alice' })
  bob = await loginAs(env, { subject: 'requests-bob' })
  ids.work = await insertWork(env, { title: 'リクエスト対象の作品' })
  ids.target = await insertWork(env, { title: 'リクエストの統合先' })
  ids.merged = await insertWork(env, { title: 'リクエストの統合元', mergedIntoId: ids.target })
})

const get = (path: string, cookie: string | null = alice.cookie) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

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

const createdId = (res: Response): string => {
  const loc = res.headers.get('location') ?? ''
  const m = /^\/requests\/([0-9A-Z]+)\?created=1$/.exec(loc)
  if (!m) throw new Error(`unexpected location: ${res.status} ${loc}`)
  return m[1]
}

type Row = {
  requester_user_id: string | null
  kind: string
  payload_json: string
  status: string
  question: string | null
  reply: string | null
}

const rowOf = (id: string) =>
  env.DB.prepare(
    'SELECT requester_user_id, kind, payload_json, status, question, reply FROM request WHERE id = ?',
  )
    .bind(id)
    .first<Row>()

const insertRequest = async (
  userId: string | null,
  r: { status?: string; question?: string; payload?: object; createdAt?: string } = {},
) => {
  const id = ulid()
  const now = r.createdAt ?? nowIso()
  await env.DB.prepare(
    "INSERT INTO request (id, requester_user_id, kind, payload_json, status, question, triage_note, agent_note, created_at, updated_at) VALUES (?, ?, 'new_work', ?, ?, ?, '選別メモ（依頼者には見せない）', 'agent メモ（依頼者には見せない）', ?, ?)",
  )
    .bind(
      id,
      userId,
      JSON.stringify(r.payload ?? { title: '直接入れた依頼' }),
      r.status ?? 'open',
      r.question ?? null,
      now,
      now,
    )
    .run()
  return id
}

// 400 の本文に msg が出ること
const expectError = async (body: Record<string, string>, msg: string, cookie = alice.cookie) => {
  const res = await post('/requests', body, cookie)
  expect(res.status).toBe(400)
  expect(await res.text()).toContain(msg)
}

describe('未ログイン', () => {
  it('GET /requests・/requests/new は 302 /login', async () => {
    for (const p of ['/requests', '/requests/new', '/requests/x']) {
      const res = await get(p, null)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
    }
  })

  it('POST /requests・reply は 401', async () => {
    expect((await post('/requests', { kind: 'other', note: 'x' }, null)).status).toBe(401)
    expect((await post('/requests/x/reply', { reply: 'x' }, null)).status).toBe(401)
  })
})

describe('POST /requests', () => {
  it('new_work（escape.id の公演）→ 302 /requests/:id?created=1、一覧に 1 行', async () => {
    const res = await post('/requests', {
      kind: 'new_work',
      url: 'https://escape.id/events/abc123',
      title: '新しい公演',
      organization: 'どこかの団体',
      note: '',
    })
    expect(res.status).toBe(302)
    const id = createdId(res)
    const row = await rowOf(id)
    expect(row).toMatchObject({ requester_user_id: alice.userId, kind: 'new_work', status: 'open' })
    // 空のキーは入れない
    expect(JSON.parse(row?.payload_json ?? '')).toEqual({
      url: 'https://escape.id/events/abc123',
      title: '新しい公演',
      organization: 'どこかの団体',
    })
    const detail = await get(`/requests/${id}?created=1`)
    expect(detail.headers.get('cache-control')).toBe('private, no-store')
    const h = await detail.text()
    expect(h).toContain('送りました')
    expect(h).toContain('受付済み')
    expect(h).toContain('rel="noopener noreferrer"')
    const list = await (await get('/requests')).text()
    expect(list).toContain(`href="/requests/${id}"`)
    expect(list).toContain('新しい公演')
  })

  it('種類ごとの必須', async () => {
    await expectError({ kind: 'new_work' }, 'URL か作品名のどちらかを入れてください。')
    await expectError(
      { kind: 'fix_work', target: ids.work },
      '直してほしい内容をメモに書いてください。',
    )
    await expectError({ kind: 'new_room_venue' }, '店舗の公式サイトの URL を入れてください。')
    for (const kind of ['new_organization', 'new_shop', 'new_genre']) {
      await expectError({ kind }, '名前を入れてください。')
    }
    await expectError({ kind: 'other' }, '内容をメモに書いてください。')
  })

  it('選べない種類（new_booth / import_trailcast / 不正値）は 400', async () => {
    for (const kind of ['new_booth', 'import_trailcast', 'xxx', '']) {
      await expectError({ kind, note: 'x', title: 'x' }, '種類の値が正しくありません。')
    }
  })

  it('fix_work の対象が無い・統合済み・指定なしは 400', async () => {
    for (const target of ['nope', ids.merged, '']) {
      await expectError(
        { kind: 'fix_work', target, note: '直して' },
        '直す作品が見つかりません。作品のページからやり直してください。',
      )
    }
  })

  it('fix_work は target_id を payload に入れる', async () => {
    const res = await post('/requests', { kind: 'fix_work', target: ids.work, note: '日付が違う' })
    const id = createdId(res)
    expect(JSON.parse((await rowOf(id))?.payload_json ?? '')).toEqual({
      note: '日付が違う',
      target_id: ids.work,
    })
    const h = await (await get(`/requests/${id}`)).text()
    expect(h).toContain('リクエスト対象の作品')
    expect(h).toContain(`href="/works/${ids.work}"`)
  })

  it('fix_work 以外では target を無視する', async () => {
    const res = await post('/requests', { kind: 'other', target: ids.work, note: 'その他' })
    expect(JSON.parse((await rowOf(createdId(res)))?.payload_json ?? '')).toEqual({
      note: 'その他',
    })
  })

  it('escape.id のマイページの URL は 400', async () => {
    for (const url of [
      'https://escape.id/me',
      'https://escape.id/me/',
      'https://ESCAPE.ID/me/x',
      'https://www.escape.id/me/',
      'https://m.escape.id/me',
      'https://escape.id./me/',
      'https://escape.id//me/x',
      'https://escape.id/%6De/',
      'https://escape.id/ME/',
      'https://escape.id/%E0%A4%A/',
    ]) {
      await expectError(
        { kind: 'new_work', url },
        'escape.id のマイページの URL は受け付けられません。公演ページの URL を貼ってください。',
      )
    }
    // /mesh のような前方一致・escape.id に似た別ホストは通る
    const res = await post('/requests', { kind: 'new_work', url: 'https://escape.id/mesh' })
    expect(res.status).toBe(302)
    const other = await post('/requests', { kind: 'new_work', url: 'https://notescape.id/me/' })
    expect(other.status).toBe(302)
  })

  it('URL・長さの検証は既存の文言', async () => {
    await expectError(
      { kind: 'new_work', url: 'javascript:alert(1)' },
      'URLは http:// か https:// で始まる URL にしてください。',
    )
    await expectError({ kind: 'new_work', title: 'あ'.repeat(201) }, '作品名は 200 文字以内')
    await expectError({ kind: 'new_shop', title: 'あ'.repeat(201) }, '名前は 200 文字以内')
    await expectError(
      { kind: 'other', note: 'あ'.repeat(2001) },
      'メモは 2000 文字以内にしてください。',
    )
  })

  it('同じ URL の未完了があれば 400。done / rejected なら通る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'requests-dup' })
    const url = 'https://escape.id/events/dup'
    expect((await post('/requests', { kind: 'new_work', url }, cookie)).status).toBe(302)
    await expectError(
      { kind: 'new_work', url },
      '同じ URL のリクエストを受け付けています。',
      cookie,
    )
    // 他人の同じ URL は関係ない
    expect((await post('/requests', { kind: 'new_work', url })).status).toBe(302)
    await env.DB.prepare(
      "UPDATE request SET status = 'done' WHERE requester_user_id = ? AND json_extract(payload_json, '$.url') = ?",
    )
      .bind(userId, url)
      .run()
    expect((await post('/requests', { kind: 'new_work', url }, cookie)).status).toBe(302)
  })

  it('直近 24 時間に 20 件あれば 21 件目は 400。24 時間より前は数えない。オーナーは通る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'requests-limit' })
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString()
    await insertRequest(userId, { createdAt: old })
    for (let i = 0; i < 19; i++) await insertRequest(userId)
    expect((await post('/requests', { kind: 'other', note: '20 件目' }, cookie)).status).toBe(302)
    await expectError(
      { kind: 'other', note: '21 件目' },
      'リクエストは 1 日 20 件までです。時間をおいてからお願いします。',
      cookie,
    )
    const owner = await loginAs(env, { subject: 'requests-owner', owner: true })
    for (let i = 0; i < 20; i++) await insertRequest(owner.userId)
    expect(
      (await post('/requests', { kind: 'other', note: 'オーナー' }, owner.cookie)).status,
    ).toBe(302)
  })
})

describe('GET /requests/new', () => {
  it('クエリを初期値にする', async () => {
    const h = await (
      await get(`/requests/new?kind=new_work&title=${encodeURIComponent('探した題名')}`)
    ).text()
    expect(h).toContain('value="探した題名"')
    expect(h).toContain('<option value="new_work" selected="">')
    expect(h).toContain('X（旧 Twitter）の投稿からは情報を取りません。')
  })

  it('fix_work は対象作品名を出し、target を hidden で持つ', async () => {
    const h = await (await get(`/requests/new?kind=fix_work&target=${ids.work}`)).text()
    expect(h).toContain('直す作品')
    expect(h).toContain('リクエスト対象の作品')
    expect(h).toContain(`name="target" value="${ids.work}"`)
  })

  it('選べない kind は作品の追加', async () => {
    const h = await (await get('/requests/new?kind=import_trailcast')).text()
    expect(h).toContain('<option value="new_work" selected="">')
    expect(h).not.toContain('value="import_trailcast"')
    expect(h).not.toContain('value="new_booth"')
  })
})

describe('GET /requests', () => {
  it('0 件は「まだリクエストはありません。」', async () => {
    const { cookie } = await loginAs(env, { subject: 'requests-empty' })
    const res = await get('/requests', cookie)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await res.text()).toContain('まだリクエストはありません。')
  })

  it('他人のリクエストは出ない', async () => {
    const id = await insertRequest(alice.userId, { payload: { title: 'アリスだけの依頼' } })
    const h = await (await get('/requests', bob.cookie)).text()
    expect(h).not.toContain(id)
    expect(h).not.toContain('アリスだけの依頼')
  })
})

describe('Cache-Control', () => {
  it('/requests 以下は一覧・フォーム・詳細・400 とも private, no-store', async () => {
    const id = await insertRequest(alice.userId)
    const responses = [
      await get('/requests'),
      await get('/requests/new'),
      await get(`/requests/${id}`),
      await get('/requests/nope'),
      await post('/requests', { kind: 'new_work' }),
    ]
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('private, no-store')
    }
  })
})

describe('他人・無い id', () => {
  it('bob は alice の詳細と reply に 404', async () => {
    const id = await insertRequest(alice.userId, { status: 'needs_info', question: '質問' })
    expect((await get(`/requests/${id}`, bob.cookie)).status).toBe(404)
    expect((await post(`/requests/${id}/reply`, { reply: '横取り' }, bob.cookie)).status).toBe(404)
    expect((await rowOf(id))?.status).toBe('needs_info')
    expect((await get('/requests/nope')).status).toBe(404)
    expect((await post('/requests/nope/reply', { reply: 'x' })).status).toBe(404)
  })
})

describe('質問と返信', () => {
  it('needs_info は質問と返信フォームを出し、triage_note / agent_note は出さない', async () => {
    const id = await insertRequest(alice.userId, {
      status: 'needs_info',
      question: '公演の日付を教えてください',
    })
    const h = await (await get(`/requests/${id}`)).text()
    expect(h).toContain('質問があります')
    expect(h).toContain('公演の日付を教えてください')
    expect(h).toContain(`action="/requests/${id}/reply"`)
    expect(h).not.toContain('選別メモ')
    expect(h).not.toContain('agent メモ')
  })

  it('reply で open に戻り、reply が保存されて表示される', async () => {
    const id = await insertRequest(alice.userId, { status: 'needs_info', question: '日付は？' })
    const res = await post(`/requests/${id}/reply`, { reply: '11/20 です' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/requests/${id}`)
    expect(await rowOf(id)).toMatchObject({ status: 'open', reply: '11/20 です' })
    const h = await (await get(`/requests/${id}`)).text()
    expect(h).toContain('11/20 です')
    expect(h).toContain('日付は？')
    expect(h).not.toContain(`action="/requests/${id}/reply"`)
  })

  it('空の返信は 400', async () => {
    const id = await insertRequest(alice.userId, { status: 'needs_info', question: '？' })
    const res = await post(`/requests/${id}/reply`, { reply: '  ' })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('返信を入力してください。')
    expect((await rowOf(id))?.status).toBe('needs_info')
  })

  it('needs_info 以外への reply は 400', async () => {
    for (const status of ['open', 'triaged', 'processing', 'proposed', 'done', 'rejected']) {
      const id = await insertRequest(alice.userId, { status })
      const res = await post(`/requests/${id}/reply`, { reply: '返信' })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('この状態からは変えられません。')
      expect(await rowOf(id)).toMatchObject({ status, reply: null })
    }
  })
})

describe('入口', () => {
  it('/settings に「作品の追加・修正をお願いする」', async () => {
    const h = await (await get('/settings')).text()
    expect(h).toContain('href="/requests"')
    expect(h).toContain('作品の追加・修正をお願いする')
  })

  it('/works?q= の 0 件に追加のリクエスト', async () => {
    const q = '一致しない題名qqq'
    const h = await (await get(`/works?q=${encodeURIComponent(q)}`)).text()
    expect(h).toContain(`href="/requests/new?kind=new_work&amp;title=${encodeURIComponent(q)}"`)
  })

  it('/works/:id に修正のリクエスト（未ログインは /login）', async () => {
    const h = await (await get(`/works/${ids.work}`)).text()
    expect(h).toContain(`href="/requests/new?kind=fix_work&amp;target=${ids.work}"`)
    const anon = await (await get(`/works/${ids.work}`, null)).text()
    expect(anon).toContain('情報の修正をリクエスト')
    expect(anon).not.toContain('kind=fix_work')
  })
})

describe('退会', () => {
  it('requester が NULL になって行は残り、同じアカウントで入り直しても一覧に出ない', async () => {
    const carol = await loginAs(env, { subject: 'requests-carol' })
    const id = createdId(
      await post('/requests', { kind: 'other', note: 'キャロルの依頼' }, carol.cookie),
    )
    const res = await post('/settings/delete', { confirm: 'yes' }, carol.cookie)
    expect(res.status).toBe(302)
    expect((await rowOf(id))?.requester_user_id).toBeNull()
    const again = await loginAs(env, { subject: 'requests-carol' })
    expect(again.userId).not.toBe(carol.userId)
    const h = await (await get('/requests', again.cookie)).text()
    expect(h).not.toContain(id)
    expect((await get(`/requests/${id}`, again.cookie)).status).toBe(404)
  })
})
