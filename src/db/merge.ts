// マスタの統合（A → B。docs/data-model.md §5）。A への FK を B に付け替え、A は削除せず merged_into_id を立てる。
// 全部を db.batch の 1 回（D1 では 1 トランザクション）で書く。A・B が存在し未統合で A ≠ B であることは呼び出し側で確かめる。
// 記録系（attempt / wishlist / session）は UPDATE / DELETE するだけで SELECT しない（件数も取らない。docs/auth.md §6）。

import { and, eq, inArray } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { alias } from 'drizzle-orm/sqlite-core'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import { logChange } from './change-log'
import type { Db } from './client'
import {
  type OrgAliasRow,
  type OrgRow,
  orgNameNormTaken,
  type VenueRow,
  type WorkAliasRow,
  type WorkRow,
  workTitleNormTaken,
} from './master'
import {
  attempt,
  booth,
  boothItem,
  marketEdition,
  organization,
  organizationAlias,
  run,
  session,
  shop,
  venue,
  wishlist,
  work,
  workAlias,
} from './schema'

const wishlistInto = alias(wishlist, 'wishlist_into')

export const mergeWork = async (
  db: Db,
  a: WorkRow,
  b: WorkRow,
  actorUserId: string,
): Promise<void> => {
  const now = nowIso()
  const extra: BatchItem<'sqlite'>[] = []

  // 旧題を B の別名に（B 側に同じ title_norm が無いときだけ）
  if (!(await workTitleNormTaken(db, { fromId: a.id, intoId: b.id }, a.titleNorm))) {
    const row: WorkAliasRow = {
      id: ulid(),
      workId: b.id,
      title: a.title,
      titleNorm: a.titleNorm,
      kind: 'former_title',
    }
    extra.push(
      db.insert(workAlias).values(row),
      logChange(db, {
        table: workAlias,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        actorUserId,
      }),
    )
  }

  // official_url（UNIQUE）は B が空のときだけ A から移す。先に A を空ける
  const takeUrl = b.officialUrl === null && a.officialUrl !== null
  const aAfter: WorkRow = {
    ...a,
    officialUrl: takeUrl ? null : a.officialUrl,
    mergedIntoId: b.id,
    updatedAt: now,
  }
  if (takeUrl) {
    const bAfter: WorkRow = { ...b, officialUrl: a.officialUrl, updatedAt: now }
    extra.push(
      db.update(work).set({ officialUrl: null }).where(eq(work.id, a.id)),
      db.update(work).set({ officialUrl: a.officialUrl, updatedAt: now }).where(eq(work.id, b.id)),
      logChange(db, {
        table: work,
        rowId: b.id,
        action: 'update',
        before: b,
        after: bAfter,
        actorUserId,
      }),
    )
  }

  await db.batch([
    db.update(run).set({ workId: b.id, updatedAt: now }).where(eq(run.workId, a.id)),
    // run_id はそのまま。attempt_no の重複は許容
    db.update(attempt).set({ workId: b.id }).where(eq(attempt.workId, a.id)),
    // (user_id, work_id) の PK が衝突する行（同じ人が A と B の両方をマイリストに入れている）は A 側を消す
    db
      .delete(wishlist)
      .where(
        and(
          eq(wishlist.workId, a.id),
          inArray(
            wishlist.userId,
            db
              .select({ userId: wishlistInto.userId })
              .from(wishlistInto)
              .where(eq(wishlistInto.workId, b.id)),
          ),
        ),
      ),
    db.update(wishlist).set({ workId: b.id }).where(eq(wishlist.workId, a.id)),
    db.update(boothItem).set({ workId: b.id }).where(eq(boothItem.workId, a.id)),
    db.update(workAlias).set({ workId: b.id }).where(eq(workAlias.workId, a.id)),
    ...extra,
    db.update(work).set({ mergedIntoId: b.id, updatedAt: now }).where(eq(work.id, a.id)),
    logChange(db, {
      table: work,
      rowId: a.id,
      action: 'merge',
      before: a,
      after: aAfter,
      actorUserId,
    }),
  ])
}

