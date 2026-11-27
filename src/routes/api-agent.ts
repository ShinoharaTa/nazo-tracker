// agent 用の JSON API（/api/agent/*、docs/agent-pipeline.md §5）。Bearer のトークンだけで認証し、cookie は見ない。
// src/index.ts で csrf / attachUser より前に登録する。定義していないパスは認証後に全部 403。

import { type Context, Hono } from 'hono'
import { escapeRunUrl, permanentValues } from '../admin/validate'
import { currentAgent, requireAgent, requireScope } from '../auth/agent'
import type { Db } from '../db/client'
import {
  type AgentIndexPart,
  type AgentIndexTable,
  type AgentRowTable,
  agentIndexTables,
  agentRowTables,
  getAgentRow,
  listAgentIndex,
} from '../db/master'
import { runStmts } from '../db/master-write'
import { findCandidates } from '../db/match'
import {
  countPendingForRequest,
  createProposalStmts,
  createSource,
  existingSources,
  getProposalWithFields,
  getRejection,
  getTargetRow,
  hasPendingWithEscapeUrl,
  isLiveRow,
  listAgentProposals,
  pendingIdByFingerprint,
  runByEscapeIdUrl,
} from '../db/proposals'
import {
  getAgentRequest,
  listAgentRequests,
  type OwnRequest,
  setRequestStatus,
} from '../db/requests'
import { proposalStatuses, requestStatuses, runChannels, shopKinds, workKinds } from '../db/schema'
import { getAutoApply } from '../db/settings'
import type { AppEnv } from '../env'
import { url as urlParser } from '../lib/form'
import { hasUserinfo } from '../lib/match'
import { prefectures } from '../lib/prefectures'
import { allow } from '../lib/rate-limit'
import { isEscapeIdMyPage } from '../lib/url'
import { buildAutoApply } from '../pipeline/apply'
import { autoApplyDecision } from '../pipeline/auto'
import {
  fingerprintOf,
  matchInputOf,
  parseProposal,
  placeholderSchema,
  proposalFieldSchema,
  validateBundle,
} from '../pipeline/fields'
import { canTransition } from '../requests/transitions'
import type { RequestStatus } from '../ui/labels'
import { matchHandler } from './match-handler'

// 本文の上限（バイト）
const BODY_MAX = 64 * 1024
// 一覧の件数（既定・上限）。範囲外・数でない値は既定か上限に寄せる
const REQUESTS_LIMIT = { def: 50, max: 100 }
const INDEX_LIMIT = { def: 1000, max: 1000 }
const PROPOSALS_LIMIT = { def: 50, max: 100 }
// 質問はオーナーの質問と同じ上限、メモは依頼者のメモと同じ上限（コードポイント）
const QUESTION_MAX = 1000
const NOTE_MAX = 2000

const apiAgent = new Hono<AppEnv>({ strict: false })

// 401 / 403 も含めて全応答を no-store にする
apiAgent.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})
// requireAgent（SHA-256 + D1 読み）より前で止める。key は CF-Connecting-IP（無ければ制限しない）
apiAgent.use('*', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP') || null
  if (!(await allow(c.env.AGENT_LIMITER, ip ? `agent:${ip}` : null))) {
    c.header('Retry-After', '60')
    return c.json({ error: 'rate_limited' }, 429)
  }
  await next()
})
apiAgent.use('*', requireAgent)

// POST / PUT / PATCH は JSON の本文だけ。DELETE は本文があるとき（Content-Length > 0 か Transfer-Encoding あり）
// だけ同じ検査をし、本文の無い DELETE は通す。ここで一度読んで検査し、各ハンドラは c.req.json() で受け取る
const BODY_METHODS = ['POST', 'PUT', 'PATCH']
const hasBody = (c: Context<AppEnv>) =>
  Number(c.req.header('Content-Length')) > 0 || c.req.header('Transfer-Encoding') !== undefined
