import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertRun, insertShop, insertVenue, insertWork } from './helpers/master'

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

type RunDbRow = {
  id: string
  work_id: string
  channel: string
  organization_id: string | null
  billed_as: string | null
  venue_id: string | null
  shop_id: string | null
  start_on: string | null
  end_on: string | null
  is_permanent: number
  escape_id_url: string | null
  ticket_url: string | null
  price_yen: number | null
  escape_type_raw: string | null
  note: string | null
  updated_at: string
}

const runsOf = async (workId: string) =>
  (
    await env.DB.prepare('SELECT * FROM run WHERE work_id = ? ORDER BY id')
      .bind(workId)
      .all<RunDbRow>()
  ).results

const runRow = (id: string) =>
  env.DB.prepare('SELECT * FROM run WHERE id = ?').bind(id).first<RunDbRow>()

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare('SELECT * FROM change_log WHERE row_id = ? ORDER BY id')
      .bind(rowId)
      .all<{ table_name: string; action: string; before_json: string; after_json: string }>()
  ).results

let owner: { cookie: string; userId: string }
let member: { cookie: string }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'ar-owner', owner: true })
  member = await loginAs(env, { subject: 'ar-member' })
})

describe('回の作成', () => {
  it('全項目 → 302 /admin/works/<workId>?saved=1、change_log に create、編集ページの回一覧に出る', async () => {
    const org = await insertOrg(env, { name: 'カイ団体' })
    const workId = await insertWork(env, { title: '回を作る作品', orgId: org })
    const venueId = await insertVenue(env, { name: 'カイ会場', prefecture: '東京都' })
    const res = await post(
      `/admin/works/${workId}/runs/new`,
      {
        channel: 'performance',
        organization_id: org,
        billed_as: 'カイ団体（旧名義）',
        venue_id: venueId,
        start_on: '2026-03-01',
        end_on: '2026-03-31',
        is_permanent: '1',
        escape_id_url: 'HTTPS://ESCAPE.ID/kai-org/e-kai?utm=1#x',
        ticket_url: 'https://example.com/ticket',
        price_yen: '3500',
        escape_type_raw: 'hall',
        note: 'メモ\n2 行目',
        // body の work_id は使わない
        work_id: 'other',
      },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/works/${workId}?saved=1`)
    const runs = await runsOf(workId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      work_id: workId,
      channel: 'performance',
      organization_id: org,
      billed_as: 'カイ団体（旧名義）',
      venue_id: venueId,
      shop_id: null,
      start_on: '2026-03-01',
      end_on: '2026-03-31',
      is_permanent: 1,
      escape_id_url: 'https://escape.id/kai-org/e-kai/',
      ticket_url: 'https://example.com/ticket',
      price_yen: 3500,
      escape_type_raw: 'hall',
      note: 'メモ\n2 行目',
    })
    const logs = await logsOf(runs[0].id)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ table_name: 'run', action: 'create' })
    expect(JSON.parse(logs[0].after_json).work_id).toBe(workId)

    const page = await (await get(`/admin/works/${workId}?saved=1`, owner.cookie)).text()
    expect(page).toContain(`href="/admin/runs/${runs[0].id}"`)
    expect(page).toContain('公演 · 東京都 · カイ会場')
  })

  it('新規フォームの名義団体は作品の団体が既定', async () => {
    const org = await insertOrg(env, { name: 'キテイ団体' })
    const workId = await insertWork(env, { title: '既定の作品', orgId: org })
    const html = await (await get(`/admin/works/${workId}/runs/new`, owner.cookie)).text()
    expect(html).toContain(`<option value="${org}" selected="">キテイ団体</option>`)
  })

  it('performance で会場無し（会場未定）は通る。sale は shop があれば通る', async () => {
    const workId = await insertWork(env, { title: '会場未定の作品' })
    const shopId = await insertShop(env, { name: 'カイの店', kind: 'booth' })
    expect(
      (await post(`/admin/works/${workId}/runs/new`, { channel: 'performance' }, owner.cookie))
        .status,
    ).toBe(302)
    expect(
      (
        await post(
          `/admin/works/${workId}/runs/new`,
          { channel: 'sale', shop_id: shopId },
          owner.cookie,
        )
      ).status,
    ).toBe(302)
    expect(await runsOf(workId)).toHaveLength(2)
  })

  it.each<
    [
      string,
      (ids: { venueId: string; shopId: string; mergedVenue: string }) => Record<string, string>,
    ]
  >([
    ['channel が空', () => ({})],
    ['channel が不正', () => ({ channel: 'stream' })],
    ['sale で shop 無し', () => ({ channel: 'sale' })],
    ['performance + shop_id', ({ shopId }) => ({ channel: 'performance', shop_id: shopId })],
    ['online + venue_id', ({ venueId }) => ({ channel: 'online', venue_id: venueId })],
    [
      'sale + venue_id',
      ({ venueId, shopId }) => ({ channel: 'sale', shop_id: shopId, venue_id: venueId }),
    ],
    ['online + is_permanent', () => ({ channel: 'online', is_permanent: '1' })],
    ['is_permanent が 1 以外', () => ({ channel: 'performance', is_permanent: 'on' })],
    ['start > end', () => ({ channel: 'online', start_on: '2026-05-02', end_on: '2026-05-01' })],
    ['日付が実在しない', () => ({ channel: 'online', start_on: '2026-02-29' })],
    ['price が負', () => ({ channel: 'online', price_yen: '-1' })],
    ['price が 1000000', () => ({ channel: 'online', price_yen: '1000000' })],
    [
      'escape_id_url が団体 URL',
      () => ({ channel: 'online', escape_id_url: 'https://escape.id/a-org/' }),
    ],
    ['ticket_url が javascript:', () => ({ channel: 'online', ticket_url: 'javascript:alert(1)' })],
    ['ticket_url に空白', () => ({ channel: 'online', ticket_url: 'https://exa mple.com/' })],
    ['billed_as に制御文字', () => ({ channel: 'online', billed_as: 'a\u0007b' })],
    ['統合済みの会場', ({ mergedVenue }) => ({ channel: 'performance', venue_id: mergedVenue })],
    ['存在しない販売先', () => ({ channel: 'sale', shop_id: 'nope' })],
  ])('%s → 400、行は増えない', async (_, make) => {
    const workId = await insertWork(env, { title: `エラー回の作品${Math.random()}` })
    const venueId = await insertVenue(env, { name: 'エラー回の会場' })
    const mergedVenue = await insertVenue(env, { name: 'エラー回の旧会場', mergedIntoId: venueId })
    const shopId = await insertShop(env, { name: 'エラー回の店', kind: 'other' })
    const res = await post(
      `/admin/works/${workId}/runs/new`,
      make({ venueId, shopId, mergedVenue }),
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('role="alert"')
    expect(await runsOf(workId)).toHaveLength(0)
  })

  it('organization_id に統合済みの団体 → 400、行は増えない', async () => {
    const into = await insertOrg(env, { name: '回の名義の統合先' })
    const merged = await insertOrg(env, { name: '回の名義の統合元', mergedIntoId: into })
    const workId = await insertWork(env, { title: '統合済み名義の作品' })
    const res = await post(
      `/admin/works/${workId}/runs/new`,
      { channel: 'online', organization_id: merged },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('名義団体が見つからないか、統合済みです')
    expect(await runsOf(workId)).toHaveLength(0)
  })

  it('price は 0 と 999999 を許す', async () => {
    const workId = await insertWork(env, { title: '価格境界の作品' })
    for (const price_yen of ['0', '999999']) {
      expect(
        (
          await post(
            `/admin/works/${workId}/runs/new`,
            { channel: 'online', price_yen },
            owner.cookie,
          )
        ).status,
      ).toBe(302)
    }
  })

  it('escape_id_url は正規化後の値で重複を見る', async () => {
    const other = await insertWork(env, { title: '先に URL を持つ作品' })
    await insertRun(env, {
      workId: other,
      channel: 'performance',
      escapeIdUrl: 'https://escape.id/dup-org/e-dup/',
    })
    const workId = await insertWork(env, { title: 'URL がかぶる作品' })
    const res = await post(
      `/admin/works/${workId}/runs/new`,
      { channel: 'performance', escape_id_url: 'https://ESCAPE.id/dup-org/e-dup?x=1' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('同じ escape.id URL の回があります')
  })

  it('エラー時は送信値が戻る', async () => {
    const workId = await insertWork(env, { title: '埋め戻しの作品' })
    const res = await post(
      `/admin/works/${workId}/runs/new`,
      { channel: 'sale', billed_as: '"><b>x</b>', is_permanent: '1' },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('<option value="sale" selected="">')
    expect(html).toMatch(/name="is_permanent" value="1" checked/)
  })

  it('統合済み・存在しない作品には作れない', async () => {
    const into = await insertWork(env, { title: '回の統合先作品' })
    const merged = await insertWork(env, { title: '回の統合元作品', mergedIntoId: into })
    expect(
      (await post(`/admin/works/${merged}/runs/new`, { channel: 'online' }, owner.cookie)).status,
    ).toBe(400)
    expect(await runsOf(merged)).toHaveLength(0)
    expect((await get('/admin/works/nope/runs/new', owner.cookie)).status).toBe(404)
    expect(
      (await post('/admin/works/nope/runs/new', { channel: 'online' }, owner.cookie)).status,
    ).toBe(404)
  })

  it('member は 404、未ログイン POST は 401', async () => {
    const workId = await insertWork(env, { title: '認可の回の作品' })
    expect((await get(`/admin/works/${workId}/runs/new`, member.cookie)).status).toBe(404)
    expect(
      (await post(`/admin/works/${workId}/runs/new`, { channel: 'online' }, member.cookie)).status,
    ).toBe(404)
    expect((await post(`/admin/works/${workId}/runs/new`, { channel: 'online' })).status).toBe(401)
    expect(await runsOf(workId)).toHaveLength(0)
  })
})

describe('回の編集', () => {
  it('end_on を入れる → 302 /admin/works/<workId>?saved=1、change_log に update。無変更は記録しない', async () => {
    const workId = await insertWork(env, { title: '回を編集する作品' })
    const runId = await insertRun(env, {
      workId,
      channel: 'performance',
      startOn: '2026-01-01',
      isPermanent: true,
    })
    const page = await (await get(`/admin/runs/${runId}`, owner.cookie)).text()
    expect(page).toContain('value="2026-01-01"')
    expect(page).toContain('回を編集する作品')

    const form = {
      channel: 'performance',
      start_on: '2026-01-01',
      end_on: '2026-06-30',
      is_permanent: '1',
    }
    const res = await post(`/admin/runs/${runId}`, form, owner.cookie)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/works/${workId}?saved=1`)
    expect((await runRow(runId))?.end_on).toBe('2026-06-30')
    const logs = await logsOf(runId)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('update')
    expect(JSON.parse(logs[0].before_json).end_on).toBeNull()
    expect(JSON.parse(logs[0].after_json).end_on).toBe('2026-06-30')

    expect((await post(`/admin/runs/${runId}`, form, owner.cookie)).status).toBe(302)
    expect(await logsOf(runId)).toHaveLength(1)
  })

  it('自分の escape_id_url はそのまま保存できる', async () => {
    const workId = await insertWork(env, { title: '自分の URL の作品' })
    const runId = await insertRun(env, {
      workId,
      channel: 'online',
      escapeIdUrl: 'https://escape.id/self-org/e-self/',
    })
    const res = await post(
      `/admin/runs/${runId}`,
      { channel: 'online', escape_id_url: 'https://escape.id/self-org/e-self/', price_yen: '100' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect((await runRow(runId))?.price_yen).toBe(100)
  })

  it('検証エラー → 400 で行は変わらない', async () => {
    const workId = await insertWork(env, { title: '回の編集エラーの作品' })
    const runId = await insertRun(env, { workId, channel: 'online' })
    const res = await post(`/admin/runs/${runId}`, { channel: 'sale' }, owner.cookie)
    expect(res.status).toBe(400)
    expect((await runRow(runId))?.channel).toBe('online')
  })

  it('統合済み作品の回は編集できない（GET はフォーム無し、POST は 400）。存在しない id は 404', async () => {
    const into = await insertWork(env, { title: '回編集の統合先' })
    const merged = await insertWork(env, { title: '回編集の統合元', mergedIntoId: into })
    const runId = await insertRun(env, { workId: merged, channel: 'online' })
    const page = await (await get(`/admin/runs/${runId}`, owner.cookie)).text()
    expect(page).toContain(`href="/admin/works/${into}"`)
    expect(page).not.toContain('name="channel"')
    expect(
      (await post(`/admin/runs/${runId}`, { channel: 'online', price_yen: '1' }, owner.cookie))
        .status,
    ).toBe(400)
    expect((await runRow(runId))?.price_yen).toBeNull()
    expect((await get('/admin/runs/nope', owner.cookie)).status).toBe(404)
    expect((await post('/admin/runs/nope', { channel: 'online' }, owner.cookie)).status).toBe(404)
  })
})
