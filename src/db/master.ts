// マスタ（作品・団体・会場・販売先・回）の読み取り。全ユーザー共有なので scopedTo を通さない。
// 記録系テーブル（scripts/check-scoped.mjs の禁止語）はここから import しない。

import { and, desc, eq, exists, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm'
import { alias, type SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { norm } from '../lib/norm'
import type { Db } from './client'
import {
  booth,
  boothItem,
  genre,
  marketEdition,
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
const ORG_WORKS_LIMIT = 100
// D1 のバインド変数は 1 文 100 個まで。IN (...) はこの件数ずつに分ける
const IN_CHUNK = 90
// D1 の LIKE パターンは 50 バイトまで。前後の % を除いた本体をこのバイト数に収める
const LIKE_BODY_MAX_BYTES = 48

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
  const rows: RunSelect[] = []
  for (let i = 0; i < workIds.length; i += IN_CHUNK) {
    rows.push(...(await selectRuns(db).where(inArray(run.workId, workIds.slice(i, i + IN_CHUNK)))))
  }
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

// LIKE の本体。\ % _ をエスケープし、UTF-8 で LIKE_BODY_MAX_BYTES 以内に切り詰める（文字・エスケープの途中では切らない）
const likeBody = (s: string): string => {
  const enc = new TextEncoder()
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const piece = ch === '\\' || ch === '%' || ch === '_' ? `\\${ch}` : ch
    const n = enc.encode(piece).length
    if (bytes + n > LIKE_BODY_MAX_BYTES) break
    out += piece
    bytes += n
  }
  return out
}

const likeEscaped = (col: SQLiteColumn, pat: string): SQL => sql`${col} LIKE ${pat} ESCAPE '\\'`

// 作品題・作品別名・団体名（primary）・団体別名の 4 つを norm() 後の値で部分一致
const searchCondition = (q: string): SQL | undefined => {
  const body = likeBody(norm(q))
  if (body === '') return undefined
  const pat = `%${body}%`
  return or(
    likeEscaped(work.titleNorm, pat),
    exists(
      sql`(SELECT 1 FROM ${workAlias} WHERE ${workAlias.workId} = ${work.id} AND ${likeEscaped(workAlias.titleNorm, pat)})`,
    ),
    likeEscaped(organization.nameNorm, pat),
    exists(
      sql`(SELECT 1 FROM ${organizationAlias} WHERE ${organizationAlias.organizationId} = ${work.primaryOrganizationId} AND ${likeEscaped(organizationAlias.nameNorm, pat)})`,
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

export type GenreRow = { id: string; label: string }

// ジャンルの選択肢。archived = 0 と、includeIds（記録に付いている分）は archived でも出す。sort_order 順
export const listGenres = (
  db: Db,
  { includeIds = [] }: { includeIds?: readonly string[] } = {},
): Promise<GenreRow[]> =>
  db
    .select({ id: genre.id, label: genre.label })
    .from(genre)
    .where(
      includeIds.length
        ? or(eq(genre.archived, 0), inArray(genre.id, [...includeIds]))
        : eq(genre.archived, 0),
    )
    .orderBy(genre.sortOrder, genre.id)

// ---------------------------------------------------------------------------
// オーナー画面（/admin/*）用の読み取り。統合済みの行も返す
// ---------------------------------------------------------------------------

export type AdminListItem = {
  id: string
  name: string
  note: string | null
  mergedInto: { id: string; name: string } | null
}

type AdminPage = { q?: string; page?: number }

const mergedOrg = alias(organization, 'merged_org')
const mergedWork = alias(work, 'merged_work')
const mergedVenue = alias(venue, 'merged_venue')

const pageOf = <T>(rows: T[]): { items: T[]; hasNext: boolean } => ({
  items: rows.slice(0, PAGE_SIZE),
  hasNext: rows.length > PAGE_SIZE,
})

const mergedRef = (id: string | null, name: string | null) => (id && name ? { id, name } : null)

// 団体。q は団体名・団体別名を norm() 後の値で部分一致
export const listAdminOrgs = async (db: Db, { q = '', page = 1 }: AdminPage) => {
  const body = likeBody(norm(q))
  const pat = `%${body}%`
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      mergedId: mergedOrg.id,
      mergedName: mergedOrg.name,
    })
    .from(organization)
    .leftJoin(mergedOrg, eq(mergedOrg.id, organization.mergedIntoId))
    .where(
      body === ''
        ? undefined
        : or(
            likeEscaped(organization.nameNorm, pat),
            exists(
              sql`(SELECT 1 FROM ${organizationAlias} WHERE ${organizationAlias.organizationId} = ${organization.id} AND ${likeEscaped(organizationAlias.nameNorm, pat)})`,
            ),
          ),
    )
    .orderBy(desc(organization.createdAt), desc(organization.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return pageOf<AdminListItem>(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: null,
      mergedInto: mergedRef(r.mergedId, r.mergedName),
    })),
  )
}

// 会場。venue に created_at が無いので id（ULID）の降順 = 登録が新しい順
export const listAdminVenues = async (db: Db, { q = '', page = 1 }: AdminPage) => {
  const body = likeBody(norm(q))
  const rows = await db
    .select({
      id: venue.id,
      name: venue.name,
      prefecture: venue.prefecture,
      mergedId: mergedVenue.id,
      mergedName: mergedVenue.name,
    })
    .from(venue)
    .leftJoin(mergedVenue, eq(mergedVenue.id, venue.mergedIntoId))
    .where(body === '' ? undefined : likeEscaped(venue.nameNorm, `%${body}%`))
    .orderBy(desc(venue.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return pageOf<AdminListItem>(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.prefecture,
      mergedInto: mergedRef(r.mergedId, r.mergedName),
    })),
  )
}

// 販売先。name_norm 列が無いので LOWER(name) で部分一致。統合は無い。並びは会場と同じ
export const listAdminShops = async (db: Db, { q = '', page = 1 }: AdminPage) => {
  const body = likeBody(q.trim().toLowerCase())
  const rows = await db
    .select({ id: shop.id, name: shop.name, kind: shop.kind })
    .from(shop)
    .where(body === '' ? undefined : sql`LOWER(${shop.name}) LIKE ${`%${body}%`} ESCAPE '\\'`)
    .orderBy(desc(shop.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return pageOf(rows)
}

// 作品。q は閲覧の作品一覧と同じ 4 つ（統合済みも含める）
export const listAdminWorks = async (db: Db, { q = '', page = 1 }: AdminPage) => {
  const rows = await db
    .select({
      id: work.id,
      title: work.title,
      kind: work.kind,
      orgName: organization.name,
      mergedId: mergedWork.id,
      mergedName: mergedWork.title,
    })
    .from(work)
    .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
    .leftJoin(mergedWork, eq(mergedWork.id, work.mergedIntoId))
    .where(searchCondition(q))
    .orderBy(desc(work.createdAt), desc(work.id))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE)
  return pageOf(
    rows.map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      orgName: r.orgName,
      mergedInto: mergedRef(r.mergedId, r.mergedName),
    })),
  )
}

