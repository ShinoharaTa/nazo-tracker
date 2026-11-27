// フレンド（/settings/friends*・/friends/:userId/*）と招待リンク（/f/:code）。DB 操作は src/db/friends.ts（全関数が viewerId で絞る）。
// src/index.ts で ui より前に登録するので、ui の /settings/* の middleware はここには掛からない。

import { type Context, Hono } from 'hono'
import { rememberInvitePath } from '../auth/login'
import { currentUser, requireUser } from '../auth/middleware'
import type { Db } from '../db/client'
import {
  acceptRequest,
  blockFriend,
  blockRequester,
  cancelRequest,
  clearFriendCode,
  declineRequest,
  type FriendPerson,
  findFriend,
  findInviter,
  type InviterState,
  listBlocked,
  listFriends,
  listIncoming,
  listOutgoing,
  type RequestRow,
  removeFriend,
  sendRequest,
  setFriendCode,
  unblock,
} from '../db/friends'
import type { AppEnv } from '../env'
import { FRIEND_CODE_RE } from '../lib/random'
import { isoToJstDate } from '../lib/time'
import { Empty, Menu, MenuItem, TopBar } from '../ui/components'
import { Layout } from '../ui/Layout'
import { NotFound, SettingsList, settingsState } from './ui'

const friends = new Hono<AppEnv>({ strict: false })

// 本人の関係しか出さないので共有キャッシュにも検索にも載せない。
// requireUser より先に置き、未ログインの 302 / 401 にも付ける
friends.use('/settings/friends/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
  c.res.headers.set('X-Robots-Tag', 'noindex')
})

// /settings/friends 自体も含む
friends.use('/settings/friends/*', requireUser)

// フレンドごとの画面（解除の確認など）。設定 → フレンドと同じ扱い
friends.use('/friends/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
  c.res.headers.set('X-Robots-Tag', 'noindex')
})
friends.use('/friends/*', requireUser)

// 招待リンク。加えてリンク（コード入りの URL）を Referer で外へ出さない。未ログインでも付ける
friends.use('/f/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
  c.res.headers.set('X-Robots-Tag', 'noindex')
  c.res.headers.set('Referrer-Policy', 'no-referrer')
})

// 申請は要ログイン。GET /f/:code は未ログインでも開ける（そのときコードを DB で引かない）
friends.use('/f/:code/request', requireUser)

