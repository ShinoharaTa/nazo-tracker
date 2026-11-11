// リクエストの画面（/requests/*）。依頼者に見せるのは 種類・入力した値・状態・質問・自分の返信だけで、
// triage_note / agent_note / 提案の中身は出さない（docs/agent-pipeline.md §2）。

import type { Child } from 'hono/jsx'
import type { OwnRequest } from '../db/requests'
import type { Form } from '../lib/form'
import { isoToJstDate } from '../lib/time'
import { memberRequestKinds, titleLabel } from '../requests/validate'
import { Empty, Field, FormErrors, Pager, Select, StubDate, Ticket, TopBar } from './components'
import { requestKindLabels, requestStatusLabels } from './labels'

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
  const p = r.payload
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
        <span class="title xl">{requestStatusLabels[r.status]}</span>
      </div>
      <div class="sect">
        <dl class="kv">
          <KvRow label="種類">{requestKindLabels[r.kind]}</KvRow>
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
          <KvRow label="送った日">
            <span class="mono">{createdOn(r.createdAt) ?? ''}</span>
          </KvRow>
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
