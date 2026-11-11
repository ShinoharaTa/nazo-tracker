// リクエストの一覧・選別（/admin/requests*）。requireOwner は admin/index.tsx で掛かる。
// 依頼者は表示名だけを出し、記録は読まない。状態の遷移は src/requests/transitions.ts の canTransition で判定する。

import { type Context, Hono } from 'hono'
import {
  type AdminRequest,
  type AdminRequestTab,
  adminRequestTabs,
  countRequests,
  getRequest,
  listRequests,
  setRequestStatus,
  workTitleOf,
} from '../../db/requests'
import type { AppEnv } from '../../env'
import { type Form, formOf } from '../../lib/form'
import { canTransition } from '../../requests/transitions'
import { isOwnerTarget, parseStatusChange, statusChangeFields } from '../../requests/validate'
import { AdminNotFound, AdminPage } from '../../ui/admin'
import { AdminRequestDetail, AdminRequestsList } from '../../ui/requests'
import { toPage } from '../ui'

const requests = new Hono<AppEnv>({ strict: false })

// 依頼者の表示名・入力値を含むので共有キャッシュに載せない（/requests 自体も含む）
requests.use('/requests/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
})

const toTab = (v: string | undefined): AdminRequestTab =>
  (adminRequestTabs as readonly string[]).includes(v ?? '') ? (v as AdminRequestTab) : 'open'

const notFoundPage = () => (
  <AdminPage title="見つかりませんでした">
    <AdminNotFound back="/admin/requests" />
  </AdminPage>
)

const detailPage = async (
  c: Context<AppEnv>,
  r: AdminRequest,
  opts: { saved?: boolean; values?: Form; errors?: string[] } = {},
) => {
  const t = r.payload.target_id ? await workTitleOf(c.get('db'), r.payload.target_id) : null
  return (
    <AdminPage title="リクエスト">
      <AdminRequestDetail r={r} target={t ? { id: t.id, title: t.title } : null} {...opts} />
    </AdminPage>
  )
}

const INVALID_TRANSITION = 'この状態からは変えられません。'

requests.get('/requests', async (c) => {
  const db = c.get('db')
  const tab = toTab(c.req.query('status'))
  const page = toPage(c.req.query('page'))
  const [{ items, hasNext }, openCount] = await Promise.all([
    listRequests(db, { status: tab, page }),
    countRequests(db, 'open'),
  ])
  return c.html(
    <AdminPage title="リクエスト">
      <AdminRequestsList
        tab={tab}
        openCount={openCount}
        items={items}
        page={page}
        hasNext={hasNext}
      />
    </AdminPage>,
  )
})

requests.get('/requests/:id', async (c) => {
  const r = await getRequest(c.get('db'), c.req.param('id'))
  if (!r) return c.html(notFoundPage(), 404)
  return c.html(await detailPage(c, r, { saved: c.req.query('saved') === '1' }))
})

requests.post('/requests/:id/status', async (c) => {
  const db = c.get('db')
  const r = await getRequest(db, c.req.param('id'))
  if (!r) return c.html(notFoundPage(), 404)
  const f = formOf(await c.req.parseBody(), statusChangeFields)
  if (!isOwnerTarget(f.to) || !canTransition(r.status, f.to, 'owner')) {
    return c.html(await detailPage(c, r, { values: f, errors: [INVALID_TRANSITION] }), 400)
  }
  const v = parseStatusChange(f, f.to)
  if (!v.ok) return c.html(await detailPage(c, r, { values: f, errors: v.errors }), 400)
  const res = await setRequestStatus(db, r.id, f.to, v.value, 'owner')
  if (res === 'not_found') return c.html(notFoundPage(), 404)
  if (res === 'invalid_transition') {
    // 読んでから書くまでの間に状態が変わった
    const now = await getRequest(db, r.id)
    if (!now) return c.html(notFoundPage(), 404)
    return c.html(await detailPage(c, now, { values: f, errors: [INVALID_TRANSITION] }), 400)
  }
  return c.redirect(`/admin/requests/${encodeURIComponent(r.id)}?saved=1`, 302)
})

export default requests
