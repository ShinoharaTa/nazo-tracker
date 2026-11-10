import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { ulid } from '../src/lib/id'
import { loginAs, ORIGIN } from './helpers/auth'
import {
  insertOrg,
  insertOrgAlias,
  insertRun,
  insertShop,
  insertVenue,
  insertWork,
  insertWorkAlias,
} from './helpers/master'

const get = (path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { Cookie: cookie } : {} }, env)

const post = (path: string, form: Record<string, string>, cookie?: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams(form).toString(),
    },
    env,
  )

const NOW = '2026-01-01T00:00:00.000Z'

const exec = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run()

const count = async (sql: string, ...params: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...params)
      .first<{ n: number }>()
  )?.n ?? 0

const row = <T = Record<string, unknown>>(table: string, id: string) =>
  env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<T>()

type LogRow = {
  table_name: string
  row_id: string
  action: string
  before_json: string | null
  after_json: string | null
}

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ? ORDER BY id')
      .bind(rowId)
      .all<LogRow>()
  ).results

const logCount = () => count('SELECT COUNT(*) AS n FROM change_log')

const insertAttempt = async (userId: string, workId: string, runId?: string) => {
  const id = ulid()
  await exec(
    "INSERT INTO attempt (id, user_id, work_id, run_id, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'cleared', ?5, ?5)",
    id,
    userId,
    workId,
    runId ?? null,
    NOW,
  )
  return id
}

const insertWishlist = (userId: string, workId: string, memo?: string) =>
  exec(
    'INSERT INTO wishlist (user_id, work_id, memo, created_at) VALUES (?, ?, ?, ?)',
    userId,
    workId,
    memo ?? null,
    NOW,
  )

const insertMarketEdition = async (venueId?: string) => {
  const marketId = ulid()
  await exec('INSERT INTO market (id, name, name_norm) VALUES (?1, ?1, ?1)', marketId)
  const id = ulid()
  await exec(
    'INSERT INTO market_edition (id, market_id, label, venue_id) VALUES (?, ?, ?, ?)',
    id,
    marketId,
    '第1回',
    venueId ?? null,
  )
  return id
}

const insertBooth = async (organizationId?: string) => {
  const id = ulid()
  await exec(
    'INSERT INTO booth (id, market_edition_id, organization_id, name_as_listed) VALUES (?, ?, ?, ?)',
    id,
    await insertMarketEdition(),
    organizationId ?? null,
    '出店名',
  )
  return id
}

const insertBoothItem = async (workId: string) => {
  const id = ulid()
  await exec(
    'INSERT INTO booth_item (id, booth_id, work_id, title_as_listed) VALUES (?, ?, ?, ?)',
    id,
    await insertBooth(),
    workId,
    '頒布物',
  )
  return id
}

let owner: { cookie: string; userId: string }
let member: { cookie: string; userId: string }
let other: { userId: string }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'mg-owner', owner: true })
  member = await loginAs(env, { subject: 'mg-member' })
  other = await loginAs(env, { subject: 'mg-other' })
})

