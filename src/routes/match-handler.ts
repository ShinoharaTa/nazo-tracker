// 名寄せ候補の JSON 応答（docs/data-model.md §5）。/api/admin/match と /api/agent/match が共用する。
// 認可は呼び出し側のサブアプリ（requireOwnerApi / requireAgent + requireScope）で済ませておく

import type { Context } from 'hono'
import { findCandidates } from '../db/match'
import type { AppEnv } from '../env'
import { normalizeMatchUrl } from '../lib/match'

// 名前・題名の上限（コードポイント）。マスタの入力上限と同じ
const NAME_MAX = 200

// title か url のどちらかが要る
export const matchHandler = async (c: Context<AppEnv>) => {
  const title = c.req.query('title')?.trim() ?? ''
  const org = c.req.query('org')?.trim() ?? ''
  const url = c.req.query('url')?.trim() ?? ''
  if (!title && !url) return c.json({ error: 'title_or_url_required' }, 400)
  if ([...title].length > NAME_MAX) return c.json({ error: 'title_too_long' }, 400)
  if ([...org].length > NAME_MAX) return c.json({ error: 'org_too_long' }, 400)
  if (url && !normalizeMatchUrl(url)) return c.json({ error: 'invalid_url' }, 400)
  return c.json(await findCandidates(c.get('db'), { title, org, url }))
}
