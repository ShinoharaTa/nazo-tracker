// agent の提案（POST /api/agent/proposals、docs/agent-pipeline.md §5）の形・検証・fingerprint。
// 項目名は `<表>.<列>`（列はフォーム名 = snake_case）、値はフォームと同じ文字列で、既存の validators にそのまま通す。
// 本文の形だけを見る parseProposal は純関数。DB を引く検証は validateBundle（読むのはマスタだけ）。

import {
  type Form,
  orgFields,
  runFields,
  shopFields,
  validateOrg,
  validateRun,
  validateShop,
  validateVenue,
  validateWork,
  venueFields,
  workFields,
} from '../admin/validate'
import type { Db } from '../db/client'
import { proposalKinds } from '../db/schema'
import { norm } from '../lib/norm'

export const proposalTables = ['work', 'run', 'organization', 'venue', 'shop'] as const
export type ProposalTable = (typeof proposalTables)[number]
export type ProposalKind = Exclude<(typeof proposalKinds)[number], 'create_attempt_import'>

// 統合を提案できる表（merged_into_id がある表）
const mergeTables: readonly ProposalTable[] = ['work', 'organization', 'venue']

// 表ごとに agent が書ける列（note は書けない。run.work_id は create run / link だけ）
const writable: Record<ProposalTable, readonly string[]> = {
  work: workFields,
  run: [...runFields.filter((f) => f !== 'note'), 'work_id'],
  organization: ['name', 'site_url', 'escape_id_url'],
  venue: venueFields,
  shop: shopFields,
}

// validators に渡すフォームの項目名（note など agent が書けない列も現在の行から入れる）
const formFields: Record<ProposalTable, readonly string[]> = {
  work: workFields,
  run: runFields,
  organization: orgFields,
  venue: venueFields,
  shop: shopFields,
}

// 束の中の参照。この列に @<表> と書くと、同じ提案で作る行を指す
const placeholders: Record<string, ProposalTable> = {
  'work.primary_organization_id': 'organization',
  'run.organization_id': 'organization',
  'venue.organization_id': 'organization',
  'run.venue_id': 'venue',
  'run.shop_id': 'shop',
}

// 主名（fingerprint で target_id の代わりに使う）
const nameColumn: Record<ProposalTable, string | null> = {
  work: 'title',
  run: null,
  organization: 'name',
  venue: 'name',
  shop: 'name',
}

const cols = (table: ProposalTable, except: readonly string[] = []) =>
  writable[table].filter((c) => !except.includes(c)).map((c) => `${table}.${c}`)

// kind と target_table ごとに入れてよい項目
const allowedFields = (kind: ProposalKind, table: ProposalTable): Set<string> => {
  const extra = [...cols('organization'), ...cols('venue'), ...cols('shop')]
  switch (kind) {
    case 'create':
      if (table === 'work') return new Set([...cols('work'), ...cols('run', ['work_id']), ...extra])
      if (table === 'run') return new Set([...cols('run'), ...extra])
      return new Set(cols(table))
    case 'update':
      return new Set(cols(table, ['work_id']))
    case 'link':
      return new Set(['run.work_id'])
    case 'merge':
      return new Set([`${table}.merged_into_id`])
  }
}

const targetTablesOf = (kind: ProposalKind): readonly ProposalTable[] =>
  kind === 'link' ? ['run'] : kind === 'merge' ? mergeTables : proposalTables

export const MATCH_CANDIDATES_MAX = 20
const REASON_MAX = 40

export type ProposalItem = {
  field: string
  table: ProposalTable
  column: string
  // trim 済み。空文字は null
  newValue: string | null
  sourceId: string | null
  confidence: number
}

export type MatchCandidateJson = { table: string; id: string; score: number; reason: string }

export type ProposalDraft = {
  kind: ProposalKind
  targetTable: ProposalTable
  targetId: string | null
  requestId: string | null
  items: ProposalItem[]
  candidates: MatchCandidateJson[]
}

// API のエラー（status と本文）
export type ApiError = { status: 400 | 404 | 409; body: { error: string; [k: string]: unknown } }
const err = (status: ApiError['status'], error: string, extra: Record<string, unknown> = {}) => ({
  ok: false as const,
  error: { status, body: { error, ...extra } },
})

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const isScore = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

// 文字列か省略（null も省略扱い）。空文字も省略と同じ。文字列でなければ false
const optId = (v: unknown): string | null | false => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return false
  return v.trim() || null
}

const parseCandidates = (v: unknown): MatchCandidateJson[] | null => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > MATCH_CANDIDATES_MAX) return null
  const out: MatchCandidateJson[] = []
  for (const c of v) {
    if (!isObj(c)) return null
    const { table, id, score, reason } = c
    if (typeof table !== 'string' || !(mergeTables as readonly string[]).includes(table)) {
      return null
    }
    if (typeof id !== 'string' || !id.trim() || !isScore(score)) return null
    if (typeof reason !== 'string' || [...reason].length > REASON_MAX) return null
    out.push({ table, id: id.trim(), score, reason })
  }
  return out
}

