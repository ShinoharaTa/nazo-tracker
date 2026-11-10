// マスタ（作品・団体・会場）の閲覧画面。データは src/db/master.ts から受け取る。
// 外部リンクの href には DB の値を出す。http(s) で始まらない値はリンクにしない（Ext）。

import type { Child } from 'hono/jsx'
import type {
  OrgDetailData,
  RunRow,
  VenueDetailData,
  WorkDetailData,
  WorkListItem,
} from '../db/master'
import { Empty, Menu, MenuItem, Ticket, TopBar } from './components'
import {
  type AttemptStatus,
  attemptStatusLabels,
  organizationAliasKindLabels,
  runChannelLabels,
  workAliasKindLabels,
  workKindLabels,
} from './labels'

type Period = Pick<RunRow, 'startOn' | 'endOn' | 'isPermanent'>

// 日付は YYYY-MM-DD のまま
export const formatPeriod = (r: Period): string => {
  if (r.isPermanent === 1) return r.endOn ? `常設 · 〜${r.endOn}` : '常設'
  if (r.startOn && r.endOn) return `${r.startOn}〜${r.endOn}`
  if (r.startOn) return `${r.startOn}〜`
  if (r.endOn) return `〜${r.endOn}`
  return '期間未定'
}

export const formatPlayers = (min: number | null, max: number | null): string | null => {
  if (min !== null && max !== null) return min === max ? `${min} 人` : `${min}〜${max} 人`
  if (min !== null) return `${min} 人〜`
  if (max !== null) return `〜${max} 人`
  return null
}

const formatYen = (n: number): string => `¥${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`

// today は todayJst()（YYYY-MM-DD）
export const runStatus = (
  r: Pick<RunRow, 'channel' | 'startOn' | 'endOn'>,
  today: string,
): string => {
  if (r.endOn && r.endOn < today) return '終了'
  if (r.startOn && r.startOn > today) return '予定'
  return r.channel === 'performance' ? '開催中' : r.channel === 'online' ? '配信中' : '販売中'
}

const kindLabel = (kind: WorkListItem['kind']) => (kind ? workKindLabels[kind] : null)

// 一覧の stub に出すエリア
const area = (rep: RunRow | null): string => {
  if (!rep) return ''
  if (rep.channel === 'performance') return rep.venue?.prefecture ?? '会場未定'
  return rep.channel === 'online' ? 'オンライン' : '通販'
}

// http(s) 以外のスキームはリンクにしない
const Ext = ({ href, children }: { href: string; children?: Child }) =>
  /^https?:\/\//i.test(href) ? (
    <a href={href} rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  )

// 作品一覧の 1 行。hrefBase の後ろに作品 id を付けてリンクにする（記録の作品選択では /records/new?work=）。
// chip / extra はマイリスト用（extra を渡すと期間の代わりに出す）
export const WorkTicket = ({
  w,
  selected,
  hrefBase = '/works/',
  chip,
  extra,
}: {
  w: WorkListItem
  selected?: boolean
  hrefBase?: string
  chip?: Child
  extra?: string
}) => {
  const k = kindLabel(w.kind)
  return (
    <Ticket
      href={`${hrefBase}${w.id}`}
      selected={selected}
      stub={
        <span class="nd">
          {k}
          {k ? <br /> : null}
          {area(w.rep)}
        </span>
      }
      meta={[k, w.org?.name].filter(Boolean).join(' · ')}
      title={w.title}
      chip={chip}
      extra={extra ?? (w.rep ? formatPeriod(w.rep) : undefined)}
    />
  )
}

// 会場・販売先・オンラインの行
const RunPlace = ({ r }: { r: RunRow }) => {
  if (r.channel === 'performance') {
    if (!r.venue) return <span>会場未定</span>
    return (
      <a href={`/venues/${r.venue.id}`}>
        {[r.venue.prefecture, r.venue.name].filter(Boolean).join(' · ')}
      </a>
    )
  }
  if (r.channel === 'sale') {
    if (!r.shop) return null
    return r.shop.url ? <Ext href={r.shop.url}>{r.shop.name}</Ext> : <span>{r.shop.name}</span>
  }
  return <span>オンライン</span>
}

