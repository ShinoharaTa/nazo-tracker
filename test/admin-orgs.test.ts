import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertOrgAlias, insertWork } from './helpers/master'

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

type OrgDbRow = {
  id: string
  name: string
  name_norm: string
  slug: string | null
  escape_id_url: string | null
  updated_at: string
}

const orgRow = (id: string) =>
  env.DB.prepare('SELECT * FROM organization WHERE id = ?').bind(id).first<OrgDbRow>()

const orgByName = (name: string) =>
  env.DB.prepare('SELECT * FROM organization WHERE name = ?').bind(name).first<OrgDbRow>()

type LogRow = {
  table_name: string
  row_id: string
  action: string
  before_json: string | null
  after_json: string | null
  actor_user_id: string | null
  actor_token_id: string | null
}

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ? ORDER BY id')
      .bind(rowId)
      .all<LogRow>()
  ).results

const logCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM change_log').first<{ n: number }>())?.n ?? 0

const idFromLocation = (res: Response, base: string) => {
  const loc = res.headers.get('location') ?? ''
  const m = new RegExp(`^${base}/([^/?]+)\\?saved=1$`).exec(loc)
  if (!m) throw new Error(`unexpected location: ${loc}`)
  return m[1]
}

let owner: { cookie: string; userId: string }
let member: { cookie: string }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'ao-owner', owner: true })
  member = await loginAs(env, { subject: 'ao-member' })
})

