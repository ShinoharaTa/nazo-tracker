import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { rejectBearer } from './auth/agent'
import { attachUser } from './auth/middleware'
import type { AppEnv } from './env'
import { IMG_SRC_CSP } from './lib/image-url'
import admin from './routes/admin'
import apiAdmin from './routes/api-admin'
import apiAgent from './routes/api-agent'
import auth from './routes/auth'
import dev from './routes/dev'
import friends from './routes/friends'
import gallery from './routes/gallery'
import records from './routes/records'
import requests from './routes/requests'
import ui from './routes/ui'

// strict: false で末尾スラッシュ付き（/records/ など）も同じルートとして扱う。サブアプリ側も同じ設定
const app = new Hono<AppEnv>({ strict: false })

// HTML の応答すべてに CSP（img-src だけ）を付ける。JSON・リダイレクト・静的アセット（[assets] が Worker より先に返す）には付けない
app.use('*', async (c, next) => {
  await next()
  if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
    c.res.headers.set('Content-Security-Policy', IMG_SRC_CSP)
  }
})

// 疎通確認。SESSION_SECRET の検査（attachUser）より前に置き、設定不備でも D1 の疎通を見られるようにする
app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
  return c.json({ ok: true, db: row?.one === 1 })
})

// agent トークン（Bearer）は /api/agent だけで受け、それ以外は 403。/api/agent は cookie を見ないので
// csrf / attachUser より前に置く（中の catch-all が全パスに応答し、後ろの middleware へは落ちない）
app.use('*', rejectBearer)
app.route('/api/agent', apiAgent)

// 安全メソッド以外は Origin が APP_ORIGIN か Sec-Fetch-Site: same-origin のときだけ通す
app.use('*', csrf({ origin: (origin, c) => origin === c.env.APP_ORIGIN }))
app.use('*', attachUser)

// 部品見本。UI_GALLERY="1" でなければ /_ui 以下はすべて 404。判定はここ 1 か所
app.use('/_ui/*', async (c, next) => {
  if (c.env.UI_GALLERY !== '1') return c.notFound()
  await next()
})
app.route('/_ui', gallery)

app.route('/_dev', dev)
app.route('/auth', auth)
app.route('/admin', admin)
app.route('/api/admin', apiAdmin)
app.route('/records', records)
app.route('/requests', requests)
// /settings/friends を ui の /settings/* より先に解決させる
app.route('/', friends)
app.route('/', ui)

export default app
