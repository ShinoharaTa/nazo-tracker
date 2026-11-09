import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { attachUser } from './auth/middleware'
import type { AppEnv } from './env'
import apiAdmin from './routes/api-admin'
import auth from './routes/auth'
import dev from './routes/dev'
import gallery from './routes/gallery'
import ui from './routes/ui'

// strict: false で末尾スラッシュ付き（/records/ など）も同じルートとして扱う。サブアプリ側も同じ設定
const app = new Hono<AppEnv>({ strict: false })

// 疎通確認。SESSION_SECRET の検査（attachUser）より前に置き、設定不備でも D1 の疎通を見られるようにする
app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
  return c.json({ ok: true, db: row?.one === 1 })
})

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
app.route('/api/admin', apiAdmin)
app.route('/', ui)

export default app
