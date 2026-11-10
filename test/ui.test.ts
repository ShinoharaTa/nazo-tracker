import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  attemptStatuses,
  organizationAliasKinds,
  runChannels,
  shopKinds,
  workAliasKinds,
  workKinds,
} from '../src/db/schema'
import { sessionOutcomes } from '../src/db/scoped'
import app from '../src/index'
import {
  attemptStatusLabels,
  organizationAliasKindLabels,
  outcomeLabels,
  runChannelLabels,
  shopKindLabels,
  workAliasKindLabels,
  workKindLabels,
} from '../src/ui/labels'
import { loginAs } from './helpers/auth'

let cookie = ''
beforeAll(async () => {
  cookie = (await loginAs(env, { subject: 'ui-test' })).cookie
})

// ログイン済みで GET する
const get = (path: string) => app.request(path, { headers: { Cookie: cookie } }, env)

describe('画面ルート', () => {
  it('/ は未ログインなら /login、ログイン済みなら /records へ 302', async () => {
    const anon = await app.request('/', {}, env)
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/login')
    const res = await get('/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')
  })

  it.each([
    '/records',
    '/records/',
    '/records?tab=pending',
    '/records/new',
    '/records/xyz',
    '/stats',
    '/stats/',
    '/settings',
    '/settings/',
  ])('未ログインで %s は 302 /login', async (path) => {
    const res = await app.request(path, {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it.each([
    ['/works', 200],
    ['/works?kind=room', 200],
    ['/works/xyz', 404],
    ['/login', 200],
  ])('未ログインで %s は %i', async (path, status) => {
    const res = await app.request(path, {}, env)
    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it.each([
    ['/records', 200],
    ['/records/', 200],
    ['/records?tab=pending', 200],
    ['/records?tab=wish', 200],
    ['/records/new', 200],
    ['/records/xyz', 404],
    ['/works', 200],
    ['/works?kind=room', 200],
    ['/works/xyz', 404],
    ['/stats', 200],
    ['/settings', 200],
  ])('ログイン済みで %s は %i', async (path, status) => {
    const res = await get(path)
    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it.each([
    ['?error=denied', 'ログインがキャンセルされました。'],
    ['?error=failed', 'ログインに失敗しました。もう一度お試しください。'],
    ['?deleted=1', '退会しました。'],
  ])('/login%s はメッセージを出す', async (q, message) => {
    const html = await (await app.request(`/login${q}`, {}, env)).text()
    expect(html).toContain(message)
  })

  it('/login の未知の ?error= はメッセージを出さない', async () => {
    const html = await (await app.request('/login?error=constructor', {}, env)).text()
    expect(html).not.toContain('role="status"')
  })

  it('/records はサイド・下部ナビ・FAB を持ち、記録タブが現在地', async () => {
    const html = await (await get('/records')).text()
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<aside class="side">')
    expect(html).toContain('<nav class="bn"')
    expect(html).toContain('<a class="fab" href="/records/new">')
    expect(html).toContain('<a class="on" href="/records" aria-current="page">記録</a>')
  })

  it('未知の ?tab= は「すべて」にフォールバック', async () => {
    const html = await (await get('/records?tab=zzz')).text()
    expect(html).toContain('<a class="tab on" href="/records" aria-current="page">すべて</a>')
  })

  it('未知の ?kind=（line 単体も含む）は「すべて」にフォールバック', async () => {
    const html = await (await app.request('/works?kind=line', {}, env)).text()
    expect(html).toContain('<a class="fchip on" href="/works" aria-current="page">すべて</a>')
    expect(html).not.toContain('name="kind"')
  })

  it('検索語はエスケープして出す', async () => {
    const q = encodeURIComponent('"><script>x</script>')
    const html = await (await app.request(`/works?q=${q}`, {}, env)).text()
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&quot;&gt;&lt;script&gt;x&lt;/script&gt;')
  })

  it('詳細を持つページだけ has-detail が付く', async () => {
    const withDetail = await (await get('/records/new')).text()
    expect(withDetail).toContain('class="book has-detail"')
    const list = await (await get('/records')).text()
    expect(list).not.toContain('has-detail')
  })

  it('/stats は見開き全体を 1 ページで使う', async () => {
    const html = await (await get('/stats')).text()
    expect(html).toContain('class="book one"')
  })
})

describe('GET /_ui', () => {
  it('UI_GALLERY 未設定なら 404', async () => {
    const res = await app.request('/_ui', {}, { ...env, UI_GALLERY: undefined })
    expect(res.status).toBe(404)
  })

  it('wrangler.toml の既定値 "0" なら 404', async () => {
    expect(env.UI_GALLERY).toBe('0')
    const res = await app.request('/_ui', {}, env)
    expect(res.status).toBe(404)
  })

  it('UI_GALLERY="1" なら 200', async () => {
    const res = await app.request('/_ui', {}, { ...env, UI_GALLERY: '1' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('星降る街の周遊録')
  })
})

describe('ネタバレの遅延読み込み', () => {
  const on = { ...env, UI_GALLERY: '1' }
  const spoiler = '第3章の暗号はキットの裏表紙と組み合わせる。'

  it('初期 HTML（/_ui）にネタバレ本文を含めない', async () => {
    const html = await (await app.request('/_ui', {}, on)).text()
    expect(html).toContain('data-spoiler-toggle')
    expect(html).toContain('href="/_ui/spoiler"')
    expect(html).not.toContain(spoiler)
  })

  it('X-Requested-With: fetch 付きなら断片だけを返す', async () => {
    const res = await app.request('/_ui/spoiler', { headers: { 'X-Requested-With': 'fetch' } }, on)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).not.toContain('<html')
    expect(html).toContain(spoiler)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('vary')).toContain('X-Requested-With')
  })

  it('ヘッダ無しなら Layout で包んだ全体ページを返す', async () => {
    const res = await app.request('/_ui/spoiler', {}, on)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<html lang="ja">')
    expect(html).toContain('<a class="back" href="/_ui"')
    expect(html).toContain(spoiler)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
  })

  it('UI_GALLERY が "1" でなければ 404', async () => {
    const res = await app.request('/_ui/spoiler', { headers: { 'X-Requested-With': 'fetch' } }, env)
    expect(res.status).toBe(404)
  })
})

describe('labels', () => {
  it('workKinds の全値にラベルがある', () => {
    expect(Object.keys(workKindLabels).sort()).toEqual([...workKinds].sort())
  })

  it('attemptStatuses の全値にラベルがある', () => {
    expect(Object.keys(attemptStatusLabels).sort()).toEqual([...attemptStatuses].sort())
  })

  it.each([
    ['runChannels', runChannelLabels, runChannels],
    ['workAliasKinds', workAliasKindLabels, workAliasKinds],
    ['organizationAliasKinds', organizationAliasKindLabels, organizationAliasKinds],
    ['shopKinds', shopKindLabels, shopKinds],
    ['sessionOutcomes', outcomeLabels, sessionOutcomes],
  ] as const)('%s の全値にラベルがある', (_, labels, values) => {
    expect(Object.keys(labels).sort()).toEqual([...values].sort())
  })
})
