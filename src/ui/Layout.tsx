// ページの外枠。スマホ用（下部ナビ・FAB）と PC 用（サイドの目次・見開き）の DOM を両方出し、
// public/app.css の @media で出し分ける。JS は使わない。

import { raw } from 'hono/html'
import type { Child } from 'hono/jsx'

export type Tab = 'records' | 'works' | 'stats' | 'settings'

const tabs: readonly { key: Tab; label: string; href: string }[] = [
  { key: 'records', label: '記録', href: '/records' },
  { key: 'works', label: '作品', href: '/works' },
  { key: 'stats', label: '統計', href: '/stats' },
  { key: 'settings', label: '設定', href: '/settings' },
]

const FONTS =
  'https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700&family=Klee+One:wght@600&family=IBM+Plex+Mono:wght@500;600&display=swap'

// <head> と <body> だけを持つ文書。ログイン画面のように外枠を使わないページはこれを直接使う
export const Document = ({ title, children }: { title: string; children?: Child }) => (
  <>
    {raw('<!DOCTYPE html>')}
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="theme-color" content="#F6F4EE" />
        <title>{`${title} | NAZO LOG`}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link rel="stylesheet" href={FONTS} />
        <link rel="stylesheet" href="/app.css" />
        <script src="/app.js" defer />
      </head>
      <body>{children}</body>
    </html>
  </>
)

// PC で詳細が開いていないときに右ページに出す表紙。データは出さない
const Cover = ({ tab }: { tab: Tab }) => {
  if (tab === 'works') {
    return (
      <div class="cover">
        <span class="big">作品を選んでください</span>
        <span>選んだ作品の詳細がこのページに開きます。</span>
      </div>
    )
  }
  if (tab === 'settings') {
    return (
      <div class="cover" style="text-align:left;align-items:stretch;justify-content:flex-start">
        <div class="top">
          <h2 style="font-size:20px">データの扱い</h2>
        </div>
        <p style="margin:0;line-height:1.9;color:var(--fg);font-size:14px">
          記録と統計は自分だけが見られます。作品ページの「プレイ済み」「マイリスト」の人数には、誰が記録したかを出しません。それでも人数の増え方から推測される可能性があるため、気になる場合は左の設定で自分を含めないようにできます。
        </p>
        <p style="margin:0;line-height:1.9;color:var(--fg);font-size:14px">
          フレンドに見えるのは、作品名・ステータス・日付だけです。メモ・ネタバレメモ・ネタバレ写真は、フレンドにも見えません。
        </p>
      </div>
    )
  }
  return (
    <div class="cover">
      <span class="big">記録を選んでください</span>
      <span>選んだ記録がこのページに開きます。</span>
    </div>
  )
}

const TabLink = ({ t, current }: { t: (typeof tabs)[number]; current: Tab }) =>
  t.key === current ? (
    <a class="on" href={t.href} aria-current="page">
      {t.label}
    </a>
  ) : (
    <a href={t.href}>{t.label}</a>
  )

// single（見開き全体を 1 ページで使う）のときは right を渡せない
export type LayoutProps = {
  title: string
  tab: Tab
  left: Child
  fab?: boolean
} & ({ single: true; right?: never } | { single?: false; right?: Child })

export const Layout = (props: LayoutProps) => {
  const hasRight = props.right !== undefined && props.right !== null
  const bookClass = props.single ? 'book one' : hasRight ? 'book has-detail' : 'book'
  return (
    <Document title={props.title}>
      <div id="app" class="wide-able">
        <aside class="side">
          <div class="brand">NAZO LOG</div>
          <a class="btn pri" href="/records/new">
            ＋ 記録
          </a>
          <nav class="idx" aria-label="メニュー">
            {tabs.map((t) => (
              <TabLink t={t} current={props.tab} />
            ))}
          </nav>
        </aside>
        <main class={bookClass}>
          <section class="page pane-l">{props.left}</section>
          {props.single ? null : (
            <section class="page pane-r">
              {hasRight ? props.right : <Cover tab={props.tab} />}
            </section>
          )}
        </main>
        {props.fab ? (
          <a class="fab" href="/records/new">
            ＋ 記録
          </a>
        ) : null}
        <nav class="bn" aria-label="メニュー">
          <div class="in">
            {tabs.map((t) => (
              <TabLink t={t} current={props.tab} />
            ))}
          </div>
        </nav>
      </div>
    </Document>
  )
}
