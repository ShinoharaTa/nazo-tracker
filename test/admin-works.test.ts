import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertRun, insertWork, insertWorkAlias } from './helpers/master'

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

type WorkDbRow = {
  id: string
  title: string
  title_norm: string
  kind: string | null
  primary_organization_id: string | null
  official_url: string | null
  description: string | null
  player_min: number | null
  player_max: number | null
  estimated_minutes: number | null
  time_limit_minutes: number | null
  first_released_on: string | null
  updated_at: string
}

const workRow = (id: string) =>
  env.DB.prepare('SELECT * FROM work WHERE id = ?').bind(id).first<WorkDbRow>()

const worksTitled = async (title: string) =>
  (await env.DB.prepare('SELECT * FROM work WHERE title = ?').bind(title).all<WorkDbRow>()).results

type LogRow = {
  table_name: string
  action: string
  before_json: string | null
  after_json: string | null
  actor_user_id: string | null
}

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ? ORDER BY id')
      .bind(rowId)
      .all<LogRow>()
  ).results

const logCount = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM change_log').first<{ n: number }>())?.n ?? 0

const idFromLocation = (res: Response) => {
  const loc = res.headers.get('location') ?? ''
  const m = /^\/admin\/works\/([^/?]+)\?saved=1$/.exec(loc)
  if (!m) throw new Error(`unexpected location: ${loc}`)
  return m[1]
}

let owner: { cookie: string; userId: string }
let member: { cookie: string }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'aw-owner', owner: true })
  member = await loginAs(env, { subject: 'aw-member' })
})

describe('/admin/works の認可', () => {
  it('未ログインの GET は 302 /login、POST は 401、member は 404', async () => {
    const res = await get('/admin/works/new')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect((await post('/admin/works/new', { title: 'x' })).status).toBe(401)
    expect((await get('/admin/works/new', member.cookie)).status).toBe(404)
    expect((await post('/admin/works/new', { title: '認可の作品' }, member.cookie)).status).toBe(
      404,
    )
    expect(await worksTitled('認可の作品')).toHaveLength(0)
  })

  it('メニューと管理一覧に「作品を追加」', async () => {
    expect(await (await get('/admin', owner.cookie)).text()).toContain('href="/admin/works/new"')
    expect(await (await get('/admin/works', owner.cookie)).text()).toContain(
      'href="/admin/works/new"',
    )
  })
})

