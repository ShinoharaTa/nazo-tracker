import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deleteAccount } from '../src/auth/account'
import { createDb } from '../src/db/client'
import { scopedTo } from '../src/db/scoped'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { randomCode } from '../src/lib/random'
import { addDays, nowIso } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (path: string, cookie?: string, extra: Record<string, string> = { Origin: ORIGIN }) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        ...extra,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: '',
    },
    env,
  )

// ログインして表示名と招待コードを決める
const member = async (subject: string, name: string) => {
  const u = await loginAs(env, { subject })
  const code = randomCode(16)
  await env.DB.prepare('UPDATE user SET display_name = ?, friend_code = ? WHERE id = ?')
    .bind(name, code, u.userId)
    .run()
  return { ...u, name, code }
}

const insertRequest = async (
  from: string,
  to: string,
  status: 'pending' | 'accepted' | 'declined' | 'canceled',
  createdAt = nowIso(),
) => {
  const id = ulid()
  await env.DB.prepare(
    'INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, from, to, status, createdAt)
    .run()
  return id
}

const statusOf = (id: string) =>
  env.DB.prepare('SELECT status FROM friend_request WHERE id = ?')
    .bind(id)
    .first<{ status: string }>()
    .then((r) => r?.status)

const requestCount = (from: string, to: string) =>
  env.DB.prepare(
    'SELECT COUNT(*) AS n FROM friend_request WHERE from_user_id = ? AND to_user_id = ?',
  )
    .bind(from, to)
    .first<{ n: number }>()
    .then((r) => r?.n ?? 0)

const friendshipOf = (a: string, b: string) =>
  env.DB.prepare('SELECT user_lo FROM friendship WHERE user_lo = ? AND user_hi = ?')
    .bind(a < b ? a : b, a < b ? b : a)
    .all()
    .then((r) => r.results)

const makeFriends = (a: string, b: string) =>
  env.DB.prepare('INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)')
    .bind(a < b ? a : b, a < b ? b : a, nowIso())
    .run()

const blockRows = (from: string, to: string) =>
  env.DB.prepare('SELECT user_id FROM block WHERE user_id = ? AND blocked_user_id = ?')
    .bind(from, to)
    .all()
    .then((r) => r.results)

const settingsHtml = async (cookie: string) => (await get('/settings/friends', cookie)).text()

describe('ブロック', () => {
  it('フレンドをブロック → friendship が消え、両方向の pending / declined が canceled、block が 1 行', async () => {
    const me = await member('fb-friend', 'わたし')
    const f = await member('fb-friend-f', 'ぶろっく')
    await makeFriends(me.userId, f.userId)
    const mine = await insertRequest(me.userId, f.userId, 'declined', addDays(nowIso(), -10))
    const theirs = await insertRequest(f.userId, me.userId, 'pending')
    const accepted = await insertRequest(f.userId, me.userId, 'accepted', addDays(nowIso(), -20))

    const page = await (await get(`/friends/${f.userId}/manage`, me.cookie)).text()
    expect(page).toContain(`action="/friends/${f.userId}/block"`)

    const res = await post(`/friends/${f.userId}/block`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(await friendshipOf(me.userId, f.userId)).toEqual([])
    expect(await blockRows(me.userId, f.userId)).toHaveLength(1)
    expect(await statusOf(mine)).toBe('canceled')
    expect(await statusOf(theirs)).toBe('canceled')
    expect(await statusOf(accepted)).toBe('accepted')

    // ブロックした側は「ブロック中」にだけ出る
    const html = await settingsHtml(me.cookie)
    expect(html).toContain('ブロック中（1）')
    expect(html).toContain(`action="/settings/friends/blocks/${f.userId}/delete"`)
    expect(html).not.toContain('フレンド（')
    expect(html).not.toContain('届いた申請（')
  })

  it('届いた申請の送り主を確認画面からブロック → 申請は canceled、block が入る。他人・送り主の側からは 404', async () => {
    const me = await member('fb-req', 'わたし')
    const from = await member('fb-req-from', 'しつこい')
    const id = await insertRequest(from.userId, me.userId, 'pending')

    const other = await member('fb-req-other', 'たにん')
    expect((await get(`/friends/${from.userId}/manage`, other.cookie)).status).toBe(404)
    expect((await post(`/friends/${from.userId}/block`, other.cookie)).status).toBe(404)
    expect((await get(`/friends/${me.userId}/manage`, from.cookie)).status).toBe(404)
    expect((await post(`/friends/${me.userId}/block`, from.cookie)).status).toBe(404)
    expect(await blockRows(other.userId, from.userId)).toEqual([])
    expect(await blockRows(from.userId, me.userId)).toEqual([])

    expect((await get(`/friends/${from.userId}/manage`, me.cookie)).status).toBe(200)
    const res = await post(`/friends/${from.userId}/block`, me.cookie)
    expect(res.status).toBe(302)
    expect(await statusOf(id)).toBe('canceled')
    expect(await blockRows(me.userId, from.userId)).toHaveLength(1)
  })

  it('届いた申請の「ブロック」は確認画面へ。送り主（まだフレンドでない）にはブロックだけ出し、戻るは /settings/friends', async () => {
    const me = await member('fb-confirm', 'わたし')
    const from = await member('fb-confirm-from', 'しつこい')
    const id = await insertRequest(from.userId, me.userId, 'pending')
    const html = await settingsHtml(me.cookie)
    expect(html).toContain(`href="/friends/${from.userId}/manage"`)
    expect(html).not.toContain('/block"')
    // 断るは 1 タップのまま
    expect(html).toContain(`action="/settings/friends/requests/${id}/decline"`)

    const page = await get(`/friends/${from.userId}/manage`, me.cookie)
    expect(page.status).toBe(200)
    const body = await page.text()
    expect(body).toContain(`action="/friends/${from.userId}/block"`)
    expect(body).not.toContain(`action="/friends/${from.userId}/remove"`)
    expect(body).toContain(
      '相手には知らせません。ブロックを解除しても、届いていた申請は元には戻りません。',
    )
    expect(body).not.toContain('フレンドも解除されます。')
    expect(body).toContain('class="back" href="/settings/friends"')
    // 確認画面を開いただけでは何も変わらない
    expect(await statusOf(id)).toBe('pending')
    expect(await blockRows(me.userId, from.userId)).toEqual([])

    const res = await post(`/friends/${from.userId}/block`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expect(await statusOf(id)).toBe('canceled')
    expect(await blockRows(me.userId, from.userId)).toHaveLength(1)
    // ブロック後は確認画面も 404
    expect((await get(`/friends/${from.userId}/manage`, me.cookie)).status).toBe(404)
  })

  it('フレンドの確認画面: 解除とブロックの両方、注記、戻るは記録一覧', async () => {
    const me = await member('fb-manage', 'わたし')
    const f = await member('fb-manage-f', 'ともだち')
    await makeFriends(me.userId, f.userId)
    const body = await (await get(`/friends/${f.userId}/manage`, me.cookie)).text()
    expect(body).toContain(`action="/friends/${f.userId}/remove"`)
    expect(body).toContain(`action="/friends/${f.userId}/block"`)
    expect(body).toContain(
      '相手には知らせません。フレンドも解除されます。ブロックを解除しても元には戻りません。',
    )
    expect(body).not.toContain('届いていた申請')
    expect(body).toContain(`class="back" href="/friends/${f.userId}"`)
  })

  it('ブロックできない相手（関係なし・断った・期限切れ・自分から申請中・自分・無い id）は確認画面も同じ 404', async () => {
    const me = await member('fb-manage-404', 'わたし')
    const stranger = await member('fb-manage-404-s', 'しらない')
    const declined = await member('fb-manage-404-d', 'ことわった')
    const old = await member('fb-manage-404-o', 'ふるい')
    const outgoing = await member('fb-manage-404-g', 'しんせいちゅう')
    await insertRequest(declined.userId, me.userId, 'declined')
    await insertRequest(old.userId, me.userId, 'pending', addDays(nowIso(), -31))
    await insertRequest(me.userId, outgoing.userId, 'pending')
    const bodies: string[] = []
    for (const id of [
      stranger.userId,
      declined.userId,
      old.userId,
      outgoing.userId,
      me.userId,
      ulid(),
    ]) {
      const res = await get(`/friends/${id}/manage`, me.cookie)
      expect(res.status).toBe(404)
      bodies.push(await res.text())
    }
    expect(new Set(bodies).size).toBe(1)
  })

  it('30 日を過ぎた申請・断った申請からはブロックできない（404）', async () => {
    const me = await member('fb-req-old', 'わたし')
    const a = await member('fb-req-old-a', 'えー')
    const b = await member('fb-req-old-b', 'びー')
    const old = await insertRequest(a.userId, me.userId, 'pending', addDays(nowIso(), -31))
    const declined = await insertRequest(b.userId, me.userId, 'declined')
    for (const u of [a, b]) {
      expect((await get(`/friends/${u.userId}/manage`, me.cookie)).status).toBe(404)
      expect((await post(`/friends/${u.userId}/block`, me.cookie)).status).toBe(404)
    }
    // 期限切れの pending は書き込みのついでに canceled になる（ブロックはされない）
    expect(await statusOf(old)).toBe('canceled')
    expect(await statusOf(declined)).toBe('declined')
    expect(await blockRows(me.userId, a.userId)).toEqual([])
    expect(await blockRows(me.userId, b.userId)).toEqual([])
  })

  it('関係の無い相手・自分・無い id を /friends/:userId/block に入れても 404 で block 行ができない', async () => {
    const me = await member('fb-unrelated', 'わたし')
    const x = await member('fb-unrelated-x', 'むかんけい')
    // 自分が送っただけの相手もブロックできない
    const y = await member('fb-unrelated-y', 'おくった')
    await insertRequest(me.userId, y.userId, 'pending')
    for (const id of [x.userId, y.userId, me.userId, ulid()]) {
      const res = await post(`/friends/${id}/block`, me.cookie)
      expect(res.status).toBe(404)
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM block WHERE user_id = ?')
      .bind(me.userId)
      .first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('ブロックされた側の見え方は、相手が退会した場合と同じ（一覧・招待リンク・asFriendOf）', async () => {
    // A1 が B1 をブロック、A2 は退会。どちらも B から見た応答を比べる
    const a1 = await member('fb-same-a1', 'ぶろっかー')
    const b1 = await member('fb-same-b1', 'びーいち')
    const a2 = await member('fb-same-a2', 'たいかいしゃ')
    const b2 = await member('fb-same-b2', 'びーに')
    for (const [a, b] of [
      [a1, b1],
      [a2, b2],
    ]) {
      await makeFriends(a.userId, b.userId)
    }
    expect((await post(`/friends/${b1.userId}/block`, a1.cookie)).status).toBe(302)
    await deleteAccount(createDb(env.DB), a2.userId)

    const s1 = await settingsHtml(b1.cookie)
    const s2 = await settingsHtml(b2.cookie)
    expect(s1).not.toContain('ぶろっかー')
    expect(s2).not.toContain('たいかいしゃ')
    for (const s of [s1, s2]) {
      expect(s).not.toContain('フレンド（')
      expect(s).not.toContain('ブロック中（')
    }
    const settings1 = await (await get('/settings', b1.cookie)).text()
    expect(settings1).toContain('<span class="note">0 人</span>')

    const l1 = await get(`/f/${a1.code}`, b1.cookie)
    const l2 = await get(`/f/${a2.code}`, b2.cookie)
    expect(l1.status).toBe(404)
    expect(l2.status).toBe(404)
    expect(await l1.text()).toBe(await l2.text())

    const m1 = await get(`/friends/${a1.userId}/manage`, b1.cookie)
    const m2 = await get(`/friends/${a2.userId}/manage`, b2.cookie)
    expect(m1.status).toBe(404)
    expect(m2.status).toBe(404)

    const db = createDb(env.DB)
    expect(await scopedTo(db, b1.userId).asFriendOf(a1.userId)).toBeNull()
    expect(await scopedTo(db, b2.userId).asFriendOf(a2.userId)).toBeNull()
  })

  it('ブロック中は双方とも相手のリンクが 404、申請の POST も 404 で行が増えない', async () => {
    const me = await member('fb-link', 'わたし')
    const x = await member('fb-link-x', 'えっくす')
    await makeFriends(me.userId, x.userId)
    expect((await post(`/friends/${x.userId}/block`, me.cookie)).status).toBe(302)

    expect((await get(`/f/${x.code}`, me.cookie)).status).toBe(404)
    expect((await get(`/f/${me.code}`, x.cookie)).status).toBe(404)
    expect((await post(`/f/${me.code}/request`, x.cookie)).status).toBe(404)
    expect((await post(`/f/${x.code}/request`, me.cookie)).status).toBe(404)
    expect(await requestCount(x.userId, me.userId)).toBe(0)
    expect(await requestCount(me.userId, x.userId)).toBe(0)
  })

  it('解除しても friendship は戻らない。解除後は申請できる。他人の block は解除できない（404）', async () => {
    const me = await member('fb-unblock', 'わたし')
    const x = await member('fb-unblock-x', 'もどる')
    await makeFriends(me.userId, x.userId)
    expect((await post(`/friends/${x.userId}/block`, me.cookie)).status).toBe(302)

    // ブロックされた側・関係の無い人は解除できない
    const other = await member('fb-unblock-o', 'たにん')
    expect((await post(`/settings/friends/blocks/${x.userId}/delete`, other.cookie)).status).toBe(
      404,
    )
    expect((await post(`/settings/friends/blocks/${me.userId}/delete`, x.cookie)).status).toBe(404)
    expect(await blockRows(me.userId, x.userId)).toHaveLength(1)

    const res = await post(`/settings/friends/blocks/${x.userId}/delete`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expect(await blockRows(me.userId, x.userId)).toEqual([])
    expect(await friendshipOf(me.userId, x.userId)).toEqual([])
    expect(await settingsHtml(me.cookie)).not.toContain('ブロック中（')
    // もう一度は 404
    expect((await post(`/settings/friends/blocks/${x.userId}/delete`, me.cookie)).status).toBe(404)

    expect((await post(`/f/${me.code}/request`, x.cookie)).status).toBe(302)
    expect(await requestCount(x.userId, me.userId)).toBe(1)
  })

  it('未ログインは 401、Origin の無い POST は 403', async () => {
    const me = await member('fb-auth', 'わたし')
    const f = await member('fb-auth-f', 'ふれんど')
    await makeFriends(me.userId, f.userId)
    for (const path of [
      `/friends/${f.userId}/block`,
      `/settings/friends/blocks/${f.userId}/delete`,
    ]) {
      expect((await post(path)).status).toBe(401)
    }
    expect((await post(`/friends/${f.userId}/block`, me.cookie, {})).status).toBe(403)
    expect(await blockRows(me.userId, f.userId)).toEqual([])
    expect(await friendshipOf(me.userId, f.userId)).toHaveLength(1)
  })
})
