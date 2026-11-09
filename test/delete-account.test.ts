import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const postDelete = (cookie: string | undefined, body: Record<string, string>) =>
  app.request(
    '/settings/delete',
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(body).toString(),
    },
    env,
  )

const now = new Date().toISOString()

const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .run()

const count = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0

const userRow = (id: string) =>
  env.DB.prepare('SELECT display_name, role, friend_code, deleted_at FROM user WHERE id = ?')
    .bind(id)
    .first<{
      display_name: string
      role: string
      friend_code: string | null
      deleted_at: string | null
    }>()

// 本人 me と他人 other のそれぞれに、退会で消える全テーブルの行を入れる。third は関係だけを持つ第三者
const seed = async (p: string, me: string, other: string, third: string) => {
  await run(`UPDATE user SET friend_code = ? WHERE id = ?`, `${p}-code`, me)
  await run(
    'INSERT INTO work (id, title, title_norm, created_at, updated_at) VALUES (?1, ?1, ?1, ?2, ?2)',
    `${p}-w`,
    now,
  )
  await run('INSERT INTO genre (id, label, sort_order) VALUES (?1, ?1, 1)', `${p}-g`)
  await run('INSERT INTO market (id, name, name_norm) VALUES (?1, ?1, ?1)', `${p}-m`)
  await run(
    'INSERT INTO market_edition (id, market_id, label) VALUES (?1, ?2, ?1)',
    `${p}-me`,
    `${p}-m`,
  )
  for (const [tag, uid] of [
    ['me', me],
    ['ot', other],
  ] as const) {
    const a = `${p}-a-${tag}`
    await run(
      "INSERT INTO attempt (id, user_id, work_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'cleared', ?4, ?4)",
      a,
      uid,
      `${p}-w`,
      now,
    )
    await run(
      'INSERT INTO attempt_genre (attempt_id, genre_id, user_id) VALUES (?, ?, ?)',
      a,
      `${p}-g`,
      uid,
    )
    await run(
      'INSERT INTO session (id, attempt_id, user_id, played_on, created_at) VALUES (?, ?, ?, ?, ?)',
      `${p}-s-${tag}`,
      a,
      uid,
      now.slice(0, 10),
      now,
    )
    await run(
      "INSERT INTO image (id, user_id, attempt_id, kind, r2_key, bytes, content_type, created_at) VALUES (?1, ?2, ?3, 'other', ?1, 1, 'image/jpeg', ?4)",
      `${p}-i-${tag}`,
      uid,
      a,
      now,
    )
    await run(
      'INSERT INTO wishlist (user_id, work_id, created_at) VALUES (?, ?, ?)',
      uid,
      `${p}-w`,
      now,
    )
    await run(
      'INSERT INTO market_visit (id, user_id, market_edition_id, visited_on) VALUES (?, ?, ?, ?)',
      `${p}-mv-${tag}`,
      uid,
      `${p}-me`,
      now.slice(0, 10),
    )
    await run('INSERT INTO recovery_code (user_id, code_hash) VALUES (?, ?)', uid, `${p}-rc-${tag}`)
    await run(
      "INSERT INTO oauth_state (state, provider, code_verifier, mode, user_id, expires_at) VALUES (?1, 'google', ?1, 'link', ?2, ?3)",
      `${p}-os-${tag}`,
      uid,
      '2999-01-01T00:00:00.000Z',
    )
    await run(
      "INSERT INTO request (id, requester_user_id, kind, payload_json, created_at, updated_at) VALUES (?, ?, 'other', '{}', ?, ?)",
      `${p}-rq-${tag}`,
      uid,
      now,
      now,
    )
  }
  // 自分が他人の画像を通報 / 他人が自分の画像を通報 / 他人が他人の画像を通報
  await run(
    'INSERT INTO image_report (id, image_id, reporter_user_id, created_at) VALUES (?, ?, ?, ?)',
    `${p}-ir-1`,
    `${p}-i-ot`,
    me,
    now,
  )
  await run(
    'INSERT INTO image_report (id, image_id, reporter_user_id, created_at) VALUES (?, ?, ?, ?)',
    `${p}-ir-2`,
    `${p}-i-me`,
    other,
    now,
  )
  await run(
    'INSERT INTO image_report (id, image_id, reporter_user_id, created_at) VALUES (?, ?, ?, ?)',
    `${p}-ir-3`,
    `${p}-i-ot`,
    third,
    now,
  )
  const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x])
  for (const [x, y] of [
    [me, other],
    [me, third],
    [other, third],
  ]) {
    await run(
      'INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)',
      ...pair(x, y),
      now,
    )
  }
  for (const [i, from, to] of [
    [1, me, third],
    [2, third, me],
    [3, other, third],
  ] as const) {
    await run(
      "INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      `${p}-fr-${i}`,
      from,
      to,
      now,
    )
  }
  for (const [from, to] of [
    [me, third],
    [third, me],
    [other, third],
  ]) {
    await run(
      'INSERT INTO block (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)',
      from,
      to,
      now,
    )
  }
}