describe('/admin の認可', () => {
  it('未ログインの GET は 302 /login、POST は 401', async () => {
    const res = await get('/admin')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect((await get('/admin/orgs/new')).status).toBe(302)
    expect((await post('/admin/orgs/new', { name: 'x' })).status).toBe(401)
  })

  it('member は 404', async () => {
    expect((await get('/admin', member.cookie)).status).toBe(404)
    expect((await get('/admin/orgs/new', member.cookie)).status).toBe(404)
    expect((await get('/admin/orgs', member.cookie)).status).toBe(404)
    expect((await post('/admin/orgs/new', { name: 'x' }, member.cookie)).status).toBe(404)
    expect(await orgByName('x')).toBeNull()
  })

  it('owner は 200。メニューに 4 種の一覧', async () => {
    const res = await get('/admin', owner.cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    for (const h of ['/admin/works', '/admin/orgs', '/admin/venues', '/admin/shops']) {
      expect(html).toContain(`href="${h}"`)
    }
    expect(html).toContain('href="/admin/orgs/new"')
  })

  it('/settings の「マスタ管理」は owner だけ', async () => {
    expect(await (await get('/settings', owner.cookie)).text()).toContain('href="/admin"')
    expect(await (await get('/settings', member.cookie)).text()).not.toContain('href="/admin"')
  })
})

describe('団体の作成', () => {
  it('escape_id_url を正規化し、name_norm・slug を計算、change_log に create', async () => {
    const res = await post(
      '/admin/orgs/new',
      { name: 'ナゾラボ', escape_id_url: 'HTTPS://ESCAPE.ID/nazolabo-org?x=1' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    const id = idFromLocation(res, '/admin/orgs')
    const row = await orgRow(id)
    // norm() はカナを畳まない（docs/data-model.md §5）
    expect(row?.name_norm).toBe('ナゾラボ')
    expect(row?.escape_id_url).toBe('https://escape.id/nazolabo-org/')
    expect(row?.slug).toBe('nazolabo')
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      table_name: 'organization',
      action: 'create',
      before_json: null,
      actor_user_id: owner.userId,
      actor_token_id: null,
    })
    const after = JSON.parse(logs[0].after_json ?? '{}')
    expect(after.name_norm).toBe('ナゾラボ')
    expect(after.escape_id_url).toBe('https://escape.id/nazolabo-org/')

    const page = await (await get(`/admin/orgs/${id}?saved=1`, owner.cookie)).text()
    expect(page).toContain('value="ナゾラボ"')
    expect(page).toContain('保存しました')
  })

  it.each<[string, Record<string, string>]>([
    ['名前が空', { name: '' }],
    ['名前が 201 文字', { name: 'あ'.repeat(201) }],
    ['名前に改行', { name: 'ア\nイ' }],
    ['名前に制御文字', { name: 'ア\u0007イ' }],
    ['site_url にタブ', { name: 'エラー団体', site_url: 'https://exa\tmple.com/' }],
    ['site_url が javascript:', { name: 'エラー団体', site_url: 'javascript:alert(1)' }],
    [
      'escape_id_url が -org/ で終わらない',
      { name: 'エラー団体', escape_id_url: 'https://escape.id/foo/' },
    ],
    [
      'escape_id_url が別ホスト',
      { name: 'エラー団体', escape_id_url: 'https://example.com/a-org/' },
    ],
  ])('%s → 400、行も change_log も増えない', async (_, form) => {
    const before = await logCount()
    const res = await post('/admin/orgs/new', form, owner.cookie)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('role="alert"')
    expect(await logCount()).toBe(before)
    if (form.name === 'エラー団体') {
      expect(await orgByName('エラー団体')).toBeNull()
      expect(html).toContain('value="エラー団体"')
    }
  })

  it('送信値がエスケープされて戻る', async () => {
    const res = await post(
      '/admin/orgs/new',
      { name: '"><script>x</script>', site_url: 'javascript:alert(1)' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('value="javascript:alert(1)"')
  })

  it('既存と同じ escape_id_url → 400。編集で自分と同じ値は通る', async () => {
    const id = await insertOrg(env, { name: '既存団体', escapeIdUrl: 'https://escape.id/dup-org/' })
    const res = await post(
      '/admin/orgs/new',
      { name: '別の団体', escape_id_url: 'https://escape.id/dup-org' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('同じ escape.id URL の団体があります')
    expect(await orgByName('別の団体')).toBeNull()

    const edit = await post(
      `/admin/orgs/${id}`,
      { name: '既存団体', escape_id_url: 'https://escape.id/dup-org/' },
      owner.cookie,
    )
    expect(edit.status).toBe(302)
    // 既存行の slug は次の保存で埋まる
    expect((await orgRow(id))?.slug).toBe('dup')
  })
})

describe('団体の編集', () => {
  it('name を変えると updated_at が進み change_log に update。無変更の保存は記録しない', async () => {
    const id = await insertOrg(env, { name: '旧い名前' })
    const before = await orgRow(id)
    const res = await post(`/admin/orgs/${id}`, { name: '新しい名前' }, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/orgs/${id}?saved=1`)
    const after = await orgRow(id)
    expect(after?.name).toBe('新しい名前')
    expect(after?.name_norm).toBe('新しい名前')
    expect(after && before && after.updated_at > before.updated_at).toBe(true)
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('update')
    expect(JSON.parse(logs[0].before_json ?? '{}').name).toBe('旧い名前')
    expect(JSON.parse(logs[0].after_json ?? '{}').name).toBe('新しい名前')

    const again = await post(`/admin/orgs/${id}`, { name: '新しい名前' }, owner.cookie)
    expect(again.status).toBe(302)
    expect(await logsOf(id)).toHaveLength(1)
    expect((await orgRow(id))?.updated_at).toBe(after?.updated_at)
  })

  it('エラー時は 400 で送信値が戻る', async () => {
    const id = await insertOrg(env, { name: 'そのまま団体' })
    const res = await post(
      `/admin/orgs/${id}`,
      { name: 'そのまま団体2', site_url: 'ftp://example.com/' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('value="そのまま団体2"')
    expect((await orgRow(id))?.name).toBe('そのまま団体')
  })

  it('統合済み団体の編集ページはフォーム無し、POST は 400', async () => {
    const into = await insertOrg(env, { name: '統合先団体' })
    const id = await insertOrg(env, { name: '統合元団体', mergedIntoId: into })
    const res = await get(`/admin/orgs/${id}`, owner.cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('統合済み')
    expect(html).toContain(`href="/admin/orgs/${into}"`)
    expect(html).not.toContain('name="name"')
    expect((await post(`/admin/orgs/${id}`, { name: '変更' }, owner.cookie)).status).toBe(400)
    expect((await orgRow(id))?.name).toBe('統合元団体')
  })

  it('存在しない id は 404（Layout 付き）', async () => {
    const res = await get('/admin/orgs/nope', owner.cookie)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('見つかりませんでした')
    expect((await post('/admin/orgs/nope', { name: 'x' }, owner.cookie)).status).toBe(404)
  })

  it('公開ページ /orgs/:id に note が出ない', async () => {
    const id = await insertOrg(env, { name: 'メモ団体', note: '内部メモ・ヒミツ' })
    const html = await (await get(`/orgs/${id}`)).text()
    expect(html).toContain('メモ団体')
    expect(html).not.toContain('内部メモ・ヒミツ')
  })

  it('/orgs/:id の「編集」は owner だけ', async () => {
    const id = await insertOrg(env, { name: '公開団体' })
    const ownerHtml = await (await get(`/orgs/${id}`, owner.cookie)).text()
    expect(ownerHtml).toContain(`href="/admin/orgs/${id}"`)
    const memberHtml = await (await get(`/orgs/${id}`, member.cookie)).text()
    expect(memberHtml).not.toContain('/admin/orgs/')
    expect(await (await get(`/orgs/${id}`)).text()).not.toContain('/admin/orgs/')
  })
})

describe('団体の別名', () => {
  it('追加すると name_norm を計算し change_log に create', async () => {
    const id = await insertOrg(env, { name: '別名テスト団体' })
    const res = await post(
      `/admin/orgs/${id}/aliases`,
      { name: 'ベツメイ　２', kind: 'former_name', since: '2020-01-01', until: '2023-12-31' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/orgs/${id}`)
    const a = await env.DB.prepare('SELECT * FROM organization_alias WHERE organization_id = ?')
      .bind(id)
      .first<{ id: string; name: string; name_norm: string; since: string }>()
    expect(a?.name).toBe('ベツメイ　２')
    expect(a?.name_norm).toBe('ベツメイ2')
    const logs = await logsOf(a?.id ?? '')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ table_name: 'organization_alias', action: 'create' })
    const page = await (await get(`/admin/orgs/${id}`, owner.cookie)).text()
    expect(page).toContain('旧名: ベツメイ　２（2020-01-01〜2023-12-31）')
    expect(page).toContain(`action="/admin/org-aliases/${a?.id}/delete"`)
  })

  it('since > until、kind 不正、名前空 → 400', async () => {
    const id = await insertOrg(env, { name: '別名エラー団体' })
    const forms: Record<string, string>[] = [
      { name: 'X', kind: 'former_name', since: '2024-01-01', until: '2023-01-01' },
      { name: 'X', kind: 'nickname' },
      { name: '', kind: 'label' },
      { name: 'X', kind: 'label', since: '2023-02-30' },
    ]
    for (const form of forms) {
      const res = await post(`/admin/orgs/${id}/aliases`, form, owner.cookie)
      expect(res.status).toBe(400)
    }
    const n = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM organization_alias WHERE organization_id = ?',
    )
      .bind(id)
      .first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('削除すると行が消え change_log の before_json に行が残る', async () => {
    const id = await insertOrg(env, { name: '別名削除団体' })
    const aliasId = await insertOrgAlias(env, {
      organizationId: id,
      name: '消える別名',
      kind: 'alt_spelling',
    })
    const res = await post(`/admin/org-aliases/${aliasId}/delete`, {}, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/orgs/${id}`)
    expect(
      await env.DB.prepare('SELECT 1 FROM organization_alias WHERE id = ?').bind(aliasId).first(),
    ).toBeNull()
    const logs = await logsOf(aliasId)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('delete')
    expect(logs[0].after_json).toBeNull()
    expect(JSON.parse(logs[0].before_json ?? '{}')).toMatchObject({
      id: aliasId,
      organization_id: id,
      name: '消える別名',
      kind: 'alt_spelling',
    })
    expect((await post(`/admin/org-aliases/${aliasId}/delete`, {}, owner.cookie)).status).toBe(404)
  })

  it('親団体が統合済みなら別名の削除は 400（行は残る）', async () => {
    const into = await insertOrg(env, { name: '別名統合先' })
    const id = await insertOrg(env, { name: '別名統合元', mergedIntoId: into })
    const aliasId = await insertOrgAlias(env, {
      organizationId: id,
      name: '残す別名',
      kind: 'label',
    })
    expect((await post(`/admin/org-aliases/${aliasId}/delete`, {}, owner.cookie)).status).toBe(400)
    expect(
      await env.DB.prepare('SELECT 1 FROM organization_alias WHERE id = ?').bind(aliasId).first(),
    ).not.toBeNull()
    expect(await logsOf(aliasId)).toHaveLength(0)
  })

  it('member は別名を削除できない（404）', async () => {
    const id = await insertOrg(env, { name: '別名守り団体' })
    const aliasId = await insertOrgAlias(env, { organizationId: id, name: '残る', kind: 'label' })
    expect((await post(`/admin/org-aliases/${aliasId}/delete`, {}, member.cookie)).status).toBe(404)
    expect(
      await env.DB.prepare('SELECT 1 FROM organization_alias WHERE id = ?').bind(aliasId).first(),
    ).not.toBeNull()
  })
})

describe('管理一覧', () => {
  it('51 件で 1 頁目に次頁リンク、page=2 に 1 件と前頁リンク', async () => {
    for (let i = 0; i < 51; i++) await insertOrg(env, { name: `ページ団体${i}` })
    const p1 = await (await get('/admin/orgs?q=ページ団体', owner.cookie)).text()
    expect(p1.match(/href="\/admin\/orgs\/(?!new")[^"]+"/g)).toHaveLength(50)
    expect(p1).toContain('次の 50 件')
    expect(p1).toContain(
      'href="/admin/orgs?q=%E3%83%9A%E3%83%BC%E3%82%B8%E5%9B%A3%E4%BD%93&amp;page=2"',
    )
    const p2 = await (await get('/admin/orgs?q=ページ団体&page=2', owner.cookie)).text()
    expect(p2.match(/href="\/admin\/orgs\/(?!new")[^"]+"/g)).toHaveLength(1)
    expect(p2).toContain('ページ団体0')
    expect(p2).toContain('前の 50 件')
    expect(p2).not.toContain('次の 50 件')
  })

  it('統合済みも出し、note に統合先。q は別名でも当たる', async () => {
    const into = await insertOrg(env, { name: 'イチラン統合先' })
    await insertOrg(env, { name: 'イチラン統合元', mergedIntoId: into })
    const aliased = await insertOrg(env, { name: 'イチラン本名' })
    await insertOrgAlias(env, { organizationId: aliased, name: 'ヒミツノナマエ', kind: 'label' })

    const html = await (await get('/admin/orgs?q=イチラン', owner.cookie)).text()
    expect(html).toContain('イチラン統合元')
    expect(html).toContain('統合済み → イチラン統合先')

    const byAlias = await (await get('/admin/orgs?q=ﾋﾐﾂﾉﾅﾏｴ', owner.cookie)).text()
    expect(byAlias).toContain(`href="/admin/orgs/${aliased}"`)
  })

  it('/admin/works は作品の一覧（統合済みも）', async () => {
    const org = await insertOrg(env, { name: 'サクヒン団体' })
    const into = await insertWork(env, { title: '管理一覧の作品', kind: 'room', orgId: org })
    await insertWork(env, { title: '管理一覧の旧作品', kind: 'room', mergedIntoId: into })
    const html = await (await get('/admin/works?q=管理一覧', owner.cookie)).text()
    expect(html).toContain(`href="/admin/works/${into}"`)
    expect(html).toContain('ルーム · サクヒン団体')
    expect(html).toContain('統合済み → 管理一覧の作品')
  })
})
