// HTML の応答の CSP（#150 PR 6）。img-src だけを付け、host は IMAGE_HOSTS から作る
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { IMAGE_HOSTS, IMG_SRC_CSP } from '../src/lib/image-url'
import { loginAs } from './helpers/auth'
import { insertWork } from './helpers/master'

const get = (path: string, cookie?: string) =>
  app.request(path, cookie ? { headers: { Cookie: cookie } } : {}, env)

let workId: string
let member: string
let owner: string

beforeAll(async () => {
  workId = await insertWork(env, { title: 'CSP の作品' })
  member = (await loginAs(env, { subject: 'csp-member' })).cookie
  owner = (await loginAs(env, { subject: 'csp-owner', owner: true })).cookie
})

describe('IMG_SRC_CSP', () => {
  it("img-src だけで、'self' と IMAGE_HOSTS の host を https で並べる", () => {
    expect(IMG_SRC_CSP).toBe("img-src 'self' https://static.escape.id")
    for (const h of IMAGE_HOSTS) expect(IMG_SRC_CSP).toContain(`https://${h.host}`)
    expect(IMG_SRC_CSP).not.toMatch(/default-src|script-src|style-src|;/)
  })
})

describe('HTML の応答に CSP が付く', () => {
  const cases: [string, () => string, () => string | undefined][] = [
    ['/works', () => '/works', () => undefined],
    ['作品詳細', () => `/works/${workId}`, () => undefined],
    ['/login', () => '/login', () => undefined],
    ['/about', () => '/about', () => undefined],
    ['ログイン後の /records', () => '/records', () => member],
    ['管理画面 /admin', () => '/admin', () => owner],
    ['承認画面 /admin/proposals', () => '/admin/proposals', () => owner],
  ]
  for (const [name, path, cookie] of cases) {
    it(name, async () => {
      const res = await get(path(), cookie())
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
      expect(res.headers.get('Content-Security-Policy')).toBe(IMG_SRC_CSP)
    })
  }
})

describe('JSON の応答には付けない', () => {
  it('/healthz', async () => {
    const res = await get('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: true })
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })

  it('/api/agent（トークンなし）', async () => {
    const res = await get('/api/agent/requests')
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})