// 本人が関わる行の数（テーブルごと）
const ownRows = async (uid: string) => ({
  image_report: await count(
    'SELECT COUNT(*) AS n FROM image_report WHERE reporter_user_id = ?',
    uid,
  ),
  image: await count('SELECT COUNT(*) AS n FROM image WHERE user_id = ?', uid),
  session: await count('SELECT COUNT(*) AS n FROM session WHERE user_id = ?', uid),
  attempt_genre: await count('SELECT COUNT(*) AS n FROM attempt_genre WHERE user_id = ?', uid),
  attempt: await count('SELECT COUNT(*) AS n FROM attempt WHERE user_id = ?', uid),
  wishlist: await count('SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ?', uid),
  market_visit: await count('SELECT COUNT(*) AS n FROM market_visit WHERE user_id = ?', uid),
  friendship: await count(
    'SELECT COUNT(*) AS n FROM friendship WHERE user_lo = ?1 OR user_hi = ?1',
    uid,
  ),
  friend_request: await count(
    'SELECT COUNT(*) AS n FROM friend_request WHERE from_user_id = ?1 OR to_user_id = ?1',
    uid,
  ),
  block: await count(
    'SELECT COUNT(*) AS n FROM block WHERE user_id = ?1 OR blocked_user_id = ?1',
    uid,
  ),
  recovery_code: await count('SELECT COUNT(*) AS n FROM recovery_code WHERE user_id = ?', uid),
  oauth_state: await count('SELECT COUNT(*) AS n FROM oauth_state WHERE user_id = ?', uid),
  session_token: await count('SELECT COUNT(*) AS n FROM session_token WHERE user_id = ?', uid),
  identity: await count('SELECT COUNT(*) AS n FROM identity WHERE user_id = ?', uid),
  request: await count('SELECT COUNT(*) AS n FROM request WHERE requester_user_id = ?', uid),
})

