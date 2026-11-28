import { describe, expect, it } from 'vitest'
import { IMAGE_HOSTS, imagePageUrl, imageUrl } from '../src/lib/image-url'
import { isXHost } from '../src/lib/url'

const IMG = 'https://static.escape.id/i/o/takarush/abc.png'

describe('imageUrl', () => {
  it('許可ホストは static.escape.id だけ', () => {
    expect(IMAGE_HOSTS.map((h) => h.host)).toEqual(['static.escape.id'])
  })

  it.each([
    [IMG, IMG],
    // query（縮小版の ?t=）と hash は落とす
    [`${IMG}?t=sm#x`, IMG],
    // host は小文字・末尾ドットを除いて比べ、保存値は規則の host に揃える
    [
      'https://STATIC.escape.id/o/takarush/nanica_logo.png',
      'https://static.escape.id/o/takarush/nanica_logo.png',
    ],
    ['https://static.escape.id./o/a.png', 'https://static.escape.id/o/a.png'],
    ['https://static.escape.id../o/a.png', 'https://static.escape.id/o/a.png'],
    // 既定のポート 443 は URL の正規化で消える
    ['https://static.escape.id:443/o/a.png', 'https://static.escape.id/o/a.png'],
    // 拡張子の許可リスト（大文字小文字を区別しない。query は見ない）
    ['https://static.escape.id/o/a.JPG', 'https://static.escape.id/o/a.JPG'],
    ['https://static.escape.id/o/a.jpeg', 'https://static.escape.id/o/a.jpeg'],
    ['https://static.escape.id/o/a.webp', 'https://static.escape.id/o/a.webp'],
    ['https://static.escape.id/o/a.gif?t=sm', 'https://static.escape.id/o/a.gif'],
  ])('%s → 通る', (raw, want) => {
    expect(imageUrl()(raw)).toEqual({ ok: true, value: want })
  })

  const hostsMsg = 'は https://static.escape.id/ の URL にしてください。'
  const extMsg = 'は png / jpg / webp / gif の画像の URL にしてください。'
  it.each([
    ['http', 'http://static.escape.id/o/a.png', hostsMsg],
    ['userinfo', 'https://u:p@static.escape.id/o/a.png', hostsMsg],
    ['ユーザー名だけ', 'https://u@static.escape.id/o/a.png', hostsMsg],
    ['ポート', 'https://static.escape.id:8443/o/a.png', hostsMsg],
    ['許可外 host', 'https://example.com/a.png', hostsMsg],
    ['escape.id 本体', 'https://escape.id/a.png', hostsMsg],
    ['サブドメイン', 'https://cdn.static.escape.id/a.png', hostsMsg],
    ['後ろに続く host', 'https://static.escape.id.example.com/a.png', hostsMsg],
    ['X の画像', 'https://pbs.twimg.com/media/a.jpg', hostsMsg],
    ['.svg', 'https://static.escape.id/o/logo.svg', extMsg],
    ['.SVG（大文字）', 'https://static.escape.id/o/logo.SVG', extMsg],
    ['.svg（query 付き）', 'https://static.escape.id/o/logo.svg?t=sm', extMsg],
    ['.svg（query に .png）', 'https://static.escape.id/o/logo.svg?x=.png', extMsg],
    ['.svg（hash に .png）', 'https://static.escape.id/o/logo.svg#.png', extMsg],
    ['.svgz', 'https://static.escape.id/o/logo.svgz', extMsg],
    ['%2Esvg', 'https://static.escape.id/o/logo%2Esvg', extMsg],
    ['末尾 /', 'https://static.escape.id/o/a.png/', extMsg],
    ['拡張子なし', 'https://static.escape.id/o/a', extMsg],
    ['パスなし', 'https://static.escape.id/', extMsg],
    [';x', 'https://static.escape.id/o/a.png;x', extMsg],
    ['%00', 'https://static.escape.id/o/a.png%00', extMsg],
    ['%20', 'https://static.escape.id/o/a.png%20', extMsg],
    ['末尾ドット', 'https://static.escape.id/o/a.png.', extMsg],
    ['.bmp', 'https://static.escape.id/o/a.bmp', extMsg],
    ['javascript:', 'javascript:alert(1)', 'は http:// か https:// で始まる URL にしてください。'],
    ['空白', 'https://static.escape.id/o/a b.png', 'に空白は使えません。'],
  ])('%s → 落ちる', (_, raw, error) => {
    expect(imageUrl()(raw)).toEqual({ ok: false, error })
  })

  it('2000 文字を超える → 落ちる', () => {
    const raw = `https://static.escape.id/${'a'.repeat(2000)}.png`
    expect(imageUrl()(raw).ok).toBe(false)
  })
})

describe('imagePageUrl', () => {
  it.each([
    ['https://escape.id/takarush-org/e-room666/', 'https://escape.id/takarush-org/e-room666/'],
    // hash は落とす。query は残す
    ['https://example.com/works?id=1#top', 'https://example.com/works?id=1'],
  ])('%s → 通る', (raw, want) => {
    expect(imagePageUrl()(raw)).toEqual({ ok: true, value: want })
  })

  const forbidden = 'に escape.id のマイページと X（Twitter）の URL は使えません。'
  it.each([
    ['http', 'http://escape.id/takarush-org/', 'は https:// で始まる URL にしてください。'],
    [
      'userinfo',
      'https://u:p@escape.id/takarush-org/',
      'に ID・パスワード付きの URL は使えません。',
    ],
    ['/me/', 'https://escape.id/me/bookmarks/', forbidden],
    ['/me（サブドメイン・大文字）', 'https://www.escape.id/ME', forbidden],
    ['x.com', 'https://x.com/someone/status/1', forbidden],
    ['twitter.com のサブドメイン', 'https://mobile.twitter.com/someone', forbidden],
    ['t.co', 'https://t.co/abc', forbidden],
  ])('%s → 落ちる', (_, raw, error) => {
    expect(imagePageUrl()(raw)).toEqual({ ok: false, error })
  })
})

describe('isXHost', () => {
  it.each([
    ['x.com', true],
    ['api.x.com', true],
    ['twitter.com', true],
    ['t.co', true],
    ['notx.com', false],
    ['escape.id', false],
  ])('%s → %s', (host, want) => {
    expect(isXHost(host)).toBe(want)
  })
})