describe('作品の統合', () => {
  it('FK を全部 B に付け替え、旧題を別名に、official_url を引き継ぎ、change_log に merge 1 行', async () => {
    const a = await insertWork(env, {
      title: '統合元の謎',
      kind: 'room',
      officialUrl: 'https://example.com/merge-a',
    })
    const b = await insertWork(env, { title: '統合先の謎', kind: 'room' })
    const r1 = await insertRun(env, { workId: a, channel: 'online' })
    const r2 = await insertRun(env, { workId: a, channel: 'online' })
    const al = await insertWorkAlias(env, {
      workId: a,
      title: '統合元の別題',
      kind: 'alt_spelling',
    })
    const bi = await insertBoothItem(a)
    const att = await insertAttempt(member.userId, a, r1)
    await insertWishlist(member.userId, a, 'X の A')
    await insertWishlist(other.userId, a, 'Y の A')
    await insertWishlist(other.userId, b, 'Y の B')

    const page = await get(`/admin/works/${a}/merge?into=${b}`, owner.cookie)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('統合する')
    expect(html).toContain('回 2 件、別名 1 件、出店 1 件')
    expect(html).toContain('件数は表示しません')
    expect(html).toContain('マイリストで両方に入れていた人は統合先側の 1 件だけが残ります')
    expect(html).toContain('「統合元の謎」の題名は「統合先の謎」の旧題として残ります')

    const res = await post(`/admin/works/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/works/${b}?merged=1`)

    // 旧 id を参照する行が各表で 0 件
    for (const [table, col] of [
      ['run', 'work_id'],
      ['work_alias', 'work_id'],
      ['attempt', 'work_id'],
      ['wishlist', 'work_id'],
      ['booth_item', 'work_id'],
      ['work', 'merged_into_id'],
    ]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, a), table).toBe(0)
    }
    expect((await row(`run`, r1))?.work_id).toBe(b)
    expect((await row(`run`, r2))?.work_id).toBe(b)
    expect((await row('work_alias', al))?.work_id).toBe(b)
    expect((await row('booth_item', bi))?.work_id).toBe(b)
    expect(await row('attempt', att)).toMatchObject({ work_id: b, run_id: r1 })
    // X は B に移り、Y は B の 1 行だけ（A 由来は消える）
    const wl = (
      await env.DB.prepare('SELECT user_id, memo FROM wishlist WHERE work_id = ? ORDER BY memo')
        .bind(b)
        .all<{ user_id: string; memo: string }>()
    ).results
    expect(wl).toEqual([
      { user_id: member.userId, memo: 'X の A' },
      { user_id: other.userId, memo: 'Y の B' },
    ])

    const aliases = (
      await env.DB.prepare('SELECT title, kind FROM work_alias WHERE work_id = ? ORDER BY title')
        .bind(b)
        .all()
    ).results
    expect(aliases).toEqual(
      expect.arrayContaining([
        { title: '統合元の謎', kind: 'former_title' },
        { title: '統合元の別題', kind: 'alt_spelling' },
      ]),
    )
    expect(await row('work', a)).toMatchObject({ merged_into_id: b, official_url: null })
    expect(await row('work', b)).toMatchObject({
      merged_into_id: null,
      official_url: 'https://example.com/merge-a',
    })

    const logs = (await logsOf(a)).filter((l) => l.action === 'merge')
    expect(logs).toHaveLength(1)
    expect(logs[0].table_name).toBe('work')
    expect(JSON.parse(logs[0].before_json ?? '{}')).toMatchObject({ id: a, merged_into_id: null })
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({ id: a, merged_into_id: b })
    expect((await logsOf(b)).map((l) => l.action)).toEqual(['update'])

    // 公開ページは統合先へ、管理の編集ページはフォーム無し、統合先は「統合しました」
    const pub = await get(`/works/${a}`)
    expect(pub.status).toBe(302)
    expect(pub.headers.get('location')).toMatch(new RegExp(`/works/${b}$`))
    const edit = await (await get(`/admin/works/${a}`, owner.cookie)).text()
    expect(edit).toContain('統合済み')
    expect(edit).not.toContain('<form method="post"')
    expect(await (await get(`/admin/works/${b}?merged=1`, owner.cookie)).text()).toContain(
      '統合しました',
    )
  })

  it('B に同じ title_norm の別名があれば旧題の別名を増やさない。official_url は B にあれば移さない', async () => {
    const a = await insertWork(env, { title: '重複題', officialUrl: 'https://example.com/dup-a' })
    const b = await insertWork(env, { title: '別の題', officialUrl: 'https://example.com/dup-b' })
    await insertWorkAlias(env, { workId: b, title: '重複題（再演）', kind: 'alt_spelling' })
    const before = await count('SELECT COUNT(*) AS n FROM work_alias WHERE work_id = ?', b)
    const res = await post(`/admin/works/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)
    expect(res.status).toBe(302)
    expect(await count('SELECT COUNT(*) AS n FROM work_alias WHERE work_id = ?', b)).toBe(before)
    expect(await row('work', a)).toMatchObject({ official_url: 'https://example.com/dup-a' })
    expect(await row('work', b)).toMatchObject({ official_url: 'https://example.com/dup-b' })
    expect(await logsOf(b)).toHaveLength(0)
  })

  it('A と B の title_norm が同じなら旧題の別名を足さず、確認画面もそう書く', async () => {
    const a = await insertWork(env, { title: '同題の謎（再演）' })
    const b = await insertWork(env, { title: '同題の謎' })
    const page = await (await get(`/admin/works/${a}/merge?into=${b}`, owner.cookie)).text()
    expect(page).toContain('同じ題名が統合先にあるため旧題は追加しません')
    expect(page).not.toContain('の旧題として残ります')
    expect(
      (await post(`/admin/works/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)).status,
    ).toBe(302)
    expect(await count('SELECT COUNT(*) AS n FROM work_alias WHERE work_id = ?', b)).toBe(0)
  })

  it('A == B / B が統合済み / B が無い / into 無し / confirm 無し → 400 で何も変わらない', async () => {
    const a = await insertWork(env, { title: '検証の謎A' })
    const live = await insertWork(env, { title: '検証の謎B' })
    const merged = await insertWork(env, { title: '検証の謎C', mergedIntoId: live })
    const n = await logCount()
    for (const form of [
      { into: a, confirm: 'yes' },
      { into: merged, confirm: 'yes' },
      { into: 'nope', confirm: 'yes' },
      { confirm: 'yes' },
      { into: live },
      { into: live, confirm: '1' },
    ] as Record<string, string>[]) {
      const res = await post(`/admin/works/${a}/merge`, form, owner.cookie)
      expect(res.status, JSON.stringify(form)).toBe(400)
    }
    expect((await get(`/admin/works/${a}/merge?into=${a}`, owner.cookie)).status).toBe(400)
    expect((await get(`/admin/works/${a}/merge?into=${merged}`, owner.cookie)).status).toBe(400)
    expect((await get(`/admin/works/${a}/merge`, owner.cookie)).status).toBe(400)
    expect(await logCount()).toBe(n)
    expect(await row('work', a)).toMatchObject({ merged_into_id: null })
  })

  it('A が無い → 404、A が統合済み → 400', async () => {
    const b = await insertWork(env, { title: '統合済み元の先' })
    const a = await insertWork(env, { title: '統合済み元', mergedIntoId: b })
    const c = await insertWork(env, { title: '統合済み元の別候補' })
    expect((await get(`/admin/works/nope/merge?into=${b}`, owner.cookie)).status).toBe(404)
    expect(
      (await post('/admin/works/nope/merge', { into: b, confirm: 'yes' }, owner.cookie)).status,
    ).toBe(404)
    expect(
      (await post(`/admin/works/${a}/merge`, { into: c, confirm: 'yes' }, owner.cookie)).status,
    ).toBe(400)
  })

  it('member → 404、未ログイン POST → 401', async () => {
    const a = await insertWork(env, { title: '認可の謎A' })
    const b = await insertWork(env, { title: '認可の謎B' })
    expect((await get(`/admin/works/${a}/merge?into=${b}`, member.cookie)).status).toBe(404)
    expect(
      (await post(`/admin/works/${a}/merge`, { into: b, confirm: 'yes' }, member.cookie)).status,
    ).toBe(404)
    expect((await post(`/admin/works/${a}/merge`, { into: b, confirm: 'yes' })).status).toBe(401)
    expect(await row('work', a)).toMatchObject({ merged_into_id: null })
  })
})

