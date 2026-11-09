// テスト補助。マスタの行を D1 に直接 INSERT する。id は ulid()、*_norm は norm() で計算する

import { ulid } from '../../src/lib/id'
import { norm } from '../../src/lib/norm'

type Env = Cloudflare.Env

// created_at は呼ぶたびに 1 ms ずつ進める（一覧の並びを決めるため）
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const nextIso = () => {
  clock += 1
  return new Date(clock).toISOString()
}

const insert = async (env: Env, table: string, row: Record<string, unknown>) => {
  const cols = Object.keys(row)
  await env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  )
    .bind(...cols.map((c) => row[c] ?? null))
    .run()
}

export const insertOrg = async (
  env: Env,
  o: { name: string; siteUrl?: string; escapeIdUrl?: string; note?: string; mergedIntoId?: string },
): Promise<string> => {
  const id = ulid()
  const now = nextIso()
  await insert(env, 'organization', {
    id,
    name: o.name,
    name_norm: norm(o.name),
    site_url: o.siteUrl,
    escape_id_url: o.escapeIdUrl,
    note: o.note,
    merged_into_id: o.mergedIntoId,
    created_at: now,
    updated_at: now,
  })
  return id
}

export const insertOrgAlias = async (
  env: Env,
  a: { organizationId: string; name: string; kind: string; since?: string; until?: string },
): Promise<string> => {
  const id = ulid()
  await insert(env, 'organization_alias', {
    id,
    organization_id: a.organizationId,
    name: a.name,
    name_norm: norm(a.name),
    kind: a.kind,
    since: a.since,
    until: a.until,
  })
  return id
}

export const insertWork = async (
  env: Env,
  w: {
    title: string
    kind?: string
    orgId?: string
    officialUrl?: string
    description?: string
    playerMin?: number
    playerMax?: number
    estimatedMinutes?: number
    timeLimitMinutes?: number
    firstReleasedOn?: string
    mergedIntoId?: string
  },
): Promise<string> => {
  const id = ulid()
  const now = nextIso()
  await insert(env, 'work', {
    id,
    title: w.title,
    title_norm: norm(w.title),
    kind: w.kind,
    primary_organization_id: w.orgId,
    official_url: w.officialUrl,
    description: w.description,
    player_min: w.playerMin,
    player_max: w.playerMax,
    estimated_minutes: w.estimatedMinutes,
    time_limit_minutes: w.timeLimitMinutes,
    first_released_on: w.firstReleasedOn,
    merged_into_id: w.mergedIntoId,
    created_at: now,
    updated_at: now,
  })
  return id
}

export const insertWorkAlias = async (
  env: Env,
  a: { workId: string; title: string; kind: string },
): Promise<string> => {
  const id = ulid()
  await insert(env, 'work_alias', {
    id,
    work_id: a.workId,
    title: a.title,
    title_norm: norm(a.title),
    kind: a.kind,
  })
  return id
}

export const insertVenue = async (
  env: Env,
  v: {
    name: string
    prefecture?: string
    address?: string
    organizationId?: string
    mergedIntoId?: string
  },
): Promise<string> => {
  const id = ulid()
  await insert(env, 'venue', {
    id,
    name: v.name,
    name_norm: norm(v.name),
    prefecture: v.prefecture,
    address: v.address,
    organization_id: v.organizationId,
    merged_into_id: v.mergedIntoId,
  })
  return id
}

export const insertShop = async (
  env: Env,
  s: { name: string; kind: string; url?: string; organizationId?: string },
): Promise<string> => {
  const id = ulid()
  await insert(env, 'shop', {
    id,
    name: s.name,
    kind: s.kind,
    url: s.url,
    organization_id: s.organizationId,
  })
  return id
}

export const insertRun = async (
  env: Env,
  r: {
    workId: string
    channel: string
    organizationId?: string
    billedAs?: string
    venueId?: string
    shopId?: string
    startOn?: string
    endOn?: string
    isPermanent?: boolean
    escapeIdUrl?: string
    ticketUrl?: string
    priceYen?: number
  },
): Promise<string> => {
  const id = ulid()
  const now = nextIso()
  await insert(env, 'run', {
    id,
    work_id: r.workId,
    channel: r.channel,
    organization_id: r.organizationId,
    billed_as: r.billedAs,
    venue_id: r.venueId,
    shop_id: r.shopId,
    start_on: r.startOn,
    end_on: r.endOn,
    is_permanent: r.isPermanent ? 1 : 0,
    escape_id_url: r.escapeIdUrl,
    ticket_url: r.ticketUrl,
    price_yen: r.priceYen,
    created_at: now,
    updated_at: now,
  })
  return id
}
