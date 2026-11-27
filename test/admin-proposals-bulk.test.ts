// まとめて承認（/admin/proposals/bulk）。create で候補 0 件の承認待ちだけを、1 件ずつ既存の承認処理に全項目採用で通す
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'

let token = ''
let owner = { cookie: '', userId: '' }
let member = { cookie: '', userId: '' }

beforeAll(async () => {
  token = (await createToken(createDb(env.DB), 'admin-proposals-bulk', 90)).token
  owner = await loginAs(env, { subject: 'admin-bulk-owner', owner: true })
  member = await loginAs(env, { subject: 'admin-bulk-member' })
})

const f = (field: string, newValue: string | null, confidence = 0.95) => ({
  field,
  new_value: newValue,
  source_id: null,
  confidence,
})

const propose = async (body: Record<string, unknown>): Promise<string> => {
  const res = await app.request(
    '/api/agent/proposals',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
  const json = (await res.json()) as Record<string, unknown>
  if (res.status !== 201) throw new Error(`propose failed: ${JSON.stringify(json)}`)
  return json.id as string
}

let seq = 0
const uniq = () => `${Date.now()}-${seq++}`

// extra に同じ項目があればそちらを使う
const createWorkBody = (title: string, extra: ReturnType<typeof f>[] = [], more = {}) => ({
  kind: 'create',
  target_table: 'work',
  fields: [
    ...[
      f('work.title', title),
      f('work.kind', 'room', 0.6),
      f('run.channel', 'performance'),
      f('run.escape_id_url', `https://escape.id/bulk-org/e-${uniq()}/`),
    ].filter((b) => !extra.some((e) => e.field === b.field)),
    ...extra,
  ],
  ...more,
})

const createOrgBody = (name: string) => ({
  kind: 'create',
  target_table: 'organization',
  fields: [f('organization.name', name)],
})

const get = (path: string, cookie: string | null = owner.cookie) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const bulkQuery = (ids: string[]) =>
  `/admin/proposals/bulk?${new URLSearchParams(ids.map((id) => ['id', id])).toString()}`

const postBulk = (
  ids: string[],
  {
    cookie = owner.cookie,
    origin = ORIGIN,
    e = env,
  }: { cookie?: string | null; origin?: string | null; e?: Cloudflare.Env } = {},
) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (origin) headers.Origin = origin
  if (cookie) headers.Cookie = cookie
  return app.request(
    '/admin/proposals/bulk',
    {
      method: 'POST',
      headers,
      body: new URLSearchParams(ids.map((id) => ['id', id])).toString(),
    },
    e,
  )
}

const statusOf = async (id: string) =>
  env.DB.prepare('SELECT status FROM proposal WHERE id = ?').bind(id).first<string>('status')

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>('n')) ?? 0

const worksTitled = (title: string) =>
  count('SELECT COUNT(*) AS n FROM work WHERE title = ?', title)

const checkboxOf = (id: string) => `name="id" value="${id}"`

