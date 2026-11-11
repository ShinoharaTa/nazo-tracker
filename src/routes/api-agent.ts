// agent 用の JSON API（/api/agent/*、docs/agent-pipeline.md §5）。Bearer のトークンだけで認証し、cookie は見ない。
// src/index.ts で csrf / attachUser より前に登録する。定義していないパスは認証後に全部 403。

import { Hono } from 'hono'
import { currentAgent, requireAgent } from '../auth/agent'
import type { AppEnv } from '../env'

// 本文の上限（バイト）
const BODY_MAX = 64 * 1024

const apiAgent = new Hono<AppEnv>({ strict: false })

// 401 / 403 も含めて全応答を no-store にする
apiAgent.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})
apiAgent.use('*', requireAgent)

// 本文を持ちうるメソッドは JSON の本文だけ。ここで一度読んで検査し、各ハンドラは c.req.json() で受け取る
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
apiAgent.use('*', async (c, next) => {
  if (!BODY_METHODS.includes(c.req.method)) return next()
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

// 定義していない API は全部禁止（記録系の名前でも 403）
apiAgent.all('*', (c) => c.json({ error: 'forbidden' }, 403))

export default apiAgent