export type OrgRow = typeof organization.$inferSelect
export type OrgAliasRow = typeof organizationAlias.$inferSelect
export type VenueRow = typeof venue.$inferSelect
export type ShopRow = typeof shop.$inferSelect

// 編集画面用の行全体。統合済みなら統合先の名前も付ける
export const getAdminOrg = async (db: Db, id: string) => {
  const row = await db.select().from(organization).where(eq(organization.id, id)).get()
  if (!row) return null
  const [into, aliases] = await Promise.all([
    row.mergedIntoId
      ? db
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(eq(organization.id, row.mergedIntoId))
          .get()
      : undefined,
    db
      .select()
      .from(organizationAlias)
      .where(eq(organizationAlias.organizationId, id))
      .orderBy(organizationAlias.id),
  ])
  return { row, mergedInto: into ?? null, aliases }
}

export const getOrgAliasRow = (db: Db, id: string) =>
  db.select().from(organizationAlias).where(eq(organizationAlias.id, id)).get()

export const getAdminVenue = async (db: Db, id: string) => {
  const row = await db.select().from(venue).where(eq(venue.id, id)).get()
  if (!row) return null
  const into = row.mergedIntoId
    ? await db
        .select({ id: venue.id, name: venue.name })
        .from(venue)
        .where(eq(venue.id, row.mergedIntoId))
        .get()
    : undefined
  return { row, mergedInto: into ?? null }
}

