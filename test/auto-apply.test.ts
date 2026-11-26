import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { runStmts } from '../src/db/master-write'
import { appliedWorkOfRequest, getAdminProposal } from '../src/db/proposals'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { buildRevert } from '../src/pipeline/apply'
import { type AutoApplyInput, autoApplyDecision } from '../src/pipeline/auto'
import { writeConflictOf } from '../src/routes/api-agent'
import { revertUntilText } from '../src/ui/proposals'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertRun, insertWork, insertWorkAlias } from './helpers/master'
import { insertAttempt } from './helpers/records'

let token = ''
let tokenId = ''
let owner = { cookie: '', userId: '' }
let member = { cookie: '', userId: '' }
// escape.id（escape_mcp）と他サイト（webfetch）の出典
let mcp = ''
let web = ''

// ---- agent 側

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

const fetchedAt = '2026-11-11T01:02:03Z'

const createSource = async (body: Record<string, unknown>): Promise<string> => {
  const r = await api('POST', '/api/agent/sources', { fetched_at: fetchedAt, ...body })
  if (r.status !== 201) throw new Error(`source failed: ${JSON.stringify(r)}`)
  return r.body.id as string
}

beforeAll(async () => {
  const t = await createToken(createDb(env.DB), 'auto-apply', 90)
  token = t.token
  tokenId = t.id
  owner = await loginAs(env, { subject: 'auto-apply-owner', owner: true })
  member = await loginAs(env, { subject: 'auto-apply-member' })
  mcp = await createSource({
    url: 'https://escape.id/foo-org/e-src/',
    method: 'escape_mcp',
    robots_checked: 0,
  })
  web = await createSource({
    url: 'https://example.com/event',
    method: 'webfetch',
    robots_checked: 1,
  })
})

// テストどうしで D1 を共有するので、毎回 既定（行が無い = OFF）から始める
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM app_setting').run()
})

const f = (field: string, newValue: string | null, confidence = 0.95, sourceId = mcp) => ({
  field,
  new_value: newValue,
  source_id: sourceId,
  confidence,
})

let seq = 0
const uniq = () => `${Date.now()}-${seq++}`

const createWorkBody = (
  title: string,
  extra: ReturnType<typeof f>[] = [],
  more: Record<string, unknown> = {},
) => ({
  kind: 'create',
  target_table: 'work',
  fields: [
    f('work.title', title),
    f('work.description', '説明'),
    f('run.channel', 'performance'),
    f('run.escape_id_url', `https://escape.id/foo-org/e-${uniq()}/`),
    ...extra,
  ],
  ...more,
})

const propose = (body: Record<string, unknown>) => api('POST', '/api/agent/proposals', body)

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

// 自動反映を ON / OFF にする（画面の Switch と同じく、on のときだけ auto_apply=on）
const setAuto = async (on: boolean) => {
  const res = await post('/admin/proposals/settings', on ? { auto_apply: 'on' } : {})
  expect(res.status).toBe(302)
}

type ProposalDbRow = {
  status: string
  applied_json: string | null
  revert_until: string | null
  reverted_at: string | null
  reverted_by_user_id: string | null
  follow_up_of_id: string | null
  target_table: string
  target_id: string | null
  kind: string
  request_id: string | null
}
const proposalOf = (id: string) =>
  env.DB.prepare(
    'SELECT status, applied_json, revert_until, reverted_at, reverted_by_user_id, follow_up_of_id, target_table, target_id, kind, request_id FROM proposal WHERE id = ?',
  )
    .bind(id)
    .first<ProposalDbRow>()

const appliedOf = async (id: string) =>
  JSON.parse((await proposalOf(id))?.applied_json ?? '{}') as Record<string, string>

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>('n')) ?? 0

const insertRequest = async (status: string, kind = 'new_work') => {
  const id = ulid()
  const at = new Date().toISOString()
  await env.DB.prepare(
    "INSERT INTO request (id, requester_user_id, kind, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?)",
  )
    .bind(id, member.userId, kind, status, at, at)
    .run()
  return id
}

// 自動反映した提案を 1 件作る（ON にしてから）
const autoApplied = async (extra: ReturnType<typeof f>[] = []) => {
  await setAuto(true)
  const r = await propose(createWorkBody(`自動反映 ${uniq()}`, extra))
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  expect(r.body.status).toBe('auto_applied')
  return r
}

