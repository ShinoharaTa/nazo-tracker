// 作品・団体・会場の統合（/admin/{works,orgs,venues}/:id/merge）。requireOwner は admin/index.tsx で掛かる。
// 統合先は管理一覧の ?merge_from= モードの「ここに統合」で選ぶ → GET で確認画面 → POST（confirm=yes）で統合。
// 確認画面に記録・マイリストの件数は出さない（docs/auth.md §6）。販売先と回は統合しない。

import { Hono } from 'hono'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import {
  getAdminOrg,
  getAdminVenue,
  getAdminWork,
  type OrgRow,
  orgMergeCounts,
  orgNameNormTaken,
  type VenueRow,
  venueMergeCounts,
  type WorkRow,
  workMergeCounts,
  workTitleNormTaken,
} from '../../db/master'
import { mergeOrganization, mergeVenue, mergeWork } from '../../db/merge'
import type { AppEnv } from '../../env'
import {
  AdminNotFound,
  AdminPage,
  MergeConfirm,
  MergedNotice,
  type MergeSide,
} from '../../ui/admin'
import { TopBar } from '../../ui/components'
import { workKindLabels } from '../../ui/labels'

type Row = { id: string; mergedIntoId: string | null }

type Entity<R extends Row> = {
  // /admin/works など
  base: string
  label: string
  get: (
    db: Db,
    id: string,
  ) => Promise<{ row: R; mergedInto: { id: string; name: string } | null } | null>
  name: (r: R) => string
  // 確認画面に並べる項目（空の値は出さない）
  details: (db: Db, r: R) => Promise<[string, string | null][]>
  // 確認画面の説明。b は統合先
  notes: (db: Db, a: R, b: R) => Promise<string[]>
  merge: (db: Db, a: R, b: R, actorUserId: string) => Promise<void>
}

const orgName = async (db: Db, id: string | null): Promise<string | null> =>
  id ? ((await getAdminOrg(db, id))?.row.name ?? null) : null

const workEntity: Entity<WorkRow> = {
  base: '/admin/works',
  label: '作品',
  get: getAdminWork,
  name: (r) => r.title,
  details: async (db, r) => [
    ['団体', await orgName(db, r.primaryOrganizationId)],
    ['形式', r.kind ? workKindLabels[r.kind] : null],
    ['公式サイト', r.officialUrl],
  ],
  notes: async (db, a, b) => {
    const [n, taken] = await Promise.all([
      workMergeCounts(db, a.id),
      workTitleNormTaken(db, { fromId: a.id, intoId: b.id }, a.titleNorm),
    ])
    return [
      `「${b.title}」に付け替わるもの: 回 ${n.runs} 件、別名 ${n.aliases} 件、出店 ${n.boothItems} 件。記録とマイリストも自動で付け替えます（件数は表示しません）。`,
      'マイリストで両方に入れていた人は統合先側の 1 件だけが残ります。',
      taken
        ? '同じ題名が統合先にあるため旧題は追加しません。'
        : `「${a.title}」の題名は「${b.title}」の旧題として残ります。`,
      `「${a.title}」は統合済みになり、作品ページは「${b.title}」へ転送されます。`,
    ]
  },
  merge: mergeWork,
}

const orgEntity: Entity<OrgRow> = {
  base: '/admin/orgs',
  label: '団体',
  get: getAdminOrg,
  name: (r) => r.name,
  details: async (_db, r) => [
    ['escape.id', r.escapeIdUrl],
    ['公式サイト', r.siteUrl],
  ],
  notes: async (db, a, b) => {
    const [n, taken] = await Promise.all([
      orgMergeCounts(db, a.id),
      orgNameNormTaken(db, { fromId: a.id, intoId: b.id }, a.nameNorm),
    ])
    return [
      `「${b.name}」に付け替わるもの: 作品 ${n.works} 件、回 ${n.runs} 件、会場 ${n.venues} 件、販売先 ${n.shops} 件、出店 ${n.booths} 件、別名 ${n.aliases} 件。回の名義の表記は書き換えません。`,
      taken
        ? '同じ名前が統合先にあるため旧名は追加しません。'
        : `「${a.name}」の名前は「${b.name}」の旧名として残ります。`,
      `「${a.name}」は統合済みになり、団体ページは「${b.name}」へ転送されます。`,
    ]
  },
  merge: mergeOrganization,
}

