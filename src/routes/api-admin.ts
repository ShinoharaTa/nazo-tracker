// オーナー用の JSON API（/api/admin/*）。非オーナーには JSON の 404 を返す

import { Hono } from 'hono'
import { requireOwnerApi } from '../auth/middleware'
import type { AppEnv } from '../env'
import { matchHandler } from './match-handler'

const apiAdmin = new Hono<AppEnv>({ strict: false })

// 404 も含めて全応答を no-store にする
apiAdmin.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'no-store')
})
apiAdmin.use('*', requireOwnerApi)

// 名寄せ候補（docs/data-model.md §5）。処理は /api/agent/match と共用
apiAdmin.get('/match', matchHandler)

export default apiAdmin
