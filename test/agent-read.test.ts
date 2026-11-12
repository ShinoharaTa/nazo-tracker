import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { loginAs } from './helpers/auth'
import {
  insertOrg,
  insertOrgAlias,
  insertRun,
  insertVenue,
  insertWork,
  insertWorkAlias,
} from './helpers/master'

let token = ''
let member = { userId: '', cookie: '' }

beforeAll(async () => {
  token = (await createToken(createDb(env.DB), 'agent-read', 90)).token
  member = await loginAs(env, { subject: 'agent-read-member' })
})

const auth = () => ({ Authorization: `Bearer ${token}` })

const get = async (path: string) => {
  const res = await app.request(path, { headers: auth() }, env)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const patch = async (id: string, body: unknown) => {
  const res = await app.request(
    `/api/agent/requests/${id}`,
    {
      method: 'PATCH',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

let seq = 0
const insertRequest = async (status: string, reply: string | null = null) => {
  const id = ulid()
  const at = new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString()
  await env.DB.prepare(
    "INSERT INTO request (id, requester_user_id, kind, payload_json, status, reply, triage_note, created_at, updated_at) VALUES (?, ?, 'new_work', ?, ?, ?, 'オーナーのメモ', ?, ?)",
  )
    .bind(id, member.userId, JSON.stringify({ title: `依頼 ${id}` }), status, reply, at, at)
    .run()
  return id
}

type ReqRow = {
  status: string
  question: string | null
  reply: string | null
  agent_note: string | null
}
const reqRow = (id: string) =>
  env.DB.prepare('SELECT status, question, reply, agent_note FROM request WHERE id = ?')
    .bind(id)
    .first<ReqRow>()

describe('リクエストの状態更新', () => {
  it('open → processing → proposed は 200、note は agent_note に入る', async () => {
    const id = await insertRequest('open')
    expect(await patch(id, { status: 'processing' })).toEqual({
      status: 200,
      body: { id, status: 'processing' },
    })
    const r = await patch(id, { status: 'proposed', note: '作品を 1 件提案' })
    expect(r).toEqual({ status: 200, body: { id, status: 'proposed' } })
    expect(await reqRow(id)).toMatchObject({ status: 'proposed', agent_note: '作品を 1 件提案' })
  })

  it('triaged → processing、processing → triaged も通る', async () => {
    const id = await insertRequest('triaged')
    expect((await patch(id, { status: 'processing' })).status).toBe(200)
    expect((await patch(id, { status: 'triaged' })).status).toBe(200)
    expect((await reqRow(id))?.status).toBe('triaged')
  })

  it('表に無い遷移は 409 invalid_transition（from / to 付き）で状態は変わらない', async () => {
    const id = await insertRequest('done')
    expect(await patch(id, { status: 'processing' })).toEqual({
      status: 409,
      body: { error: 'invalid_transition', from: 'done', to: 'processing' },
    })
    expect((await reqRow(id))?.status).toBe('done')
    // オーナーだけの遷移も agent は不可
    const open = await insertRequest('open')
    expect((await patch(open, { status: 'triaged' })).status).toBe(409)
    expect((await patch(open, { status: 'done' })).status).toBe(409)
  })

  it('needs_info は question 必須、入れると question が入り前の reply が消える', async () => {
    const id = await insertRequest('processing', '前の返信')
    expect(await patch(id, { status: 'needs_info' })).toEqual({
      status: 400,
      body: { error: 'question_required' },
    })
    expect(await patch(id, { status: 'needs_info', question: '  ' })).toEqual({
      status: 400,
      body: { error: 'question_required' },
    })
    expect((await reqRow(id))?.status).toBe('processing')
    const r = await patch(id, { status: 'needs_info', question: '公演の URL はありますか？' })
    expect(r.status).toBe(200)
    expect(await reqRow(id)).toMatchObject({
      status: 'needs_info',
      question: '公演の URL はありますか？',
      reply: null,
    })
  })

  it('不正な status は 400 invalid_status、無い id は 404 not_found', async () => {
    const id = await insertRequest('open')
    expect((await patch(id, { status: 'nope' })).body).toEqual({ error: 'invalid_status' })
    expect((await patch(id, {})).body).toEqual({ error: 'invalid_status' })
    expect(await patch('nope', { status: 'processing' })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
  })
})

describe('リクエストの読み取り', () => {
  it('既定は triaged だけを古い順。requester 系・triage_note・agent_note を返さない', async () => {
    const a = await insertRequest('triaged')
    const b = await insertRequest('triaged')
    const open = await insertRequest('open')
    const r = await get('/api/agent/requests')
    expect(r.status).toBe(200)
    const items = r.body.items as Record<string, unknown>[]
    expect(items.every((i) => i.status === 'triaged')).toBe(true)
    const ids = items.map((i) => i.id)
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b))
    expect(ids).not.toContain(open)
    expect(Object.keys(items[0]).sort()).toEqual(
      ['created_at', 'id', 'kind', 'payload', 'question', 'reply', 'status', 'updated_at'].sort(),
    )
    const text = JSON.stringify(r.body)
    expect(text).not.toContain('requester')
    expect(text).not.toContain(member.userId)
    expect(text).not.toContain('オーナーのメモ')
  })

  it('status はカンマ区切り、limit で件数を絞る、不正値は 400', async () => {
    await insertRequest('open')
    await insertRequest('triaged')
    const r = await get('/api/agent/requests?status=open,triaged&limit=1')
    expect((r.body.items as unknown[]).length).toBe(1)
    const both = await get('/api/agent/requests?status=open,triaged')
    const statuses = new Set((both.body.items as { status: string }[]).map((i) => i.status))
    expect([...statuses].sort()).toEqual(['open', 'triaged'])
    expect(await get('/api/agent/requests?status=open,bad')).toEqual({
      status: 400,
      body: { error: 'invalid_status' },
    })
  })

  it('1 件の取得は同じ形、無い id は 404 not_found', async () => {
    const id = await insertRequest('open')
    const r = await get(`/api/agent/requests/${id}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      id,
      kind: 'new_work',
      status: 'open',
      payload: { title: `依頼 ${id}` },
    })
    expect(JSON.stringify(r.body)).not.toContain('requester')
    expect(await get('/api/agent/requests/nope')).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
  })
})

describe('マスタの行', () => {
  it('work に aliases・runs が付き、note は返さない', async () => {
    const workId = await insertWork(env, { title: '行の作品', kind: 'hall' })
    await insertWorkAlias(env, { workId, title: '行の作品 別名', kind: 'alt_spelling' })
    const runId = await insertRun(env, { workId, channel: 'performance' })
    await env.DB.prepare("UPDATE run SET note = '回のメモ' WHERE id = ?").bind(runId).run()
    const r = await get(`/api/agent/rows/work/${workId}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: workId, title: '行の作品', title_norm: expect.any(String) })
    expect(r.body.merged_into_id).toBeNull()
    const aliases = r.body.aliases as Record<string, unknown>[]
    expect(aliases).toHaveLength(1)
    expect(aliases[0]).toMatchObject({ work_id: workId, title: '行の作品 別名' })
    const runs = r.body.runs as Record<string, unknown>[]
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ id: runId, work_id: workId, channel: 'performance' })
    expect(runs[0]).not.toHaveProperty('note')
    expect(JSON.stringify(r.body)).not.toContain('回のメモ')
  })

  it('organization・run の行から note を除く', async () => {
    const orgId = await insertOrg(env, { name: '行の団体', note: '団体のメモ' })
    const o = await get(`/api/agent/rows/organization/${orgId}`)
    expect(o.status).toBe(200)
    expect(o.body).toMatchObject({ id: orgId, name: '行の団体', name_norm: expect.any(String) })
    expect(o.body).not.toHaveProperty('note')
    const workId = await insertWork(env, { title: '回の作品' })
    const runId = await insertRun(env, { workId, channel: 'performance' })
    await env.DB.prepare("UPDATE run SET note = 'メモ' WHERE id = ?").bind(runId).run()
    const r = await get(`/api/agent/rows/run/${runId}`)
    expect(r.body).toMatchObject({ id: runId, work_id: workId })
    expect(r.body).not.toHaveProperty('note')
  })

  it('統合済みも merged_into_id 入りで返す', async () => {
    const into = await insertWork(env, { title: '統合先' })
    const from = await insertWork(env, { title: '統合元', mergedIntoId: into })
    const r = await get(`/api/agent/rows/work/${from}`)
    expect(r.status).toBe(200)
    expect(r.body.merged_into_id).toBe(into)
  })

  it('table 不正は 400 invalid_table、無い id は 404', async () => {
    expect(await get('/api/agent/rows/attempt/x')).toEqual({
      status: 400,
      body: { error: 'invalid_table' },
    })
    expect(await get('/api/agent/rows/user/x')).toEqual({
      status: 400,
      body: { error: 'invalid_table' },
    })
    expect(await get('/api/agent/rows/work/nope')).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
  })
})

