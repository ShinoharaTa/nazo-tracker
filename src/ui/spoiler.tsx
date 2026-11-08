// ネタバレ本文の断片レスポンス。SpoilerCard（components.tsx）の src が指す URL はこれで返す。
// - X-Requested-With: fetch 付き（public/app.js からの取得）なら断片だけ
// - 無ければ（JS 無効で href に遷移したとき）Layout で包んだ全体ページ
// どちらもキャッシュ・インデックスさせない。認可（本人のみ）は呼び出し側のルートで行う。

import type { Context } from 'hono'
import { TopBar } from './components'
import { Layout, type Tab } from './Layout'

export type SpoilerBody = {
  memo: string | null
  photos: readonly { label: string }[]
}

// memo は空行・改行ごとに段落にする。文字列は JSX がエスケープする
export const SpoilerFragment = ({ memo, photos }: SpoilerBody) => {
  const paragraphs = (memo ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return (
    <>
      {paragraphs.length ? (
        paragraphs.map((p) => <p style="margin:0;line-height:1.7">{p}</p>)
      ) : (
        <span class="note">ネタバレメモはありません。</span>
      )}
      {photos.length ? (
        <div class="photos">
          {photos.map((ph) => (
            <div class="ph sp">{ph.label}</div>
          ))}
        </div>
      ) : null}
    </>
  )
}

export const spoilerResponse = (
  c: Context,
  body: SpoilerBody,
  page: { back: string; tab: Tab; title?: string },
) => {
  c.header('Cache-Control', 'no-store, private')
  c.header('X-Robots-Tag', 'noindex')
  c.header('Vary', 'X-Requested-With')
  if (c.req.header('X-Requested-With') === 'fetch') {
    return c.html(<SpoilerFragment {...body} />)
  }
  const title = page.title ?? 'ネタバレ'
  return c.html(
    <Layout
      title={title}
      tab={page.tab}
      single
      left={
        <>
          <TopBar back={page.back} label={title} />
          <section class="spoil">
            <span class="lock">自分だけに表示されます。フレンドにも見えません。</span>
            <SpoilerFragment {...body} />
          </section>
        </>
      }
    />,
  )
}