describe('作品の作成', () => {
  it('全項目 → 302、title_norm を計算、change_log に create', async () => {
    const org = await insertOrg(env, { name: 'ゼンコウモク団体' })
    const res = await post(
      '/admin/works/new',
      {
        title: '星降る街（再演）',
        kind: 'stroll',
        primary_organization_id: org,
        official_url: 'HTTPS://Example.COM/hoshi',
        description: '一行目\n二行目',
        player_min: '1',
        player_max: '4',
        estimated_minutes: '120',
        time_limit_minutes: '60',
        first_released_on: '2025-04-01',
      },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    const id = idFromLocation(res)
    const row = await workRow(id)
    expect(row).toMatchObject({
      title: '星降る街（再演）',
      title_norm: '星降る街',
      kind: 'stroll',
      primary_organization_id: org,
      official_url: 'https://example.com/hoshi',
      description: '一行目\n二行目',
      player_min: 1,
      player_max: 4,
      estimated_minutes: 120,
      time_limit_minutes: 60,
      first_released_on: '2025-04-01',
    })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      table_name: 'work',
      action: 'create',
      before_json: null,
      actor_user_id: owner.userId,
    })
    expect(JSON.parse(logs[0].after_json ?? '{}').title_norm).toBe('星降る街')

    const page = await (await get(`/admin/works/${id}?saved=1`, owner.cookie)).text()
    expect(page).toContain('保存しました')
    expect(page).toContain('value="星降る街（再演）"')
    expect(page).toContain(`href="/admin/works/${id}/runs/new"`)
  })

  it('kind は空（未設定）でも作れる', async () => {
    const res = await post('/admin/works/new', { title: 'カインドナシの作品' }, owner.cookie)
    expect(res.status).toBe(302)
    expect((await workRow(idFromLocation(res)))?.kind).toBeNull()
  })

  it.each<[string, Record<string, string>]>([
    ['題名が空', { title: '' }],
    ['題名に改行', { title: 'エラー\n作品' }],
    ['kind が不正', { title: 'エラー作品', kind: 'cafe' }],
    ['player_min > player_max', { title: 'エラー作品', player_min: '5', player_max: '2' }],
    ['player_max が 100', { title: 'エラー作品', player_max: '100' }],
    ['estimated_minutes が 0', { title: 'エラー作品', estimated_minutes: '0' }],
    ['time_limit_minutes が小数', { title: 'エラー作品', time_limit_minutes: '1.5' }],
    ['first_released_on が実在しない', { title: 'エラー作品', first_released_on: '2025-02-30' }],
    ['official_url が javascript:', { title: 'エラー作品', official_url: 'javascript:alert(1)' }],
    ['official_url に空白', { title: 'エラー作品', official_url: 'https://exa mple.com/' }],
    ['description に制御文字', { title: 'エラー作品', description: 'a\u0007b' }],
    ['団体が存在しない', { title: 'エラー作品', primary_organization_id: 'nope' }],
  ])('%s → 400、行も change_log も増えない', async (_, form) => {
    const before = await logCount()
    const res = await post('/admin/works/new', form, owner.cookie)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('role="alert"')
    expect(await logCount()).toBe(before)
    if (form.title === 'エラー作品') {
      expect(await worksTitled('エラー作品')).toHaveLength(0)
      expect(html).toContain('value="エラー作品"')
    }
  })

  it('primary_organization_id に統合済みの団体 → 400', async () => {
    const into = await insertOrg(env, { name: '作品の統合先団体' })
    const merged = await insertOrg(env, { name: '作品の統合元団体', mergedIntoId: into })
    const res = await post(
      '/admin/works/new',
      { title: '統合済み団体の作品', primary_organization_id: merged },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('団体が見つからないか、統合済みです')
  })

  it('official_url の重複 → 400。編集で自分と同じ値は通る', async () => {
    const id = await insertWork(env, {
      title: '公式サイト持ちの作品',
      officialUrl: 'https://example.com/dup-work',
    })
    const res = await post(
      '/admin/works/new',
      { title: 'ぜんぜん違うなまえ', official_url: 'https://EXAMPLE.com/dup-work' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('同じ公式サイトの作品があります')
    const edit = await post(
      `/admin/works/${id}`,
      { title: '公式サイト持ちの作品', official_url: 'https://example.com/dup-work' },
      owner.cookie,
    )
    expect(edit.status).toBe(302)
  })
})

describe('作成時の重複チェック', () => {
  it('同じ題 → 400 で候補を出し行は増えない。confirm=1 を付けた再送で作成', async () => {
    const org = await insertOrg(env, { name: 'ワーディール団体' })
    const existing = await insertWork(env, { title: 'WORDEAL', kind: 'hall', orgId: org })
    const before = await logCount()
    const res = await post('/admin/works/new', { title: 'WORDEAL', kind: 'hall' }, owner.cookie)
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('似た作品があります')
    expect(html).toContain(`href="/admin/works/${existing}"`)
    expect(html).toContain('ワーディール団体')
    expect(html).toContain('score 0.85')
    expect(html).toContain('title')
    expect(html).toContain('name="confirm" value="1"')
    // 送信値は埋め戻す
    expect(html).toContain('value="WORDEAL"')
    expect(await worksTitled('WORDEAL')).toHaveLength(1)
    expect(await logCount()).toBe(before)

    const again = await post(
      '/admin/works/new',
      { title: 'WORDEAL', kind: 'hall', confirm: '1' },
      owner.cookie,
    )
    expect(again.status).toBe(302)
    expect(await worksTitled('WORDEAL')).toHaveLength(2)
  })

  it('別名の一致でも止める。団体を選べば same_org_title', async () => {
    const org = await insertOrg(env, { name: 'ベツメイ一致団体' })
    const w = await insertWork(env, { title: '本来の題名ですよ', orgId: org })
    await insertWorkAlias(env, { workId: w, title: '旧い題名ですよ', kind: 'former_title' })
    const res = await post(
      '/admin/works/new',
      { title: '旧い題名ですよ', primary_organization_id: org },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain(`href="/admin/works/${w}"`)
    expect(html).toContain('score 0.95')
    expect(html).toContain('same_org_title')
  })

  it('統合済みの作品は候補にしない', async () => {
    const into = await insertWork(env, { title: '統合先のながい題名' })
    await insertWork(env, { title: '統合元のみじかい題', mergedIntoId: into })
    const res = await post('/admin/works/new', { title: '統合元のみじかい題' }, owner.cookie)
    expect(res.status).toBe(302)
  })

  it('全く違う題 → 1 回で 302', async () => {
    const res = await post('/admin/works/new', { title: 'まったく新しい題名の作品' }, owner.cookie)
    expect(res.status).toBe(302)
  })

  it('検証エラーのときは候補を出さない（confirm は送信値を引き継ぐ）', async () => {
    await insertWork(env, { title: 'ケンショウ優先の作品' })
    const res = await post(
      '/admin/works/new',
      { title: 'ケンショウ優先の作品', player_min: '0' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).not.toContain('似た作品があります')
    expect(html).not.toContain('name="confirm"')
  })
})

describe('作品の編集', () => {
  it('題名を変えると title_norm と updated_at が変わり change_log に update。無変更は記録しない', async () => {
    const id = await insertWork(env, { title: '編集まえの作品', kind: 'room' })
    const before = await workRow(id)
    const res = await post(
      `/admin/works/${id}`,
      { title: 'ＥＤＩＴ後の作品', kind: 'room' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/works/${id}?saved=1`)
    const after = await workRow(id)
    expect(after?.title_norm).toBe('edit後の作品')
    expect(after && before && after.updated_at > before.updated_at).toBe(true)
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('update')
    expect(JSON.parse(logs[0].before_json ?? '{}').title).toBe('編集まえの作品')

    const again = await post(
      `/admin/works/${id}`,
      { title: 'ＥＤＩＴ後の作品', kind: 'room' },
      owner.cookie,
    )
    expect(again.status).toBe(302)
    expect(await logsOf(id)).toHaveLength(1)
  })

  it('編集時は重複チェックをしない', async () => {
    await insertWork(env, { title: 'ジュウフクしてもよい' })
    const id = await insertWork(env, { title: 'あとで同じ題にする' })
    const res = await post(`/admin/works/${id}`, { title: 'ジュウフクしてもよい' }, owner.cookie)
    expect(res.status).toBe(302)
  })

  it('エラー時は 400 で送信値が戻る', async () => {
    const id = await insertWork(env, { title: 'そのままの作品' })
    const res = await post(
      `/admin/works/${id}`,
      { title: 'そのままの作品2', player_min: 'x' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('value="そのままの作品2"')
    expect((await workRow(id))?.title).toBe('そのままの作品')
  })

  it('回一覧に回と編集リンク', async () => {
    const id = await insertWork(env, { title: '回一覧の作品' })
    const runId = await insertRun(env, {
      workId: id,
      channel: 'performance',
      startOn: '2026-01-01',
      endOn: '2026-02-01',
    })
    const html = await (await get(`/admin/works/${id}`, owner.cookie)).text()
    expect(html).toContain(`href="/admin/runs/${runId}"`)
    expect(html).toContain('公演 · 会場未定 · 2026-01-01〜2026-02-01')
  })

  it('統合済み作品の編集ページはフォーム無し、POST は 400', async () => {
    const into = await insertWork(env, { title: '作品の統合先' })
    const id = await insertWork(env, { title: '作品の統合元', mergedIntoId: into })
    const res = await get(`/admin/works/${id}`, owner.cookie)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('統合済み')
    expect(html).toContain(`href="/admin/works/${into}"`)
    expect(html).not.toContain('name="title"')
    expect((await post(`/admin/works/${id}`, { title: '変更' }, owner.cookie)).status).toBe(400)
    expect((await workRow(id))?.title).toBe('作品の統合元')
  })

  it('存在しない id は 404（Layout 付き）', async () => {
    const res = await get('/admin/works/nope', owner.cookie)
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('見つかりませんでした')
    expect(html).toContain('href="/admin/works"')
    expect((await post('/admin/works/nope', { title: 'x' }, owner.cookie)).status).toBe(404)
  })

  it('/works/:id の「編集」（作品と回）は owner だけ', async () => {
    const id = await insertWork(env, { title: '公開の作品' })
    const runId = await insertRun(env, { workId: id, channel: 'online' })
    const ownerHtml = await (await get(`/works/${id}`, owner.cookie)).text()
    expect(ownerHtml).toContain(`href="/admin/works/${id}"`)
    expect(ownerHtml).toContain(`href="/admin/runs/${runId}"`)
    for (const cookie of [member.cookie, undefined]) {
      const html = await (await get(`/works/${id}`, cookie)).text()
      expect(html).not.toContain('/admin/works/')
      expect(html).not.toContain('/admin/runs/')
    }
  })
})

describe('作品の別名', () => {
  it('追加すると title_norm を計算し change_log に create。削除で消える', async () => {
    const id = await insertWork(env, { title: '別名テストの作品' })
    const res = await post(
      `/admin/works/${id}/aliases`,
      { title: 'ベツメイ　２', kind: 'alt_spelling' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/works/${id}`)
    const a = await env.DB.prepare('SELECT * FROM work_alias WHERE work_id = ?')
      .bind(id)
      .first<{ id: string; title_norm: string }>()
    expect(a?.title_norm).toBe('ベツメイ2')
    expect(await logsOf(a?.id ?? '')).toHaveLength(1)
    const page = await (await get(`/admin/works/${id}`, owner.cookie)).text()
    expect(page).toContain('表記ゆれ: ベツメイ　２')
    expect(page).toContain(`action="/admin/work-aliases/${a?.id}/delete"`)

    const del = await post(`/admin/work-aliases/${a?.id}/delete`, {}, owner.cookie)
    expect(del.status).toBe(302)
    expect(del.headers.get('location')).toBe(`/admin/works/${id}`)
    expect(
      await env.DB.prepare('SELECT 1 FROM work_alias WHERE id = ?').bind(a?.id).first(),
    ).toBeNull()
    const logs = await logsOf(a?.id ?? '')
    expect(logs.map((l) => l.action)).toEqual(['create', 'delete'])
    expect(logs[1].after_json).toBeNull()
    expect((await post(`/admin/work-aliases/${a?.id}/delete`, {}, owner.cookie)).status).toBe(404)
  })

  it('kind 不正・題名空 → 400', async () => {
    const id = await insertWork(env, { title: '別名エラーの作品' })
    for (const form of [
      { title: 'X', kind: 'nickname' },
      { title: '', kind: 'subtitle' },
    ]) {
      expect((await post(`/admin/works/${id}/aliases`, form, owner.cookie)).status).toBe(400)
    }
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM work_alias WHERE work_id = ?')
      .bind(id)
      .first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('統合済み作品では追加・削除とも 400', async () => {
    const into = await insertWork(env, { title: '別名の統合先作品' })
    const id = await insertWork(env, { title: '別名の統合元作品', mergedIntoId: into })
    const aliasId = await insertWorkAlias(env, { workId: id, title: '残る別名', kind: 'subtitle' })
    expect(
      (
        await post(
          `/admin/works/${id}/aliases`,
          { title: '足せない', kind: 'subtitle' },
          owner.cookie,
        )
      ).status,
    ).toBe(400)
    expect((await post(`/admin/work-aliases/${aliasId}/delete`, {}, owner.cookie)).status).toBe(400)
    expect(
      await env.DB.prepare('SELECT 1 FROM work_alias WHERE id = ?').bind(aliasId).first(),
    ).not.toBeNull()
  })

  it('member は別名を削除できない（404）', async () => {
    const id = await insertWork(env, { title: '別名守りの作品' })
    const aliasId = await insertWorkAlias(env, { workId: id, title: '守る', kind: 'subtitle' })
    expect((await post(`/admin/work-aliases/${aliasId}/delete`, {}, member.cookie)).status).toBe(
      404,
    )
  })
})
