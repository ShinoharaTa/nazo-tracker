import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { formatPeriod, formatPlayers, runStatus } from '../src/ui/master'
import {
  insertOrg,
  insertOrgAlias,
  insertRun,
  insertShop,
  insertVenue,
  insertWork,
  insertWorkAlias,
  insertWorksWithRunBatch,
} from './helpers/master'

// 未ログインで GET する（閲覧ルートは公開）
const get = (path: string) => app.request(path, {}, env)
const html = async (path: string) => (await get(path)).text()
const tickets = (h: string) => h.match(/class="ticket( sel)?"/g)?.length ?? 0

const ids: Record<string, string> = {}

beforeAll(async () => {
  ids.lemon = await insertOrg(env, {
    name: 'CrazyLemon',
    escapeIdUrl: 'https://escape.id/crazylemon-org/',
  })
  await insertOrgAlias(env, {
    organizationId: ids.lemon,
    name: 'レモン旧団',
    kind: 'former_name',
    since: '2020-01-01',
    until: '2023-12-31',
  })
  ids.lig = await insertVenue(env, {
    name: 'なぞすぽっとLIG',
    prefecture: '東京都',
    address: '渋谷区 1-2-3',
    organizationId: ids.lemon,
  })
  ids.wordeal = await insertWork(env, {
    title: 'WORDEAL',
    kind: 'room',
    orgId: ids.lemon,
    playerMin: 1,
    playerMax: 4,
    estimatedMinutes: 60,
  })
  ids.wordealRun = await insertRun(env, {
    workId: ids.wordeal,
    channel: 'performance',
    venueId: ids.lig,
    startOn: '2026-11-03',
    endOn: '2026-11-23',
    escapeIdUrl: 'https://escape.id/crazylemon-org/e-wordeal/',
    priceYen: 1500,
  })
  ids.line = await insertWork(env, { title: 'ラインの謎', kind: 'line' })
  await insertRun(env, { workId: ids.line, channel: 'online' })
  ids.web = await insertWork(env, { title: 'ウェブの謎', kind: 'web' })
  ids.hall = await insertWork(env, { title: 'ホールの謎', kind: 'hall' })
  ids.room2 = await insertWork(env, { title: 'ルーム二号', kind: 'room' })
  await insertWorkAlias(env, { workId: ids.room2, title: '旧題ひみつ', kind: 'former_title' })
  ids.merged = await insertWork(env, {
    title: 'マージ済み作品',
    kind: 'room',
    mergedIntoId: ids.wordeal,
  })

  // primary は別団体、run の名義だけ「メイギ団体」
  ids.other = await insertOrg(env, { name: 'ベツ団体' })
  ids.meigi = await insertOrg(env, { name: 'メイギ団体' })
  ids.kit = await insertWork(env, { title: '持ち帰りキット', kind: 'takeaway', orgId: ids.other })
  ids.shop = await insertShop(env, {
    name: 'メイギ通販',
    kind: 'official_store',
    url: 'https://shop.example/',
  })
  await insertRun(env, {
    workId: ids.kit,
    channel: 'sale',
    shopId: ids.shop,
    organizationId: ids.meigi,
    billedAs: 'メイギ団体 presents',
  })
})

describe('GET /works', () => {
  it('題名・団体名・形式ラベル・エリア・期間が出る。統合済みは出ない', async () => {
    const h = await html('/works')
    expect(h).toContain('WORDEAL')
    expect(h).toContain('ルーム · CrazyLemon')
    expect(h).toContain('東京都')
    expect(h).toContain('2026-11-03〜2026-11-23')
    expect(h).toContain(`href="/works/${ids.wordeal}"`)
    expect(h).not.toContain('マージ済み作品')
    expect(h).not.toContain('作品はまだ登録されていません')
  })

  it('?kind=online は line / web だけ', async () => {
    const h = await html('/works?kind=online')
    expect(h).toContain('ラインの謎')
    expect(h).toContain('ウェブの謎')
    expect(h).toContain('オンライン')
    expect(h).not.toContain('WORDEAL')
    expect(h).not.toContain('ホールの謎')
  })

  it('?kind=room は room だけ', async () => {
    const h = await html('/works?kind=room')
    expect(h).toContain('WORDEAL')
    expect(h).toContain('ルーム二号')
    expect(h).not.toContain('ラインの謎')
    expect(h).not.toContain('マージ済み作品')
  })

  it.each([
    ['ＷＯＲＤＥＡＬ', 'WORDEAL'],
    ['word eal', 'WORDEAL'],
    // 作品の別名
    ['旧題ひみつ', 'ルーム二号'],
    // 団体名・団体の別名
    ['crazy', 'WORDEAL'],
    ['レモン旧団', 'WORDEAL'],
  ])('?q=%s で %s が当たる', async (q, title) => {
    const h = await html(`/works?q=${encodeURIComponent(q)}`)
    expect(h).toContain(title)
    expect(h).not.toContain('ホールの謎')
  })

  it('統合済みの作品は検索でも出ない', async () => {
    const h = await html(`/works?q=${encodeURIComponent('マージ済み')}`)
    expect(tickets(h)).toBe(0)
    expect(h).toContain('「マージ済み」に一致する作品はありません')
  })

  it('形式チップの href は q を引き継ぐ', async () => {
    const h = await html('/works?q=wordeal')
    expect(h).toContain('href="/works?kind=room&amp;q=wordeal"')
    expect(h).toContain('href="/works?q=wordeal"')
  })
})

