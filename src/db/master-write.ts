// マスタの書き込み（オーナー画面）。入力は src/admin/validate.ts を通した値だけを受け取る。
// 本体と change_log を db.batch の 1 回で書く。*_norm はここで norm() から計算する（フォームに出さない）。

import { eq } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { OrgAliasInput, OrgInput, ShopInput, VenueInput } from '../admin/validate'
import { ulid } from '../lib/id'
import { norm } from '../lib/norm'
import { nowIso } from '../lib/time'
import { columnRow, logChange } from './change-log'
import type { Db } from './client'
import type { OrgAliasRow, OrgRow, ShopRow, VenueRow } from './master'
import { organization, organizationAlias, shop, venue } from './schema'

// before と after が（ignore の列を除いて）同じか。同じなら UPDATE も change_log も書かない
const sameRow = (
  table: SQLiteTable,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: readonly string[] = [],
): boolean => {
  const a = columnRow(table, before)
  const b = columnRow(table, after)
  for (const k of ignore) {
    delete a[k]
    delete b[k]
  }
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------
// organization
// ---------------------------------------------------------------------------

export const createOrg = async (db: Db, input: OrgInput, actorUserId: string): Promise<string> => {
  const now = nowIso()
  const row: OrgRow = {
    id: ulid(),
    ...input,
    nameNorm: norm(input.name),
    mergedIntoId: null,
    createdAt: now,
    updatedAt: now,
  }
  await db.batch([
    db.insert(organization).values(row),
    logChange(db, {
      table: organization,
      rowId: row.id,
      action: 'create',
      before: null,
      after: row,
      actorUserId,
    }),
  ])
  return row.id
}

// 変更があれば true
export const updateOrg = async (
  db: Db,
  before: OrgRow,
  input: OrgInput,
  actorUserId: string,
): Promise<boolean> => {
  const after: OrgRow = { ...before, ...input, nameNorm: norm(input.name), updatedAt: nowIso() }
  if (sameRow(organization, before, after, ['updated_at'])) return false
  const { id: _, ...set } = after
  await db.batch([
    db.update(organization).set(set).where(eq(organization.id, before.id)),
    logChange(db, {
      table: organization,
      rowId: before.id,
      action: 'update',
      before,
      after,
      actorUserId,
    }),
  ])
  return true
}

export const createOrgAlias = async (
  db: Db,
  organizationId: string,
  input: OrgAliasInput,
  actorUserId: string,
): Promise<string> => {
  const row: OrgAliasRow = { id: ulid(), organizationId, ...input, nameNorm: norm(input.name) }
  await db.batch([
    db.insert(organizationAlias).values(row),
    logChange(db, {
      table: organizationAlias,
      rowId: row.id,
      action: 'create',
      before: null,
      after: row,
      actorUserId,
    }),
  ])
  return row.id
}

export const deleteOrgAlias = async (
  db: Db,
  before: OrgAliasRow,
  actorUserId: string,
): Promise<void> => {
  await db.batch([
    db.delete(organizationAlias).where(eq(organizationAlias.id, before.id)),
    logChange(db, {
      table: organizationAlias,
      rowId: before.id,
      action: 'delete',
      before,
      after: null,
      actorUserId,
    }),
  ])
}

// ---------------------------------------------------------------------------
// venue / shop（時刻列は無い。履歴は change_log のみ）
// ---------------------------------------------------------------------------

export const createVenue = async (
  db: Db,
  input: VenueInput,
  actorUserId: string,
): Promise<string> => {
  const row: VenueRow = { id: ulid(), ...input, nameNorm: norm(input.name), mergedIntoId: null }
  await db.batch([
    db.insert(venue).values(row),
    logChange(db, {
      table: venue,
      rowId: row.id,
      action: 'create',
      before: null,
      after: row,
      actorUserId,
    }),
  ])
  return row.id
}

export const updateVenue = async (
  db: Db,
  before: VenueRow,
  input: VenueInput,
  actorUserId: string,
): Promise<boolean> => {
  const after: VenueRow = { ...before, ...input, nameNorm: norm(input.name) }
  if (sameRow(venue, before, after)) return false
  const { id: _, ...set } = after
  await db.batch([
    db.update(venue).set(set).where(eq(venue.id, before.id)),
    logChange(db, { table: venue, rowId: before.id, action: 'update', before, after, actorUserId }),
  ])
  return true
}

export const createShop = async (
  db: Db,
  input: ShopInput,
  actorUserId: string,
): Promise<string> => {
  const row: ShopRow = { id: ulid(), ...input }
  await db.batch([
    db.insert(shop).values(row),
    logChange(db, {
      table: shop,
      rowId: row.id,
      action: 'create',
      before: null,
      after: row,
      actorUserId,
    }),
  ])
  return row.id
}

export const updateShop = async (
  db: Db,
  before: ShopRow,
  input: ShopInput,
  actorUserId: string,
): Promise<boolean> => {
  const after: ShopRow = { ...before, ...input }
  if (sameRow(shop, before, after)) return false
  const { id: _, ...set } = after
  await db.batch([
    db.update(shop).set(set).where(eq(shop.id, before.id)),
    logChange(db, { table: shop, rowId: before.id, action: 'update', before, after, actorUserId }),
  ])
  return true
}