apiAgent.use('*', async (c, next) => {
  const m = c.req.method
  if (!BODY_METHODS.includes(m) && !(m === 'DELETE' && hasBody(c))) return next()
  const type = c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return c.json({ error: 'unsupported_media_type' }, 415)
  if (Number(c.req.header('Content-Length')) > BODY_MAX) return c.json({ error: 'too_large' }, 413)
  const text = await c.req.text()
  if (new TextEncoder().encode(text).length > BODY_MAX) return c.json({ error: 'too_large' }, 413)
  try {
    JSON.parse(text)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  await next()
})

// CLI の疎通確認
apiAgent.get('/whoami', (c) => {
  const t = currentAgent(c)
  return c.json({ token_id: t.id, name: t.name, expires_at: t.expiresAt })
})

const limitOf = (raw: string | undefined, { def, max }: { def: number; max: number }) => {
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : def
  return Math.min(Math.max(n, 1), max)
}

const isStatus = (v: unknown): v is RequestStatus =>
  typeof v === 'string' && (requestStatuses as readonly string[]).includes(v)

// 依頼者の id・表示名は返さない（OwnRequest にも無い）
const requestJson = (r: OwnRequest) => ({
  id: r.id,
  kind: r.kind,
  payload: r.payload,
  status: r.status,
  question: r.question,
  reply: r.reply,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
})

// リクエスト一覧。status はカンマ区切り（既定 triaged）、古い順
apiAgent.get('/requests', requireScope('request:rw'), async (c) => {
  const raw = c.req.query('status')
  const statuses = raw === undefined ? ['triaged'] : raw.split(',').map((s) => s.trim())
  if (!statuses.every(isStatus)) return c.json({ error: 'invalid_status' }, 400)
  const limit = limitOf(c.req.query('limit'), REQUESTS_LIMIT)
  const items = await listAgentRequests(c.get('db'), [...new Set(statuses)], limit)
  return c.json({ items: items.map(requestJson) })
})

apiAgent.get('/requests/:id', requireScope('request:rw'), async (c) => {
  const r = await getAgentRequest(c.get('db'), c.req.param('id'))
  if (!r) return c.json({ error: 'not_found' }, 404)
  return c.json(requestJson(r))
})

// 文字列か省略（null も省略扱い）。前後の空白を落とし、空なら省略と同じ
const optText = (v: unknown): string | null | false => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return false
  return v.trim() || null
}

