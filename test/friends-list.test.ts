import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { randomCode } from '../src/lib/random'
import { addDays, nowIso } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string, extra: Record<string, string> = {}) =>
  app.request(path, { headers: { ...extra, ...(cookie ? { Cookie: cookie } : {}) } }, env)

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

// ログインして表示名を決める（一覧の文字列で確かめるため）
const member = async (subject: string, name: string) => {
  const u = await loginAs(env, { subject })
  await env.DB.prepare('UPDATE user SET display_name = ? WHERE id = ?').bind(name, u.userId).run()
  return { ...u, name }
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

const friendshipOf = (a: string, b: string) =>
  env.DB.prepare('SELECT user_lo, user_hi FROM friendship WHERE user_lo = ? AND user_hi = ?')
    .bind(a < b ? a : b, a < b ? b : a)
    .all<{ user_lo: string; user_hi: string }>()
    .then((r) => r.results)

const makeFriends = (a: string, b: string) =>
  env.DB.prepare('INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)')
    .bind(a < b ? a : b, a < b ? b : a, nowIso())
    .run()

const settingsHtml = async (cookie: string) => (await get('/settings/friends', cookie)).text()

const expectPrivate = (res: Response) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('x-robots-tag')).toBe('noindex')
}

describe('/settings/friends の一覧', () => {
  it('届いた申請・フレンド・送った申請を出す。空の節は見出しごと出さない', async () => {
    const me = await member('fl-lists', 'わたし')
    const empty = await settingsHtml(me.cookie)
    expect(empty).not.toContain('届いた申請（')
    expect(empty).not.toContain('フレンド（')
    expect(empty).not.toContain('送った申請（')
    expect(empty).toContain('招待リンク')

    const from = await member('fl-lists-from', 'とどいた')
    const to = await member('fl-lists-to', 'おくった')
    const fb = await member('fl-lists-fb', 'びー')
    const fa = await member('fl-lists-fa', 'あー')
    const inId = await insertRequest(from.userId, me.userId, 'pending')
    const outId = await insertRequest(me.userId, to.userId, 'pending')
    await makeFriends(me.userId, fb.userId)
    await makeFriends(me.userId, fa.userId)

    const html = await settingsHtml(me.cookie)
    expect(html).toContain('届いた申請（1）')
    expect(html).toContain('とどいた')
    expect(html).toContain(`action="/settings/friends/requests/${inId}/accept"`)
    expect(html).toContain(`action="/settings/friends/requests/${inId}/decline"`)
    expect(html).toContain('送った申請（1）')
    expect(html).toContain(`action="/settings/friends/requests/${outId}/cancel"`)
    // フレンドは表示名の昇順。/friends/:userId はまだ無いのでリンクにしない
    expect(html).toContain('フレンド（2）')
    expect(html.indexOf('<span>あー</span>')).toBeLessThan(html.indexOf('<span>びー</span>'))
    expect(html).not.toContain(`href="/friends/`)
    // 並びは 招待リンク → 届いた申請 → フレンド → 送った申請
    const order = ['招待リンク', '届いた申請（', 'フレンド（', '送った申請（'].map((s) =>
      html.indexOf(s),
    )
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('30 日を過ぎた pending は一覧に出ず、承認は 404 で friendship ができない', async () => {
    const me = await member('fl-expired', 'わたし')
    const old = await member('fl-expired-from', 'ふるい')
    const to = await member('fl-expired-to', 'むかし')
    const id = await insertRequest(old.userId, me.userId, 'pending', addDays(nowIso(), -31))
    await insertRequest(me.userId, to.userId, 'declined', addDays(nowIso(), -31))
    const html = await settingsHtml(me.cookie)
    expect(html).not.toContain('ふるい')
    expect(html).not.toContain('むかし')

    const res = await post(`/settings/friends/requests/${id}/accept`, me.cookie)
    expect(res.status).toBe(404)
    expect(await friendshipOf(me.userId, old.userId)).toEqual([])
  })

  it('設定一覧の「フレンド」の note は「n 人」、届いた申請があれば「n 人・申請 m 件」', async () => {
    const me = await member('fl-note', 'わたし')
    const f = await member('fl-note-f', 'ふれんど')
    await makeFriends(me.userId, f.userId)
    const one = await (await get('/settings', me.cookie)).text()
    expect(one).toContain(
      '<a href="/settings/friends"><span>フレンド</span><span class="note">1 人</span></a>',
    )

    for (const s of ['fl-note-r1', 'fl-note-r2']) {
      const r = await member(s, s)
      await insertRequest(r.userId, me.userId, 'pending')
    }
    // 期限切れ・断った分は数えない
    const r3 = await member('fl-note-r3', 'r3')
    await insertRequest(r3.userId, me.userId, 'pending', addDays(nowIso(), -31))
    const r4 = await member('fl-note-r4', 'r4')
    await insertRequest(r4.userId, me.userId, 'declined')
    const html = await (await get('/settings', me.cookie)).text()
    expect(html).toContain('<span class="note">1 人・申請 2 件</span>')
  })
})

describe('承認・断る・取り消す', () => {
  it('承認 → friendship が user_lo < user_hi の 1 行、申請は accepted。二重承認は 404 で 1 行のまま', async () => {
    const me = await member('fl-accept', 'わたし')
    const from = await member('fl-accept-from', 'しんせい')
    const id = await insertRequest(from.userId, me.userId, 'pending')
    const res = await post(`/settings/friends/requests/${id}/accept`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expectPrivate(res)
    expect(await statusOf(id)).toBe('accepted')
    const rows = await friendshipOf(me.userId, from.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0].user_lo < rows[0].user_hi).toBe(true)

    const again = await post(`/settings/friends/requests/${id}/accept`, me.cookie)
    expect(again.status).toBe(404)
    expect(await friendshipOf(me.userId, from.userId)).toHaveLength(1)

    // 両方の一覧にフレンドとして出る
    expect(await settingsHtml(me.cookie)).toContain('<span>しんせい</span>')
    expect(await settingsHtml(from.cookie)).toContain('<span>わたし</span>')
  })

  it('他人宛て・他人からの申請 id、無い id は承認・断る・取り消すとも 404 で状態が変わらない', async () => {
    const me = await member('fl-other', 'わたし')
    const a = await member('fl-other-a', 'えー')
    const b = await member('fl-other-b', 'びー')
    const id = await insertRequest(a.userId, b.userId, 'pending')
    for (const action of ['accept', 'decline', 'cancel']) {
      const res = await post(`/settings/friends/requests/${id}/${action}`, me.cookie)
      expect(res.status).toBe(404)
      expectPrivate(res)
      expect(await statusOf(id)).toBe('pending')
      expect((await post(`/settings/friends/requests/${ulid()}/${action}`, me.cookie)).status).toBe(
        404,
      )
    }
    // 送った側は承認・断るができず、受けた側は取り消せない
    expect((await post(`/settings/friends/requests/${id}/accept`, a.cookie)).status).toBe(404)
    expect((await post(`/settings/friends/requests/${id}/decline`, a.cookie)).status).toBe(404)
    expect((await post(`/settings/friends/requests/${id}/cancel`, b.cookie)).status).toBe(404)
    expect(await statusOf(id)).toBe('pending')
    expect(await friendshipOf(a.userId, b.userId)).toEqual([])
  })

  it('断る → declined。送った側の一覧と招待リンクの画面は「申請中」のまま。取り消すと canceled', async () => {
    const me = await member('fl-decline', 'うけて')
    const code = randomCode(16)
    await env.DB.prepare('UPDATE user SET friend_code = ? WHERE id = ?').bind(code, me.userId).run()
    const from = await member('fl-decline-from', 'おくりて')
    const id = await insertRequest(from.userId, me.userId, 'pending')

    // 送った側の招待リンクの画面には「取り消す」
    const inviteHtml = await (await get(`/f/${code}`, from.cookie)).text()
    expect(inviteHtml).toContain(`action="/settings/friends/requests/${id}/cancel"`)

    const res = await post(`/settings/friends/requests/${id}/decline`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expect(await statusOf(id)).toBe('declined')
    expect(await settingsHtml(me.cookie)).not.toContain('おくりて')
    // 断ったあとは承認できない
    expect((await post(`/settings/friends/requests/${id}/accept`, me.cookie)).status).toBe(404)

    const outHtml = await settingsHtml(from.cookie)
    expect(outHtml).toContain('送った申請（1）')
    expect(outHtml).toContain('うけて')
    expect(outHtml).toContain(`action="/settings/friends/requests/${id}/cancel"`)
    const after = await (await get(`/f/${code}`, from.cookie)).text()
    expect(after).toContain('うけてさんに申請を送ってあります。')
    expect(after).toContain(`action="/settings/friends/requests/${id}/cancel"`)

    const cancel = await post(`/settings/friends/requests/${id}/cancel`, from.cookie)
    expect(cancel.status).toBe(302)
    expect(cancel.headers.get('location')).toBe('/settings/friends')
    expect(await statusOf(id)).toBe('canceled')
    expect(await settingsHtml(from.cookie)).not.toContain('送った申請（')
    // 取り消し済みはもう一度取り消せない
    expect((await post(`/settings/friends/requests/${id}/cancel`, from.cookie)).status).toBe(404)
  })

  it('招待リンクの画面: 届いている申請に「承認」「断る」が出て、承認できる', async () => {
    const me = await member('fl-invite-in', 'わたし')
    const inv = await member('fl-invite-in-inv', 'しょうたい')
    const code = randomCode(16)
    await env.DB.prepare('UPDATE user SET friend_code = ? WHERE id = ?')
      .bind(code, inv.userId)
      .run()
    const id = await insertRequest(inv.userId, me.userId, 'pending')
    const html = await (await get(`/f/${code}`, me.cookie)).text()
    expect(html).toContain('しょうたいさんから申請が届いています。')
    expect(html).toContain(`action="/settings/friends/requests/${id}/accept"`)
    expect(html).toContain(`action="/settings/friends/requests/${id}/decline"`)
    expect((await post(`/settings/friends/requests/${id}/accept`, me.cookie)).status).toBe(302)
    expect(await friendshipOf(me.userId, inv.userId)).toHaveLength(1)
  })

  it('同じ相手への有効な申請が 2 行あっても一覧は 1 行。取り消すと両方 canceled', async () => {
    const me = await member('fl-two', 'わたし')
    const to = await member('fl-two-to', 'あいて')
    const oldId = await insertRequest(me.userId, to.userId, 'declined', addDays(nowIso(), -10))
    const newId = await insertRequest(me.userId, to.userId, 'pending')
    const html = await settingsHtml(me.cookie)
    expect(html).toContain('送った申請（1）')
    expect(html).toContain(`requests/${newId}/cancel`)
    expect(html).not.toContain(`requests/${oldId}/cancel`)
    expect((await post(`/settings/friends/requests/${newId}/cancel`, me.cookie)).status).toBe(302)
    expect(await statusOf(oldId)).toBe('canceled')
    expect(await statusOf(newId)).toBe('canceled')
  })
})

describe('フレンド解除', () => {
  it('確認画面 → 解除で friendship が消え、相手の一覧からも消える', async () => {
    const me = await member('fl-remove', 'わたし')
    const f = await member('fl-remove-f', 'かいじょ')
    await makeFriends(me.userId, f.userId)
    const page = await get(`/friends/${f.userId}/manage`, me.cookie)
    expect(page.status).toBe(200)
    expectPrivate(page)
    const html = await page.text()
    expect(html).toContain('かいじょさんとのフレンドを解除しますか？')
    expect(html).toContain(`action="/friends/${f.userId}/remove"`)

    const res = await post(`/friends/${f.userId}/remove`, me.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings/friends')
    expectPrivate(res)
    expect(await friendshipOf(me.userId, f.userId)).toEqual([])
    expect(await settingsHtml(me.cookie)).not.toContain('かいじょ')
    expect(await settingsHtml(f.cookie)).not.toContain('わたし</span>')
    // もう一度は 404、確認画面も 404
    expect((await post(`/friends/${f.userId}/remove`, me.cookie)).status).toBe(404)
    expect((await get(`/friends/${f.userId}/manage`, me.cookie)).status).toBe(404)
  })

  it('フレンドでない相手・自分・無い id は確認画面も解除も 404。他人どうしの friendship は残る', async () => {
    const me = await member('fl-remove-404', 'わたし')
    const a = await member('fl-remove-404-a', 'えー')
    const b = await member('fl-remove-404-b', 'びー')
    await makeFriends(a.userId, b.userId)
    for (const id of [a.userId, me.userId, ulid()]) {
      expect((await get(`/friends/${id}/manage`, me.cookie)).status).toBe(404)
      expect((await post(`/friends/${id}/remove`, me.cookie)).status).toBe(404)
    }
    expect(await friendshipOf(a.userId, b.userId)).toHaveLength(1)
  })

  it('退会した相手は一覧に出ない', async () => {
    const me = await member('fl-deleted', 'わたし')
    const f = await member('fl-deleted-f', 'たいかい')
    await makeFriends(me.userId, f.userId)
    await env.DB.prepare('UPDATE user SET deleted_at = ? WHERE id = ?')
      .bind(nowIso(), f.userId)
      .run()
    expect(await settingsHtml(me.cookie)).not.toContain('たいかい')
    expect((await get(`/friends/${f.userId}/manage`, me.cookie)).status).toBe(404)
  })
})

describe('認証・CSRF・agent', () => {
  it('未ログインは GET 302 /login、POST 401', async () => {
    const id = ulid()
    const res = await get(`/friends/${id}/manage`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expectPrivate(res)
    for (const path of [
      `/settings/friends/requests/${id}/accept`,
      `/settings/friends/requests/${id}/decline`,
      `/settings/friends/requests/${id}/cancel`,
      `/friends/${id}/remove`,
    ]) {
      expect((await post(path)).status).toBe(401)
    }
  })

  it('Origin の無い POST は 403 で状態が変わらない', async () => {
    const me = await member('fl-csrf', 'わたし')
    const from = await member('fl-csrf-from', 'しんせい')
    const id = await insertRequest(from.userId, me.userId, 'pending')
    const res = await post(`/settings/friends/requests/${id}/accept`, me.cookie, {})
    expect(res.status).toBe(403)
    expect(await statusOf(id)).toBe('pending')
    await makeFriends(me.userId, from.userId)
    expect((await post(`/friends/${from.userId}/remove`, me.cookie, {})).status).toBe(403)
    expect(await friendshipOf(me.userId, from.userId)).toHaveLength(1)
  })

  it('agent トークン（Authorization）は 403', async () => {
    const id = ulid()
    const auth = { Authorization: 'Bearer x' }
    expect((await get(`/friends/${id}/manage`, undefined, auth)).status).toBe(403)
    expect(
      (
        await post(`/settings/friends/requests/${id}/accept`, undefined, {
          ...auth,
          Origin: ORIGIN,
        })
      ).status,
    ).toBe(403)
  })
})