export const getShopRow = (db: Db, id: string) =>
  db.select().from(shop).where(eq(shop.id, id)).get()

// 選択肢用。未統合の団体を name_norm 順に
export const orgOptions = (db: Db) =>
  db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(isNull(organization.mergedIntoId))
    .orderBy(organization.nameNorm, organization.id)

// id の団体が存在し、統合済みでないか
export const isLiveOrg = async (db: Db, id: string): Promise<boolean> =>
  !!(await db
    .select({ id: organization.id })
    .from(organization)
    .where(and(eq(organization.id, id), isNull(organization.mergedIntoId)))
    .get())

// escape_id_url か slug が同じ団体（exceptId 以外。統合済みも含む）があるか
export const orgUniqueTaken = async (
  db: Db,
  { escapeIdUrl, slug }: { escapeIdUrl: string | null; slug: string | null },
  exceptId?: string,
): Promise<boolean> => {
  const conds: SQL[] = []
  if (escapeIdUrl) conds.push(eq(organization.escapeIdUrl, escapeIdUrl))
  if (slug) conds.push(eq(organization.slug, slug))
  if (conds.length === 0) return false
  const row = await db
    .select({ id: organization.id })
    .from(organization)
    .where(and(or(...conds), exceptId ? ne(organization.id, exceptId) : undefined))
    .get()
  return !!row
}

// url が同じ販売先（exceptId 以外）があるか
export const shopUrlTaken = async (db: Db, url: string, exceptId?: string): Promise<boolean> =>
  !!(await db
    .select({ id: shop.id })
    .from(shop)
    .where(and(eq(shop.url, url), exceptId ? ne(shop.id, exceptId) : undefined))
    .get())

export type WorkRow = typeof work.$inferSelect
export type WorkAliasRow = typeof workAlias.$inferSelect
export type RunDbRow = typeof run.$inferSelect

// 作品の編集画面用。行全体・統合先・別名・回（表示用、compareRuns の順）
export const getAdminWork = async (db: Db, id: string) => {
  const row = await db.select().from(work).where(eq(work.id, id)).get()
  if (!row) return null
  const [into, aliases, runs] = await Promise.all([
    row.mergedIntoId
      ? db
          .select({ id: work.id, name: work.title })
          .from(work)
          .where(eq(work.id, row.mergedIntoId))
          .get()
      : undefined,
    db.select().from(workAlias).where(eq(workAlias.workId, id)).orderBy(workAlias.id),
    runsByWork(db, [id]),
  ])
  return { row, mergedInto: into ?? null, aliases, runs: runs.get(id) ?? [] }
}

export const getWorkAliasRow = (db: Db, id: string) =>
  db.select().from(workAlias).where(eq(workAlias.id, id)).get()

export const getRunRow = (db: Db, id: string) => db.select().from(run).where(eq(run.id, id)).get()

// 選択肢用。未統合の会場を name_norm 順に
export const venueOptions = (db: Db) =>
  db
    .select({ id: venue.id, name: venue.name, prefecture: venue.prefecture })
    .from(venue)
    .where(isNull(venue.mergedIntoId))
    .orderBy(venue.nameNorm, venue.id)

// 選択肢用。販売先を名前順に（統合は無い）
export const shopOptions = (db: Db) =>
  db.select({ id: shop.id, name: shop.name }).from(shop).orderBy(shop.name, shop.id)

