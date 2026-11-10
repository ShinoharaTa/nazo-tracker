import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { ORIGIN } from './helpers/auth'

const on = { ...env, AUTH_DEV_LOGIN: '1' }

const post = (subject: string, e: Cloudflare.Env = on, extra: Record<string, string> = {}) =>
  app.request(
    '/_dev/login',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...extra,
      },
      body: new URLSearchParams({ subject }).toString(),
    },
    e,
  )

describe('仮ログイン /_dev/login', () => {
  it('wrangler.toml の既定値は "0" で 404', async () => {
    expect(env.AUTH_DEV_LOGIN).toBe('0')
    expect((await app.request('/_dev/login', {}, env)).status).toBe(404)
    expect((await post('owner', env)).status).toBe(404)
  })

  it('AUTH_DEV_LOGIN 未設定なら 404', async () => {
    const e = { ...env, AUTH_DEV_LOGIN: undefined }
    expect((await app.request('/_dev/login', {}, e)).status).toBe(404)
  })

  it('"1" でも APP_ORIGIN が本番なら 404', async () => {
    const e = { ...on, APP_ORIGIN: 'https://nazo.shino3.net' }
    expect((await app.request('/_dev/login', {}, e)).status).toBe(404)
    const res = await post('owner', e, { Origin: 'https://nazo.shino3.net' })
    expect(res.status).toBe(404)
  })

  it('"1" でも Host が nazo.shino3.net なら 404', async () => {
    const res = await app.request('/_dev/login', { headers: { Host: 'nazo.shino3.net' } }, on)
    expect(res.status).toBe(404)
    expect((await post('owner', on, { Host: 'nazo.shino3.net' })).status).toBe(404)
  })

  it('ガードを通れば GET はフォームを返す', async () => {
    const res = await app.request('/_dev/login', { headers: { Host: '127.0.0.1:8787' } }, on)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('action="/_dev/login"')
    expect(html).toContain('value="owner"')
  })

  it('Host: localhost:8787 でも通る', async () => {
    const res = await post('viahost', on, { Host: 'localhost:8787' })
    expect(res.status).toBe(302)
  })

  describe('AUTH_DEV_HOSTS', () => {
    const LAN = 'http://10.1.111.70:8787'
    const lan = { ...on, APP_ORIGIN: LAN, AUTH_DEV_HOSTS: ' 10.1.111.70 , ' }

    it('wrangler.toml の既定値は空', () => {
      expect(env.AUTH_DEV_HOSTS).toBe('')
    })

    it('許可した IP で APP_ORIGIN も同じ IP なら有効（ポート付き Host も通る）', async () => {
      const res = await app.request('/_dev/login', { headers: { Host: '10.1.111.70:8787' } }, lan)
      expect(res.status).toBe(200)
      const posted = await post('lanuser', lan, { Origin: LAN, Host: '10.1.111.70:8787' })
      expect(posted.status).toBe(302)
    })

    it('Host が許可外なら 404', async () => {
      const res = await app.request('/_dev/login', { headers: { Host: '10.1.111.71:8787' } }, lan)
      expect(res.status).toBe(404)
    })

    it('APP_ORIGIN が許可外なら 404', async () => {
      const e = { ...lan, APP_ORIGIN: 'http://10.1.111.71:8787' }
      const res = await app.request('/_dev/login', { headers: { Host: '10.1.111.70:8787' } }, e)
      expect(res.status).toBe(404)
    })

    it('公開 IP は AUTH_DEV_HOSTS に入れても無視して 404', async () => {
      const e = { ...on, APP_ORIGIN: 'http://8.8.8.8:8787', AUTH_DEV_HOSTS: '8.8.8.8' }
      const res = await app.request('/_dev/login', { headers: { Host: '8.8.8.8:8787' } }, e)
      expect(res.status).toBe(404)
    })

    it.each(['172.15.0.1', '172.32.0.1', '192.169.0.1', 'nazo.shino3.net'])(
      'プライベート IPv4 以外 %s は無視して 404',
      async (h) => {
        const e = { ...on, APP_ORIGIN: `http://${h}:8787`, AUTH_DEV_HOSTS: h }
        const res = await app.request('/_dev/login', { headers: { Host: `${h}:8787` } }, e)
        expect(res.status).toBe(404)
      },
    )

    it.each(['10.1.111.700', '10.1.111', '10.1.111.70.1', '10.1.111.70:8787', '010.1.111.70'])(
      '不正な形式 %s は無視する',
      async (h) => {
        const e = { ...on, APP_ORIGIN: LAN, AUTH_DEV_HOSTS: h }
        const res = await app.request('/_dev/login', { headers: { Host: '10.1.111.70:8787' } }, e)
        expect(res.status).toBe(404)
      },
    )

    it('172.16.0.0/12・192.168.0.0/16 も採用する', async () => {
      for (const h of ['172.16.0.1', '172.31.255.255', '192.168.0.10']) {
        const e = { ...on, APP_ORIGIN: `http://${h}:8787`, AUTH_DEV_HOSTS: `8.8.8.8,${h}` }
        const res = await app.request('/_dev/login', { headers: { Host: `${h}:8787` } }, e)
        expect(res.status).toBe(200)
      }
    })

    it('AUTH_DEV_HOSTS があっても 127.0.0.1 は引き続き通る', async () => {
      const e = { ...on, AUTH_DEV_HOSTS: '10.1.111.70' }
      const res = await app.request('/_dev/login', { headers: { Host: '127.0.0.1:8787' } }, e)
      expect(res.status).toBe(200)
    })
  })

  it.each(['', ' ', 'a b', 'あ', 'x'.repeat(33), 'a/b'])('subject %j は 400', async (s) => {
    expect((await post(s)).status).toBe(400)
  })

  it('前後の空白は trim して受け付ける', async () => {
    const res = await post('  trimmed  ')
    expect(res.status).toBe(302)
    const row = await env.DB.prepare(
      "SELECT subject FROM identity WHERE provider = 'dev' AND subject = 'trimmed'",
    ).first()
    expect(row).not.toBeNull()
  })

  it('OWNER_IDENTITIES は完全一致のみ', async () => {
    await post('Partial', { ...on, OWNER_IDENTITIES: 'dev:partial, dev:Partia' })
    const row = await env.DB.prepare(
      "SELECT u.role FROM identity i JOIN user u ON u.id = i.user_id WHERE i.provider = 'dev' AND i.subject = 'Partial'",
    ).first<{ role: string }>()
    expect(row?.role).toBe('member')

    await post('spaced', { ...on, OWNER_IDENTITIES: 'dev:other , dev:spaced ' })
    const row2 = await env.DB.prepare(
      "SELECT u.role FROM identity i JOIN user u ON u.id = i.user_id WHERE i.provider = 'dev' AND i.subject = 'spaced'",
    ).first<{ role: string }>()
    expect(row2?.role).toBe('owner')
  })

  it('新規 user は表示名「ななしさん」・ULID の id', async () => {
    await post('fresh')
    const row = await env.DB.prepare(
      "SELECT u.id, u.display_name, u.last_seen_at, i.last_login_at FROM identity i JOIN user u ON u.id = i.user_id WHERE i.provider = 'dev' AND i.subject = 'fresh'",
    ).first<{ id: string; display_name: string; last_seen_at: string; last_login_at: string }>()
    expect(row?.display_name).toBe('ななしさん')
    expect(row?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(row?.last_seen_at).toBeTruthy()
    expect(row?.last_login_at).toBeTruthy()
  })

  it('ログイン時に期限切れの session_token / oauth_state を掃除する', async () => {
    await post('sweeper')
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const { id } = (await env.DB.prepare(
      "SELECT user_id AS id FROM identity WHERE provider = 'dev' AND subject = 'sweeper'",
    ).first<{ id: string }>()) as { id: string }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO session_token (id, user_id, expires_at, created_at) VALUES ('old', ?, ?, ?)",
      ).bind(id, past, past),
      env.DB.prepare(
        "INSERT INTO oauth_state (state, provider, code_verifier, mode, expires_at) VALUES ('old', 'google', 'v', 'login', ?)",
      ).bind(past),
    ])
    await post('sweeper')
    expect(await env.DB.prepare("SELECT 1 FROM session_token WHERE id = 'old'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT 1 FROM oauth_state WHERE state = 'old'").first()).toBeNull()
  })

  it('User-Agent の先頭 120 文字を ua_hint に入れる', async () => {
    await post('ua', on, { 'User-Agent': 'x'.repeat(200) })
    const row = await env.DB.prepare(
      "SELECT s.ua_hint FROM session_token s JOIN identity i ON i.user_id = s.user_id WHERE i.provider = 'dev' AND i.subject = 'ua'",
    ).first<{ ua_hint: string }>()
    expect(row?.ua_hint).toBe('x'.repeat(120))
  })
})
