import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { runStmts } from '../src/db/master-write'
import { getAdminProposal } from '../src/db/proposals'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { approvalChoiceOf, buildApproval } from '../src/pipeline/apply'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'

let token = ''
let owner = { cookie: '', userId: '' }
let member = { cookie: '', userId: '' }

beforeAll(async () => {
  token = (await createToken(createDb(env.DB), 'admin-proposals', 90)).token
  owner = await loginAs(env, { subject: 'admin-proposals-owner', owner: true })
  member = await loginAs(env, { subject: 'admin-proposals-member' })
})

// ---- agent 側（提案を作る）

const api = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const f = (field: string, newValue: string | null, confidence = 0.95) => ({
  field,
  new_value: newValue,
  source_id: null,
  confidence,
})

const propose = async (body: Record<string, unknown>): Promise<string> => {
  const r = await api('POST', '/api/agent/proposals', body)
  if (r.status !== 201) throw new Error(`propose failed: ${JSON.stringify(r)}`)
  return r.body.id as string
}

// ---- オーナー側（HTML フォーム）

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

type FieldRow = { id: string; field: string; new_value: string | null; accepted: number | null }
const fieldsOf = async (proposalId: string) =>
  (
    await env.DB.prepare(
      'SELECT id, field, new_value, accepted FROM proposal_field WHERE proposal_id = ? ORDER BY field',
    )
      .bind(proposalId)
      .all<FieldRow>()
  ).results

// 全項目を採用（except の項目は外す）したフォーム。形式の Select は画面の既定（提案の値）を送る
const acceptAll = async (proposalId: string, except: string[] = [], extra = {}) => {
  const body: Record<string, string> = {}
  for (const r of await fieldsOf(proposalId)) {
    if (r.field === 'work.kind') body.kind = r.new_value ?? ''
    if (!except.includes(r.field)) body[`accept_${r.id}`] = '1'
  }
  return { ...body, ...extra }
}

const approve = async (id: string, except: string[] = [], extra: Record<string, string> = {}) =>
  post(`/admin/proposals/${id}/approve`, await acceptAll(id, except, extra))

const proposalOf = (id: string) =>
  env.DB.prepare('SELECT status, applied_json, review_note FROM proposal WHERE id = ?')
    .bind(id)
    .first<{ status: string; applied_json: string | null; review_note: string | null }>()

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>('n')) ?? 0

let seq = 0
const uniq = () => `${Date.now()}-${seq++}`

const insertRequest = async (status: string) => {
  const id = ulid()
  const at = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO request (id, requester_user_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, 'new_work', '{}', ?, ?, ?)",
  )
    .bind(id, member.userId, status, at, at)
    .run()
  return id
}

const createWorkBody = (title: string, extra: ReturnType<typeof f>[] = [], more = {}) => ({
  kind: 'create',
  target_table: 'work',
  fields: [
    f('work.title', title),
    f('work.description', '説明'),
    f('work.kind', 'room', 0.6),
    f('run.channel', 'performance'),
    f('run.escape_id_url', `https://escape.id/foo-org/e-${uniq()}/`),
    ...extra,
  ],
  ...more,
})

