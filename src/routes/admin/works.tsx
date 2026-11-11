// 作品の作成・編集と別名の追加・削除（/admin/works/*, /admin/work-aliases/*）。requireOwner は admin/index.tsx で掛かる。
// 作成時だけ名寄せ候補（findCandidates）を見て、score ≥ SIMILAR_MIN があれば止める（同じ題名での再送は 1 回で通す）。
// findCandidates は完全一致だけを返すので、止まるのは題名・別名が norm で一致するときだけ。

import { Hono } from 'hono'
import {
  emptyForm,
  type Form,
  formOf,
  validateWork,
  validateWorkAlias,
  workAliasFields,
  workFields,
} from '../../admin/validate'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import {
  getAdminWork,
  getWorkAliasRow,
  orgOptions,
  type RunRow,
  type WorkAliasRow,
  type WorkRow,
} from '../../db/master'
import { createWork, createWorkAlias, deleteWorkAlias, updateWork } from '../../db/master-write'
import { findCandidates } from '../../db/match'
import type { AppEnv } from '../../env'
import { type Candidate, SIMILAR_MIN } from '../../lib/match'
import { norm } from '../../lib/norm'
import {
  AdminNotFound,
  AdminPage,
  MergedDone,
  MergedNotice,
  MergeSection,
  Saved,
  WorkAliasSection,
  WorkForm,
  WorkRunsSection,
} from '../../ui/admin'
import { TopBar } from '../../ui/components'

const works = new Hono<AppEnv>({ strict: false })

const num = (n: number | null) => (n === null ? '' : String(n))

const workFormOf = (r: WorkRow): Form => ({
  title: r.title,
  kind: r.kind ?? '',
  primary_organization_id: r.primaryOrganizationId ?? '',
  official_url: r.officialUrl ?? '',
  description: r.description ?? '',
  player_min: num(r.playerMin),
  player_max: num(r.playerMax),
  estimated_minutes: num(r.estimatedMinutes),
  time_limit_minutes: num(r.timeLimitMinutes),
  first_released_on: r.firstReleasedOn ?? '',
})

const notFound = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/works" />
  </AdminPage>
)

const mergedPage = (into: { id: string; name: string } | null) => (
  <AdminPage title="作品を編集">
    <TopBar back="/admin/works" label="作品を編集" />
    {into ? <MergedNotice href={`/admin/works/${into.id}`} name={into.name} /> : null}
  </AdminPage>
)

const newPage = async (
  db: Db,
  p: {
    values: Form
    errors?: readonly string[]
    candidates?: readonly Candidate[]
    confirm?: string
  },
) => (
  <AdminPage title="作品を追加">
    <TopBar back="/admin/works" label="作品を追加" />
    <div class="sect" style="margin-top:4px">
      <WorkForm action="/admin/works/new" orgs={await orgOptions(db)} {...p} />
    </div>
  </AdminPage>
)

const editPage = async (
  db: Db,
  p: {
    row: WorkRow
    aliases: readonly WorkAliasRow[]
    runs: readonly RunRow[]
    values?: Form
    errors?: readonly string[]
    aliasValues?: Form
    aliasErrors?: readonly string[]
    saved?: boolean
    merged?: boolean
  },
) => (
  <AdminPage title="作品を編集">
    <TopBar back="/admin/works" label="作品を編集" />
    <div class="sect" style="margin-top:4px">
      {p.saved ? <Saved /> : null}
      {p.merged ? <MergedDone /> : null}
      <WorkForm
        action={`/admin/works/${p.row.id}`}
        values={p.values ?? workFormOf(p.row)}
        errors={p.errors}
        orgs={await orgOptions(db)}
      />
    </div>
    <WorkRunsSection workId={p.row.id} runs={p.runs} />
    <WorkAliasSection
      workId={p.row.id}
      aliases={p.aliases}
      values={p.aliasValues ?? emptyForm(workAliasFields)}
      errors={p.aliasErrors}
    />
    <MergeSection label="作品" href={`/admin/works?merge_from=${p.row.id}`} />
  </AdminPage>
)

works.get('/works/new', async (c) =>
  c.html(await newPage(c.get('db'), { values: emptyForm(workFields) })),
)

works.post('/works/new', async (c) => {
  const db = c.get('db')
  const body = await c.req.parseBody()
  const form = formOf(body, workFields)
  // confirm は候補を見て確認済みの norm(title)。題名を変えたら再チェックする
  const confirm = typeof body.confirm === 'string' ? body.confirm : ''
  const v = await validateWork(db, form)
  if (!v.ok) {
    return c.html(
      await newPage(db, { values: form, errors: v.errors, confirm: confirm || undefined }),
      400,
    )
  }
  const titleNorm = norm(v.value.title)
  if (confirm !== titleNorm) {
    const orgName = v.value.primaryOrganizationId
      ? (await orgOptions(db)).find((o) => o.id === v.value.primaryOrganizationId)?.name
      : undefined
    const m = await findCandidates(db, { title: v.value.title, org: orgName })
    const candidates = m.works.filter((w) => w.score >= SIMILAR_MIN)
    if (candidates.length) {
      return c.html(await newPage(db, { values: form, candidates, confirm: titleNorm }), 400)
    }
  }
  const id = await createWork(db, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${id}?saved=1`, 302)
})

works.get('/works/:id', async (c) => {
  const db = c.get('db')
  const w = await getAdminWork(db, c.req.param('id'))
  if (!w) return c.html(notFound(), 404)
  if (w.row.mergedIntoId) return c.html(mergedPage(w.mergedInto))
  return c.html(
    await editPage(db, {
      ...w,
      saved: c.req.query('saved') === '1',
      merged: c.req.query('merged') === '1',
    }),
  )
})

// 編集時は重複チェックをしない
works.post('/works/:id', async (c) => {
  const db = c.get('db')
  const w = await getAdminWork(db, c.req.param('id'))
  if (!w) return c.html(notFound(), 404)
  if (w.row.mergedIntoId) return c.html(mergedPage(w.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), workFields)
  const v = await validateWork(db, form, w.row.id)
  if (!v.ok) return c.html(await editPage(db, { ...w, values: form, errors: v.errors }), 400)
  await updateWork(db, w.row, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${w.row.id}?saved=1`, 302)
})

works.post('/works/:id/aliases', async (c) => {
  const db = c.get('db')
  const w = await getAdminWork(db, c.req.param('id'))
  if (!w) return c.html(notFound(), 404)
  if (w.row.mergedIntoId) return c.html(mergedPage(w.mergedInto), 400)
  const form = formOf(await c.req.parseBody(), workAliasFields)
  const v = validateWorkAlias(form)
  if (!v.ok) {
    return c.html(await editPage(db, { ...w, aliasValues: form, aliasErrors: v.errors }), 400)
  }
  await createWorkAlias(db, w.row.id, v.value, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${w.row.id}`, 302)
})

works.post('/work-aliases/:id/delete', async (c) => {
  const db = c.get('db')
  const a = await getWorkAliasRow(db, c.req.param('id'))
  if (!a) return c.html(notFound(), 404)
  // 親作品が統合済みなら追加と同じく 400
  const w = await getAdminWork(db, a.workId)
  if (w?.row.mergedIntoId) return c.html(mergedPage(w.mergedInto), 400)
  await deleteWorkAlias(db, a, { actor: { userId: currentUser(c).id } })
  return c.redirect(`/admin/works/${a.workId}`, 302)
})

export default works
