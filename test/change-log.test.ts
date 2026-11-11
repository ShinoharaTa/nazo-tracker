import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { columnRow, logChange } from '../src/db/change-log'
import { createDb } from '../src/db/client'
import { getRunRow } from '../src/db/master'
import { relinkRunStmts, runStmts } from '../src/db/master-write'
import { organizationAlias, shop } from '../src/db/schema'
import { loginAs } from './helpers/auth'
import { insertRun, insertWork } from './helpers/master'

describe('columnRow', () => {
  it('DB 列名（snake_case）をキーにした行全体。無い列は null', () => {
    expect(
      columnRow(organizationAlias, { id: 'a1', organizationId: 'o1', name: 'X', kind: 'label' }),
    ).toEqual({
      id: 'a1',
      organization_id: 'o1',
      name: 'X',
      name_norm: null,
      kind: 'label',
      since: null,
      until: null,
    })
  })
})

describe('logChange', () => {
  it('change_log 1 行を組み立てる（actor_token_id / proposal_id は NULL）', async () => {
    const { userId } = await loginAs(env, { subject: 'cl-owner', owner: true })
    const db = createDb(env.DB)
    const after = { id: 's1', name: '店', kind: 'other', url: null, organizationId: null }
    await logChange(db, {
      table: shop,
      rowId: 's1',
      action: 'create',
      before: null,
      after,
      actor: { userId },
    })
    const row = await env.DB.prepare("SELECT * FROM change_log WHERE row_id = 's1'").first<
      Record<string, string | null>
    >()
    expect(row).toMatchObject({
      table_name: 'shop',
      action: 'create',
      before_json: null,
      actor_user_id: userId,
      actor_token_id: null,
      proposal_id: null,
    })
    expect(JSON.parse(row?.after_json ?? '')).toEqual({
      id: 's1',
      name: '店',
      kind: 'other',
      url: null,
      organization_id: null,
    })
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// agent トークンと提案の行（change_log の FK 先）を直接入れる
const insertTokenAndProposal = async (tag: string) => {
  const now = '2026-01-01T00:00:00.000Z'
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO api_token (id, name, token_hash, role, created_at) VALUES (?, ?, ?, 'agent', ?)",
    ).bind(`tok-${tag}`, tag, `hash-${tag}`, now),
    env.DB.prepare(
      "INSERT INTO proposal (id, kind, target_table, fingerprint, created_by_token_id, created_at) VALUES (?, 'update', 'run', ?, ?, ?)",
    ).bind(`prop-${tag}`, `fp-${tag}`, `tok-${tag}`, now),
  ])
  return { tokenId: `tok-${tag}`, proposalId: `prop-${tag}` }
}

describe('logChange（トークン）', () => {
  it('actor が tokenId なら actor_token_id が入り actor_user_id は NULL。proposalId も入る', async () => {
    const { tokenId, proposalId } = await insertTokenAndProposal('cl')
    const db = createDb(env.DB)
    const after = { id: 's2', name: '店', kind: 'other', url: null, organizationId: null }
    await logChange(db, {
      table: shop,
      rowId: 's2',
      action: 'create',
      before: null,
      after,
      actor: { tokenId },
      proposalId,
    })
    const row = await env.DB.prepare("SELECT * FROM change_log WHERE row_id = 's2'").first<
      Record<string, string | null>
    >()
    expect(row).toMatchObject({
      actor_user_id: null,
      actor_token_id: tokenId,
      proposal_id: proposalId,
    })
  })
})

describe('relinkRunStmts', () => {
  it('run の work_id を付け替え、change_log に update を 1 行書く', async () => {
    const { tokenId, proposalId } = await insertTokenAndProposal('relink')
    const w1 = await insertWork(env, { title: '付け替え元' })
    const w2 = await insertWork(env, { title: '付け替え先' })
    const runId = await insertRun(env, { workId: w1, channel: 'online' })
    const db = createDb(env.DB)
    const before = await getRunRow(db, runId)
    if (!before) throw new Error('run が無い')
    const s = relinkRunStmts(db, before, w2, { actor: { tokenId }, proposalId })
    expect(s.id).toBe(runId)
    await runStmts(db, s.stmts)

    expect((await getRunRow(db, runId))?.workId).toBe(w2)
    const { results } = await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ?')
      .bind(runId)
      .all<Record<string, string | null>>()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      table_name: 'run',
      action: 'update',
      actor_user_id: null,
      actor_token_id: tokenId,
      proposal_id: proposalId,
    })
    expect(JSON.parse(results[0]?.before_json ?? '').work_id).toBe(w1)
    expect(JSON.parse(results[0]?.after_json ?? '').work_id).toBe(w2)
  })
})
