// 画面のルート。作品・団体・会場はマスタの実データ、記録などの中身はまだ空状態で返す。

import { Hono } from 'hono'
import { deleteAccount } from '../auth/account'
import { currentUser, requireUser } from '../auth/middleware'
import { isProviderReady } from '../auth/oauth'
import { findOAuthProvider } from '../auth/providers/types'
import { clearSessionCookie, type SessionUser } from '../auth/session'
import type { Db } from '../db/client'
import { getOrg, getVenue, getWork, listWorks, type WorkListItem } from '../db/master'
import { scopedTo } from '../db/scoped'
import type { AppEnv } from '../env'
import { todayJst } from '../lib/time'
import {
  Empty,
  Field,
  Kpis,
  Menu,
  MenuItem,
  Pager,
  SearchIcon,
  Switch,
  Tabs,
  TopBar,
} from '../ui/components'
import { Document, Layout } from '../ui/Layout'
import { OrgDetail, VenueDetail, WorkDetail, WorkTicket } from '../ui/master'

const ui = new Hono<AppEnv>({ strict: false })

// /records/* は /records 自体も含む
ui.use('/records/*', requireUser)
ui.use('/stats', requireUser)
ui.use('/settings/*', requireUser)

type RecordsTab = 'all' | 'pending' | 'wish'

const recordsTabs: readonly { key: RecordsTab; label: string; href: string }[] = [
  { key: 'all', label: 'すべて', href: '/records' },
  { key: 'pending', label: '進行中・積み謎', href: '/records?tab=pending' },
  { key: 'wish', label: 'マイリスト', href: '/records?tab=wish' },
]

const toRecordsTab = (v: string | undefined): RecordsTab =>
  v === 'pending' || v === 'wish' ? v : 'all'

// 記録一覧（左ページ）
const RecordsList = ({ tab }: { tab: RecordsTab }) => (
  <>
    <TopBar
      title="記録"
      action={
        <a class="btn ghost" style="min-height:40px" href="/stats">
          0 件プレイ ›
        </a>
      }
    />
    <Tabs items={recordsTabs} current={tab} label="記録の絞り込み" />
    <div class="list">
      {tab === 'all' ? (
        <Empty>
          まだ記録はありません。
          <br />
          「＋ 記録」から作品を選んで付けられます。
        </Empty>
      ) : tab === 'pending' ? (
        <Empty>ここに出る記録はまだありません。</Empty>
      ) : (
        <>
          <Empty>
            マイリストは空です。
            <br />
            作品ページの「マイリストに追加」から登録できます。
          </Empty>
          <p class="note">
            マイリストからは自動では外れません。遊び終わったら ✕ で外してください。
          </p>
        </>
      )}
    </div>
  </>
)

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
}

// 作品一覧（左ページ）
const WorksList = ({ kind, q, page, items, hasNext, selectedId }: WorksListProps) => (
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
        items.map((w) => <WorkTicket w={w} selected={w.id === selectedId} />)
      ) : q.trim() ? (
        <Empty>「{q}」に一致する作品はありません</Empty>
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
  return (
    <WorksList kind="all" q="" page={1} items={items} hasNext={hasNext} selectedId={selectedId} />
  )
}

// 1 始まり。不正値は 1
const toPage = (v: string | undefined): number => {
  if (!v || !/^[1-9]\d{0,8}$/.test(v)) return 1
  return Number(v)
}

const NotFound = ({ back }: { back: string }) => (
  <>
    <TopBar back={back} label="404" />
    <Empty>見つかりませんでした。</Empty>
  </>
)

ui.get('/', (c) => c.redirect(c.get('user') ? '/records' : '/login', 302))

ui.get('/records', (c) => {
  const tab = toRecordsTab(c.req.query('tab'))
  return c.html(<Layout title="記録" tab="records" left={<RecordsList tab={tab} />} fab />)
})

ui.get('/records/new', (c) =>
  c.html(
    <Layout
      title="記録を追加"
      tab="records"
      left={<RecordsList tab="all" />}
      right={
        <>
          <TopBar back="/records" label="記録を追加" />
          <div class="sect" style="margin-top:4px">
            <h2>何を記録しますか？</h2>
            <label class="search">
              <SearchIcon />
              <input
                type="search"
                name="q"
                placeholder="作品名・団体で検索"
                aria-label="作品を検索"
              />
            </label>
            <Empty>作品マスタは P2 で入ります</Empty>
          </div>
        </>
      }
    />,
  ),
)

ui.get('/records/:id', (c) =>
  c.html(
    <Layout
      title="見つかりませんでした"
      tab="records"
      left={<RecordsList tab="all" />}
      right={<NotFound back="/records" />}
    />,
    404,
  ),
)