describe('承認（create work + run）', () => {
  it('work・run ができ、change_log が actor_user_id と proposal_id 付き、proposal は applied', async () => {
    const title = `承認テスト ${uniq()}`
    const id = await propose(createWorkBody(title))
    const res = await approve(id)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/admin/proposals/${id}?applied=1`)

    const p = await proposalOf(id)
    expect(p?.status).toBe('applied')
    const applied = JSON.parse(p?.applied_json ?? '{}') as Record<string, string>
    const w = await env.DB.prepare('SELECT title, kind, description FROM work WHERE id = ?')
      .bind(applied.work)
      .first()
    expect(w).toEqual({ title, kind: 'room', description: '説明' })
    expect(
      await env.DB.prepare('SELECT work_id FROM run WHERE id = ?')
        .bind(applied.run)
        .first('work_id'),
    ).toBe(applied.work)

    const logs = (
      await env.DB.prepare(
        "SELECT table_name, actor_user_id, actor_token_id FROM change_log WHERE proposal_id = ? AND table_name IN ('work', 'run') ORDER BY table_name",
      )
        .bind(id)
        .all()
    ).results
    expect(logs).toEqual([
      { table_name: 'run', actor_user_id: owner.userId, actor_token_id: null },
      { table_name: 'work', actor_user_id: owner.userId, actor_token_id: null },
    ])
    for (const r of await fieldsOf(id)) expect(r.accepted, r.field).toBe(1)

    // 反映後の詳細に「反映しました」
    const html = await (await get(`/admin/proposals/${id}?applied=1`)).text()
    expect(html).toContain('反映しました')
    expect(html).not.toContain('class="hl')
  })

  it('work.description を外すと説明は NULL で accepted=0。work.title を外すと 400 で何も書かれない', async () => {
    const title = `部分承認 ${uniq()}`
    const id = await propose(createWorkBody(title))
    expect((await approve(id, ['work.description'])).status).toBe(302)
    const applied = JSON.parse((await proposalOf(id))?.applied_json ?? '{}')
    expect(
      await env.DB.prepare('SELECT description FROM work WHERE id = ?')
        .bind(applied.work)
        .first('description'),
    ).toBeNull()
    const acc = Object.fromEntries((await fieldsOf(id)).map((r) => [r.field, r.accepted]))
    expect(acc['work.description']).toBe(0)
    expect(acc['work.title']).toBe(1)

    const title2 = `題名なし ${uniq()}`
    const id2 = await propose(createWorkBody(title2))
    const res = await approve(id2, ['work.title'])
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('題名を入力してください。')
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE title = ?', title2)).toBe(0)
    expect((await proposalOf(id2))?.status).toBe('pending')
  })

  it('kind を選び直すとその値で入る。work.kind の accepted は提案と同じ値のときだけ 1', async () => {
    const id = await propose(createWorkBody(`形式 ${uniq()}`))
    expect((await approve(id, [], { kind: 'hall' })).status).toBe(302)
    const applied = JSON.parse((await proposalOf(id))?.applied_json ?? '{}')
    expect(
      await env.DB.prepare('SELECT kind FROM work WHERE id = ?').bind(applied.work).first('kind'),
    ).toBe('hall')
    const acc = Object.fromEntries((await fieldsOf(id)).map((r) => [r.field, r.accepted]))
    expect(acc['work.kind']).toBe(0)
  })

  it('link_work_id を選ぶと作品は増えず、回が既存の作品に付く', async () => {
    const existing = await insertWork(env, { title: `既存 ${uniq()}` })
    const title = `紐付け ${uniq()}`
    const id = await propose(
      createWorkBody(title, [], {
        match_candidates: [{ table: 'work', id: existing, score: 0.7, reason: 'agent の見立て' }],
      }),
    )
    const html = await (await get(`/admin/proposals/${id}`)).text()
    expect(html).toContain(`value="${existing}"`)
    expect(html).toContain('agent の見立て')

    const before = await count('SELECT COUNT(*) AS n FROM work')
    expect((await approve(id, [], { link_work_id: existing })).status).toBe(302)
    expect(await count('SELECT COUNT(*) AS n FROM work')).toBe(before)
    const applied = JSON.parse((await proposalOf(id))?.applied_json ?? '{}')
    expect(applied.work).toBeUndefined()
    expect(
      await env.DB.prepare('SELECT work_id FROM run WHERE id = ?')
        .bind(applied.run)
        .first('work_id'),
    ).toBe(existing)
    const acc = Object.fromEntries((await fieldsOf(id)).map((r) => [r.field, r.accepted]))
    expect(acc['work.title']).toBe(0)
    expect(acc['run.channel']).toBe(1)
  })

  it('候補に無い作品・存在しない候補は紐付けに使えず、画面にも出ない', async () => {
    const other = await insertWork(env, { title: `候補外 ${uniq()}` })
    const id = await propose(
      createWorkBody(`候補なし ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: 'nope-0000', score: 0.9, reason: '<b>x</b>' }],
      }),
    )
    const html = await (await get(`/admin/proposals/${id}`)).text()
    expect(html).not.toContain('nope-0000')
    expect(html).not.toContain('<b>x</b>')
    const res = await approve(id, [], { link_work_id: other })
    expect(res.status).toBe(400)
    expect((await proposalOf(id))?.status).toBe('pending')
  })

  it('回の節を全部外して紐付けると 400「回の情報が無いので紐付けられません。」', async () => {
    const existing = await insertWork(env, { title: `既存2 ${uniq()}` })
    const id = await propose(
      createWorkBody(`回なし ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: existing, score: 0.7, reason: 'r' }],
      }),
    )
    const res = await approve(id, ['run.channel', 'run.escape_id_url'], { link_work_id: existing })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('回の情報が無いので紐付けられません。')
  })
})

describe('束の参照（@organization / @shop）', () => {
  it('shop.organization_id の @organization と run.shop_id の @shop が作った行の id になる', async () => {
    const workId = await insertWork(env, { title: `販売 ${uniq()}` })
    const orgName = `束の団体 ${uniq()}`
    const id = await propose({
      kind: 'create',
      target_table: 'run',
      fields: [
        f('run.work_id', workId),
        f('run.channel', 'sale'),
        f('run.shop_id', '@shop'),
        f('shop.name', `束の販売先 ${uniq()}`),
        f('shop.kind', 'booth'),
        f('shop.organization_id', '@organization'),
        f('organization.name', orgName),
      ],
    })
    expect((await approve(id)).status).toBe(302)
    const a = JSON.parse((await proposalOf(id))?.applied_json ?? '{}')
    expect(
      await env.DB.prepare('SELECT organization_id FROM shop WHERE id = ?')
        .bind(a.shop)
        .first('organization_id'),
    ).toBe(a.organization)
    expect(
      await env.DB.prepare('SELECT name FROM organization WHERE id = ?')
        .bind(a.organization)
        .first('name'),
    ).toBe(orgName)
    expect(
      await env.DB.prepare('SELECT work_id, shop_id FROM run WHERE id = ?').bind(a.run).first(),
    ).toEqual({ work_id: workId, shop_id: a.shop })
  })

  it('参照先の節を全部外して参照だけ残すと 400', async () => {
    const id = await propose(
      createWorkBody(`会場なし ${uniq()}`, [
        f('run.venue_id', '@venue'),
        f('venue.name', '会場 A'),
      ]),
    )
    const res = await approve(id, ['venue.name'])
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('この提案で作る会場を指しています')
    expect((await proposalOf(id))?.status).toBe('pending')
  })

  it('回から参照されていない会場の節には注記が出る', async () => {
    const id = await propose(createWorkBody(`未使用 ${uniq()}`, [f('venue.name', '使わない会場')]))
    const html = await (await get(`/admin/proposals/${id}`)).text()
    expect(html).toContain('この会場はほかの項目から参照されていません')
  })
})

describe('update / merge', () => {
  it('old_value と今の値が違えば 409 と「それでも反映する」、force=1 で反映', async () => {
    const workId = await insertWork(env, { title: `修正 ${uniq()}`, description: '元' })
    const id = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      fields: [f('work.description', '新しい説明')],
    })
    await env.DB.prepare("UPDATE work SET description = '誰かが直した' WHERE id = ?")
      .bind(workId)
      .run()
    const res = await approve(id)
    expect(res.status).toBe(409)
    const html = await res.text()
    expect(html).toContain('提案のあとで値が変わっています（説明）')
    expect(html).toContain('それでも反映する')
    expect(html).toContain('name="force" value="1"')
    expect(html).toContain('誰かが直した')
    expect((await proposalOf(id))?.status).toBe('pending')

    expect((await approve(id, [], { force: '1' })).status).toBe(302)
    expect(
      await env.DB.prepare('SELECT description FROM work WHERE id = ?')
        .bind(workId)
        .first('description'),
    ).toBe('新しい説明')
    expect(JSON.parse((await proposalOf(id))?.applied_json ?? '{}')).toEqual({ work: workId })
  })

  it('対象が統合されたら 409「対象が統合されたか、見つかりません。却下してください。」', async () => {
    const into = await insertWork(env, { title: `先 ${uniq()}` })
    const workId = await insertWork(env, { title: `元 ${uniq()}` })
    const id = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      fields: [f('work.description', 'x')],
    })
    await env.DB.prepare('UPDATE work SET merged_into_id = ? WHERE id = ?').bind(into, workId).run()
    const res = await approve(id)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('対象が統合されたか、見つかりません。却下してください。')
  })

  it('merge 提案の承認で merged_into_id が立ち、旧題が別名に入る', async () => {
    const b = await insertWork(env, { title: `統合先 ${uniq()}` })
    const aTitle = `統合元 ${uniq()}`
    const a = await insertWork(env, { title: aTitle })
    const id = await propose({
      kind: 'merge',
      target_table: 'work',
      target_id: a,
      fields: [f('work.merged_into_id', b)],
    })
    expect((await approve(id)).status).toBe(302)
    expect(
      await env.DB.prepare('SELECT merged_into_id FROM work WHERE id = ?')
        .bind(a)
        .first('merged_into_id'),
    ).toBe(b)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM work_alias WHERE work_id = ? AND title = ? AND kind = 'former_title'",
        b,
        aTitle,
      ),
    ).toBe(1)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE proposal_id = ? AND table_name = 'work' AND action = 'merge' AND actor_user_id = ?",
        id,
        owner.userId,
      ),
    ).toBe(1)
  })

  it('同じ対象の承認待ちがほかにあると詳細に出る', async () => {
    const workId = await insertWork(env, { title: `二重 ${uniq()}` })
    const reqA = await insertRequest('processing')
    const id1 = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      fields: [f('work.description', '1')],
    })
    const id2 = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      request_id: reqA,
      fields: [f('work.description', '2')],
    })
    const html = await (await get(`/admin/proposals/${id1}`)).text()
    expect(html).toContain('同じ対象の承認待ちの提案がほかにもあります')
    expect(html).toContain(`/admin/proposals/${id2}`)
  })

  it('同じ escape.id URL の承認待ちが 2 件あると詳細に出て、1 件目の承認後の 2 件目は 400', async () => {
    const url = `https://escape.id/foo-org/e-same-${uniq()}/`
    const body = (title: string) => ({
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', title),
        f('run.channel', 'performance'),
        f('run.escape_id_url', url),
      ],
    })
    const id1 = await propose(body(`URL 1 ${uniq()}`))
    const id2 = await propose(body(`URL 2 ${uniq()}`))
    const html = await (await get(`/admin/proposals/${id1}`)).text()
    expect(html).toContain('同じ escape.id の URL で回を作る承認待ちの提案がほかにもあります')
    expect(html).toContain(`/admin/proposals/${id2}`)
    expect((await approve(id1)).status).toBe(302)
    const res = await approve(id2)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('同じ escape.id URL の回があります。')
  })
})

