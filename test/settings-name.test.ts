import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (displayName: string, cookie?: string) =>
  app.request(
    '/settings/name',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams({ displayName }).toString(),
    },
    env,
  )

const displayNameOf = (userId: string) =>
  env.DB.prepare('SELECT display_name FROM user WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string }>()
    .then((r) => r?.display_name)

describe('GET /settings/name', () => {
  it('未ログインは 302 /login', async () => {
    const res = await get('/settings/name')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('現在の表示名がフォームに入る。welcome=1 のときだけ案内を出す', async () => {
    const { cookie } = await loginAs(env, { subject: 'sn-get' })
    const res = await get('/settings/name', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('name="displayName"')
    expect(html).toContain('value="ななしさん"')
    expect(html).not.toContain('はじめに表示名を決めてください')
    const welcome = await (await get('/settings/name?welcome=1', cookie)).text()
    expect(welcome).toContain('はじめに表示名を決めてください（あとで変えられます）')
  })

  it('/settings の「表示名を変える」は /settings/name へのリンク', async () => {
    const { cookie } = await loginAs(env, { subject: 'sn-link' })
    const html = await (await get('/settings', cookie)).text()
    expect(html).toContain('href="/settings/name"')
  })
})

describe('POST /settings/name', () => {
  it('未ログインは 401', async () => {
    expect((await post('だれか')).status).toBe(401)
  })

  it('Origin が無ければ 403（CSRF）', async () => {
    const { cookie } = await loginAs(env, { subject: 'sn-csrf' })
    const res = await app.request(
      '/settings/name',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ displayName: 'x' }).toString(),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['21 文字', 'あ'.repeat(21)],
    ['改行入り', 'あい\nうえ'],
    ['制御文字入り', 'あい\u0007うえ'],
    ['ゼロ幅スペース 3 つだけ', '​​​'],
    ['ハングルフィラー（U+3164）だけ', 'ㅤ'],
    ['RLO（U+202E）入り', 'あい‮うえ'],
    ['行区切り（U+2028）入り', 'あい うえ'],
  ])('%s は 400 で同じフォームとエラー文、保存しない', async (_, name) => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-bad' })
    const res = await post(name, cookie)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('name="displayName"')
    expect(html).toContain('role="alert"')
    expect(await displayNameOf(userId)).toBe('ななしさん')
  })

  it('20 文字ちょうどは保存して 302 /settings', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-20' })
    const name = 'あ'.repeat(20)
    const res = await post(name, cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings')
    expect(await displayNameOf(userId)).toBe(name)
  })

  it('長さはコードポイントで数える（絵文字 20 個は通る）', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-emoji' })
    const name = '😀'.repeat(20)
    expect((await post(name, cookie)).status).toBe(302)
    expect(await displayNameOf(userId)).toBe(name)
  })

  it('ZWJ でつないだ絵文字は通る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-zwj' })
    const name = '👨‍👩‍👧'
    expect((await post(name, cookie)).status).toBe(302)
    expect(await displayNameOf(userId)).toBe(name)
  })

  it('NFC 正規化と trim をしてから保存する', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-nfc' })
    // か + 結合用濁点 → が
    expect((await post('  がぎ  ', cookie)).status).toBe(302)
    expect(await displayNameOf(userId)).toBe('がぎ')
  })

  it('HTML は保存され、/settings と /settings/name の value ではエスケープして出る', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'sn-xss' })
    const name = '"><script>'
    expect((await post(name, cookie)).status).toBe(302)
    expect(await displayNameOf(userId)).toBe(name)
    const html = await (await get('/settings', cookie)).text()
    expect(html).not.toContain('"><script>')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    const form = await (await get('/settings/name', cookie)).text()
    expect(form).not.toContain('"><script>')
    expect(form).toContain('value="&quot;&gt;&lt;script&gt;"')
  })

  it('ほかの user の表示名は変わらない', async () => {
    const other = await loginAs(env, { subject: 'sn-other' })
    const { cookie } = await loginAs(env, { subject: 'sn-self' })
    expect((await post('じぶん', cookie)).status).toBe(302)
    expect(await displayNameOf(other.userId)).toBe('ななしさん')
  })
})