ui.get('/works', async (c) => {
  const k = c.req.query('kind') ?? 'all'
  const kind = kindFilters.some((f) => f.key === k) ? k : 'all'
  const q = c.req.query('q') ?? ''
  const page = toPage(c.req.query('page'))
  const { items, hasNext } = await listWorks(c.get('db'), { q, kind, page })
  return c.html(
    <Layout
      title="作品"
      tab="works"
      left={<WorksList kind={kind} q={q} page={page} items={items} hasNext={hasNext} />}
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

// 統合済みの行は統合先へ 302（Location は自サイトの相対パスだけ）
ui.get('/works/:id', async (c) => {
  const db = c.get('db')
  const r = await getWork(db, c.req.param('id'))
  if (!r) return c.html(await masterNotFound(db), 404)
  if ('redirect' in r) return c.redirect(`/works/${encodeURIComponent(r.redirect)}`, 302)
  return c.html(
    <Layout
      title={r.found.title}
      tab="works"
      left={await defaultWorksList(db, r.found.id)}
      right={<WorkDetail w={r.found} today={todayJst()} />}
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
      right={<OrgDetail o={r.found} />}
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
      right={<VenueDetail v={r.found} today={todayJst()} />}
    />,
  )
})

ui.get('/stats', (c) =>
  c.html(
    <Layout
      title="統計"
      tab="stats"
      single
      left={
        <>
          <TopBar title="統計" />
          <Kpis
            items={[
              { label: 'プレイ', value: 0, note: 'クリア 0 / 失敗 0' },
              { label: '成功率', value: '0%', note: '断念を除く' },
              { label: '積み謎', value: 0, note: '買った・進行中' },
            ]}
          />
          <Switch label="断念を失敗に含める" name="dropAsFail" disabled />
          <div class="sect">
            <h2>難易度別の成功率</h2>
            <Empty>まだデータがありません。</Empty>
          </div>
          <div class="sect">
            <h2>得意なジャンル</h2>
            <Empty>まだデータがありません。</Empty>
          </div>
          <div class="sect">
            <h2>月別の参加数</h2>
            <Empty>まだデータがありません。</Empty>
          </div>
          <p class="note" style="margin-top:14px">
            成功率 = クリア
            ÷（クリア＋失敗）。買った・進行中は含めません。統計は自分だけに表示されます。
          </p>
        </>
      }
    />,
  ),
)

const linkNote = (linked: Set<string>, provider: string) =>
  linked.has(provider) ? '連携済み' : '未連携'

// 設定一覧（左ページ）。linked は連携済みの provider 名
const SettingsList = ({ user, linked }: { user: SessionUser; linked: Set<string> }) => (
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
        <MenuItem label="作品の人数に自分を含める" note="P3 で実装" disabled />
        <MenuItem label="自分のデータをエクスポート" note="P7 で実装" disabled />
      </Menu>
    </div>
    {user.role === 'owner' ? (
      <div class="sect">
        <h2>管理（オーナーのみ）</h2>
        <Menu>
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
  const linked = await scopedTo(c.get('db'), user.id).own().linkedProviders()
  return c.html(
    <Layout title="設定" tab="settings" left={<SettingsList user={user} linked={linked} />} />,
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
  linked: Set<string>,
  form: Parameters<typeof DisplayNameForm>[0],
) => (
  <Layout
    title="表示名を変える"
    tab="settings"
    left={<SettingsList user={user} linked={linked} />}
    right={<DisplayNameForm {...form} />}
  />
)

ui.get('/settings/name', async (c) => {
  const user = currentUser(c)
  const profile = await scopedTo(c.get('db'), user.id).own().profile()
  const linked = await scopedTo(c.get('db'), user.id).own().linkedProviders()
  return c.html(
    displayNamePage(user, linked, {
      value: profile.displayName,
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
    const linked = await scopedTo(c.get('db'), user.id).own().linkedProviders()
    return c.html(displayNamePage(user, linked, { value: name, error }), 400)
  }
  await scopedTo(c.get('db'), user.id).own().updateDisplayName(name)
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

const deletePage = (user: SessionUser, linked: Set<string>, error?: string) => (
  <Layout
    title="退会"
    tab="settings"
    left={<SettingsList user={user} linked={linked} />}
    right={<DeleteAccount user={user} error={error} />}
  />
)

ui.get('/settings/delete', async (c) => {
  const user = currentUser(c)
  return c.html(deletePage(user, await scopedTo(c.get('db'), user.id).own().linkedProviders()))
})

ui.post('/settings/delete', async (c) => {
  const user = currentUser(c)
  if (user.role === 'owner') {
    return c.html(
      deletePage(user, await scopedTo(c.get('db'), user.id).own().linkedProviders()),
      400,
    )
  }
  const body = await c.req.parseBody()
  if (body.confirm !== 'yes') {
    const linked = await scopedTo(c.get('db'), user.id).own().linkedProviders()
    return c.html(deletePage(user, linked, '確認のチェックを入れてください。'), 400)
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
