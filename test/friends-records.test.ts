import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { deleteAccount } from '../src/auth/account'
import { createDb } from '../src/db/client'
import { scopedTo } from '../src/db/scoped'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { nowIso } from '../src/lib/time'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertWork } from './helpers/master'
import { insertAttempt, insertSession } from './helpers/records'

const db = createDb(env.DB)

const get = (path: string, cookie?: string, extra: Record<string, string> = {}) =>
  app.request(path, { headers: { ...extra, ...(cookie ? { Cookie: cookie } : {}) } }, env)

const post = (path: string, cookie: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: '',
    },
    env,
  )

// ログインして表示名を決める（見出しの文字列で確かめるため）
const member = async (subject: string, name: string, owner = false) => {
  const u = await loginAs(env, { subject, owner })
  await env.DB.prepare('UPDATE user SET display_name = ? WHERE id = ?').bind(name, u.userId).run()
  return { ...u, name }
}

const makeFriends = (a: string, b: string) =>
  env.DB.prepare('INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)')
    .bind(a < b ? a : b, a < b ? b : a, nowIso())
    .run()

const blockUser = (from: string, to: string) =>
  env.DB.prepare('INSERT INTO block (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)')
    .bind(from, to, nowIso())
    .run()

const expectPrivate = (res: Response) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store')
  expect(res.headers.get('x-robots-tag')).toBe('noindex')
}

// 一覧の作品名の並び（Ticket の title）
const titlesOf = (html: string) =>
  [...html.matchAll(/<span class="title">([^<]*)<\/span>/g)].map((m) => m[1])

