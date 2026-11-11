// agent トークン（Bearer）の認証（docs/auth.md §6、docs/agent-pipeline.md §5）。
// /api/agent/* だけが Bearer を受け、cookie・c.get('user') は一切見ない。それ以外のルートへの Bearer は 403。

import { createMiddleware } from 'hono/factory'
import { createDb } from '../db/client'
import { findActiveToken, hashToken, touchToken } from '../db/tokens'
import type { AppEnv } from '../env'

// last_used_at はこれより古いときだけ書き直す
const TOUCH_MS = 3_600_000

const isAgentPath = (path: string) => path === '/api/agent' || path.startsWith('/api/agent/')

// 「Bearer 」で始まる Authorization（スキーム名は大文字小文字を区別しない）の残り。無ければ null
const bearerOf = (header: string | undefined): string | null =>
  header && /^bearer /i.test(header) ? header.slice(7).trim() : null

// /api/agent 以外に Bearer が来たら 403。トークンの有効性は見ない（記録系・オーナー画面へ agent を通さない）
export const rejectBearer = createMiddleware<AppEnv>(async (c, next) => {
  if (!isAgentPath(c.req.path) && bearerOf(c.req.header('Authorization')) !== null) {
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
  c.set('agentTokenId', row.id)
  await next()
})
