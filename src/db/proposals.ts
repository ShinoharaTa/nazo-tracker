// 出典（source）・提案（proposal / proposal_field）・却下記憶（rejection_memory）の読み書き（docs/agent-pipeline.md §4・§5）。
// マスタは読むだけ（承認での反映の文は src/pipeline/apply.ts）。記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import { nameColumn, type ProposalDraft, type ProposalTable } from '../pipeline/fields'
import { columnRow, logChange, type WriteCtx } from './change-log'
import type { Db } from './client'
import { PAGE_SIZE } from './master'
import type { Stmts } from './master-write'
import {
  organization,
  proposal,
  proposalField,
  rejectionMemory,
  run,
  shop,
  source,
  venue,
  work,
} from './schema'

// ---------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------

export type SourceInput = Omit<typeof source.$inferInsert, 'id'>

export const createSource = async (db: Db, input: SourceInput): Promise<string> => {
  const id = ulid()
  await db.insert(source).values({ id, ...input })
  return id
}

// ids のうち存在する source の id
export const existingSourceIds = async (db: Db, ids: string[]): Promise<Set<string>> => {
  if (ids.length === 0) return new Set()
  const rows = await db.select({ id: source.id }).from(source).where(inArray(source.id, ids))
  return new Set(rows.map((r) => r.id))
}

// ---------------------------------------------------------------------------
// 提案の対象・参照先（マスタの読み取り）
// ---------------------------------------------------------------------------

const tables = { work, run, organization, venue, shop }

// 対象の行（drizzle の行のまま）。無ければ null
export const getRawRow = async (
  db: Db,
  table: ProposalTable,
  id: string,
): Promise<Record<string, unknown> | null> => {
  const t = tables[table]
  return (await db.select().from(t).where(eq(t.id, id)).get()) ?? null
}

// 対象の行（DB 列名キー）。無ければ null
export const getTargetRow = async (
  db: Db,
  table: ProposalTable,
  id: string,
): Promise<Record<string, unknown> | null> => {
  const row = await getRawRow(db, table, id)
  return row ? columnRow(tables[table], row) : null
}

// 未統合で存在する作品・団体・会場か
export const isLiveRow = async (
  db: Db,
  table: 'work' | 'organization' | 'venue',
  id: string,
): Promise<boolean> => {
  const t = tables[table]
  return !!(await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), isNull(t.mergedIntoId)))
    .get())
}

// escape_id_url が一致する回
export const runByEscapeIdUrl = (db: Db, url: string) =>
  db.select({ id: run.id, workId: run.workId }).from(run).where(eq(run.escapeIdUrl, url)).get()

// ---------------------------------------------------------------------------
// proposal
// ---------------------------------------------------------------------------

export const getRejection = (db: Db, fingerprint: string) =>
  db
    .select({ reason: rejectionMemory.reason })
    .from(rejectionMemory)
    .where(eq(rejectionMemory.fingerprint, fingerprint))
    .get()

export const pendingIdByFingerprint = async (
  db: Db,
  fingerprint: string,
): Promise<string | null> => {
  const row = await db
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(eq(proposal.fingerprint, fingerprint), eq(proposal.status, 'pending')))
    .get()
  return row?.id ?? null
}

// リクエストに紐付く pending の提案の件数
export const countPendingForRequest = async (db: Db, requestId: string): Promise<number> =>
  db.$count(proposal, and(eq(proposal.requestId, requestId), eq(proposal.status, 'pending')))

export type NewProposal = {
  draft: ProposalDraft
  oldValues: (string | null)[]
  fingerprint: string
  candidatesJson: string
  tokenId: string
}

// proposal_field の INSERT 1 文あたりの行数。D1 は 1 文の変数が 100 個まで（1 行 7〜8 個）
const FIELD_ROWS_PER_INSERT = 12

