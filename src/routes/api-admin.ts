// オーナー用の JSON API（/api/admin/*）。非オーナーには JSON の 404 を返す

import { Hono } from 'hono'
import { requireOwnerApi } from '../auth/middleware'
import { findCandidates } from '../db/match'
import type { AppEnv } from '../env'
import { normalizeMatchUrl } from '../lib/match'

// 名前・題名の上限（コードポイント）。マスタの入力上限と同じ
const NAME_MAX = 200

const apiAdmin = new Hono<AppEnv>({ strict: false })

// 404 も含めて全応答を no-store にする
apiAdmin.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})
apiAdmin.use('*', requireOwnerApi)

// 名寄せ候補（docs/data-model.md §5）。title か url のどちらかが要る
apiAdmin.get('/match', async (c) => {
  const title = c.req.query('title')?.trim() ?? ''
  const org = c.req.query('org')?.trim() ?? ''
  const url = c.req.query('url')?.trim() ?? ''
  if (!title && !url) return c.json({ error: 'title_or_url_required' }, 400)
  if ([...title].length > NAME_MAX) return c.json({ error: 'title_too_long' }, 400)
  if ([...org].length > NAME_MAX) return c.json({ error: 'org_too_long' }, 400)
  if (url && !normalizeMatchUrl(url)) return c.json({ error: 'invalid_url' }, 400)
  return c.json(await findCandidates(c.get('db'), { title, org, url }))
})

export default apiAdmin
