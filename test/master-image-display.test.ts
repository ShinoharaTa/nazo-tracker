// マスタの画像の表示（#150 PR 4）。判定は shownImage 1 か所、全体スイッチは MASTER_IMAGES
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { countingD1 } from '../src/db/d1-count'
import app from '../src/index'
import { type ImageSource, shownImage } from '../src/lib/image-url'
import { loginAs } from './helpers/auth'
import { insertOrg, insertRun, insertWork } from './helpers/master'

const IMG = 'https://static.escape.id/i/o/takarush/abc.png'
const PAGE = 'https://escape.id/takarush-org/e-room666/'
const LOGO = 'https://static.escape.id/o/takarush/nanica_logo.png'
const ORG_PAGE = 'https://escape.id/takarush-org/'

const on = { ...env, MASTER_IMAGES: '1' }
const off = { ...env, MASTER_IMAGES: '0' }

const html = async (path: string, e: Cloudflare.Env, cookie?: string) => {
  const res = await app.request(path, cookie ? { headers: { Cookie: cookie } } : {}, e)
  expect(res.status).toBe(200)
  return res.text()
}

const imgs = (h: string) => h.match(/<img [^>]*>/g) ?? []

// 一覧の 1 行（<a class="ticket" href="/works/<id>"> … </a>）
const ticketOf = (h: string, id: string) => {
  const m = h.match(new RegExp(`<a class="ticket[^"]*" href="[^"]*${id}">.*?</a>`))
  if (!m) throw new Error(`ticket not found: ${id}`)
  return m[0]
}

const setWorkImage = (id: string, url: string | null, page: string | null, blocked = 0) =>
  env.DB.prepare(
    'UPDATE work SET image_url = ?, image_page_url = ?, image_blocked = ? WHERE id = ?',
  )
    .bind(url, page, blocked, id)
    .run()

const setOrgLogo = (id: string, url: string | null, page: string | null, blocked = 0) =>
  env.DB.prepare(
    'UPDATE organization SET logo_url = ?, logo_page_url = ?, image_blocked = ? WHERE id = ?',
  )
    .bind(url, page, blocked, id)
    .run()

const src = (s: Partial<ImageSource>): ImageSource => ({
  url: IMG,
  pageUrl: PAGE,
  blocked: 0,
  orgBlocked: 0,
  ...s,
})

describe('shownImage', () => {
  it('一覧は ?t=sm、詳細は ?t=md。取得元の host を返す', () => {
    expect(shownImage(true, src({}), 'list')).toEqual({
      src: `${IMG}?t=sm`,
      pageUrl: PAGE,
      pageHost: 'escape.id',
    })
    expect(shownImage(true, src({}), 'detail')?.src).toBe(`${IMG}?t=md`)
  })

  it('/i/ で始まらないパス（ロゴの /o/）はそのまま', () => {
    expect(shownImage(true, src({ url: LOGO }), 'list')?.src).toBe(LOGO)
    expect(shownImage(true, src({ url: LOGO }), 'detail')?.src).toBe(LOGO)
  })

  it.each<[string, boolean, Partial<ImageSource>]>([
    ['全体スイッチ OFF', false, {}],
    ['URL が NULL', true, { url: null }],
    ['取得元が NULL', true, { pageUrl: null }],
    ['許可外の host', true, { url: 'https://example.com/i/a.png' }],
    ['サブドメイン', true, { url: 'https://x.static.escape.id/i/a.png' }],
    ['http', true, { url: 'http://static.escape.id/i/a.png' }],
    ['.svg', true, { url: 'https://static.escape.id/i/a.svg' }],
    ['取得元が X', true, { pageUrl: 'https://x.com/foo' }],
    ['行が image_blocked=1', true, { blocked: 1 }],
    ['主団体が image_blocked=1', true, { orgBlocked: 1 }],
  ])('%s なら出さない', (_, enabled, s) => {
    expect(shownImage(enabled, src(s), 'list')).toBeNull()
    expect(shownImage(enabled, src(s), 'detail')).toBeNull()
  })

  it('主団体なし（orgBlocked=null）は出す', () => {
    expect(shownImage(true, src({ orgBlocked: null }), 'list')).not.toBeNull()
  })
})

