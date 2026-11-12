import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { fingerprintOf } from '../src/pipeline/fields'
import { loginAs } from './helpers/auth'
import { insertOrg, insertRun, insertWork } from './helpers/master'

let token = ''
let tokenId = ''
let member = { userId: '', cookie: '' }

beforeAll(async () => {
  const t = await createToken(createDb(env.DB), 'agent-proposals', 90)
  token = t.token
  tokenId = t.id
  member = await loginAs(env, { subject: 'agent-proposals-member' })
})

const auth = () => ({ Authorization: `Bearer ${token}` })

type Res = { status: number; body: Record<string, unknown> }

const send = async (method: string, path: string, body?: unknown): Promise<Res> => {
  const res = await app.request(
    path,
    {
      method,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const post = (path: string, body: unknown) => send('POST', path, body)
const get = (path: string) => send('GET', path)

const fetchedAt = '2026-11-11T01:02:03Z'

const okSource = {
  url: 'https://escape.id/foo-org/e-bar/',
  method: 'escape_mcp',
  fetched_at: fetchedAt,
  robots_checked: 0,
}

const f = (field: string, newValue: string | null, confidence = 0.95, sourceId?: string) => ({
  field,
  new_value: newValue,
  source_id: sourceId ?? null,
  confidence,
})

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

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>('n')) ?? 0

describe('POST /api/agent/sources', () => {
  it('escape.id の /me/ と X は 400 forbidden_source', async () => {
    for (const url of [
      'https://escape.id/me/',
      'https://www.escape.id/me/history',
      'https://x.com/someone/status/1',
      'https://mobile.twitter.com/someone',
    ]) {
      const r = await post('/api/agent/sources', {
        ...okSource,
        url,
        method: 'webfetch',
        robots_checked: 1,
      })
      expect(r, url).toEqual({ status: 400, body: { error: 'forbidden_source' } })
    }
  })

  it('escape_mcp で他ホスト・webfetch で robots 未確認・excerpt 501 字・manual は 400', async () => {
    expect(await post('/api/agent/sources', { ...okSource, url: 'https://example.com/a' })).toEqual(
      { status: 400, body: { error: 'method_host_mismatch' } },
    )
    expect(
      await post('/api/agent/sources', {
        ...okSource,
        url: 'https://example.com/a',
        method: 'webfetch',
      }),
    ).toEqual({ status: 400, body: { error: 'robots_not_checked' } })
    expect(await post('/api/agent/sources', { ...okSource, excerpt: 'あ'.repeat(501) })).toEqual({
      status: 400,
      body: { error: 'excerpt_too_long' },
    })
    expect(await post('/api/agent/sources', { ...okSource, method: 'manual' })).toEqual({
      status: 400,
      body: { error: 'invalid_method' },
    })
    expect(await post('/api/agent/sources', { ...okSource, fetched_at: '2026-11-11' })).toEqual({
      status: 400,
      body: { error: 'invalid_fetched_at' },
    })
    expect(await post('/api/agent/sources', { ...okSource, content_hash: 'abc' })).toEqual({
      status: 400,
      body: { error: 'invalid_content_hash' },
    })
  })

  it('正常は 201 で domain が入る（500 字の excerpt は通る）', async () => {
    const r = await post('/api/agent/sources', {
      ...okSource,
      url: 'https://ESCAPE.id/foo-org/e-bar/',
      excerpt: 'あ'.repeat(500),
      content_hash: 'a'.repeat(64),
    })
    expect(r.status).toBe(201)
    const row = await env.DB.prepare('SELECT * FROM source WHERE id = ?')
      .bind(r.body.id)
      .first<Record<string, unknown>>()
    expect(row).toMatchObject({
      url: 'https://escape.id/foo-org/e-bar/',
      domain: 'escape.id',
      method: 'escape_mcp',
      fetched_at: '2026-11-11T01:02:03.000Z',
      robots_checked: 0,
    })
    const w = await post('/api/agent/sources', {
      url: 'https://example.com/page',
      method: 'webfetch',
      fetched_at: fetchedAt,
      robots_checked: 1,
    })
    expect(w.status).toBe(201)
  })
})

describe('POST /api/agent/proposals の形', () => {
  it('未知の field・note 列・imageUrl は 400 unknown_field', async () => {
    for (const field of ['work.nope', 'work.note', 'run.note', 'organization.note', 'imageUrl']) {
      const r = await post('/api/agent/proposals', {
        kind: 'create',
        target_table: 'work',
        fields: [f('work.title', `題 ${uniq()}`), f(field, 'x')],
      })
      expect(r, field).toEqual({ status: 400, body: { error: 'unknown_field' } })
    }
  })

  it('create_attempt_import は 400 kind_not_supported', async () => {
    expect(
      await post('/api/agent/proposals', {
        kind: 'create_attempt_import',
        target_table: 'work',
        fields: [f('work.title', 'x')],
      }),
    ).toEqual({ status: 400, body: { error: 'kind_not_supported' } })
  })

  it('@venue を venue 節なしで使うと 400 invalid_placeholder', async () => {
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', `題 ${uniq()}`),
        f('run.channel', 'performance'),
        f('run.venue_id', '@venue'),
      ],
    })
    expect(r).toEqual({ status: 400, body: { error: 'invalid_placeholder' } })
  })

  it('同じ field 2 回・confidence 範囲外・候補の不正は 400', async () => {
    const base = { kind: 'create', target_table: 'work' }
    expect(
      await post('/api/agent/proposals', {
        ...base,
        fields: [f('work.title', 'a'), f('work.title', 'b')],
      }),
    ).toEqual({ status: 400, body: { error: 'duplicate_field' } })
    expect(
      await post('/api/agent/proposals', { ...base, fields: [f('work.title', 'a', 1.5)] }),
    ).toEqual({ status: 400, body: { error: 'invalid_confidence' } })
    expect(
      await post('/api/agent/proposals', {
        ...base,
        fields: [f('work.title', 'a')],
        match_candidates: [{ table: 'run', id: 'x', score: 0.5, reason: 'r' }],
      }),
    ).toEqual({ status: 400, body: { error: 'invalid_candidates' } })
  })

  it('無い source_id は 400 source_not_found と field', async () => {
    expect(
      await post('/api/agent/proposals', {
        kind: 'create',
        target_table: 'work',
        fields: [f('work.title', `題 ${uniq()}`, 0.9, 'nope')],
      }),
    ).toEqual({ status: 400, body: { error: 'source_not_found', field: 'work.title' } })
  })

  it('work.title 無しは 400 invalid_fields に「題名を入力してください。」', async () => {
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [f('work.description', '説明')],
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_fields')
    expect(r.body.details).toContain('題名を入力してください。')
  })

  it('target: 無い → 404、統合済み → 409', async () => {
    const b = await insertWork(env, { title: `統合先 ${uniq()}` })
    const a = await insertWork(env, { title: `統合元 ${uniq()}`, mergedIntoId: b })
    expect(
      await post('/api/agent/proposals', {
        kind: 'update',
        target_table: 'work',
        target_id: 'nope',
        fields: [f('work.description', 'x')],
      }),
    ).toEqual({ status: 404, body: { error: 'target_not_found' } })
    expect(
      await post('/api/agent/proposals', {
        kind: 'update',
        target_table: 'work',
        target_id: a,
        fields: [f('work.description', 'x')],
      }),
    ).toEqual({ status: 409, body: { error: 'target_merged' } })
  })
})