describe('統合先を選ぶ一覧（?merge_from=）', () => {
  it('A 自身と統合済みの行には「ここに統合」が無く、他の行にはある', async () => {
    const a = await insertWork(env, { title: '選ぶ一覧の謎A' })
    const b = await insertWork(env, { title: '選ぶ一覧の謎B' })
    const m = await insertWork(env, { title: '選ぶ一覧の謎M', mergedIntoId: b })
    const html = await (
      await get(
        `/admin/works?merge_from=${a}&q=${encodeURIComponent('選ぶ一覧の謎')}`,
        owner.cookie,
      )
    ).text()
    expect(html).toContain(`action="/admin/works/${a}/merge"`)
    expect(html).toContain(`name="into" value="${b}"`)
    expect(html).not.toContain(`name="into" value="${a}"`)
    expect(html).not.toContain(`name="into" value="${m}"`)
    expect(html).toContain(`name="merge_from" value="${a}"`)
    expect(html).not.toContain('href="/admin/works/new"')
  })

  it('merge_from が無い・統合済みなら 404。編集ページに統合先を選ぶリンク', async () => {
    const b = await insertWork(env, { title: '選ぶ404の先' })
    const m = await insertWork(env, { title: '選ぶ404の元', mergedIntoId: b })
    expect((await get('/admin/works?merge_from=nope', owner.cookie)).status).toBe(404)
    expect((await get(`/admin/works?merge_from=${m}`, owner.cookie)).status).toBe(404)
    expect(await (await get(`/admin/works/${b}`, owner.cookie)).text()).toContain(
      `href="/admin/works?merge_from=${b}"`,
    )
    const org = await insertOrg(env, { name: '選ぶリンク団体' })
    expect(await (await get(`/admin/orgs/${org}`, owner.cookie)).text()).toContain(
      `href="/admin/orgs?merge_from=${org}"`,
    )
    const v = await insertVenue(env, { name: '選ぶリンク会場' })
    expect(await (await get(`/admin/venues/${v}`, owner.cookie)).text()).toContain(
      `href="/admin/venues?merge_from=${v}"`,
    )
  })
})

