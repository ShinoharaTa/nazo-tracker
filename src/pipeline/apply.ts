// 提案の承認・却下・自動反映・取り消しの statement 組み立て（docs/agent-pipeline.md §4）。実行は呼び出し側が db.batch の 1 回で（runStmts）。
// 承認はマスタの書き込み（src/db/master-write.ts / merge.ts の Stmts）と、提案・項目・リクエストの更新を同じ batch に入れる。
// change_log の actor はオーナー（{ userId }。自動反映はトークン）、proposal_id はこの提案。記録系テーブルはここから import しない。

import { and, eq, inArray, notExists, type SQL, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import {
  type OrgInput,
  type RunInput,
  type ShopInput,
  str,
  type VenueInput,
  type WorkInput,
} from '../admin/validate'
import { logChange, logChangeIf, type WriteCtx } from '../db/change-log'
import type { Db } from '../db/client'
import type { OrgRow, RunDbRow, ShopRow, VenueRow, WorkRow } from '../db/master'
import {
  createOrgStmts,
  createRunStmts,
  createShopStmts,
  createVenueStmts,
  createWorkStmts,
  relinkRunStmts,
  updateOrgStmts,
  updateRunStmts,
  updateShopStmts,
  updateVenueStmts,
  updateWorkStmts,
} from '../db/master-write'
import { mergeOrganizationStmts, mergeVenueStmts, mergeWorkStmts } from '../db/merge'
import {
  type AdminProposalField,
  type CandidateView,
  createProposalStmts,
  getRawRow,
  getTargetRow,
  isLiveRow,
  type NewProposal,
  type ProposalRow,
  pendingForRevert,
} from '../db/proposals'
import {
  proposal,
  proposalField,
  rejectionMemory,
  request,
  run,
  work,
  workKinds,
} from '../db/schema'
import { field } from '../lib/form'
import { ulid } from '../lib/id'
import { addDays, nowIso } from '../lib/time'
import { proposalFieldLabel, proposalTableLabel, type WorkKind } from '../ui/labels'
import {
  camel,
  fingerprintOf,
  formValueOf,
  type ProposalDraft,
  type ProposalItem,
  type ProposalTable,
  placeholderOf,
  validateBundle,
  workOnlySections,
} from './fields'

type Stmt = BatchItem<'sqlite'>

const NOTE_MAX = 500
// proposal_field の accepted を立てる UPDATE 1 文あたりの id 数（D1 は 1 文の変数が 100 個まで）
const ACCEPT_IDS_PER_UPDATE = 90

export const ALREADY_PROCESSED = 'この提案はもう処理されています。'
export const TARGET_GONE = '対象が統合されたか、見つかりません。却下してください。'
export const NOTHING_ACCEPTED =
  '採用する項目を 1 つ以上選んでください。全部いらないときは却下してください。'
const NO_RUN_TO_LINK = '回の情報が無いので紐付けられません。'
const LINK_TARGET_GONE = '紐付け先の作品が候補に無いか、統合されました。'

// 作る順（id を先に振ってプレースホルダを置き換える）
const createOrder: readonly ProposalTable[] = ['organization', 'venue', 'shop', 'work', 'run']

// kind の Select を出すか（work.kind を含む提案か、create work）
export const kindSelectable = (
  p: Pick<ProposalRow, 'kind' | 'targetTable'>,
  fields: readonly Pick<AdminProposalField, 'field'>[],
): boolean =>
  fields.some((f) => f.field === 'work.kind') || (p.kind === 'create' && p.targetTable === 'work')

// 作品に紐付けられるか（create work で、候補に作品があるとき）
export const linkable = (p: Pick<ProposalRow, 'kind' | 'targetTable'>): boolean =>
  p.kind === 'create' && p.targetTable === 'work'

// 承認フォームの値
export type ApprovalChoice = {
  // 採用 Checkbox が on の proposal_field.id
  accepted: Set<string>
  // kind の Select（'' = 未設定）。Select を出さない提案では使わない
  kind: string
  // '' = 新しく作る / 候補の作品 id
  linkWorkId: string
  note: string
  force: boolean
}

export const approvalChoiceOf = (
  body: Record<string, unknown>,
  fields: readonly Pick<AdminProposalField, 'id'>[],
): ApprovalChoice => {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '')
  return {
    accepted: new Set(fields.filter((f) => s(`accept_${f.id}`) === '1').map((f) => f.id)),
    kind: s('kind'),
    linkWorkId: s('link_work_id'),
    note: s('note'),
    force: s('force') === '1',
  }
}