describe('却下', () => {
  it('却下すると rejection_memory に fingerprint が入り、同じ提案は 409 suppressed', async () => {
    const body = createWorkBody(`却下 ${uniq()}`)
    const id = await propose(body)
    const res = await post(`/admin/proposals/${id}/reject`, { reason: '重複', remember: '1' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/admin/proposals?tab=pending')
    const p = await proposalOf(id)
    expect(p).toMatchObject({ status: 'rejected', review_note: '重複' })
    const again = await api('POST', '/api/agent/proposals', body)
    expect(again).toEqual({ status: 409, body: { error: 'suppressed', reason: '重複' } })
  })

  it('remember を外すと却下記憶に入らない。理由が空なら 400', async () => {
    const body = createWorkBody(`却下 2 ${uniq()}`)
    const id = await propose(body)
    const empty = await post(`/admin/proposals/${id}/reject`, { reason: ' ', remember: '1' })
    expect(empty.status).toBe(400)
    expect(await empty.text()).toContain('却下の理由を入力してください。')
    expect((await proposalOf(id))?.status).toBe('pending')

    expect((await post(`/admin/proposals/${id}/reject`, { reason: 'いらない' })).status).toBe(302)
    expect((await api('POST', '/api/agent/proposals', body)).status).toBe(201)
  })
})

describe('リクエストの自動 done', () => {
  it('最後の pending を処理すると done、残っていれば proposed のまま', async () => {
    const req = await insertRequest('processing')
    const id1 = await propose(createWorkBody(`依頼 1 ${uniq()}`, [], { request_id: req }))
    const id2 = await propose(createWorkBody(`依頼 2 ${uniq()}`, [], { request_id: req }))
    expect((await api('PATCH', `/api/agent/requests/${req}`, { status: 'proposed' })).status).toBe(
      200,
    )
    const status = () =>
      env.DB.prepare('SELECT status FROM request WHERE id = ?').bind(req).first('status')

    expect((await approve(id1)).status).toBe(302)
    expect(await status()).toBe('proposed')
    expect(
      (await post(`/admin/proposals/${id2}/reject`, { reason: 'x', remember: '1' })).status,
    ).toBe(302)
    expect(await status()).toBe('done')

    // オーナーのリクエスト画面に提案が出る。依頼者の画面に「作品を見る ›」
    const adminHtml = await (await get(`/admin/requests/${req}`)).text()
    expect(adminHtml).toContain(`/admin/proposals/${id1}`)
    expect(adminHtml).toContain(`/admin/proposals/${id2}`)
    const workId = JSON.parse((await proposalOf(id1))?.applied_json ?? '{}').work
    const own = await (await get(`/requests/${req}`, member.cookie)).text()
    expect(own).toContain(`/works/${workId}`)
    expect(own).toContain('作品を見る ›')
  })
})

describe('二重の処理・権限・画面', () => {
  it('2 回目の承認・却下は 409「この提案はもう処理されています。」', async () => {
    const id = await propose(createWorkBody(`二回 ${uniq()}`))
    expect((await approve(id)).status).toBe(302)
    const again = await approve(id)
    expect(again.status).toBe(409)
    expect(await again.text()).toContain('この提案はもう処理されています。')
    const rej = await post(`/admin/proposals/${id}/reject`, { reason: 'x' })
    expect(rej.status).toBe(409)
  })

  it('組み立ててから書くまでの間に処理されていたら batch ごと失敗して何も作らない', async () => {
    const db = createDb(env.DB)
    const title = `競合 ${uniq()}`
    const id = await propose(createWorkBody(title))
    const d = await getAdminProposal(db, id)
    if (!d) throw new Error('no proposal')
    const body = await acceptAll(id)
    const r = await buildApproval(
      db,
      d.row,
      d.fields,
      approvalChoiceOf(body, d.fields),
      [],
      owner.userId,
    )
    if (!r.ok) throw new Error(JSON.stringify(r))
    await env.DB.prepare("UPDATE proposal SET status = 'rejected' WHERE id = ?").bind(id).run()
    await expect(runStmts(db, r.stmts)).rejects.toThrow()
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE title = ?', title)).toBe(0)
  })

  it('member は 404、未ログインの POST は 401', async () => {
    const id = await propose(createWorkBody(`権限 ${uniq()}`))
    expect((await get('/admin/proposals', member.cookie)).status).toBe(404)
    expect((await get(`/admin/proposals/${id}`, member.cookie)).status).toBe(404)
    expect((await post(`/admin/proposals/${id}/approve`, {}, member.cookie)).status).toBe(404)
    expect((await post(`/admin/proposals/${id}/reject`, { reason: 'x' }, null)).status).toBe(401)
    expect((await proposalOf(id))?.status).toBe('pending')
  })

  it('採用 0 件は 400', async () => {
    const workId = await insertWork(env, { title: `ゼロ ${uniq()}` })
    const id = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      fields: [f('work.description', 'x')],
    })
    const res = await post(`/admin/proposals/${id}/approve`, {})
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('採用する項目を 1 つ以上選んでください。')
  })

  it('一覧に承認待ちが出て、設定に件数のリンク。HTML に人数は出ない', async () => {
    const orgId = await insertOrg(env, { name: `一覧の団体 ${uniq()}` })
    const title = `一覧 ${uniq()}`
    const id = await propose(createWorkBody(title, [f('work.primary_organization_id', orgId)]))
    const list = await (await get('/admin/proposals')).text()
    expect(list).toContain(title)
    expect(list).toContain(`/admin/proposals/${id}`)
    const detail = await (await get(`/admin/proposals/${id}`)).text()
    expect(detail).toContain('承認して反映')
    expect(detail).toContain('一覧の団体')
    expect(detail).not.toMatch(/\d+ 人/)
    expect(detail).not.toContain('class="hl')
    const n = await count("SELECT COUNT(*) AS n FROM proposal WHERE status = 'pending'")
    const settings = await (await get('/settings')).text()
    expect(settings).toContain('href="/admin/proposals"')
    expect(settings).toContain(`${n} 件`)
  })
})
