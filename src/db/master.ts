// マスタ（作品・団体・会場・販売先・回）の読み取り。全ユーザー共有なので scopedTo を通さない。
// 記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, desc, eq, exists, inArray, isNull, like, or, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { norm } from '../lib/norm'
import type { Db } from './client'
import {
  organization,
  organizationAlias,
  type organizationAliasKinds,
  run,
  type runChannels,
  shop,
  venue,
  work,
  workAlias,
  type workAliasKinds,
  type workKinds,
} from './schema'

export const PAGE_SIZE = 50
// 統合済みの鎖をたどる上限。超えたら 404
const MERGE_HOPS = 5
const ORG_WORKS_LIMIT = 200

type WorkKind = (typeof workKinds)[number]

export type RunRow = {
  id: string
  channel: (typeof runChannels)[number]
  billedAs: string | null
  startOn: string | null
  endOn: string | null
  isPermanent: number
  escapeIdUrl: string | null
  ticketUrl: string | null
  priceYen: number | null
  org: { id: string; name: string } | null
  venue: { id: string; name: string; prefecture: string | null } | null
  shop: { id: string; name: string; url: string | null } | null
}

export type WorkListItem = {
  id: string
  title: string
  kind: WorkKind | null
  org: { id: string; name: string } | null
  // 代表 run（compareRuns の先頭）。run が無ければ null
  rep: RunRow | null
}

// 代表 run の並び: COALESCE(end_on,'9999-12-31') DESC, COALESCE(start_on,'') DESC, id DESC
// （is_permanent=1 で end_on NULL も end を 9999-12-31 扱い = COALESCE と同じ）
export const compareRuns = (
  a: Pick<RunRow, 'id' | 'startOn' | 'endOn'>,
  b: Pick<RunRow, 'id' | 'startOn' | 'endOn'>,
): number => {
  const cmp = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0)
  return (
    cmp(a.endOn ?? '9999-12-31', b.endOn ?? '9999-12-31') ||
    cmp(a.startOn ?? '', b.startOn ?? '') ||
    cmp(a.id, b.id)
  )
}

const runOrg = alias(organization, 'run_org')

const runColumns = {
  id: run.id,
  workId: run.workId,
  channel: run.channel,
  billedAs: run.billedAs,
  startOn: run.startOn,
  endOn: run.endOn,
  isPermanent: run.isPermanent,
  escapeIdUrl: run.escapeIdUrl,
  ticketUrl: run.ticketUrl,
  priceYen: run.priceYen,
  orgId: runOrg.id,
  orgName: runOrg.name,
  venueId: venue.id,
  venueName: venue.name,
  venuePrefecture: venue.prefecture,
  shopId: shop.id,
  shopName: shop.name,
  shopUrl: shop.url,
}

type RunSelect = Awaited<ReturnType<typeof selectRuns>>[number]

const toRunRow = (r: RunSelect): RunRow => ({
  id: r.id,
  channel: r.channel,
  billedAs: r.billedAs,
  startOn: r.startOn,
  endOn: r.endOn,
  isPermanent: r.isPermanent,
  escapeIdUrl: r.escapeIdUrl,
  ticketUrl: r.ticketUrl,
  priceYen: r.priceYen,
  org: r.orgId && r.orgName ? { id: r.orgId, name: r.orgName } : null,
  venue:
    r.venueId && r.venueName
      ? { id: r.venueId, name: r.venueName, prefecture: r.venuePrefecture }
      : null,
  shop: r.shopId && r.shopName ? { id: r.shopId, name: r.shopName, url: r.shopUrl } : null,
})

const selectRuns = (db: Db) =>
  db
    .select(runColumns)
    .from(run)
    .leftJoin(runOrg, eq(runOrg.id, run.organizationId))
    .leftJoin(venue, eq(venue.id, run.venueId))
    .leftJoin(shop, eq(shop.id, run.shopId))

// 作品ごとの run を compareRuns の順で
const runsByWork = async (db: Db, workIds: string[]): Promise<Map<string, RunRow[]>> => {
  const out = new Map<string, RunRow[]>()
  if (workIds.length === 0) return out
  const rows = await selectRuns(db).where(inArray(run.workId, workIds))
  for (const r of rows) {
    const list = out.get(r.workId) ?? []
    list.push(toRunRow(r))
    out.set(r.workId, list)
  }
  for (const list of out.values()) list.sort(compareRuns)
  return out
}

const workListColumns = {
  id: work.id,
  title: work.title,
  kind: work.kind,
  orgId: organization.id,
  orgName: organization.name,
}

