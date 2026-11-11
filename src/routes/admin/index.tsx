// オーナー画面 /admin/*。全ページ requireOwner（未ログイン GET は 302 /login、POST は 401、member は 404）。
// メニューと管理一覧はここ、作成・編集は works / runs / orgs / venues / shops。JS は使わず HTML form の POST だけ。

import { Hono } from 'hono'
import { requireOwner } from '../../auth/middleware'
import type { Db } from '../../db/client'
import {
  getAdminOrg,
  getAdminVenue,
  getAdminWork,
  listAdminOrgs,
  listAdminShops,
  listAdminVenues,
  listAdminWorks,
} from '../../db/master'
import type { AppEnv } from '../../env'
import {
  AdminList,
  type AdminListRow,
  AdminNotFound,
  AdminPage,
  type MergeFrom,
} from '../../ui/admin'
import { Menu, MenuItem, TopBar } from '../../ui/components'
import { shopKindLabels, workKindLabels } from '../../ui/labels'
import merge from './merge'
import orgs from './orgs'
import requests from './requests'
import runs from './runs'
import shops from './shops'
import tokens from './tokens'
import venues from './venues'
import works from './works'

const admin = new Hono<AppEnv>({ strict: false })

// /admin 自体も含む
admin.use('*', requireOwner)

// 1 始まり。不正値は 1（src/routes/ui.tsx の作品一覧と同じ）
const toPage = (v: string | undefined): number => {
  if (!v || !/^[1-9]\d{0,8}$/.test(v)) return 1
  return Number(v)
}

const mergedNote = (m: { name: string } | null, note?: string | null) =>
  m ? `統合済み → ${m.name}` : note

// ?merge_from=A（統合先を選ぶモード）の A。A が無い・統合済みなら 'missing'、指定が無ければ undefined
const mergeFromOf = async <R extends { id: string; mergedIntoId: string | null }>(
  db: Db,
  id: string | undefined,
  base: string,
  get: (db: Db, id: string) => Promise<{ row: R } | null>,
  name: (row: R) => string,
): Promise<MergeFrom | 'missing' | undefined> => {
  if (!id) return undefined
  const a = await get(db, id)
  if (!a || a.row.mergedIntoId) return 'missing'
  return {
    id: a.row.id,
    name: name(a.row),
    back: `${base}/${a.row.id}`,
    action: `${base}/${a.row.id}/merge`,
  }
}

// 統合先の候補にできるか（A 自身と統合済みの行は不可）
const mergeTarget = (m: MergeFrom | undefined, id: string, merged: unknown) =>
  m && id !== m.id && !merged ? id : undefined

const notFoundPage = (back: string) => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back={back} />
  </AdminPage>
)

admin.get('/', (c) =>
  c.html(
    <AdminPage title="マスタ管理">
      <TopBar back="/settings" label="マスタ管理" />
      <div class="sect" style="margin-top:4px">
        <h2>作品</h2>
        <Menu>
          <MenuItem label="作品の一覧" href="/admin/works" />
          <MenuItem label="作品を追加" href="/admin/works/new" />
        </Menu>
      </div>
      <div class="sect">
        <h2>団体</h2>
        <Menu>
          <MenuItem label="団体の一覧" href="/admin/orgs" />
          <MenuItem label="団体を追加" href="/admin/orgs/new" />
        </Menu>
      </div>
      <div class="sect">
        <h2>会場</h2>
        <Menu>
          <MenuItem label="会場の一覧" href="/admin/venues" />
          <MenuItem label="会場を追加" href="/admin/venues/new" />
        </Menu>
      </div>
      <div class="sect">
        <h2>販売先</h2>
        <Menu>
          <MenuItem label="販売先の一覧" href="/admin/shops" />
          <MenuItem label="販売先を追加" href="/admin/shops/new" />
        </Menu>
      </div>
    </AdminPage>,
  ),
)

// 管理一覧 4 つ。統合済みの行も出し、note に統合先を書く
const listPage = (p: {
  label: string
  base: string
  newHref?: string
  q: string
  page: number
  hasNext: boolean
  rows: AdminListRow[]
  mergeFrom?: MergeFrom
}) => (
  <AdminPage title={p.label}>
    <AdminList {...p} />
  </AdminPage>
)

admin.get('/works', async (c) => {
  const db = c.get('db')
  const m = await mergeFromOf(
    db,
    c.req.query('merge_from'),
    '/admin/works',
    getAdminWork,
    (r) => r.title,
  )
  if (m === 'missing') return c.html(notFoundPage('/admin/works'), 404)
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminWorks(db, { q, page })
  const rows = items.map((w) => ({
    href: `/admin/works/${w.id}`,
    label: w.title,
    note: mergedNote(
      w.mergedInto,
      [w.kind ? workKindLabels[w.kind] : null, w.orgName].filter(Boolean).join(' · ') || null,
    ),
    mergeInto: mergeTarget(m, w.id, w.mergedInto),
  }))
  return c.html(
    listPage({
      label: '作品',
      base: '/admin/works',
      newHref: '/admin/works/new',
      q,
      page,
      hasNext,
      rows,
      mergeFrom: m,
    }),
  )
})

admin.get('/orgs', async (c) => {
  const db = c.get('db')
  const m = await mergeFromOf(
    db,
    c.req.query('merge_from'),
    '/admin/orgs',
    getAdminOrg,
    (r) => r.name,
  )
  if (m === 'missing') return c.html(notFoundPage('/admin/orgs'), 404)
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminOrgs(db, { q, page })
  const rows = items.map((o) => ({
    href: `/admin/orgs/${o.id}`,
    label: o.name,
    note: mergedNote(o.mergedInto, o.note),
    mergeInto: mergeTarget(m, o.id, o.mergedInto),
  }))
  return c.html(
    listPage({
      label: '団体',
      base: '/admin/orgs',
      newHref: '/admin/orgs/new',
      q,
      page,
      hasNext,
      rows,
      mergeFrom: m,
    }),
  )
})

admin.get('/venues', async (c) => {
  const db = c.get('db')
  const m = await mergeFromOf(
    db,
    c.req.query('merge_from'),
    '/admin/venues',
    getAdminVenue,
    (r) => r.name,
  )
  if (m === 'missing') return c.html(notFoundPage('/admin/venues'), 404)
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminVenues(db, { q, page })
  const rows = items.map((v) => ({
    href: `/admin/venues/${v.id}`,
    label: v.name,
    note: mergedNote(v.mergedInto, v.note),
    mergeInto: mergeTarget(m, v.id, v.mergedInto),
  }))
  return c.html(
    listPage({
      label: '会場',
      base: '/admin/venues',
      newHref: '/admin/venues/new',
      q,
      page,
      hasNext,
      rows,
      mergeFrom: m,
    }),
  )
})

admin.get('/shops', async (c) => {
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminShops(c.get('db'), { q, page })
  const rows = items.map((s) => ({
    href: `/admin/shops/${s.id}`,
    label: s.name,
    note: shopKindLabels[s.kind],
  }))
  return c.html(
    listPage({
      label: '販売先',
      base: '/admin/shops',
      newHref: '/admin/shops/new',
      q,
      page,
      hasNext,
      rows,
    }),
  )
})

admin.route('/', works)
admin.route('/', merge)
admin.route('/', runs)
admin.route('/', orgs)
admin.route('/', venues)
admin.route('/', shops)
admin.route('/', tokens)
admin.route('/', requests)

export default admin
