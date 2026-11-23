// リクエスト（request）の読み書き（docs/agent-pipeline.md §2）。
// 依頼者用の関数は必ず requester_user_id = viewerId で絞る（他人の行は「無い」と同じに扱う）。
// 記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, asc, count, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm'
import { ulid } from '../lib/id'
import { addDays, nowIso } from '../lib/time'
import { canTransition, type RequestActor } from '../requests/transitions'
import { DELETED_DISPLAY_NAME, type RequestKind, type RequestStatus } from '../ui/labels'
import type { Db } from './client'
import { PAGE_SIZE } from './master'
import { request, user, work } from './schema'

// payload_json の形。キーは値があるものだけ
export type RequestPayload = {
  url?: string
  title?: string
  organization?: string
  note?: string
  target_id?: string
}

const payloadKeys = ['url', 'title', 'organization', 'note', 'target_id'] as const

// 文字列のキーだけ拾う。壊れた JSON は空
export const parsePayload = (json: string): RequestPayload => {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return {}
  }
  if (!v || typeof v !== 'object') return {}
  const out: RequestPayload = {}
  for (const k of payloadKeys) {
    const x = (v as Record<string, unknown>)[k]
    if (typeof x === 'string') out[k] = x
  }
  return out
}

// 依頼者に見せる列だけ（triage_note / agent_note は持たない）
export type OwnRequest = {
  id: string
  kind: RequestKind
  payload: RequestPayload
  status: RequestStatus
  question: string | null
  reply: string | null
  createdAt: string
  updatedAt: string
}

const ownCols = {
  id: request.id,
  kind: request.kind,
  payloadJson: request.payloadJson,
  status: request.status,
  question: request.question,
  reply: request.reply,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt,
}

const toOwn = ({ payloadJson, ...r }: { payloadJson: string } & Omit<OwnRequest, 'payload'>) => ({
  ...r,
  payload: parsePayload(payloadJson),
})

export const createRequest = async (
  db: Db,
  userId: string,
  kind: RequestKind,
  payload: RequestPayload,
): Promise<string> => {
  const id = ulid()
  const now = nowIso()
  await db.insert(request).values({
    id,
    requesterUserId: userId,
    kind,
    payloadJson: JSON.stringify(payload),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  })
  return id
}

// 直近 24 時間に本人が作った件数（INDEX(requester_user_id, created_at) を使う）
export const countRecentRequests = async (db: Db, userId: string): Promise<number> => {
  const row = await db
    .select({ n: count() })
    .from(request)
    .where(and(eq(request.requesterUserId, userId), gt(request.createdAt, addDays(nowIso(), -1))))
    .get()
  return row?.n ?? 0
}

// 本人の未完了（done / rejected 以外）に同じ URL があるか
export const hasOpenRequestWithUrl = async (
  db: Db,
  userId: string,
  url: string,
): Promise<boolean> => {
  const row = await db
    .select({ id: request.id })
    .from(request)
    .where(
      and(
        eq(request.requesterUserId, userId),
        notInArray(request.status, ['done', 'rejected']),
        sql`json_extract(${request.payloadJson}, '$.url') = ${url}`,
      ),
    )
    .limit(1)
    .get()
  return !!row
}

