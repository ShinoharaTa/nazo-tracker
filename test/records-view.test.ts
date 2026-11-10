import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { scopedTo } from '../src/db/scoped'
import app from '../src/index'
import { loginAs } from './helpers/auth'
import { insertOrg, insertRun, insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertSession } from './helpers/records'

const db = createDb(env.DB)
const SPOILER = '最後の扉の暗証番号は 0412。'

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
let carol = { cookie: '', userId: '' }
const ids: Record<string, string> = {}

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'records-view-alice' })
  bob = await loginAs(env, { subject: 'records-view-bob' })
  carol = await loginAs(env, { subject: 'records-view-carol' })
  ids.org = await insertOrg(env, { name: '閲覧テスト団' })
  ids.work = await insertWork(env, { title: '閲覧テストの謎', kind: 'stroll', orgId: ids.org })
  ids.work2 = await insertWork(env, { title: '進行中の謎', kind: 'stroll' })
  ids.work3 = await insertWork(env, { title: '積んだ謎' })
  ids.venue = await insertVenue(env, { name: '閲覧会場', prefecture: '大阪府' })
  ids.run = await insertRun(env, {
    workId: ids.work,
    channel: 'performance',
    venueId: ids.venue,
    startOn: '2026-09-01',
    endOn: '2026-10-31',
  })
  // alice: クリア（10-01）、進行中（started 10-05）、日付なしの買った
  ids.cleared = await insertAttempt(env, {
    userId: alice.userId,
    workId: ids.work,
    status: 'cleared',
    finishedOn: '2026-10-01',
    runId: ids.run,
    difficulty: 4,
    volume: 3,
    durationSec: 5400,
    companions: 'みお、けい',
    partySize: 3,
    rating: 5,
    memo: '楽しかった',
    spoilerMemo: SPOILER,
  })
  ids.inProgress = await insertAttempt(env, {
    userId: alice.userId,
    workId: ids.work2,
    status: 'in_progress',
    startedOn: '2026-10-05',
  })
  ids.purchased = await insertAttempt(env, {
    userId: alice.userId,
    workId: ids.work3,
    status: 'purchased',
  })
  await insertGenre(env, ids.cleared, alice.userId, 'g_logic')
  await insertGenre(env, ids.cleared, alice.userId, 'g_hirameki')
  // bob の記録（alice には出ない）
  ids.bobAttempt = await insertAttempt(env, {
    userId: bob.userId,
    workId: ids.work,
    status: 'failed',
    finishedOn: '2026-10-20',
    spoilerMemo: 'ボブのネタバレ',
  })
})

const get = (path: string, cookie: string | null = alice.cookie, headers = {}) =>
  app.request(path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, env)

const ticketHrefs = (h: string) =>
  [...h.matchAll(/<a class="ticket(?: sel)?" href="\/records\/([0-9A-Z]+)">/g)].map((m) => m[1])

describe('v_attempt_enriched', () => {
  it('migration で作られ、spoiler_memo 列を持たない', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(v_attempt_enriched)').all<{
      name: string
    }>()
    const names = cols.results.map((c) => c.name)
    expect(names).toContain('display_on')
    expect(names).toContain('session_count')
    expect(names).not.toContain('spoiler_memo')
  })

  it('進行ログがあれば display_on は最新ログ日、session_count と合計', async () => {
    const id = await insertAttempt(env, {
      userId: carol.userId,
      workId: ids.work2,
      status: 'in_progress',
      startedOn: '2026-10-01',
    })
    await insertSession(env, {
      attemptId: id,
      userId: carol.userId,
      playedOn: '2026-10-04',
      durationSec: 3600,
    })
    await insertSession(env, {
      attemptId: id,
      userId: carol.userId,
      playedOn: '2026-10-11',
      durationSec: 1800,
      progressNote: '第 3 章まで',
    })
    const row = await env.DB.prepare(
      'SELECT display_on, session_count, session_duration_sec, last_played_on FROM v_attempt_enriched WHERE id = ?',
    )
      .bind(id)
      .first()
    expect(row).toEqual({
      display_on: '2026-10-11',
      session_count: 2,
      session_duration_sec: 5400,
      last_played_on: '2026-10-11',
    })
    // 詳細: 「n 日目」と合計
    const h = await (await get(`/records/${id}`, carol.cookie)).text()
    expect(h).toContain('第 3 章まで · 2 日目')
    expect(h).toContain('1時間30分')
    expect(h.match(/class="log"/g)?.length).toBe(2)
  })
})

describe('own()', () => {
  it('getAttempt は他人の id で null', async () => {
    expect(await scopedTo(db, alice.userId).own().getAttempt(ids.bobAttempt)).toBeNull()
    expect(await scopedTo(db, alice.userId).own().getAttempt(ids.cleared)).not.toBeNull()
  })

  it('playedCount は cleared + failed', async () => {
    expect(await scopedTo(db, alice.userId).own().playedCount()).toBe(1)
    expect(await scopedTo(db, bob.userId).own().playedCount()).toBe(1)
  })
})