const selectWorkList = (db: Db) =>
  db
    .select(workListColumns)
    .from(work)
    .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))

// 頁の作品に代表 run を付ける（作品 → run の 2 クエリ）
const withRep = async (
  db: Db,
  rows: {
    id: string
    title: string
    kind: WorkKind | null
    orgId: string | null
    orgName: string | null
  }[],
): Promise<WorkListItem[]> => {
  const runs = await runsByWork(
    db,
    rows.map((r) => r.id),
  )
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    org: r.orgId && r.orgName ? { id: r.orgId, name: r.orgName } : null,
    rep: runs.get(r.id)?.[0] ?? null,
  }))
}

// kind は UI の値（online = line / web、all = 条件なし）
const kindCondition = (kind: string): SQL | undefined => {
  if (kind === 'all') return undefined
  if (kind === 'online') return inArray(work.kind, ['line', 'web'])
  return eq(work.kind, kind as WorkKind)
}

// 作品題・作品別名・団体名（primary）・団体別名の 4 つを norm() 後の値で部分一致
const searchCondition = (q: string): SQL | undefined => {
  const qn = norm(q)
  if (qn === '') return undefined
  // norm() の結果に % _ \ は含まれないのでエスケープ不要
  const pat = `%${qn}%`
  return or(
    like(work.titleNorm, pat),
    exists(
      sql`(SELECT 1 FROM ${workAlias} WHERE ${workAlias.workId} = ${work.id} AND ${workAlias.titleNorm} LIKE ${pat})`,
    ),
    like(organization.nameNorm, pat),
    exists(
      sql`(SELECT 1 FROM ${organizationAlias} WHERE ${organizationAlias.organizationId} = ${work.primaryOrganizationId} AND ${organizationAlias.nameNorm} LIKE ${pat})`,
    ),
  )
}

