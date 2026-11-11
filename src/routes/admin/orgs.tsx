// 団体の作成・編集と別名の追加・削除（/admin/orgs/*, /admin/org-aliases/*）。requireOwner は admin/index.tsx で掛かる。

import { Hono } from 'hono'
import {
  emptyForm,
  type Form,
  formOf,
  orgAliasFields,
  orgFields,
  validateOrg,
  validateOrgAlias,
} from '../../admin/validate'
import { currentUser } from '../../auth/middleware'
import { getAdminOrg, getOrgAliasRow, type OrgAliasRow, type OrgRow } from '../../db/master'
import { createOrg, createOrgAlias, deleteOrgAlias, updateOrg } from '../../db/master-write'
import type { AppEnv } from '../../env'
import {
  AdminNotFound,
  AdminPage,
  MergedDone,
  MergedNotice,
  MergeSection,
  OrgAliasSection,
  OrgForm,
  Saved,
} from '../../ui/admin'
import { TopBar } from '../../ui/components'

const orgs = new Hono<AppEnv>({ strict: false })

const orgFormOf = (r: OrgRow): Form => ({
  name: r.name,
  site_url: r.siteUrl ?? '',
  escape_id_url: r.escapeIdUrl ?? '',
  note: r.note ?? '',
})

const notFound = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/orgs" />
  </AdminPage>
)

const mergedPage = (into: { id: string; name: string } | null) => (
  <AdminPage title="団体を編集">
    <TopBar back="/admin/orgs" label="団体を編集" />
    {into ? <MergedNotice href={`/admin/orgs/${into.id}`} name={into.name} /> : null}
  </AdminPage>
)

const newPage = (values: Form, errors: readonly string[] = []) => (
  <AdminPage title="団体を追加">
    <TopBar back="/admin/orgs" label="団体を追加" />
    <div class="sect" style="margin-top:4px">
      <OrgForm action="/admin/orgs/new" values={values} errors={errors} />
    </div>
  </AdminPage>
)

const editPage = (p: {
  row: OrgRow
  aliases: readonly OrgAliasRow[]
  values?: Form
  errors?: readonly string[]
  aliasValues?: Form
  aliasErrors?: readonly string[]
  saved?: boolean
  merged?: boolean
}) => (
  <AdminPage title="団体を編集">
    <TopBar back="/admin/orgs" label="団体を編集" />
    <div class="sect" style="margin-top:4px">
      {p.saved ? <Saved /> : null}
      {p.merged ? <MergedDone /> : null}
      <OrgForm
        action={`/admin/orgs/${p.row.id}`}
        values={p.values ?? orgFormOf(p.row)}
        errors={p.errors}
      />
    </div>
    <OrgAliasSection
      orgId={p.row.id}
      aliases={p.aliases}
      values={p.aliasValues ?? emptyForm(orgAliasFields)}
      errors={p.aliasErrors}
    />
    <MergeSection label="団体" href={`/admin/orgs?merge_from=${p.row.id}`} />
  </AdminPage>
)

orgs.get('/orgs/new', (c) => c.html(newPage(emptyForm(orgFields))))

orgs.post('/orgs/new', async (c) => {
  const db = c.get('db')
  const form = formOf(await c.req.parseBody(), orgFields)
  const v = await validateOrg(db, form)
  if (!v.ok) return c.html(newPage(form, v.errors), 400)
  const id = await createOrg(db, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/orgs/${id}?saved=1`, 302)
})

orgs.get('/orgs/:id', async (c) => {
  const o = await getAdminOrg(c.get('db'), c.req.param('id'))
  if (!o) return c.html(notFound(), 404)
  if (o.row.mergedIntoId) return c.html(mergedPage(o.mergedInto))
  return c.html(
    editPage({ ...o, saved: c.req.query('saved') === '1', merged: c.req.query('merged') === '1' }),
  )
})

orgs.post('/orgs/:id', async (c) => {
  const db = c.get('db')
  const o = await getAdminOrg(db, c.req.param('id'))
  if (!o) return c.html(notFound(), 404)
  if (o.row.mergedIntoId) return c.html(mergedPage(o.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), orgFields)
  const v = await validateOrg(db, form, o.row.id)
  if (!v.ok) return c.html(editPage({ ...o, values: form, errors: v.errors }), 400)
  await updateOrg(db, o.row, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/orgs/${o.row.id}?saved=1`, 302)
})

orgs.post('/orgs/:id/aliases', async (c) => {
  const db = c.get('db')
  const o = await getAdminOrg(db, c.req.param('id'))
  if (!o) return c.html(notFound(), 404)
  if (o.row.mergedIntoId) return c.html(mergedPage(o.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), orgAliasFields)
  const v = validateOrgAlias(form)
  if (!v.ok) {
    return c.html(editPage({ ...o, aliasValues: form, aliasErrors: v.errors }), 400)
  }
  await createOrgAlias(db, o.row.id, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/orgs/${o.row.id}`, 302)
})

orgs.post('/org-aliases/:id/delete', async (c) => {
  const db = c.get('db')
  const a = await getOrgAliasRow(db, c.req.param('id'))
  if (!a) return c.html(notFound(), 404)
  // 親団体が統合済みなら追加と同じく 400
  const o = await getAdminOrg(db, a.organizationId)
  if (o?.row.mergedIntoId) return c.html(mergedPage(o.mergedInto), 400)
  await deleteOrgAlias(db, a, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/orgs/${a.organizationId}`, 302)
})

export default orgs