// まとめて承認（docs/agent-pipeline.md §4）。Workers Free の D1 は 1 回の呼び出しで 50 クエリまで（batch は 1 と数える）。
// 件数では切らず、POST の中で D1 の呼び出しを数え（src/db/d1-count.ts）、次の 1 件を最悪の見積もりで足すと
// BULK_CALL_LIMIT を超えるならそこで打ち切って残りを「未処理」にする。test/admin-proposals-bulk.test.ts で数えている
// 選べる件数の上限（一覧の 1 ページと同じ）
export const BULK_MAX = 50
// 打ち切りの線。50 から余裕 2
export const BULK_CALL_LIMIT = 48
// 1 件の最悪の見積もり。実測の最大は 9（販売の束 @shop + 作品 + 回 sale + escape_id_url で、団体は既存・URL も全部入り）。
// 書き込みが NOT NULL で落ちたときの読み直し 2 で超える分は、BULK_CALL_LIMIT と 50 の差で吸収する
export const BULK_ITEM_WORST = 10
// 前段の middleware（attachUser）で使う分の見積もり。最大 3（セッション・延長・最終アクセス）。余裕 2 を足して 5
export const BULK_PRE_CALLS = 5

// まとめて承認の選択: 詳細の承認フォームを既定のまま送ったのと同じ（全項目採用、形式は提案の値、新しく作る、メモなし）
export const bulkChoiceOf = (
  fields: readonly Pick<AdminProposalField, 'id' | 'field' | 'newValue'>[],
): ApprovalChoice => ({
  accepted: new Set(fields.map((f) => f.id)),
  kind: fields.find((f) => f.field === 'work.kind')?.newValue ?? '',
  linkWorkId: '',
  note: '',
  force: false,
})

// 提案のあとで今の値が変わった項目
export type StaleField = { field: string; current: string | null }

export type ApprovalResult =
  | { ok: true; stmts: Stmt[] }
  | { ok: false; status: 400; errors: string[] }
  | { ok: false; status: 409; errors: string[]; stale?: StaleField[] }

const bad = (errors: string[]): ApprovalResult => ({ ok: false, status: 400, errors })
const conflict = (errors: string[], stale?: StaleField[]): ApprovalResult => ({
  ok: false,
  status: 409,
  errors,
  ...(stale ? { stale } : {}),
})

// 提案自身の change_log。row_id を「まだ pending なら（guard を満たすなら）提案の id」の副問い合わせにして、batch の先頭に置く。
// 読んでから書くまでの間に処理された（二重送信・同時の承認）なら NOT NULL 違反で batch ごと失敗する
const proposalLog = (
  db: Db,
  p: ProposalRow,
  after: ProposalRow,
  ctx: WriteCtx,
  guard: SQL = sql`${proposal.status} = 'pending'`,
): Stmt =>
  logChange(db, {
    table: proposal,
    rowId: sql`(SELECT ${proposal.id} FROM ${proposal} WHERE ${proposal.id} = ${p.id} AND ${guard})`,
    action: 'update',
    before: p,
    after,
    ...ctx,
  })