// 回 1 件。primaryOrg は作品の団体（名義・団体リンクを出すか決めるのに使う）。editHref はオーナーのときだけ
export const RunCard = (props: {
  r: RunRow
  today: string
  primaryOrg: { id: string; name: string } | null
  editHref?: string
}) => {
  const { r, primaryOrg } = props
  const orgName = r.org?.name ?? primaryOrg?.name
  const billed = r.billedAs && r.billedAs !== orgName ? r.billedAs : null
  const otherOrg = r.org && r.org.id !== primaryOrg?.id ? r.org : null
  const links = [
    r.escapeIdUrl ? <Ext href={r.escapeIdUrl}>escape.id</Ext> : null,
    r.ticketUrl ? <Ext href={r.ticketUrl}>チケット</Ext> : null,
  ].filter(Boolean)
  return (
    <div class="card">
      <div class="row" style="justify-content:flex-start">
        <span>{runChannelLabels[r.channel]} · </span>
        <span class="badge">{runStatus(r, props.today)}</span>
        {props.editHref ? (
          <a href={props.editHref} style="margin-left:auto">
            編集
          </a>
        ) : null}
      </div>
      <div>
        <RunPlace r={r} />
      </div>
      <div class="note">{formatPeriod(r)}</div>
      {billed || otherOrg ? (
        <div class="note">
          {billed ? `名義: ${billed}` : null}
          {billed && otherOrg ? ' · ' : null}
          {otherOrg ? <a href={`/orgs/${otherOrg.id}`}>{otherOrg.name}</a> : null}
        </div>
      ) : null}
      {r.priceYen !== null ? <div>{formatYen(r.priceYen)}</div> : null}
      {links.length ? (
        <div class="row" style="justify-content:flex-start">
          {links}
        </div>
      ) : null}
    </div>
  )
}

const KvRow = ({ label, children }: { label: string; children?: Child }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
)

// 作品ページに出す本人の記録とマイリスト登録の有無。null は未ログイン
export type WorkMine = {
  wished: boolean
  attempts: { id: string; status: AttemptStatus; displayOn: string | null; attemptNo: number }[]
} | null

