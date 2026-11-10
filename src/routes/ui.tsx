// 画面のルート。作品・団体・会場はマスタの実データ。記録（/records/*）は routes/records.tsx、統計は本人の記録を集計する（src/lib/stats.ts）。

import { type Context, Hono } from 'hono'
import { deleteAccount } from '../auth/account'
import { currentUser, requireUser } from '../auth/middleware'
import { isProviderReady } from '../auth/oauth'
import { findOAuthProvider } from '../auth/providers/types'
import { clearSessionCookie, type SessionUser } from '../auth/session'
import type { Db } from '../db/client'
import { countsFor, type WorkCounts } from '../db/counts'
import { getOrg, getVenue, getWork, listGenres, listWorks, type WorkListItem } from '../db/master'
import { scopedTo } from '../db/scoped'
import type { AppEnv } from '../env'
import { computeStats } from '../lib/stats'
import { todayJst } from '../lib/time'
import { Empty, Field, Menu, MenuItem, Pager, SearchIcon, Switch, TopBar } from '../ui/components'
import { Document, Layout } from '../ui/Layout'
import { OrgDetail, VenueDetail, WorkDetail, WorkTicket } from '../ui/master'
import { StatsPage } from '../ui/stats'

const ui = new Hono<AppEnv>({ strict: false })

ui.use('/stats', requireUser)
ui.use('/settings/*', requireUser)
// 設定は本人のデータなので共有キャッシュに載せない（既に付いていれば上書きしない）
ui.use('/settings/*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'private, no-store')
})

// 作品一覧の形式フィルタ。LINE と Web はモックに合わせて 1 つにまとめる。
// online は line / web をまとめた UI 上だけの値（workKinds には無い）。listWorks が kind IN ('line', 'web') に変換する
const kindFilters: readonly { key: string; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'hall', label: '公演' },
  { key: 'room', label: 'ルーム' },
  { key: 'stroll', label: '周遊' },
  { key: 'takeaway', label: '持ち帰り' },
  { key: 'online', label: 'LINE・Web' },
]

const worksHref = (params: { kind?: string; q?: string }) => {
  const sp = new URLSearchParams()
  if (params.kind && params.kind !== 'all') sp.set('kind', params.kind)
  if (params.q) sp.set('q', params.q)
  const qs = sp.toString()
  return qs ? `/works?${qs}` : '/works'
}

type WorksListProps = {
  kind: string
  q: string
  page: number
  items: WorkListItem[]
  hasNext: boolean
  selectedId?: string
  // 匿名人数（プレイ済みの chip）
  counts: Map<string, WorkCounts>
}

// 作品一覧（左ページ）
const WorksList = ({ kind, q, page, items, hasNext, selectedId, counts }: WorksListProps) => (
  <>
    <TopBar title="作品" />
    <form class="search" method="get" action="/works">
      <SearchIcon />
      <input
        type="search"
        name="q"
        value={q}
        placeholder="作品名・団体で検索"
        aria-label="作品を検索"
      />
      {kind !== 'all' ? <input type="hidden" name="kind" value={kind} /> : null}
    </form>
    <nav class="chips" aria-label="形式で絞り込む">
      {kindFilters.map((f) => {
        const href = worksHref({ kind: f.key, q })
        return f.key === kind ? (
          <a class="fchip on" href={href} aria-current="page">
            {f.label}
          </a>
        ) : (
          <a class="fchip" href={href}>
            {f.label}
          </a>
        )
      })}
    </nav>
    {kind === 'room' ? (
      <p class="note">ルーム型は都道府県 → 店舗の順でも探せます（P10）。</p>
    ) : null}
    <div class="list">
      {items.length ? (
        items.map((w) => (
          <WorkTicket w={w} selected={w.id === selectedId} counts={counts.get(w.id)} />
        ))
      ) : q.trim() ? (
        <Empty>「{q}」に一致する作品はありません</Empty>
      ) : kind !== 'all' ? (
        <Empty>この形式の作品はまだありません。</Empty>
      ) : (
        <Empty>作品はまだ登録されていません。</Empty>
      )}
    </div>
    <Pager
      base="/works"
      page={page}
      hasNext={hasNext}
      params={{ kind: kind === 'all' ? '' : kind, q }}
    />
    <p class="note" style="margin-top:14px">
      人数は 5 人未満のとき「少数」と表示します。誰が記録したかは表示しません。
    </p>
  </>
)