// 招待リンクの節。url は発行済みのとき https://…/f/<code>
const InviteLink = ({ url }: { url: string | null }) => (
  <div class="sect" style="margin-top:4px">
    <h2>招待リンク</h2>
    {url ? (
      <div class="list">
        {/* JS が無くても input を選択してコピーできる */}
        <label class="field">
          リンク
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
            <button type="submit" class="btn ghost">
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

const requestDate = (r: RequestRow) => isoToJstDate(r.createdAt) ?? r.createdAt

// 届いた申請（承認・断る・ブロック）
const IncomingList = ({ rows }: { rows: RequestRow[] }) => (
  <div class="sect">
    <h2>届いた申請（{rows.length}）</h2>
    <div class="list">
      {rows.map((r) => (
        <div class="card">
          <p>{r.displayName}</p>
          <p class="note">申請日 {requestDate(r)}</p>
          <div class="btns">
            <form method="post" action={`/settings/friends/requests/${r.requestId}/accept`}>
              <button type="submit" class="btn pri">
                承認
              </button>
            </form>
            <form method="post" action={`/settings/friends/requests/${r.requestId}/decline`}>
              <button type="submit" class="btn ghost">
                断る
              </button>
            </form>
            <form method="post" action={`/settings/friends/requests/${r.requestId}/block`}>
              <button type="submit" class="btn ghost">
                ブロック
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  </div>
)

// フレンド一覧。/friends/:userId はまだ無いので表示名はリンクにしない
const FriendList = ({ rows }: { rows: FriendPerson[] }) => (
  <div class="sect">
    <h2>フレンド（{rows.length}）</h2>
    <Menu>
      {rows.map((f) => (
        <MenuItem label={f.displayName} />
      ))}
    </Menu>
  </div>
)

// 送った申請（断られた分も「申請中」としてここに出す）
const OutgoingList = ({ rows }: { rows: RequestRow[] }) => (
  <div class="sect">
    <h2>送った申請（{rows.length}）</h2>
    <div class="list">
      {rows.map((r) => (
        <div class="card">
          <p>{r.displayName}</p>
          <p class="note">申請日 {requestDate(r)}</p>
          <form method="post" action={`/settings/friends/requests/${r.requestId}/cancel`}>
            <button type="submit" class="btn ghost">
              取り消す
            </button>
          </form>
        </div>
      ))}
    </div>
  </div>
)

// ブロック中（ブロックした側にだけ出る）
const BlockedList = ({ rows }: { rows: FriendPerson[] }) => (
  <div class="sect">
    <h2>ブロック中（{rows.length}）</h2>
    <div class="list">
      {rows.map((b) => (
        <div class="card">
          <p>{b.displayName}</p>
          <form method="post" action={`/settings/friends/blocks/${b.userId}/delete`}>
            <button type="submit" class="btn ghost">
              解除
            </button>
          </form>
        </div>
      ))}
    </div>
  </div>
)

friends.get('/settings/friends', async (c) => {
  const user = currentUser(c)
  const db = c.get('db')
  const [state, incoming, list, outgoing, blocked] = await Promise.all([
    settingsState(db, user),
    listIncoming(db, user.id),
    listFriends(db, user.id),
    listOutgoing(db, user.id),
    listBlocked(db, user.id),
  ])
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
          {incoming.length ? <IncomingList rows={incoming} /> : null}
          {list.length ? <FriendList rows={list} /> : null}
          {outgoing.length ? <OutgoingList rows={outgoing} /> : null}
          {blocked.length ? <BlockedList rows={blocked} /> : null}
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

// 申請 id・ユーザー id が不正、他人のもの、条件を満たさないものは全部この 404
const friendNotFound = async (c: Context<AppEnv>) => {
  const user = currentUser(c)
  const state = await settingsState(c.get('db'), user)
  return c.html(
    <Layout
      title="見つかりませんでした"
      tab="settings"
      left={<SettingsList user={user} state={state} />}
      right={<NotFound back="/settings/friends" />}
    />,
    404,
  )
}

// 届いた申請の承認・断る・ブロック、送った申請の取り消し。成否は書き換えた行数で決める
const requestAction =
  (action: (db: Db, viewerId: string, requestId: string) => Promise<boolean>) =>
  async (c: Context<AppEnv>) => {
    if (!(await action(c.get('db'), currentUser(c).id, c.req.param('id') ?? ''))) {
      return friendNotFound(c)
    }
    return c.redirect('/settings/friends', 302)
  }

friends.post('/settings/friends/requests/:id/accept', requestAction(acceptRequest))
friends.post('/settings/friends/requests/:id/decline', requestAction(declineRequest))
friends.post('/settings/friends/requests/:id/cancel', requestAction(cancelRequest))
friends.post('/settings/friends/requests/:id/block', requestAction(blockRequester))

// ブロック解除。friendship は戻らない（もう一度リンクから申請する）
friends.post('/settings/friends/blocks/:userId/delete', async (c) => {
  if (!(await unblock(c.get('db'), currentUser(c).id, c.req.param('userId')))) {
    return friendNotFound(c)
  }
  return c.redirect('/settings/friends', 302)
})

// 解除・ブロックの確認画面
friends.get('/friends/:userId/manage', async (c) => {
  const user = currentUser(c)
  const db = c.get('db')
  const friend = await findFriend(db, user.id, c.req.param('userId'))
  if (!friend) return friendNotFound(c)
  const state = await settingsState(db, user)
  return c.html(
    <Layout
      title={friend.displayName}
      tab="settings"
      left={<SettingsList user={user} state={state} />}
      right={
        <>
          <TopBar back="/settings/friends" label={friend.displayName} />
          <div class="sect" style="margin-top:4px">
            <div class="list">
              <p>{friend.displayName}さんとのフレンドを解除しますか？</p>
              <p class="note">相手には知らせません。</p>
              <form method="post" action={`/friends/${friend.userId}/remove`}>
                <button type="submit" class="btn danger">
                  フレンドを解除する
                </button>
              </form>
              <p class="note">
                ブロックすると、相手からはあなたが見えなくなり、申請も届かなくなります。相手には知らせません。
              </p>
              <form method="post" action={`/friends/${friend.userId}/block`}>
                <button type="submit" class="btn danger">
                  ブロックする
                </button>
              </form>
            </div>
          </div>
        </>
      }
    />,
  )
})

friends.post('/friends/:userId/remove', async (c) => {
  if (!(await removeFriend(c.get('db'), currentUser(c).id, c.req.param('userId')))) {
    return friendNotFound(c)
  }
  return c.redirect('/settings/friends', 302)
})

// ブロックできるのは今のフレンドだけ（申請の送り主は /settings/friends/requests/:id/block）
friends.post('/friends/:userId/block', async (c) => {
  if (!(await blockFriend(c.get('db'), currentUser(c).id, c.req.param('userId')))) {
    return friendNotFound(c)
  }
  return c.redirect('/settings/friends', 302)
})

const NOTE_VISIBLE =
  'フレンドに見えるのは、作品名・ステータス・日付だけです。メモやネタバレは見えません。'

const invitePage = (c: Context<AppEnv>, body: unknown, status: 200 | 400 | 404 = 200) =>
  c.html(
    <Layout
      title="フレンド招待"
      tab="settings"
      single
      left={
        <>
          <TopBar title="フレンド招待" />
          <div class="sect" style="margin-top:4px">
            {body}
          </div>
        </>
      }
    />,
    status,
  )

// コードの書式違い・無い・退会済み・ブロック中は全部この 1 つ（本文も同じ）
const inviteNotFound = (c: Context<AppEnv>) =>
  c.html(
    <Layout
      title="見つかりませんでした"
      tab="settings"
      single
      left={
        <>
          <TopBar back="/settings/friends" label="404" />
          <Empty>この招待リンクは使えません。</Empty>
        </>
      }
    />,
    404,
  )

// 状態ごとの本文（outgoing / incoming / can_request）。self / friends / not_found は呼び出し側で応答する
const InviteBody = ({
  state,
  code,
  myName,
  error,
}: {
  state: Extract<InviterState, { kind: 'outgoing' | 'incoming' | 'can_request' }>
  code: string
  myName: string
  error?: string
}) => {
  if (state.kind === 'outgoing') {
    return (
      <div class="list">
        <p>{state.displayName}さんに申請を送ってあります。承認されるとフレンドになります。</p>
        <form method="post" action={`/settings/friends/requests/${state.requestId}/cancel`}>
          <button type="submit" class="btn ghost">
            取り消す
          </button>
        </form>
      </div>
    )
  }
  if (state.kind === 'incoming') {
    return (
      <div class="list">
        <p>{state.displayName}さんから申請が届いています。</p>
        <div class="btns">
          <form method="post" action={`/settings/friends/requests/${state.requestId}/accept`}>
            <button type="submit" class="btn pri">
              承認
            </button>
          </form>
          <form method="post" action={`/settings/friends/requests/${state.requestId}/decline`}>
            <button type="submit" class="btn ghost">
              断る
            </button>
          </form>
        </div>
      </div>
    )
  }
  return (
    <div class="list">
      {error ? (
        <p class="note" role="alert">
          {error}
        </p>
      ) : null}
      <p>{state.displayName}さんにフレンド申請を送りますか？</p>
      <p class="note">{NOTE_VISIBLE}</p>
      <p class="note">
        あなたの表示名: {myName}（<a href="/settings/name">変える</a>）
      </p>
      <form method="post" action={`/f/${code}/request`}>
        <button type="submit" class="btn pri">
          申請する
        </button>
      </form>
    </div>
  )
}

friends.get('/f/:code', async (c) => {
  const code = c.req.param('code')
  if (!FRIEND_CODE_RE.test(code)) return inviteNotFound(c)
  const user = c.get('user')
  // 未ログインはコードを引かない（招待者の名前も、コードの当たり外れも出さない）
  if (!user) {
    rememberInvitePath(c, `/f/${code}`)
    return invitePage(
      c,
      <div class="list">
        <p>NAZO LOG のフレンド招待リンクです。ログインすると、申請を送れます。</p>
        <a class="btn pri" href="/login">
          ログインする
        </a>
      </div>,
    )
  }
  const state = await findInviter(c.get('db'), user.id, code)
  if (state.kind === 'not_found') return inviteNotFound(c)
  if (state.kind === 'self') return c.redirect('/settings/friends', 302)
  if (state.kind === 'friends') return c.redirect(`/friends/${state.userId}`, 302)
  return invitePage(c, <InviteBody state={state} code={code} myName={user.displayName} />)
})

const SEND_ERRORS = {
  receiver_full: 'この相手は今は申請を受け付けられません。',
  unknown: '申請できませんでした。時間をおいてお試しください。',
} as const

friends.post('/f/:code/request', async (c) => {
  const code = c.req.param('code')
  if (!FRIEND_CODE_RE.test(code)) return inviteNotFound(c)
  const user = currentUser(c)
  const db = c.get('db')
  const state = await findInviter(db, user.id, code)
  switch (state.kind) {
    case 'not_found':
      return inviteNotFound(c)
    case 'self':
      return c.redirect('/settings/friends', 302)
    case 'friends':
      return c.redirect(`/friends/${state.userId}`, 302)
    // 申請中ならもう 1 行は作らない
    case 'outgoing':
      return c.redirect(`/f/${code}`, 302)
    // 相手からも届いていれば、新しい行は作らず承認として扱う
    case 'incoming':
      if (!(await acceptRequest(db, user.id, state.requestId))) return inviteNotFound(c)
      return c.redirect(`/f/${code}`, 302)
    case 'can_request': {
      const result = await sendRequest(db, user.id, code)
      if (result.ok) return c.redirect(`/f/${code}`, 302)
      return invitePage(
        c,
        <InviteBody
          state={state}
          code={code}
          myName={user.displayName}
          error={SEND_ERRORS[result.reason]}
        />,
        400,
      )
    }
  }
})

export default friends