describe('GET /settings/delete', () => {
  it('未ログインは 302 /login', async () => {
    const res = await get('/settings/delete')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('member には確認のフォームを出す', async () => {
    const { cookie } = await loginAs(env, { subject: 'del-get-member' })
    const res = await get('/settings/delete', cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<input type="checkbox" name="confirm" value="yes"')
    expect(html).toContain('class="btn danger"')
    expect(html).toContain('新規ユーザーになります')
    expect(html).toContain('匿名化して残ります')
    expect(html).toContain('この操作は元に戻せません。')
  })

  it('owner にはフォームを出さない', async () => {
    const { cookie } = await loginAs(env, { subject: 'del-get-owner', owner: true })
    const html = await (await get('/settings/delete', cookie)).text()
    expect(html).toContain('オーナーは退会できません')
    expect(html).not.toContain('name="confirm"')
  })

  it('/settings に退会へのリンクがある', async () => {
    const { cookie } = await loginAs(env, { subject: 'del-link' })
    const html = await (await get('/settings', cookie)).text()
    expect(html).toContain('href="/settings/delete"')
  })
})

describe('POST /settings/delete', () => {
  it('未ログインは 401', async () => {
    expect((await postDelete(undefined, { confirm: 'yes' })).status).toBe(401)
  })

  it('Origin が違えば 403（CSRF）', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'del-csrf' })
    const res = await app.request(
      '/settings/delete',
      {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'confirm=yes',
      },
      env,
    )
    expect(res.status).toBe(403)
    expect((await userRow(userId))?.deleted_at).toBeNull()
  })

  it('confirm が無ければ 400 で同じページにエラー、行は変わらない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'del-noconfirm' })
    const res = await postDelete(cookie, {})
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('role="alert"')
    expect(html).toContain('name="confirm"')
    expect((await userRow(userId))?.deleted_at).toBeNull()
    expect((await get('/records', cookie)).status).toBe(200)
  })

  it('owner は 400、行は変わらない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'del-owner', owner: true })
    const before = await userRow(userId)
    const res = await postDelete(cookie, { confirm: 'yes' })
    expect(res.status).toBe(400)
    expect(await userRow(userId)).toEqual(before)
    expect(before?.role).toBe('owner')
    expect((await ownRows(userId)).identity).toBe(1)
    expect((await get('/records', cookie)).status).toBe(200)
  })

  it('member の退会: 本人の行が消え、他人の行は残る', async () => {
    const { cookie, userId: me } = await loginAs(env, { subject: 'del-me' })
    const { userId: other } = await loginAs(env, { subject: 'del-other' })
    const { userId: third } = await loginAs(env, { subject: 'del-third' })
    await seed('del', me, other, third)
    const otherBefore = await ownRows(other)
    const thirdBefore = await ownRows(third)

    const res = await postDelete(cookie, { confirm: 'yes' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?deleted=1')
    expect(
      res.headers.getSetCookie().some((sc) => sc.startsWith('session=;') && /Max-Age=0/.test(sc)),
    ).toBe(true)

    expect(await ownRows(me)).toEqual(
      Object.fromEntries(Object.keys(otherBefore).map((k) => [k, 0])),
    )

    // other: 自分とのフレンド関係と、自分の画像への通報（画像の削除で cascade）だけが減る
    expect(await ownRows(other)).toEqual({
      ...otherBefore,
      friendship: otherBefore.friendship - 1,
      image_report: otherBefore.image_report - 1,
    })
    // third: 自分との friendship・friend_request（往復 2 件）・block（往復 2 件）だけが減り、
    // other との分は残る
    expect(await ownRows(third)).toEqual({
      ...thirdBefore,
      friendship: thirdBefore.friendship - 1,
      friend_request: thirdBefore.friend_request - 2,
      block: thirdBefore.block - 2,
    })
    expect(await count("SELECT COUNT(*) AS n FROM image_report WHERE id = 'del-ir-3'")).toBe(1)
    expect(await count("SELECT COUNT(*) AS n FROM image_report WHERE id LIKE 'del-ir-%'")).toBe(1)
    expect(await count("SELECT COUNT(*) AS n FROM friend_request WHERE id = 'del-fr-3'")).toBe(1)
    expect(
      await count(
        'SELECT COUNT(*) AS n FROM block WHERE user_id = ? AND blocked_user_id = ?',
        other,
        third,
      ),
    ).toBe(1)

    // request は匿名化して残る
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM request WHERE id = 'del-rq-me' AND requester_user_id IS NULL",
      ),
    ).toBe(1)

    const u = await userRow(me)
    expect(u?.deleted_at).not.toBeNull()
    expect(u?.display_name).toBe('退会したユーザー')
    expect(u?.friend_code).toBeNull()
  })

  it('退会後の cookie は未ログイン扱い、同じ subject で再ログインすると新しい user', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'del-relogin' })
    expect((await postDelete(cookie, { confirm: 'yes' })).status).toBe(302)

    const res = await get('/records', cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')

    const again = await loginAs(env, { subject: 'del-relogin' })
    expect(again.userId).not.toBe(userId)
    expect((await userRow(again.userId))?.deleted_at).toBeNull()
  })

  it('/login?deleted=1 で退会のメッセージ', async () => {
    const html = await (await get('/login?deleted=1')).text()
    expect(html).toContain('退会しました。')
  })
})