// リクエストの自動 done（proposed か processing で、紐付く提案の pending が 0 件。この提案が紐付いているので 1 件以上はある）。
// この提案を pending でなくした文より後に置く
const requestDoneStmt = (db: Db, requestId: string | null, now: string): Stmt[] =>
  requestId
    ? [
        db
          .update(request)
          .set({ status: 'done', updatedAt: now })
          .where(
            and(
              eq(request.id, requestId),
              inArray(request.status, ['proposed', 'processing']),
              notExists(
                db
                  .select({ id: proposal.id })
                  .from(proposal)
                  .where(and(eq(proposal.requestId, requestId), eq(proposal.status, 'pending'))),
              ),
            ),
          ),
      ]
    : []

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

const toItem = (f: AdminProposalField): ProposalItem => ({
  field: f.field,
  table: f.table,
  column: f.column,
  newValue: f.newValue,
  sourceId: f.sourceId,
  confidence: f.confidence ?? 0,
})

// 作った / 変えた行の id（proposal.applied_json）
export type AppliedIds = Partial<Record<ProposalTable, string>>

// create の束を書く文（作る順に、プレースホルダを先に作った行の id に置き換える）。inputs は validateBundle の検証後の値
const createBundleStmts = (
  db: Db,
  draft: ProposalDraft,
  inputs: Partial<Record<ProposalTable, Record<string, unknown>>>,
  ctx: WriteCtx,
): { stmts: Stmt[]; applied: AppliedIds } => {
  const stmts: Stmt[] = []
  const ids: AppliedIds = {}
  // 検証後の値に、プレースホルダの列だけ先に作った行の id を入れる
  const inputOf = (t: ProposalTable): Record<string, unknown> => {
    const input = { ...inputs[t] }
    for (const i of draft.items) {
      const ref = i.table === t ? placeholderOf(i) : null
      if (ref) input[camel(i.column)] = ids[ref] ?? null
    }
    return input
  }
  for (const t of createOrder) {
    if (!inputs[t]) continue
    const input = inputOf(t)
    const s =
      t === 'organization'
        ? createOrgStmts(db, input as OrgInput, ctx)
        : t === 'venue'
          ? createVenueStmts(db, input as VenueInput, ctx)
          : t === 'shop'
            ? createShopStmts(db, input as ShopInput, ctx)
            : t === 'work'
              ? createWorkStmts(db, input as WorkInput, ctx)
              : createRunStmts(
                  db,
                  (draft.targetTable === 'run'
                    ? draft.items.find((i) => i.field === 'run.work_id')?.newValue
                    : ids.work) ?? '',
                  input as RunInput,
                  ctx,
                )
    ids[t] = s.id
    stmts.push(...s.stmts)
  }
  return { stmts, applied: ids }
}