describe('GET /records', () => {
  it('display_on 降順（進行中 → クリア → 買った）で、bob の行は出ない', async () => {
    const h = await (await get('/records')).text()
    expect(ticketHrefs(h)).toEqual([ids.inProgress, ids.cleared, ids.purchased])
    expect(h).not.toContain(ids.bobAttempt)
    expect(h).toContain('1 件プレイ ›')
    expect(h).toContain('class="chip st-cleared"')
    expect(h).toContain('難易度 4 · 同行 みお、けい')
    // StubDate は「日付<br/>なし」の 2 行
    expect(h).toContain('<span class="nd">日付<br/>なし</span>')
    expect(h).not.toContain(SPOILER)
  })

  it('?tab=pending は purchased / in_progress だけ', async () => {
    const h = await (await get('/records?tab=pending')).text()
    expect(ticketHrefs(h)).toEqual([ids.inProgress, ids.purchased])
  })

  it('pending が空なら専用の文言、all が空なら既存の文言', async () => {
    const dave = await loginAs(env, { subject: 'records-view-dave' })
    expect(await (await get('/records?tab=pending', dave.cookie)).text()).toContain(
      '進行中・積み謎はありません。',
    )
    const h = await (await get('/records', dave.cookie)).text()
    expect(h).toContain('まだ記録はありません。')
    expect(h).toContain('0 件プレイ ›')
  })

  it('TopBar は cleared + failed の件数', async () => {
    const eve = await loginAs(env, { subject: 'records-view-eve' })
    await insertAttempt(env, { userId: eve.userId, workId: ids.work, status: 'cleared' })
    await insertAttempt(env, { userId: eve.userId, workId: ids.work, status: 'failed' })
    await insertAttempt(env, { userId: eve.userId, workId: ids.work, status: 'dropped' })
    expect(await (await get('/records', eve.cookie)).text()).toContain('2 件プレイ ›')
  })

  it('51 件で Pager、2 頁目に残り 1 件', async () => {
    const frank = await loginAs(env, { subject: 'records-view-frank' })
    for (let i = 0; i < 51; i++) {
      await insertAttempt(env, {
        userId: frank.userId,
        workId: ids.work3,
        status: 'cleared',
        attemptNo: i + 1,
        finishedOn: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      })
    }
    const p1 = await (await get('/records', frank.cookie)).text()
    expect(ticketHrefs(p1)).toHaveLength(50)
    expect(p1).toContain('href="/records?page=2"')
    const p2 = await (await get('/records?page=2', frank.cookie)).text()
    expect(ticketHrefs(p2)).toHaveLength(1)
    expect(p2).toContain('‹ 前の 50 件')
  })
})