// 状態の更新。遷移は src/requests/transitions.ts の agent の行だけ
apiAgent.patch('/requests/:id', requireScope('request:rw'), async (c) => {
  const body: unknown = await c.req.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const b = body as Record<string, unknown>
  if (!isStatus(b.status)) return c.json({ error: 'invalid_status' }, 400)
  const to = b.status
  const question = optText(b.question)
  const note = optText(b.note)
  if (question === false || note === false) return c.json({ error: 'invalid_body' }, 400)
  if (question && [...question].length > QUESTION_MAX) {
    return c.json({ error: 'question_too_long' }, 400)
  }
  if (note && [...note].length > NOTE_MAX) return c.json({ error: 'note_too_long' }, 400)
  if (to === 'needs_info' && !question) return c.json({ error: 'question_required' }, 400)

  const db = c.get('db')
  const id = c.req.param('id')
  const cur = await getAgentRequest(db, id)
  if (!cur) return c.json({ error: 'not_found' }, 404)
  if (!canTransition(cur.status, to, 'agent')) {
    return c.json({ error: 'invalid_transition', from: cur.status, to }, 409)
  }
  // 提案を 1 件も出さずに「確認中」にはしない（pending が 0 件だと Worker の自動 done が起きない）
  if (to === 'proposed' && (await countPendingForRequest(db, id)) === 0) {
    return c.json({ error: 'no_pending_proposal' }, 409)
  }
  const res = await setRequestStatus(db, id, to, { note, question }, 'agent')
  if (res === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (res === 'invalid_transition') {
    // 読んでから書くまでの間に状態が変わった
    const now = await getAgentRequest(db, id)
    if (!now) return c.json({ error: 'not_found' }, 404)
    return c.json({ error: 'invalid_transition', from: now.status, to }, 409)
  }
  return c.json({ id, status: to })
})

// 名寄せ候補（/api/admin/match と同じ検証・同じ形。完全一致のみ）
apiAgent.get('/match', requireScope('master:read'), matchHandler)

// マスタの行 1 つ（DB 列名、note は除く）
apiAgent.get('/rows/:table/:id', requireScope('master:read'), async (c) => {
  const table = c.req.param('table')
  if (!(agentRowTables as readonly string[]).includes(table)) {
    return c.json({ error: 'invalid_table' }, 400)
  }
  const row = await getAgentRow(c.get('db'), table as AgentRowTable, c.req.param('id'))
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})

// 名寄せ用の軽い一覧（未統合だけ、id 昇順）。venue は name のみ
apiAgent.get('/index/:table', requireScope('master:read'), async (c) => {
  const table = c.req.param('table')
  if (!(agentIndexTables as readonly string[]).includes(table)) {
    return c.json({ error: 'invalid_table' }, 400)
  }
  const part = c.req.query('part') ?? 'name'
  if (part !== 'name' && (part !== 'alias' || table === 'venue')) {
    return c.json({ error: 'invalid_part' }, 400)
  }
  const after = c.req.query('after') || null
  const limit = limitOf(c.req.query('limit'), INDEX_LIMIT)
  return c.json(
    await listAgentIndex(
      c.get('db'),
      table as AgentIndexTable,
      part as AgentIndexPart,
      after,
      limit,
    ),
  )
})

// 提案で書ける項目と値の一覧（MCP のツール説明の元。fields.ts の表と validators の enum から作る）
apiAgent.get('/schema', requireScope('master:read'), (c) =>
  c.json({
    proposal_fields: proposalFieldSchema(),
    enums: {
      'work.kind': workKinds,
      'run.channel': runChannels,
      'shop.kind': shopKinds,
      'venue.prefecture': prefectures,
      // 空文字（null）は常設でない
      'run.is_permanent': [...permanentValues, ''],
    },
    placeholders: placeholderSchema(),
    source_methods: agentSourceMethods,
    request_statuses: requestStatuses,
    proposal_statuses: proposalStatuses,
  }),
)

// ---- 出典（source）。Worker は外部へ取りに行かず、agent が取った記録だけを受け取る（docs/sources.md §4）

const EXCERPT_MAX = 500
const agentSourceMethods = ['escape_mcp', 'webfetch', 'pds'] as const
// X（旧 Twitter）とその短縮 URL は取得元にしない（サブドメインも全部）
const xHosts = ['x.com', 'twitter.com', 't.co']
const isXHost = (host: string) => xHosts.some((h) => host === h || host.endsWith(`.${h}`))
// ISO 8601 の日時（タイムゾーン付き）
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/

apiAgent.post('/sources', requireScope('source:write'), async (c) => {
  const body: unknown = await c.req.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const b = body as Record<string, unknown>
  const parsed = typeof b.url === 'string' ? urlParser()(b.url.trim()) : null
  // userinfo（user:pass@）付きは出典にしない
  if (!parsed?.ok || hasUserinfo(parsed.value)) return c.json({ error: 'invalid_url' }, 400)
  const href = parsed.value
  const host = new URL(href).hostname.replace(/\.+$/, '').toLowerCase()
  if (isEscapeIdMyPage(href) || isXHost(host)) {
    return c.json({ error: 'forbidden_source' }, 400)
  }
  const method = b.method
  if (typeof method !== 'string' || !(agentSourceMethods as readonly string[]).includes(method)) {
    return c.json({ error: 'invalid_method' }, 400)
  }
  if (method === 'escape_mcp' && host !== 'escape.id') {
    return c.json({ error: 'method_host_mismatch' }, 400)
  }
  const robots = b.robots_checked
  if (robots !== 0 && robots !== 1 && robots !== true && robots !== false) {
    return c.json({ error: 'invalid_robots_checked' }, 400)
  }
  const robotsChecked = robots === 1 || robots === true ? 1 : 0
  if (method === 'webfetch' && robotsChecked !== 1) {
    return c.json({ error: 'robots_not_checked' }, 400)
  }
  const fetchedAt = b.fetched_at
  if (
    typeof fetchedAt !== 'string' ||
    !ISO_DATETIME.test(fetchedAt) ||
    Number.isNaN(Date.parse(fetchedAt))
  ) {
    return c.json({ error: 'invalid_fetched_at' }, 400)
  }
  const hash = b.content_hash ?? null
  if (hash !== null && (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash))) {
    return c.json({ error: 'invalid_content_hash' }, 400)
  }
  const excerpt = b.excerpt ?? null
  if (excerpt !== null && (typeof excerpt !== 'string' || [...excerpt].length > EXCERPT_MAX)) {
    return c.json({ error: 'excerpt_too_long' }, 400)
  }
  const id = await createSource(c.get('db'), {
    url: href,
    domain: host,
    method: method as (typeof agentSourceMethods)[number],
    fetchedAt: new Date(fetchedAt).toISOString(),
    contentHash: hash?.toLowerCase() ?? null,
    excerpt: excerpt || null,
    robotsChecked,
  })
  return c.json({ id }, 201)
})

