// 名寄せ候補の取得（docs/data-model.md §5）。マスタだけを読む。
// Workers では完全一致（escape_id_url / 同団体の題名 / 題名 / 団体名）まで。類似度（Dice）は CLI（P5）が計算する。
// 記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm'
import { type Candidate, hasUserinfo, normalizeMatchUrl, rankCandidates } from '../lib/match'
import { norm } from '../lib/norm'
import type { Db } from './client'
import { organization, organizationAlias, run, work, workAlias } from './schema'

// 統合済みの鎖をたどる上限（src/db/master.ts と同じ）。超えたら候補にしない
const MERGE_HOPS = 5

export type MatchResult = {
  titleNorm: string | null
  orgNorm: string | null
  works: Candidate[]
  organizations: Candidate[]
}

type MergeRow = { id: string; name: string; mergedIntoId: string | null }

// 統合済みなら統合先へ。鎖が切れている・長すぎるときは null
const resolveChain = async (
  fetch: (id: string) => Promise<MergeRow | undefined>,
  id: string,
): Promise<MergeRow | null> => {
  let next = id
  for (let i = 0; i <= MERGE_HOPS; i++) {
    const row = await fetch(next)
    if (!row) return null
    if (row.mergedIntoId === null) return row
    next = row.mergedIntoId
  }
  return null
}

const fetchOrg = (db: Db) => (id: string) =>
  db
    .select({
      id: organization.id,
      name: organization.name,
      mergedIntoId: organization.mergedIntoId,
    })
    .from(organization)
    .where(eq(organization.id, id))
    .get()

const fetchWork = (db: Db) => (id: string) =>
  db
    .select({ id: work.id, name: work.title, mergedIntoId: work.mergedIntoId })
    .from(work)
    .where(eq(work.id, id))
    .get()

const workColumns = {
  id: work.id,
  title: work.title,
  orgId: organization.id,
  orgName: organization.name,
}

type WorkRow = { id: string; title: string; orgId: string | null; orgName: string | null }

const toCandidate = (
  w: WorkRow,
  score: number,
  reason: string,
  via: Candidate['via'],
): Candidate => ({
  id: w.id,
  name: w.title,
  score,
  reason,
  via,
  ...(w.orgId && w.orgName ? { organization: { id: w.orgId, name: w.orgName } } : {}),
})

// 1. escape_id_url が一致する run の作品
const byEscapeIdUrl = async (db: Db, url: string): Promise<Candidate[]> => {
  const r = await db
    .select({ id: run.id, workId: run.workId })
    .from(run)
    .where(eq(run.escapeIdUrl, url))
    .get()
  if (!r) return []
  const w = await resolveChain(fetchWork(db), r.workId)
  if (!w) return []
  const row = await db
    .select(workColumns)
    .from(work)
    .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
    .where(eq(work.id, w.id))
    .get()
  if (!row) return []
  return [{ ...toCandidate(row, 1, 'escape_id_url', 'name'), runId: r.id }]
}

// title_norm（作品名・別名）が tn と一致する未統合の作品。scope で団体などに絞る
const byTitleNorm = async (
  db: Db,
  tn: string,
  scope: SQL | undefined,
  score: number,
  reason: string,
): Promise<Candidate[]> => {
  const [names, aliases] = await Promise.all([
    db
      .select(workColumns)
      .from(work)
      .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
      .where(and(isNull(work.mergedIntoId), eq(work.titleNorm, tn), scope)),
    db
      .select(workColumns)
      .from(workAlias)
      .innerJoin(work, eq(work.id, workAlias.workId))
      .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
      .where(and(isNull(work.mergedIntoId), eq(workAlias.titleNorm, tn), scope)),
  ])
  return [
    ...names.map((w) => toCandidate(w, score, reason, 'name')),
    ...aliases.map((w) => toCandidate(w, score, reason, 'alias')),
  ]
}

// name_norm（団体名・別名）が on と完全一致する団体。統合済みは統合先へ解決する
const orgsByNameNorm = async (
  db: Db,
  on: string,
): Promise<{ org: MergeRow; via: Candidate['via'] }[]> => {
  const [names, aliases] = await Promise.all([
    db.select({ id: organization.id }).from(organization).where(eq(organization.nameNorm, on)),
    db
      .select({ id: organizationAlias.organizationId })
      .from(organizationAlias)
      .where(eq(organizationAlias.nameNorm, on)),
  ])
  const hits = [
    ...names.map((r) => ({ id: r.id, via: 'name' as const })),
    ...aliases.map((r) => ({ id: r.id, via: 'alias' as const })),
  ]
  const out: { org: MergeRow; via: Candidate['via'] }[] = []
  for (const h of hits) {
    const org = await resolveChain(fetchOrg(db), h.id)
    if (org) out.push({ org, via: h.via })
  }
  return out
}

// 候補を返す。title / org / url は生の入力（空白だけなら無いものとして扱う）。
// url は呼び出し側で normalizeMatchUrl が通ることを確かめておく（通らなければここでは一致を見ない）
export const findCandidates = async (
  db: Db,
  input: { title?: string; org?: string; url?: string },
): Promise<MatchResult> => {
  const title = input.title?.trim() || null
  const orgName = input.org?.trim() || null
  const rawUrl = input.url?.trim() ?? ''
  // userinfo 付きの URL は登録されることが無いので一致を見ない
  const url = rawUrl && !hasUserinfo(rawUrl) ? normalizeMatchUrl(rawUrl) : null
  const tn = title ? norm(title) : null
  const on = orgName ? norm(orgName) : null

  const works: Candidate[] = []
  const organizations: Candidate[] = []

  if (url) works.push(...(await byEscapeIdUrl(db, url)))

  const orgHits = on ? await orgsByNameNorm(db, on) : []
  for (const h of orgHits) {
    organizations.push({ id: h.org.id, name: h.org.name, score: 1, reason: 'name', via: h.via })
  }

  if (tn) {
    const orgIds = [...new Set(orgHits.map((h) => h.org.id))]
    if (orgIds.length > 0) {
      // 団体の作品 = primary がその団体か、その団体名義の run を持つ作品（団体ページと同じ）
      const ofOrgs = or(
        inArray(work.primaryOrganizationId, orgIds),
        inArray(
          work.id,
          db.select({ id: run.workId }).from(run).where(inArray(run.organizationId, orgIds)),
        ),
      )
      works.push(...(await byTitleNorm(db, tn, ofOrgs, 0.95, 'same_org_title')))
    }
    works.push(...(await byTitleNorm(db, tn, undefined, 0.85, 'title')))
  }

  return {
    titleNorm: tn,
    orgNorm: on,
    works: rankCandidates(works),
    organizations: rankCandidates(organizations),
  }
}