describe('GET /works/:id', () => {
  it('団体・会場・escape.id のリンク、期間、状態、記録ボタン（未ログインは /login）', async () => {
    const res = await get(`/works/${ids.wordeal}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain(`href="/orgs/${ids.lemon}"`)
    expect(h).toContain(`href="/venues/${ids.lig}"`)
    expect(h).toContain('東京都 · なぞすぽっとLIG')
    expect(h).toContain(
      '<a href="https://escape.id/crazylemon-org/e-wordeal/" rel="noopener noreferrer">escape.id</a>',
    )
    expect(h).toContain('2026-11-03〜2026-11-23')
    expect(h).toContain('¥1,500')
    expect(h).toContain('1〜4 人')
    expect(h).toContain('60 分')
    expect(h).toContain('<a class="btn" href="/login">記録する</a>')
    // 左の一覧で該当行が選ばれている
    expect(h).toContain(`<a class="ticket sel" href="/works/${ids.wordeal}">`)
    // 別名・説明が無ければ節を出さない
    expect(h).not.toContain('<h2>別名</h2>')
    expect(h).not.toContain('<h2>説明</h2>')
  })

  it('別名があれば「旧題: …」で出す', async () => {
    const h = await html(`/works/${ids.room2}`)
    expect(h).toContain('<h2>別名</h2>')
    expect(h).toContain('旧題: 旧題ひみつ')
    expect(h).toContain('回の情報はまだありません')
  })

  it('名義と run の団体リンク、販売先の外部リンク', async () => {
    const h = await html(`/works/${ids.kit}`)
    expect(h).toContain('名義: メイギ団体 presents')
    expect(h).toContain(`href="/orgs/${ids.meigi}"`)
    expect(h).toContain('<a href="https://shop.example/" rel="noopener noreferrer">メイギ通販</a>')
  })

  it('統合済みは統合先へ 302', async () => {
    const res = await get(`/works/${ids.merged}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/works/${ids.wordeal}`)
  })

  it('鎖は 5 段までたどり、6 段なら 404', async () => {
    const chain = [await insertWork(env, { title: '鎖の終点' })]
    for (let i = 0; i < 6; i++) {
      chain.push(await insertWork(env, { title: `鎖${i}`, mergedIntoId: chain[chain.length - 1] }))
    }
    const five = await get(`/works/${chain[5]}`)
    expect(five.status).toBe(302)
    expect(five.headers.get('location')).toBe(`/works/${chain[0]}`)
    const six = await get(`/works/${chain[6]}`)
    expect(six.status).toBe(404)
  })

  it('存在しない id は Layout 付きの 404', async () => {
    const res = await get('/works/nope')
    expect(res.status).toBe(404)
    const h = await res.text()
    expect(h).toContain('<html lang="ja">')
    expect(h).toContain('見つかりませんでした。')
  })
})

describe('GET /orgs/:id', () => {
  it('名前・別名・運営会場・作品が出る', async () => {
    const res = await get(`/orgs/${ids.lemon}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('CrazyLemon')
    expect(h).toContain('旧名: レモン旧団（2020-01-01〜2023-12-31）')
    expect(h).toContain(`href="/venues/${ids.lig}"`)
    expect(h).toContain('href="https://escape.id/crazylemon-org/"')
  })

  it('primary が別団体でも run の名義が該当する作品が出る', async () => {
    const h = await html(`/orgs/${ids.meigi}`)
    expect(h).toContain('持ち帰りキット')
  })

  it('統合済みは 302、存在しなければ 404', async () => {
    const merged = await insertOrg(env, { name: '旧レモン', mergedIntoId: ids.lemon })
    const res = await get(`/orgs/${merged}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/orgs/${ids.lemon}`)
    expect((await get('/orgs/nope')).status).toBe(404)
  })
})

describe('GET /venues/:id', () => {
  it('都道府県・住所・運営団体・公演一覧（作品リンク）', async () => {
    const res = await get(`/venues/${ids.lig}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('東京都')
    expect(h).toContain('渋谷区 1-2-3')
    expect(h).toContain(`href="/orgs/${ids.lemon}"`)
    expect(h).toContain(`href="/works/${ids.wordeal}"`)
    expect(h).toContain('2026-11-03〜2026-11-23')
  })

  it('統合済みは 302、存在しなければ 404', async () => {
    const merged = await insertVenue(env, { name: '旧LIG', mergedIntoId: ids.lig })
    const res = await get(`/venues/${merged}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/venues/${ids.lig}`)
    expect((await get('/venues/nope')).status).toBe(404)
  })
})

describe('ページング', () => {
  beforeAll(async () => {
    for (let i = 0; i < 51; i++) {
      await insertWork(env, { title: `頁送り${String(i).padStart(2, '0')}`, kind: 'other' })
    }
  })

  it('1 頁目は 50 件と「次の 50 件」、2 頁目は 1 件と「前の 50 件」', async () => {
    const q = encodeURIComponent('頁送り')
    const p1 = await html(`/works?q=${q}`)
    expect(tickets(p1)).toBe(50)
    expect(p1).toContain(`href="/works?q=${q}&amp;page=2"`)
    expect(p1).toContain('次の 50 件')
    expect(p1).not.toContain('前の 50 件')
    const p2 = await html(`/works?q=${q}&page=2`)
    expect(tickets(p2)).toBe(1)
    expect(p2).toContain('前の 50 件')
    expect(p2).not.toContain('次の 50 件')
  })

  it.each(['0', 'x', '-1'])('?page=%s は 1 頁目扱い', async (page) => {
    const h = await html(`/works?q=${encodeURIComponent('頁送り')}&page=${page}`)
    expect(tickets(h)).toBe(50)
    expect(h).not.toContain('前の 50 件')
  })
})

describe('表示用の関数', () => {
  const p = (startOn: string | null, endOn: string | null, isPermanent = 0) => ({
    startOn,
    endOn,
    isPermanent,
  })

  it.each([
    [p(null, null, 1), '常設'],
    [p('2026-01-01', '2026-12-31', 1), '常設 · 〜2026-12-31'],
    [p('2026-11-03', '2026-11-23'), '2026-11-03〜2026-11-23'],
    [p('2026-11-03', null), '2026-11-03〜'],
    [p(null, '2026-11-23'), '〜2026-11-23'],
    [p(null, null), '期間未定'],
  ])('formatPeriod(%o) = %s', (r, s) => {
    expect(formatPeriod(r)).toBe(s)
  })

  it.each([
    [1, 4, '1〜4 人'],
    [4, 4, '4 人'],
    [1, null, '1 人〜'],
    [null, 4, '〜4 人'],
    [null, null, null],
  ])('formatPlayers(%s, %s) = %s', (min, max, s) => {
    expect(formatPlayers(min, max)).toBe(s)
  })

  it('runStatus: 終了 / 予定 / 開催中・配信中・販売中', () => {
    const today = '2026-11-09'
    const r = (
      channel: 'performance' | 'online' | 'sale',
      startOn: string | null,
      endOn: string | null,
    ) => ({
      channel,
      startOn,
      endOn,
    })
    expect(runStatus(r('performance', '2026-11-01', '2026-11-08'), today)).toBe('終了')
    expect(runStatus(r('performance', '2026-11-10', null), today)).toBe('予定')
    expect(runStatus(r('performance', '2026-11-09', '2026-11-09'), today)).toBe('開催中')
    expect(runStatus(r('online', null, null), today)).toBe('配信中')
    expect(runStatus(r('sale', null, null), today)).toBe('販売中')
  })
})

describe('レビュー反映（#42）', () => {
  it.each([
    ['日本語 17 文字', 'あいうえおかきくけこさしすせそたち'],
    ['ASCII 60 文字', 'a'.repeat(60)],
  ])('長い検索語（%s）でも 200', async (_, q) => {
    const res = await get(`/works?q=${encodeURIComponent(q)}`)
    expect(res.status).toBe(200)
  })

  it.each(['%', '_'])('q=%s はワイルドカードにならない（0 件）', async (q) => {
    const h = await html(`/works?q=${encodeURIComponent(q)}`)
    expect(tickets(h)).toBe(0)
  })

  it('kind 指定で 0 件なら「この形式の作品はまだありません。」', async () => {
    const h = await html('/works?kind=stroll')
    expect(tickets(h)).toBe(0)
    expect(h).toContain('この形式の作品はまだありません。')
  })

  it('http(s) 以外の official_url はリンクにしない', async () => {
    const id = await insertWork(env, { title: '危険なURL', officialUrl: 'javascript:alert(1)' })
    const h = await html(`/works/${id}`)
    expect(h).not.toContain('href="javascript:')
    expect(h).toContain('<span>javascript:alert(1)</span>')
  })

  it('作品 101 件の団体ページも 200（上限 100 件で切る）', async () => {
    const org = await insertOrg(env, { name: '大量団体' })
    await insertWorksWithRunBatch(
      env,
      Array.from({ length: 101 }, (_, i) => ({ title: `大量${i}`, kind: 'other', orgId: org })),
      'online',
    )
    const res = await get(`/orgs/${org}`)
    expect(res.status).toBe(200)
    // 左ページ（作品一覧）を除いた右ページだけ数える
    const right = (await res.text()).split('class="page pane-r"')[1]
    expect(tickets(right)).toBe(100)
  })
})
