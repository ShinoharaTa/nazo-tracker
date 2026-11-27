// フレンド（/settings/friends*）。DB 操作は src/db/friends.ts（全関数が viewerId で絞る）。
// src/index.ts で ui より前に登録するので、ui の /settings/* の middleware はここには掛からない。

import { Hono } from 'hono'
import { currentUser, requireUser } from '../auth/middleware'
import { clearFriendCode, setFriendCode } from '../db/friends'
import type { AppEnv } from '../env'
import { TopBar } from '../ui/components'
import { Layout } from '../ui/Layout'
import { SettingsList, settingsState } from './ui'

const friends = new Hono<AppEnv>({ strict: false })

// /settings/friends 自体も含む
friends.use('/settings/friends/*', requireUser)

// 本人の関係しか出さないので共有キャッシュにも検索にも載せない
friends.use('/settings/friends/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
  c.res.headers.set('X-Robots-Tag', 'noindex')
})

// 招待リンクの節。url は発行済みのとき https://…/f/<code>
const InviteLink = ({ url }: { url: string | null }) => (
  <div class="sect" style="margin-top:4px">
    <h2>招待リンク</h2>
    {url ? (
      <div class="list">
        {/* JS が無くても input を選択してコピーできる */}
        <label class="field">
          招待リンク
          <input type="text" id="friend-invite-url" value={url} readonly />
        </label>
        <div class="btns">
          <button type="button" class="btn pri" data-copy="friend-invite-url">
            コピー
          </button>
          <form method="post" action="/settings/friends/code">
            <button type="submit" class="btn ghost">
              リンクを作り直す
            </button>
          </form>
          <form method="post" action="/settings/friends/code/delete">
            <button type="submit" class="btn danger">
              招待を止める
            </button>
          </form>
        </div>
      </div>
    ) : (
      <div class="list">
        <p class="note">リンクを知っている人だけが、あなたにフレンド申請できます。</p>
        <form method="post" action="/settings/friends/code">
          <button type="submit" class="btn pri">
            招待リンクを作る
          </button>
        </form>
      </div>
    )}
  </div>
)

friends.get('/settings/friends', async (c) => {
  const user = currentUser(c)
  const state = await settingsState(c.get('db'), user)
  const url = state.friendCode ? `${c.env.APP_ORIGIN}/f/${state.friendCode}` : null
  return c.html(
    <Layout
      title="フレンド"
      tab="settings"
      left={<SettingsList user={user} state={state} />}
      right={
        <>
          <TopBar back="/settings" label="フレンド" />
          <InviteLink url={url} />
          <div class="sect">
            <p class="note">
              フレンドに見えるのは、作品名・ステータス・日付だけです。メモやネタバレは見えません。
            </p>
          </div>
        </>
      }
    />,
  )
})

// 作る・作り直す（古いリンクはその場で使えなくなる）
friends.post('/settings/friends/code', async (c) => {
  await setFriendCode(c.get('db'), currentUser(c).id)
  return c.redirect('/settings/friends', 302)
})

friends.post('/settings/friends/code/delete', async (c) => {
  await clearFriendCode(c.get('db'), currentUser(c).id)
  return c.redirect('/settings/friends', 302)
})

export default friends
