// ネタバレ本文の断片レスポンス。SpoilerCard（components.tsx）の src が指す URL はこれで返す。
// - X-Requested-With: fetch 付き（public/app.js からの取得）なら断片だけ
// - 無ければ（JS 無効で href に遷移したとき）Layout で包んだ全体ページ
// どちらもキャッシュ・インデックスさせない。
// spoilerResponse は own() でしか得られない OwnAttempt だけを受ける（本人以外の記録を渡せない）。
// 部品見本（src/routes/gallery.tsx）は OwnAttempt を作れないので SpoilerFragment / SpoilerPage / spoilerHeaders を直接使う。

import type { Context } from 'hono'
import type { OwnAttempt } from '../db/scoped'
import { TopBar } from './components'
import { Layout, type Tab } from './Layout'

type SpoilerBody = {
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

type SpoilerPageProps = { back: string; tab: Tab; title?: string }

// JS 無効で src に遷移したときの全体ページ
export const SpoilerPage = ({ body, page }: { body: SpoilerBody; page: SpoilerPageProps }) => {
  const title = page.title ?? 'ネタバレ'
  return (
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
    />
  )
}

// ネタバレ本文を含む応答に付けるヘッダ
export const spoilerHeaders = (c: Context) => {
  c.header('Cache-Control', 'no-store, private')
  c.header('X-Robots-Tag', 'noindex')
  c.header('Vary', 'X-Requested-With')
}

// 写真（spoiler=1 の image）は P9 まで常に空
export const spoilerResponse = (c: Context, a: OwnAttempt, page: SpoilerPageProps) => {
  const body: SpoilerBody = { memo: a.spoilerMemo, photos: [] }
  spoilerHeaders(c)
  if (c.req.header('X-Requested-With') === 'fetch') {
    return c.html(<SpoilerFragment {...body} />)
  }
  return c.html(<SpoilerPage body={body} page={page} />)
}