describe('表示', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    ids.org = await insertOrg(env, { name: 'タカラッシュ' })
    ids.blockedOrg = await insertOrg(env, { name: '止めた団体' })
    ids.plain = await insertWork(env, { title: '画像なし', kind: 'room', orgId: ids.org })
    await insertRun(env, { workId: ids.plain, channel: 'online' })
    ids.img = await insertWork(env, { title: '画像あり', kind: 'room', orgId: ids.org })
    await insertRun(env, { workId: ids.img, channel: 'online' })
    ids.blocked = await insertWork(env, { title: '作品で止めた', kind: 'room', orgId: ids.org })
    ids.orgBlocked = await insertWork(env, {
      title: '団体で止めた',
      kind: 'room',
      orgId: ids.blockedOrg,
    })
    ids.foreign = await insertWork(env, { title: '許可外', kind: 'room', orgId: ids.org })
    await setWorkImage(ids.img, IMG, PAGE)
    // 作品の blocked は保存時に URL を NULL にするが、表示の判定は URL があっても出さない
    await setWorkImage(ids.blocked, IMG, PAGE, 1)
    await setWorkImage(ids.orgBlocked, IMG, PAGE)
    await setWorkImage(ids.foreign, 'https://example.com/i/a.png', PAGE)
    await setOrgLogo(ids.org, LOGO, ORG_PAGE)
    await setOrgLogo(ids.blockedOrg, null, null, 1)
  })

  describe('MASTER_IMAGES=0', () => {
    it.each([
      ['作品一覧', () => '/works'],
      ['作品詳細', () => `/works/${ids.img}`],
      ['団体詳細', () => `/orgs/${ids.org}`],
    ])('%s に <img> が 1 つも出ない', async (_, path) => {
      const h = await html(path(), off)
      expect(imgs(h)).toEqual([])
      expect(h).not.toContain('data-mimg')
      expect(h).not.toContain('static.escape.id')
    })

    it('既定（vitest の binding）も "0"', async () => {
      expect(env.MASTER_IMAGES).toBe('0')
      expect(imgs(await html('/works', env))).toEqual([])
    })
  })

  describe('MASTER_IMAGES=1', () => {
    it('一覧: URL のある作品の stub に ?t=sm の <img>（属性つき・alt=""）', async () => {
      const t = ticketOf(await html('/works', on), ids.img)
      expect(t).toContain(
        `<div class="stub"><span class="mimg thumb" data-mimg=""><img src="${IMG}?t=sm" alt="" width="72" height="40" loading="lazy" decoding="async" referrerpolicy="no-referrer"/></span><span class="nd">ルーム<br/>オンライン</span></div>`,
      )
    })

    it('一覧: 画像なしの行の HTML は OFF のときと同じ（stub は文字 2 行だけ）', async () => {
      const a = ticketOf(await html('/works', on), ids.plain)
      const b = ticketOf(await html('/works', off), ids.plain)
      expect(a).toBe(b)
      expect(a).toContain('<div class="stub"><span class="nd">ルーム<br/>オンライン</span></div>')
    })

    it('一覧: 作品 blocked / 団体 blocked / 許可外 host は出ない', async () => {
      const h = await html('/works', on)
      for (const id of [ids.blocked, ids.orgBlocked, ids.foreign]) {
        expect(ticketOf(h, id)).not.toContain('<img')
      }
      // 一覧の <img> は画像ありの 1 件だけ
      expect(imgs(h)).toHaveLength(1)
    })

    it('作品詳細: 16:9 の箱に ?t=md の <img>、箱ごと取得元へのリンクと「画像: escape.id ›」', async () => {
      const h = await html(`/works/${ids.img}`, on)
      expect(h).toContain(
        `<a class="mimg wide" href="${PAGE}" rel="noopener noreferrer"><img src="${IMG}?t=md" alt="画像あり の画像" width="640" height="360" loading="lazy" decoding="async" referrerpolicy="no-referrer"/></a>`,
      )
      expect(h).toContain(
        `<a class="mcap" href="${PAGE}" rel="noopener noreferrer">画像: escape.id ›</a>`,
      )
    })

    it.each([
      ['作品 blocked', () => ids.blocked],
      ['団体 blocked', () => ids.orgBlocked],
      ['許可外 host', () => ids.foreign],
      ['画像なし', () => ids.plain],
    ])('作品詳細: %s は出ない（右ページに画像も出典も無い）', async (_, id) => {
      const h = await html(`/works/${id()}`, on)
      const right = h.slice(h.indexOf('pane-r'))
      expect(right).not.toContain('<img')
      expect(right).not.toContain('画像: ')
    })

    it('団体詳細: 高さ 48 のロゴ（alt「{団体名} のロゴ」）と「ロゴ: escape.id ›」', async () => {
      const h = await html(`/orgs/${ids.org}`, on)
      expect(h).toContain(
        `<img src="${LOGO}" alt="タカラッシュ のロゴ" width="200" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer"/>`,
      )
      expect(h).toContain(
        `<a class="mcap" href="${ORG_PAGE}" rel="noopener noreferrer">ロゴ: escape.id ›</a>`,
      )
    })

    it('団体詳細: blocked の団体はロゴも作品の画像も出ない', async () => {
      const h = await html(`/orgs/${ids.blockedOrg}`, on)
      const right = h.slice(h.indexOf('pane-r'))
      expect(right).not.toContain('<img')
      expect(right).not.toContain('ロゴ: ')
    })

    it('マイリストの行に出す。記録一覧には出さない', async () => {
      const { cookie } = await loginAs(env, { subject: 'mimg-alice' })
      const form = (body: Record<string, string>) => ({
        method: 'POST',
        headers: {
          Origin: env.APP_ORIGIN,
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
        },
        body: new URLSearchParams(body).toString(),
      })
      const wished = await app.request('/records/wishlist', form({ work_id: ids.img }), on)
      expect(wished.status).toBe(302)
      const wish = await html('/records?tab=wish', on, cookie)
      expect(ticketOf(wish, ids.img)).toContain(`<img src="${IMG}?t=sm"`)
      expect(imgs(await html('/records?tab=wish', off, cookie))).toEqual([])
      // 記録一覧（RecordTicket）は stub が日付のまま
      expect(imgs(await html('/records', on, cookie))).toEqual([])
    })
  })

  // main（PR 4 の前）の実測: /works 3、/works/:id 7、/orgs/:id 9（未ログイン）
  it.each([
    ['作品一覧', () => '/works', 3],
    ['作品詳細', () => `/works/${ids.img}`, 7],
    ['団体詳細', () => `/orgs/${ids.org}`, 9],
  ])('%s のクエリ数が増えていない（ON / OFF とも）', async (_, path, calls) => {
    for (const e of [on, off]) {
      const c = countingD1(env.DB)
      const res = await app.request(path(), {}, { ...e, DB: c.db })
      expect(res.status).toBe(200)
      expect(c.n.calls).toBe(calls)
    }
  })
})

describe('データの扱い', () => {
  it.each([
    ['0', off],
    ['1', on],
  ])('MASTER_IMAGES=%s でも画像の扱いと連絡先を出す', async (_, e) => {
    const { cookie } = await loginAs(env, { subject: `mimg-data-${_}` })
    const h = await html('/settings', e, cookie)
    expect(h).toContain('作品の画像と団体のロゴは、このサイトには保存していません。')
    expect(h).toContain(
      '<a href="https://bsky.app/profile/shino3.net" rel="noopener noreferrer">@shino3.net</a>',
    )
    expect(h).toContain(
      '<a href="https://x.com/SHINOHARATTT" rel="noopener noreferrer">@SHINOHARATTT</a>',
    )
  })
})