describe('団体の統合', () => {
  it('FK を全部 B に、別名も B に、旧名を former_name に、billed_as は不変、escape_id_url / slug を引き継ぐ', async () => {
    const a = await insertOrg(env, { name: '統合元団体' })
    await exec(
      "UPDATE organization SET escape_id_url = 'https://escape.id/mergea-org/', slug = 'mergea' WHERE id = ?",
      a,
    )
    const b = await insertOrg(env, { name: '統合先団体' })
    const al = await insertOrgAlias(env, { organizationId: a, name: '統合元の旧称', kind: 'label' })
    const w = await insertWork(env, { title: '団体統合の作品', orgId: a })
    const r = await insertRun(env, {
      workId: w,
      channel: 'online',
      organizationId: a,
      billedAs: '統合元名義',
    })
    const v = await insertVenue(env, { name: '団体統合の会場', organizationId: a })
    const s = await insertShop(env, { name: '団体統合の販売先', kind: 'other', organizationId: a })
    const bo = await insertBooth(a)

    const page = await (await get(`/admin/orgs/${a}/merge?into=${b}`, owner.cookie)).text()
    expect(page).toContain('作品 1 件、回 1 件、会場 1 件、販売先 1 件、出店 1 件、別名 1 件')

    const res = await post(`/admin/orgs/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/orgs/${b}?merged=1`)

    for (const [table, col] of [
      ['work', 'primary_organization_id'],
      ['run', 'organization_id'],
      ['venue', 'organization_id'],
      ['shop', 'organization_id'],
      ['booth', 'organization_id'],
      ['organization_alias', 'organization_id'],
      ['organization', 'merged_into_id'],
    ]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, a), table).toBe(0)
    }
    expect((await row('work', w))?.primary_organization_id).toBe(b)
    expect(await row('run', r)).toMatchObject({ organization_id: b, billed_as: '統合元名義' })
    expect((await row('venue', v))?.organization_id).toBe(b)
    expect((await row('shop', s))?.organization_id).toBe(b)
    expect((await row('booth', bo))?.organization_id).toBe(b)
    expect((await row('organization_alias', al))?.organization_id).toBe(b)
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM organization_alias WHERE organization_id = ? AND name = '統合元団体' AND kind = 'former_name'",
        b,
      ),
    ).toBe(1)
    expect(await row('organization', a)).toMatchObject({
      merged_into_id: b,
      escape_id_url: null,
      slug: null,
    })
    expect(await row('organization', b)).toMatchObject({
      escape_id_url: 'https://escape.id/mergea-org/',
      slug: 'mergea',
    })
    expect((await logsOf(a)).filter((l) => l.action === 'merge')).toHaveLength(1)

    const pub = await get(`/orgs/${a}`)
    expect(pub.status).toBe(302)
    expect(pub.headers.get('location')).toMatch(new RegExp(`/orgs/${b}$`))
  })

  it('A と B の name_norm が同じなら former_name を足さず、確認画面もそう書く', async () => {
    const a = await insertOrg(env, { name: '同名ﾀﾞﾝﾀｲ' })
    const b = await insertOrg(env, { name: '同名ダンタイ' })
    const page = await (await get(`/admin/orgs/${a}/merge?into=${b}`, owner.cookie)).text()
    expect(page).toContain('同じ名前が統合先にあるため旧名は追加しません')
    expect(page).not.toContain('の旧名として残ります')
    expect(
      (await post(`/admin/orgs/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)).status,
    ).toBe(302)
    expect(
      await count('SELECT COUNT(*) AS n FROM organization_alias WHERE organization_id = ?', b),
    ).toBe(0)
  })

  it('B に escape_id_url があれば移さない', async () => {
    const a = await insertOrg(env, {
      name: 'URL元団体',
      escapeIdUrl: 'https://escape.id/urla-org/',
    })
    const b = await insertOrg(env, {
      name: 'URL先団体',
      escapeIdUrl: 'https://escape.id/urlb-org/',
    })
    expect(
      (await post(`/admin/orgs/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)).status,
    ).toBe(302)
    expect((await row('organization', a))?.escape_id_url).toBe('https://escape.id/urla-org/')
    expect((await row('organization', b))?.escape_id_url).toBe('https://escape.id/urlb-org/')
  })
})