// 新しい順、50 件ずつ
export const listOwnRequests = async (
  db: Db,
  viewerId: string,
  page: number,
): Promise<{ items: OwnRequest[]; hasNext: boolean }> => {
  const rows = await db
    .select(ownCols)
    .from(request)
    .where(eq(request.requesterUserId, viewerId))
    .orderBy(desc(request.createdAt), desc(request.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return { items: rows.slice(0, PAGE_SIZE).map(toOwn), hasNext: rows.length > PAGE_SIZE }
}

export const getOwnRequest = async (
  db: Db,
  viewerId: string,
  id: string,
): Promise<OwnRequest | null> => {
  const row = await db
    .select(ownCols)
    .from(request)
    .where(and(eq(request.id, id), eq(request.requesterUserId, viewerId)))
    .get()
  return row ? toOwn(row) : null
}

// needs_info のときだけ reply を保存して open に戻す。他人・無い id は not_found、それ以外の状態は invalid_state
export const replyOwnRequest = async (
  db: Db,
  viewerId: string,
  id: string,
  text: string,
): Promise<'ok' | 'not_found' | 'invalid_state'> => {
  const updated = await db
    .update(request)
    .set({ reply: text, status: 'open', updatedAt: nowIso() })
    .where(
      and(
        eq(request.id, id),
        eq(request.requesterUserId, viewerId),
        eq(request.status, 'needs_info'),
      ),
    )
    .returning({ id: request.id })
  if (updated.length) return 'ok'
  return (await getOwnRequest(db, viewerId, id)) ? 'invalid_state' : 'not_found'
}

// fix_work の対象。live = 未統合のときだけ true（投稿の検証用）。表示には統合済みでも題名を返す
export const workTitleOf = async (
  db: Db,
  id: string,
): Promise<{ id: string; title: string; live: boolean } | null> => {
  const row = await db
    .select({ id: work.id, title: work.title, mergedIntoId: work.mergedIntoId })
    .from(work)
    .where(eq(work.id, id))
    .get()
  return row ? { id: row.id, title: row.title, live: row.mergedIntoId === null } : null
}

// ---- オーナー用（依頼者で絞らない）。依頼者は user から display_name だけを引く（記録は読まない）

// 一覧のタブ。closed = done + rejected
export const adminRequestTabs = [
  'open',
  'triaged',
  'processing',
  'needs_info',
  'proposed',
  'closed',
] as const
export type AdminRequestTab = (typeof adminRequestTabs)[number]

const tabStatuses = (tab: AdminRequestTab): RequestStatus[] =>
  tab === 'closed' ? ['done', 'rejected'] : [tab]

export type AdminRequestRow = {
  id: string
  kind: RequestKind
  payload: RequestPayload
  status: RequestStatus
  requesterName: string
  createdAt: string
}

export type AdminRequest = OwnRequest & {
  requesterName: string
  triageNote: string | null
  agentNote: string | null
}

// 退会済み（requester_user_id = NULL）は「退会したユーザー」
const requesterName = (name: string | null): string => name ?? DELETED_DISPLAY_NAME

// 完了・見送りは新しい順、それ以外（処理待ち）は古い順。50 件ずつ
export const listRequests = async (
  db: Db,
  { status, page }: { status: AdminRequestTab; page: number },
): Promise<{ items: AdminRequestRow[]; hasNext: boolean }> => {
  const order =
    status === 'closed'
      ? [desc(request.createdAt), desc(request.id)]
      : [asc(request.createdAt), asc(request.id)]
  const rows = await db
    .select({
      id: request.id,
      kind: request.kind,
      payloadJson: request.payloadJson,
      status: request.status,
      displayName: user.displayName,
      createdAt: request.createdAt,
    })
    .from(request)
    .leftJoin(user, eq(user.id, request.requesterUserId))
    .where(inArray(request.status, tabStatuses(status)))
    .orderBy(...order)
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return {
    items: rows.slice(0, PAGE_SIZE).map(({ payloadJson, displayName, ...r }) => ({
      ...r,
      payload: parsePayload(payloadJson),
      requesterName: requesterName(displayName),
    })),
    hasNext: rows.length > PAGE_SIZE,
  }
}

export const countRequests = async (db: Db, status: RequestStatus): Promise<number> => {
  const row = await db.select({ n: count() }).from(request).where(eq(request.status, status)).get()
  return row?.n ?? 0
}

export const getRequest = async (db: Db, id: string): Promise<AdminRequest | null> => {
  const row = await db
    .select({
      ...ownCols,
      triageNote: request.triageNote,
      agentNote: request.agentNote,
      displayName: user.displayName,
    })
    .from(request)
    .leftJoin(user, eq(user.id, request.requesterUserId))
    .where(eq(request.id, id))
    .get()
  if (!row) return null
  const { displayName, triageNote, agentNote, ...own } = row
  return { ...toOwn(own), requesterName: requesterName(displayName), triageNote, agentNote }
}

// 状態を変える。遷移は canTransition で判定し、読んでから書くまでに状態が変わっていれば invalid_transition。
// note はオーナーなら triaged / rejected の triage_note、agent なら agent_note（どちらも空なら今の値のまま）。
// question は needs_info の質問。
// needs_info にするときは元の状態に関係なく前の reply を消す（古い返信が新しい質問への答えに見えないように）
export const setRequestStatus = async (
  db: Db,
  id: string,
  to: RequestStatus,
  { note, question }: { note?: string | null; question?: string | null },
  by: Extract<RequestActor, 'owner' | 'agent'>,
): Promise<'ok' | 'not_found' | 'invalid_transition'> => {
  const cur = await db
    .select({ status: request.status })
    .from(request)
    .where(eq(request.id, id))
    .get()
  if (!cur) return 'not_found'
  if (!canTransition(cur.status, to, by)) return 'invalid_transition'
  const set: Partial<typeof request.$inferInsert> = { status: to, updatedAt: nowIso() }
  if (by === 'owner' && (to === 'triaged' || to === 'rejected') && note) set.triageNote = note
  if (by === 'agent' && note) set.agentNote = note
  if (to === 'needs_info') {
    set.question = question ?? null
    set.reply = null
  }
  const updated = await db
    .update(request)
    .set(set)
    .where(and(eq(request.id, id), eq(request.status, cur.status)))
    .returning({ id: request.id })
  return updated.length ? 'ok' : 'invalid_transition'
}

// ---- agent 用（/api/agent/requests）。依頼者の id・表示名は持たない（依頼者用と同じ列だけ）

// 指定した状態のものを古い順に
export const listAgentRequests = async (
  db: Db,
  statuses: RequestStatus[],
  limit: number,
): Promise<OwnRequest[]> =>
  (
    await db
      .select(ownCols)
      .from(request)
      .where(inArray(request.status, statuses))
      .orderBy(asc(request.createdAt), asc(request.id))
      .limit(limit)
  ).map(toOwn)

export const getAgentRequest = async (db: Db, id: string): Promise<OwnRequest | null> => {
  const row = await db.select(ownCols).from(request).where(eq(request.id, id)).get()
  return row ? toOwn(row) : null
}
