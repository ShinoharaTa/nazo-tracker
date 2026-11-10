// 記録（/records/*）のルート。本人のデータは全て scopedTo(db, user.id).own() 経由（docs/auth.md §6）。
// URL にユーザー id を出さない。他人の記録 id・無い id は 404。

import { type Context, Hono } from 'hono'
import { currentUser, requireUser } from '../auth/middleware'
import { getWork, listGenres, listWorks, type WorkDetailData } from '../db/master'
import { scopedTo } from '../db/scoped'
import type { AppEnv } from '../env'
import { type Form, formOf } from '../lib/form'
import { todayJst } from '../lib/time'
import { newRecordFields, parseNewRecord } from '../records/validate'
import { Layout } from '../ui/Layout'
import {
  NewRecordForm,
  NewRecordSearch,
  RecordDetail,
  RecordsList,
  type RecordsTab,
} from '../ui/records'
import { spoilerResponse } from '../ui/spoiler'
import { NotFound, toPage } from './ui'

const records = new Hono<AppEnv>({ strict: false })

// /records 自体も含む
records.use('*', requireUser)

// 本人のデータしか返さないので共有キャッシュに載せない（ネタバレ断片は spoilerResponse が付けた値のまま）
records.use('*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store')
})

const own = (c: Context<AppEnv>) => scopedTo(c.get('db'), currentUser(c).id).own()

const toRecordsTab = (v: string | undefined): RecordsTab =>
  v === 'pending' || v === 'wish' ? v : 'all'

// 左ページの記録一覧
const recordsList = async (
  c: Context<AppEnv>,
  { tab = 'all', page = 1, selectedId }: { tab?: RecordsTab; page?: number; selectedId?: string },
) => {
  const repo = own(c)
  const [list, playedCount] = await Promise.all([
    tab === 'wish' ? { items: [], hasNext: false } : repo.listAttempts({ tab, page }),
    repo.playedCount(),
  ])
  return (
    <RecordsList
      tab={tab}
      items={list.items}
      page={page}
      hasNext={list.hasNext}
      playedCount={playedCount}
      selectedId={selectedId}
    />
  )
}

const notFoundPage = async (c: Context<AppEnv>, back: string) =>
  c.html(
    <Layout
      title="見つかりませんでした"
      tab="records"
      left={await recordsList(c, {})}
      right={<NotFound back={back} />}
    />,
    404,
  )

records.get('/', async (c) => {
  const tab = toRecordsTab(c.req.query('tab'))
  const page = toPage(c.req.query('page'))
  return c.html(
    <Layout title="記録" tab="records" left={await recordsList(c, { tab, page })} fab />,
  )
})

// 作品検索の結果ページ（errors は POST /records で作品が見つからなかったとき）
const searchPage = async (
  c: Context<AppEnv>,
  { q, page, errors }: { q: string; page: number; errors?: string[] },
) => {
  const { items, hasNext } = await listWorks(c.get('db'), { q, page })
  return (
    <Layout
      title="記録を追加"
      tab="records"
      left={await recordsList(c, {})}
      right={<NewRecordSearch q={q} page={page} items={items} hasNext={hasNext} errors={errors} />}
    />
  )
}

// 軽い記録のフォーム（右ページ）
const newFormPage = async (
  c: Context<AppEnv>,
  w: WorkDetailData,
  values: Form,
  { errors, q }: { errors?: string[]; q?: string } = {},
) => (
  <Layout
    title="記録を追加"
    tab="records"
    left={await recordsList(c, {})}
    right={
      <NewRecordForm
        w={w}
        existing={await own(c).attemptsOfWork(w.id)}
        values={values}
        errors={errors}
        q={q}
      />
    }
  />
)

// work 無し: 作品検索。work あり: 軽い記録のフォーム（統合済みは統合先へ 302、q は引き継がない）
records.get('/new', async (c) => {
  const workId = c.req.query('work')
  if (workId === undefined) {
    const q = c.req.query('q') ?? ''
    return c.html(await searchPage(c, { q, page: toPage(c.req.query('page')) }))
  }
  const r = await getWork(c.get('db'), workId)
  if (!r) return notFoundPage(c, '/records/new')
  if ('redirect' in r) {
    return c.redirect(`/records/new?work=${encodeURIComponent(r.redirect)}`, 302)
  }
  return c.html(
    await newFormPage(
      c,
      r.found,
      { work_id: r.found.id, status: '', on: todayJst() },
      { q: c.req.query('q') },
    ),
  )
})

// 軽い記録を作る。work_id は存在して未統合であること
records.post('/', async (c) => {
  const f = formOf(await c.req.parseBody(), newRecordFields)
  const r = f.work_id ? await getWork(c.get('db'), f.work_id) : null
  if (!r || 'redirect' in r) {
    return c.html(
      await searchPage(c, { q: '', page: 1, errors: ['作品が見つからないか、統合済みです。'] }),
      400,
    )
  }
  const v = parseNewRecord(f)
  if (!v.ok) return c.html(await newFormPage(c, r.found, f, { errors: v.errors }), 400)
  const id = await own(c).createAttempt({ workId: r.found.id, ...v.value })
  return c.redirect(`/records/${id}?created=1`, 302)
})

records.get('/:id', async (c) => {
  const id = c.req.param('id')
  const a = await own(c).getAttempt(id)
  if (!a) return notFoundPage(c, '/records')
  const genres = a.genreIds.length
    ? (await listGenres(c.get('db'), { includeIds: a.genreIds })).filter((g) =>
        a.genreIds.includes(g.id),
      )
    : []
  return c.html(
    <Layout
      title={a.work.title}
      tab="records"
      left={await recordsList(c, { selectedId: a.id })}
      right={
        <RecordDetail
          a={a}
          genres={genres}
          created={c.req.query('created') === '1'}
          saved={c.req.query('saved') === '1'}
        />
      }
    />,
  )
})

// ネタバレ断片。本人以外・無い id は text の 404（断片なので Layout は不要）
records.get('/:id/spoiler', async (c) => {
  const id = c.req.param('id')
  const a = await own(c).getAttempt(id)
  if (!a) return c.notFound()
  return spoilerResponse(c, a, {
    back: `/records/${a.id}`,
    tab: 'records',
    title: `${a.work.title} のネタバレ`,
  })
})

export default records