// 詳細ページの左に出す一覧（1 頁目・フィルタ無し）
const defaultWorksList = async (db: Db, selectedId?: string) => {
  const { items, hasNext } = await listWorks(db, { page: 1 })
  const counts = await countsFor(
    db,
    items.map((w) => w.id),
  )
  return (
    <WorksList
      kind="all"
      q=""
      page={1}
      items={items}
      hasNext={hasNext}
      selectedId={selectedId}
      counts={counts}
    />
  )
}

// 1 始まり。不正値は 1
export const toPage = (v: string | undefined): number => {
  if (!v || !/^[1-9]\d{0,8}$/.test(v)) return 1
  return Number(v)
}

export const NotFound = ({ back }: { back: string }) => (
  <>
    <TopBar back={back} label="404" />
    <Empty>見つかりませんでした。</Empty>
  </>
)

ui.get('/', (c) => c.redirect(c.get('user') ? '/records' : '/login', 302))

ui.get('/works', async (c) => {
  const k = c.req.query('kind') ?? 'all'
  const kind = kindFilters.some((f) => f.key === k) ? k : 'all'
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const db = c.get('db')
  const { items, hasNext } = await listWorks(db, { q, kind, page })
  const counts = await countsFor(
    db,
    items.map((w) => w.id),
  )
  return c.html(
    <Layout
      title="作品"
      tab="works"
      left={
        <WorksList kind={kind} q={q} page={page} items={items} hasNext={hasNext} counts={counts} />
      }
    />,
  )
})

// 作品・団体・会場の詳細で共通の 404（左は作品一覧）
const masterNotFound = async (db: Db) => (
  <Layout
    title="見つかりませんでした"
    tab="works"
    left={await defaultWorksList(db)}
    right={<NotFound back="/works" />}
  />
)

const isOwner = (c: Context<AppEnv>) => c.get('user')?.role === 'owner'

// 統合済みの行は統合先へ 302（Location は自サイトの相対パスだけ）
ui.get('/works/:id', async (c) => {
  const db = c.get('db')
  const r = await getWork(db, c.req.param('id'))
  if (!r) return c.html(await masterNotFound(db), 404)
  if ('redirect' in r) return c.redirect(`/works/${encodeURIComponent(r.redirect)}`, 302)
  const owner = isOwner(c)
  const user = c.get('user')
  const repo = user ? scopedTo(db, user.id).own() : null
  const mine = repo
    ? await Promise.all([repo.isWished(r.found.id), repo.attemptsOfWork(r.found.id)]).then(
        ([wished, attempts]) => ({ wished, attempts }),
      )
    : null
  const counts = (await countsFor(db, [r.found.id])).get(r.found.id) ?? {
    played: 'none',
    wish: 'none',
  }
  // ログイン中は本人の記録を含むので共有キャッシュに載せない
  if (user) c.header('Cache-Control', 'private, no-store')
  return c.html(
    <Layout
      title={r.found.title}
      tab="works"
      left={await defaultWorksList(db, r.found.id)}
      right={
        <WorkDetail
          w={r.found}
          today={todayJst()}
          mine={mine}
          counts={counts}
          editHref={owner ? `/admin/works/${r.found.id}` : undefined}
          runEditHref={owner ? (runId) => `/admin/runs/${runId}` : undefined}
        />
      }
    />,
  )
})

ui.get('/orgs/:id', async (c) => {
  const db = c.get('db')
  const r = await getOrg(db, c.req.param('id'))
  if (!r) return c.html(await masterNotFound(db), 404)
  if ('redirect' in r) return c.redirect(`/orgs/${encodeURIComponent(r.redirect)}`, 302)
  return c.html(
    <Layout
      title={r.found.name}
      tab="works"
      left={await defaultWorksList(db)}
      right={
        <OrgDetail
          o={r.found}
          counts={
            await countsFor(
              db,
              r.found.works.map((w) => w.id),
            )
          }
          editHref={isOwner(c) ? `/admin/orgs/${r.found.id}` : undefined}
        />
      }
    />,
  )
})

ui.get('/venues/:id', async (c) => {
  const db = c.get('db')
  const r = await getVenue(db, c.req.param('id'))
  if (!r) return c.html(await masterNotFound(db), 404)
  if ('redirect' in r) return c.redirect(`/venues/${encodeURIComponent(r.redirect)}`, 302)
  return c.html(
    <Layout
      title={r.found.name}
      tab="works"
      left={await defaultWorksList(db)}
      right={
        <VenueDetail
          v={r.found}
          today={todayJst()}
          editHref={isOwner(c) ? `/admin/venues/${r.found.id}` : undefined}
        />
      }
    />,
  )
})