describe('POST /api/agent/proposals の書き込み', () => {
  it('create work + run の束が pending で入り、confidence は最小値、old_value は NULL', async () => {
    const src = (await post('/api/agent/sources', okSource)).body.id as string
    const title = `束の作品 ${uniq()}`
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', title, 0.95, src),
        f('work.kind', 'hall', 0.5, src),
        f('run.channel', 'performance', 0.95, src),
        f('run.venue_id', '@venue', 0.9, src),
        f('venue.name', `会場 ${uniq()}`, 0.8, src),
      ],
    })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({
      status: 'pending',
      revert_until: null,
      follow_ups: [],
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    const p = await env.DB.prepare('SELECT * FROM proposal WHERE id = ?')
      .bind(r.body.id)
      .first<Record<string, unknown>>()
    expect(p).toMatchObject({
      status: 'pending',
      kind: 'create',
      target_table: 'work',
      target_id: null,
      confidence: 0.5,
      created_by_token_id: tokenId,
    })
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM proposal_field WHERE proposal_id = ? AND old_value IS NULL AND source_id = ?',
        r.body.id,
        src,
      ),
    ).toBe(5)
    // マスタには何も書かない。change_log は提案の作成だけ（actor = トークン、proposal_id）
    expect(await count('SELECT COUNT(*) AS n FROM work WHERE title = ?', title)).toBe(0)
    const logs = await env.DB.prepare(
      'SELECT table_name, action, actor_user_id, actor_token_id FROM change_log WHERE proposal_id = ?',
    )
      .bind(r.body.id)
      .all()
    expect(logs.results).toEqual([
      { table_name: 'proposal', action: 'create', actor_user_id: null, actor_token_id: tokenId },
    ])

    // GET 1 件は項目込み
    const one = await get(`/api/agent/proposals/${r.body.id}`)
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ id: r.body.id, status: 'pending', kind: 'create' })
    expect((one.body.fields as unknown[]).length).toBe(5)
    expect((await get('/api/agent/proposals/nope')).status).toBe(404)
  })

  it('既存の escape_id_url の create は 409 と run_id・work_id', async () => {
    const workId = await insertWork(env, { title: `既存 ${uniq()}` })
    const url = `https://escape.id/a-org/e-${uniq()}/`
    const runId = await insertRun(env, { workId, channel: 'performance', escapeIdUrl: url })
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', `別の題 ${uniq()}`),
        f('run.channel', 'performance'),
        f('run.escape_id_url', url.slice(0, -1)),
      ],
    })
    expect(r).toEqual({
      status: 409,
      body: { error: 'duplicate_escape_id_url', run_id: runId, work_id: workId },
    })
  })

  it('update の old_value は Worker が今の行から入れる（agent の値は無視）。同じ値だけなら 400 no_change', async () => {
    const workId = await insertWork(env, { title: `更新 ${uniq()}`, description: '前の説明' })
    expect(
      await post('/api/agent/proposals', {
        kind: 'update',
        target_table: 'work',
        target_id: workId,
        fields: [{ ...f('work.description', '前の説明'), old_value: 'うそ' }],
      }),
    ).toEqual({ status: 400, body: { error: 'no_change' } })
    const r = await post('/api/agent/proposals', {
      kind: 'update',
      target_table: 'work',
      target_id: workId,
      fields: [{ ...f('work.description', '新しい説明'), old_value: 'うそ' }],
    })
    expect(r.status).toBe(201)
    const pf = await env.DB.prepare(
      'SELECT old_value, new_value FROM proposal_field WHERE proposal_id = ?',
    )
      .bind(r.body.id)
      .first()
    expect(pf).toEqual({ old_value: '前の説明', new_value: '新しい説明' })
  })

  it('同じ提案 2 回は 409 duplicate_pending', async () => {
    const body = {
      kind: 'create',
      target_table: 'organization',
      fields: [f('organization.name', `団体 ${uniq()}`)],
    }
    const a = await post('/api/agent/proposals', body)
    expect(a.status).toBe(201)
    // confidence と source が違っても同じ fingerprint
    const b = await post('/api/agent/proposals', {
      ...body,
      fields: [{ ...body.fields[0], confidence: 0.4 }],
    })
    expect(b).toEqual({ status: 409, body: { error: 'duplicate_pending', proposal_id: a.body.id } })
  })

  it('rejection_memory に入れた fingerprint は 409 suppressed で行が増えない', async () => {
    const body = {
      kind: 'create',
      target_table: 'organization',
      fields: [f('organization.name', `却下 ${uniq()}`)],
    }
    const fp = await fingerprintOf({
      kind: 'create',
      targetTable: 'organization',
      targetId: null,
      items: [{ field: 'organization.name', newValue: body.fields[0].new_value }],
    })
    await env.DB.prepare(
      "INSERT INTO rejection_memory (fingerprint, reason, created_at) VALUES (?, '重複', ?)",
    )
      .bind(fp, new Date().toISOString())
      .run()
    const before = await count('SELECT COUNT(*) AS n FROM proposal')
    expect(await post('/api/agent/proposals', body)).toEqual({
      status: 409,
      body: { error: 'suppressed', reason: '重複' },
    })
    expect(await count('SELECT COUNT(*) AS n FROM proposal')).toBe(before)
  })

  it('同じ target の update 2 本目で 1 本目が superseded', async () => {
    const workId = await insertWork(env, { title: `置き換え ${uniq()}` })
    const up = (d: string) =>
      post('/api/agent/proposals', {
        kind: 'update',
        target_table: 'work',
        target_id: workId,
        fields: [f('work.description', d)],
      })
    const a = await up('一つ目')
    const b = await up('二つ目')
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const st = (id: unknown) =>
      env.DB.prepare('SELECT status FROM proposal WHERE id = ?').bind(id).first('status')
    expect(await st(a.body.id)).toBe('superseded')
    expect(await st(b.body.id)).toBe('pending')
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM change_log WHERE row_id = ? AND action = 'update' AND proposal_id = ?",
        a.body.id,
        b.body.id,
      ),
    ).toBe(1)
  })

  it('link と merge の old_value・検証', async () => {
    const w1 = await insertWork(env, { title: `紐付け元 ${uniq()}` })
    const w2 = await insertWork(env, { title: `紐付け先 ${uniq()}` })
    const runId = await insertRun(env, { workId: w1, channel: 'online' })
    const l = await post('/api/agent/proposals', {
      kind: 'link',
      target_table: 'run',
      target_id: runId,
      fields: [f('run.work_id', w2)],
    })
    expect(l.status).toBe(201)
    expect(
      await env.DB.prepare('SELECT old_value FROM proposal_field WHERE proposal_id = ?')
        .bind(l.body.id)
        .first('old_value'),
    ).toBe(w1)
    expect(
      await post('/api/agent/proposals', {
        kind: 'link',
        target_table: 'run',
        target_id: runId,
        fields: [f('run.work_id', w1)],
      }),
    ).toEqual({ status: 400, body: { error: 'no_change' } })
    const m = await post('/api/agent/proposals', {
      kind: 'merge',
      target_table: 'work',
      target_id: w1,
      fields: [f('work.merged_into_id', 'nope')],
    })
    expect(m.status).toBe(400)
    expect(m.body.details).toEqual(['統合先が見つからないか、統合済みです。'])
    // update で run.work_id は書けない
    expect(
      await post('/api/agent/proposals', {
        kind: 'update',
        target_table: 'run',
        target_id: runId,
        fields: [f('run.work_id', w2)],
      }),
    ).toEqual({ status: 400, body: { error: 'unknown_field' } })
  })

  it('request が processing でない → 409、無い → 404', async () => {
    const open = await insertRequest('open')
    const body = (requestId: string) => ({
      kind: 'create',
      target_table: 'organization',
      request_id: requestId,
      fields: [f('organization.name', `依頼の団体 ${uniq()}`)],
    })
    expect(await post('/api/agent/proposals', body(open))).toEqual({
      status: 409,
      body: { error: 'request_not_processing' },
    })
    expect(await post('/api/agent/proposals', body('nope'))).toEqual({
      status: 404,
      body: { error: 'request_not_found' },
    })
  })

  it('Worker の完全一致候補が worker:title で保存される（agent の候補もそのまま）', async () => {
    const title = `候補の作品 ${uniq()}`
    const existing = await insertWork(env, { title })
    const agentWork = await insertWork(env, { title: `似た作品 ${uniq()}` })
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [f('work.title', title)],
      match_candidates: [{ table: 'work', id: agentWork, score: 0.82, reason: 'similar' }],
    })
    expect(r.status).toBe(201)
    const json = await env.DB.prepare(
      'SELECT match_candidates_json AS j FROM proposal WHERE id = ?',
    )
      .bind(r.body.id)
      .first<string>('j')
    expect(JSON.parse(json ?? '[]')).toEqual([
      { table: 'work', id: agentWork, score: 0.82, reason: 'similar' },
      { table: 'work', id: existing, score: 0.85, reason: 'worker:title' },
    ])
  })

  it('束の団体名で Worker の団体候補も入る', async () => {
    const name = `既存の団体 ${uniq()}`
    const orgId = await insertOrg(env, { name })
    const r = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'work',
      fields: [
        f('work.title', `新しい作品 ${uniq()}`),
        f('work.primary_organization_id', '@organization'),
        f('organization.name', name),
      ],
    })
    expect(r.status).toBe(201)
    const json = await env.DB.prepare(
      'SELECT match_candidates_json AS j FROM proposal WHERE id = ?',
    )
      .bind(r.body.id)
      .first<string>('j')
    expect(JSON.parse(json ?? '[]')).toContainEqual({
      table: 'organization',
      id: orgId,
      score: 1,
      reason: 'worker:name',
    })
  })
})