export const isLiveVenue = async (db: Db, id: string): Promise<boolean> =>
  !!(await db
    .select({ id: venue.id })
    .from(venue)
    .where(and(eq(venue.id, id), isNull(venue.mergedIntoId)))
    .get())

export const shopExists = async (db: Db, id: string): Promise<boolean> =>
  !!(await db.select({ id: shop.id }).from(shop).where(eq(shop.id, id)).get())

// official_url が同じ作品（exceptId 以外。統合済みも含む）があるか
export const workOfficialUrlTaken = async (
  db: Db,
  url: string,
  exceptId?: string,
): Promise<boolean> =>
  !!(await db
    .select({ id: work.id })
    .from(work)
    .where(and(eq(work.officialUrl, url), exceptId ? ne(work.id, exceptId) : undefined))
    .get())

// escape_id_url が同じ回（exceptId 以外）があるか
export const runEscapeUrlTaken = async (db: Db, url: string, exceptId?: string): Promise<boolean> =>
  !!(await db
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.escapeIdUrl, url), exceptId ? ne(run.id, exceptId) : undefined))
    .get())

// ---------------------------------------------------------------------------
// 統合（/admin/*/:id/merge）の確認画面と事前検査。マスタ表の件数だけ（記録・マイリストは数えない）
// ---------------------------------------------------------------------------

export const workMergeCounts = async (db: Db, id: string) => {
  const [runs, aliases, boothItems] = await Promise.all([
    db.$count(run, eq(run.workId, id)),
    db.$count(workAlias, eq(workAlias.workId, id)),
    db.$count(boothItem, eq(boothItem.workId, id)),
  ])
  return { runs, aliases, boothItems }
}

export const orgMergeCounts = async (db: Db, id: string) => {
  const [works, runs, venues, shops, booths, aliases] = await Promise.all([
    db.$count(work, eq(work.primaryOrganizationId, id)),
    db.$count(run, eq(run.organizationId, id)),
    db.$count(venue, eq(venue.organizationId, id)),
    db.$count(shop, eq(shop.organizationId, id)),
    db.$count(booth, eq(booth.organizationId, id)),
    db.$count(organizationAlias, eq(organizationAlias.organizationId, id)),
  ])
  return { works, runs, venues, shops, booths, aliases }
}

export const venueMergeCounts = async (db: Db, id: string) => {
  const [runs, marketEditions] = await Promise.all([
    db.$count(run, eq(run.venueId, id)),
    db.$count(marketEdition, eq(marketEdition.venueId, id)),
  ])
  return { runs, marketEditions }
}

// 統合後の B（B 本体の題名・B の別名・B へ移る A の別名）に titleNorm があるか。あれば旧題の別名を足さない
export const workTitleNormTaken = async (
  db: Db,
  { fromId, intoId }: { fromId: string; intoId: string },
  titleNorm: string,
): Promise<boolean> => {
  const [w, a] = await Promise.all([
    db
      .select({ id: work.id })
      .from(work)
      .where(and(eq(work.id, intoId), eq(work.titleNorm, titleNorm)))
      .get(),
    db
      .select({ id: workAlias.id })
      .from(workAlias)
      .where(and(inArray(workAlias.workId, [fromId, intoId]), eq(workAlias.titleNorm, titleNorm)))
      .get(),
  ])
  return !!(w || a)
}

// 団体版。nameNorm が統合後の B の名前・別名にあるか
export const orgNameNormTaken = async (
  db: Db,
  { fromId, intoId }: { fromId: string; intoId: string },
  nameNorm: string,
): Promise<boolean> => {
  const [o, a] = await Promise.all([
    db
      .select({ id: organization.id })
      .from(organization)
      .where(and(eq(organization.id, intoId), eq(organization.nameNorm, nameNorm)))
      .get(),
    db
      .select({ id: organizationAlias.id })
      .from(organizationAlias)
      .where(
        and(
          inArray(organizationAlias.organizationId, [fromId, intoId]),
          eq(organizationAlias.nameNorm, nameNorm),
        ),
      )
      .get(),
  ])
  return !!(o || a)
}
