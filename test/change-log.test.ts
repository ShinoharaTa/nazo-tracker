import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { columnRow, logChange } from '../src/db/change-log'
import { createDb } from '../src/db/client'
import { organizationAlias, shop } from '../src/db/schema'
import { loginAs } from './helpers/auth'

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
      actorUserId: userId,
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
