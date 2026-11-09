// オーナー画面（/admin/*）のフォームと一覧。値は src/admin/validate.ts の Form（trim 済みの文字列）で受け取り、
// エラー時は送信値をそのまま埋め戻す（エスケープは JSX に任せる）。

import type { Child } from 'hono/jsx'
import type { Form } from '../admin/validate'
import type { OrgAliasRow } from '../db/master'
import { organizationAliasKinds, shopKinds } from '../db/schema'
import { prefectures } from '../lib/prefectures'
import {
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
import { organizationAliasKindLabels, shopKindLabels } from './labels'

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