describe('GET /friends/:userId（フレンドの記録一覧）', () => {
  it('フレンドの記録を作品名・形式・ステータス・日付だけで出す。作品ページへリンクし、manage へ行ける', async () => {
    const me = await member('fr-view-me', 'わたし')
    const fr = await member('fr-view-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const work = await insertWork(env, { title: '友の作品', kind: 'room' })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: work,
      status: 'cleared',
      finishedOn: '2026-10-05',
    })
    const res = await get(`/friends/${fr.userId}`, me.cookie)
    expect(res.status).toBe(200)
    expectPrivate(res)
    const html = await res.text()
    expect(html).toContain('ともだちさんの記録')
    expect(html).toContain('友の作品')
    expect(html).toContain(`href="/works/${work}"`)
    expect(html).toContain('ルーム')
    expect(html).toContain('st-cleared')
    expect(html).toContain('2026.10')
    expect(html).toContain(`href="/friends/${fr.userId}/manage"`)
    // 記録詳細へのリンクは無い
    expect(html).not.toMatch(/href="\/records\/[0-9A-Z]{26}"/)
  })

  it('0 件は「まだ記録はありません。」', async () => {
    const me = await member('fr-empty-me', 'わたし')
    const fr = await member('fr-empty-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const html = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(html).toContain('まだ記録はありません。')
  })

  it('メモ・ネタバレ・同行者・評価・難易度・物量・買った日・進行ログの本文は HTML に一切出ない', async () => {
    const me = await member('fr-secret-me', 'わたし')
    const fr = await member('fr-secret-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const work = await insertWork(env, { title: '秘密の作品', kind: 'takeaway' })
    const a = await insertAttempt(env, {
      userId: fr.userId,
      workId: work,
      status: 'cleared',
      purchasedOn: '2031-03-03',
      startedOn: '2026-09-01',
      finishedOn: '2026-09-02',
      durationSec: 7777,
      partySize: 9,
      companions: 'MARK-COMPANIONS',
      rating: 5,
      difficulty: 4,
      volume: 3,
      memo: 'MARK-MEMO',
      spoilerMemo: 'MARK-SPOILER',
    })
    await insertSession(env, {
      attemptId: a,
      userId: fr.userId,
      playedOn: '2026-09-01',
      progressNote: 'MARK-PROGRESS',
      memo: 'MARK-SESSION-MEMO',
    })
    const html = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(html).toContain('秘密の作品')
    expect(html).not.toContain('MARK-')
    expect(html).not.toContain('2031')
    expect(html).not.toContain(a)
    expect(html).not.toContain('難易度')
    expect(html).not.toContain('同行')
    expect(html).not.toContain('回目')
  })

  it('FriendAttemptStatus のキーは 6 つだけ', async () => {
    const me = await member('fr-keys-me', 'わたし')
    const fr = await member('fr-keys-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const work = await insertWork(env, { title: 'キーの作品' })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: work,
      status: 'failed',
      memo: 'x',
      spoilerMemo: 'y',
      rating: 1,
    })
    const repo = await scopedTo(db, me.userId).asFriendOf(fr.userId)
    if (!repo) throw new Error('asFriendOf が null')
    const { items } = await repo.listAttempts({ page: 1 })
    expect(items).toHaveLength(1)
    expect(Object.keys(items[0]).sort()).toEqual(
      ['finishedOn', 'startedOn', 'status', 'workId', 'workKind', 'workTitle'].sort(),
    )
    expect(items[0]).toEqual({
      workId: work,
      workTitle: 'キーの作品',
      workKind: null,
      status: 'failed',
      startedOn: null,
      finishedOn: null,
    })
  })

  it('買った（日付は purchased_on だけ）は「日付なし」。並びは finished_on → started_on の降順、日付なしは最後', async () => {
    const me = await member('fr-order-me', 'わたし')
    const fr = await member('fr-order-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const w = async (title: string) => insertWork(env, { title })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await w('買った作品'),
      status: 'purchased',
      purchasedOn: '2026-12-01',
    })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await w('九月に始めた'),
      status: 'in_progress',
      startedOn: '2026-09-10',
    })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await w('十月に終えた'),
      status: 'cleared',
      startedOn: '2026-01-01',
      finishedOn: '2026-10-01',
    })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await w('八月に終えた'),
      status: 'dropped',
      finishedOn: '2026-08-01',
    })
    // 同じ日付なら created_at の降順（後から入れた方が先）
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await w('十月に終えた2'),
      status: 'failed',
      finishedOn: '2026-10-01',
    })
    const html = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(titlesOf(html)).toEqual([
      '十月に終えた2',
      '十月に終えた',
      '九月に始めた',
      '八月に終えた',
      '買った作品',
    ])
    expect(html).toContain('class="nd"')
    expect(html).not.toContain('2026.12')
  })

  it('51 件で次ページ。2 ページ目に残りの 1 件', async () => {
    const me = await member('fr-page-me', 'わたし')
    const fr = await member('fr-page-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const work = await insertWork(env, { title: 'ページの作品' })
    for (let i = 1; i <= 51; i++) {
      await insertAttempt(env, {
        userId: fr.userId,
        workId: work,
        status: 'cleared',
        attemptNo: i,
        finishedOn: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      })
    }
    const p1 = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(titlesOf(p1)).toHaveLength(50)
    expect(p1).toContain(`href="/friends/${fr.userId}?page=2"`)
    const p2 = await (await get(`/friends/${fr.userId}?page=2`, me.cookie)).text()
    expect(titlesOf(p2)).toHaveLength(1)
    expect(p2).not.toContain('?page=3')
  })

  it('share_override = hidden の記録と、default_share_level = none の相手の記録は出さない', async () => {
    const me = await member('fr-share-me', 'わたし')
    const fr = await member('fr-share-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const hidden = await insertAttempt(env, {
      userId: fr.userId,
      workId: await insertWork(env, { title: '隠した作品' }),
      status: 'cleared',
    })
    await insertAttempt(env, {
      userId: fr.userId,
      workId: await insertWork(env, { title: '見せる作品' }),
      status: 'cleared',
    })
    await env.DB.prepare("UPDATE attempt SET share_override = 'hidden' WHERE id = ?")
      .bind(hidden)
      .run()
    const html = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(titlesOf(html)).toEqual(['見せる作品'])

    await env.DB.prepare("UPDATE user SET default_share_level = 'none' WHERE id = ?")
      .bind(fr.userId)
      .run()
    const none = await (await get(`/friends/${fr.userId}`, me.cookie)).text()
    expect(titlesOf(none)).toEqual([])
    expect(none).toContain('まだ記録はありません。')
  })

  it('他のフレンドの記録・自分の記録は混ざらない', async () => {
    const me = await member('fr-mix-me', 'わたし')
    const a = await member('fr-mix-a', 'えー')
    const b = await member('fr-mix-b', 'びー')
    await makeFriends(me.userId, a.userId)
    await makeFriends(me.userId, b.userId)
    await insertAttempt(env, {
      userId: a.userId,
      workId: await insertWork(env, { title: 'Aの作品' }),
      status: 'cleared',
    })
    await insertAttempt(env, {
      userId: b.userId,
      workId: await insertWork(env, { title: 'Bの作品' }),
      status: 'cleared',
    })
    await insertAttempt(env, {
      userId: me.userId,
      workId: await insertWork(env, { title: '自分の作品' }),
      status: 'cleared',
    })
    expect(titlesOf(await (await get(`/friends/${a.userId}`, me.cookie)).text())).toEqual([
      'Aの作品',
    ])
    expect(titlesOf(await (await get(`/friends/${b.userId}`, me.cookie)).text())).toEqual([
      'Bの作品',
    ])
  })
})

