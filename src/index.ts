import { Hono } from 'hono'
import ui from './routes/ui'

export type Bindings = {
  DB: D1Database
  // "1" のときだけ部品見本 GET /_ui を有効にする
  UI_GALLERY?: string
}

// strict: false で末尾スラッシュ付き（/records/ など）も同じルートとして扱う。ui 側も同じ設定
const app = new Hono<{ Bindings: Bindings }>({ strict: false })

app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
  return c.json({ ok: true, db: row?.one === 1 })
})

app.route('/', ui)

export default app
