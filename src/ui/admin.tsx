// オーナー画面（/admin/*）のフォームと一覧。値は src/admin/validate.ts の Form（trim 済みの文字列）で受け取り、
// エラー時は送信値をそのまま埋め戻す（エスケープは JSX に任せる）。

import type { Child } from 'hono/jsx'
import type { Form } from '../admin/validate'
import type { OrgAliasRow, RunRow, WorkAliasRow } from '../db/master'
import {
  organizationAliasKinds,
  runChannels,
  shopKinds,
  workAliasKinds,
  workKinds,
} from '../db/schema'
import type { Candidate } from '../lib/match'
import { prefectures } from '../lib/prefectures'
import {
  Checkbox,
  Empty,
  Field,
  FormErrors,
  Menu,
  MenuItem,
  Pager,
  SearchIcon,
  Select,
  TopBar,
} from './components'
import { Layout } from './Layout'
import {
  matchReasonLabel,
  organizationAliasKindLabels,
  runChannelLabels,
  shopKindLabels,
  workAliasKindLabels,
  workKindLabels,
} from './labels'
import { formatPeriod } from './master'

type FormProps = { action: string; values: Form; errors?: readonly string[] }
type OrgOption = { id: string; name: string }

const orgSelectOptions = (orgs: readonly OrgOption[]) =>
  orgs.map((o) => ({ value: o.id, label: o.name }))

// 全ページ見開き 1 枚（single）、タブは設定
export const AdminPage = ({ title, children }: { title: string; children?: Child }) => (
  <Layout title={title} tab="settings" single left={children} />
)

export const AdminNotFound = ({ back }: { back: string }) => (
  <>
    <TopBar back={back} label="404" />
    <Empty>見つかりませんでした。</Empty>
  </>
)

export const Saved = () => (
  <p class="note" role="status">
    保存しました
  </p>
)

// 統合済みの行の編集ページ。フォームは出さない
export const MergedNotice = ({ href, name }: { href: string; name: string }) => (
  <div class="sect" style="margin-top:4px">
    <p>
      統合済み → <a href={href}>{name}</a>
    </p>
  </div>
)

const SubmitButton = () => (
  <button type="submit" class="btn pri">
    保存
  </button>
)

export const OrgForm = ({ action, values, errors = [] }: FormProps) => (
  <form method="post" action={action} class="list">
    <FormErrors errors={errors} />
    <Field label="名前" name="name" value={values.name} required />
    <Field label="公式サイト" name="site_url" type="url" value={values.site_url} />
    <Field
      label="escape.id の URL"
      name="escape_id_url"
      type="url"
      value={values.escape_id_url}
      placeholder="https://escape.id/〇〇-org/"
    />
    <Field label="メモ" name="note" value={values.note} multiline />
    <SubmitButton />
  </form>
)

const aliasPeriod = (since: string | null, until: string | null): string =>
  since || until ? `（${since ?? ''}〜${until ?? ''}）` : ''

