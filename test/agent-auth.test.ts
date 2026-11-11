import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env)

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

const postForm = (path: string, form: Record<string, string>, cookie: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: new URLSearchParams(form).toString(),
    },
    env,
  )

type TokenDbRow = {
  id: string
  name: string
  token_hash: string
  role: string
  scopes_json: string
  expires_at: string
  last_used_at: string | null
  revoked_at: string | null
}

const tokenRow = (name: string) =>
  env.DB.prepare('SELECT * FROM api_token WHERE name = ?').bind(name).first<TokenDbRow>()

let ownerCookie = ''

// 画面から発行し、表示された平文を返す
const issue = async (name: string, days = '90') => {
  const res = await postForm('/admin/tokens', { name, days }, ownerCookie)
  expect(res.status).toBe(200)
  const token = /nzt_[A-Za-z0-9_-]{43}/.exec(await res.text())?.[0]
  if (!token) throw new Error('平文が表示されていない')
  return { token, res }
}

beforeAll(async () => {
  ownerCookie = (await loginAs(env, { subject: 'agent-owner', owner: true })).cookie
})

describe('トークンの発行', () => {
  it('平文はその場で 1 回だけ表示し、D1 にはハッシュだけを置く', async () => {
    const { token, res } = await issue('cli-1')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const row = await tokenRow('cli-1')
    expect(row?.role).toBe('agent')
    expect(JSON.parse(row?.scopes_json ?? '')).toEqual([
      'master:read',
      'request:rw',
      'source:write',
      'proposal:write',
    ])
    expect(row?.token_hash).not.toBe(token)
    const all = JSON.stringify((await env.DB.prepare('SELECT * FROM api_token').all()).results)
    expect(all).not.toContain(token)
    expect(all).not.toContain(token.slice(4))
    // 一覧には平文を出さない
    const list = await get('/admin/tokens', { Cookie: ownerCookie })
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toContain('no-store')
    const html = await list.text()
    expect(html).toContain('cli-1')
    expect(html).not.toContain(token)
  })

  it('期限は選んだ日数', async () => {
    await issue('cli-30', '30')
    const row = await tokenRow('cli-30')
    const days = (Date.parse(row?.expires_at ?? '') - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('名前が空・期限が選択肢外は 400 で作らない', async () => {
    const res = await postForm('/admin/tokens', { name: '', days: '90' }, ownerCookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('名前を入力してください。')
    const res2 = await postForm('/admin/tokens', { name: 'bad-days', days: '365' }, ownerCookie)
    expect(res2.status).toBe(400)
    expect(await tokenRow('bad-days')).toBeNull()
  })

  it('member が /admin/tokens は 404', async () => {
    const { cookie } = await loginAs(env, { subject: 'agent-member' })
    expect((await get('/admin/tokens', { Cookie: cookie })).status).toBe(404)
    expect((await postForm('/admin/tokens', { name: 'm', days: '90' }, cookie)).status).toBe(404)
  })
})

describe('requireAgent', () => {
  it('発行したトークンで whoami が 200', async () => {
    const { token } = await issue('who')
    const res = await get('/api/agent/whoami', bearer(token))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const row = await tokenRow('who')
    expect(await res.json()).toEqual({
      token_id: row?.id,
      name: 'who',
      expires_at: row?.expires_at,
    })
    // スキーム名は大文字小文字を区別しない
    expect((await get('/api/agent/whoami', { Authorization: `bearer ${token}` })).status).toBe(200)
  })

  it('失効・期限切れ・でたらめ・ヘッダ無しは同じ 401', async () => {
    const revoked = await issue('revoked')
    const id = (await tokenRow('revoked'))?.id ?? ''
    const r = await postForm(`/admin/tokens/${id}/revoke`, {}, ownerCookie)
    expect(r.status).toBe(302)
    expect((await tokenRow('revoked'))?.revoked_at).not.toBeNull()

    const expired = await issue('expired')
    await env.DB.prepare('UPDATE api_token SET expires_at = ? WHERE name = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), 'expired')
      .run()

    const cases: Record<string, string>[] = [
      bearer(revoked.token),
      bearer(expired.token),
      bearer('nzt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      {},
      { Authorization: revoked.token },
    ]
    for (const h of cases) {
      const res = await get('/api/agent/whoami', h)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ error: 'invalid_token' })
    }
    // 一覧の状態
    const html = await (await get('/admin/tokens', { Cookie: ownerCookie })).text()
    expect(html).toContain('失効')
    expect(html).toContain('期限切れ')
  })

  it('cookie でログインしたオーナーでも /api/agent は 401', async () => {
    const res = await get('/api/agent/whoami', { Cookie: ownerCookie })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_token' })
  })

  it('無いトークンを失効しようとすると 404', async () => {
    expect((await postForm('/admin/tokens/nope/revoke', {}, ownerCookie)).status).toBe(404)
  })

  it('last_used_at が入り、1 時間以内の 2 回目は変わらない', async () => {
    const { token } = await issue('touch')
    expect((await tokenRow('touch'))?.last_used_at).toBeNull()
    await get('/api/agent/whoami', bearer(token))
    const first = (await tokenRow('touch'))?.last_used_at
    expect(first).toBeTruthy()
    await get('/api/agent/whoami', bearer(token))
    expect((await tokenRow('touch'))?.last_used_at).toBe(first)

    const old = new Date(Date.now() - 2 * 3_600_000).toISOString()
    await env.DB.prepare('UPDATE api_token SET last_used_at = ? WHERE name = ?')
      .bind(old, 'touch')
      .run()
    await get('/api/agent/whoami', bearer(token))
    expect((await tokenRow('touch'))?.last_used_at).not.toBe(old)
  })
})

describe('agent トークンで使えないルート', () => {
  let token = ''
  beforeAll(async () => {
    token = (await issue('deny')).token
  })

  it('/api/agent 以外は 403 agent_token_not_allowed', async () => {
    for (const path of [
      '/records',
      '/records/01HZZZZZZZZZZZZZZZZZZZZZZZ/spoiler',
      '/stats',
      '/settings/counts',
      '/admin',
      '/admin/tokens',
      '/api/admin/match?title=x',
      '/works',
      '/api/agentx',
    ]) {
      const res = await get(path, bearer(token))
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'agent_token_not_allowed' })
    }
    // 有効性も形式も見ない（でたらめ・タブ区切り・Bearer だけ・Basic でも 403）
    for (const auth of [
      'Bearer garbage',
      `Bearer\t${token}`,
      'Bearer',
      'Basic dXNlcjpwYXNz',
      token,
    ]) {
      const res = await get('/records', { Authorization: auth })
      expect(res.status, auth).toBe(403)
      expect(await res.json()).toEqual({ error: 'agent_token_not_allowed' })
    }
  })

  it('/api/agent の未定義パスは 403 forbidden', async () => {
    for (const path of ['/api/agent', '/api/agent/attempts', '/api/agent/me/stats']) {
      const res = await get(path, bearer(token))
      expect(res.status, path).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    }
  })

  it('POST の本文は JSON だけ・64 KiB まで・壊れた JSON は 400', async () => {
    const post = (body: string, type: string) =>
      app.request(
        '/api/agent/whoami',
        { method: 'POST', headers: { ...bearer(token), 'Content-Type': type }, body },
        env,
      )
    const t = await post('hi', 'text/plain')
    expect(t.status).toBe(415)
    expect(await t.json()).toEqual({ error: 'unsupported_media_type' })
    const big = await post(JSON.stringify({ a: 'x'.repeat(65 * 1024) }), 'application/json')
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ error: 'too_large' })
    const bad = await post('{', 'application/json')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_json' })
    // 通った本文は未定義の POST なので 403
    expect((await post('{}', 'application/json; charset=utf-8')).status).toBe(403)
  })

  it('PUT / DELETE も本文の検査を通す', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const req = (headers: Record<string, string>, body?: string) =>
        app.request(
          '/api/agent/whoami',
          { method, headers: { ...bearer(token), ...headers }, body },
          env,
        )
      const noType = await req({})
      expect(noType.status, method).toBe(415)
      expect(await noType.json()).toEqual({ error: 'unsupported_media_type' })
      expect((await req({ 'Content-Type': 'application/json' }, '{')).status, method).toBe(400)
      expect((await req({ 'Content-Type': 'application/json' }, '{}')).status, method).toBe(403)
    }
  })
})
