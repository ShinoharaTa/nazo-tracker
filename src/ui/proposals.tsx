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
import { imageUrl } from '../lib/image-url'
import { norm } from '../lib/norm'
import { isoToJstDate } from '../lib/time'
import {
  type ApprovalChoice,
  BULK_MAX,
  type RejectionChoice,
  type StaleField,
} from '../pipeline/apply'
import { nameColumn, type ProposalTable, placeholderOf, workOnlySections } from '../pipeline/fields'
import {
  Checkbox,
  Empty,
  Field,
  FormErrors,
  Pager,
  Select,
  StubDate,
  Switch,
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

// 取り消しの期限（JST の M/D HH:mm）
export const revertUntilText = (iso: string | null): string => {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(t)) return ''
  const j = new Date(t + 9 * 3_600_000).toISOString()
  return `${Number(j.slice(5, 7))}/${Number(j.slice(8, 10))} ${j.slice(11, 16)}`
}

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

// 画像の項目（work.image_url / organization.logo_url）のプレビュー。許可ホストの検証を通った URL だけ <img> にする
const imageFields: readonly string[] = ['work.image_url', 'organization.logo_url']
const ImagePreview = ({ field, v }: { field: string; v: string | null }) => {
  if (v === null || !imageFields.includes(field)) return null
  const u = imageUrl()(v)
  if (!u.ok) return null
  return (
    <img
      src={u.value}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      style="display:block;width:auto;height:auto;max-width:160px;max-height:160px;object-fit:contain;margin-top:4px"
    />
  )
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

// 一覧の 1 行。meta = 種類 · 対象 · 出典ドメイン · 確信度の最小（自動反映タブは取り消しの期限も）
export const ProposalTicket = ({
  r,
  chip,
  revertUntil,
}: {
  r: AdminProposalRow
  chip?: boolean
  revertUntil?: boolean
}) => (
  <Ticket
    href={`/admin/proposals/${r.id}`}
    stub={<StubDate date={isoToJstDate(r.createdAt)} />}
    meta={
      <>
        {[kindLabelOf(r), ...r.domains].join(' · ')} ·{' '}
        <span class="mono">{confidenceText(r.confidence)}</span>
        {revertUntil && r.revertUntil ? (
          <>
            {' '}
            · <span class="mono">取り消せるのは {revertUntilText(r.revertUntil)} まで</span>
          </>
        ) : null}
      </>
    }
    title={r.headline}
    chip={chip ? <span class="chip">{proposalStatusLabels[r.status]}</span> : undefined}
  />
)

// 自動反映の ON / OFF（既定 OFF）。Switch は on のときだけ auto_apply=on が届く
const AutoApplyForm = ({ on, saved }: { on: boolean; saved?: boolean }) => (
  <form method="post" action="/admin/proposals/settings" class="sect list">
    {saved ? (
      <p class="note" role="status">
        保存しました
      </p>
    ) : null}
    <Switch label="escape.id 由来の新しい作品・回を自動で反映する" name="auto_apply" checked={on} />
    <p class="note">
      自動で反映した作品・回は 7 日間取り消せます。新しい団体・会場を含む提案は承認待ちになります。
    </p>
    <button type="submit" class="btn">
      保存
    </button>
  </form>
)

// ---- まとめて承認（create で候補 0 件の承認待ちだけ。src/routes/admin/proposals.tsx の /proposals/bulk）

// 承認待ちタブの一覧。選べる行の左に Checkbox（選べない行は同じ幅を空ける）。確認ページへは GET
const BulkPickForm = ({ items }: { items: AdminProposalRow[] }) => (
  <form method="get" action="/admin/proposals/bulk" class="list">
    <p class="note" style="margin:0">
      候補の無い新しい提案は、チェックしてまとめて承認できます（1 回 {BULK_MAX}{' '}
      件まで）。候補つき・更新・紐付け・統合は 1 件ずつ開いて確かめてください。
    </p>
    <label hidden data-check-all={String(BULK_MAX)}>
      <input type="checkbox" /> 選べる提案をすべて選ぶ（先頭 {BULK_MAX} 件）
    </label>
    {items.map((r) => (
      <div class="pick">
        {r.bulkable ? (
          <label class="pick-box">
            <input
              type="checkbox"
              name="id"
              value={r.id}
              aria-label={`まとめて承認: ${r.headline}`}
            />
          </label>
        ) : (
          <span class="pick-box" aria-hidden="true" />
        )}
        <ProposalTicket r={r} />
      </div>
    ))}
    <button type="submit" class="btn pri">
      選んだ提案をまとめて承認
    </button>
  </form>
)

export type BulkItem = {
  id: string
  headline: string
  // 種類 · 対象 · 団体（見つからない提案は id）
  meta: string
  // 提案が見つかったか（見つからない行は詳細へのリンクを出さない）
  found: boolean
  // 束が新しく作る団体の名前（organization.name）。無ければ null
  newOrg: string | null
}

export type BulkResult = BulkItem & {
  // applied = 承認した、failed = できなかった（errors に理由）、unprocessed = 上限で打ち切って pending のまま
  result: 'applied' | 'failed' | 'unprocessed'
  errors: string[]
}

// 一覧の 1 行の題名と meta（種類 · 対象 · 団体）。団体は束で新しく作るもの（@organization）と既存の参照先を分けて出す
export const bulkItemOf = (
  p: ProposalRow,
  fields: AdminProposalField[],
  names: RefNames,
): BulkItem => {
  const t = p.targetTable
  const orgField = fields.find(
    (f) => f.field === `${t}.primary_organization_id` || f.field === `${t}.organization_id`,
  )
  const newOrg =
    p.kind === 'create'
      ? (fields.find((f) => f.field === 'organization.name')?.newValue ?? null)
      : null
  const org = !orgField?.newValue
    ? t === 'work'
      ? '団体未設定'
      : null
    : placeholderOf(orgField)
      ? `団体（新しく作る）: ${newOrg ?? NOT_FOUND}`
      : `団体: ${names.organization.get(orgField.newValue) ?? NOT_FOUND}`
  return {
    id: p.id,
    headline: headlineOf(p, fields, names),
    meta: [kindLabelOf(p), org].filter(Boolean).join(' · '),
    found: true,
    newOrg,
  }
}

// 見つからない id の行（id は送られたまま出す。JSX がエスケープする）
export const bulkMissingItemOf = (id: string): BulkItem => ({
  id,
  headline: NOT_FOUND,
  meta: `id: ${id}`,
  found: false,
  newOrg: null,
})

// 新しく作る団体の名前（norm で比べる）が 2 件以上の提案で重なるか
const dupNewOrg = (items: readonly BulkItem[]): boolean => {
  const seen = new Set<string>()
  for (const i of items) {
    if (!i.newOrg) continue
    const k = norm(i.newOrg)
    if (seen.has(k)) return true
    seen.add(k)
  }
  return false
}

const BulkRow = ({ item, children }: { item: BulkItem; children?: Child }) => (
  <div class="cand">
    <span class="title">{item.headline}</span>
    <span class="meta">
      {item.meta}
      {item.found ? (
        <>
          {' · '}
          <a href={`/admin/proposals/${encodeURIComponent(item.id)}`}>開く</a>
        </>
      ) : null}
    </span>
    {children}
  </div>
)

// 確認ページ。items は反映する提案、skipped はまとめて承認できない提案（理由つき）
export const BulkConfirm = (props: {
  items: BulkItem[]
  skipped: BulkResult[]
  errors?: string[]
  // BULK_MAX を超えて選ばれたときの注記
  over?: string
}) => (
  <>
    <TopBar back="/admin/proposals" label="まとめて承認" />
    {props.errors?.length ? (
      <div class="sect">
        <FormErrors errors={props.errors} />
      </div>
    ) : null}
    {dupNewOrg(props.items) ? (
      <p class="note" role="alert">
        同じ名前の団体を新しく作る提案が複数あります。まとめて承認すると同名の団体が複数できます。先に団体だけを承認してください。
      </p>
    ) : null}
    {props.over ? (
      <p class="note" role="status">
        {props.over}
      </p>
    ) : null}
    {props.items.length ? (
      <form method="post" action="/admin/proposals/bulk" class="sect">
        <h2>反映する提案（{props.items.length} 件）</h2>
        <p class="note">
          全項目を採用して、1 件ずつ反映します。形式などを選び直すときは、詳細から 1
          件ずつ承認してください。
        </p>
        <p class="note">
          一度に処理できる数には上限があります。処理しきれなかった分は、結果の画面から続けて承認できます。
        </p>
        <div class="list">
          {props.items.map((i) => (
            <BulkRow item={i}>
              <input type="hidden" name="id" value={i.id} />
            </BulkRow>
          ))}
        </div>
        <button type="submit" class="btn pri">
          {props.items.length} 件を承認して反映
        </button>
      </form>
    ) : null}
    {props.skipped.length ? (
      <div class="sect">
        <h2>まとめて承認できない提案（{props.skipped.length} 件）</h2>
        <div class="list">
          {props.skipped.map((i) => (
            <BulkRow item={i}>
              <p class="note" style="margin:0">
                {i.errors.join(' ')}
              </p>
            </BulkRow>
          ))}
        </div>
      </div>
    ) : null}
  </>
)

// 結果。件ごとに承認した / できなかった（理由）/ 未処理
export const BulkResults = ({ results, over }: { results: BulkResult[]; over?: string }) => {
  const n = (r: BulkResult['result']) => results.filter((x) => x.result === r).length
  const rest = n('unprocessed')
  return (
    <>
      <TopBar back="/admin/proposals" label="まとめて承認" />
      <div class="list">
        <p class="note" role="status">
          {`承認 ${n('applied')} 件 / 失敗 ${n('failed')} 件 / 未処理 ${rest} 件`}
        </p>
        {over ? (
          <p class="note" style="margin:0">
            {over}
          </p>
        ) : null}
        {results.map((r) => (
          <BulkRow item={r}>
            {r.result === 'applied' ? (
              <p class="note" style="margin:0">
                反映しました
              </p>
            ) : r.result === 'unprocessed' ? (
              <p class="note" style="margin:0">
                未処理（承認待ちのままです）
              </p>
            ) : (
              <FormErrors errors={r.errors} />
            )}
          </BulkRow>
        ))}
        {rest ? (
          <p class="note" style="margin:0">
            <a href="/admin/proposals">続けて承認する ›</a>
          </p>
        ) : null}
      </div>
    </>
  )
}

export const ProposalsList = (props: {
  tab: AdminProposalTab
  pendingCount: number
  items: AdminProposalRow[]
  page: number
  hasNext: boolean
  autoApply: boolean
  saved?: boolean
}) => (
  <>
    <TopBar back="/settings" label="提案" />
    <AutoApplyForm on={props.autoApply} saved={props.saved} />
    <Tabs
      items={(['pending', 'auto', 'done'] as const).map((t) => ({
        key: t,
        label: t === 'pending' ? `${tabLabels[t]} ${props.pendingCount}` : tabLabels[t],
        href: tabHref(t),
      }))}
      current={props.tab}
      label="提案の状態"
    />
    {props.tab === 'pending' && props.items.some((r) => r.bulkable) ? (
      <BulkPickForm items={props.items} />
    ) : (
      <div class="list">
        {props.items.length ? (
          props.items.map((r) => (
            <ProposalTicket
              r={r}
              chip={props.tab !== 'pending'}
              revertUntil={props.tab === 'auto'}
            />
          ))
        ) : (
          <Empty>{emptyText[props.tab]}</Empty>
        )}
      </div>
    )}
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

// 出典は 1 行の summary（確信度 · host · 日付 · 出典）。開くと抜粋と URL。出典が無ければ「出典なし · 確信度」の 1 行
const SourceLine = ({ f, indent }: { f: AdminProposalField; indent: boolean }) => {
  const ind = indent ? ' ind' : ''
  const conf = <span class="mono">{confidenceText(f.confidence)}</span>
  return f.source ? (
    <details class={`full${ind}`}>
      <summary class="meta">
        {conf}
        {[f.source.domain, f.source.fetchedAt ? isoToJstDate(f.source.fetchedAt) : null]
          .filter(Boolean)
          .map((t) => ` · ${t}`)
          .join('')}{' '}
        · 出典
      </summary>
      {f.source.excerpt ? (
        <p class="note" style="margin:4px 0;white-space:pre-wrap">
          {f.source.excerpt}
        </p>
      ) : null}
      <a href={f.source.url} rel="noopener noreferrer" style="overflow-wrap:anywhere">
        {f.source.url}
      </a>
    </details>
  ) : (
    <span class={`meta full${ind}`}>出典なし · {conf}</span>
  )
}

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
}) => {
  // 「前」が全部空の節（新規の値ばかり）は「前」の列を出さず 2 列にする
  const isNew = props.fields.every((f) => f.oldValue === null || f.oldValue === '')
  return (
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
      <div class={isNew ? 'diff new' : 'diff'}>
        <span class="meta">項目</span>
        {isNew ? null : <span class="meta">前</span>}
        <span class="meta">後</span>
        {props.fields.map((f) => {
          const label = proposalFieldLabel(f.field)
          const off = !props.editable && f.accepted === 0 ? ' off' : ''
          const byKind = props.kindBySelect && f.field === 'work.kind'
          const box = props.editable && !byKind
          return (
            <div class="it">
              <span class={`k${off}`}>
                {box ? (
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
              {isNew ? null : (
                <span class={`o${off}`}>
                  {valueText(f.field, f.oldValue, props.names)}
                  <ImagePreview field={f.field} v={f.oldValue} />
                </span>
              )}
              <span class={`n${off}`}>
                {valueText(f.field, f.newValue, props.names)}
                <ImagePreview field={f.field} v={f.newValue} />
              </span>
              <SourceLine f={f} indent={box} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
  // 自動反映で、取り消せる期間内
  revertable?: boolean
  // follow-up のとき、元の提案の状態（reverted なら「元の作品は取り消されました」）
  parentStatus?: ProposalRow['status'] | null
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
          {p.followUpOfId ? (
            <Kv label="元の提案">
              <a href={`/admin/proposals/${p.followUpOfId}`}>自動反映した提案を見る</a>
              {props.parentStatus === 'reverted' ? (
                <span class="note" style="display:block">
                  元の作品は取り消されました。
                </span>
              ) : null}
            </Kv>
          ) : null}
          {p.reviewedAt ? (
            <Kv label="処理日">
              <span class="mono">{isoToJstDate(p.reviewedAt) ?? ''}</span>
            </Kv>
          ) : null}
          {p.revertedAt ? (
            <Kv label="取り消し日">
              <span class="mono">{isoToJstDate(p.revertedAt) ?? ''}</span>
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
          {props.revertable ? (
            <div class="sect">
              <p class="note">
                取り消すと、この提案で作った作品・回を削除します。取り消せるのは{' '}
                <span class="mono">{revertUntilText(p.revertUntil)}</span> までです。
              </p>
              <a class="btn danger" href={`/admin/proposals/${p.id}/revert`}>
                取り消す
              </a>
            </div>
          ) : null}
          {body}
        </>
      )}
    </>
  )
}

// 取り消しの確認（退会と同じ checkbox 形式）。error は 400 / 409 の文言、mergeHref は統合画面（取り消せないとき）
export const RevertConfirm = (props: {
  p: ProposalRow
  headline: string
  canRevert: boolean
  error?: string
  mergeHref?: string | null
}) => (
  <>
    <TopBar back={`/admin/proposals/${props.p.id}`} label="自動反映の取り消し" />
    <div class="sect" style="margin-top:4px">
      <span class="title xl">{props.headline}</span>
      <h2>取り消すと消えるもの</h2>
      <ul>
        <li>この提案で作った作品・回（削除します）</li>
        <li>形式・常設の承認待ちの提案（置き換え済みにします）</li>
        <li>この操作は元に戻せません。</li>
      </ul>
      <p class="note">
        あとから記録・マイリスト・別名・別の回などが付いた作品・回は取り消せません。そのときは作品の統合で直してください。
      </p>
    </div>
    {props.error ? (
      <div class="sect">
        <p class="note" role="alert">
          {props.error}
        </p>
        {props.mergeHref ? (
          <p class="note">
            <a href={props.mergeHref}>作品の統合へ ›</a>
          </p>
        ) : null}
      </div>
    ) : null}
    {props.canRevert ? (
      <form method="post" action={`/admin/proposals/${props.p.id}/revert`} class="sect">
        <label>
          <input type="checkbox" name="confirm" value="yes" /> 上の内容を確認しました
        </label>
        <button type="submit" class="btn danger">
          取り消す
        </button>
      </form>
    ) : null}
  </>
)
