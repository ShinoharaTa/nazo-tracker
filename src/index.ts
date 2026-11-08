import { Hono } from 'hono'

export type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS one').first<{ one: number }>()
  return c.json({ ok: true, db: row?.one === 1 })
})

export default app