// 承認の検証と文の組み立て。p は pending であることを呼び出し側で確かめてから渡す（batch の先頭でも確かめる）
export const buildApproval = async (
  db: Db,
  p: ProposalRow,
  fields: AdminProposalField[],
  choice: ApprovalChoice,
  candidates: readonly CandidateView[],
  userId: string,
): Promise<ApprovalResult> => {
  const ctx: WriteCtx = { actor: { userId }, proposalId: p.id }
  const table = p.targetTable as ProposalTable
  const errors: string[] = []
  const note = field(errors, 'メモ', choice.note, str(NOTE_MAX, { multiline: true }))
  const selectable = kindSelectable(p, fields)
  const linking = linkable(p) && choice.linkWorkId !== ''
  let kind: WorkKind | null = null
  if (selectable && !linking && choice.kind !== '') {
    if ((workKinds as readonly string[]).includes(choice.kind)) kind = choice.kind as WorkKind
    else errors.push('形式の値が正しくありません。')
  }
  if (errors.length) return bad(errors)

  // 対象（update / link / merge）
  let raw: Record<string, unknown> | null = null
  let target: Record<string, unknown> | null = null
  if (p.kind !== 'create') {
    raw = p.targetId ? await getRawRow(db, table, p.targetId) : null
    target = p.targetId && raw ? await getTargetRow(db, table, p.targetId) : null
    if (!raw || !target || target.merged_into_id) return conflict([TARGET_GONE])
  }

  // 採否。work.kind は Select の値が提案と同じなら採用。紐付けるときは work.* と、
  // 作品からしか参照されていない節（採用した項目で判定）を使わない
  const usesKind = selectable && !linking
  const checkedOf = (f: AdminProposalField) => {
    if (linking && f.table === 'work') return false
    if (f.field === 'work.kind' && usesKind) return (kind ?? null) === f.newValue
    return choice.accepted.has(f.id)
  }
  const checked = fields.filter(checkedOf)
  const dropped = linking
    ? workOnlySections(fields.filter((f) => f.table === 'work' || checked.includes(f)))
    : new Set<ProposalTable>()
  const accepted = checked.filter((f) => !dropped.has(f.table))
  const currentKind = (target?.kind as string | null | undefined) ?? null
  const kindChanges = usesKind && kind !== currentKind
  // 紐付けるときは回の項目が要る（work.* は使わないので、採用 0 件より先に見る）
  if (linking && !accepted.some((f) => f.table === 'run')) return bad([NO_RUN_TO_LINK])
  if (accepted.length === 0 && !kindChanges) return bad([NOTHING_ACCEPTED])

  // 提案のあとで今の値が変わった（force=1 で無視して反映）
  if (target && !choice.force) {
    const kindField = fields.find((f) => f.field === 'work.kind')
    const checks = kindChanges && kindField ? [...new Set([...accepted, kindField])] : accepted
    const stale = checks.flatMap((f) => {
      const current = formValueOf(f.column, target[f.column]) || null
      return current === f.oldValue ? [] : [{ field: f.field, current }]
    })
    if (stale.length) {
      const names = stale.map((s) => proposalFieldLabel(s.field)).join('・')
      return conflict(
        [
          `提案のあとで値が変わっています（${names}）。今の値を確かめて、もう一度承認してください。`,
        ],
        stale,
      )
    }
  }

  // validators に通す束（採用した項目 + kind の選び直し）
  const items = accepted.filter((f) => f.field !== 'work.kind').map(toItem)
  if (usesKind) {
    items.push({
      field: 'work.kind',
      table: 'work',
      column: 'kind',
      newValue: kind,
      sourceId: null,
      confidence: 1,
    })
  }
  let draft: ProposalDraft = {
    kind: p.kind as ProposalDraft['kind'],
    targetTable: table,
    targetId: p.targetId,
    requestId: p.requestId,
    items,
    candidates: [],
  }
  if (linking) {
    if (!candidates.some((c) => c.table === 'work' && c.id === choice.linkWorkId)) {
      return bad([LINK_TARGET_GONE])
    }
    draft = {
      ...draft,
      targetTable: 'run',
      items: [
        ...items,
        {
          field: 'run.work_id',
          table: 'run',
          column: 'work_id',
          newValue: choice.linkWorkId,
          sourceId: null,
          confidence: 1,
        },
      ],
    }
  }

  // @<表> は、その表の節を作るときだけ（節の項目を全部外したら参照も外す）
  const sections = new Set(draft.items.map((i) => i.table))
  for (const i of draft.items) {
    const ref = placeholderOf(i)
    if (ref && !sections.has(ref)) {
      const t = proposalTableLabel(ref)
      errors.push(
        `${proposalFieldLabel(i.field)}は、この提案で作る${t}を指しています。${t}の項目も採用するか、${proposalFieldLabel(i.field)}を外してください。`,
      )
    }
  }
  if (errors.length) return bad(errors)

  const v = await validateBundle(db, draft, target, { isLive: (t, id) => isLiveRow(db, t, id) })
  if (v.errors.length) return bad(v.errors)

  // マスタの書き込み
  const master: Stmt[] = []
  const applied: AppliedIds = {}
  if (draft.kind === 'create') {
    const s = createBundleStmts(db, draft, v.inputs, ctx)
    Object.assign(applied, s.applied)
    master.push(...s.stmts)
  } else if (draft.kind === 'update') {
    const input = v.inputs[table] ?? {}
    const s =
      table === 'work'
        ? updateWorkStmts(db, raw as WorkRow, input as WorkInput, ctx)
        : table === 'run'
          ? updateRunStmts(db, raw as RunDbRow, input as RunInput, ctx)
          : table === 'organization'
            ? updateOrgStmts(db, raw as OrgRow, input as OrgInput, ctx)
            : table === 'venue'
              ? updateVenueStmts(db, raw as VenueRow, input as VenueInput, ctx)
              : updateShopStmts(db, raw as ShopRow, input as ShopInput, ctx)
    applied[table] = s.id
    master.push(...s.stmts)
  } else if (draft.kind === 'link') {
    const workId = draft.items[0].newValue ?? ''
    const s = relinkRunStmts(db, raw as RunDbRow, workId, ctx)
    applied.run = s.id
    master.push(...s.stmts)
  } else {
    // merge: A = 対象、B = merged_into_id（validateBundle で未統合・A ≠ B を確かめた）
    const intoId = draft.items[0].newValue ?? ''
    const b = await getRawRow(db, table, intoId)
    if (!b) return bad([`統合先が見つからないか、統合済みです。`])
    master.push(
      ...(table === 'work'
        ? await mergeWorkStmts(db, raw as WorkRow, b as WorkRow, ctx)
        : table === 'organization'
          ? await mergeOrganizationStmts(db, raw as OrgRow, b as OrgRow, ctx)
          : await mergeVenueStmts(db, raw as VenueRow, b as VenueRow, ctx)),
    )
    applied[table] = raw?.id as string
  }

  const now = nowIso()
  const set = {
    status: 'applied' as const,
    reviewedAt: now,
    reviewerUserId: userId,
    reviewNote: note,
    appliedJson: JSON.stringify(applied),
  }
  const acceptedIds = accepted.map((f) => f.id)
  return {
    ok: true,
    stmts: [
      proposalLog(db, p, { ...p, ...set }, ctx),
      ...master,
      db
        .update(proposal)
        .set(set)
        .where(and(eq(proposal.id, p.id), eq(proposal.status, 'pending'))),
      db.update(proposalField).set({ accepted: 0 }).where(eq(proposalField.proposalId, p.id)),
      ...chunks(acceptedIds, ACCEPT_IDS_PER_UPDATE).map((ids) =>
        db.update(proposalField).set({ accepted: 1 }).where(inArray(proposalField.id, ids)),
      ),
      ...requestDoneStmt(db, p.requestId, now),
    ],
  }
}