// year は 4 桁で STATS_MIN_YEAR〜今年（JST）。それ以外は今年
const STATS_MIN_YEAR = 2000
const toStatsYear = (v: string | undefined, thisYear: number): number => {
  if (!v || !/^\d{4}$/.test(v)) return thisYear
  const n = Number(v)
  return n >= STATS_MIN_YEAR && n <= thisYear ? n : thisYear
}

ui.get('/stats', async (c) => {
  const db = c.get('db')
  const own = scopedTo(db, currentUser(c).id).own()
  const thisYear = Number(todayJst().slice(0, 4))
  const year = toStatsYear(c.req.query('year'), thisYear)
  const dropAsFail = c.req.query('drop') === 'fail'
  const [{ rows, genres, capped }, wishlist] = await Promise.all([
    own.statsRows(),
    own.wishlistSummary(),
  ])
  const stats = computeStats(rows, genres, { dropAsFail, year })
  const genreRows = await listGenres(db, { includeIds: stats.byGenre.map((g) => g.genreId) })
  c.header('Cache-Control', 'private, no-store')
  return c.html(
    <Layout
      title="統計"
      tab="stats"
      single
      left={
        <StatsPage
          stats={stats}
          dropAsFail={dropAsFail}
          year={year}
          thisYear={thisYear}
          minYear={STATS_MIN_YEAR}
          capped={capped}
          genres={genreRows}
          wishlist={wishlist}
        />
      }
    />,
  )
})

const linkNote = (linked: Set<string>, provider: string) =>
  linked.has(provider) ? '連携済み' : '未連携'

// 設定一覧（左ページ）の中身。linked は連携済みの provider 名。displayName は DB の現在値（表示名フォーム用）
type SettingsState = { linked: Set<string>; excludeFromCounts: boolean; displayName: string }

const settingsState = async (db: Db, userId: string): Promise<SettingsState> => {
  const own = scopedTo(db, userId).own()
  const [linked, profile] = await Promise.all([own.linkedProviders(), own.profile()])
  return {
    linked,
    excludeFromCounts: profile.excludeFromCounts,
    displayName: profile.displayName,
  }
}

// 設定一覧（左ページ）
const SettingsList = ({
  user,
  state: { linked, excludeFromCounts },
}: {
  user: SessionUser
  state: SettingsState
}) => (
  <>
    <TopBar title="設定" />
    <div class="sect" style="margin-top:4px">
      <h2>表示名</h2>
      <Menu>
        <MenuItem label="表示名を変える" note={user.displayName} href="/settings/name" />
      </Menu>
    </div>
    <div class="sect">
      <h2>ログイン方法</h2>
      <Menu>
        <MenuItem label="Google" note={linkNote(linked, 'google')} disabled />
        <MenuItem label="Discord" note={linkNote(linked, 'discord')} disabled />
        <MenuItem label="ほかのログイン方法を連携" note="P6 で実装" disabled />
        <MenuItem label="復旧コード" note="P6 で実装" disabled />
      </Menu>
      <p class="note">ログイン方法を 2 つ連携しておくと、片方が使えなくなっても戻れます。</p>
    </div>
    <div class="sect">
      <h2>フレンド</h2>
      <Menu>
        <MenuItem label="フレンド" note="P8 で実装" disabled />
        <MenuItem label="招待リンクをコピー" note="P8 で実装" disabled />
      </Menu>
      <p class="note">
        フレンドに見えるのは、作品名・ステータス・日付だけです。メモやネタバレは見えません。
      </p>
    </div>
    <div class="sect">
      <h2>データ</h2>
      <Menu>
        <MenuItem
          label="作品の人数に自分を含める"
          note={excludeFromCounts ? '含めない' : '含める'}
          href="/settings/counts"
        />
        <MenuItem label="自分のデータをエクスポート" note="P7 で実装" disabled />
      </Menu>
    </div>
    {user.role === 'owner' ? (
      <div class="sect">
        <h2>管理（オーナーのみ）</h2>
        <Menu>
          <MenuItem label="マスタ管理" href="/admin" />
          <MenuItem label="承認待ちの提案" note="P4 で実装" disabled />
        </Menu>
      </div>
    ) : null}
    <div class="sect">
      <Menu>
        <MenuItem label="ログアウト" action="/auth/logout" />
        <MenuItem label="退会" href="/settings/delete" />
      </Menu>
    </div>
  </>
)