describe('選べる条件', () => {
  it('一覧: 候補 0 件の create だけに Checkbox。候補つき・update は出ない', async () => {
    const plain = await propose(createWorkBody(`まとめ一覧 ${uniq()}`))
    const org = await propose(createOrgBody(`まとめ団体 ${uniq()}`))
    const existing = await insertWork(env, { title: `既存 ${uniq()}` })
    const withCand = await propose(
      createWorkBody(`候補つき ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: existing, score: 0.7, reason: 'r' }],
      }),
    )
    const update = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: existing,
      fields: [f('work.description', 'x')],
    })
    const html = await (await get('/admin/proposals')).text()
    expect(html).toContain('action="/admin/proposals/bulk"')
    expect(html).toContain(checkboxOf(plain))
    expect(html).toContain(checkboxOf(org))
    expect(html).not.toContain(checkboxOf(withCand))
    expect(html).not.toContain(checkboxOf(update))
    // 選べない行も一覧には出る
    expect(html).toContain(`/admin/proposals/${withCand}`)
    expect(html).toContain(`/admin/proposals/${update}`)
  })

  it('確認ページ: 題名と団体を出し、候補つき・update は反映する側に入れない', async () => {
    const orgName = `確認の団体 ${uniq()}`
    const orgId = await insertOrg(env, { name: orgName })
    const title = `確認 ${uniq()}`
    const plain = await propose(createWorkBody(title, [f('work.primary_organization_id', orgId)]))
    const bundleOrg = `束の団体 ${uniq()}`
    const bundle = await propose(
      createWorkBody(`束 ${uniq()}`, [
        f('work.primary_organization_id', '@organization'),
        f('organization.name', bundleOrg),
      ]),
    )
    const existing = await insertWork(env, { title: `既存 ${uniq()}` })
    const withCand = await propose(
      createWorkBody(`候補つき ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: existing, score: 0.7, reason: 'r' }],
      }),
    )
    const update = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: existing,
      fields: [f('work.description', 'x')],
    })
    const res = await get(bulkQuery([plain, bundle, withCand, update]))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const html = await res.text()
    expect(html).toContain(title)
    expect(html).toContain(orgName)
    expect(html).toContain(bundleOrg)
    expect(html).toContain('反映する提案（2 件）')
    expect(html).toContain('2 件を承認して反映')
    expect(html).toContain(`type="hidden" name="id" value="${plain}"`)
    expect(html).toContain(`type="hidden" name="id" value="${bundle}"`)
    expect(html).not.toContain(`type="hidden" name="id" value="${withCand}"`)
    expect(html).not.toContain(`type="hidden" name="id" value="${update}"`)
    expect(html).toContain('まとめて承認できない提案（2 件）')
    // GET では書かない
    expect(await statusOf(plain)).toBe('pending')
  })

  it('候補つき・update の id を POST に混ぜても反映せず、結果に理由を出す', async () => {
    const title = `混ぜる ${uniq()}`
    const plain = await propose(createWorkBody(title))
    const existing = await insertWork(env, { title: `既存 ${uniq()}` })
    const withCand = await propose(
      createWorkBody(`候補つき ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: existing, score: 0.7, reason: 'r' }],
      }),
    )
    const update = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: existing,
      fields: [f('work.description', '変えない')],
    })
    const res = await postBulk([withCand, plain, update])
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('1 件を反映しました。2 件は反映できませんでした。')
    expect(html).toContain('詳細から 1 件ずつ承認してください。')
    expect(await statusOf(plain)).toBe('applied')
    expect(await statusOf(withCand)).toBe('pending')
    expect(await statusOf(update)).toBe('pending')
    expect(await worksTitled(title)).toBe(1)
    expect(
      await env.DB.prepare('SELECT description FROM work WHERE id = ?')
        .bind(existing)
        .first('description'),
    ).not.toBe('変えない')
  })

  it('0 件・51 件は 400 で何も反映しない', async () => {
    expect((await get('/admin/proposals/bulk')).status).toBe(400)
    expect((await postBulk([])).status).toBe(400)
    const id = await propose(createWorkBody(`上限 ${uniq()}`))
    const ids = [id, ...Array.from({ length: 50 }, (_, n) => `nope-${n}`)]
    const g = await get(bulkQuery(ids))
    expect(g.status).toBe(400)
    expect(await g.text()).toContain('1 回 50 件までです。')
    expect((await postBulk(ids)).status).toBe(400)
    expect(await statusOf(id)).toBe('pending')
  })
})

describe('反映', () => {
  it('全項目採用で反映（形式は提案の値、change_log は proposal_id 付き）、団体 → 作品の順に通る', async () => {
    const orgName = `第 1 段 ${uniq()}`
    const org = await propose(createOrgBody(orgName))
    const title = `全項目 ${uniq()}`
    const w = await propose(createWorkBody(title, [f('work.description', '説明')]))
    const html = await (await postBulk([org, w])).text()
    expect(html).toContain('2 件を反映しました。')
    expect(await statusOf(org)).toBe('applied')
    expect(await statusOf(w)).toBe('applied')
    const row = await env.DB.prepare('SELECT id, kind, description FROM work WHERE title = ?')
      .bind(title)
      .first<{ id: string; kind: string; description: string }>()
    expect(row?.kind).toBe('room')
    expect(row?.description).toBe('説明')
    expect(await count('SELECT COUNT(*) AS n FROM organization WHERE name = ?', orgName)).toBe(1)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'work' AND row_id = ? AND proposal_id = ? AND actor_user_id = ?",
        row?.id,
        w,
        owner.userId,
      ),
    ).toBe(1)
    // 全項目（題名・形式・経路・URL・説明）を採用
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM proposal_field WHERE proposal_id = ? AND accepted = 1',
        w,
      ),
    ).toBe(5)
  })

  it('途中で 1 件が検証で落ちても残りは進み、結果に件ごとに出る', async () => {
    const url = `https://escape.id/bulk-org/e-same-${uniq()}/`
    const a = `同じ URL A ${uniq()}`
    const b = `同じ URL B ${uniq()}`
    const c = `後ろ ${uniq()}`
    const ids = [
      await propose(createWorkBody(a, [f('run.escape_id_url', url)])),
      await propose(createWorkBody(b, [f('run.escape_id_url', url)])),
      await propose(createWorkBody(c)),
    ]
    // createWorkBody の escape_id_url を上書きできているか（同じ URL の提案が 2 件）
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM proposal_field WHERE field = 'run.escape_id_url' AND new_value = ?",
        url,
      ),
    ).toBe(2)
    const res = await postBulk(ids)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('2 件を反映しました。1 件は反映できませんでした。')
    expect(html).toContain('role="alert"')
    expect(await statusOf(ids[0])).toBe('applied')
    expect(await statusOf(ids[1])).toBe('pending')
    expect(await statusOf(ids[2])).toBe('applied')
    expect(await worksTitled(b)).toBe(0)
    expect(await worksTitled(c)).toBe(1)
  })

  it('書き込みが例外で落ちた 1 件は「書き込めませんでした」、残りは進む', async () => {
    const a = `例外 ${uniq()}`
    const b = `例外の後 ${uniq()}`
    const ids = [await propose(createWorkBody(a)), await propose(createWorkBody(b))]
    let calls = 0
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            calls++
            if (calls === 1) throw new Error('D1_ERROR: boom')
            return t.batch(stmts)
          }
        }
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const html = await (await postBulk(ids, { e: { ...env, DB: db } })).text()
    expect(html).toContain('1 件を反映しました。1 件は反映できませんでした。')
    expect(html).toContain('書き込めませんでした。')
    expect(await statusOf(ids[0])).toBe('pending')
    expect(await worksTitled(a)).toBe(0)
    expect(await statusOf(ids[1])).toBe('applied')
    expect(await worksTitled(b)).toBe(1)
  })
})