describe('GET /api/agent/proposals と PATCH proposed', () => {
  it('request_id で一覧。pending が 0 件のうちは proposed にできない', async () => {
    const req = await insertRequest('processing')
    expect(await send('PATCH', `/api/agent/requests/${req}`, { status: 'proposed' })).toEqual({
      status: 409,
      body: { error: 'no_pending_proposal' },
    })
    const p = await post('/api/agent/proposals', {
      kind: 'create',
      target_table: 'organization',
      request_id: req,
      fields: [f('organization.name', `一覧の団体 ${uniq()}`)],
    })
    expect(p.status).toBe(201)
    const list = await get(`/api/agent/proposals?request_id=${req}`)
    expect(list.body.items).toEqual([
      {
        id: p.body.id,
        kind: 'create',
        target_table: 'organization',
        target_id: null,
        status: 'pending',
        created_at: expect.any(String),
      },
    ])
    expect((await get('/api/agent/proposals')).body).toEqual({ error: 'request_id_required' })
    expect(await send('PATCH', `/api/agent/requests/${req}`, { status: 'proposed' })).toEqual({
      status: 200,
      body: { id: req, status: 'proposed' },
    })
  })
})

describe('fingerprint', () => {
  const base = { kind: 'create' as const, targetTable: 'work' as const, targetId: null }
  const items = [
    { field: 'work.title', newValue: '題' },
    { field: 'run.channel', newValue: 'performance' },
  ]
  it('項目の順序が違っても同じ、値が変われば違う', async () => {
    const a = await fingerprintOf({ ...base, items })
    expect(await fingerprintOf({ ...base, items: [...items].reverse() })).toBe(a)
    expect(
      await fingerprintOf({
        ...base,
        items: [items[0], { field: 'run.channel', newValue: 'online' }],
      }),
    ).not.toBe(a)
  })

  it('confidence・source を変えても同じ', async () => {
    const withMeta = items.map((i, n) => ({ ...i, confidence: n / 3, sourceId: `s${n}` }))
    const other = items.map((i) => ({ ...i, confidence: 1, sourceId: null }))
    expect(await fingerprintOf({ ...base, items: withMeta })).toBe(
      await fingerprintOf({ ...base, items: other }),
    )
  })
})