// 本文の形・項目名・確信度・候補・プレースホルダを見る（DB は引かない）
export const parseProposal = (
  body: unknown,
): { ok: true; value: ProposalDraft } | { ok: false; error: ApiError } => {
  if (!isObj(body)) return err(400, 'invalid_body')
  const { kind } = body
  if (kind === 'create_attempt_import') return err(400, 'kind_not_supported')
  if (typeof kind !== 'string' || !(proposalKinds as readonly string[]).includes(kind)) {
    return err(400, 'invalid_kind')
  }
  const k = kind as ProposalKind
  const table = body.target_table
  if (typeof table !== 'string' || !(targetTablesOf(k) as readonly string[]).includes(table)) {
    return err(400, 'invalid_target_table')
  }
  const t = table as ProposalTable
  const targetId = optId(body.target_id)
  const requestId = optId(body.request_id)
  if (targetId === false || requestId === false) return err(400, 'invalid_body')
  if (k === 'create' && targetId) return err(400, 'target_id_not_allowed')
  if (k !== 'create' && !targetId) return err(400, 'target_id_required')

  if (!Array.isArray(body.fields) || body.fields.length === 0) return err(400, 'invalid_body')
  const allowed = allowedFields(k, t)
  const items: ProposalItem[] = []
  const seen = new Set<string>()
  for (const f of body.fields) {
    if (!isObj(f) || typeof f.field !== 'string') return err(400, 'invalid_body')
    if (!allowed.has(f.field)) return err(400, 'unknown_field')
    if (seen.has(f.field)) return err(400, 'duplicate_field')
    seen.add(f.field)
    const v = f.new_value
    if (v !== null && v !== undefined && typeof v !== 'string') return err(400, 'invalid_body')
    const sourceId = optId(f.source_id)
    if (sourceId === false) return err(400, 'invalid_body')
    if (!isScore(f.confidence)) return err(400, 'invalid_confidence')
    const [ft, column] = f.field.split('.') as [ProposalTable, string]
    items.push({
      field: f.field,
      table: ft,
      column,
      newValue: typeof v === 'string' ? v.trim() || null : null,
      sourceId,
      confidence: f.confidence,
    })
  }

  // @<表> は、その表の節が同じ束にあるときだけ。参照の列以外の @ は普通の文字列
  const sections = new Set(items.map((i) => i.table))
  for (const i of items) {
    const ref = placeholders[i.field]
    if (!ref || !i.newValue?.startsWith('@')) continue
    if (i.newValue !== `@${ref}` || !sections.has(ref)) return err(400, 'invalid_placeholder')
  }

  const candidates = parseCandidates(body.match_candidates)
  if (!candidates) return err(400, 'invalid_candidates')
  return { ok: true, value: { kind: k, targetTable: t, targetId, requestId, items, candidates } }
}

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

