// 出典（source）・提案（proposal / proposal_field）・却下記憶（rejection_memory）の読み書き（docs/agent-pipeline.md §4・§5）。
// マスタは読むだけ（反映は PR-9 以降）。記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import type { ProposalDraft, ProposalTable } from '../pipeline/fields'
import { columnRow, logChange, type WriteCtx } from './change-log'
import type { Db } from './client'
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

// 対象の行（DB 列名キー）。無ければ null
export const getTargetRow = async (
  db: Db,
  table: ProposalTable,
  id: string,
): Promise<Record<string, unknown> | null> => {
  const t = tables[table]
  const row = await db.select().from(t).where(eq(t.id, id)).get()
  return row ? columnRow(t, row) : null
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

// 提案 1 件の文: 同じ対象の pending を superseded（update / link / merge のとき）→ proposal → proposal_field×n。
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
  stmts.push(
    db.insert(proposal).values(row),
    db.insert(proposalField).values(
      d.items.map((i, n) => ({
        id: ulid(),
        proposalId: id,
        field: i.field,
        oldValue: p.oldValues[n],
        newValue: i.newValue,
        sourceId: i.sourceId,
        confidence: i.confidence,
      })),
    ),
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

// リクエストに紐付く提案を古い順に
export const listProposalsByRequest = (db: Db, requestId: string) =>
  db
    .select(listCols)
    .from(proposal)
    .where(eq(proposal.requestId, requestId))
    .orderBy(asc(proposal.createdAt), asc(proposal.id))

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
