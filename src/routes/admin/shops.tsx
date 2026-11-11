// 販売先の作成・編集（/admin/shops/*）。shop は merged_into_id が無いので統合済みの扱いは無い。
// requireOwner は admin/index.tsx で掛かる。

import { Hono } from 'hono'
import { emptyForm, type Form, formOf, shopFields, validateShop } from '../../admin/validate'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import { getShopRow, orgOptions, type ShopRow } from '../../db/master'
import { createShop, updateShop } from '../../db/master-write'
import type { AppEnv } from '../../env'
import { AdminNotFound, AdminPage, Saved, ShopForm } from '../../ui/admin'
import { TopBar } from '../../ui/components'

const shops = new Hono<AppEnv>({ strict: false })

const shopFormOf = (r: ShopRow): Form => ({
  name: r.name,
  kind: r.kind,
  url: r.url ?? '',
  organization_id: r.organizationId ?? '',
})

const notFound = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/shops" />
  </AdminPage>
)

const formPage = async (
  db: Db,
  p: { title: string; action: string; values: Form; errors?: readonly string[]; saved?: boolean },
) => (
  <AdminPage title={p.title}>
    <TopBar back="/admin/shops" label={p.title} />
    <div class="sect" style="margin-top:4px">
      {p.saved ? <Saved /> : null}
      <ShopForm action={p.action} values={p.values} errors={p.errors} orgs={await orgOptions(db)} />
    </div>
  </AdminPage>
)

shops.get('/shops/new', async (c) =>
  c.html(
    await formPage(c.get('db'), {
      title: '販売先を追加',
      action: '/admin/shops/new',
      values: emptyForm(shopFields),
    }),
  ),
)

shops.post('/shops/new', async (c) => {
  const db = c.get('db')
  const form = formOf(await c.req.parseBody(), shopFields)
  const v = await validateShop(db, form)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '販売先を追加',
        action: '/admin/shops/new',
        values: form,
        errors: v.errors,
      }),
      400,
    )
  }
  const id = await createShop(db, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/shops/${id}?saved=1`, 302)
})

shops.get('/shops/:id', async (c) => {
  const db = c.get('db')
  const row = await getShopRow(db, c.req.param('id'))
  if (!row) return c.html(notFound(), 404)
  return c.html(
    await formPage(db, {
      title: '販売先を編集',
      action: `/admin/shops/${row.id}`,
      values: shopFormOf(row),
      saved: c.req.query('saved') === '1',
    }),
  )
})

shops.post('/shops/:id', async (c) => {
  const db = c.get('db')
  const row = await getShopRow(db, c.req.param('id'))
  if (!row) return c.html(notFound(), 404)
  const form = formOf(await c.req.parseBody(), shopFields)
  const v = await validateShop(db, form, row.id)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '販売先を編集',
        action: `/admin/shops/${row.id}`,
        values: form,
        errors: v.errors,
      }),
      400,
    )
  }
  await updateShop(db, row, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/shops/${row.id}?saved=1`, 302)
})

export default shops