// 作品一覧。LIMIT 51 で次頁の有無を見る（COUNT はしない）
export const listWorks = async (
  db: Db,
  { q = '', kind = 'all', page = 1 }: { q?: string; kind?: string; page?: number },
): Promise<{ items: WorkListItem[]; hasNext: boolean }> => {
  const rows = await selectWorkList(db)
    .where(and(isNull(work.mergedIntoId), kindCondition(kind), searchCondition(q)))
    .orderBy(desc(work.createdAt), desc(work.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  const hasNext = rows.length > PAGE_SIZE
  return { items: await withRep(db, rows.slice(0, PAGE_SIZE)), hasNext }
}

export type Resolved<T> = { found: T } | { redirect: string } | null

// 統合済み（merged_into_id あり）なら統合先の id を返す。鎖は MERGE_HOPS 段まで、超えたら・先が無ければ null
const resolveMerged = async <T extends { mergedIntoId: string | null }>(
  fetch: (id: string) => Promise<T | undefined>,
  id: string,
): Promise<Resolved<T>> => {
  let row = await fetch(id)
  if (!row) return null
  if (row.mergedIntoId === null) return { found: row }
  for (let i = 0; i < MERGE_HOPS; i++) {
    const nextId: string = row.mergedIntoId as string
    row = await fetch(nextId)
    if (!row) return null
    if (row.mergedIntoId === null) return { redirect: nextId }
  }
  return null
}

export type WorkDetailData = {
  id: string
  title: string
  kind: WorkKind | null
  description: string | null
  playerMin: number | null
  playerMax: number | null
  estimatedMinutes: number | null
  timeLimitMinutes: number | null
  firstReleasedOn: string | null
  officialUrl: string | null
  org: { id: string; name: string } | null
  aliases: { title: string; kind: (typeof workAliasKinds)[number] }[]
  runs: RunRow[]
}

export const getWork = async (db: Db, id: string): Promise<Resolved<WorkDetailData>> => {
  const resolved = await resolveMerged(
    (wid) =>
      db
        .select({
          id: work.id,
          title: work.title,
          kind: work.kind,
          description: work.description,
          playerMin: work.playerMin,
          playerMax: work.playerMax,
          estimatedMinutes: work.estimatedMinutes,
          timeLimitMinutes: work.timeLimitMinutes,
          firstReleasedOn: work.firstReleasedOn,
          officialUrl: work.officialUrl,
          mergedIntoId: work.mergedIntoId,
          orgId: organization.id,
          orgName: organization.name,
        })
        .from(work)
        .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
        .where(eq(work.id, wid))
        .get(),
    id,
  )
  if (!resolved || 'redirect' in resolved) return resolved
  const { mergedIntoId: _, orgId, orgName, ...w } = resolved.found
  const [aliases, runs] = await Promise.all([
    db
      .select({ title: workAlias.title, kind: workAlias.kind })
      .from(workAlias)
      .where(eq(workAlias.workId, w.id))
      .orderBy(workAlias.id),
    runsByWork(db, [w.id]),
  ])
  return {
    found: {
      ...w,
      org: orgId && orgName ? { id: orgId, name: orgName } : null,
      aliases,
      runs: runs.get(w.id) ?? [],
    },
  }
}

export type OrgDetailData = {
  id: string
  name: string
  siteUrl: string | null
  escapeIdUrl: string | null
  note: string | null
  aliases: {
    name: string
    kind: (typeof organizationAliasKinds)[number]
    since: string | null
    until: string | null
  }[]
  venues: { id: string; name: string; prefecture: string | null }[]
  works: WorkListItem[]
}

export const getOrg = async (db: Db, id: string): Promise<Resolved<OrgDetailData>> => {
  const resolved = await resolveMerged(
    (oid) =>
      db
        .select({
          id: organization.id,
          name: organization.name,
          siteUrl: organization.siteUrl,
          escapeIdUrl: organization.escapeIdUrl,
          note: organization.note,
          mergedIntoId: organization.mergedIntoId,
        })
        .from(organization)
        .where(eq(organization.id, oid))
        .get(),
    id,
  )
  if (!resolved || 'redirect' in resolved) return resolved
  const { mergedIntoId: _, ...o } = resolved.found
  const [aliases, venues, workRows] = await Promise.all([
    db
      .select({
        name: organizationAlias.name,
        kind: organizationAlias.kind,
        since: organizationAlias.since,
        until: organizationAlias.until,
      })
      .from(organizationAlias)
      .where(eq(organizationAlias.organizationId, o.id))
      .orderBy(organizationAlias.id),
    db
      .select({ id: venue.id, name: venue.name, prefecture: venue.prefecture })
      .from(venue)
      .where(and(eq(venue.organizationId, o.id), isNull(venue.mergedIntoId)))
      .orderBy(venue.name, venue.id),
    // primary がこの団体か、この団体名義の run を持つ作品
    selectWorkList(db)
      .where(
        and(
          isNull(work.mergedIntoId),
          or(
            eq(work.primaryOrganizationId, o.id),
            inArray(
              work.id,
              db.select({ id: run.workId }).from(run).where(eq(run.organizationId, o.id)),
            ),
          ),
        ),
      )
      .orderBy(desc(work.createdAt), desc(work.id))
      .limit(ORG_WORKS_LIMIT),
  ])
  return { found: { ...o, aliases, venues, works: await withRep(db, workRows) } }
}

export type VenueDetailData = {
  id: string
  name: string
  prefecture: string | null
  address: string | null
  org: { id: string; name: string } | null
  runs: (RunRow & { work: { id: string; title: string; kind: WorkKind | null } })[]
}

export const getVenue = async (db: Db, id: string): Promise<Resolved<VenueDetailData>> => {
  const resolved = await resolveMerged(
    (vid) =>
      db
        .select({
          id: venue.id,
          name: venue.name,
          prefecture: venue.prefecture,
          address: venue.address,
          mergedIntoId: venue.mergedIntoId,
          orgId: organization.id,
          orgName: organization.name,
        })
        .from(venue)
        .leftJoin(organization, eq(organization.id, venue.organizationId))
        .where(eq(venue.id, vid))
        .get(),
    id,
  )
  if (!resolved || 'redirect' in resolved) return resolved
  const { mergedIntoId: _, orgId, orgName, ...v } = resolved.found
  const rows = await db
    .select({ ...runColumns, workTitle: work.title, workKind: work.kind })
    .from(run)
    .innerJoin(work, eq(work.id, run.workId))
    .leftJoin(runOrg, eq(runOrg.id, run.organizationId))
    .leftJoin(venue, eq(venue.id, run.venueId))
    .leftJoin(shop, eq(shop.id, run.shopId))
    .where(and(eq(run.venueId, v.id), isNull(work.mergedIntoId)))
  const runs = rows
    .map((r) => ({ ...toRunRow(r), work: { id: r.workId, title: r.workTitle, kind: r.workKind } }))
    .sort(compareRuns)
  return {
    found: {
      ...v,
      org: orgId && orgName ? { id: orgId, name: orgName } : null,
      runs,
    },
  }
}
