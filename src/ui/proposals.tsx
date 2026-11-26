// 提案の一覧・詳細（/admin/proposals*）。差分は .diff（項目 / 前 / 後）、採否は項目ごとの Checkbox。
// 蛍光ペンは使わない（承認は作業の画面で、見出しは太さと大きさだけで 1 番目にする）。記録・人数の数字は出さない。

import type { Child } from 'hono/jsx'
import type {
  AdminProposalField,
  AdminProposalRow,
  AdminProposalTab,
  CandidateView,
  ProposalRow,
} from '../db/proposals'
import { workKinds } from '../db/schema'
import { isoToJstDate } from '../lib/time'
import type { ApprovalChoice, RejectionChoice, StaleField } from '../pipeline/apply'
import { nameColumn, type ProposalTable, placeholderOf, workOnlySections } from '../pipeline/fields'
import {
  Checkbox,
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
import {
  matchReasonLabel,
  proposalFieldLabel,
  proposalFieldOrder,
  proposalKindLabels,
  proposalStatusLabels,
  proposalTableLabel,
  type RunChannel,
  runChannelLabels,
  type ShopKind,
  shopKindLabels,
  statusesFor,
  statusLabel,
  type WorkKind,
  workKindLabels,
} from './labels'

// id を持つ列 → 名前を引く表
export const refTables: Record<string, ProposalTable> = {
  'work.primary_organization_id': 'organization',
  'run.organization_id': 'organization',
  'venue.organization_id': 'organization',
  'shop.organization_id': 'organization',
  'run.venue_id': 'venue',
  'run.shop_id': 'shop',
  'run.work_id': 'work',
  'work.merged_into_id': 'work',
  'organization.merged_into_id': 'organization',
  'venue.merged_into_id': 'venue',
}

// 表ごとの id → 名前（run は作品の題名）
export type RefNames = Record<ProposalTable, Map<string, string>>

const NOT_FOUND = '（見つかりません）'

const confidenceText = (n: number | null): string => (n === null ? '—' : n.toFixed(2))

const kindLabelOf = (p: Pick<AdminProposalRow, 'kind' | 'targetTable'>) =>
  `${proposalKindLabels[p.kind]} · ${proposalTableLabel(p.targetTable)}`

// 項目の値の表示。参照の id は名前、列挙はラベル、@<表> は「この提案で作る〇〇」
const valueText = (field: string, v: string | null, names: RefNames): string => {
  if (v === null) return ''
  const ref = placeholderOf({ field, newValue: v })
  if (ref) return `（この提案で作る${proposalTableLabel(ref)}）`
  const t = refTables[field]
  if (t) return names[t].get(v) ?? `${NOT_FOUND} ${v}`
  if (field === 'work.kind') return workKindLabels[v as WorkKind] ?? v
  if (field === 'run.channel') return runChannelLabels[v as RunChannel] ?? v
  if (field === 'shop.kind') return shopKindLabels[v as ShopKind] ?? v
  if (field === 'run.is_permanent') return v === '1' ? '常設' : v
  return v
}

// 詳細の見出し。create は作る行の名前（回は作品の題名）、それ以外は対象の今の名前
export const headlineOf = (p: ProposalRow, fields: AdminProposalField[], names: RefNames) => {
  const t = p.targetTable as ProposalTable
  if (p.kind !== 'create') return (p.targetId && names[t]?.get(p.targetId)) || NOT_FOUND
  const col = nameColumn[t]
  if (col) return fields.find((f) => f.field === `${t}.${col}`)?.newValue ?? NOT_FOUND
  const workId = fields.find((f) => f.field === 'run.work_id')?.newValue
  return (workId && names.work.get(workId)) || NOT_FOUND
}

// ---- 一覧

const tabLabels: Record<AdminProposalTab, string> = {
  pending: '承認待ち',
  auto: '自動反映',
  done: '済み',
}

const emptyText: Record<AdminProposalTab, string> = {
  pending: '承認待ちの提案はありません。',
  auto: '自動反映した提案はありません。',
  done: '処理済みの提案はありません。',
}

const tabHref = (tab: AdminProposalTab) =>
  tab === 'pending' ? '/admin/proposals' : `/admin/proposals?tab=${tab}`

// 一覧の 1 行。meta = 種類 · 対象 · 出典ドメイン · 確信度の最小
export const ProposalTicket = ({ r, chip }: { r: AdminProposalRow; chip?: boolean }) => (
  <Ticket
    href={`/admin/proposals/${r.id}`}
    stub={<StubDate date={isoToJstDate(r.createdAt)} />}
    meta={
      <>
        {[kindLabelOf(r), ...r.domains].join(' · ')} ·{' '}
        <span class="mono">{confidenceText(r.confidence)}</span>
      </>
    }
    title={r.headline}
    chip={chip ? <span class="chip">{proposalStatusLabels[r.status]}</span> : undefined}
  />
)

export const ProposalsList = (props: {
  tab: AdminProposalTab
  pendingCount: number
  items: AdminProposalRow[]
  page: number
  hasNext: boolean
}) => (
  <>
    <TopBar back="/settings" label="提案" />
    <Tabs
      items={(['pending', 'auto', 'done'] as const).map((t) => ({
        key: t,
        label: t === 'pending' ? `${tabLabels[t]} ${props.pendingCount}` : tabLabels[t],
        href: tabHref(t),
      }))}
      current={props.tab}
      label="提案の状態"
    />
    <div class="list">
      {props.items.length ? (
        props.items.map((r) => <ProposalTicket r={r} chip={props.tab !== 'pending'} />)
      ) : (
        <Empty>{emptyText[props.tab]}</Empty>
      )}
    </div>
    <Pager
      base="/admin/proposals"
      page={props.page}
      hasNext={props.hasNext}
      params={{ tab: props.tab === 'pending' ? '' : props.tab }}
    />
  </>
)

// ---- 詳細

const sectionOrder: readonly ProposalTable[] = ['organization', 'venue', 'shop', 'work', 'run']

const orderOf = (field: string) => {
  const n = proposalFieldOrder.indexOf(field)
  return n === -1 ? proposalFieldOrder.length : n
}

const SourceLine = ({ f }: { f: AdminProposalField }) => (
  <>
    <span class="meta full">
      {f.source
        ? [f.source.domain ?? '出典', f.source.fetchedAt ? isoToJstDate(f.source.fetchedAt) : null]
            .filter(Boolean)
            .join(' · ')
        : '出典なし'}{' '}
      · <span class="mono">{confidenceText(f.confidence)}</span>
    </span>
    {f.source ? (
      <details class="full">
        <summary class="meta">出典を見る</summary>
        {f.source.excerpt ? (
          <p class="note" style="margin:4px 0;white-space:pre-wrap">
            {f.source.excerpt}
          </p>
        ) : null}
        <a href={f.source.url} rel="noopener noreferrer" style="overflow-wrap:anywhere">
          {f.source.url}
        </a>
      </details>
    ) : null}
  </>
)

// 節の差分。editable なら採用の Checkbox（work.kind は下の Select で選ぶので付けない）
const DiffSection = (props: {
  table: ProposalTable
  fields: AdminProposalField[]
  names: RefNames
  editable: boolean
  kindBySelect: boolean
  checked: (f: AdminProposalField) => boolean
  // 回から参照されていない会場・販売先など（create の束で、対象の表でない節）
  unused: boolean
  // 作品からしか参照されていない節で、既存の作品に紐付けられるとき（紐付けると作らない）
  workOnly: boolean
}) => (
  <div class="sect">
    <h2>{proposalTableLabel(props.table)}</h2>
    {props.unused ? (
      <p class="note">
        この{proposalTableLabel(props.table)}
        はほかの項目から参照されていません。採用すると単独で作ります（いらなければ項目を全部外してください）。
      </p>
    ) : null}
    {props.workOnly ? (
      <p class="note">
        この{proposalTableLabel(props.table)}
        は作品からしか参照されていないので、既存の作品に紐付けるときは作りません。
      </p>
    ) : null}
    <div class="diff">
      <span class="meta">項目</span>
      <span class="meta">前</span>
      <span class="meta">後</span>
      {props.fields.map((f) => {
        const label = proposalFieldLabel(f.field)
        const off = !props.editable && f.accepted === 0 ? ' off' : ''
        const byKind = props.kindBySelect && f.field === 'work.kind'
        return (
          <>
            <span class={off.trim() || undefined}>
              {props.editable && !byKind ? (
                <label>
                  <input
                    type="checkbox"
                    name={`accept_${f.id}`}
                    value="1"
                    checked={props.checked(f)}
                  />
                  {label}
                </label>
              ) : (
                label
              )}
            </span>
            <span class={`o${off}`}>{valueText(f.field, f.oldValue, props.names)}</span>
            <span class={`n${off}`}>{valueText(f.field, f.newValue, props.names)}</span>
            <SourceLine f={f} />
          </>
        )
      })}
    </div>
  </div>
)

const reasonText = (reasons: string[]) =>
  reasons.map((r) => matchReasonLabel(r.replace(/^worker:/, ''))).join('・')

const candidateHref = (c: CandidateView) =>
  c.table === 'work'
    ? `/admin/works/${c.id}`
    : c.table === 'organization'
      ? `/admin/orgs/${c.id}`
      : `/admin/venues/${c.id}`

const CandidateMeta = ({ c }: { c: CandidateView }) => (
  <span class="meta">
    {[proposalTableLabel(c.table), c.orgName, reasonText(c.reasons)].filter(Boolean).join(' · ')} ·{' '}
    <span class="mono">{c.score.toFixed(2)}</span> · <a href={candidateHref(c)}>開く</a>
  </span>
)

// 名寄せ候補。radio なら「新しく作る / この作品に紐付ける」（create work の承認待ち）
const Candidates = (props: { candidates: CandidateView[]; radio: boolean; linkWorkId: string }) => (
  <div class="sect">
    <h2>候補</h2>
    <div class="list">
      {props.radio ? (
        <div class="cand">
          <label>
            <input type="radio" name="link_work_id" value="" checked={props.linkWorkId === ''} />
            新しく作る
          </label>
        </div>
      ) : null}
      {props.candidates.map((c) => (
        <div class="cand">
          {props.radio && c.table === 'work' ? (
            <label>
              <input
                type="radio"
                name="link_work_id"
                value={c.id}
                checked={props.linkWorkId === c.id}
              />
              この作品に紐付ける: {c.name}
            </label>
          ) : (
            <span class="title">{c.name}</span>
          )}
          <CandidateMeta c={c} />
        </div>
      ))}
    </div>
    {props.radio ? (
      <p class="note">紐付けると作品は作らず、回だけをその作品に作ります。形式も使いません。</p>
    ) : null}
  </div>
)

const visitStatusText = statusesFor('room')
  .map((s) => statusLabel(s, 'room'))
  .join('・')

const PendingList = ({ label, ids }: { label: string; ids: string[] }) =>
  ids.length ? (
    <div class="list" role="note">
      <p class="note" style="margin:0">
        {label}
      </p>
      <p class="note" style="margin:0">
        {ids.map((id, n) => (
          <>
            {n ? '、' : ''}
            <a href={`/admin/proposals/${id}`}>提案 {n + 1}</a>
          </>
        ))}
      </p>
    </div>
  ) : null

const Kv = ({ label, children }: { label: string; children?: Child }) => (
  <>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </>
)

export type ProposalDetailProps = {
  p: ProposalRow
  fields: AdminProposalField[]
  names: RefNames
  candidates: CandidateView[]
  sameTarget: string[]
  sameEscapeUrl: string[]
  kindSelectable: boolean
  linkable: boolean
  // update の対象の今の形式（形式の Select の既定。create は提案の値）
  currentKind?: string | null
  applied?: boolean
  nextId?: string | null
  // 承認フォームの再描画（400 / 409）
  choice?: ApprovalChoice
  errors?: string[]
  stale?: StaleField[]
  // 却下フォームの再描画（400）
  rejection?: RejectionChoice
  rejectErrors?: string[]
}

export const ProposalDetail = (props: ProposalDetailProps) => {
  const { p, fields, names } = props
  const pending = p.status === 'pending'
  const choice = props.choice
  const kindField = fields.find((f) => f.field === 'work.kind')
  const kindValue = choice
    ? choice.kind
    : p.kind === 'update'
      ? (props.currentKind ?? '')
      : (kindField?.newValue ?? '')
  // 提案の値は選択肢に「提案: 〇〇」と出す
  const proposedKind = kindField ? (kindField.newValue ?? '') : null
  const kindOptionLabel = (k: string, label: string) =>
    proposedKind === k ? `提案: ${label}` : label
  const radio = pending && props.linkable && props.candidates.some((c) => c.table === 'work')
  const workOnly = radio ? workOnlySections(fields) : new Set<ProposalTable>()
  const checked = (f: AdminProposalField) => (choice ? choice.accepted.has(f.id) : true)
  // 束の中で参照されていない節（create で、対象の表でないもの）
  const referenced = new Set(
    fields.flatMap((f) => {
      const ref = placeholderOf(f)
      return ref ? [ref] : []
    }),
  )
  const sections = sectionOrder
    .map((t) => ({
      table: t,
      fields: fields
        .filter((f) => f.table === t)
        .sort((a, b) => orderOf(a.field) - orderOf(b.field)),
    }))
    .filter((s) => s.fields.length)
  const minConfidence = props.p.confidence

  const body = (
    <>
      {sections.map((s) => (
        <DiffSection
          table={s.table}
          fields={s.fields}
          names={names}
          editable={pending}
          kindBySelect={props.kindSelectable}
          checked={checked}
          unused={
            p.kind === 'create' &&
            s.table !== p.targetTable &&
            s.table !== 'work' &&
            s.table !== 'run' &&
            !referenced.has(s.table)
          }
          workOnly={workOnly.has(s.table)}
        />
      ))}
      {props.candidates.length ? (
        <Candidates
          candidates={props.candidates}
          radio={radio}
          linkWorkId={choice?.linkWorkId ?? ''}
        />
      ) : null}
    </>
  )

  return (
    <>
      <TopBar back="/admin/proposals" label="提案" />
      {props.applied ? (
        <div class="list">
          <p class="note" role="status">
            反映しました
          </p>
          {props.nextId ? (
            <p class="note" style="margin:0">
              <a href={`/admin/proposals/${props.nextId}`}>次の提案 ›</a>
            </p>
          ) : null}
        </div>
      ) : null}
      <div class="card">
        <span class="title xl">{headlineOf(p, fields, names)}</span>
        <span class="row" style="justify-content:flex-start;gap:8px">
          <span class="chip">{proposalStatusLabels[p.status]}</span>
          <span class="meta">
            {kindLabelOf(p)} · 確信度 <span class="mono">{confidenceText(minConfidence)}</span>
          </span>
        </span>
      </div>
      <div class="sect">
        <dl class="kv">
          <Kv label="提案日">
            <span class="mono">{isoToJstDate(p.createdAt) ?? ''}</span>
          </Kv>
          {p.requestId ? (
            <Kv label="依頼元">
              <a href={`/admin/requests/${p.requestId}`}>リクエストを見る</a>
            </Kv>
          ) : null}
          {p.reviewedAt ? (
            <Kv label="処理日">
              <span class="mono">{isoToJstDate(p.reviewedAt) ?? ''}</span>
            </Kv>
          ) : null}
          {p.reviewNote ? (
            <Kv label={p.status === 'rejected' ? '却下の理由' : 'メモ'}>
              <span style="white-space:pre-wrap">{p.reviewNote}</span>
            </Kv>
          ) : null}
        </dl>
      </div>
      {pending ? (
        <>
          <PendingList
            label="同じ対象の承認待ちの提案がほかにもあります。先に承認した方の値が、もう片方の「前」と食い違います。"
            ids={props.sameTarget}
          />
          <PendingList
            label="同じ escape.id の URL で回を作る承認待ちの提案がほかにもあります。承認できるのはどれか 1 件です。"
            ids={props.sameEscapeUrl}
          />
          <form method="post" action={`/admin/proposals/${p.id}/approve`} class="list">
            {props.errors?.length ? (
              <div class="sect">
                <FormErrors errors={props.errors} />
              </div>
            ) : null}
            {props.stale?.length ? (
              <div class="sect">
                <h2>今の値</h2>
                <dl class="kv">
                  {props.stale.map((s) => (
                    <Kv label={proposalFieldLabel(s.field)}>
                      {valueText(s.field, s.current, names)}
                    </Kv>
                  ))}
                </dl>
                <input type="hidden" name="force" value="1" />
              </div>
            ) : null}
            {body}
            {props.kindSelectable ? (
              <div class="sect">
                <Select
                  label="形式"
                  name="kind"
                  options={workKinds.map((k) => ({
                    value: k,
                    label: kindOptionLabel(k, workKindLabels[k]),
                  }))}
                  value={kindValue}
                  blank={kindOptionLabel('', '（未設定）')}
                />
                <p class="note">
                  ルーム・公演にすると、記録で選べるステータスは {visitStatusText}{' '}
                  になります。今ある記録のステータスは書き換えません。
                </p>
              </div>
            ) : null}
            <div class="sect">
              <Field label="メモ（任意）" name="note" value={choice?.note} multiline />
              <button type="submit" class="btn pri">
                {props.stale?.length ? 'それでも反映する' : '承認して反映'}
              </button>
            </div>
          </form>
          <div class="sect">
            <h2>却下</h2>
            <form method="post" action={`/admin/proposals/${p.id}/reject`} class="list">
              <FormErrors errors={props.rejectErrors ?? []} />
              <Field label="理由" name="reason" value={props.rejection?.reason} multiline />
              <Checkbox
                label="同じ内容の再提案を止める"
                name="remember"
                checked={props.rejection ? props.rejection.remember : true}
              />
              <button type="submit" class="btn danger">
                却下
              </button>
            </form>
          </div>
        </>
      ) : (
        <>
          {props.errors?.length ? (
            <div class="sect">
              <FormErrors errors={props.errors} />
            </div>
          ) : null}
          {body}
        </>
      )}
    </>
  )
}