// ---------------------------------------------------------------------------
// 純関数
// ---------------------------------------------------------------------------

describe('autoApplyDecision', () => {
  const item = (field: string, newValue: string | null, confidence = 0.95, sourceId = 's1') => ({
    field,
    table: field.split('.')[0] as 'work' | 'run',
    newValue,
    sourceId,
    confidence,
  })
  const base = (): AutoApplyInput => ({
    enabled: true,
    kind: 'create',
    targetTable: 'work',
    items: [
      item('work.title', '題名'),
      item('work.kind', 'room'),
      item('run.channel', 'performance'),
      item('run.escape_id_url', 'https://escape.id/a-org/e-b/'),
    ],
    sourceMethods: new Map([
      ['s1', 'escape_mcp'],
      ['s2', 'webfetch'],
    ]),
    workerCandidates: 0,
    agentScores: [0.5],
    requestKind: null,
    pendingSameUrl: false,
  })

  it('全部満たすと apply=true、deferred は空', () => {
    expect(autoApplyDecision(base())).toEqual({ apply: true, reason: 'ok', deferred: [] })
    expect(autoApplyDecision({ ...base(), requestKind: 'new_work' }).apply).toBe(true)
  })

  it('1〜8 をそれぞれ 1 つだけ崩すと apply=false', () => {
    const b = base()
    const cases: [string, AutoApplyInput][] = [
      ['1 設定 OFF', { ...b, enabled: false }],
      ['2 update', { ...b, kind: 'update' }],
      ['2 create organization', { ...b, targetTable: 'organization' }],
      [
        '3 団体の節',
        {
          ...b,
          items: [
            ...b.items,
            {
              field: 'organization.name',
              table: 'organization',
              newValue: '団体',
              sourceId: 's1',
              confidence: 1,
            },
          ],
        },
      ],
      ['4 出典なし', { ...b, items: [...b.items, item('work.description', '説明', 0.95, '')] }],
      ['4 webfetch', { ...b, items: [...b.items, item('work.description', '説明', 0.95, 's2')] }],
      [
        '4 無い source',
        { ...b, items: [...b.items, item('work.description', '説明', 0.95, 'sx')] },
      ],
      [
        '5 escape_id_url なし',
        { ...b, items: b.items.filter((i) => i.field !== 'run.escape_id_url') },
      ],
      ['6 確信度 0.89', { ...b, items: [...b.items, item('work.description', '説明', 0.89)] }],
      ['7 Worker の候補', { ...b, workerCandidates: 1 }],
      ['7 agent の候補 0.8', { ...b, agentScores: [0.8] }],
      ['7 同じ escape_id_url の承認待ち', { ...b, pendingSameUrl: true }],
      ['8 リクエストが new_work 以外', { ...b, requestKind: 'fix_work' }],
    ]
    for (const [name, input] of cases) {
      expect(autoApplyDecision(input).apply, name).toBe(false)
    }
  })

  it('kind 0.7 → deferred に work.kind。is_permanent 0.5 も。値が空なら deferred にしない', () => {
    const b = base()
    const items = b.items.map((i) => (i.field === 'work.kind' ? { ...i, confidence: 0.7 } : i))
    expect(autoApplyDecision({ ...b, items })).toEqual({
      apply: true,
      reason: 'ok',
      deferred: ['work.kind'],
    })
    expect(
      autoApplyDecision({ ...b, items: [...items, item('run.is_permanent', '1', 0.5)] }).deferred,
    ).toEqual(['work.kind', 'run.is_permanent'])
    expect(
      autoApplyDecision({ ...b, items: [...b.items, item('run.is_permanent', null, 0.5)] })
        .deferred,
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// POST /api/agent/proposals の自動反映
// ---------------------------------------------------------------------------

describe('自動反映', () => {
  it('設定 OFF（既定、行が無い）では条件を満たしても pending', async () => {
    expect(await count("SELECT COUNT(*) AS n FROM app_setting WHERE key = 'auto_apply'")).toBe(0)
    const r = await propose(createWorkBody(`OFF ${uniq()}`))
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ status: 'pending', revert_until: null, follow_ups: [] })
    expect((await proposalOf(r.body.id as string))?.status).toBe('pending')
  })

  it('ON で auto_applied、revert_until が 7 日後、work・run ができ change_log が actor_token_id', async () => {
    const title = `ON ${uniq()}`
    await setAuto(true)
    const before = Date.now()
    const r = await propose(createWorkBody(title, [f('work.kind', 'room')]))
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('auto_applied')
    expect(r.body.follow_ups).toEqual([])
    const id = r.body.id as string
    const p = await proposalOf(id)
    expect(p?.status).toBe('auto_applied')
    expect(p?.revert_until).toBe(r.body.revert_until)
    const until = Date.parse(p?.revert_until ?? '')
    expect(until - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000)
    expect(until - Date.now()).toBeLessThanOrEqual(7 * 86_400_000)

    const applied = await appliedOf(id)
    const w = await env.DB.prepare('SELECT title, kind FROM work WHERE id = ?')
      .bind(applied.work)
      .first<{ title: string; kind: string | null }>()
    expect(w).toEqual({ title, kind: 'room' })
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM run WHERE id = ? AND work_id = ?',
        applied.run,
        applied.work,
      ),
    ).toBe(1)
    const logs = (
      await env.DB.prepare(
        "SELECT table_name, actor_user_id, actor_token_id FROM change_log WHERE proposal_id = ? AND table_name IN ('work', 'run') ORDER BY table_name",
      )
        .bind(id)
        .all<{ table_name: string; actor_user_id: string | null; actor_token_id: string | null }>()
    ).results
    expect(logs).toEqual([
      { table_name: 'run', actor_user_id: null, actor_token_id: tokenId },
      { table_name: 'work', actor_user_id: null, actor_token_id: tokenId },
    ])
    // 入れた項目は accepted = 1
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM proposal_field WHERE proposal_id = ? AND accepted = 1',
        id,
      ),
    ).toBe(5)
  })

  it('kind 0.7 → kind NULL で反映し、follow-up の update（pending、follow_up_of_id）ができる', async () => {
    const r = await autoApplied([f('work.kind', 'room', 0.7)])
    const id = r.body.id as string
    const applied = await appliedOf(id)
    const w = await env.DB.prepare('SELECT kind FROM work WHERE id = ?')
      .bind(applied.work)
      .first<{ kind: string | null }>()
    expect(w?.kind).toBeNull()
    const followUps = r.body.follow_ups as string[]
    expect(followUps).toHaveLength(1)
    const fu = await proposalOf(followUps[0])
    expect(fu).toMatchObject({
      status: 'pending',
      kind: 'update',
      target_table: 'work',
      target_id: applied.work,
      follow_up_of_id: id,
      request_id: null,
    })
    const fields = (
      await env.DB.prepare(
        'SELECT field, old_value, new_value, confidence FROM proposal_field WHERE proposal_id = ?',
      )
        .bind(followUps[0])
        .all()
    ).results
    expect(fields).toEqual([
      { field: 'work.kind', old_value: null, new_value: 'room', confidence: 0.7 },
    ])
    // 元の提案の work.kind は入れていない（accepted = 0）
    expect(
      await env.DB.prepare(
        "SELECT accepted FROM proposal_field WHERE proposal_id = ? AND field = 'work.kind'",
      )
        .bind(id)
        .first<number>('accepted'),
    ).toBe(0)

    // follow-up を承認すると kind が入る
    const fid = followUps[0]
    const res = await post(`/admin/proposals/${fid}/approve`, { kind: 'room' })
    expect(res.status).toBe(302)
    expect(
      await env.DB.prepare('SELECT kind FROM work WHERE id = ?').bind(applied.work).first('kind'),
    ).toBe('room')
  })

  it('is_permanent 0.5 → is_permanent 0 で反映し、follow-up の update run ができる', async () => {
    const r = await autoApplied([f('run.is_permanent', '1', 0.5)])
    const applied = await appliedOf(r.body.id as string)
    expect(
      await env.DB.prepare('SELECT is_permanent FROM run WHERE id = ?')
        .bind(applied.run)
        .first('is_permanent'),
    ).toBe(0)
    const followUps = r.body.follow_ups as string[]
    expect(followUps).toHaveLength(1)
    expect(await proposalOf(followUps[0])).toMatchObject({
      status: 'pending',
      kind: 'update',
      target_table: 'run',
      target_id: applied.run,
      follow_up_of_id: r.body.id,
    })
  })

  it('束に団体の節 → pending', async () => {
    await setAuto(true)
    const r = await propose(
      createWorkBody(`団体付き ${uniq()}`, [
        f('organization.name', `新団体 ${uniq()}`),
        f('work.primary_organization_id', '@organization'),
      ]),
    )
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
  })

  it('同じ題名の既存作品 → pending', async () => {
    await setAuto(true)
    const title = `既存 ${uniq()}`
    await insertWork(env, { title })
    const r = await propose(createWorkBody(title))
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
  })

  it('agent の候補 0.85 → pending', async () => {
    await setAuto(true)
    const other = await insertWork(env, { title: `似た作品 ${uniq()}` })
    const r = await propose(
      createWorkBody(`候補あり ${uniq()}`, [], {
        match_candidates: [{ table: 'work', id: other, score: 0.85, reason: 'similar' }],
      }),
    )
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
  })

  it('webfetch の source が 1 つ → pending', async () => {
    await setAuto(true)
    const r2 = await propose(
      createWorkBody(`webfetch ${uniq()}`, [
        f('work.official_url', 'https://example.com/event', 0.95, web),
      ]),
    )
    expect(r2.status).toBe(201)
    expect(r2.body.status).toBe('pending')
  })

  it('リクエスト（new_work, processing）付きなら反映して request は done、fix_work なら pending', async () => {
    await setAuto(true)
    const req = await insertRequest('processing')
    const r = await propose(createWorkBody(`依頼 ${uniq()}`, [], { request_id: req }))
    expect(r.body.status).toBe('auto_applied')
    expect(
      await env.DB.prepare('SELECT status FROM request WHERE id = ?').bind(req).first('status'),
    ).toBe('done')

    const fix = await insertRequest('processing', 'fix_work')
    const r2 = await propose(createWorkBody(`依頼 ${uniq()}`, [], { request_id: fix }))
    expect(r2.body.status).toBe('pending')
  })

  it('全項目を入れた束（proposal_field が 12 行を超える）でも 1 文 100 変数の上限に掛からない', async () => {
    await setAuto(true)
    const r = await propose({
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', `全部入り ${uniq()}`),
        f('work.kind', 'hall'),
        f('work.official_url', 'https://example.com/full'),
        f('work.description', '説明'),
        f('work.player_min', '2'),
        f('work.player_max', '6'),
        f('work.estimated_minutes', '90'),
        f('work.time_limit_minutes', '60'),
        f('work.first_released_on', '2026-01-01'),
        f('run.channel', 'performance'),
        f('run.billed_as', '名義'),
        f('run.start_on', '2026-02-01'),
        f('run.end_on', '2026-03-01'),
        f('run.is_permanent', '1'),
        f('run.escape_id_url', `https://escape.id/foo-org/e-${uniq()}/`),
        f('run.ticket_url', 'https://example.com/ticket'),
        f('run.price_yen', '3000'),
        f('run.escape_type_raw', 'hall'),
      ],
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.status).toBe('auto_applied')
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM proposal_field WHERE proposal_id = ? AND accepted = 1',
        r.body.id,
      ),
    ).toBe(18)
  })

  it('同じ escape_id_url で回を作る承認待ちがあれば自動反映せず pending', async () => {
    const url = `https://escape.id/foo-org/e-same-${uniq()}/`
    const body = (title: string) => {
      const b = createWorkBody(title)
      return {
        ...b,
        fields: b.fields.map((x) =>
          x.field === 'run.escape_id_url' ? { ...x, new_value: url } : x,
        ),
      }
    }
    const first = await propose(body(`同じ URL 1 ${uniq()}`))
    expect(first.body.status).toBe('pending')
    await setAuto(true)
    const second = await propose(body(`同じ URL 2 ${uniq()}`))
    expect(second.status).toBe(201)
    expect(second.body.status).toBe('pending')
  })

  it('書き込みの UNIQUE 違反: 同じ escape_id_url の回ができていれば duplicate_escape_id_url、ほかは conflict', async () => {
    const db = createDb(env.DB)
    const url = `https://escape.id/foo-org/e-race-${uniq()}/`
    const workId = await insertWork(env, { title: `競合 ${uniq()}` })
    const runId = await insertRun(env, { workId, channel: 'performance', escapeIdUrl: url })
    // 確かめた後に同じ URL の回ができた状態で、自動反映の回の INSERT が落ちたときと同じエラー
    let err: unknown
    try {
      await env.DB.prepare(
        "INSERT INTO run (id, work_id, channel, escape_id_url, created_at, updated_at) VALUES (?, ?, 'performance', ?, 'x', 'x')",
      )
        .bind(ulid(), workId, url)
        .run()
    } catch (e) {
      err = e
    }
    expect(String(err)).toContain('UNIQUE constraint failed')
    const w = { fingerprint: 'none', escapeUrl: url, autoApplied: true }
    expect(await writeConflictOf(db, err, w)).toEqual({
      error: 'duplicate_escape_id_url',
      run_id: runId,
      work_id: workId,
    })
    expect(await writeConflictOf(db, err, { ...w, escapeUrl: null })).toEqual({ error: 'conflict' })
    // 承認待ちで作るとき（自動反映でない）は fingerprint の重複だけを 409 にする
    expect(await writeConflictOf(db, err, { ...w, autoApplied: false })).toBeNull()
    expect(await writeConflictOf(db, new Error('other'), w)).toBeNull()
  })

  it('appliedWorkOfRequest は承認（reviewed_at）と自動反映（created_at）を新しい順に並べる', async () => {
    const req = await insertRequest('processing')
    // 1 件目は OFF で pending → 承認（request は done になる）
    const p1 = await propose(createWorkBody(`並び1 ${uniq()}`, [], { request_id: req }))
    expect(p1.body.status).toBe('pending')
    const fields = (
      await env.DB.prepare('SELECT id FROM proposal_field WHERE proposal_id = ?')
        .bind(p1.body.id)
        .all<{ id: string }>()
    ).results
    const body: Record<string, string> = {}
    for (const x of fields) body[`accept_${x.id}`] = '1'
    expect((await post(`/admin/proposals/${p1.body.id}/approve`, body)).status).toBe(302)
    // 2 件目は自動反映（あとから）
    await env.DB.prepare("UPDATE request SET status = 'processing' WHERE id = ?").bind(req).run()
    await setAuto(true)
    const p2 = await propose(createWorkBody(`並び2 ${uniq()}`, [], { request_id: req }))
    expect(p2.body.status).toBe('auto_applied')
    const w2 = (await appliedOf(p2.body.id as string)).work
    expect(await appliedWorkOfRequest(createDb(env.DB), req)).toBe(w2)
  })
})

