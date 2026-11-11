// URL の判定。リクエストの投稿と、agent の出典の検査（docs/sources.md §4）で共有する。

// escape.id（www. などのサブドメインも）のマイページ（/me と /me/…）。本人の記録が載るので受け付けない。
// 表記の揺れで抜けないよう、host は末尾のドットを除いて小文字、path はデコード（できなければ拒否）・小文字・
// 連続スラッシュを 1 つに畳んでから見る。URL として読めないものも拒否する
export const isEscapeIdMyPage = (href: string): boolean => {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return true
  }
  const host = u.hostname.replace(/\.+$/, '').toLowerCase()
  if (host !== 'escape.id' && !host.endsWith('.escape.id')) return false
  let path: string
  try {
    path = decodeURIComponent(u.pathname)
  } catch {
    return true
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/')
  return path === '/me' || path.startsWith('/me/')
}
