import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { attachUser, requireOwner } from '../src/auth/middleware'
import type { AppEnv } from '../src/env'
import { loginAs } from './helpers/auth'

// テスト専用の小さなアプリ。本体の app には requireOwner のルートがまだ無い
const owned = new Hono<AppEnv>()
owned.use('*', attachUser)
owned.get('/owner-only', requireOwner, (c) => c.text('ok'))

const get = (cookie?: string) =>
  owned.request('/owner-only', { headers: cookie ? { Cookie: cookie } : {} }, env)

describe('requireOwner', () => {
  it('未ログインの GET は 302 /login', async () => {
    const res = await get()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('member は 404', async () => {
    const { cookie } = await loginAs(env, { subject: 'ro-member' })
    expect((await get(cookie)).status).toBe(404)
  })

  it('owner は 200', async () => {
    const { cookie } = await loginAs(env, { subject: 'ro-owner', owner: true })
    const res = await get(cookie)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