// 却下フォームの値
export type RejectionChoice = { reason: string; remember: boolean }

export const rejectionChoiceOf = (body: Record<string, unknown>): RejectionChoice => ({
  reason: typeof body.reason === 'string' ? body.reason.trim() : '',
  remember: body.remember === '1',
})

// 却下: 提案を rejected、remember なら却下記憶を UPSERT、リクエストの自動 done
export const buildRejection = (
  db: Db,
  p: ProposalRow,
  choice: RejectionChoice,
  userId: string,
): { ok: true; stmts: Stmt[] } | { ok: false; errors: string[] } => {
  const errors: string[] = []
  const reason = field(
    errors,
    '却下の理由',
    choice.reason,
    str(NOTE_MAX, { multiline: true }),
    true,
  )
  if (errors.length || !reason) return { ok: false, errors }
  const ctx: WriteCtx = { actor: { userId }, proposalId: p.id }
  const now = nowIso()
  const set = {
    status: 'rejected' as const,
    reviewedAt: now,
    reviewerUserId: userId,
    reviewNote: reason,
  }
  return {
    ok: true,
    stmts: [
      proposalLog(db, p, { ...p, ...set }, ctx),
      db
        .update(proposal)
        .set(set)
        .where(and(eq(proposal.id, p.id), eq(proposal.status, 'pending'))),
      ...(choice.remember
        ? [
            db
              .insert(rejectionMemory)
              .values({ fingerprint: p.fingerprint, reason, createdAt: now })
              .onConflictDoUpdate({ target: rejectionMemory.fingerprint, set: { reason } }),
          ]
        : []),
      ...requestDoneStmt(db, p.requestId, now),
    ],
  }
}