export const mergeOrganization = async (
  db: Db,
  a: OrgRow,
  b: OrgRow,
  actorUserId: string,
): Promise<void> => {
  const now = nowIso()
  const extra: BatchItem<'sqlite'>[] = []

  // 旧名を B の別名に（B 側に同じ name_norm が無いときだけ）
  if (!(await orgNameNormTaken(db, { fromId: a.id, intoId: b.id }, a.nameNorm))) {
    const row: OrgAliasRow = {
      id: ulid(),
      organizationId: b.id,
      name: a.name,
      nameNorm: a.nameNorm,
      kind: 'former_name',
      since: null,
      until: null,
    }
    extra.push(
      db.insert(organizationAlias).values(row),
      logChange(db, {
        table: organizationAlias,
        rowId: row.id,
        action: 'create',
        before: null,
        after: row,
        actorUserId,
      }),
    )
  }

  // escape_id_url と slug（どちらも UNIQUE。slug は URL から導くので組で扱う）は B の URL が空のときだけ A から移す
  const takeUrl = b.escapeIdUrl === null && a.escapeIdUrl !== null
  const aAfter: OrgRow = {
    ...a,
    escapeIdUrl: takeUrl ? null : a.escapeIdUrl,
    slug: takeUrl ? null : a.slug,
    mergedIntoId: b.id,
    updatedAt: now,
  }
  if (takeUrl) {
    const bAfter: OrgRow = { ...b, escapeIdUrl: a.escapeIdUrl, slug: a.slug, updatedAt: now }
    extra.push(
      db
        .update(organization)
        .set({ escapeIdUrl: null, slug: null })
        .where(eq(organization.id, a.id)),
      db
        .update(organization)
        .set({ escapeIdUrl: a.escapeIdUrl, slug: a.slug, updatedAt: now })
        .where(eq(organization.id, b.id)),
      logChange(db, {
        table: organization,
        rowId: b.id,
        action: 'update',
        before: b,
        after: bAfter,
        actorUserId,
      }),
    )
  }

  await db.batch([
    db
      .update(work)
      .set({ primaryOrganizationId: b.id, updatedAt: now })
      .where(eq(work.primaryOrganizationId, a.id)),
    // billed_as（当時の名義の表記）は書き換えない
    db
      .update(run)
      .set({ organizationId: b.id, updatedAt: now })
      .where(eq(run.organizationId, a.id)),
    db.update(venue).set({ organizationId: b.id }).where(eq(venue.organizationId, a.id)),
    db.update(shop).set({ organizationId: b.id }).where(eq(shop.organizationId, a.id)),
    db.update(booth).set({ organizationId: b.id }).where(eq(booth.organizationId, a.id)),
    db
      .update(organizationAlias)
      .set({ organizationId: b.id })
      .where(eq(organizationAlias.organizationId, a.id)),
    ...extra,
    db
      .update(organization)
      .set({ mergedIntoId: b.id, updatedAt: now })
      .where(eq(organization.id, a.id)),
    logChange(db, {
      table: organization,
      rowId: a.id,
      action: 'merge',
      before: a,
      after: aAfter,
      actorUserId,
    }),
  ])
}

// venue に別名の表は無いので、旧名は change_log にだけ残る
export const mergeVenue = async (
  db: Db,
  a: VenueRow,
  b: VenueRow,
  actorUserId: string,
): Promise<void> => {
  const now = nowIso()
  await db.batch([
    db.update(run).set({ venueId: b.id, updatedAt: now }).where(eq(run.venueId, a.id)),
    db.update(session).set({ venueId: b.id }).where(eq(session.venueId, a.id)),
    db.update(marketEdition).set({ venueId: b.id }).where(eq(marketEdition.venueId, a.id)),
    db.update(venue).set({ mergedIntoId: b.id }).where(eq(venue.id, a.id)),
    logChange(db, {
      table: venue,
      rowId: a.id,
      action: 'merge',
      before: a,
      after: { ...a, mergedIntoId: b.id },
      actorUserId,
    }),
  ])
}