describe('GET /records/:id', () => {
  it('本人の記録 → 200。題名・StatusChip・作品リンク・SpoilerCard、ネタバレ本文は含めない', async () => {
    const res = await get(`/records/${ids.cleared}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('閲覧テストの謎')
    // 結果の行: 大きい印と、一覧と同じ displayOn の日付（蛍光ペン）。作成直後でなければハンコは無い
    expect(h).toContain('<span class="chip lg st-cleared">クリア</span>')
    expect(h).toContain('<span class="res-date hl">2026.10.01</span>')
    expect(h).not.toContain('stamp')
    expect(h).toContain(`href="/works/${ids.work}"`)
    expect(h).toContain('周遊 · 閲覧テスト団 · 大阪府')
    expect(h).toContain(`href="/records/${ids.cleared}/spoiler"`)
    expect(h).toContain('（メモ 1 · 写真 0）')
    expect(h).not.toContain(SPOILER)
    // 参加・メモ・ジャンル
    expect(h).toContain('<dt>終了日</dt><dd>2026-10-01</dd>')
    expect(h).toContain('<dt>人数</dt><dd>3 人</dd>')
    expect(h).toContain('<dt>評価</dt><dd>5/5</dd>')
    expect(h).toContain('公演 · 閲覧会場')
    expect(h).toContain('楽しかった')
    expect(h).toContain('<b>4/5</b>')
    expect(h).toContain('<b>1時間30分</b>')
    // ジャンルは sort_order 順（ひらめき → 論理）
    expect(h).toMatch(/<span class="gtag">ひらめき<\/span><span class="gtag">論理<\/span>/)
    expect(h).toContain('進行ログはまだありません。')
    expect(h).toContain('写真は P9 で追加できます。')
    // 左の一覧で選ばれている
    expect(h).toContain(`<a class="ticket sel" href="/records/${ids.cleared}">`)
  })

  it('?saved=1 で「保存しました」', async () => {
    const h = await (await get(`/records/${ids.purchased}?saved=1`)).text()
    expect(h).toContain(
      '<p class="note" role="status"><span class="hl draw saved">保存しました</span></p>',
    )
  })

  it('ログイン中の /records/* は Cache-Control: private, no-store', async () => {
    for (const p of ['/records', `/records/${ids.cleared}`, '/records/new', '/records/nope']) {
      expect((await get(p)).headers.get('cache-control')).toBe('private, no-store')
    }
  })

  it('?created=1 で保存の案内', async () => {
    const h = await (await get(`/records/${ids.purchased}?created=1`)).text()
    expect(h).toContain('<span class="hl draw">保存しました。日付・同行者・評価も足せます</span>')
    expect(h).toContain('<span class="chip lg st-purchased stamp">買った</span>')
    expect(h).toContain('<b>–/5</b>')
  })

  it('bob の cookie で alice の記録 → 404（Layout）', async () => {
    const res = await get(`/records/${ids.cleared}`, bob.cookie)
    expect(res.status).toBe(404)
    const h = await res.text()
    expect(h).toContain('<html lang="ja">')
    expect(h).toContain('見つかりませんでした。')
    expect(h).not.toContain(ids.cleared)
    expect(h).not.toContain('楽しかった')
    expect(h).not.toContain(SPOILER)
  })

  it('無い id → 404', async () => {
    expect((await get('/records/nope')).status).toBe(404)
  })
})

describe('GET /records/:id/spoiler', () => {
  const path = () => `/records/${ids.cleared}/spoiler`

  it('X-Requested-With: fetch → 断片に本文、3 ヘッダ', async () => {
    const res = await get(path(), alice.cookie, { 'X-Requested-With': 'fetch' })
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).not.toContain('<html')
    expect(h).toContain(SPOILER)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('vary')).toContain('X-Requested-With')
  })

  it('ヘッダ無し → Layout の全体ページ', async () => {
    const res = await get(path())
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('<html lang="ja">')
    expect(h).toContain(`<a class="back" href="/records/${ids.cleared}"`)
    expect(h).toContain('閲覧テストの謎 のネタバレ')
    expect(h).toContain(SPOILER)
    expect(res.headers.get('cache-control')).toBe('no-store, private')
  })

  it('ネタバレメモが無ければ「ありません」', async () => {
    const h = await (
      await get(`/records/${ids.purchased}/spoiler`, alice.cookie, { 'X-Requested-With': 'fetch' })
    ).text()
    expect(h).toContain('ネタバレメモはありません。')
  })

  it('bob → 404、本文を含まない', async () => {
    const res = await get(path(), bob.cookie, { 'X-Requested-With': 'fetch' })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(SPOILER)
  })

  it('存在しない id → 404', async () => {
    const res = await get('/records/nope/spoiler', alice.cookie, { 'X-Requested-With': 'fetch' })
    expect(res.status).toBe(404)
  })

  it('未ログイン → 302 /login', async () => {
    const res = await get(path(), null)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })
})

describe('GET /works/:id', () => {
  it('ログイン中: 記録するリンクと「あなたの記録」、Cache-Control: private, no-store', async () => {
    const res = await get(`/works/${ids.work}`)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const h = await res.text()
    expect(h).toContain(`href="/records/new?work=${ids.work}"`)
    expect(h).toContain('<h2>あなたの記録</h2>')
    expect(h).toContain(`href="/records/${ids.cleared}"`)
    expect(h).not.toContain(ids.bobAttempt)
  })

  it('記録が無ければ「あなたの記録」を出さない', async () => {
    const h = await (await get(`/works/${ids.work}`, carol.cookie)).text()
    expect(h).not.toContain('<h2>あなたの記録</h2>')
  })

  it('未ログイン: ボタンは /login へ、「あなたの記録」無し、Cache-Control は付けない', async () => {
    const res = await get(`/works/${ids.work}`, null)
    expect(res.headers.get('cache-control')).toBeNull()
    const h = await res.text()
    expect(h).toContain('<a class="btn" href="/login">記録する</a>')
    expect(h).toContain('<a class="btn" href="/login">マイリストに追加</a>')
    expect(h).not.toContain('/records/new?work=')
    expect(h).not.toContain('<h2>あなたの記録</h2>')
  })
})

describe('一覧の並び（display_on が無い記録は created_at の JST の日付）', () => {
  it('UTC では前日・JST では同じ日の記録は、同じ日の中で created_at の新しい順', async () => {
    const dave = await loginAs(env, { subject: 'records-view-dave' })
    const dated = await insertAttempt(env, {
      userId: dave.userId,
      workId: ids.work,
      status: 'cleared',
      finishedOn: '2026-03-02',
    })
    const undated = await insertAttempt(env, {
      userId: dave.userId,
      workId: ids.work2,
      status: 'purchased',
    })
    // JST 2026-03-02 01:00（UTC では 03-01）。dated より新しい
    await env.DB.prepare('UPDATE attempt SET created_at = ? WHERE id = ?')
      .bind('2026-03-01T16:00:00.000Z', undated)
      .run()
    await env.DB.prepare('UPDATE attempt SET created_at = ? WHERE id = ?')
      .bind('2026-03-01T10:00:00.000Z', dated)
      .run()
    const { items } = await scopedTo(db, dave.userId).own().listAttempts({ tab: 'all', page: 1 })
    expect(items.map((a) => a.id)).toEqual([undated, dated])
  })
})
