// 記録（/records/*）のルート。本人のデータは全て scopedTo(db, user.id).own() 経由（docs/auth.md §6）。
// URL にユーザー id を出さない。他人の記録 id・無い id は 404。

import { type Context, Hono } from 'hono'
import { currentUser, requireUser } from '../auth/middleware'
import { getWork, listGenres, listWorks, type WorkDetailData } from '../db/master'
import { type OwnAttempt, scopedTo } from '../db/scoped'
import type { AppEnv } from '../env'
import { type Form, formOf } from '../lib/form'
import { todayJst } from '../lib/time'
import {
  editRecordFields,
  newRecordFields,
  parseEditRecord,
  parseNewRecord,
  parseSpoiler,
  parseStatus,
  spoilerFields,
  statusFields,
} from '../records/validate'
import { Layout } from '../ui/Layout'
import {
  DeleteRecord,
  NewRecordForm,
  NewRecordSearch,
  RecordDetail,
  RecordEditForm,
  RecordsList,
  type RecordsTab,
  recordEditValues,
  SpoilerEditForm,
} from '../ui/records'
import { spoilerHeaders, spoilerResponse } from '../ui/spoiler'
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
  if (!v.ok) {
    return c.html(await newFormPage(c, r.found, f, { errors: v.errors, q: f.q || undefined }), 400)
  }
  const id = await own(c).createAttempt({ workId: r.found.id, ...v.value })
  return c.redirect(`/records/${id}?created=1`, 302)
})

// 記録の詳細ページ。statusValues / statusErrors はステータス変更の 400 の再描画のとき
const detailPage = async (
  c: Context<AppEnv>,
  a: OwnAttempt,
  {
    created,
    saved,
    statusValues = { status: a.status, on: todayJst() },
    statusErrors,
  }: { created?: boolean; saved?: boolean; statusValues?: Form; statusErrors?: string[] } = {},
) => {
  const genres = a.genreIds.length
    ? (await listGenres(c.get('db'), { includeIds: a.genreIds })).filter((g) =>
        a.genreIds.includes(g.id),
      )
    : []
  return (
    <Layout
      title={a.work.title}
      tab="records"
      left={await recordsList(c, { selectedId: a.id })}
      right={
        <RecordDetail
          a={a}
          genres={genres}
          created={created}
          saved={saved}
          statusValues={statusValues}
          statusErrors={statusErrors}
        />
      }
    />
  )
}

records.get('/:id', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  return c.html(
    await detailPage(c, a, {
      created: c.req.query('created') === '1',
      saved: c.req.query('saved') === '1',
    }),
  )
})

// ステータス変更。日付の書き先は data-model.md §3 の表（own().setStatus）
records.post('/:id/status', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  const f = formOf(await c.req.parseBody(), statusFields)
  const v = parseStatus(f)
  if (!v.ok) {
    return c.html(await detailPage(c, a, { statusValues: f, statusErrors: v.errors }), 400)
  }
  if (!(await own(c).setStatus(a.id, v.value.status, v.value.on))) {
    return notFoundPage(c, '/records')
  }
  return c.redirect(`/records/${a.id}`, 302)
})

// 詳しい編集の選択肢: その作品の回（compareRuns 順）と、選べるジャンル（記録に付いている archived も含む）
const editOptions = async (c: Context<AppEnv>, a: OwnAttempt) => {
  const db = c.get('db')
  const [w, genres] = await Promise.all([
    getWork(db, a.workId),
    listGenres(db, { includeIds: a.genreIds }),
  ])
  return { runs: w && 'found' in w ? w.found.runs : [], genres }
}

const editPage = async (
  c: Context<AppEnv>,
  a: OwnAttempt,
  opts: Awaited<ReturnType<typeof editOptions>>,
  {
    values,
    genreValues,
    errors,
  }: { values: Form; genreValues: readonly string[]; errors?: string[] },
) => (
  <Layout
    title="記録を編集"
    tab="records"
    left={await recordsList(c, { selectedId: a.id })}
    right={
      <RecordEditForm
        a={a}
        runs={opts.runs}
        genres={opts.genres}
        values={values}
        genreValues={genreValues}
        errors={errors}
      />
    }
  />
)

records.get('/:id/edit', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  return c.html(
    await editPage(c, a, await editOptions(c, a), {
      values: recordEditValues(a),
      genreValues: a.genreIds,
    }),
  )
})

// genre は同名 checkbox が複数来るので all: true で受ける（1 つなら文字列、複数なら配列）
records.post('/:id/edit', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  const body = await c.req.parseBody({ all: true })
  const f = formOf(body, editRecordFields)
  const rawGenre = body.genre
  const genre = (Array.isArray(rawGenre) ? rawGenre : [rawGenre]).filter(
    (g): g is string => typeof g === 'string',
  )
  const opts = await editOptions(c, a)
  const v = parseEditRecord(f, genre, {
    runIds: opts.runs.map((r) => r.id),
    genreIds: opts.genres.map((g) => g.id),
  })
  if (!v.ok) {
    return c.html(
      await editPage(c, a, opts, { values: f, genreValues: genre, errors: v.errors }),
      400,
    )
  }
  if (!(await own(c).updateAttempt(a.id, v.value.patch, v.value.genreIds))) {
    return notFoundPage(c, '/records')
  }
  return c.redirect(`/records/${a.id}?saved=1`, 302)
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

// ネタバレメモの編集。本文を textarea に出すので GET も 400 も spoilerHeaders を付ける
const spoilerEditPage = async (
  c: Context<AppEnv>,
  a: OwnAttempt,
  value: string,
  errors?: string[],
) => {
  spoilerHeaders(c)
  return (
    <Layout
      title="ネタバレメモを編集"
      tab="records"
      left={await recordsList(c, { selectedId: a.id })}
      right={<SpoilerEditForm a={a} value={value} errors={errors} />}
    />
  )
}

records.get('/:id/spoiler/edit', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  return c.html(await spoilerEditPage(c, a, a.spoilerMemo ?? ''))
})

records.post('/:id/spoiler/edit', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  const f = formOf(await c.req.parseBody(), spoilerFields)
  const v = parseSpoiler(f)
  if (!v.ok) return c.html(await spoilerEditPage(c, a, f.spoiler_memo, v.errors), 400)
  if (!(await own(c).updateSpoilerMemo(a.id, v.value))) return notFoundPage(c, '/records')
  return c.redirect(`/records/${a.id}`, 302)
})

// 記録の削除。確認ページ → confirm=yes の POST
const deletePage = async (c: Context<AppEnv>, a: OwnAttempt, errors?: string[]) => (
  <Layout
    title="記録を削除"
    tab="records"
    left={await recordsList(c, { selectedId: a.id })}
    right={<DeleteRecord a={a} errors={errors} />}
  />
)

records.get('/:id/delete', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  return c.html(await deletePage(c, a))
})

records.post('/:id/delete', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  const body = await c.req.parseBody()
  if (body.confirm !== 'yes') {
    return c.html(await deletePage(c, a, ['「確認しました」にチェックしてください。']), 400)
  }
  if (!(await own(c).deleteAttempt(a.id))) return notFoundPage(c, '/records')
  return c.redirect('/records', 302)
})

export default records
