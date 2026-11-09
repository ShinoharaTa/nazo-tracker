// オーナー画面 /admin/*。全ページ requireOwner（未ログイン GET は 302 /login、POST は 401、member は 404）。
// メニューと管理一覧はここ、作成・編集は orgs / venues / shops。JS は使わず HTML form の POST だけ。

import { Hono } from 'hono'
import { requireOwner } from '../../auth/middleware'
import { listAdminOrgs, listAdminShops, listAdminVenues, listAdminWorks } from '../../db/master'
import type { AppEnv } from '../../env'
import { AdminList, type AdminListRow, AdminNotFound, AdminPage } from '../../ui/admin'
import { Menu, MenuItem, TopBar } from '../../ui/components'
import { shopKindLabels, workKindLabels } from '../../ui/labels'
import orgs from './orgs'
import shops from './shops'
import venues from './venues'

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

admin.get('/', (c) =>
  c.html(
    <AdminPage title="マスタ管理">
      <TopBar back="/settings" label="マスタ管理" />
      <div class="sect" style="margin-top:4px">
        <h2>作品</h2>
        <Menu>
          <MenuItem label="作品の一覧" href="/admin/works" />
          <MenuItem label="作品を追加" note="P2 の続きで実装" disabled />
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
}) => (
  <AdminPage title={p.label}>
    <AdminList {...p} />
  </AdminPage>
)

admin.get('/works', async (c) => {
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminWorks(c.get('db'), { q, page })
  const rows = items.map((w) => ({
    href: `/admin/works/${w.id}`,
    label: w.title,
    note: mergedNote(
      w.mergedInto,
      [w.kind ? workKindLabels[w.kind] : null, w.orgName].filter(Boolean).join(' · ') || null,
    ),
  }))
  return c.html(listPage({ label: '作品', base: '/admin/works', q, page, hasNext, rows }))
})

admin.get('/orgs', async (c) => {
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminOrgs(c.get('db'), { q, page })
  const rows = items.map((o) => ({
    href: `/admin/orgs/${o.id}`,
    label: o.name,
    note: mergedNote(o.mergedInto, o.note),
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
    }),
  )
})

admin.get('/venues', async (c) => {
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listAdminVenues(c.get('db'), { q, page })
  const rows = items.map((v) => ({
    href: `/admin/venues/${v.id}`,
    label: v.name,
    note: mergedNote(v.mergedInto, v.note),
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

// 作品の編集は P2-4 で差し替える。それまでは Layout 付きの 404
admin.get('/works/:id', (c) =>
  c.html(
    <AdminPage title="見つかりませんでした">
      <AdminNotFound back="/admin/works" />
    </AdminPage>,
    404,
  ),
)

admin.route('/', orgs)
admin.route('/', venues)
admin.route('/', shops)

export default admin