ui.get('/settings', async (c) => {
  const user = currentUser(c)
  const state = await settingsState(c.get('db'), user.id)
  return c.html(
    <Layout title="設定" tab="settings" left={<SettingsList user={user} state={state} />} />,
  )
})

const DISPLAY_NAME_MAX = 20

// 制御文字・行/段落区切り・双方向制御（表示を乱すので禁止）
const FORBIDDEN_CHARS = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u
// 文字としては数えられるが見えないもの（ハングルのフィラー・ゼロ幅文字・BOM）
const INVISIBLE_CHARS = /[ᅟᅠㅤﾠ​-‍⁠﻿]/gu
const VISIBLE_CHAR = /[\p{L}\p{N}\p{P}\p{S}]/u

// NFC 正規化 → trim。判定順は 空 → 制御文字 → 見える文字 → 長さ（コードポイントで 1〜20）
const parseDisplayName = (raw: string): { name: string; error: string | null } => {
  const name = raw.normalize('NFC').trim()
  if (name.length === 0) return { name, error: '表示名を入力してください。' }
  if (FORBIDDEN_CHARS.test(name)) return { name, error: '表示名に改行や制御文字は使えません。' }
  if (!VISIBLE_CHAR.test(name.replace(INVISIBLE_CHARS, ''))) {
    return { name, error: '表示名に見える文字を 1 つ以上入れてください。' }
  }
  if ([...name].length > DISPLAY_NAME_MAX) {
    return { name, error: `表示名は ${DISPLAY_NAME_MAX} 文字以内にしてください。` }
  }
  return { name, error: null }
}

const DisplayNameForm = (props: { value: string; welcome?: boolean; error?: string | null }) => (
  <>
    <TopBar back="/settings" label="表示名を変える" />
    <div class="sect" style="margin-top:4px">
      {props.welcome ? (
        <p class="note" role="status">
          はじめに表示名を決めてください（あとで変えられます）
        </p>
      ) : null}
      {props.error ? (
        <p class="note" role="alert">
          {props.error}
        </p>
      ) : null}
      <form method="post" action="/settings/name" class="list">
        <Field label="表示名" name="displayName" value={props.value} />
        <button type="submit" class="btn pri">
          保存
        </button>
      </form>
    </div>
  </>
)

const displayNamePage = (
  user: SessionUser,
  state: SettingsState,
  form: Parameters<typeof DisplayNameForm>[0],
) => (
  <Layout
    title="表示名を変える"
    tab="settings"
    left={<SettingsList user={user} state={state} />}
    right={<DisplayNameForm {...form} />}
  />
)

ui.get('/settings/name', async (c) => {
  const user = currentUser(c)
  const state = await settingsState(c.get('db'), user.id)
  return c.html(
    displayNamePage(user, state, {
      value: state.displayName,
      welcome: c.req.query('welcome') === '1',
    }),
  )
})

ui.post('/settings/name', async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  const raw = typeof body.displayName === 'string' ? body.displayName : ''
  const { name, error } = parseDisplayName(raw)
  if (error) {
    const state = await settingsState(c.get('db'), user.id)
    return c.html(displayNamePage(user, state, { value: name, error }), 400)
  }
  await scopedTo(c.get('db'), user.id).own().updateDisplayName(name)
  return c.redirect('/settings', 302)
})

// 匿名人数のオプトアウト（右ページ）。説明は Layout の Cover「データの扱い」と同じ趣旨
const CountsForm = ({ excludeFromCounts }: { excludeFromCounts: boolean }) => (
  <>
    <TopBar back="/settings" label="作品の人数" />
    <div class="sect" style="margin-top:4px">
      <p class="note">
        作品一覧・作品ページの「プレイ済み」「マイリスト」の人数には、誰が記録したかを出さず、5
        人未満は「少数」と表示します。それでも人数の増え方から推測される可能性があるため、気になる場合は自分を含めないようにできます。
      </p>
      <form method="post" action="/settings/counts" class="list">
        <Switch label="作品の人数に自分を含める" name="include" checked={!excludeFromCounts} />
        <button type="submit" class="btn pri">
          保存
        </button>
      </form>
    </div>
  </>
)

ui.get('/settings/counts', async (c) => {
  const user = currentUser(c)
  const state = await settingsState(c.get('db'), user.id)
  return c.html(
    <Layout
      title="作品の人数"
      tab="settings"
      left={<SettingsList user={user} state={state} />}
      right={<CountsForm excludeFromCounts={state.excludeFromCounts} />}
    />,
  )
})