describe('二重送信・権限・CSRF', () => {
  it('同じ id を 2 回送っても 1 つしか作らない（2 回目は「もう処理されています」）', async () => {
    const title = `二回 ${uniq()}`
    const id = await propose(createWorkBody(title))
    expect(await (await postBulk([id, id])).text()).toContain('1 件を反映しました。')
    const again = await (await postBulk([id])).text()
    expect(again).toContain('0 件を反映しました。1 件は反映できませんでした。')
    expect(again).toContain('この提案はもう処理されています。')
    expect(await worksTitled(title)).toBe(1)
  })

  it('読んでから書くまでの間に別の送信が通っても、二重に作らない', async () => {
    const title = `競合 ${uniq()}`
    const id = await propose(createWorkBody(title))
    let second: Response | null = null
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (!second) second = await postBulk([id])
            return t.batch(stmts)
          }
        }
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    const first = await (await postBulk([id], { e: { ...env, DB: db } })).text()
    expect(await (second as Response | null)?.text()).toContain('1 件を反映しました。')
    expect(first).toContain('この提案はもう処理されています。')
    expect(await worksTitled(title)).toBe(1)
  })

  it('オーナー以外は弾く（member 404・未ログイン 401・agent トークン 403）', async () => {
    const id = await propose(createWorkBody(`権限 ${uniq()}`))
    expect((await get(bulkQuery([id]), member.cookie)).status).toBe(404)
    expect((await postBulk([id], { cookie: member.cookie })).status).toBe(404)
    expect((await postBulk([id], { cookie: null })).status).toBe(401)
    const bearer = await app.request(
      '/admin/proposals/bulk',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ id }).toString(),
      },
      env,
    )
    expect(bearer.status).toBe(403)
    expect(await statusOf(id)).toBe('pending')
  })

  it('CSRF: Origin が違う・無い POST は 403 で反映しない', async () => {
    const id = await propose(createWorkBody(`CSRF ${uniq()}`))
    expect((await postBulk([id], { origin: 'https://evil.example' })).status).toBe(403)
    expect((await postBulk([id], { origin: null })).status).toBe(403)
    expect(await statusOf(id)).toBe('pending')
  })
})