// ---------------------------------------------------------------------------
// 自動反映・取り消し（docs/agent-pipeline.md §4 A-3）
// ---------------------------------------------------------------------------

// 自動反映を取り消せる日数
export const REVERT_DAYS = 7

export type AutoApplyInput = Omit<
  NewProposal,
  'id' | 'status' | 'revertUntil' | 'appliedJson' | 'followUpOfId' | 'acceptedOf'
> & {
  // validateBundle の検証後の値（draft は正規化後の項目）
  inputs: Partial<Record<ProposalTable, Record<string, unknown>>>
  // 入れずに反映し、follow-up の承認待ちにする項目（work.kind / run.is_permanent）
  deferred: readonly string[]
}

// 提案を auto_applied で作り、同じ batch で束を書く（actor = トークン）。deferred の項目は既定値（kind NULL /
// is_permanent 0）で作り、同じ値の update 提案（pending、follow_up_of_id = この提案）を作る。
// 呼び出し側は fingerprint・却下記憶・重複の検査を済ませてから渡す
export const buildAutoApply = async (
  db: Db,
  a: AutoApplyInput,
): Promise<{ id: string; stmts: Stmt[]; revertUntil: string; followUps: string[] }> => {
  const id = ulid()
  const ctx: WriteCtx = { actor: { tokenId: a.tokenId }, proposalId: id }
  const deferred = new Set(a.deferred)
  const inputs = { ...a.inputs }
  if (deferred.has('work.kind') && inputs.work) inputs.work = { ...inputs.work, kind: null }
  if (deferred.has('run.is_permanent') && inputs.run) {
    inputs.run = { ...inputs.run, isPermanent: 0 }
  }
  const master = createBundleStmts(db, a.draft, inputs, ctx)
  const now = nowIso()
  const revertUntil = addDays(now, REVERT_DAYS)
  // change_log の proposal_id がこの提案を指すので、提案の INSERT を先に置く
  const created = await createProposalStmts(db, {
    draft: a.draft,
    oldValues: a.oldValues,
    fingerprint: a.fingerprint,
    candidatesJson: a.candidatesJson,
    tokenId: a.tokenId,
    id,
    status: 'auto_applied',
    revertUntil,
    appliedJson: JSON.stringify(master.applied),
    acceptedOf: (i) => (deferred.has(i.field) ? 0 : 1),
  })
  const followUps: Stmt[] = []
  const followUpIds: string[] = []
  for (const item of a.draft.items) {
    if (!deferred.has(item.field)) continue
    const targetId = master.applied[item.table]
    if (!targetId) continue
    // 依頼元のリクエストは付けない（作品・回はもう反映したので、リクエストは自動 done にする）
    const draft: ProposalDraft = {
      kind: 'update',
      targetTable: item.table,
      targetId,
      requestId: null,
      items: [item],
      candidates: [],
    }
    const f = await createProposalStmts(db, {
      draft,
      // 作ったばかりの行は既定値（kind NULL / is_permanent 0 → どちらも空）
      oldValues: [null],
      fingerprint: await fingerprintOf(draft),
      candidatesJson: '[]',
      tokenId: a.tokenId,
      followUpOfId: id,
    })
    followUps.push(...f.stmts)
    followUpIds.push(f.id)
  }
  return {
    id,
    stmts: [
      ...created.stmts,
      ...master.stmts,
      ...followUps,
      ...requestDoneStmt(db, a.draft.requestId, now),
    ],
    revertUntil,
    followUps: followUpIds,
  }
}

export const REVERT_EXPIRED = '取り消せる期間を過ぎたか、取り消せない提案です。'
export const REVERT_BLOCKED =
  'この作品・回にはあとから記録や別名などが付いたため、取り消せません。直すときは作品の統合を使ってください。'

// 取り消せる提案か（自動反映で、期限内）
export const revertable = (p: Pick<ProposalRow, 'status' | 'revertUntil'>, now = nowIso()) =>
  p.status === 'auto_applied' && !!p.revertUntil && p.revertUntil > now

