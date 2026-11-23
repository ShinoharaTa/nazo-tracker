// agent トークン（Bearer）の認証（docs/auth.md §6、docs/agent-pipeline.md §5）。
// /api/agent/* だけが Bearer を受け、cookie・c.get('user') は一切見ない。それ以外のルートへの Authorization は 403。

import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { createDb } from '../db/client'
import { type ActiveToken, findActiveToken, hashToken, touchToken } from '../db/tokens'
import type { AppEnv } from '../env'

// last_used_at はこれより古いときだけ書き直す
const TOUCH_MS = 3_600_000

const isAgentPath = (path: string) => path === '/api/agent' || path.startsWith('/api/agent/')

// 「Bearer 」で始まる Authorization（スキーム名は大文字小文字を区別しない）の残り。無ければ null
const bearerOf = (header: string | undefined): string | null =>
  header && /^bearer /i.test(header) ? header.slice(7).trim() : null

// /api/agent 以外に Authorization が来たら、形式（Bearer / Basic / 崩れた値）にも有効性にも関係なく 403。
// 記録系・オーナー画面へ agent を通さない（このアプリの他のルートは Authorization を使わない）
export const rejectBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAgentPath(c.req.path) && c.req.header('Authorization') !== undefined) {
    return c.json({ error: 'agent_token_not_allowed' }, 403)
  }
  await next()
})

// 無い・失効・期限切れ・role 違いは理由を区別せず同じ 401
export const requireAgent = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerOf(c.req.header('Authorization'))
  const db = createDb(c.env.DB)
  const row = token ? await findActiveToken(db, await hashToken(token)) : null
  if (!row) {
    c.header('WWW-Authenticate', 'Bearer')
    return c.json({ error: 'invalid_token' }, 401)
  }
  if (!row.lastUsedAt || Date.parse(row.lastUsedAt) < Date.now() - TOUCH_MS) {
    await touchToken(db, row.id)
  }
  c.set('db', db)
  c.set('agentToken', row)
  await next()
})

// requireAgent を通したルートで、認証済みのトークンを取り出す
export const currentAgent = (c: Context<AppEnv>): ActiveToken => {
  const t = c.get('agentToken')
  if (!t) throw new Error('requireAgent を通していないルートで currentAgent が呼ばれた')
  return t
}

// トークンの scopes_json（JSON の文字列配列）に name が無ければ 403。NULL・壊れた JSON・配列でないものは全部拒否。
// requireAgent の後ろに置く
const hasScope = (json: string | null, name: string): boolean => {
  if (json === null) return false
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return false
  }
  return Array.isArray(v) && v.includes(name)
}

export const requireScope = (name: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!hasScope(currentAgent(c).scopesJson, name)) {
      return c.json({ error: 'insufficient_scope', required: name }, 403)
    }
    await next()
  })
