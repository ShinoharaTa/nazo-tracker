// マスタの画像（作品の OGP 画像・団体のロゴ）の URL。実体は取得・保存・配信せず、URL の文字列だけを持つ（docs/design.md §3.4.2）。
// 画像の URL は許可ホストに限る。ホストを足すのは docs/sources.md §2 に行を足す PR とセット。X 系の画像ホストは足さない。

import { ng, ok, type Parser, url } from './form'
import { hasUserinfo } from './match'
import { isEscapeIdMyPage, isXHost } from './url'

// 画像の URL に使えるホスト。dropQuery: 保存時に query を落とす（縮小版の指定 ?t= は表示側で付ける）
export const IMAGE_HOSTS: readonly { host: string; dropQuery: boolean }[] = [
  { host: 'static.escape.id', dropQuery: true },
]

const hostOf = (u: URL) => u.hostname.replace(/\.+$/, '').toLowerCase()

const HOSTS_MSG = `は ${IMAGE_HOSTS.map((h) => `https://${h.host}/`).join(' か ')} の URL にしてください。`

// 画像の URL（work.image_url / organization.logo_url）。https・userinfo なし・ポートなし・許可ホストに完全一致・.svg 以外。
// 保存値は hash を落とした href（dropQuery のホストは query も落とす）
export const imageUrl = (): Parser<string> => (raw) => {
  const base = url()(raw)
  if (!base.ok) return base
  const u = new URL(base.value)
  if (u.protocol !== 'https:' || hasUserinfo(base.value) || u.port !== '') return ng(HOSTS_MSG)
  const rule = IMAGE_HOSTS.find((h) => h.host === hostOf(u))
  if (!rule) return ng(HOSTS_MSG)
  let path: string
  try {
    path = decodeURIComponent(u.pathname).toLowerCase()
  } catch {
    return ng(HOSTS_MSG)
  }
  if (path.endsWith('.svg')) return ng('に SVG の画像は使えません。')
  u.hash = ''
  if (rule.dropQuery) u.search = ''
  return ok(u.href)
}

// 画像の取得元のページ（work.image_page_url / organization.logo_page_url）。https・userinfo なし。
// escape.id のマイページと X は出典にしない（docs/sources.md §4 の forbidden_source と同じ規則）。保存値は hash を落とした href
export const imagePageUrl = (): Parser<string> => (raw) => {
  const base = url()(raw)
  if (!base.ok) return base
  const u = new URL(base.value)
  if (u.protocol !== 'https:') return ng('は https:// で始まる URL にしてください。')
  if (hasUserinfo(base.value)) return ng('に ID・パスワード付きの URL は使えません。')
  if (isEscapeIdMyPage(base.value) || isXHost(hostOf(u))) {
    return ng('に escape.id のマイページと X（Twitter）の URL は使えません。')
  }
  u.hash = ''
  return ok(u.href)
}
