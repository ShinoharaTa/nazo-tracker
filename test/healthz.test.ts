import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('GET /healthz', () => {
  it('200 で ok と D1 の疎通結果を返す', async () => {
    const res = await app.request('/healthz', {}, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true })
  })

  it('マイグレーション適用済みの D1 にテーブルがある', async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempt'",
    ).first<{ name: string }>()
    expect(row?.name).toBe('attempt')
  })
})
