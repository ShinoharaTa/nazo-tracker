// agent 用の JSON API（/api/agent/*、docs/agent-pipeline.md §5）。Bearer のトークンだけで認証し、cookie は見ない。
// src/index.ts で csrf / attachUser より前に登録する。定義していないパスは認証後に全部 403。

import { type Context, Hono } from 'hono'
import { currentAgent, requireAgent, requireScope } from '../auth/agent'
import {
  type AgentIndexPart,
  type AgentIndexTable,
  type AgentRowTable,
  agentIndexTables,
  agentRowTables,
  getAgentRow,
  listAgentIndex,
} from '../db/master'
import {
  getAgentRequest,
  listAgentRequests,
  type OwnRequest,
  setRequestStatus,
} from '../db/requests'
import { requestStatuses } from '../db/schema'
import type { AppEnv } from '../env'
import { canTransition } from '../requests/transitions'
import type { RequestStatus } from '../ui/labels'
import { matchHandler } from './match-handler'

// 本文の上限（バイト）
const BODY_MAX = 64 * 1024
// 一覧の件数（既定・上限）。範囲外・数でない値は既定か上限に寄せる
const REQUESTS_LIMIT = { def: 50, max: 100 }
const INDEX_LIMIT = { def: 1000, max: 1000 }
// 質問はオーナーの質問と同じ上限、メモは依頼者のメモと同じ上限（コードポイント）
const QUESTION_MAX = 1000
const NOTE_MAX = 2000

const apiAgent = new Hono<AppEnv>({ strict: false })

// 401 / 403 も含めて全応答を no-store にする
apiAgent.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
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

// 定義していない API は全部禁止（記録系の名前でも 403）
apiAgent.all('*', (c) => c.json({ error: 'forbidden' }, 403))

export default apiAgent