export const appliedIdsOf = (json: string | null): AppliedIds => {
  try {
    const a: unknown = JSON.parse(json ?? '{}')
    return a && typeof a === 'object' ? (a as AppliedIds) : {}
  } catch {
    return {}
  }
}

// 取り消し: applied_json の行を run → work の順に物理 DELETE（change_log delete、actor = オーナー）、
// 提案を reverted、follow-up と、取り消す作品・回を対象にした承認待ちを superseded。あとから記録・別名・別の回などが付いた行は
// FK 違反で batch ごと失敗する（呼び出し側が REVERT_BLOCKED にする）。統合された作品・付け替えられた回は先に止める
export const buildRevert = async (
  db: Db,
  p: ProposalRow,
  userId: string,
): Promise<{ ok: true; stmts: Stmt[] } | { ok: false; error: string }> => {
  const now = nowIso()
  if (!revertable(p, now)) return { ok: false, error: REVERT_EXPIRED }
  const ctx: WriteCtx = { actor: { userId }, proposalId: p.id }
  const applied = appliedIdsOf(p.appliedJson)
  const runRow = applied.run ? ((await getRawRow(db, 'run', applied.run)) as RunDbRow | null) : null
  const workRow = applied.work
    ? ((await getRawRow(db, 'work', applied.work)) as WorkRow | null)
    : null
  if (applied.run && !runRow) return { ok: false, error: REVERT_BLOCKED }
  if (applied.work && (!workRow || workRow.mergedIntoId))
    return { ok: false, error: REVERT_BLOCKED }
  if (runRow && workRow && runRow.workId !== workRow.id) return { ok: false, error: REVERT_BLOCKED }

  const deletes: Stmt[] = []
  if (runRow) {
    deletes.push(
      db.delete(run).where(eq(run.id, runRow.id)),
      logChange(db, {
        table: run,
        rowId: runRow.id,
        action: 'delete',
        before: runRow,
        after: null,
        ...ctx,
      }),
    )
  }
  if (workRow) {
    deletes.push(
      db.delete(work).where(eq(work.id, workRow.id)),
      logChange(db, {
        table: work,
        rowId: workRow.id,
        action: 'delete',
        before: workRow,
        after: null,
        ...ctx,
      }),
    )
  }
  const set = { status: 'reverted' as const, revertedAt: now, revertedByUserId: userId }
  // follow-up と、取り消す作品・回を対象にした承認待ち（対象が消えるので承認できなくなる）
  const followUps = await pendingForRevert(db, p.id, {
    work: workRow?.id,
    run: runRow?.id,
  })
  return {
    ok: true,
    stmts: [
      // 読んでから書くまでの間に取り消された・期限を過ぎたなら NOT NULL 違反で batch ごと失敗する
      proposalLog(
        db,
        p,
        { ...p, ...set },
        ctx,
        sql`${proposal.status} = 'auto_applied' AND ${proposal.revertUntil} > ${now}`,
      ),
      ...deletes,
      db
        .update(proposal)
        .set(set)
        .where(and(eq(proposal.id, p.id), eq(proposal.status, 'auto_applied'))),
      // 読んでから書くまでの間に承認・却下された提案は変えず、履歴も残さない（履歴を UPDATE の前に同じ条件で入れる）
      ...followUps.flatMap((f) => [
        logChangeIf(
          db,
          {
            table: proposal,
            rowId: f.id,
            action: 'update',
            before: f,
            after: { ...f, status: 'superseded' },
            ...ctx,
          },
          sql`EXISTS (SELECT 1 FROM ${proposal} WHERE ${proposal.id} = ${f.id} AND ${proposal.status} = 'pending')`,
        ),
        db
          .update(proposal)
          .set({ status: 'superseded' })
          .where(and(eq(proposal.id, f.id), eq(proposal.status, 'pending'))),
      ]),
    ],
  }
}