// ---------------------------------------------------------------------------
// 画面: 設定・自動反映タブ
// ---------------------------------------------------------------------------

describe('設定と一覧', () => {
  it('Switch の既定は OFF、保存すると ON、もう一度保存（チェック無し）で OFF', async () => {
    const page = async () =>
      (await (await get('/admin/proposals')).text()).match(
        /<input[^>]*name="auto_apply"[^>]*>/,
      )?.[0] ?? ''
    expect(await page()).not.toContain('checked')
    await setAuto(true)
    expect(await page()).toContain('checked')
    expect(
      await env.DB.prepare(
        "SELECT value, updated_by_user_id FROM app_setting WHERE key = 'auto_apply'",
      ).first(),
    ).toEqual({ value: '1', updated_by_user_id: owner.userId })
    await setAuto(false)
    expect(await page()).not.toContain('checked')
  })

  it('自動反映タブに期限内の行と「取り消せるのは M/D HH:mm まで」（JST）、期限切れは済みタブ', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const html = await (await get('/admin/proposals?tab=auto')).text()
    expect(html).toContain(`/admin/proposals/${id}`)
    expect(html).toMatch(/取り消せるのは \d{1,2}\/\d{1,2} \d{2}:\d{2} まで/)
    const detail = await (await get(`/admin/proposals/${id}`)).text()
    expect(detail).toContain(`/admin/proposals/${id}/revert`)

    await env.DB.prepare(
      "UPDATE proposal SET revert_until = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(id)
      .run()
    expect(await (await get('/admin/proposals?tab=auto')).text()).not.toContain(
      `/admin/proposals/${id}`,
    )
    expect(await (await get('/admin/proposals?tab=done')).text()).toContain(
      `/admin/proposals/${id}`,
    )
  })

  it('member は設定・取り消しに 404', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    expect(
      (await post('/admin/proposals/settings', { auto_apply: 'on' }, member.cookie)).status,
    ).toBe(404)
    expect((await get(`/admin/proposals/${id}/revert`, member.cookie)).status).toBe(404)
    expect(
      (await post(`/admin/proposals/${id}/revert`, { confirm: 'yes' }, member.cookie)).status,
    ).toBe(404)
    expect((await proposalOf(id))?.status).toBe('auto_applied')
  })
})