// next をたどって全部集める
const collect = async (base: string, limit: number) => {
  const all: Record<string, unknown>[] = []
  let after = ''
  let pages = 0
  for (;;) {
    const r = await get(`${base}&limit=${limit}${after ? `&after=${after}` : ''}`)
    expect(r.status).toBe(200)
    const items = r.body.items as Record<string, unknown>[]
    expect(items.length).toBeLessThanOrEqual(limit)
    all.push(...items)
    pages++
    if (r.body.next === null) break
    expect(r.body.next).toBe(items.at(-1)?.id)
    after = r.body.next as string
  }
  return { all, pages }
}

describe('名寄せ用の一覧', () => {
  it('venue: 3 件・limit=2 で next が付き、2 回で全部。統合済みは出ない', async () => {
    const ids = [
      await insertVenue(env, { name: '会場 A', prefecture: '東京都' }),
      await insertVenue(env, { name: '会場 B' }),
      await insertVenue(env, { name: '会場 C' }),
    ]
    await insertVenue(env, { name: '会場 統合済み', mergedIntoId: ids[0] })
    const first = await get('/api/agent/index/venue?limit=2')
    expect(first.body.next).toBe(ids[1])
    expect(first.body.items).toEqual([
      { id: ids[0], name: '会場 A', name_norm: expect.any(String), prefecture: '東京都' },
      { id: ids[1], name: '会場 B', name_norm: expect.any(String), prefecture: null },
    ])
    const second = await get(`/api/agent/index/venue?limit=2&after=${ids[1]}`)
    expect(second.body).toEqual({
      items: [{ id: ids[2], name: '会場 C', name_norm: expect.any(String), prefecture: null }],
      next: null,
    })
  })

  it('work: name と alias。id 昇順、統合済みの作品とその別名は出ない', async () => {
    const orgId = await insertOrg(env, { name: '一覧の団体' })
    const live = await insertWork(env, { title: '一覧の作品', orgId })
    const merged = await insertWork(env, { title: '一覧の統合済み', mergedIntoId: live })
    const aliasId = await insertWorkAlias(env, {
      workId: live,
      title: '一覧の別名',
      kind: 'alt_spelling',
    })
    await insertWorkAlias(env, { workId: merged, title: '統合済みの別名', kind: 'alt_spelling' })

    const names = await collect('/api/agent/index/work?part=name', 2)
    const ids = names.all.map((i) => i.id as string)
    expect(ids).toEqual([...ids].sort())
    expect(names.all).toContainEqual({
      id: live,
      work_id: live,
      title: '一覧の作品',
      title_norm: expect.any(String),
      org_id: orgId,
    })
    expect(ids).not.toContain(merged)

    const aliases = await collect('/api/agent/index/work?part=alias', 1000)
    expect(aliases.all).toContainEqual({
      id: aliasId,
      work_id: live,
      title: '一覧の別名',
      title_norm: expect.any(String),
      org_id: orgId,
    })
    expect(aliases.all.map((i) => i.title)).not.toContain('統合済みの別名')
  })

  it('organization: name と alias、統合済みは出ない', async () => {
    const live = await insertOrg(env, { name: '一覧の生きた団体' })
    const merged = await insertOrg(env, { name: '一覧の統合済み団体', mergedIntoId: live })
    await insertOrgAlias(env, {
      organizationId: live,
      name: '生きた団体の旧名',
      kind: 'former_name',
    })
    await insertOrgAlias(env, {
      organizationId: merged,
      name: '統合済み団体の旧名',
      kind: 'former_name',
    })
    const names = await collect('/api/agent/index/organization?part=name', 3)
    expect(names.all).toContainEqual({
      id: live,
      organization_id: live,
      name: '一覧の生きた団体',
      name_norm: expect.any(String),
    })
    expect(names.all.map((i) => i.id)).not.toContain(merged)
    const aliases = await collect('/api/agent/index/organization?part=alias', 1000)
    expect(aliases.all).toContainEqual({
      id: expect.any(String),
      organization_id: live,
      name: '生きた団体の旧名',
      name_norm: expect.any(String),
    })
    expect(aliases.all.map((i) => i.name)).not.toContain('統合済み団体の旧名')
  })

  it('table / part 不正は 400', async () => {
    expect(await get('/api/agent/index/run')).toEqual({
      status: 400,
      body: { error: 'invalid_table' },
    })
    expect(await get('/api/agent/index/venue?part=alias')).toEqual({
      status: 400,
      body: { error: 'invalid_part' },
    })
    expect(await get('/api/agent/index/work?part=x')).toEqual({
      status: 400,
      body: { error: 'invalid_part' },
    })
  })
})

describe('名寄せ候補', () => {
  it('/api/admin/match と同じ形（完全一致のみ）', async () => {
    const workId = await insertWork(env, { title: '候補の作品' })
    const r = await get(`/api/agent/match?title=${encodeURIComponent('候補の作品')}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ titleNorm: expect.any(String), orgNorm: null })
    expect((r.body.works as { id: string }[]).map((w) => w.id)).toContain(workId)
    expect(JSON.stringify(r.body)).not.toContain('similar')
    expect(await get('/api/agent/match')).toEqual({
      status: 400,
      body: { error: 'title_or_url_required' },
    })
  })

  it('cookie だけ（Bearer 無し）は 401', async () => {
    const res = await app.request(
      '/api/agent/match?title=x',
      { headers: { Cookie: member.cookie } },
      env,
    )
    expect(res.status).toBe(401)
  })
})