describe('GET /friends/:userId の認可', () => {
  it('フレンドでない・申請中・ブロック（両方向）・自分自身・無い id・退会済みは、すべて同じ 404', async () => {
    const me = await member('fr-auth-me', 'わたし')
    const stranger = await member('fr-auth-stranger', 'しらないひと')
    const pending = await member('fr-auth-pending', 'しんせいちゅう')
    const blockedByMe = await member('fr-auth-bme', 'ぶろっくした')
    const blockedMe = await member('fr-auth-bby', 'ぶろっくされた')
    const gone = await member('fr-auth-gone', 'たいかい')
    for (const u of [stranger, pending, blockedByMe, blockedMe, gone]) {
      await insertAttempt(env, {
        userId: u.userId,
        workId: await insertWork(env, { title: `${u.name}の作品` }),
        status: 'cleared',
      })
    }
    await env.DB.prepare(
      "INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    )
      .bind(ulid(), me.userId, pending.userId, nowIso())
      .run()
    // ブロックは friendship を消すが、行が残っていても block が勝つことを確かめる
    await makeFriends(me.userId, blockedByMe.userId)
    await blockUser(me.userId, blockedByMe.userId)
    await makeFriends(me.userId, blockedMe.userId)
    await blockUser(blockedMe.userId, me.userId)
    await makeFriends(me.userId, gone.userId)
    await deleteAccount(db, gone.userId)

    const ids = [
      stranger.userId,
      pending.userId,
      blockedByMe.userId,
      blockedMe.userId,
      me.userId,
      ulid(),
      gone.userId,
    ]
    const bodies: string[] = []
    for (const id of ids) {
      const res = await get(`/friends/${id}`, me.cookie)
      expect(res.status).toBe(404)
      expectPrivate(res)
      const html = await res.text()
      expect(html).not.toContain('の作品')
      expect(html).not.toContain('さんの記録')
      bodies.push(html)
    }
    expect(new Set(bodies).size).toBe(1)
  })

  it('退会済み: friendship の行が残っていても 404（asFriendOf が deleted_at を見る）', async () => {
    const me = await member('fr-del-me', 'わたし')
    const fr = await member('fr-del-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    await env.DB.prepare('UPDATE user SET deleted_at = ? WHERE id = ?')
      .bind(nowIso(), fr.userId)
      .run()
    expect(await scopedTo(db, me.userId).asFriendOf(fr.userId)).toBeNull()
    expect((await get(`/friends/${fr.userId}`, me.cookie)).status).toBe(404)
  })

  it('解除した直後に見えなくなる（どちらの側からも）', async () => {
    const me = await member('fr-rm-me', 'わたし')
    const fr = await member('fr-rm-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    expect((await get(`/friends/${fr.userId}`, me.cookie)).status).toBe(200)
    expect((await get(`/friends/${me.userId}`, fr.cookie)).status).toBe(200)
    const res = await post(`/friends/${fr.userId}/remove`, me.cookie)
    expect(res.status).toBe(302)
    expect((await get(`/friends/${fr.userId}`, me.cookie)).status).toBe(404)
    expect((await get(`/friends/${me.userId}`, fr.cookie)).status).toBe(404)
  })

  it('ブロックした直後に見えなくなる（どちらの側からも）', async () => {
    const me = await member('fr-bk-me', 'わたし')
    const fr = await member('fr-bk-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    expect((await post(`/friends/${fr.userId}/block`, me.cookie)).status).toBe(302)
    expect((await get(`/friends/${fr.userId}`, me.cookie)).status).toBe(404)
    expect((await get(`/friends/${me.userId}`, fr.cookie)).status).toBe(404)
  })

  it('オーナーでもフレンドでなければ 404', async () => {
    const owner = await member('fr-owner', 'おーなー', true)
    const fr = await member('fr-owner-target', 'だれか')
    expect((await get(`/friends/${fr.userId}`, owner.cookie)).status).toBe(404)
  })

  it('未ログインは 302 /login（応答は private, no-store）。Bearer は 403', async () => {
    const fr = await member('fr-anon-target', 'だれか')
    const anon = await get(`/friends/${fr.userId}`)
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe('/login')
    expectPrivate(anon)
    const bearer = await get(`/friends/${fr.userId}`, undefined, {
      Authorization: 'Bearer nzt_dummy',
    })
    expect(bearer.status).toBe(403)
  })
})

describe('/friends/:userId への導線', () => {
  it('フレンド一覧の表示名は /friends/:userId へのリンク', async () => {
    const me = await member('fr-link-me', 'わたし')
    const fr = await member('fr-link-fr', 'りんく')
    await makeFriends(me.userId, fr.userId)
    const html = await (await get('/settings/friends', me.cookie)).text()
    expect(html).toContain(`href="/friends/${fr.userId}"`)
  })

  it('フレンド済みの招待リンクは /friends/:userId へ 302 し、その先は 200', async () => {
    const me = await member('fr-inv-me', 'わたし')
    const fr = await member('fr-inv-fr', 'ともだち')
    await makeFriends(me.userId, fr.userId)
    const code = 'abcdefghijkmnpqr'
    await env.DB.prepare('UPDATE user SET friend_code = ? WHERE id = ?').bind(code, fr.userId).run()
    const res = await get(`/f/${code}`, me.cookie)
    expect(res.status).toBe(302)
    const to = res.headers.get('location') ?? ''
    expect(to).toBe(`/friends/${fr.userId}`)
    expect((await get(to, me.cookie)).status).toBe(200)
  })
})
