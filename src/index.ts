import { Hono } from 'hono'
import ui from './routes/ui'

export type Bindings = {
  DB: D1Database
  // "1" のときだけ部品見本 GET /_ui を有効にする
  UI_GALLERY?: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
  return c.json({ ok: true, db: row?.one === 1 })
})

app.route('/', ui)

export default app
