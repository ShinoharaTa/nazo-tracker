// 記録（/records/*）のルート。本人のデータは全て scopedTo(db, user.id).own() 経由（docs/auth.md §6）。
// URL にユーザー id を出さない。他人の記録 id・無い id は 404。

import { type Context, Hono } from 'hono'
import { currentUser, requireUser } from '../auth/middleware'
import { getRunById, getWork, listGenres, listWorks, type WorkDetailData } from '../db/master'
import { type OwnAttempt, scopedTo } from '../db/scoped'
import type { AppEnv } from '../env'
import { emptyForm, type Form, formOf } from '../lib/form'
import { todayJst } from '../lib/time'
import {
  editRecordFields,
  newRecordFields,
  parseEditRecord,
  parseNewRecord,
  parseSession,
  parseSpoiler,
  parseStatus,
  sessionFields,
  spoilerFields,
  statusFields,
} from '../records/validate'
import { Layout } from '../ui/Layout'
import { isVisitKind } from '../ui/labels'
import {
  DeleteRecord,
  NewRecordForm,
  NewRecordSearch,
  RecordDetail,
  RecordEditForm,
  RecordsList,
  type RecordsTab,
  recordEditValues,
  SessionForm,
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

// 左ページの記録一覧（unplayed は tab=wish のときだけ使う）
const recordsList = async (
  c: Context<AppEnv>,
  {
    tab = 'all',
    page = 1,
    selectedId,
    unplayed = false,
  }: { tab?: RecordsTab; page?: number; selectedId?: string; unplayed?: boolean },
) => {
  const repo = own(c)
  const [list, wish, playedCount] = await Promise.all([
    tab === 'wish' ? { items: [], hasNext: false } : repo.listAttempts({ tab, page }),
    tab === 'wish' ? repo.listWishlist({ unplayed, page }) : { items: [], hasNext: false },
    repo.playedCount(),
  ])
  return (
    <RecordsList
      tab={tab}
      items={list.items}
      wishItems={wish.items}
      unplayed={unplayed}
      page={page}
      hasNext={tab === 'wish' ? wish.hasNext : list.hasNext}
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
  const unplayed = c.req.query('unplayed') === '1'
  return c.html(
    <Layout title="記録" tab="records" left={await recordsList(c, { tab, page, unplayed })} fab />,
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
  const v = parseNewRecord(f, { kind: r.found.kind })
  if (!v.ok) {
    return c.html(await newFormPage(c, r.found, f, { errors: v.errors, q: f.q || undefined }), 400)
  }
  const id = await own(c).createAttempt({ workId: r.found.id, ...v.value })
  return c.redirect(`/records/${id}?created=1`, 302)
})

// マイリストの追加 / 削除。リダイレクト先は back の 2 値から組み立てる（URL を body から受けない）。
// /:id より先に登録する（/:id/... のルートに wishlist を id として拾わせない）
const wishRoute = (op: 'addWish' | 'removeWish') => async (c: Context<AppEnv>) => {
  const f = formOf(await c.req.parseBody(), ['work_id', 'back'])
  const r = f.work_id ? await getWork(c.get('db'), f.work_id) : null
  if (!r || 'redirect' in r) return notFoundPage(c, '/records?tab=wish')
  await own(c)[op](r.found.id)
  return c.redirect(
    f.back === 'wish' ? '/records?tab=wish' : `/works/${encodeURIComponent(r.found.id)}`,
    302,
  )
}

records.post('/wishlist', wishRoute('addWish'))
records.post('/wishlist/delete', wishRoute('removeWish'))

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
  const v = parseStatus(f, { kind: a.work.kind, current: a.status })
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
  const runs = w && 'found' in w ? w.found.runs : []
  // 今の run_id が作品の回に無くても選択肢に残す（無いと保存のたびに回が外れる）。
  // a.workId が統合済みの作品だと getWork が redirect を返すので、作品の回の一覧は空になる
  // （統合では attempt.work_id も run も統合先へ付け替わるので、通常は統合と編集が行き違ったときだけ）
  if (a.runId && !runs.some((r) => r.id === a.runId)) {
    const current = await getRunById(db, a.runId)
    if (current) return { runs: [...runs, current], genres }
  }
  return { runs, genres }
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
    kind: a.work.kind,
    current: a.status,
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

// 進行ログの追加。attempt の id は URL の :id だけから取る（body から受けない）
const sessionPage = async (c: Context<AppEnv>, a: OwnAttempt, values: Form, errors?: string[]) => (
  <Layout
    title="進行ログを追加"
    tab="records"
    left={await recordsList(c, { selectedId: a.id })}
    right={<SessionForm a={a} values={values} errors={errors} />}
  />
)

// 来場型（ルーム・公演）の記録には進行ログを足せない（GET は詳細へ戻し、POST は 400）
const NO_SESSIONS = 'ルーム・公演には進行ログがありません。'

records.get('/:id/sessions/new', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  if (isVisitKind(a.work.kind)) return c.redirect(`/records/${a.id}`, 302)
  return c.html(
    await sessionPage(c, a, {
      ...emptyForm(sessionFields),
      played_on: todayJst(),
      outcome: 'keep',
    }),
  )
})

// 記録の status / 日付は outcome で決める（own().addSession、data-model.md §3 session）
records.post('/:id/sessions', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  const f = formOf(await c.req.parseBody(), sessionFields)
  if (isVisitKind(a.work.kind)) {
    return c.html(await sessionPage(c, a, f, [NO_SESSIONS]), 400)
  }
  const v = parseSession(f)
  if (!v.ok) return c.html(await sessionPage(c, a, f, v.errors), 400)
  if (!(await own(c).addSession(a.id, v.value.session, v.value.outcome))) {
    return notFoundPage(c, '/records')
  }
  return c.redirect(`/records/${a.id}`, 302)
})

// 進行ログの削除（確認なし）。記録の status / 日付は戻さない
records.post('/:id/sessions/:sid/delete', async (c) => {
  const a = await own(c).getAttempt(c.req.param('id'))
  if (!a) return notFoundPage(c, '/records')
  if (!(await own(c).deleteSession(a.id, c.req.param('sid')))) {
    return notFoundPage(c, `/records/${a.id}`)
  }
  return c.redirect(`/records/${a.id}`, 302)
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
