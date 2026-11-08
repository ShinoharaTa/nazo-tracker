// 画面のルート。P0 の UI 基盤では認証・DB を使わず、すべて空状態で返す。

import { Hono } from 'hono'
import type { Bindings } from '../index'
import { Empty, Kpis, Menu, MenuItem, SearchIcon, Switch, Tabs, TopBar } from '../ui/components'
import { Gallery } from '../ui/Gallery'
import { Document, Layout } from '../ui/Layout'

const ui = new Hono<{ Bindings: Bindings }>()

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

// 作品一覧の形式フィルタ。LINE と Web はモックに合わせて 1 つにまとめる
const kindFilters: readonly { key: string; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'hall', label: '公演' },
  { key: 'room', label: 'ルーム' },
  { key: 'stroll', label: '周遊' },
  { key: 'takeaway', label: '持ち帰り' },
  { key: 'online', label: 'LINE・Web' },
]

const WorksList = ({ kind, q }: { kind: string; q: string }) => (
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
        const href = f.key === 'all' ? '/works' : `/works?kind=${f.key}`
        return f.key === kind ? (
          <a class="fchip on" href={href} aria-current="true">
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
      <Empty>
        作品はまだ登録されていません。
        <br />
        作品マスタは P2 で入ります。
      </Empty>
    </div>
    <p class="note" style="margin-top:14px">
      人数は 5 人未満のとき「少数」と表示します。誰が記録したかは表示しません。
    </p>
  </>
)

const NotFound = ({ back }: { back: string }) => (
  <>
    <TopBar back={back} label="404" />
    <Empty>見つかりませんでした。</Empty>
  </>
)

ui.get('/', (c) => c.redirect('/records', 302))

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

ui.get('/works', (c) => {
  const k = c.req.query('kind') ?? 'all'
  const kind = kindFilters.some((f) => f.key === k) ? k : 'all'
  const q = c.req.query('q') ?? ''
  return c.html(<Layout title="作品" tab="works" left={<WorksList kind={kind} q={q} />} />)
})

ui.get('/works/:id', (c) =>
  c.html(
    <Layout
      title="見つかりませんでした"
      tab="works"
      left={<WorksList kind="all" q="" />}
      right={<NotFound back="/works" />}
    />,
    404,
  ),
)

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

ui.get('/settings', (c) =>
  c.html(
    <Layout
      title="設定"
      tab="settings"
      left={
        <>
          <TopBar title="設定" />
          <div class="sect" style="margin-top:4px">
            <h2>表示名</h2>
            <Menu>
              <MenuItem label="表示名を変える" note="P1 で実装" disabled />
            </Menu>
          </div>
          <div class="sect">
            <h2>ログイン方法</h2>
            <Menu>
              <MenuItem label="Google" note="P1 で実装" disabled />
              <MenuItem label="Discord" note="P1 で実装" disabled />
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
          <div class="sect">
            <h2>管理（オーナーのみ）</h2>
            <Menu>
              <MenuItem label="承認待ちの提案" note="P4 で実装" disabled />
            </Menu>
          </div>
          <div class="sect">
            <Menu>
              <MenuItem label="ログアウト" note="P1 で実装" disabled />
              <MenuItem label="退会" note="P1 で実装" disabled />
            </Menu>
          </div>
        </>
      }
    />,
  ),
)

ui.get('/login', (c) =>
  c.html(
    <Document title="ログイン">
      <div id="app">
        <div class="login">
          <h1>NAZO LOG</h1>
          <p class="note" style="font-size:14px;margin:0">
            謎解きの参加記録と、遊びたい作品のリスト。
          </p>
          <div class="list">
            <a class="btn pri" href="/auth/google">
              Google でログイン
            </a>
            <a class="btn" href="/auth/discord">
              Discord でログイン
            </a>
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
  ),
)

// 部品見本。UI_GALLERY=1 のときだけ有効
ui.get('/_ui', (c) => {
  if (c.env.UI_GALLERY !== '1') return c.notFound()
  return c.html(<Gallery />)
})

export default ui
