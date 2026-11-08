import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { attemptStatuses, workKinds } from '../src/db/schema'
import app from '../src/index'
import { attemptStatusLabels, workKindLabels } from '../src/ui/labels'

describe('画面ルート', () => {
  it('/ は /records へ 302', async () => {
    const res = await app.request('/', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/records')
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
    ['/login', 200],
  ])('%s は %i', async (path, status) => {
    const res = await app.request(path, {}, env)
    expect(res.status).toBe(status)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('/records はサイド・下部ナビ・FAB を持ち、記録タブが現在地', async () => {
    const html = await (await app.request('/records', {}, env)).text()
    expect(html).toMatch(/^<!DOCTYPE html>/)
    expect(html).toContain('<aside class="side">')
    expect(html).toContain('<nav class="bn"')
    expect(html).toContain('<a class="fab" href="/records/new">')
    expect(html).toContain('<a class="on" href="/records" aria-current="page">記録</a>')
  })

  it('未知の ?tab= は「すべて」にフォールバック', async () => {
    const html = await (await app.request('/records?tab=zzz', {}, env)).text()
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
    const withDetail = await (await app.request('/records/new', {}, env)).text()
    expect(withDetail).toContain('class="book has-detail"')
    const list = await (await app.request('/records', {}, env)).text()
    expect(list).not.toContain('has-detail')
  })

  it('/stats は見開き全体を 1 ページで使う', async () => {
    const html = await (await app.request('/stats', {}, env)).text()
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

describe('labels', () => {
  it('workKinds の全値にラベルがある', () => {
    expect(Object.keys(workKindLabels).sort()).toEqual([...workKinds].sort())
  })

  it('attemptStatuses の全値にラベルがある', () => {
    expect(Object.keys(attemptStatusLabels).sort()).toEqual([...attemptStatuses].sort())
  })
})