// ---- 提案（proposal）。自動反映ルール（src/pipeline/auto.ts）に合えば auto_applied、それ以外は pending

const isUniqueViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes('UNIQUE constraint failed')

// 提案の書き込みが UNIQUE 違反で落ちたときの 409 の本文。確かめてから書くまでの間に、同じ fingerprint の pending か、
// （自動反映なら）同じ escape.id URL の回ができた。自動反映でほかの UNIQUE に当たったら conflict。どれでもなければ null
export const writeConflictOf = async (
  db: Db,
  e: unknown,
  w: { fingerprint: string; escapeUrl: string | null; autoApplied: boolean },
): Promise<Record<string, unknown> | null> => {
  if (!isUniqueViolation(e)) return null
  const id = await pendingIdByFingerprint(db, w.fingerprint)
  if (id) return { error: 'duplicate_pending', proposal_id: id }
  if (!w.autoApplied) return null
  const dup = w.escapeUrl ? await runByEscapeIdUrl(db, w.escapeUrl) : undefined
  if (dup) return { error: 'duplicate_escape_id_url', run_id: dup.id, work_id: dup.workId }
  return { error: 'conflict' }
}

apiAgent.post('/proposals', requireScope('proposal:write'), async (c) => {
  const body = await c.req.json()
  const parsed = parseProposal(body)
  if (!parsed.ok) return c.json(parsed.error.body, parsed.error.status)
  const d = parsed.value
  // hold: true なら自動反映の判定を飛ばして必ず pending（fingerprint には含めない）
  const { hold = false } = body as { hold?: unknown }
  if (typeof hold !== 'boolean') return c.json({ error: 'invalid_hold' }, 400)
  const db = c.get('db')

  let requestKind: string | null = null
  if (d.requestId) {
    const r = await getAgentRequest(db, d.requestId)
    if (!r) return c.json({ error: 'request_not_found' }, 404)
    if (r.status !== 'processing') return c.json({ error: 'request_not_processing' }, 409)
    requestKind = r.kind
  }

  let target: Record<string, unknown> | null = null
  if (d.targetId) {
    target = await getTargetRow(db, d.targetTable, d.targetId)
    if (!target) return c.json({ error: 'target_not_found' }, 404)
    if (target.merged_into_id) return c.json({ error: 'target_merged' }, 409)
  }

  const sourceIds = [...new Set(d.items.flatMap((i) => (i.sourceId ? [i.sourceId] : [])))]
  const found = await existingSources(db, sourceIds)
  const missing = d.items.find((i) => i.sourceId && !found.has(i.sourceId))
  if (missing) return c.json({ error: 'source_not_found', field: missing.field }, 400)

  // 既にある回の escape.id URL で作ろうとしている（検証の「同じ URL の回があります」より先に、回と作品を返す）
  const escapeUrl = d.items.find((i) => i.field === 'run.escape_id_url')?.newValue
  if (d.kind === 'create' && escapeUrl) {
    const norm = escapeRunUrl()(escapeUrl)
    const dup = norm.ok ? await runByEscapeIdUrl(db, norm.value) : undefined
    if (dup) {
      return c.json({ error: 'duplicate_escape_id_url', run_id: dup.id, work_id: dup.workId }, 409)
    }
  }

  const v = await validateBundle(db, d, target, { isLive: (t, id) => isLiveRow(db, t, id) })
  if (v.errors.length) return c.json({ error: 'invalid_fields', details: v.errors }, 400)
  if (v.noChange) return c.json({ error: 'no_change' }, 400)
  // 以下の fingerprint・候補・保存は validator が正規化した後の値で
  const nd = { ...d, items: v.items }

  const fingerprint = await fingerprintOf(nd)
  const rejected = await getRejection(db, fingerprint)
  if (rejected) return c.json({ error: 'suppressed', reason: rejected.reason }, 409)
  const pendingId = await pendingIdByFingerprint(db, fingerprint)
  if (pendingId) return c.json({ error: 'duplicate_pending', proposal_id: pendingId }, 409)

  // Worker 自身の完全一致を worker: 付きで足す（対象そのものは除く）
  const m = matchInputOf(nd)
  const own =
    m.title || m.org || m.url ? await findCandidates(db, m) : { works: [], organizations: [] }
  const workerCandidates = [
    ...own.works.map((w) => ({
      table: 'work',
      id: w.id,
      score: w.score,
      reason: `worker:${w.reason}`,
    })),
    ...own.organizations.map((o) => ({
      table: 'organization',
      id: o.id,
      score: o.score,
      reason: `worker:${o.reason}`,
    })),
  ].filter((x) => !(x.table === d.targetTable && x.id === d.targetId))

  const proposalInput = {
    draft: nd,
    oldValues: v.oldValues,
    fingerprint,
    candidatesJson: JSON.stringify([...nd.candidates, ...workerCandidates]),
    tokenId: currentAgent(c).id,
  }
  const normEscapeUrl = nd.items.find((i) => i.field === 'run.escape_id_url')?.newValue ?? null
  const decision = hold
    ? { apply: false, deferred: [] }
    : autoApplyDecision({
        enabled: await getAutoApply(db),
        kind: nd.kind,
        targetTable: nd.targetTable,
        items: nd.items,
        sourceMethods: found,
        workerCandidates: workerCandidates.length,
        agentScores: nd.candidates.map((x) => x.score),
        requestKind,
        pendingSameUrl:
          nd.kind === 'create' &&
          !!normEscapeUrl &&
          (await hasPendingWithEscapeUrl(db, normEscapeUrl)),
      })
  const s = decision.apply
    ? await buildAutoApply(db, { ...proposalInput, inputs: v.inputs, deferred: decision.deferred })
    : { ...(await createProposalStmts(db, proposalInput)), revertUntil: null, followUps: [] }
  try {
    await runStmts(db, s.stmts)
  } catch (e) {
    const conflict = await writeConflictOf(db, e, {
      fingerprint,
      escapeUrl: normEscapeUrl,
      autoApplied: decision.apply,
    })
    if (!conflict) throw e
    return c.json(conflict, 409)
  }
  return c.json(
    {
      id: s.id,
      status: decision.apply ? 'auto_applied' : 'pending',
      fingerprint,
      revert_until: s.revertUntil,
      follow_ups: s.followUps,
    },
    201,
  )
})