// 提案 1 件の文: 同じリクエスト・同じ kind・同じ対象の pending を superseded（update / link / merge のとき）
// → proposal → proposal_field（FIELD_ROWS_PER_INSERT 行ずつ）。
// proposal の作成と置き換えは change_log にも残す（actor = トークン、proposal_id = 新しい提案）
export const createProposalStmts = async (db: Db, p: NewProposal): Promise<Stmts> => {
  const { draft: d } = p
  const id = ulid()
  const ctx: WriteCtx = { actor: { tokenId: p.tokenId }, proposalId: id }
  const now = nowIso()
  const stmts: Stmts['stmts'] = []
  // change_log の proposal_id は新しい提案を指すので、提案の INSERT より後に置く
  const logs: Stmts['stmts'] = []

  if (d.kind !== 'create' && d.targetId) {
    const olds = await db
      .select()
      .from(proposal)
      .where(
        and(
          eq(proposal.targetTable, d.targetTable),
          eq(proposal.targetId, d.targetId),
          eq(proposal.kind, d.kind),
          d.requestId ? eq(proposal.requestId, d.requestId) : isNull(proposal.requestId),
          eq(proposal.status, 'pending'),
        ),
      )
    for (const old of olds) {
      stmts.push(
        db
          .update(proposal)
          .set({ status: 'superseded' })
          .where(and(eq(proposal.id, old.id), eq(proposal.status, 'pending'))),
      )
      logs.push(
        logChange(db, {
          table: proposal,
          rowId: old.id,
          action: 'update',
          before: old,
          after: { ...old, status: 'superseded' },
          ...ctx,
        }),
      )
    }
  }

  const row: typeof proposal.$inferInsert = {
    id,
    requestId: d.requestId,
    kind: d.kind,
    targetTable: d.targetTable,
    targetId: d.targetId,
    confidence: Math.min(...d.items.map((i) => i.confidence)),
    status: 'pending',
    fingerprint: p.fingerprint,
    matchCandidatesJson: p.candidatesJson,
    createdByTokenId: p.tokenId,
    createdAt: now,
  }
  const fieldRows = d.items.map((i, n) => ({
    id: ulid(),
    proposalId: id,
    field: i.field,
    oldValue: p.oldValues[n],
    newValue: i.newValue,
    sourceId: i.sourceId,
    confidence: i.confidence,
  }))
  const fieldInserts: Stmts['stmts'] = []
  for (let n = 0; n < fieldRows.length; n += FIELD_ROWS_PER_INSERT) {
    fieldInserts.push(
      db.insert(proposalField).values(fieldRows.slice(n, n + FIELD_ROWS_PER_INSERT)),
    )
  }
  stmts.push(
    db.insert(proposal).values(row),
    ...fieldInserts,
    logChange(db, {
      table: proposal,
      rowId: id,
      action: 'create',
      before: null,
      after: row,
      ...ctx,
    }),
    ...logs,
  )
  return { id, stmts }
}

const listCols = {
  id: proposal.id,
  kind: proposal.kind,
  target_table: proposal.targetTable,
  target_id: proposal.targetId,
  status: proposal.status,
  created_at: proposal.createdAt,
}

