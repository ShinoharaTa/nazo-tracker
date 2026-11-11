// リクエストの画面（/requests/*）。依頼者に見せるのは 種類・入力した値・状態・質問・自分の返信だけで、
// triage_note / agent_note / 提案の中身は出さない（docs/agent-pipeline.md §2）。

import type { Child } from 'hono/jsx'
import {
  type AdminRequest,
  type AdminRequestRow,
  type AdminRequestTab,
  adminRequestTabs,
  type OwnRequest,
} from '../db/requests'
import type { Form } from '../lib/form'
import { isoToJstDate } from '../lib/time'
import { canTransition } from '../requests/transitions'
import { memberRequestKinds, type OwnerTarget, titleLabel } from '../requests/validate'
import { Saved } from './admin'
import {
  Empty,
  Field,
  FormErrors,
  Pager,
  Select,
  StubDate,
  Tabs,
  Ticket,
  TopBar,
} from './components'
import { ownerRequestStatusLabels, requestKindLabels, requestStatusLabels } from './labels'

const KvRow = ({ label, children }: { label: string; children?: Child }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
)

// 一覧の主文。名前 → URL → 種類の順で最初にあるもの
const headline = (r: Pick<OwnRequest, 'kind' | 'payload'>): string =>
  r.payload.title ?? r.payload.url ?? requestKindLabels[r.kind]

const createdOn = (iso: string): string | null => isoToJstDate(iso)

// 依頼者が入力した値（.kv の行）。依頼者用とオーナー用で同じ
const PayloadRows = ({
  r,
  target,
}: {
  r: Pick<OwnRequest, 'kind' | 'payload'>
  target: { id: string; title: string } | null
}) => {
  const p = r.payload
  return (
    <>
      {target ? (
        <KvRow label="直す作品">
          <a href={`/works/${target.id}`}>{target.title}</a>
        </KvRow>
      ) : null}
      {p.url ? (
        <KvRow label="URL">
          <a href={p.url} rel="noopener noreferrer" style="overflow-wrap:anywhere">
            {p.url}
          </a>
        </KvRow>
      ) : null}
      {p.title ? <KvRow label={titleLabel(r.kind)}>{p.title}</KvRow> : null}
      {p.organization ? <KvRow label="団体">{p.organization}</KvRow> : null}
      {p.note ? (
        <KvRow label="メモ">
          <span style="white-space:pre-wrap">{p.note}</span>
        </KvRow>
      ) : null}
    </>
  )
}

// 自分のリクエスト一覧（左ページ）
export const RequestsList = (props: { items: OwnRequest[]; page: number; hasNext: boolean }) => (
  <>
    <TopBar
      title="リクエスト"
      action={
        <a class="btn pri" href="/requests/new">
          リクエストする
        </a>
      }
    />
    <div class="list">
      {props.items.length ? (
        props.items.map((r) => (
          <Ticket
            href={`/requests/${r.id}`}
            stub={<StubDate date={createdOn(r.createdAt)} />}
            meta={requestKindLabels[r.kind]}
            title={headline(r)}
            // needs_info も普通の chip（赤ペン・蛍光ペンは使わない）
            chip={<span class="chip">{requestStatusLabels[r.status]}</span>}
          />
        ))
      ) : (
        <Empty>まだリクエストはありません。</Empty>
      )}
    </div>
    <Pager base="/requests" page={props.page} hasNext={props.hasNext} />
  </>
)

// 投稿フォーム（右ページ）。target は fix_work の対象作品（見つかったときだけ）
export const NewRequestForm = (props: {
  values: Form
  target: { id: string; title: string } | null
  errors?: readonly string[]
}) => {
  const { values, target } = props
  return (
    <>
      <TopBar back="/requests" label="リクエストする" />
      <div class="sect" style="margin-top:4px">
        {values.kind === 'fix_work' && target ? (
          <dl class="kv">
            <KvRow label="直す作品">
              <a href={`/works/${target.id}`}>{target.title}</a>
            </KvRow>
          </dl>
        ) : null}
        <form method="post" action="/requests" class="list">
          <FormErrors errors={props.errors ?? []} />
          <Select
            label="種類"
            name="kind"
            options={memberRequestKinds.map((k) => ({ value: k, label: requestKindLabels[k] }))}
            value={values.kind}
            required
          />
          <Field label="URL" name="url" type="url" value={values.url} inputmode="url" />
          <Field label={titleLabel(values.kind)} name="title" value={values.title} />
          <Field label="団体" name="organization" value={values.organization} />
          <Field label="メモ" name="note" value={values.note} multiline />
          {values.target ? <input type="hidden" name="target" value={values.target} /> : null}
          <button type="submit" class="btn pri">
            送る
          </button>
        </form>
        <p class="note">escape.id や公式サイトの公演ページの URL があると早く登録できます。</p>
        <p class="note">X（旧 Twitter）の投稿からは情報を取りません。</p>
      </div>
    </>
  )
}

