// 記録（/records/*）の画面。データは src/db/scoped.ts の own() から受け取る。
// ネタバレメモの本文はここでは出さない（SpoilerCard の src から遅延取得。src/ui/spoiler.tsx）。

import type { Child } from 'hono/jsx'
import type { GenreRow, RunRow, WorkDetailData, WorkListItem } from '../db/master'
import {
  type OwnAttempt,
  type OwnAttemptRow,
  type OwnSession,
  type OwnWishRow,
  sessionOutcomes,
} from '../db/scoped'
import type { Form } from '../lib/form'
import { isoToJstDate } from '../lib/time'
import {
  Checkbox,
  Empty,
  Field,
  FormErrors,
  Pager,
  SearchIcon,
  Select,
  SpoilerCard,
  StatusChip,
  StatusSeg,
  StubDate,
  Tabs,
  Ticket,
  TopBar,
} from './components'
import {
  type AttemptStatus,
  attemptStatusLabels,
  outcomeLabels,
  runChannelLabels,
  workKindLabels,
} from './labels'
import { formatPeriod, WorkTicket } from './master'

export type RecordsTab = 'all' | 'pending' | 'wish'

const recordsTabs: readonly { key: RecordsTab; label: string; href: string }[] = [
  { key: 'all', label: 'すべて', href: '/records' },
  { key: 'pending', label: '進行中・積み謎', href: '/records?tab=pending' },
  { key: 'wish', label: 'マイリスト', href: '/records?tab=wish' },
]