// リクエストに紐付く提案を古い順（created_at, id）に、after（提案の id）より後を limit 件。
// next は続きがあるときの最後の id。after がそのリクエストの提案でなければ 'invalid_after'
export const listProposalsByRequest = async (
  db: Db,
  requestId: string,
  after: string | null,
  limit: number,
): Promise<{ items: { id: string }[]; next: string | null } | 'invalid_after'> => {
  const cur = after
    ? await db
        .select({ id: proposal.id, createdAt: proposal.createdAt })
        .from(proposal)
        .where(and(eq(proposal.id, after), eq(proposal.requestId, requestId)))
        .get()
    : undefined
  if (after && !cur) return 'invalid_after'
  const rows = await db
    .select(listCols)
    .from(proposal)
    .where(
      and(
        eq(proposal.requestId, requestId),
        cur
          ? or(
              gt(proposal.createdAt, cur.createdAt),
              and(eq(proposal.createdAt, cur.createdAt), gt(proposal.id, cur.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(proposal.createdAt), asc(proposal.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit)
  return { items, next: rows.length > limit ? items[items.length - 1].id : null }
}

// 提案 1 件と項目（agent 用。レビューの列は返さない）
export const getProposalWithFields = async (db: Db, id: string) => {
  const p = await db
    .select({
      ...listCols,
      request_id: proposal.requestId,
      confidence: proposal.confidence,
      fingerprint: proposal.fingerprint,
      match_candidates_json: proposal.matchCandidatesJson,
    })
    .from(proposal)
    .where(eq(proposal.id, id))
    .get()
  if (!p) return null
  const fields = await db
    .select({
      id: proposalField.id,
      field: proposalField.field,
      old_value: proposalField.oldValue,
      new_value: proposalField.newValue,
      source_id: proposalField.sourceId,
      confidence: proposalField.confidence,
    })
    .from(proposalField)
    .where(eq(proposalField.proposalId, id))
    .orderBy(asc(proposalField.field))
  const { match_candidates_json, ...rest } = p
  return {
    ...rest,
    match_candidates: match_candidates_json ? JSON.parse(match_candidates_json) : [],
    fields,
  }
}

// ---------------------------------------------------------------------------
// オーナーの承認画面（/admin/proposals*）。マスタは名前を引くだけ（記録・人数は読まない）
// ---------------------------------------------------------------------------

export type ProposalRow = typeof proposal.$inferSelect

export const adminProposalTabs = ['pending', 'auto', 'done'] as const
export type AdminProposalTab = (typeof adminProposalTabs)[number]

const tabStatuses: Record<AdminProposalTab, ProposalRow['status'][]> = {
  pending: ['pending'],
  auto: ['auto_applied'],
  done: ['applied', 'rejected', 'superseded', 'reverted'],
}

// id → 表示名（run は作品の題名）。無い id は入らない
export const namesOf = async (
  db: Db,
  table: ProposalTable,
  ids: readonly string[],
): Promise<Map<string, string>> => {
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return new Map()
  let rows: { id: string; name: string }[]
  if (table === 'run') {
    rows = await db
      .select({ id: run.id, name: work.title })
      .from(run)
      .innerJoin(work, eq(work.id, run.workId))
      .where(inArray(run.id, uniq))
  } else if (table === 'work') {
    rows = await db
      .select({ id: work.id, name: work.title })
      .from(work)
      .where(inArray(work.id, uniq))
  } else {
    const t = tables[table]
    rows = await db.select({ id: t.id, name: t.name }).from(t).where(inArray(t.id, uniq))
  }
  return new Map(rows.map((r) => [r.id, r.name]))
}

export type AdminProposalRow = {
  id: string
  kind: ProposalRow['kind']
  targetTable: string
  status: ProposalRow['status']
  confidence: number | null
  createdAt: string
  // 作る行の名前（create）か、対象の今の名前
  headline: string
  // 出典のドメイン（重複なし）
  domains: string[]
}

const NOT_FOUND_NAME = '（見つかりません）'

type ListCols = Pick<
  ProposalRow,
  'id' | 'kind' | 'targetTable' | 'targetId' | 'status' | 'confidence' | 'createdAt'
>

// 一覧の行に見出しと出典のドメインを付ける
const decorate = async (db: Db, rows: ListCols[]): Promise<AdminProposalRow[]> => {
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return []
  const [nameFields, domainRows] = await Promise.all([
    db
      .select({
        proposalId: proposalField.proposalId,
        field: proposalField.field,
        newValue: proposalField.newValue,
      })
      .from(proposalField)
      .where(
        and(
          inArray(proposalField.proposalId, ids),
          inArray(proposalField.field, [
            'work.title',
            'organization.name',
            'venue.name',
            'shop.name',
            'run.work_id',
          ]),
        ),
      ),
    db
      .selectDistinct({ proposalId: proposalField.proposalId, domain: source.domain })
      .from(proposalField)
      .innerJoin(source, eq(source.id, proposalField.sourceId))
      .where(inArray(proposalField.proposalId, ids)),
  ])
  const fieldValue = (id: string, field: string) =>
    nameFields.find((f) => f.proposalId === id && f.field === field)?.newValue ?? null

  // 名前を引く id を表ごとに集める（create run は run.work_id の作品、create 以外は対象の今の行）
  const want: Record<ProposalTable, string[]> = {
    work: [],
    run: [],
    organization: [],
    venue: [],
    shop: [],
  }
  for (const r of rows) {
    const t = r.targetTable as ProposalTable
    if (!(t in want)) continue
    if (r.kind === 'create') {
      const workId = t === 'run' ? fieldValue(r.id, 'run.work_id') : null
      if (workId) want.work.push(workId)
    } else if (r.targetId) want[t].push(r.targetId)
  }
  const tableKeys = Object.keys(want) as ProposalTable[]
  const maps = await Promise.all(tableKeys.map((t) => namesOf(db, t, want[t])))
  const names = Object.fromEntries(tableKeys.map((t, n) => [t, maps[n]])) as Record<
    ProposalTable,
    Map<string, string>
  >

  return rows.map((r) => {
    const t = r.targetTable as ProposalTable
    let headline: string | null = null
    if (r.kind === 'create') {
      const col = nameColumn[t]
      const workId = col ? null : fieldValue(r.id, 'run.work_id')
      headline = col
        ? fieldValue(r.id, `${t}.${col}`)
        : workId
          ? (names.work.get(workId) ?? null)
          : null
    } else if (r.targetId && names[t]) {
      headline = names[t].get(r.targetId) ?? null
    }
    return {
      id: r.id,
      kind: r.kind,
      targetTable: r.targetTable,
      status: r.status,
      confidence: r.confidence,
      createdAt: r.createdAt,
      headline: headline ?? NOT_FOUND_NAME,
      domains: domainRows.flatMap((d) => (d.proposalId === r.id && d.domain ? [d.domain] : [])),
    }
  })
}

const rowCols = {
  id: proposal.id,
  kind: proposal.kind,
  targetTable: proposal.targetTable,
  targetId: proposal.targetId,
  status: proposal.status,
  confidence: proposal.confidence,
  createdAt: proposal.createdAt,
}

// 承認待ちは古い順、それ以外は新しい順。50 件ずつ
export const listAdminProposals = async (
  db: Db,
  { tab, page }: { tab: AdminProposalTab; page: number },
): Promise<{ items: AdminProposalRow[]; hasNext: boolean }> => {
  const order =
    tab === 'pending'
      ? [asc(proposal.createdAt), asc(proposal.id)]
      : [desc(proposal.createdAt), desc(proposal.id)]
  const rows = await db
    .select(rowCols)
    .from(proposal)
    .where(inArray(proposal.status, tabStatuses[tab]))
    .orderBy(...order)
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return { items: await decorate(db, rows.slice(0, PAGE_SIZE)), hasNext: rows.length > PAGE_SIZE }
}

export const countPendingProposals = (db: Db): Promise<number> =>
  db.$count(proposal, eq(proposal.status, 'pending'))

// 一番古い承認待ち（exceptId 以外）。「次の提案 ›」用
export const nextPendingId = async (db: Db, exceptId: string): Promise<string | null> => {
  const row = await db
    .select({ id: proposal.id })
    .from(proposal)
    .where(and(eq(proposal.status, 'pending'), ne(proposal.id, exceptId)))
    .orderBy(asc(proposal.createdAt), asc(proposal.id))
    .get()
  return row?.id ?? null
}

// リクエストに紐付く提案（古い順、50 件まで）。/admin/requests/:id 用
export const listProposalsOfRequest = async (
  db: Db,
  requestId: string,
): Promise<AdminProposalRow[]> =>
  decorate(
    db,
    await db
      .select(rowCols)
      .from(proposal)
      .where(eq(proposal.requestId, requestId))
      .orderBy(asc(proposal.createdAt), asc(proposal.id))
      .limit(PAGE_SIZE),
  )

export type ProposalSource = {
  url: string
  domain: string | null
  fetchedAt: string | null
  excerpt: string | null
}

export type AdminProposalField = {
  id: string
  field: string
  table: ProposalTable
  column: string
  oldValue: string | null
  newValue: string | null
  sourceId: string | null
  confidence: number | null
  accepted: number | null
  source: ProposalSource | null
}

export const getAdminProposal = async (
  db: Db,
  id: string,
): Promise<{ row: ProposalRow; fields: AdminProposalField[] } | null> => {
  const row = await db.select().from(proposal).where(eq(proposal.id, id)).get()
  if (!row) return null
  const rows = await db
    .select({
      id: proposalField.id,
      field: proposalField.field,
      oldValue: proposalField.oldValue,
      newValue: proposalField.newValue,
      sourceId: proposalField.sourceId,
      confidence: proposalField.confidence,
      accepted: proposalField.accepted,
      url: source.url,
      domain: source.domain,
      fetchedAt: source.fetchedAt,
      excerpt: source.excerpt,
    })
    .from(proposalField)
    .leftJoin(source, eq(source.id, proposalField.sourceId))
    .where(eq(proposalField.proposalId, id))
    .orderBy(asc(proposalField.field), asc(proposalField.id))
  const fields = rows.map(({ url, domain, fetchedAt, excerpt, ...f }) => {
    const [table, column] = f.field.split('.') as [ProposalTable, string]
    return { ...f, table, column, source: url ? { url, domain, fetchedAt, excerpt } : null }
  })
  return { row, fields }
}

// 同じ対象（update / link / merge）の、ほかの承認待ち
export const otherPendingForTarget = async (db: Db, p: ProposalRow): Promise<string[]> => {
  if (!p.targetId) return []
  const rows = await db
    .select({ id: proposal.id })
    .from(proposal)
    .where(
      and(
        eq(proposal.targetTable, p.targetTable),
        eq(proposal.targetId, p.targetId),
        eq(proposal.status, 'pending'),
        ne(proposal.id, p.id),
      ),
    )
    .orderBy(asc(proposal.createdAt), asc(proposal.id))
    .limit(PAGE_SIZE)
  return rows.map((r) => r.id)
}

// 同じ run.escape_id_url で回を作ろうとしている、ほかの承認待ち（どれか 1 件を承認すると、残りは検証で止まる）
export const otherPendingWithEscapeUrl = async (
  db: Db,
  p: ProposalRow,
  url: string,
): Promise<string[]> => {
  const rows = await db
    .select({ id: proposal.id })
    .from(proposalField)
    .innerJoin(proposal, eq(proposal.id, proposalField.proposalId))
    .where(
      and(
        eq(proposalField.field, 'run.escape_id_url'),
        eq(proposalField.newValue, url),
        eq(proposal.status, 'pending'),
        ne(proposal.id, p.id),
      ),
    )
    .orderBy(asc(proposal.createdAt), asc(proposal.id))
    .limit(PAGE_SIZE)
  return rows.map((r) => r.id)
}

export type CandidateView = {
  table: 'work' | 'organization' | 'venue'
  id: string
  name: string
  // 作品の団体
  orgName: string | null
  score: number
  reasons: string[]
}

const candidateTables = ['work', 'organization', 'venue'] as const

// match_candidates_json の候補を DB で確かめる。未統合で存在する行だけを保存された順に返す（同じ行は 1 つにまとめ、
// スコアは大きい方、理由は両方）。名前・理由は表示時に JSX がエスケープする
export const resolveCandidates = async (db: Db, json: string | null): Promise<CandidateView[]> => {
  let raw: unknown
  try {
    raw = json ? JSON.parse(json) : []
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const list = raw.flatMap((c) => {
    if (!c || typeof c !== 'object') return []
    const { table, id, score, reason } = c as Record<string, unknown>
    if (!(candidateTables as readonly unknown[]).includes(table)) return []
    if (typeof id !== 'string' || typeof score !== 'number') return []
    return [
      {
        table: table as CandidateView['table'],
        id,
        score,
        reason: typeof reason === 'string' ? reason : '',
      },
    ]
  })
  const idsOf = (t: CandidateView['table']) => [
    ...new Set(list.filter((c) => c.table === t).map((c) => c.id)),
  ]
  const workIds = idsOf('work')
  const orgIds = idsOf('organization')
  const venueIds = idsOf('venue')
  const [works, orgs, venues] = await Promise.all([
    workIds.length
      ? db
          .select({ id: work.id, name: work.title, orgName: organization.name })
          .from(work)
          .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
          .where(and(inArray(work.id, workIds), isNull(work.mergedIntoId)))
      : [],
    orgIds.length
      ? db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(and(inArray(organization.id, orgIds), isNull(organization.mergedIntoId)))
      : [],
    venueIds.length
      ? db
          .select({ id: venue.id, name: venue.name })
          .from(venue)
          .where(and(inArray(venue.id, venueIds), isNull(venue.mergedIntoId)))
      : [],
  ])
  const live = new Map<string, { name: string; orgName: string | null }>()
  for (const w of works) live.set(`work:${w.id}`, { name: w.name, orgName: w.orgName })
  for (const o of orgs) live.set(`organization:${o.id}`, { name: o.name, orgName: null })
  for (const v of venues) live.set(`venue:${v.id}`, { name: v.name, orgName: null })

  const out = new Map<string, CandidateView>()
  for (const c of list) {
    const key = `${c.table}:${c.id}`
    const row = live.get(key)
    if (!row) continue
    const seen = out.get(key)
    if (seen) {
      seen.score = Math.max(seen.score, c.score)
      if (c.reason && !seen.reasons.includes(c.reason)) seen.reasons.push(c.reason)
      continue
    }
    out.set(key, {
      table: c.table,
      id: c.id,
      ...row,
      score: c.score,
      reasons: c.reason ? [c.reason] : [],
    })
  }
  return [...out.values()]
}

// リクエストから反映された作品（done の依頼者画面の「作品を見る ›」）。新しい反映から順に、作品か回の作品を返す
export const appliedWorkOfRequest = async (db: Db, requestId: string): Promise<string | null> => {
  const rows = await db
    .select({ appliedJson: proposal.appliedJson })
    .from(proposal)
    .where(
      and(eq(proposal.requestId, requestId), inArray(proposal.status, ['applied', 'auto_applied'])),
    )
    .orderBy(desc(proposal.reviewedAt), desc(proposal.id))
    .limit(PAGE_SIZE)
  for (const r of rows) {
    let a: unknown
    try {
      a = JSON.parse(r.appliedJson ?? '{}')
    } catch {
      continue
    }
    if (!a || typeof a !== 'object') continue
    const { work: workId, run: runId } = a as Record<string, unknown>
    if (typeof workId === 'string') {
      const w = await db.select({ id: work.id }).from(work).where(eq(work.id, workId)).get()
      if (w) return w.id
    }
    if (typeof runId === 'string') {
      const x = await db.select({ workId: run.workId }).from(run).where(eq(run.id, runId)).get()
      if (x) return x.workId
    }
  }
  return null
}