// 団体の別名一覧（削除ボタン付き）と追加フォーム
export const OrgAliasSection = (props: {
  orgId: string
  aliases: readonly OrgAliasRow[]
  values: Form
  errors?: readonly string[]
}) => (
  <div class="sect">
    <h2>別名</h2>
    {props.aliases.length ? (
      <div class="list">
        {props.aliases.map((a) => (
          <div class="card">
            <div class="row">
              <span>
                {organizationAliasKindLabels[a.kind]}: {a.name}
                {aliasPeriod(a.since, a.until)}
              </span>
              <form method="post" action={`/admin/org-aliases/${a.id}/delete`}>
                <button type="submit" class="btn danger">
                  削除
                </button>
              </form>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <p class="note">別名はまだありません。</p>
    )}
    <form method="post" action={`/admin/orgs/${props.orgId}/aliases`} class="list">
      <FormErrors errors={props.errors ?? []} />
      <Field label="別名" name="name" value={props.values.name} required />
      <Select
        label="種類"
        name="kind"
        options={organizationAliasKinds.map((k) => ({
          value: k,
          label: organizationAliasKindLabels[k],
        }))}
        value={props.values.kind}
        blank="（選択）"
        required
      />
      <div class="grid2">
        <Field label="開始日" name="since" type="date" value={props.values.since} />
        <Field label="終了日" name="until" type="date" value={props.values.until} />
      </div>
      <button type="submit" class="btn">
        別名を追加
      </button>
    </form>
  </div>
)

export const VenueForm = ({
  action,
  values,
  errors = [],
  orgs,
}: FormProps & { orgs: readonly OrgOption[] }) => (
  <form method="post" action={action} class="list">
    <FormErrors errors={errors} />
    <Field label="名前" name="name" value={values.name} required />
    <Select
      label="都道府県"
      name="prefecture"
      options={prefectures.map((p) => ({ value: p, label: p }))}
      value={values.prefecture}
      blank="（未設定）"
    />
    <Field label="住所" name="address" value={values.address} />
    <Select
      label="運営団体"
      name="organization_id"
      options={orgSelectOptions(orgs)}
      value={values.organization_id}
      blank="（未設定）"
    />
    <SubmitButton />
  </form>
)

export const ShopForm = ({
  action,
  values,
  errors = [],
  orgs,
}: FormProps & { orgs: readonly OrgOption[] }) => (
  <form method="post" action={action} class="list">
    <FormErrors errors={errors} />
    <Field label="名前" name="name" value={values.name} required />
    <Select
      label="種類"
      name="kind"
      options={shopKinds.map((k) => ({ value: k, label: shopKindLabels[k] }))}
      value={values.kind}
      blank="（選択）"
      required
    />
    <Field label="URL" name="url" type="url" value={values.url} />
    <Select
      label="団体"
      name="organization_id"
      options={orgSelectOptions(orgs)}
      value={values.organization_id}
      blank="（未設定）"
    />
    <SubmitButton />
  </form>
)

// 作成時の重複チェックで止めたときの候補一覧
const DuplicateCandidates = ({ candidates }: { candidates: readonly Candidate[] }) => (
  <div class="list" role="alert">
    <p class="note">似た作品があります。重複でなければもう一度「保存」を押すと作成します。</p>
    <Menu>
      {candidates.map((c) => (
        <MenuItem
          label={c.name}
          note={[c.organization?.name, `score ${c.score.toFixed(2)}`, matchReasonLabel(c.reason)]
            .filter(Boolean)
            .join(' · ')}
          href={`/admin/works/${c.id}`}
        />
      ))}
    </Menu>
  </div>
)

// candidates があれば上に出す。confirm（確認済みの norm(title)）を hidden で付け、同じ題名の再送で作成させる
export const WorkForm = ({
  action,
  values,
  errors = [],
  orgs,
  candidates = [],
  confirm,
}: FormProps & {
  orgs: readonly OrgOption[]
  candidates?: readonly Candidate[]
  confirm?: string
}) => (
  <form method="post" action={action} class="list">
    {candidates.length ? <DuplicateCandidates candidates={candidates} /> : null}
    {confirm ? <input type="hidden" name="confirm" value={confirm} /> : null}
    <FormErrors errors={errors} />
    <Field label="題名" name="title" value={values.title} required />
    <Select
      label="形式"
      name="kind"
      options={workKinds.map((k) => ({ value: k, label: workKindLabels[k] }))}
      value={values.kind}
      blank="（未設定）"
    />
    <Select
      label="団体"
      name="primary_organization_id"
      options={orgSelectOptions(orgs)}
      value={values.primary_organization_id}
      blank="（未設定）"
    />
    <Field label="公式サイト" name="official_url" type="url" value={values.official_url} />
    <Field label="説明" name="description" value={values.description} multiline />
    <div class="grid2">
      <Field
        label="最少人数"
        name="player_min"
        type="number"
        inputmode="numeric"
        min="1"
        max="99"
        value={values.player_min}
      />
      <Field
        label="最多人数"
        name="player_max"
        type="number"
        inputmode="numeric"
        min="1"
        max="99"
        value={values.player_max}
      />
    </div>
    <div class="grid2">
      <Field
        label="所要時間（分）"
        name="estimated_minutes"
        type="number"
        inputmode="numeric"
        min="1"
        max="6000"
        value={values.estimated_minutes}
      />
      <Field
        label="制限時間（分）"
        name="time_limit_minutes"
        type="number"
        inputmode="numeric"
        min="1"
        max="6000"
        value={values.time_limit_minutes}
      />
    </div>
    <Field
      label="初演・発売日"
      name="first_released_on"
      type="date"
      value={values.first_released_on}
    />
    <SubmitButton />
  </form>
)

// 作品の別名一覧（削除ボタン付き）と追加フォーム。団体の別名と同じ形
export const WorkAliasSection = (props: {
  workId: string
  aliases: readonly WorkAliasRow[]
  values: Form
  errors?: readonly string[]
}) => (
  <div class="sect">
    <h2>別名</h2>
    {props.aliases.length ? (
      <div class="list">
        {props.aliases.map((a) => (
          <div class="card">
            <div class="row">
              <span>
                {workAliasKindLabels[a.kind]}: {a.title}
              </span>
              <form method="post" action={`/admin/work-aliases/${a.id}/delete`}>
                <button type="submit" class="btn danger">
                  削除
                </button>
              </form>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <p class="note">別名はまだありません。</p>
    )}
    <form method="post" action={`/admin/works/${props.workId}/aliases`} class="list">
      <FormErrors errors={props.errors ?? []} />
      <Field label="別名" name="title" value={props.values.title} required />
      <Select
        label="種類"
        name="kind"
        options={workAliasKinds.map((k) => ({ value: k, label: workAliasKindLabels[k] }))}
        value={props.values.kind}
        blank="（選択）"
        required
      />
      <button type="submit" class="btn">
        別名を追加
      </button>
    </form>
  </div>
)

// 回の場所（会場 / 販売先 / オンライン）
const runPlace = (r: RunRow): string => {
  if (r.channel === 'performance') {
    return r.venue ? [r.venue.prefecture, r.venue.name].filter(Boolean).join(' · ') : '会場未定'
  }
  if (r.channel === 'sale') return r.shop?.name ?? ''
  return 'オンライン'
}

// 作品の編集ページの回一覧。並びは compareRuns（getAdminWork が並べて返す）
export const WorkRunsSection = ({ workId, runs }: { workId: string; runs: readonly RunRow[] }) => (
  <div class="sect">
    <h2>回</h2>
    {runs.length ? (
      <Menu>
        {runs.map((r) => (
          <MenuItem
            label={[runChannelLabels[r.channel], runPlace(r), formatPeriod(r)]
              .filter(Boolean)
              .join(' · ')}
            note="編集"
            href={`/admin/runs/${r.id}`}
          />
        ))}
      </Menu>
    ) : (
      <p class="note">回はまだありません。</p>
    )}
    <a class="btn" href={`/admin/works/${workId}/runs/new`}>
      ＋ 回を追加
    </a>
  </div>
)

type VenueOption = { id: string; name: string; prefecture: string | null }

export const RunForm = ({
  action,
  values,
  errors = [],
  orgs,
  venues,
  shops,
}: FormProps & {
  orgs: readonly OrgOption[]
  venues: readonly VenueOption[]
  shops: readonly OrgOption[]
}) => (
  <form method="post" action={action} class="list">
    <FormErrors errors={errors} />
    <Select
      label="種別"
      name="channel"
      options={runChannels.map((k) => ({ value: k, label: runChannelLabels[k] }))}
      value={values.channel}
      blank="（選択）"
      required
    />
    <Select
      label="名義団体"
      name="organization_id"
      options={orgSelectOptions(orgs)}
      value={values.organization_id}
      blank="（未設定）"
    />
    <Field label="名義の表記" name="billed_as" value={values.billed_as} />
    <Select
      label="会場（公演のみ）"
      name="venue_id"
      options={venues.map((v) => ({
        value: v.id,
        label: [v.prefecture, v.name].filter(Boolean).join(' · '),
      }))}
      value={values.venue_id}
      blank="（未設定）"
    />
    <Select
      label="販売先（販売のみ・必須）"
      name="shop_id"
      options={orgSelectOptions(shops)}
      value={values.shop_id}
      blank="（未設定）"
    />
    <div class="grid2">
      <Field label="開始日" name="start_on" type="date" value={values.start_on} />
      <Field label="終了日" name="end_on" type="date" value={values.end_on} />
    </div>
    <Checkbox label="常設（公演のみ）" name="is_permanent" checked={values.is_permanent === '1'} />
    <Field
      label="escape.id の URL"
      name="escape_id_url"
      type="url"
      value={values.escape_id_url}
      placeholder="https://escape.id/〇〇-org/e-〇〇/"
    />
    <Field label="チケットの URL" name="ticket_url" type="url" value={values.ticket_url} />
    <Field
      label="価格（円）"
      name="price_yen"
      type="number"
      inputmode="numeric"
      min="0"
      max="999999"
      value={values.price_yen}
    />
    <Field
      label="escape.id の type（生値）"
      name="escape_type_raw"
      value={values.escape_type_raw}
    />
    <Field label="メモ" name="note" value={values.note} multiline />
    <SubmitButton />
  </form>
)

export type AdminListRow = { href: string; label: string; note?: string | null }

// 管理一覧。base は /admin/orgs など。newHref が無ければ「新規」を出さない
export const AdminList = (props: {
  label: string
  base: string
  newHref?: string
  q: string
  page: number
  hasNext: boolean
  rows: readonly AdminListRow[]
}) => (
  <>
    <TopBar
      back="/admin"
      label={props.label}
      action={
        props.newHref ? (
          <a class="btn ghost" style="min-height:40px" href={props.newHref}>
            ＋ 新規
          </a>
        ) : undefined
      }
    />
    <form class="search" method="get" action={props.base}>
      <SearchIcon />
      <input
        type="search"
        name="q"
        value={props.q}
        placeholder="名前で検索"
        aria-label={`${props.label}を検索`}
      />
    </form>
    {props.rows.length ? (
      <Menu>
        {props.rows.map((r) => (
          <MenuItem label={r.label} note={r.note ?? undefined} href={r.href} />
        ))}
      </Menu>
    ) : props.q.trim() ? (
      <Empty>「{props.q}」に一致するものはありません</Empty>
    ) : (
      <Empty>まだ登録されていません。</Empty>
    )}
    <Pager base={props.base} page={props.page} hasNext={props.hasNext} params={{ q: props.q }} />
  </>
)