// editHref / runEditHref はオーナーのときだけ（作品と各回の「編集」）
export const WorkDetail = ({
  w,
  today,
  mine,
  editHref,
  runEditHref,
}: {
  w: WorkDetailData
  today: string
  mine: WorkMine
  editHref?: string
  runEditHref?: (runId: string) => string
}) => {
  const k = kindLabel(w.kind)
  const players = formatPlayers(w.playerMin, w.playerMax)
  return (
    <>
      <TopBar back="/works" label="作品" action={EditLink({ href: editHref })} />
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:6px">
          <span class="meta">
            {k}
            {k && w.org ? ' · ' : null}
            {w.org ? <a href={`/orgs/${w.org.id}`}>{w.org.name}</a> : null}
          </span>
          <span class="title" style="font-size:22px">
            {w.title}
          </span>
        </div>
        {/* TODO(P3): countsFor に差し替える */}
        <div class="nums">
          <div class="num">
            <span>プレイ済み</span>
            <b>—</b>
          </div>
          <div class="num">
            <span>マイリスト</span>
            <b>—</b>
          </div>
        </div>
      </div>
      <div class="sect">
        {/* 未ログインは /login へ（next は作らない） */}
        {mine ? (
          <div class="btns">
            {/* form の箱を消し、中の button を .btns の並びに入れる */}
            <form
              method="post"
              action={mine.wished ? '/records/wishlist/delete' : '/records/wishlist'}
              style="display:contents"
            >
              <input type="hidden" name="work_id" value={w.id} />
              <input type="hidden" name="back" value="work" />
              <button type="submit" class="btn">
                {mine.wished ? 'マイリストから外す' : 'マイリストに追加'}
              </button>
            </form>
            <a class="btn pri" href={`/records/new?work=${w.id}`}>
              記録する
            </a>
          </div>
        ) : (
          <div class="btns">
            <a class="btn" href="/login">
              マイリストに追加
            </a>
            <a class="btn" href="/login">
              記録する
            </a>
          </div>
        )}
      </div>
      {mine?.attempts.length ? (
        <div class="sect">
          <h2>あなたの記録</h2>
          <Menu>
            {mine.attempts.map((a) => (
              <MenuItem
                label={attemptStatusLabels[a.status]}
                note={`${a.displayOn ?? '日付なし'}${a.attemptNo >= 2 ? ` · ${a.attemptNo}回目` : ''}`}
                href={`/records/${a.id}`}
              />
            ))}
          </Menu>
        </div>
      ) : null}
      {w.description ? (
        <div class="sect">
          <h2>説明</h2>
          <p style="margin:0;white-space:pre-wrap">{w.description}</p>
        </div>
      ) : null}
      <div class="sect">
        <h2>基本情報</h2>
        <dl class="kv">
          {w.org ? (
            <KvRow label="団体">
              <a href={`/orgs/${w.org.id}`}>{w.org.name}</a>
            </KvRow>
          ) : null}
          {k ? <KvRow label="形式">{k}</KvRow> : null}
          {players ? <KvRow label="人数">{players}</KvRow> : null}
          {w.estimatedMinutes !== null ? (
            <KvRow label="所要">{`${w.estimatedMinutes} 分`}</KvRow>
          ) : null}
          {w.timeLimitMinutes !== null ? (
            <KvRow label="制限時間">{`${w.timeLimitMinutes} 分`}</KvRow>
          ) : null}
          {w.firstReleasedOn ? <KvRow label="初演・発売日">{w.firstReleasedOn}</KvRow> : null}
          {w.officialUrl ? (
            <KvRow label="公式サイト">
              <Ext href={w.officialUrl}>{w.officialUrl}</Ext>
            </KvRow>
          ) : null}
        </dl>
      </div>
      <div class="sect">
        <h2>公演・配信・販売</h2>
        {w.runs.length ? (
          w.runs.map((r) => (
            <RunCard r={r} today={today} primaryOrg={w.org} editHref={runEditHref?.(r.id)} />
          ))
        ) : (
          <Empty>回の情報はまだありません</Empty>
        )}
      </div>
      {w.aliases.length ? (
        <div class="sect">
          <h2>別名</h2>
          <ul>
            {w.aliases.map((a) => (
              <li>
                {workAliasKindLabels[a.kind]}: {a.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

const aliasPeriod = (since: string | null, until: string | null): string =>
  since || until ? `（${since ?? ''}〜${until ?? ''}）` : ''

// オーナーのときだけ編集画面へのリンク（右上）
const EditLink = ({ href }: { href?: string }) =>
  href ? (
    <a class="btn ghost" style="min-height:40px" href={href}>
      編集
    </a>
  ) : undefined

export const OrgDetail = ({ o, editHref }: { o: OrgDetailData; editHref?: string }) => (
  <>
    <TopBar back="/works" label="団体" action={EditLink({ href: editHref })} />
    <div class="card">
      <span class="title" style="font-size:22px">
        {o.name}
      </span>
      {o.siteUrl || o.escapeIdUrl ? (
        <div class="row" style="justify-content:flex-start">
          {o.siteUrl ? <Ext href={o.siteUrl}>公式サイト</Ext> : null}
          {o.escapeIdUrl ? <Ext href={o.escapeIdUrl}>escape.id</Ext> : null}
        </div>
      ) : null}
      {o.note ? <p style="margin:0;white-space:pre-wrap">{o.note}</p> : null}
    </div>
    {o.aliases.length ? (
      <div class="sect">
        <h2>別名</h2>
        <ul>
          {o.aliases.map((a) => (
            <li>
              {organizationAliasKindLabels[a.kind]}: {a.name}
              {aliasPeriod(a.since, a.until)}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {o.venues.length ? (
      <div class="sect">
        <h2>運営する会場</h2>
        <ul>
          {o.venues.map((v) => (
            <li>
              <a href={`/venues/${v.id}`}>{[v.prefecture, v.name].filter(Boolean).join(' · ')}</a>
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    <div class="sect">
      <h2>作品</h2>
      {o.works.length ? (
        <div class="list">
          {o.works.map((w) => (
            <WorkTicket w={w} />
          ))}
        </div>
      ) : (
        <Empty>作品はまだ登録されていません。</Empty>
      )}
    </div>
  </>
)

export const VenueDetail = ({
  v,
  today,
  editHref,
}: {
  v: VenueDetailData
  today: string
  editHref?: string
}) => (
  <>
    <TopBar back="/works" label="会場" action={EditLink({ href: editHref })} />
    <div class="card">
      <span class="title" style="font-size:22px">
        {v.name}
      </span>
      <dl class="kv">
        {v.prefecture ? <KvRow label="都道府県">{v.prefecture}</KvRow> : null}
        {v.address ? <KvRow label="住所">{v.address}</KvRow> : null}
        {v.org ? (
          <KvRow label="運営団体">
            <a href={`/orgs/${v.org.id}`}>{v.org.name}</a>
          </KvRow>
        ) : null}
      </dl>
    </div>
    <div class="sect">
      <h2>この会場の公演</h2>
      {v.runs.length ? (
        <div class="list">
          {v.runs.map((r) => (
            <Ticket
              href={`/works/${r.work.id}`}
              stub={<span class="nd">{kindLabel(r.work.kind)}</span>}
              meta={runStatus(r, today)}
              title={r.work.title}
              extra={formatPeriod(r)}
            />
          ))}
        </div>
      ) : (
        <Empty>この会場の公演はまだありません。</Empty>
      )}
    </div>
  </>
)
