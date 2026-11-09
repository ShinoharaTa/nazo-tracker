import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertShop, insertVenue } from './helpers/master'

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

const idFromLocation = (res: Response, base: string) => {
  const loc = res.headers.get('location') ?? ''
  const m = new RegExp(`^${base}/([^/?]+)\\?saved=1$`).exec(loc)
  if (!m) throw new Error(`unexpected location: ${loc}`)
  return m[1]
}

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ? ORDER BY id')
      .bind(rowId)
      .all<{ table_name: string; action: string; before_json: string; after_json: string }>()
  ).results

const count = async (table: string, where: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n

let owner: { cookie: string; userId: string }
let member: { cookie: string }
let org: string
let mergedOrg: string

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'avs-owner', owner: true })
  member = await loginAs(env, { subject: 'avs-member' })
  org = await insertOrg(env, { name: '会場の団体' })
  mergedOrg = await insertOrg(env, { name: '統合済みの団体', mergedIntoId: org })
})

describe('会場', () => {
  it('member は 404', async () => {
    expect((await get('/admin/venues/new', member.cookie)).status).toBe(404)
    expect((await post('/admin/venues/new', { name: 'x' }, member.cookie)).status).toBe(404)
  })

  it('作成フォームの団体の選択肢に統合済みは出ない', async () => {
    const html = await (await get('/admin/venues/new', owner.cookie)).text()
    expect(html).toContain(`value="${org}"`)
    expect(html).not.toContain(`value="${mergedOrg}"`)
    expect(html).toContain('<option value="東京都">')
  })

  it('作成すると name_norm を計算し change_log に create', async () => {
    const res = await post(
      '/admin/venues/new',
      {
        name: 'ナゾスポット　ＬＩＧ',
        prefecture: '東京都',
        address: '渋谷区',
        organization_id: org,
      },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    const id = idFromLocation(res, '/admin/venues')
    const row = await env.DB.prepare('SELECT * FROM venue WHERE id = ?')
      .bind(id)
      .first<{ name_norm: string; prefecture: string; organization_id: string }>()
    expect(row).toMatchObject({
      name_norm: 'ナゾスポットlig',
      prefecture: '東京都',
      organization_id: org,
    })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ table_name: 'venue', action: 'create' })

    const page = await (await get(`/admin/venues/${id}?saved=1`, owner.cookie)).text()
    expect(page).toContain('保存しました')
    expect(page).toContain('<option value="東京都" selected="">')
  })

  it.each<[string, Record<string, string>]>([
    ['prefecture が「東京」', { name: 'エラー会場', prefecture: '東京' }],
    ['organization_id が統合済み', { name: 'エラー会場', organization_id: 'MERGED' }],
    ['organization_id が存在しない', { name: 'エラー会場', organization_id: 'nope' }],
    ['名前が空', { name: '', prefecture: '東京都' }],
    ['address が 201 文字', { name: 'エラー会場', address: 'あ'.repeat(201) }],
    ['address に改行', { name: 'エラー会場', address: '渋谷区\n1-2-3' }],
  ])('%s → 400', async (_, form) => {
    const body = form.organization_id === 'MERGED' ? { ...form, organization_id: mergedOrg } : form
    const res = await post('/admin/venues/new', body, owner.cookie)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('role="alert"')
    expect(await count('venue', 'name = ?', 'エラー会場')).toBe(0)
  })

  it('編集で change_log に update。無変更なら増えない', async () => {
    const id = await insertVenue(env, { name: '編集会場', prefecture: '大阪府' })
    const res = await post(
      `/admin/venues/${id}`,
      { name: '編集会場', prefecture: '京都府' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/venues/${id}?saved=1`)
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].before_json).prefecture).toBe('大阪府')
    expect(JSON.parse(logs[0].after_json).prefecture).toBe('京都府')
    await post(`/admin/venues/${id}`, { name: '編集会場', prefecture: '京都府' }, owner.cookie)
    expect(await logsOf(id)).toHaveLength(1)
  })

  it('統合済み会場の編集ページはフォーム無し、POST は 400', async () => {
    const into = await insertVenue(env, { name: '統合先会場' })
    const id = await insertVenue(env, { name: '統合元会場', mergedIntoId: into })
    const html = await (await get(`/admin/venues/${id}`, owner.cookie)).text()
    expect(html).toContain(`href="/admin/venues/${into}"`)
    expect(html).not.toContain('name="name"')
    expect((await post(`/admin/venues/${id}`, { name: 'x' }, owner.cookie)).status).toBe(400)
  })

  it('/venues/:id の「編集」は owner だけ', async () => {
    const id = await insertVenue(env, { name: '公開会場' })
    expect(await (await get(`/venues/${id}`, owner.cookie)).text()).toContain(
      `href="/admin/venues/${id}"`,
    )
    expect(await (await get(`/venues/${id}`, member.cookie)).text()).not.toContain('/admin/')
  })

  it('管理一覧は統合済みも出し note に統合先', async () => {
    const into = await insertVenue(env, { name: 'カイジョウ一覧先' })
    await insertVenue(env, { name: 'カイジョウ一覧元', mergedIntoId: into })
    const html = await (await get('/admin/venues?q=ｶｲｼﾞｮｳ一覧', owner.cookie)).text()
    expect(html).toContain('カイジョウ一覧元')
    expect(html).toContain('統合済み → カイジョウ一覧先')
  })
})

describe('販売先', () => {
  it('作成すると change_log に create', async () => {
    const res = await post(
      '/admin/shops/new',
      {
        name: 'ナゾ通販',
        kind: 'official_store',
        url: 'https://shop.example/nazo',
        organization_id: org,
      },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    const id = idFromLocation(res, '/admin/shops')
    const row = await env.DB.prepare('SELECT * FROM shop WHERE id = ?')
      .bind(id)
      .first<{ kind: string; url: string }>()
    expect(row).toMatchObject({ kind: 'official_store', url: 'https://shop.example/nazo' })
    expect((await logsOf(id))[0]).toMatchObject({ table_name: 'shop', action: 'create' })
  })

  it('kind=amazon → 400、kind 無し → 400', async () => {
    expect(
      (await post('/admin/shops/new', { name: 'アマゾン', kind: 'amazon' }, owner.cookie)).status,
    ).toBe(400)
    expect((await post('/admin/shops/new', { name: 'アマゾン' }, owner.cookie)).status).toBe(400)
    expect(await count('shop', 'name = ?', 'アマゾン')).toBe(0)
  })

  it('url 重複 → 400。編集で自分と同じ url は通る', async () => {
    const id = await insertShop(env, {
      name: '先の通販',
      kind: 'other',
      url: 'https://dup.example/',
    })
    const res = await post(
      '/admin/shops/new',
      { name: '後の通販', kind: 'other', url: 'https://dup.example/' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('同じ URL の販売先があります')
    const edit = await post(
      `/admin/shops/${id}`,
      { name: '先の通販（改）', kind: 'other', url: 'https://dup.example/' },
      owner.cookie,
    )
    expect(edit.status).toBe(302)
    expect((await logsOf(id))[0].action).toBe('update')
  })

  it('url が javascript: → 400', async () => {
    const res = await post(
      '/admin/shops/new',
      { name: 'スキーム通販', kind: 'other', url: 'javascript:alert(1)' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
  })

  it('管理一覧は名前の部分一致（大文字小文字を区別しない）', async () => {
    const id = await insertShop(env, { name: 'BOOTH Store', kind: 'booth' })
    const html = await (await get('/admin/shops?q=booth', owner.cookie)).text()
    expect(html).toContain(`href="/admin/shops/${id}"`)
    expect(html).toContain('BOOTH')
  })

  it('url にタブ → 400', async () => {
    const res = await post(
      '/admin/shops/new',
      { name: 'タブ通販', kind: 'other', url: 'https://tab.example/\tx' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await count('shop', 'name = ?', 'タブ通販')).toBe(0)
  })

  it('GET /admin/shops/:id は 200 で値が埋まる', async () => {
    const id = await insertShop(env, {
      name: '埋め戻し通販',
      kind: 'physical_store',
      url: 'https://fill.example/',
      organizationId: org,
    })
    const res = await get(`/admin/shops/${id}`, owner.cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('value="埋め戻し通販"')
    expect(html).toContain('value="https://fill.example/"')
    expect(html).toContain('<option value="physical_store" selected="">')
    expect(html).toContain(`<option value="${org}" selected="">`)
  })

  it('存在しない id は 404', async () => {
    expect((await get('/admin/shops/nope', owner.cookie)).status).toBe(404)
  })
})