// 秒 → 「{h}時間{m}分」（分は四捨五入。1 時間未満は「{m}分」）。NULL と 0 分は null（表示しない）
export const formatDuration = (sec: number | null): string | null => {
  if (sec === null) return null
  const min = Math.round(sec / 60)
  if (min === 0) return null
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h}時間${m}分` : `${m}分`
}

const kindText = (kind: OwnAttemptRow['work']['kind']) => (kind ? workKindLabels[kind] : null)

// 記録一覧の 1 行
export const RecordTicket = ({ a, selected }: { a: OwnAttemptRow; selected?: boolean }) => {
  const extra = [
    a.difficulty !== null ? `難易度 ${a.difficulty}` : null,
    a.companions ? `同行 ${a.companions}` : null,
    a.attemptNo >= 2 ? `${a.attemptNo}回目` : null,
  ].filter(Boolean)
  return (
    <Ticket
      href={`/records/${a.id}`}
      selected={selected}
      stub={<StubDate date={a.displayOn} />}
      meta={[kindText(a.work.kind), a.work.org?.name].filter(Boolean).join(' · ') || '—'}
      title={a.work.title}
      chip={<StatusChip status={a.status} />}
      extra={extra.length ? extra.join(' · ') : undefined}
    />
  )
}

// マイリストの 1 行。記録があれば最新のステータス、無ければ「未プレイ」
const WishRow = ({ w }: { w: OwnWishRow }) => (
  <div class="row wrow">
    <WorkTicket
      w={{ id: w.workId, title: w.title, kind: w.kind, org: w.org, rep: null }}
      chip={
        w.latestStatus ? <StatusChip status={w.latestStatus} /> : <span class="mark">未プレイ</span>
      }
      extra={`登録 ${isoToJstDate(w.createdAt) ?? '—'}`}
    />
    <form method="post" action="/records/wishlist/delete">
      <input type="hidden" name="work_id" value={w.workId} />
      <input type="hidden" name="back" value="wish" />
      <button type="submit" class="btn ghost">
        外す
      </button>
    </form>
  </div>
)

// マイリスト（tab=wish）。unplayed は「未プレイだけ」
export const WishList = ({
  items,
  unplayed,
  page,
  hasNext,
}: {
  items: OwnWishRow[]
  unplayed: boolean
  page: number
  hasNext: boolean
}) => (
  <>
    <nav class="chips" aria-label="マイリストの絞り込み">
      {[
        { on: !unplayed, label: 'すべて', href: '/records?tab=wish' },
        { on: unplayed, label: '未プレイだけ', href: '/records?tab=wish&unplayed=1' },
      ].map((f) =>
        f.on ? (
          <a class="fchip on" href={f.href} aria-current="page">
            {f.label}
          </a>
        ) : (
          <a class="fchip" href={f.href}>
            {f.label}
          </a>
        ),
      )}
    </nav>
    <div class="list">
      {items.length ? (
        items.map((w) => <WishRow w={w} />)
      ) : (
        <Empty>
          マイリストは空です。
          <br />
          作品ページの「マイリストに追加」から登録できます。
        </Empty>
      )}
      <p class="note">
        マイリストからは自動では外れません。遊び終わったら「外す」で外してください。
      </p>
    </div>
    <Pager
      base="/records"
      page={page}
      hasNext={hasNext}
      params={{ tab: 'wish', unplayed: unplayed ? '1' : '' }}
    />
  </>
)

export type RecordsListProps = {
  tab: RecordsTab
  items: OwnAttemptRow[]
  // tab=wish のときの行と「未プレイだけ」
  wishItems?: OwnWishRow[]
  unplayed?: boolean
  page: number
  hasNext: boolean
  playedCount: number
  selectedId?: string
}

// 記録一覧（左ページ）
export const RecordsList = ({
  tab,
  items,
  wishItems = [],
  unplayed = false,
  page,
  hasNext,
  playedCount,
  selectedId,
}: RecordsListProps) => (
  <>
    <TopBar
      title="記録"
      action={
        <a class="btn ghost" style="min-height:40px" href="/stats">
          {playedCount} 件プレイ ›
        </a>
      }
    />
    <Tabs items={recordsTabs} current={tab} label="記録の絞り込み" />
    {tab === 'wish' ? (
      <WishList items={wishItems} unplayed={unplayed} page={page} hasNext={hasNext} />
    ) : (
      <>
        <div class="list">
          {items.length ? (
            items.map((a) => <RecordTicket a={a} selected={a.id === selectedId} />)
          ) : tab === 'pending' ? (
            <Empty>進行中・積み謎はありません。</Empty>
          ) : (
            <Empty>
              まだ記録はありません。
              <br />
              「＋ 記録」から作品を選んで付けられます。
            </Empty>
          )}
        </div>
        <Pager
          base="/records"
          page={page}
          hasNext={hasNext}
          params={{ tab: tab === 'all' ? '' : tab }}
        />
      </>
    )}
  </>
)

// 検索結果から軽い記録のフォームへ。q はフォームの戻り先に引き継ぐ
const newRecordHrefBase = (q: string) =>
  q ? `/records/new?q=${encodeURIComponent(q)}&work=` : '/records/new?work='

// 記録の追加: 作品を選ぶ（右ページ）。q が空なら登録の新しい順
export const NewRecordSearch = (props: {
  q: string
  page: number
  items: WorkListItem[]
  hasNext: boolean
  errors?: readonly string[]
}) => (
  <>
    <TopBar back="/records" label="記録を追加" />
    <div class="sect" style="margin-top:4px">
      <h2>何を記録しますか？</h2>
      <FormErrors errors={props.errors ?? []} />
      <form class="search" method="get" action="/records/new">
        <SearchIcon />
        <input
          type="search"
          name="q"
          value={props.q}
          placeholder="作品名・団体で検索"
          aria-label="作品を検索"
        />
      </form>
      <div class="list">
        {props.items.length ? (
          props.items.map((w) => <WorkTicket w={w} hrefBase={newRecordHrefBase(props.q)} />)
        ) : props.q.trim() ? (
          <Empty>
            「{props.q}」に一致する作品はありません。作品の追加リクエストは P4 で入ります。
          </Empty>
        ) : (
          <Empty>作品はまだ登録されていません。</Empty>
        )}
      </div>
      <Pager
        base="/records/new"
        page={props.page}
        hasNext={props.hasNext}
        params={{ q: props.q }}
      />
    </div>
  </>
)

const workMeta = (w: { kind: WorkDetailData['kind']; org: { name: string } | null }) =>
  [kindText(w.kind), w.org?.name].filter(Boolean).join(' · ')

// 記録の追加: 軽い記録のフォーム（右ページ）。latest は同じ作品の既存の記録（attempt_no DESC の先頭）
export const NewRecordForm = (props: {
  w: WorkDetailData
  existing: { id: string; status: AttemptStatus; displayOn: string | null }[]
  values: Form
  errors?: readonly string[]
  // 検索語。戻り先の /records/new?q= に引き継ぐ
  q?: string
}) => {
  const { w, existing, values } = props
  const latest = existing[0]
  return (
    <>
      <TopBar
        back={props.q ? `/records/new?q=${encodeURIComponent(props.q)}` : '/records/new'}
        label="記録を追加"
      />
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:6px">
          <span class="meta">{workMeta(w)}</span>
          <span class="title" style="font-size:22px">
            {w.title}
          </span>
        </div>
        <a href={`/works/${w.id}`}>作品を見る ›</a>
      </div>
      {latest ? (
        <p class="note">
          この作品の記録が {existing.length} 件あります（最新:{' '}
          <a href={`/records/${latest.id}`}>
            {attemptStatusLabels[latest.status]} {latest.displayOn ?? '日付なし'}
          </a>
          ）。新しい挑戦として追加します。
        </p>
      ) : null}
      <form method="post" action="/records" class="sect">
        <FormErrors errors={props.errors ?? []} />
        <input type="hidden" name="work_id" value={w.id} />
        {props.q ? <input type="hidden" name="q" value={props.q} /> : null}
        <StatusSeg
          name="status"
          idPrefix="new-status"
          value={
            Object.hasOwn(attemptStatusLabels, values.status)
              ? (values.status as AttemptStatus)
              : undefined
          }
        />
        <Field label="日付" name="on" type="date" value={values.on} />
        <p class="note">
          買った → 買った日、進行中 → 始めた日、クリア・失敗・断念 → 終わった日として保存します。
        </p>
        <button type="submit" class="btn pri">
          保存
        </button>
      </form>
    </>
  )
}

const KvRow = ({ label, children }: { label: string; children?: Child }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
)

const runPeriod = (r: { startOn: string | null; endOn: string | null }): string | null => {
  if (r.startOn && r.endOn) return `${r.startOn}〜${r.endOn}`
  if (r.startOn) return `${r.startOn}〜`
  if (r.endOn) return `〜${r.endOn}`
  return null
}

// 進行ログの 1 件。削除は <details> を開いてから押す 2 段（JS なし。POST /records/:id/sessions/:sid/delete）
const SessionLog = ({
  attemptId,
  s,
  last,
}: {
  attemptId: string
  s: OwnSession
  last: boolean
}) => (
  <div class="log">
    <div class="rail">
      <div class="dot" />
      {last ? null : <div class="ln" />}
    </div>
    <div class="body">
      <span class="sub">
        {[s.playedOn, formatDuration(s.durationSec)].filter(Boolean).join(' · ')}
      </span>
      <b>{s.progressNote ?? '記録'}</b>
      {[s.memo, s.locationText, s.companions].map((t) =>
        t ? (
          <span class="note" style="font-size:13px;white-space:pre-wrap">
            {t}
          </span>
        ) : null,
      )}
      <details>
        <summary class="note">削除</summary>
        <form method="post" action={`/records/${attemptId}/sessions/${s.id}/delete`}>
          <button type="submit" class="btn danger">
            {s.playedOn.slice(5).replace('-', '/')} のログを削除
          </button>
        </form>
      </details>
    </div>
  </div>
)

// 進行ログは新しい順に SESSIONS_SHOWN 件まで出し、残りは <details> に畳む（JS なし）
const SESSIONS_SHOWN = 5

const SessionLogs = ({ a }: { a: OwnAttempt }) => {
  const logs = a.sessions.map((s, i) => (
    <SessionLog attemptId={a.id} s={s} last={i === a.sessions.length - 1} />
  ))
  if (logs.length <= SESSIONS_SHOWN) return <>{logs}</>
  return (
    <>
      {logs.slice(0, SESSIONS_SHOWN)}
      <details class="older">
        <summary class="note">古い進行ログ {logs.length - SESSIONS_SHOWN} 件を表示</summary>
        {logs.slice(SESSIONS_SHOWN)}
      </details>
    </>
  )
}

const statusValueOf = (raw: string | undefined): AttemptStatus | undefined =>
  raw !== undefined && Object.hasOwn(attemptStatusLabels, raw) ? (raw as AttemptStatus) : undefined

// 詳細ページのステータス変更フォーム。values / errors は 400 の再描画のとき
export const StatusForm = ({
  a,
  values,
  errors,
}: {
  a: OwnAttempt
  values: Form
  errors?: readonly string[]
}) => (
  <form method="post" action={`/records/${a.id}/status`} class="list">
    <FormErrors errors={errors ?? []} />
    <StatusSeg name="status" idPrefix="status" value={statusValueOf(values.status)} />
    <Field label="日付" name="on" type="date" value={values.on} />
    <p class="note">空にすると今の日付を残します。</p>
    <button type="submit" class="btn">
      変更
    </button>
  </form>
)

// 記録の詳細（右ページ）。genres は記録に付いたジャンル（表示順）。
// statusValues / statusErrors はステータス変更フォームの値（400 の再描画では送信値）
export const RecordDetail = ({
  a,
  genres,
  created,
  saved,
  statusValues,
  statusErrors,
}: {
  a: OwnAttempt
  genres: GenreRow[]
  created?: boolean
  saved?: boolean
  statusValues: Form
  statusErrors?: readonly string[]
}) => {
  const meta = [kindText(a.work.kind), a.work.org?.name, a.run?.venue?.prefecture].filter(Boolean)
  const latest = a.sessions[0]
  const total = a.sessionDurationSec ?? a.durationSec
  const run = a.run
  // 結果の行に出す日付（一覧の日付と同じ優先順）
  const resultOn = a.finishedOn ?? a.startedOn ?? a.purchasedOn
  const kv = [
    a.purchasedOn ? <KvRow label="買った日">{a.purchasedOn}</KvRow> : null,
    a.startedOn ? <KvRow label="開始日">{a.startedOn}</KvRow> : null,
    a.finishedOn ? <KvRow label="終了日">{a.finishedOn}</KvRow> : null,
    run ? (
      <KvRow label="回">
        {[runChannelLabels[run.channel], run.venue?.name].filter(Boolean).join(' · ')}
        {runPeriod(run) ? <div class="note">{runPeriod(run)}</div> : null}
      </KvRow>
    ) : null,
    a.companions ? <KvRow label="同行者">{a.companions}</KvRow> : null,
    a.partySize !== null ? <KvRow label="人数">{`${a.partySize} 人`}</KvRow> : null,
    a.rating !== null ? <KvRow label="評価">{`${a.rating}/5`}</KvRow> : null,
  ].filter(Boolean)
  return (
    <>
      <TopBar
        back="/records"
        label="記録"
        action={
          <a class="btn ghost" href={`/records/${a.id}/edit`}>
            編集
          </a>
        }
      />
      {created ? (
        <div class="hint" role="status">
          <span class="hl draw">保存しました。日付・同行者・評価も足せます</span>
          <a class="btn" href={`/records/${a.id}/edit`}>
            足す
          </a>
        </div>
      ) : saved ? (
        <p class="note" role="status">
          <span class="hl draw">保存しました</span>
        </p>
      ) : null}
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:6px">
          <a class="meta" href={`/works/${a.workId}`}>
            {meta.length ? meta.join(' · ') : '作品を見る'} ›
          </a>
          <span class="title" style="font-size:22px">
            {a.work.title}
          </span>
        </div>
        <div class="res">
          <span class={`chip lg st-${a.status}${created ? ' stamp' : ''}`}>
            {attemptStatusLabels[a.status]}
          </span>
          {resultOn ? <span class="res-date hl">{resultOn.replaceAll('-', '.')}</span> : null}
          {a.attemptNo >= 2 || latest ? (
            <span class="pen">
              {[
                a.attemptNo >= 2 ? `${a.attemptNo}回目` : null,
                latest?.progressNote,
                latest ? `${a.sessionCount} 日目` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          ) : null}
        </div>
        <div class="nums">
          <div class="num">
            <span>難易度</span>
            <b>{a.difficulty ?? '–'}/5</b>
          </div>
          <div class="num">
            <span>物量</span>
            <b>{a.volume ?? '–'}/5</b>
          </div>
          <div class="num">
            <span>合計</span>
            <b>{formatDuration(total) ?? '–'}</b>
          </div>
        </div>
      </div>
      <div class="sect">
        <h2>ステータス</h2>
        <StatusForm a={a} values={statusValues} errors={statusErrors} />
      </div>
      {kv.length ? (
        <div class="sect">
          <h2>参加</h2>
          <dl class="kv">{kv}</dl>
        </div>
      ) : null}
      {a.memo ? (
        <div class="sect">
          <h2>メモ</h2>
          <p style="margin:0;white-space:pre-wrap">{a.memo}</p>
        </div>
      ) : null}
      {genres.length ? (
        <div class="sect">
          <h2>ジャンル</h2>
          <div class="gtags">
            {genres.map((g) => (
              <span class="gtag">{g.label}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div class="sect">
        <div class="row">
          <h2>進行ログ</h2>
          <a class="btn" href={`/records/${a.id}/sessions/new`}>
            ＋ 進行ログ
          </a>
        </div>
        {a.sessions.length ? <SessionLogs a={a} /> : <Empty>進行ログはまだありません。</Empty>}
      </div>
      <div class="sect">
        <h2>写真</h2>
        <div class="photos">
          <button
            type="button"
            class="ph add"
            aria-label="写真を追加"
            aria-disabled="true"
            disabled
          >
            ＋
          </button>
        </div>
        <p class="note">写真は P9 で追加できます。</p>
      </div>
      {/* TODO(P8): フレンド n 人 */}
      <div class="sect">
        <SpoilerCard
          src={`/records/${a.id}/spoiler`}
          count={{ memo: a.spoilerMemo ? 1 : 0, photos: 0 }}
        />
        <a href={`/records/${a.id}/spoiler/edit`}>ネタバレメモを編集</a>
      </div>
      <div class="sect">
        <a class="btn danger" href={`/records/${a.id}/delete`}>
          記録を削除
        </a>
      </div>
    </>
  )
}

const scoreOptions = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))

// 回の選択肢の場所。公演は会場、販売は販売先、配信はオンライン
const runPlace = (r: RunRow): string => {
  if (r.channel === 'performance') return r.venue?.name ?? '会場未定'
  if (r.channel === 'sale') return r.shop?.name ?? ''
  return 'オンライン'
}

const numText = (n: number | null) => (n === null ? '' : String(n))

// 編集フォームの初期値（記録の今の値）。ジャンルは a.genreIds
export const recordEditValues = (a: OwnAttempt): Form => ({
  status: a.status,
  run_id: a.runId ?? '',
  purchased_on: a.purchasedOn ?? '',
  started_on: a.startedOn ?? '',
  finished_on: a.finishedOn ?? '',
  duration_min: a.durationSec === null ? '' : String(Math.round(a.durationSec / 60)),
  party_size: numText(a.partySize),
  companions: a.companions ?? '',
  rating: numText(a.rating),
  difficulty: numText(a.difficulty),
  volume: numText(a.volume),
  memo: a.memo ?? '',
})

// 詳しい記録の編集（右ページ）。runs はその作品の回（compareRuns 順）、genres は選べるジャンル。
// ネタバレメモはここに出さない（/records/:id/spoiler/edit）
export const RecordEditForm = (props: {
  a: OwnAttempt
  runs: readonly RunRow[]
  genres: readonly GenreRow[]
  values: Form
  genreValues: readonly string[]
  errors?: readonly string[]
}) => {
  const { a, values } = props
  return (
    <>
      <TopBar back={`/records/${a.id}`} label="記録を編集" />
      <div class="card">
        <span class="title" style="font-size:22px">
          {a.work.title}
        </span>
      </div>
      <form method="post" action={`/records/${a.id}/edit`} class="sect list">
        <FormErrors errors={props.errors ?? []} />
        <StatusSeg name="status" idPrefix="edit-status" value={statusValueOf(values.status)} />
        <Select
          label="回"
          name="run_id"
          blank="指定しない"
          value={values.run_id}
          options={props.runs.map((r) => ({
            value: r.id,
            label: [runChannelLabels[r.channel], runPlace(r), formatPeriod(r)]
              .filter(Boolean)
              .join(' · '),
          }))}
        />
        <div class="grid2">
          <Field label="買った日" name="purchased_on" type="date" value={values.purchased_on} />
          <Field label="開始日" name="started_on" type="date" value={values.started_on} />
          <Field label="終了日" name="finished_on" type="date" value={values.finished_on} />
        </div>
        <div class="grid2">
          <Field
            label="所要（分）"
            name="duration_min"
            type="number"
            min="1"
            max="6000"
            inputmode="numeric"
            value={values.duration_min}
          />
          <Field
            label="人数"
            name="party_size"
            type="number"
            min="1"
            max="99"
            inputmode="numeric"
            value={values.party_size}
          />
        </div>
        <Field
          label="同行者"
          name="companions"
          placeholder="例: みお、けい"
          value={values.companions}
        />
        <div class="grid2">
          <Select
            label="評価"
            name="rating"
            blank="未評価"
            options={scoreOptions}
            value={values.rating}
          />
          <Select
            label="難易度"
            name="difficulty"
            blank="未評価"
            options={scoreOptions}
            value={values.difficulty}
          />
          <Select
            label="物量"
            name="volume"
            blank="未評価"
            options={scoreOptions}
            value={values.volume}
          />
        </div>
        {props.genres.length ? (
          <fieldset class="list genres">
            <legend class="note">ジャンル</legend>
            {props.genres.map((g) => (
              <Checkbox
                label={g.label}
                name="genre"
                value={g.id}
                checked={props.genreValues.includes(g.id)}
              />
            ))}
          </fieldset>
        ) : null}
        <Field label="メモ" name="memo" multiline value={values.memo} />
        <button type="submit" class="btn pri">
          保存
        </button>
      </form>
    </>
  )
}

// ネタバレメモの編集（右ページ）。本文を出すので応答には spoilerHeaders を付ける
export const SpoilerEditForm = (props: {
  a: OwnAttempt
  value: string
  errors?: readonly string[]
}) => (
  <>
    <TopBar back={`/records/${props.a.id}`} label="ネタバレメモを編集" />
    <form method="post" action={`/records/${props.a.id}/spoiler/edit`} class="spoil">
      <span class="lock">自分だけに表示されます。フレンドにも見えません。</span>
      <FormErrors errors={props.errors ?? []} />
      <Field label="ネタバレメモ" name="spoiler_memo" multiline value={props.value} />
      <button type="submit" class="btn pri">
        保存
      </button>
    </form>
  </>
)

// 進行ログの追加（右ページ）。outcome の既定は keep
export const SessionForm = (props: { a: OwnAttempt; values: Form; errors?: readonly string[] }) => {
  const { a, values } = props
  return (
    <>
      <TopBar back={`/records/${a.id}`} label="進行ログを追加" />
      <div class="card">
        <span class="title" style="font-size:22px">
          {a.work.title}
        </span>
      </div>
      <form method="post" action={`/records/${a.id}/sessions`} class="sect list">
        <FormErrors errors={props.errors ?? []} />
        <Field label="日付" name="played_on" type="date" value={values.played_on} required />
        <Field
          label="所要（分）"
          name="duration_min"
          type="number"
          min="1"
          max="6000"
          inputmode="numeric"
          value={values.duration_min}
        />
        <Field
          label="進み具合"
          name="progress_note"
          placeholder="例: 第 3 章まで"
          value={values.progress_note}
        />
        <Field label="場所" name="location_text" value={values.location_text} />
        <Field label="同行者" name="companions" value={values.companions} />
        <Field label="メモ" name="memo" multiline value={values.memo} />
        <fieldset class="list outcome">
          <legend class="note">結果</legend>
          {sessionOutcomes.map((o) => (
            <label>
              <input type="radio" name="outcome" value={o} checked={values.outcome === o} />{' '}
              {outcomeLabels[o]}
            </label>
          ))}
        </fieldset>
        <button type="submit" class="btn pri">
          保存
        </button>
      </form>
    </>
  )
}

// 記録の削除の確認（右ページ）。POST は同じ URL に confirm=yes
export const DeleteRecord = (props: { a: OwnAttempt; errors?: readonly string[] }) => (
  <>
    <TopBar back={`/records/${props.a.id}`} label="記録を削除" />
    <div class="card">
      <span class="title" style="font-size:22px">
        {props.a.work.title}
      </span>
    </div>
    <form method="post" action={`/records/${props.a.id}/delete`} class="sect list">
      <FormErrors errors={props.errors ?? []} />
      <p class="note">消えるもの: 記録、進行ログ {props.a.sessions.length} 件、ジャンル、写真</p>
      <p class="note">元に戻せません。</p>
      <Checkbox label="確認しました" name="confirm" value="yes" />
      <button type="submit" class="btn danger">
        削除する
      </button>
    </form>
  </>
)