type ProposalStatus = (typeof proposalStatuses)[number]
const isProposalStatus = (v: string): v is ProposalStatus =>
  (proposalStatuses as readonly string[]).includes(v)

// 提案の一覧。request_id があればそのリクエストの提案、無ければこのトークンが作った提案だけ。
// status はカンマ区切り（省略は全状態）。古い順、after（前の頁の next）で続き
apiAgent.get('/proposals', requireScope('proposal:write'), async (c) => {
  // キーが無いときだけ自分の一覧。キーがあって空・空白だけは取り違えなので 400
  const rawRequestId = c.req.query('request_id')
  const requestId = rawRequestId?.trim()
  if (rawRequestId !== undefined && !requestId) {
    return c.json({ error: 'invalid_request_id' }, 400)
  }
  const raw = c.req.query('status')
  const statuses = raw === undefined ? null : raw.split(',').map((s) => s.trim())
  if (statuses && !statuses.every(isProposalStatus)) {
    return c.json({ error: 'invalid_status' }, 400)
  }
  const after = c.req.query('after') || null
  const limit = limitOf(c.req.query('limit'), PROPOSALS_LIMIT)
  const r = await listAgentProposals(
    c.get('db'),
    requestId ? { requestId } : { tokenId: currentAgent(c).id },
    statuses ? [...new Set(statuses as ProposalStatus[])] : null,
    after,
    limit,
  )
  if (r === 'invalid_after') return c.json({ error: 'invalid_after' }, 400)
  return c.json(r)
})

apiAgent.get('/proposals/:id', requireScope('proposal:write'), async (c) => {
  const p = await getProposalWithFields(c.get('db'), c.req.param('id'))
  if (!p) return c.json({ error: 'not_found' }, 404)
  return c.json(p)
})

// 定義していない API は全部禁止（記録系の名前でも 403）
apiAgent.all('*', (c) => c.json({ error: 'forbidden' }, 403))

export default apiAgent
