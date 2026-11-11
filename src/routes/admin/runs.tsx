// 回の作成・編集（/admin/works/:id/runs/new, /admin/runs/:id）。削除はしない。requireOwner は admin/index.tsx で掛かる。
// 親の作品は URL の :id（作成）か run.work_id（編集）から取り、body の work_id は受け取らない。

import { Hono } from 'hono'
import { emptyForm, type Form, formOf, runFields, validateRun } from '../../admin/validate'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import {
  getAdminWork,
  getRunRow,
  orgOptions,
  type RunDbRow,
  shopOptions,
  venueOptions,
} from '../../db/master'
import { createRun, updateRun } from '../../db/master-write'
import type { AppEnv } from '../../env'
import { AdminNotFound, AdminPage, MergedNotice, RunForm, Saved } from '../../ui/admin'
import { TopBar } from '../../ui/components'

const runs = new Hono<AppEnv>({ strict: false })

const runFormOf = (r: RunDbRow): Form => ({
  channel: r.channel,
  organization_id: r.organizationId ?? '',
  billed_as: r.billedAs ?? '',
  venue_id: r.venueId ?? '',
  shop_id: r.shopId ?? '',
  start_on: r.startOn ?? '',
  end_on: r.endOn ?? '',
  is_permanent: r.isPermanent === 1 ? '1' : '',
  escape_id_url: r.escapeIdUrl ?? '',
  ticket_url: r.ticketUrl ?? '',
  price_yen: r.priceYen === null ? '' : String(r.priceYen),
  escape_type_raw: r.escapeTypeRaw ?? '',
  note: r.note ?? '',
})

const notFound = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/works" />
  </AdminPage>
)

const mergedPage = (into: { id: string; name: string } | null) => (
  <AdminPage title="回を編集">
    <TopBar back="/admin/works" label="回を編集" />
    {into ? <MergedNotice href={`/admin/works/${into.id}`} name={into.name} /> : null}
  </AdminPage>
)

const formPage = async (
  db: Db,
  p: {
    title: string
    action: string
    work: { id: string; title: string }
    values: Form
    errors?: readonly string[]
    saved?: boolean
  },
) => {
  const [orgs, venues, shops] = await Promise.all([
    orgOptions(db),
    venueOptions(db),
    shopOptions(db),
  ])
  return (
    <AdminPage title={p.title}>
      <TopBar back={`/admin/works/${p.work.id}`} label={p.title} />
      <div class="sect" style="margin-top:4px">
        <p class="note">{p.work.title}</p>
        {p.saved ? <Saved /> : null}
        <RunForm
          action={p.action}
          values={p.values}
          errors={p.errors}
          orgs={orgs}
          venues={venues}
          shops={shops}
        />
      </div>
    </AdminPage>
  )
}

const workOf = (w: { row: { id: string; title: string } }) => ({ id: w.row.id, title: w.row.title })

runs.get('/works/:id/runs/new', async (c) => {
  const db = c.get('db')
  const w = await getAdminWork(db, c.req.param('id'))
  if (!w) return c.html(notFound(), 404)
  if (w.row.mergedIntoId) return c.html(mergedPage(w.mergedInto))
  // 名義団体の既定は作品の団体
  const values = { ...emptyForm(runFields), organization_id: w.row.primaryOrganizationId ?? '' }
  return c.html(
    await formPage(db, {
      title: '回を追加',
      action: `/admin/works/${w.row.id}/runs/new`,
      work: workOf(w),
      values,
    }),
  )
})

runs.post('/works/:id/runs/new', async (c) => {
  const db = c.get('db')
  const w = await getAdminWork(db, c.req.param('id'))
  if (!w) return c.html(notFound(), 404)
  if (w.row.mergedIntoId) return c.html(mergedPage(w.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), runFields)
  const v = await validateRun(db, form)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '回を追加',
        action: `/admin/works/${w.row.id}/runs/new`,
        work: workOf(w),
        values: form,
        errors: v.errors,
      }),
      400,
    )
  }
  await createRun(db, w.row.id, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${w.row.id}?saved=1`, 302)
})

// 回の親作品。統合済みの作品の回は編集させない
const runWithWork = async (db: Db, id: string) => {
  const row = await getRunRow(db, id)
  if (!row) return null
  const w = await getAdminWork(db, row.workId)
  return w ? { row, w } : null
}

runs.get('/runs/:id', async (c) => {
  const db = c.get('db')
  const r = await runWithWork(db, c.req.param('id'))
  if (!r) return c.html(notFound(), 404)
  if (r.w.row.mergedIntoId) return c.html(mergedPage(r.w.mergedInto))
  return c.html(
    await formPage(db, {
      title: '回を編集',
      action: `/admin/runs/${r.row.id}`,
      work: workOf(r.w),
      values: runFormOf(r.row),
      saved: c.req.query('saved') === '1',
    }),
  )
})

runs.post('/runs/:id', async (c) => {
  const db = c.get('db')
  const r = await runWithWork(db, c.req.param('id'))
  if (!r) return c.html(notFound(), 404)
  if (r.w.row.mergedIntoId) return c.html(mergedPage(r.w.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), runFields)
  const v = await validateRun(db, form, r.row.id)
  if (!v.ok) {
    return c.html(
      await formPage(db, {
        title: '回を編集',
        action: `/admin/runs/${r.row.id}`,
        work: workOf(r.w),
        values: form,
        errors: v.errors,
      }),
      400,
    )
  }
  await updateRun(db, r.row, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${r.row.workId}?saved=1`, 302)
})

export default runs