// ---------------------------------------------------------------------------
// 取り消し
// ---------------------------------------------------------------------------

const revert = (id: string, confirm = true) =>
  post(`/admin/proposals/${id}/revert`, confirm ? { confirm: 'yes' } : {})

describe('取り消し', () => {
  it('work・run が消え、change_log delete 2 行（actor = オーナー）、reverted、follow-up が superseded', async () => {
    const r = await autoApplied([f('work.kind', 'room', 0.7)])
    const id = r.body.id as string
    const applied = await appliedOf(id)
    const [fu] = r.body.follow_ups as string[]

    expect((await get(`/admin/proposals/${id}/revert`)).status).toBe(200)
    // 確認のチェックが無ければ 400
    expect((await revert(id, false)).status).toBe(400)
    expect((await proposalOf(id))?.status).toBe('auto_applied')

    const res = await revert(id)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(`/admin/proposals/${id}`)
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE id = ?', applied.work)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM run WHERE id = ?', applied.run)).toBe(0)
    const logs = (
      await env.DB.prepare(
        "SELECT table_name, row_id, actor_user_id, actor_token_id FROM change_log WHERE proposal_id = ? AND action = 'delete' ORDER BY table_name",
      )
        .bind(id)
        .all()
    ).results
    expect(logs).toEqual([
      { table_name: 'run', row_id: applied.run, actor_user_id: owner.userId, actor_token_id: null },
      {
        table_name: 'work',
        row_id: applied.work,
        actor_user_id: owner.userId,
        actor_token_id: null,
      },
    ])
    const p = await proposalOf(id)
    expect(p?.status).toBe('reverted')
    expect(p?.reverted_by_user_id).toBe(owner.userId)
    expect(p?.reverted_at).not.toBeNull()
    expect((await proposalOf(fu))?.status).toBe('superseded')
    // 取り消した fingerprint は却下記憶に入れない
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM rejection_memory WHERE fingerprint = ?',
        r.body.fingerprint,
      ),
    ).toBe(0)
    // 2 回目は 409
    expect((await revert(id)).status).toBe(409)
  })

  it('attempt が付いた作品は FK 違反で batch ごと巻き戻り、409 の文言で work・run が残る', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const applied = await appliedOf(id)
    await insertAttempt(env, {
      userId: member.userId,
      workId: applied.work,
      runId: applied.run,
      status: 'cleared',
    })
    const res = await revert(id)
    expect(res.status).toBe(409)
    const html = await res.text()
    expect(html).toContain('あとから記録や別名などが付いたため、取り消せません')
    expect(html).toContain(`/admin/works?merge_from=${applied.work}`)
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE id = ?', applied.work)).toBe(1)
    expect(await count('SELECT COUNT(*) AS n FROM run WHERE id = ?', applied.run)).toBe(1)
    expect((await proposalOf(id))?.status).toBe('auto_applied')
    // 先頭の change_log（提案）も、run の delete も残らない
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE proposal_id = ? AND action = 'delete'",
        id,
      ),
    ).toBe(0)
  })

  it('work_alias が付いた作品も同じ（run の DELETE は通っても work で落ちて巻き戻る）', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const applied = await appliedOf(id)
    await insertWorkAlias(env, {
      workId: applied.work,
      title: `別名 ${uniq()}`,
      kind: 'alt_spelling',
    })
    const res = await revert(id)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('取り消せません')
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE id = ?', applied.work)).toBe(1)
    expect(await count('SELECT COUNT(*) AS n FROM run WHERE id = ?', applied.run)).toBe(1)
    expect((await proposalOf(id))?.status).toBe('auto_applied')
  })

  it('revert_until を過去にした行・承認待ちの提案は 409', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    await env.DB.prepare(
      "UPDATE proposal SET revert_until = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(id)
      .run()
    const res = await revert(id)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('取り消せる期間を過ぎたか、取り消せない提案です。')
    expect((await proposalOf(id))?.status).toBe('auto_applied')

    await setAuto(false)
    const p = await propose(createWorkBody(`承認待ち ${uniq()}`))
    expect((await revert(p.body.id as string)).status).toBe(409)
  })
})