describe('会場の統合', () => {
  it('run / session / market_edition を B に、merged_into_id を立てる', async () => {
    const a = await insertVenue(env, { name: '統合元会場' })
    const b = await insertVenue(env, { name: '統合先会場' })
    const w = await insertWork(env, { title: '会場統合の作品' })
    const r = await insertRun(env, { workId: w, channel: 'performance', venueId: a })
    const att = await insertAttempt(member.userId, w, r)
    const sid = ulid()
    await exec(
      'INSERT INTO session (id, attempt_id, user_id, played_on, venue_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      sid,
      att,
      member.userId,
      '2026-01-01',
      a,
      NOW,
    )
    const me = await insertMarketEdition(a)

    const page = await (await get(`/admin/venues/${a}/merge?into=${b}`, owner.cookie)).text()
    expect(page).toContain('回 1 件、マーケット開催 1 件')

    const res = await post(`/admin/venues/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/venues/${b}?merged=1`)
    for (const [table, col] of [
      ['run', 'venue_id'],
      ['session', 'venue_id'],
      ['market_edition', 'venue_id'],
      ['venue', 'merged_into_id'],
    ]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, a), table).toBe(0)
    }
    expect((await row('run', r))?.venue_id).toBe(b)
    expect((await row('session', sid))?.venue_id).toBe(b)
    expect((await row('market_edition', me))?.venue_id).toBe(b)
    expect((await row('venue', a))?.merged_into_id).toBe(b)
    expect((await logsOf(a)).filter((l) => l.action === 'merge')).toHaveLength(1)

    const pub = await get(`/venues/${a}`)
    expect(pub.status).toBe(302)
    expect(pub.headers.get('location')).toMatch(new RegExp(`/venues/${b}$`))
  })
})

describe('統合の鎖を畳む', () => {
  it('C → A 済みで A → B を統合すると C.merged_into_id が B になる（作品・団体・会場）', async () => {
    const wb = await insertWork(env, { title: '鎖の謎B' })
    const wa = await insertWork(env, { title: '鎖の謎A' })
    const wc = await insertWork(env, { title: '鎖の謎C', mergedIntoId: wa })
    const ob = await insertOrg(env, { name: '鎖団体B' })
    const oa = await insertOrg(env, { name: '鎖団体A' })
    const oc = await insertOrg(env, { name: '鎖団体C', mergedIntoId: oa })
    const vb = await insertVenue(env, { name: '鎖会場B' })
    const va = await insertVenue(env, { name: '鎖会場A' })
    const vc = await insertVenue(env, { name: '鎖会場C', mergedIntoId: va })
    for (const [base, a, b] of [
      ['works', wa, wb],
      ['orgs', oa, ob],
      ['venues', va, vb],
    ]) {
      const res = await post(`/admin/${base}/${a}/merge`, { into: b, confirm: 'yes' }, owner.cookie)
      expect(res.status, base).toBe(302)
    }
    expect((await row('work', wc))?.merged_into_id).toBe(wb)
    expect((await row('organization', oc))?.merged_into_id).toBe(ob)
    expect((await row('venue', vc))?.merged_into_id).toBe(vb)
    // C の行は change_log に出さない
    expect(await logsOf(wc)).toHaveLength(0)
    expect(await logsOf(oc)).toHaveLength(0)
    expect(await logsOf(vc)).toHaveLength(0)
  })
})