// 詳細（右ページ）。target は fix_work の対象作品の題名（消えていれば null）
export const RequestDetail = (props: {
  r: OwnRequest
  target: { id: string; title: string } | null
  created?: boolean
  replyValue?: string
  errors?: readonly string[]
}) => {
  const { r, target } = props
  const asking = r.status === 'needs_info'
  return (
    <>
      <TopBar back="/requests" label="リクエスト" />
      {props.created ? (
        <p class="note" role="status">
          <span class="hl draw saved">送りました</span>
        </p>
      ) : null}
      <div class="card">
        <span class="title" style="font-size:22px">
          {requestStatusLabels[r.status]}
        </span>
      </div>
      <div class="sect">
        <dl class="kv">
          <KvRow label="種類">{requestKindLabels[r.kind]}</KvRow>
          <PayloadRows r={r} target={target} />
          <KvRow label="送った日">{createdOn(r.createdAt) ?? ''}</KvRow>
        </dl>
      </div>
      {/* needs_info 以外への返信の 400 はここに出す（フォームが無いので） */}
      {asking ? null : <FormErrors errors={props.errors ?? []} />}
      {r.question || asking ? (
        <div class="sect">
          <h2>質問</h2>
          {r.question ? <p style="margin:0;white-space:pre-wrap">{r.question}</p> : null}
          {asking ? (
            <form method="post" action={`/requests/${r.id}/reply`} class="list">
              <FormErrors errors={props.errors ?? []} />
              <Field label="返信" name="reply" value={props.replyValue} multiline required />
              <button type="submit" class="btn pri">
                返信する
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {r.reply ? (
        <div class="sect">
          <h2>あなたの返信</h2>
          <p style="margin:0;white-space:pre-wrap">{r.reply}</p>
        </div>
      ) : null}
    </>
  )
}

// 作品検索で 0 件のときの入口（作品一覧・記録の追加）。検索語を作品名の初期値にする
export const RequestNewWorkLink = ({ q }: { q: string }) => (
  <p style="margin:0;text-align:center">
    <a href={`/requests/new?kind=new_work&title=${encodeURIComponent(q.trim())}`}>
      見つからないときは追加をリクエスト ›
    </a>
  </p>
)

// ---- オーナー用（/admin/requests*）

const adminTabLabels: Record<AdminRequestTab, string> = {
  open: '未選別',
  triaged: '選別済み',
  processing: '調べています',
  needs_info: '質問中',
  proposed: '提案あり',
  closed: '完了・見送り',
}

const adminTabHref = (tab: AdminRequestTab) =>
  tab === 'open' ? '/admin/requests' : `/admin/requests?status=${tab}`

// openCount は未選別の件数（タブに出す）
export const AdminRequestsList = (props: {
  tab: AdminRequestTab
  openCount: number
  items: AdminRequestRow[]
  page: number
  hasNext: boolean
}) => (
  <>
    <TopBar back="/settings" label="リクエスト" />
    <Tabs
      items={adminRequestTabs.map((t) => ({
        key: t,
        label: t === 'open' ? `${adminTabLabels[t]} ${props.openCount}` : adminTabLabels[t],
        href: adminTabHref(t),
      }))}
      current={props.tab}
      label="リクエストの状態"
    />
    <div class="list">
      {props.items.length ? (
        props.items.map((r) => (
          <Ticket
            href={`/admin/requests/${r.id}`}
            stub={<StubDate date={createdOn(r.createdAt)} />}
            meta={`${requestKindLabels[r.kind]} · ${r.requesterName}`}
            title={headline(r)}
            chip={<span class="chip">{ownerRequestStatusLabels[r.status]}</span>}
          />
        ))
      ) : (
        <Empty>この状態のリクエストはありません。</Empty>
      )}
    </div>
    <Pager
      base="/admin/requests"
      page={props.page}
      hasNext={props.hasNext}
      params={{ status: props.tab === 'open' ? '' : props.tab }}
    />
  </>
)

const StatusForm = (props: {
  id: string
  to: OwnerTarget
  label: string
  danger?: boolean
  children?: Child
}) => (
  <form method="post" action={`/admin/requests/${props.id}/status`} class="list">
    <input type="hidden" name="to" value={props.to} />
    {props.children}
    <button type="submit" class={props.danger ? 'btn danger' : 'btn'}>
      {props.label}
    </button>
  </form>
)

// 詳細と選別フォーム。出すフォームは canTransition で決める（values / errors は 400 の再描画で送信値を戻す）
export const AdminRequestDetail = (props: {
  r: AdminRequest
  target: { id: string; title: string } | null
  saved?: boolean
  values?: Form
  errors?: readonly string[]
}) => {
  const { r, target } = props
  const v = props.values ?? {}
  const can = (to: OwnerTarget) => canTransition(r.status, to, 'owner')
  const multi = (text: string) => <span style="white-space:pre-wrap">{text}</span>
  return (
    <>
      <TopBar back="/admin/requests" label="リクエスト" />
      {props.saved ? <Saved /> : null}
      <div class="card">
        <span class="title" style="font-size:22px">
          {headline(r)}
        </span>
        <span class="row" style="justify-content:flex-start">
          <span class="chip">{ownerRequestStatusLabels[r.status]}</span>
        </span>
      </div>
      <div class="sect">
        <dl class="kv">
          <KvRow label="種類">{requestKindLabels[r.kind]}</KvRow>
          <KvRow label="依頼者">{r.requesterName}</KvRow>
          <PayloadRows r={r} target={target} />
          <KvRow label="作成日">{createdOn(r.createdAt) ?? ''}</KvRow>
          <KvRow label="更新日">{createdOn(r.updatedAt) ?? ''}</KvRow>
          {r.question ? <KvRow label="質問">{multi(r.question)}</KvRow> : null}
          {r.reply ? <KvRow label="返信">{multi(r.reply)}</KvRow> : null}
          {r.triageNote ? <KvRow label="選別メモ">{multi(r.triageNote)}</KvRow> : null}
          {r.agentNote ? <KvRow label="agent メモ">{multi(r.agentNote)}</KvRow> : null}
        </dl>
      </div>
      {props.errors?.length ? (
        <div class="sect">
          <FormErrors errors={props.errors} />
        </div>
      ) : null}
      {r.status === 'open' ? (
        <div class="sect">
          <h2>選別</h2>
          <StatusForm id={r.id} to="triaged" label="選別済みにする">
            <Field
              label="メモ（任意）"
              name="note"
              value={v.to === 'triaged' ? v.note : ''}
              multiline
            />
          </StatusForm>
        </div>
      ) : null}
      {r.status === 'processing' && can('triaged') ? (
        <div class="sect">
          <StatusForm id={r.id} to="triaged" label="選別済みに戻す" />
        </div>
      ) : null}
      {can('needs_info') ? (
        <div class="sect">
          <h2>質問する</h2>
          <StatusForm id={r.id} to="needs_info" label="質問する">
            <Field
              label="質問（依頼者に見えます）"
              name="question"
              value={v.to === 'needs_info' ? v.question : ''}
              multiline
            />
          </StatusForm>
        </div>
      ) : null}
      {can('done') ? (
        <div class="sect">
          <StatusForm id={r.id} to="done" label="完了にする" />
        </div>
      ) : null}
      {can('rejected') ? (
        <div class="sect">
          <h2>見送る</h2>
          <StatusForm id={r.id} to="rejected" label="見送る" danger>
            <Field
              label="理由（依頼者には見えません）"
              name="note"
              value={v.to === 'rejected' ? v.note : ''}
              multiline
            />
          </StatusForm>
        </div>
      ) : null}
      <div class="sect">
        <h2>提案</h2>
        <Empty>提案はまだありません。</Empty>
      </div>
    </>
  )
}