describe('取り消し（ほかの提案・統合・付け替え）', () => {
  it('取り消す作品を対象にした update の承認待ちも superseded（change_log 付き）。戻しても対象が無いので承認は 409', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const applied = await appliedOf(id)
    const up = await propose({
      kind: 'update',
      target_table: 'work',
      target_id: applied.work,
      fields: [f('work.description', '直した説明')],
    })
    expect(up.status).toBe(201)
    const upId = up.body.id as string
    expect((await revert(id)).status).toBe(302)
    expect((await proposalOf(upId))?.status).toBe('superseded')
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'proposal' AND row_id = ? AND proposal_id = ? AND actor_user_id = ?",
        upId,
        id,
        owner.userId,
      ),
    ).toBe(1)
    // superseded の承認は 409
    const fields = (
      await env.DB.prepare('SELECT id FROM proposal_field WHERE proposal_id = ?')
        .bind(upId)
        .all<{ id: string }>()
    ).results
    const body = Object.fromEntries(fields.map((x) => [`accept_${x.id}`, '1']))
    expect((await post(`/admin/proposals/${upId}/approve`, body)).status).toBe(409)
    // pending に戻しても、対象が消えているので 409
    await env.DB.prepare("UPDATE proposal SET status = 'pending' WHERE id = ?").bind(upId).run()
    const res = await post(`/admin/proposals/${upId}/approve`, body)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('対象が統合されたか、見つかりません。')
  })

  it('承認済みの follow-up は残り、詳細に「元の作品は取り消されました」', async () => {
    const r = await autoApplied([f('work.kind', 'room', 0.7)])
    const id = r.body.id as string
    const [fu] = r.body.follow_ups as string[]
    expect((await post(`/admin/proposals/${fu}/approve`, { kind: 'room' })).status).toBe(302)
    expect((await revert(id)).status).toBe(302)
    expect((await proposalOf(fu))?.status).toBe('applied')
    expect(await (await get(`/admin/proposals/${fu}`)).text()).toContain(
      '元の作品は取り消されました',
    )
  })

  it('取り消しの文を組んだ後に follow-up が承認されたら、follow-up は applied のまま superseded の履歴も残らない', async () => {
    const db = createDb(env.DB)
    const r = await autoApplied([f('work.kind', 'room', 0.7)])
    const id = r.body.id as string
    const [fu] = r.body.follow_ups as string[]
    const p = await getAdminProposal(db, id)
    const built = await buildRevert(db, p?.row ?? (null as never), owner.userId)
    if (!built.ok) throw new Error(built.error)
    expect((await post(`/admin/proposals/${fu}/approve`, { kind: 'room' })).status).toBe(302)
    await runStmts(db, built.stmts)
    expect((await proposalOf(id))?.status).toBe('reverted')
    expect((await proposalOf(fu))?.status).toBe('applied')
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'proposal' AND row_id = ? AND after_json LIKE '%superseded%'",
        fu,
      ),
    ).toBe(0)
  })

  it('統合された作品は 409 で、作品・回が残る', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const applied = await appliedOf(id)
    const into = await insertWork(env, { title: `統合先 ${uniq()}` })
    await env.DB.prepare('UPDATE run SET work_id = ? WHERE id = ?').bind(into, applied.run).run()
    await env.DB.prepare('UPDATE work SET merged_into_id = ? WHERE id = ?')
      .bind(into, applied.work)
      .run()
    const res = await revert(id)
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('取り消せません')
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE id = ?', applied.work)).toBe(1)
    expect(await count('SELECT COUNT(*) AS n FROM run WHERE id = ?', applied.run)).toBe(1)
    expect((await proposalOf(id))?.status).toBe('auto_applied')
  })

  it('別の作品に付け替えられた回は 409 で、作品・回が残る（FK 違反にならないので書く前に止める）', async () => {
    const r = await autoApplied()
    const id = r.body.id as string
    const applied = await appliedOf(id)
    const other = await insertWork(env, { title: `付け替え先 ${uniq()}` })
    await env.DB.prepare('UPDATE run SET work_id = ? WHERE id = ?').bind(other, applied.run).run()
    const res = await revert(id)
    expect(res.status).toBe(409)
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE id = ?', applied.work)).toBe(1)
    expect(await count('SELECT COUNT(*) AS n FROM run WHERE id = ?', applied.run)).toBe(1)
    expect((await proposalOf(id))?.status).toBe('auto_applied')
  })

  it('期限の表示は JST の M/D HH:mm', () => {
    expect(revertUntilText('2026-11-18T15:04:00.000Z')).toBe('11/19 00:04')
    expect(revertUntilText(null)).toBe('')
  })
})
