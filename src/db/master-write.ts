// マスタの書き込み（オーナー画面・P4 の提案）。入力は src/admin/validate.ts を通した値だけを受け取る。
// xxxStmts は本体と change_log の文を組み立てるだけ（実行しない）。複数表の文をまとめて 1 つの db.batch に入れられる。
// 今の名前の関数はそれを db.batch の 1 回で書く wrapper。*_norm はここで norm() から計算する（フォームに出さない）。

import { eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type {
  OrgAliasInput,
  OrgInput,
  RunInput,
  ShopInput,
  VenueInput,
  WorkAliasInput,
  WorkInput,
} from '../admin/validate'
import { ulid } from '../lib/id'
import { norm } from '../lib/norm'
import { nowIso } from '../lib/time'
import { columnRow, logChange, type WriteCtx } from './change-log'
import type { Db } from './client'
import type {
  OrgAliasRow,
  OrgRow,
  RunDbRow,
  ShopRow,
  VenueRow,
  WorkAliasRow,
  WorkRow,
} from './master'
import { organization, organizationAlias, run, shop, venue, work, workAlias } from './schema'

// 組み立てた文と対象の行 id
export type Stmts = { id: string; stmts: BatchItem<'sqlite'>[] }

// 文を db.batch の 1 回で書く。空なら何もしない（batch は空配列を受けない）
export const runStmts = async (db: Db, stmts: BatchItem<'sqlite'>[]): Promise<void> => {
  if (stmts.length === 0) return
  await db.batch(stmts as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
}

const runCreate = async (db: Db, s: Stmts): Promise<string> => {
  await runStmts(db, s.stmts)
  return s.id
}

// 変更があれば true（文が空 = 変更なし）
const runUpdate = async (db: Db, s: Stmts): Promise<boolean> => {
  await runStmts(db, s.stmts)
  return s.stmts.length > 0
}

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

export const createOrgStmts = (db: Db, input: OrgInput, ctx: WriteCtx): Stmts => {
  const now = nowIso()
  const row: OrgRow = {
    id: ulid(),
    ...input,
    nameNorm: norm(input.name),
    mergedIntoId: null,
    createdAt: now,
    updatedAt: now,
  }
  return {
    id: row.id,
    stmts: [
      db.insert(organization).values(row),
      logChange(db, {
        table: organization,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createOrg = (db: Db, input: OrgInput, ctx: WriteCtx): Promise<string> =>
  runCreate(db, createOrgStmts(db, input, ctx))

// 変更が無ければ stmts は空
export const updateOrgStmts = (db: Db, before: OrgRow, input: OrgInput, ctx: WriteCtx): Stmts => {
  const after: OrgRow = { ...before, ...input, nameNorm: norm(input.name), updatedAt: nowIso() }
  if (sameRow(organization, before, after, ['updated_at'])) return { id: before.id, stmts: [] }
  const { id: _, ...set } = after
  return {
    id: before.id,
    stmts: [
      db.update(organization).set(set).where(eq(organization.id, before.id)),
      logChange(db, {
        table: organization,
        rowId: before.id,
        action: 'update',
        before,
        after,
        ...ctx,
      }),
    ],
  }
}

// 変更があれば true
export const updateOrg = (
  db: Db,
  before: OrgRow,
  input: OrgInput,
  ctx: WriteCtx,
): Promise<boolean> => runUpdate(db, updateOrgStmts(db, before, input, ctx))

export const createOrgAliasStmts = (
  db: Db,
  organizationId: string,
  input: OrgAliasInput,
  ctx: WriteCtx,
): Stmts => {
  const row: OrgAliasRow = { id: ulid(), organizationId, ...input, nameNorm: norm(input.name) }
  return {
    id: row.id,
    stmts: [
      db.insert(organizationAlias).values(row),
      logChange(db, {
        table: organizationAlias,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createOrgAlias = (
  db: Db,
  organizationId: string,
  input: OrgAliasInput,
  ctx: WriteCtx,
): Promise<string> => runCreate(db, createOrgAliasStmts(db, organizationId, input, ctx))

export const deleteOrgAliasStmts = (db: Db, before: OrgAliasRow, ctx: WriteCtx): Stmts => ({
  id: before.id,
  stmts: [
    db.delete(organizationAlias).where(eq(organizationAlias.id, before.id)),
    logChange(db, {
      table: organizationAlias,
      rowId: before.id,
      action: 'delete',
      before,
      after: null,
      ...ctx,
    }),
  ],
})

export const deleteOrgAlias = async (db: Db, before: OrgAliasRow, ctx: WriteCtx): Promise<void> => {
  await runStmts(db, deleteOrgAliasStmts(db, before, ctx).stmts)
}

// ---------------------------------------------------------------------------
// venue / shop（時刻列は無い。履歴は change_log のみ）
// ---------------------------------------------------------------------------

export const createVenueStmts = (db: Db, input: VenueInput, ctx: WriteCtx): Stmts => {
  const row: VenueRow = { id: ulid(), ...input, nameNorm: norm(input.name), mergedIntoId: null }
  return {
    id: row.id,
    stmts: [
      db.insert(venue).values(row),
      logChange(db, {
        table: venue,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createVenue = (db: Db, input: VenueInput, ctx: WriteCtx): Promise<string> =>
  runCreate(db, createVenueStmts(db, input, ctx))

export const updateVenueStmts = (
  db: Db,
  before: VenueRow,
  input: VenueInput,
  ctx: WriteCtx,
): Stmts => {
  const after: VenueRow = { ...before, ...input, nameNorm: norm(input.name) }
  if (sameRow(venue, before, after)) return { id: before.id, stmts: [] }
  const { id: _, ...set } = after
  return {
    id: before.id,
    stmts: [
      db.update(venue).set(set).where(eq(venue.id, before.id)),
      logChange(db, { table: venue, rowId: before.id, action: 'update', before, after, ...ctx }),
    ],
  }
}

export const updateVenue = (
  db: Db,
  before: VenueRow,
  input: VenueInput,
  ctx: WriteCtx,
): Promise<boolean> => runUpdate(db, updateVenueStmts(db, before, input, ctx))

export const createShopStmts = (db: Db, input: ShopInput, ctx: WriteCtx): Stmts => {
  const row: ShopRow = { id: ulid(), ...input }
  return {
    id: row.id,
    stmts: [
      db.insert(shop).values(row),
      logChange(db, {
        table: shop,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createShop = (db: Db, input: ShopInput, ctx: WriteCtx): Promise<string> =>
  runCreate(db, createShopStmts(db, input, ctx))

export const updateShopStmts = (
  db: Db,
  before: ShopRow,
  input: ShopInput,
  ctx: WriteCtx,
): Stmts => {
  const after: ShopRow = { ...before, ...input }
  if (sameRow(shop, before, after)) return { id: before.id, stmts: [] }
  const { id: _, ...set } = after
  return {
    id: before.id,
    stmts: [
      db.update(shop).set(set).where(eq(shop.id, before.id)),
      logChange(db, { table: shop, rowId: before.id, action: 'update', before, after, ...ctx }),
    ],
  }
}

export const updateShop = (
  db: Db,
  before: ShopRow,
  input: ShopInput,
  ctx: WriteCtx,
): Promise<boolean> => runUpdate(db, updateShopStmts(db, before, input, ctx))

// ---------------------------------------------------------------------------
// work / work_alias
// ---------------------------------------------------------------------------

export const createWorkStmts = (db: Db, input: WorkInput, ctx: WriteCtx): Stmts => {
  const now = nowIso()
  const row: WorkRow = {
    id: ulid(),
    ...input,
    titleNorm: norm(input.title),
    mergedIntoId: null,
    createdAt: now,
    updatedAt: now,
  }
  return {
    id: row.id,
    stmts: [
      db.insert(work).values(row),
      logChange(db, {
        table: work,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createWork = (db: Db, input: WorkInput, ctx: WriteCtx): Promise<string> =>
  runCreate(db, createWorkStmts(db, input, ctx))

export const updateWorkStmts = (
  db: Db,
  before: WorkRow,
  input: WorkInput,
  ctx: WriteCtx,
): Stmts => {
  const after: WorkRow = { ...before, ...input, titleNorm: norm(input.title), updatedAt: nowIso() }
  if (sameRow(work, before, after, ['updated_at'])) return { id: before.id, stmts: [] }
  const { id: _, ...set } = after
  return {
    id: before.id,
    stmts: [
      db.update(work).set(set).where(eq(work.id, before.id)),
      logChange(db, { table: work, rowId: before.id, action: 'update', before, after, ...ctx }),
    ],
  }
}

export const updateWork = (
  db: Db,
  before: WorkRow,
  input: WorkInput,
  ctx: WriteCtx,
): Promise<boolean> => runUpdate(db, updateWorkStmts(db, before, input, ctx))

export const createWorkAliasStmts = (
  db: Db,
  workId: string,
  input: WorkAliasInput,
  ctx: WriteCtx,
): Stmts => {
  const row: WorkAliasRow = { id: ulid(), workId, ...input, titleNorm: norm(input.title) }
  return {
    id: row.id,
    stmts: [
      db.insert(workAlias).values(row),
      logChange(db, {
        table: workAlias,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createWorkAlias = (
  db: Db,
  workId: string,
  input: WorkAliasInput,
  ctx: WriteCtx,
): Promise<string> => runCreate(db, createWorkAliasStmts(db, workId, input, ctx))

export const deleteWorkAliasStmts = (db: Db, before: WorkAliasRow, ctx: WriteCtx): Stmts => ({
  id: before.id,
  stmts: [
    db.delete(workAlias).where(eq(workAlias.id, before.id)),
    logChange(db, {
      table: workAlias,
      rowId: before.id,
      action: 'delete',
      before,
      after: null,
      ...ctx,
    }),
  ],
})

export const deleteWorkAlias = async (
  db: Db,
  before: WorkAliasRow,
  ctx: WriteCtx,
): Promise<void> => {
  await runStmts(db, deleteWorkAliasStmts(db, before, ctx).stmts)
}

// ---------------------------------------------------------------------------
// run（削除はしない）
// ---------------------------------------------------------------------------

export const createRunStmts = (db: Db, workId: string, input: RunInput, ctx: WriteCtx): Stmts => {
  const now = nowIso()
  const row: RunDbRow = { id: ulid(), workId, ...input, createdAt: now, updatedAt: now }
  return {
    id: row.id,
    stmts: [
      db.insert(run).values(row),
      logChange(db, {
        table: run,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        ...ctx,
      }),
    ],
  }
}

export const createRun = (
  db: Db,
  workId: string,
  input: RunInput,
  ctx: WriteCtx,
): Promise<string> => runCreate(db, createRunStmts(db, workId, input, ctx))

export const updateRunStmts = (db: Db, before: RunDbRow, input: RunInput, ctx: WriteCtx): Stmts => {
  const after: RunDbRow = { ...before, ...input, updatedAt: nowIso() }
  if (sameRow(run, before, after, ['updated_at'])) return { id: before.id, stmts: [] }
  const { id: _, ...set } = after
  return {
    id: before.id,
    stmts: [
      db.update(run).set(set).where(eq(run.id, before.id)),
      logChange(db, { table: run, rowId: before.id, action: 'update', before, after, ...ctx }),
    ],
  }
}

export const updateRun = (
  db: Db,
  before: RunDbRow,
  input: RunInput,
  ctx: WriteCtx,
): Promise<boolean> => runUpdate(db, updateRunStmts(db, before, input, ctx))

// 回を別の作品に付け替える（run.work_id + change_log の update）。P4 の承認で紐付け先を変えるとき用。
// work_id が同じなら stmts は空
export const relinkRunStmts = (db: Db, before: RunDbRow, workId: string, ctx: WriteCtx): Stmts => {
  if (before.workId === workId) return { id: before.id, stmts: [] }
  const after: RunDbRow = { ...before, workId, updatedAt: nowIso() }
  return {
    id: before.id,
    stmts: [
      db.update(run).set({ workId, updatedAt: after.updatedAt }).where(eq(run.id, before.id)),
      logChange(db, { table: run, rowId: before.id, action: 'update', before, after, ...ctx }),
    ],
  }
}