// checkbox は on のときだけ include=on が届く。無ければ含めない
ui.post('/settings/counts', async (c) => {
  const user = currentUser(c)
  const body = await c.req.parseBody()
  await scopedTo(c.get('db'), user.id)
    .own()
    .setExcludeFromCounts(body.include !== 'on')
  return c.redirect('/settings', 302)
})

// 退会の確認（右ページ）。オーナーは退会できない（ロックアウト防止）
const DeleteAccount = ({ user, error }: { user: SessionUser; error?: string }) => (
  <>
    <TopBar back="/settings" label="退会" />
    <div class="sect" style="margin-top:4px">
      <h2>退会すると消えるもの</h2>
      <ul>
        <li>記録・進行ログ・写真</li>
        <li>マイリスト</li>
        <li>フレンド関係（申請・ブロックを含む）</li>
        <li>ログイン連携</li>
        <li>この操作は元に戻せません。</li>
      </ul>
      <p class="note">補足</p>
      <ul>
        <li>同じアカウントで再ログインすると、新規ユーザーになります。</li>
        <li>作品マスタへのリクエストは、匿名化して残ります。</li>
      </ul>
    </div>
    {user.role === 'owner' ? (
      <p class="note">オーナーは退会できません。</p>
    ) : (
      <form method="post" action="/settings/delete" class="sect">
        {error ? (
          <p class="note" role="alert">
            {error}
          </p>
        ) : null}
        <label>
          <input type="checkbox" name="confirm" value="yes" /> 上の内容を確認しました
        </label>
        <button type="submit" class="btn danger">
          退会する
        </button>
      </form>
    )}
  </>
)

const deletePage = (user: SessionUser, state: SettingsState, error?: string) => (
  <Layout
    title="退会"
    tab="settings"
    left={<SettingsList user={user} state={state} />}
    right={<DeleteAccount user={user} error={error} />}
  />
)

ui.get('/settings/delete', async (c) => {
  const user = currentUser(c)
  return c.html(deletePage(user, await settingsState(c.get('db'), user.id)))
})

ui.post('/settings/delete', async (c) => {
  const user = currentUser(c)
  if (user.role === 'owner') {
    return c.html(deletePage(user, await settingsState(c.get('db'), user.id)), 400)
  }
  const body = await c.req.parseBody()
  if (body.confirm !== 'yes') {
    const state = await settingsState(c.get('db'), user.id)
    return c.html(deletePage(user, state, '確認のチェックを入れてください。'), 400)
  }
  await deleteAccount(c.get('db'), user.id)
  clearSessionCookie(c)
  return c.redirect('/login?deleted=1', 302)
})

const loginMessage = (error: string | undefined, deleted: string | undefined): string | null => {
  if (deleted === '1') return '退会しました。'
  if (error === 'denied') return 'ログインがキャンセルされました。'
  if (error === 'failed') return 'ログインに失敗しました。もう一度お試しください。'
  return null
}

// CLIENT_ID か CLIENT_SECRET が未設定（または未登録）のプロバイダは押せない「準備中」のボタンにする
const LoginButton = ({
  name,
  label,
  ready,
  primary = false,
}: {
  name: string
  label: string
  ready: boolean
  primary?: boolean
}) => {
  if (!ready) {
    return (
      <button type="button" class="btn" aria-disabled="true" disabled>
        {label} でログイン（準備中）
      </button>
    )
  }
  return (
    <a class={primary ? 'btn pri' : 'btn'} href={`/auth/${name}`}>
      {label} でログイン
    </a>
  )
}

ui.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/records', 302)
  const message = loginMessage(c.req.query('error'), c.req.query('deleted'))
  const ready = (name: string) => {
    const provider = findOAuthProvider(name)
    return !!provider && isProviderReady(c, provider)
  }
  return c.html(
    <Document title="ログイン">
      <div id="app">
        <div class="login">
          <h1>NAZO LOG</h1>
          <p class="note" style="font-size:14px;margin:0">
            謎解きの参加記録と、遊びたい作品のリスト。
          </p>
          {message ? (
            <p class="note" role="status" style="margin:0">
              {message}
            </p>
          ) : null}
          <div class="list">
            <LoginButton name="google" label="Google" ready={ready('google')} primary />
            <LoginButton name="discord" label="Discord" ready={ready('discord')} />
          </div>
          <p class="note" style="margin:0">
            メールアドレスは保存しません。ログイン先のアカウント ID だけを使います。
          </p>
          <a class="btn ghost" href="/works">
            ログインせずに作品を見る
          </a>
        </div>
      </div>
    </Document>,
  )
})

export default ui
