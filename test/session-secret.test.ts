import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index'

describe('SESSION_SECRET の検査', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['未設定', ''],
    ['32 文字未満', 'x'.repeat(31)],
  ])('%s なら 500、/healthz は影響しない', async (_, secret) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const e = { ...env, SESSION_SECRET: secret }
    const res = await app.request('/works', {}, e)
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('SESSION_SECRET が未設定か短すぎます')
    expect(error).toHaveBeenCalled()
    expect((await app.request('/healthz', {}, e)).status).toBe(200)
  })

  it('32 文字ちょうどなら通る', async () => {
    const res = await app.request('/works', {}, { ...env, SESSION_SECRET: 'x'.repeat(32) })
    expect(res.status).toBe(200)
  })
})