const sha256Hex = async (s: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

// sha256 hex([kind, target_table, target_id ?? norm(主名), [field, new_value] を field 昇順])。
// confidence と source は含めない（同じ内容を取り直しても同じ値）
export const fingerprintOf = (
  d: Pick<ProposalDraft, 'kind' | 'targetTable' | 'targetId'> & {
    items: Pick<ProposalItem, 'field' | 'newValue'>[]
  },
): Promise<string> => {
  const col = nameColumn[d.targetTable]
  const name = col ? d.items.find((i) => i.field === `${d.targetTable}.${col}`)?.newValue : null
  const pairs = d.items
    .map((i) => [i.field, i.newValue] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return sha256Hex(
    JSON.stringify([d.kind, d.targetTable, d.targetId ?? (name ? norm(name) : null), pairs]),
  )
}

// ---------------------------------------------------------------------------
// validators を通す
// ---------------------------------------------------------------------------

// DB 列名キーの行 → フォームの文字列。null は空、is_permanent は '1' か空
export const formValueOf = (column: string, v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (column === 'is_permanent') return v === 1 ? '1' : ''
  return String(v)
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

// 節の項目 → フォーム。base（update の現在の行。DB 列名キー）の上に提案の値を重ね、参照プレースホルダは空にする
const formFor = (
  table: ProposalTable,
  items: ProposalItem[],
  base: Record<string, unknown> | null,
): Form => {
  const f: Form = {}
  for (const n of formFields[table]) f[n] = base ? formValueOf(n, base[n]) : ''
  for (const i of items) {
    if (i.table !== table) continue
    f[i.column] = placeholders[i.field] && i.newValue?.startsWith('@') ? '' : (i.newValue ?? '')
  }
  return f
}

// 参照プレースホルダを空にして validateRun に通したときの channel の制約を、プレースホルダで補う
const SALE_SHOP_REQUIRED = '販売では販売先を選んでください。'
const runPlaceholderErrors = (items: ProposalItem[], f: Form, errors: string[]): string[] => {
  const value = (field: string) => items.find((i) => i.field === field)?.newValue
  const venueRef = value('run.venue_id') === '@venue'
  const shopRef = value('run.shop_id') === '@shop'
  const out = shopRef ? errors.filter((e) => e !== SALE_SHOP_REQUIRED) : [...errors]
  if (f.channel && f.channel !== 'performance' && venueRef) {
    out.push('会場は公演のときだけ選べます。')
  }
  if (f.channel && f.channel !== 'sale' && shopRef) out.push('販売先は販売のときだけ選べます。')
  return out
}

export type BundleDeps = {
  // 未統合で存在する行か（run.work_id / merge の統合先）
  isLive: (table: 'work' | 'organization' | 'venue', id: string) => Promise<boolean>
}

// 束を validators に通す。target は update / link / merge の現在の行（DB 列名キー）。
// 戻り値の oldValues は項目ごとの old_value（create は全部 null）、noChange は全項目が今の値と同じとき
export const validateBundle = async (
  db: Db,
  d: ProposalDraft,
  target: Record<string, unknown> | null,
  deps: BundleDeps,
): Promise<{ errors: string[]; oldValues: (string | null)[]; noChange: boolean }> => {
  const errors: string[] = []
  const oldValues = d.items.map((i) =>
    target ? formValueOf(i.column, target[i.column]) || null : null,
  )

  if (d.kind === 'link' || d.kind === 'merge') {
    const [i] = d.items
    const label = d.kind === 'link' ? '作品' : '統合先'
    const table = d.kind === 'link' ? 'work' : (d.targetTable as 'work' | 'organization' | 'venue')
    if (!i.newValue) errors.push(`${label}を入力してください。`)
    else if (d.kind === 'merge' && i.newValue === d.targetId) {
      errors.push('統合先に統合元と同じ行は選べません。')
    } else if (!(await deps.isLive(table, i.newValue))) {
      errors.push(`${label}が見つからないか、統合済みです。`)
    }
    return { errors, oldValues, noChange: errors.length === 0 && oldValues[0] === i.newValue }
  }

  if (d.kind === 'update') {
    const t = d.targetTable
    const f = formFor(t, d.items, target)
    const selfId = d.targetId ?? undefined
    const r =
      t === 'work'
        ? await validateWork(db, f, selfId)
        : t === 'run'
          ? await validateRun(db, f, selfId)
          : t === 'organization'
            ? await validateOrg(db, f, selfId)
            : t === 'venue'
              ? await validateVenue(db, f)
              : await validateShop(db, f, selfId)
    if (!r.ok) return { errors: r.errors, oldValues, noChange: false }
    // 検証後の値（正規化済み）が全項目で今の値と同じなら変更なし
    const input = r.value as Record<string, unknown>
    const noChange = d.items.every(
      (i) => (input[camel(i.column)] ?? null) === (target?.[i.column] ?? null),
    )
    return { errors, oldValues, noChange }
  }

  // create: 作る節を順に検証する（団体 → 会場 → 販売先 → 作品 → 回）
  const has = (t: ProposalTable) => d.targetTable === t || d.items.some((i) => i.table === t)
  if (has('organization')) {
    const r = await validateOrg(db, formFor('organization', d.items, null))
    if (!r.ok) errors.push(...r.errors)
  }
  if (has('venue')) {
    const r = await validateVenue(db, formFor('venue', d.items, null))
    if (!r.ok) errors.push(...r.errors)
  }
  if (has('shop')) {
    const r = await validateShop(db, formFor('shop', d.items, null))
    if (!r.ok) errors.push(...r.errors)
  }
  if (has('work')) {
    const r = await validateWork(db, formFor('work', d.items, null))
    if (!r.ok) errors.push(...r.errors)
  }
  if (has('run')) {
    const f = formFor('run', d.items, null)
    const r = await validateRun(db, f)
    errors.push(...runPlaceholderErrors(d.items, f, r.ok ? [] : r.errors))
    if (d.targetTable === 'run') {
      const workId = f.work_id
      if (!workId) errors.push('作品を入力してください。')
      else if (!(await deps.isLive('work', workId))) {
        errors.push('作品が見つからないか、統合済みです。')
      }
    }
  }
  return { errors, oldValues, noChange: false }
}

// Worker が名寄せ候補を引く値（work.title / 束の団体名 / run.escape_id_url）
export const matchInputOf = (d: ProposalDraft) => {
  const v = (field: string) => d.items.find((i) => i.field === field)?.newValue ?? undefined
  return { title: v('work.title'), org: v('organization.name'), url: v('run.escape_id_url') }
}