const venueEntity: Entity<VenueRow> = {
  base: '/admin/venues',
  label: '会場',
  get: getAdminVenue,
  name: (r) => r.name,
  details: async (db, r) => [
    ['都道府県', r.prefecture],
    ['住所', r.address],
    ['運営団体', await orgName(db, r.organizationId)],
  ],
  notes: async (db, a, b) => {
    const n = await venueMergeCounts(db, a.id)
    return [
      `「${b.name}」に付け替わるもの: 回 ${n.runs} 件、マーケット開催 ${n.marketEditions} 件。記録の進行ログも自動で付け替えます（件数は表示しません）。`,
      `「${a.name}」の名前は変更履歴にだけ残ります。「${a.name}」は統合済みになり、会場ページは「${b.name}」へ転送されます。`,
    ]
  },
  merge: mergeVenue,
}

const register = <R extends Row>(app: Hono<AppEnv>, e: Entity<R>) => {
  const path = `${e.base.replace(/^\/admin/, '')}/:id/merge`
  const title = `${e.label}の統合`

  const notFound = () => (
    <AdminPage title="見つかりませんでした">
      <AdminNotFound back={e.base} />
    </AdminPage>
  )

  const mergedPage = (into: { id: string; name: string } | null) => (
    <AdminPage title={title}>
      <TopBar back={e.base} label={title} />
      {into ? <MergedNotice href={`${e.base}/${into.id}`} name={into.name} /> : null}
    </AdminPage>
  )

  const errorPage = (a: R, message: string) => (
    <AdminPage title={title}>
      <TopBar back={`${e.base}/${a.id}`} label={title} />
      <div class="sect" style="margin-top:4px">
        <p class="note" role="alert">
          {message}
        </p>
        <a class="btn" href={`${e.base}?merge_from=${a.id}`}>
          統合先を選び直す
        </a>
      </div>
    </AdminPage>
  )

  const side = async (db: Db, label: string, r: R): Promise<MergeSide> => ({
    label,
    name: e.name(r),
    href: `${e.base}/${r.id}`,
    rows: (await e.details(db, r)).filter((kv): kv is [string, string] => !!kv[1]),
  })

  const confirmPage = async (db: Db, a: R, b: R, errors?: string[]) => (
    <AdminPage title={title}>
      <TopBar back={`${e.base}?merge_from=${a.id}`} label={title} />
      <MergeConfirm
        action={`${e.base}/${a.id}/merge`}
        into={b.id}
        a={await side(db, '統合元（統合済みになる）', a)}
        b={await side(db, '統合先（残る）', b)}
        notes={await e.notes(db, a, b)}
        errors={errors}
      />
    </AdminPage>
  )

  // A と B を引いて検証する。駄目なら出すページと status、良ければ両方の行
  const load = async (
    db: Db,
    aId: string,
    bId: string | undefined,
  ): Promise<{ page: ReturnType<typeof notFound>; status: 400 | 404 } | { a: R; b: R }> => {
    const a = await e.get(db, aId)
    if (!a) return { page: notFound(), status: 404 }
    if (a.row.mergedIntoId) return { page: mergedPage(a.mergedInto), status: 400 }
    if (!bId) return { page: errorPage(a.row, '統合先が選ばれていません'), status: 400 }
    if (bId === a.row.id) {
      return { page: errorPage(a.row, `同じ${e.label}には統合できません`), status: 400 }
    }
    const b = await e.get(db, bId)
    if (!b) return { page: errorPage(a.row, '統合先が見つかりません'), status: 400 }
    if (b.row.mergedIntoId) {
      return { page: errorPage(a.row, '統合先はすでに統合済みです'), status: 400 }
    }
    return { a: a.row, b: b.row }
  }

  app.get(path, async (c) => {
    const db = c.get('db')
    const r = await load(db, c.req.param('id') ?? '', c.req.query('into'))
    if ('page' in r) return c.html(r.page, r.status)
    return c.html(await confirmPage(db, r.a, r.b))
  })

  app.post(path, async (c) => {
    const db = c.get('db')
    const body = await c.req.parseBody()
    const into = typeof body.into === 'string' ? body.into : undefined
    const r = await load(db, c.req.param('id') ?? '', into)
    if ('page' in r) return c.html(r.page, r.status)
    if (body.confirm !== 'yes') {
      return c.html(
        await confirmPage(db, r.a, r.b, ['「確認しました」にチェックしてください']),
        400,
      )
    }
    await e.merge(db, r.a, r.b, currentUser(c).id)
    return c.redirect(`${e.base}/${r.b.id}?merged=1`, 302)
  })
}

const merge = new Hono<AppEnv>({ strict: false })

register(merge, workEntity)
register(merge, orgEntity)
register(merge, venueEntity)

export default merge
