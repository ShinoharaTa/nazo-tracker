// HTML の応答の CSP（#150 PR 6）。img-src だけを付け、host は IMAGE_HOSTS から作る
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { IMAGE_HOSTS, IMG_SRC_CSP } from '../src/lib/image-url'
import { randomCode } from '../src/lib/random'
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
    const hosts = IMAGE_HOSTS.map((h) => `https://${h.host}`)
    expect(IMG_SRC_CSP).toBe(["img-src 'self'", ...hosts].join(' '))
  })
})

describe('HTML の応答に CSP が付く', () => {
  const cases: [string, () => string, () => string | undefined, number][] = [
    ['/works', () => '/works', () => undefined, 200],
    ['作品詳細', () => `/works/${workId}`, () => undefined, 200],
    ['/login', () => '/login', () => undefined, 200],
    ['/about', () => '/about', () => undefined, 200],
    ['ログイン後の /records', () => '/records', () => member, 200],
    ['管理画面 /admin', () => '/admin', () => owner, 200],
    ['承認画面 /admin/proposals', () => '/admin/proposals', () => owner, 200],
    ['管理画面の 404（存在しない作品）', () => `/admin/works/${ulid()}`, () => owner, 404],
  ]
  for (const [name, path, cookie, status] of cases) {
    it(name, async () => {
      const res = await get(path(), cookie())
      expect(res.status).toBe(status)
      expect(res.headers.get('Content-Type')).toMatch(/^text\/html/)
      expect(res.headers.get('Content-Security-Policy')).toBe(IMG_SRC_CSP)
    })
  }

  it('招待リンク /f/<code> は Referrer-Policy と CSP の両方', async () => {
    const res = await get(`/f/${randomCode(16)}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Content-Security-Policy')).toBe(IMG_SRC_CSP)
  })
})

describe('HTML 以外の応答には付けない', () => {
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

  it('未ログインの /records（302）', async () => {
    const res = await get('/records')
    expect(res.status).toBe(302)
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})
