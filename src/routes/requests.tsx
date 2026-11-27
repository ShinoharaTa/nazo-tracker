// メンバーのリクエスト（/requests/*）。読み書きは全て requester_user_id = 本人（src/db/requests.ts）。
// 他人の id・無い id は 404（区別しない）。リダイレクト先はサーバーで組み立てる。

import { type Context, Hono } from 'hono'
import { currentUser, requireUser } from '../auth/middleware'
import type { SessionUser } from '../auth/session'
import type { Db } from '../db/client'
import { appliedWorkOfRequest, rejectedOnlyRequests } from '../db/proposals'
import {
  countRecentRequests,
  createRequestIfAllowed,
  getOwnRequest,
  hasOpenRequestWithUrl,
  listOwnRequests,
  type OwnRequest,
  replyOwnRequest,
  workTitleOf,
} from '../db/requests'
import type { AppEnv } from '../env'
import { type Form, formOf } from '../lib/form'
import { canTransition } from '../requests/transitions'
import {
  isMemberRequestKind,
  parseReply,
  parseRequest,
  replyFields,
  requestFields,
} from '../requests/validate'
import { Layout } from '../ui/Layout'
import { NewRequestForm, RequestDetail, RequestsList } from '../ui/requests'
import { NotFound, toPage } from './ui'

// 直近 24 時間に作れる件数（オーナーは対象外）
const DAILY_LIMIT = 20

const LIMIT_MESSAGE = 'リクエストは 1 日 20 件までです。時間をおいてからお願いします。'

// 上限・重複に当たっていれば文言。当たっていなければ null
const requestLimitError = async (
  db: Db,
  user: SessionUser,
  url: string | undefined,
): Promise<string | null> => {
  if (user.role !== 'owner' && (await countRecentRequests(db, user.id)) >= DAILY_LIMIT) {
    return LIMIT_MESSAGE
  }
  if (url && (await hasOpenRequestWithUrl(db, user.id, url))) {
    return '同じ URL のリクエストを受け付けています。'
  }
  return null
}

const requests = new Hono<AppEnv>({ strict: false })

// /requests 自体も含む
requests.use('*', requireUser)

// 本人のデータしか返さないので共有キャッシュに載せない
requests.use('*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
})

const requestsList = async (c: Context<AppEnv>, page = 1) => {
  const db = c.get('db')
  const { items, hasNext } = await listOwnRequests(db, currentUser(c).id, page)
  const rejectedOnly = await rejectedOnlyRequests(
    db,
    items.filter((r) => r.status === 'done').map((r) => r.id),
  )
  return <RequestsList items={items} page={page} hasNext={hasNext} rejectedOnly={rejectedOnly} />
}

const notFoundPage = async (c: Context<AppEnv>) =>
  c.html(
    <Layout
      title="見つかりませんでした"
      tab="settings"
      left={await requestsList(c)}
      right={<NotFound back="/requests" />}
    />,
    404,
  )

// fix_work の対象作品。未統合のものだけ（統合済み・無い id は null）
const liveTarget = async (c: Context<AppEnv>, f: Form) => {
  if (f.kind !== 'fix_work' || !f.target) return null
  const w = await workTitleOf(c.get('db'), f.target)
  return w?.live ? { id: w.id, title: w.title } : null
}

const newPage = async (
  c: Context<AppEnv>,
  values: Form,
  target: { id: string; title: string } | null,
  errors?: string[],
) => (
  <Layout
    title="リクエストする"
    tab="settings"
    left={await requestsList(c)}
    right={<NewRequestForm values={values} target={target} errors={errors} />}
  />
)

const detailPage = async (
  c: Context<AppEnv>,
  r: OwnRequest,
  opts: { created?: boolean; replyValue?: string; errors?: string[] } = {},
) => {
  const db = c.get('db')
  const done = r.status === 'done'
  const [t, workId, rejectedOnly] = await Promise.all([
    r.payload.target_id ? workTitleOf(db, r.payload.target_id) : null,
    done ? appliedWorkOfRequest(db, r.id) : null,
    done ? rejectedOnlyRequests(db, [r.id]) : new Set<string>(),
  ])
  return (
    <Layout
      title="リクエスト"
      tab="settings"
      left={await requestsList(c)}
      right={
        <RequestDetail
          r={r}
          target={t ? { id: t.id, title: t.title } : null}
          workId={workId}
          rejectedOnly={rejectedOnly.has(r.id)}
          {...opts}
        />
      }
    />
  )
}

requests.get('/', async (c) => {
  const page = toPage(c.req.query('page'))
  return c.html(<Layout title="リクエスト" tab="settings" left={await requestsList(c, page)} />)
})

// クエリは初期値（kind が選べない値なら作品の追加）
requests.get('/new', async (c) => {
  const kind = c.req.query('kind') ?? ''
  const values: Form = {
    kind: isMemberRequestKind(kind) ? kind : 'new_work',
    url: '',
    title: c.req.query('title') ?? '',
    organization: '',
    note: '',
    target: c.req.query('target') ?? '',
  }
  return c.html(await newPage(c, values, await liveTarget(c, values)))
})

requests.post('/', async (c) => {
  const user = currentUser(c)
  const db = c.get('db')
  const f = formOf(await c.req.parseBody(), requestFields)
  const target = await liveTarget(c, f)
  const v = parseRequest(f, { targetId: target?.id ?? null })
  if (!v.ok) return c.html(await newPage(c, f, target, v.errors), 400)
  // 事前チェックは文言を出し分けるため。最終判定は条件付き INSERT（同時に送られても上限・重複を超えない）
  const limitError = await requestLimitError(db, user, v.value.payload.url)
  if (limitError) return c.html(await newPage(c, f, target, [limitError]), 400)
  const id = await createRequestIfAllowed(
    db,
    user.id,
    v.value.kind,
    v.value.payload,
    user.role === 'owner' ? null : DAILY_LIMIT,
  )
  if (!id) {
    // 事前チェックと INSERT の間に他の送信が入った。もう一度見て該当する文言を出す
    const err = (await requestLimitError(db, user, v.value.payload.url)) ?? LIMIT_MESSAGE
    return c.html(await newPage(c, f, target, [err]), 400)
  }
  return c.redirect(`/requests/${id}?created=1`, 302)
})

requests.get('/:id', async (c) => {
  const r = await getOwnRequest(c.get('db'), currentUser(c).id, c.req.param('id'))
  if (!r) return notFoundPage(c)
  return c.html(await detailPage(c, r, { created: c.req.query('created') === '1' }))
})

requests.post('/:id/reply', async (c) => {
  const db = c.get('db')
  const userId = currentUser(c).id
  const id = c.req.param('id')
  const r = await getOwnRequest(db, userId, id)
  if (!r) return notFoundPage(c)
  const f = formOf(await c.req.parseBody(), replyFields)
  if (!canTransition(r.status, 'open', 'requester')) {
    return c.html(await detailPage(c, r, { errors: ['この状態からは変えられません。'] }), 400)
  }
  const v = parseReply(f)
  if (!v.ok) return c.html(await detailPage(c, r, { replyValue: f.reply, errors: v.errors }), 400)
  const res = await replyOwnRequest(db, userId, id, v.value)
  if (res === 'not_found') return notFoundPage(c)
  if (res === 'invalid_state') {
    // 読んでから書くまでの間に状態が変わった
    const now = await getOwnRequest(db, userId, id)
    if (!now) return notFoundPage(c)
    return c.html(await detailPage(c, now, { errors: ['この状態からは変えられません。'] }), 400)
  }
  return c.redirect(`/requests/${encodeURIComponent(id)}`, 302)
})

export default requests
