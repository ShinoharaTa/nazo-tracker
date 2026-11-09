// 会場の作成・編集（/admin/venues/*）。requireOwner は admin/index.tsx で掛かる。

import { Hono } from 'hono'
import { emptyForm, type Form, formOf, validateVenue, venueFields } from '../../admin/validate'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import { getAdminVenue, orgOptions, type VenueRow } from '../../db/master'
import { createVenue, updateVenue } from '../../db/master-write'
import type { AppEnv } from '../../env'
import {
  AdminNotFound,
  AdminPage,
  MergedDone,
  MergedNotice,
  MergeSection,
  Saved,
  VenueForm,
} from '../../ui/admin'
import { TopBar } from '../../ui/components'

const venues = new Hono<AppEnv>({ strict: false })

const venueFormOf = (r: VenueRow): Form => ({
  name: r.name,
  prefecture: r.prefecture ?? '',
  address: r.address ?? '',
  organization_id: r.organizationId ?? '',
})

const notFound = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/venues" />
  </AdminPage>
)

const mergedPage = (into: { id: string; name: string } | null) => (
  <AdminPage title="会場を編集">
    <TopBar back="/admin/venues" label="会場を編集" />
    {into ? <MergedNotice href={`/admin/venues/${into.id}`} name={into.name} /> : null}
  </AdminPage>
)

const formPage = async (
  db: Db,
  p: {
    title: string
    action: string
    values: Form
    errors?: readonly string[]
    saved?: boolean
    merged?: boolean
    // 編集のときだけ。統合の節を出す
    id?: string
  },
) => (
  <AdminPage title={p.title}>
    <TopBar back="/admin/venues" label={p.title} />
    <div class="sect" style="margin-top:4px">
      {p.saved ? <Saved /> : null}
      {p.merged ? <MergedDone /> : null}
      <VenueForm
        action={p.action}
        values={p.values}
        errors={p.errors}
        orgs={await orgOptions(db)}
      />
    </div>
    {p.id ? <MergeSection label="会場" href={`/admin/venues?merge_from=${p.id}`} /> : null}
  </AdminPage>
)

venues.get('/venues/new', async (c) =>
  c.html(
    await formPage(c.get('db'), {
      title: '会場を追加',
      action: '/admin/venues/new',
      values: emptyForm(venueFields),
    }),
  ),
)

venues.post('/venues/new', async (c) => {
  const db = c.get('db')
  const form = formOf(await c.req.parseBody(), venueFields)
  const v = await validateVenue(db, form)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '会場を追加',
        action: '/admin/venues/new',
        values: form,
        errors: v.errors,
      }),
      400,
    )
  }
  const id = await createVenue(db, v.value, currentUser(c).id)
  return c.redirect(`/admin/venues/${id}?saved=1`, 302)
})

venues.get('/venues/:id', async (c) => {
  const db = c.get('db')
  const r = await getAdminVenue(db, c.req.param('id'))
  if (!r) return c.html(notFound(), 404)
  if (r.row.mergedIntoId) return c.html(mergedPage(r.mergedInto))
  return c.html(
    await formPage(db, {
      title: '会場を編集',
      action: `/admin/venues/${r.row.id}`,
      values: venueFormOf(r.row),
      saved: c.req.query('saved') === '1',
      merged: c.req.query('merged') === '1',
      id: r.row.id,
    }),
  )
})

venues.post('/venues/:id', async (c) => {
  const db = c.get('db')
  const r = await getAdminVenue(db, c.req.param('id'))
  if (!r) return c.html(notFound(), 404)
  if (r.row.mergedIntoId) return c.html(mergedPage(r.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), venueFields)
  const v = await validateVenue(db, form)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '会場を編集',
        action: `/admin/venues/${r.row.id}`,
        values: form,
        errors: v.errors,
        id: r.row.id,
      }),
      400,
    )
  }
  await updateVenue(db, r.row, v.value, currentUser(c).id)
  return c.redirect(`/admin/venues/${r.row.id}?saved=1`, 302)
})

export default venues
