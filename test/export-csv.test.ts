import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { EXPORT_WISHLIST_LIMIT } from '../src/db/scoped'
import app from '../src/index'
import { toCsv } from '../src/lib/export'
import { ulid } from '../src/lib/id'
import { todayJst } from '../src/lib/time'
import { loginAs } from './helpers/auth'
import { insertOrg, insertRun, insertVenue, insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertSession, insertWish } from './helpers/records'

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env)

// RFC 4180 の最小パーサ（BOM を外し、CRLF 区切り。最終行の CRLF の後は空）
const parseCsv = (text: string): string[][] => {
  const src = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' && src[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) throw new Error('最終行が CRLF で終わっていない')
  return rows
}

// 見出し行をキーにした行の配列
const csvOf = async (path: string, cookie: string) => {
  const res = await get(path, { Cookie: cookie })
  expect(res.status, path).toBe(200)
  const text = await res.text()
  const [header = [], ...rows] = parseCsv(text)
  return {
    text,
    header,
    rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
  }
}

const ATTEMPT_HEADER =
  'id,work_id,work_title,work_kind,org_name,run_id,venue_name,venue_prefecture,status,attempt_no,purchased_on,started_on,finished_on,duration_sec,party_size,companions,rating,difficulty,volume,genres,memo,source_ref,created_at,updated_at'
const ATTEMPT_HEADER_SPOILER = ATTEMPT_HEADER.replace(',memo,', ',memo,spoiler_memo,')
const SESSION_HEADER =
  'id,attempt_id,played_on,started_at,ended_at,duration_sec,progress_note,companions,memo,location_text,created_at'
const WISH_HEADER = 'work_id,work_title,work_kind,org_name,memo,created_at'

const insertManyAttempts = async (userId: string, workId: string, n: number) => {
  const now = '2026-02-01T00:00:00.000Z'
  const stmt = env.DB.prepare(
    "INSERT INTO attempt (id, user_id, work_id, status, attempt_no, created_at, updated_at) VALUES (?, ?, ?, 'cleared', ?, ?, ?)",
  )
  await env.DB.batch(
    Array.from({ length: n }, (_, i) => stmt.bind(ulid(), userId, workId, i + 1, now, now)),
  )
}

const paths = [
  '/settings/export/attempts.csv?part=1',
  '/settings/export/sessions.csv?part=1',
  '/settings/export/wishlist.csv',
]

describe('toCsv', () => {
  it('null は空セル、数値・raw 列はそのまま、text 列だけ数式対策、引用は RFC 4180', () => {
    const csv = toCsv(
      [
        { name: 'n', value: (r: { n: number | null; s: string | null }) => r.n },
        { name: 'raw', value: (r) => r.s },
        { name: 's', text: true, value: (r) => r.s },
      ],
      [
        { n: -1, s: '=SUM(A1)' },
        { n: null, s: null },
        { n: 2, s: 'a"b,c\r\nd' },
        { n: 3, s: '\tx' },
      ],
    )
    expect(csv).toBe(
      '﻿n,raw,s\r\n-1,=SUM(A1),\'=SUM(A1)\r\n,,\r\n2,"a""b,c\r\nd","a""b,c\r\nd"\r\n3,\tx,\'\tx\r\n',
    )
  })

  it.each([
    ['LF', '\nx', '"\'\nx"'],
    ["CR（' を足したうえで引用）", '\rx', '"\'\rx"'],
    ['全角 ＝', '＝1+1', "'＝1+1"],
    ['全角 ＋', '＋x', "'＋x"],
    ['全角 －', '－x', "'－x"],
    ['全角 ＠', '＠x', "'＠x"],
  ])("%s で始まる text セルに ' が付く", (_, value, cell) => {
    const csv = toCsv([{ name: 's', text: true, value: (r: { s: string }) => r.s }], [{ s: value }])
    expect(csv).toBe(`﻿s\r\n${cell}\r\n`)
  })
})

describe('/settings/export/*.csv', () => {
  it('未ログインは 302 /login、Authorization 付きは 403', async () => {
    const { cookie } = await loginAs(env, { subject: 'csv-auth' })
    for (const path of paths) {
      const res = await get(path)
      expect(res.status, path).toBe(302)
      expect(res.headers.get('location')).toBe('/login')
      const bearer = await get(path, { Cookie: cookie, Authorization: 'Bearer x' })
      expect(bearer.status, path).toBe(403)
    }
  })

  it('ヘッダ（no-store・noindex・attachment・ファイル名）、先頭 3 バイトが BOM、列順が固定', async () => {
    const { cookie } = await loginAs(env, { subject: 'csv-headers' })
    const ymd = todayJst().replaceAll('-', '')
    const expected: [string, string, string][] = [
      [paths[0] ?? '', `nazo-attempts-${ymd}-p1.csv`, ATTEMPT_HEADER],
      [paths[1] ?? '', `nazo-sessions-${ymd}-p1.csv`, SESSION_HEADER],
      [paths[2] ?? '', `nazo-wishlist-${ymd}-p1.csv`, WISH_HEADER],
      [`${paths[0]}&spoiler=1`, `nazo-attempts-${ymd}-p1.csv`, ATTEMPT_HEADER_SPOILER],
    ]
    for (const [path, filename, header] of expected) {
      const res = await get(path, { Cookie: cookie })
      expect(res.status, path).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${filename}"`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      // 0 件でも見出し行だけは出る
      expect(new TextDecoder().decode(bytes)).toBe(`${header}\r\n`)
    }
  })

  it('改行・"・, を含むメモが 1 セル、= + - @ で始まる文字列セルに \' が付き数値・日付には付かない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-cells' })
    const w = await insertWork(env, { title: '=1+1', kind: 'hall' })
    const a = await insertAttempt(env, {
      userId,
      workId: w,
      status: 'cleared',
      finishedOn: '2026-03-01',
      durationSec: 3600,
      rating: 4,
      companions: '-x',
      memo: '1 行目\n"引用", カンマ\r\n3 行目',
      spoilerMemo: '@答え',
    })
    await insertGenre(env, a, userId, 'g_logic')
    await insertGenre(env, a, userId, 'g_coop')
    await insertSession(env, {
      attemptId: a,
      userId,
      playedOn: '2026-03-01',
      progressNote: '+x',
      memo: '=HYPERLINK("http://example.com")',
    })
    await insertWish(env, userId, w)

    const attempts = await csvOf('/settings/export/attempts.csv?part=1&spoiler=1', cookie)
    expect(attempts.rows).toHaveLength(1)
    expect(attempts.rows[0]).toMatchObject({
      id: a,
      work_title: "'=1+1",
      work_kind: 'hall',
      companions: "'-x",
      memo: '1 行目\n"引用", カンマ\r\n3 行目',
      spoiler_memo: "'@答え",
      genres: '論理 | 協力',
      finished_on: '2026-03-01',
      duration_sec: '3600',
      rating: '4',
      org_name: '',
    })

    const sessions = await csvOf('/settings/export/sessions.csv?part=1', cookie)
    expect(sessions.rows).toHaveLength(1)
    expect(sessions.rows[0]).toMatchObject({
      attempt_id: a,
      played_on: '2026-03-01',
      progress_note: "'+x",
      memo: '\'=HYPERLINK("http://example.com")',
    })

    const wishes = await csvOf('/settings/export/wishlist.csv', cookie)
    expect(wishes.rows).toEqual([
      {
        work_id: w,
        work_title: "'=1+1",
        work_kind: 'hall',
        org_name: '',
        memo: '',
        created_at: expect.any(String),
      },
    ])
  })

  it('spoiler=1 のときだけ spoiler_memo 列。無しでは本文も出ない', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-spoiler' })
    const w = await insertWork(env, { title: 'CSV ネタバレ' })
    await insertAttempt(env, { userId, workId: w, status: 'cleared', spoilerMemo: '答えは鏡' })

    const plain = await csvOf('/settings/export/attempts.csv?part=1', cookie)
    expect(plain.header).not.toContain('spoiler_memo')
    expect(plain.text).not.toContain('答えは鏡')
    const sp = await csvOf('/settings/export/attempts.csv?part=1&spoiler=1', cookie)
    expect(sp.rows[0]?.spoiler_memo).toBe('答えは鏡')
    // sessions.csv は spoiler を見ない
    const s = await csvOf('/settings/export/sessions.csv?part=1&spoiler=1', cookie)
    // res.text() は BOM を外す
    expect(s.text).toBe(`${SESSION_HEADER}\r\n`)
  })

  it('他人の記録・進行ログ・マイリストが出ない', async () => {
    const me = await loginAs(env, { subject: 'csv-me' })
    const other = await loginAs(env, { subject: 'csv-other' })
    const w = await insertWork(env, { title: 'CSV 他人' })
    const mine = await insertAttempt(env, { userId: me.userId, workId: w, status: 'cleared' })
    const theirs = await insertAttempt(env, {
      userId: other.userId,
      workId: w,
      status: 'failed',
      memo: '他人のメモ',
      spoilerMemo: '他人のネタバレ',
    })
    await insertSession(env, { attemptId: theirs, userId: other.userId, playedOn: '2026-03-02' })
    await insertWish(env, other.userId, w)

    const attempts = await csvOf('/settings/export/attempts.csv?part=1&spoiler=1', me.cookie)
    expect(attempts.rows.map((r) => r.id)).toEqual([mine])
    expect(attempts.text).not.toContain('他人の')
    const sessions = await csvOf('/settings/export/sessions.csv?part=1', me.cookie)
    expect(sessions.rows).toEqual([])
    const wishes = await csvOf('/settings/export/wishlist.csv', me.cookie)
    expect(wishes.rows).toEqual([])
  })

  it('501 件: sessions.csv の part は attempts.csv と同じ区切り。part=3・0・abc は 404', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-parts' })
    const w = await insertWork(env, { title: 'CSV 501' })
    await insertManyAttempts(userId, w, 501)
    const sorted = await env.DB.prepare('SELECT id FROM attempt WHERE user_id = ? ORDER BY id')
      .bind(userId)
      .all<{ id: string }>()
    const [a500, a501] = [sorted.results[499]?.id ?? '', sorted.results[500]?.id ?? '']
    const s500 = await insertSession(env, { attemptId: a500, userId, playedOn: '2026-04-01' })
    const s501 = await insertSession(env, { attemptId: a501, userId, playedOn: '2026-04-02' })

    const p1 = await csvOf('/settings/export/attempts.csv?part=1', cookie)
    expect(p1.rows).toHaveLength(500)
    expect(p1.rows.at(-1)?.id).toBe(a500)
    const p2 = await csvOf('/settings/export/attempts.csv?part=2', cookie)
    expect(p2.rows.map((r) => r.id)).toEqual([a501])

    const sp1 = await csvOf('/settings/export/sessions.csv?part=1', cookie)
    expect(sp1.rows.map((r) => [r.id, r.attempt_id])).toEqual([[s500, a500]])
    const sp2 = await csvOf('/settings/export/sessions.csv?part=2', cookie)
    expect(sp2.rows.map((r) => [r.id, r.attempt_id])).toEqual([[s501, a501]])

    for (const base of ['attempts', 'sessions']) {
      for (const q of ['?part=3', '?part=0', '?part=abc', '']) {
        const r = await get(`/settings/export/${base}.csv${q}`, { Cookie: cookie })
        expect(r.status, `${base}${q}`).toBe(404)
      }
    }
  })

  it("マスタ由来の org_name・venue_name も = 始まりなら ' が付く", async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-master' })
    const org = await insertOrg(env, { name: '=団体' })
    const w = await insertWork(env, { title: 'CSV マスタ', kind: 'hall', orgId: org })
    const venue = await insertVenue(env, { name: '=会場', prefecture: '東京都' })
    const run = await insertRun(env, { workId: w, channel: 'performance', venueId: venue })
    await insertAttempt(env, { userId, workId: w, runId: run, status: 'cleared' })
    await insertWish(env, userId, w)

    const attempts = await csvOf('/settings/export/attempts.csv?part=1', cookie)
    expect(attempts.rows[0]).toMatchObject({ org_name: "'=団体", venue_name: "'=会場" })
    const wishes = await csvOf('/settings/export/wishlist.csv', cookie)
    expect(wishes.rows[0]).toMatchObject({ org_name: "'=団体" })
  })

  it('マイリストが上限を超えたら画面の件数に「先頭 5000 件まで」', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-wish-cap' })
    const now = '2026-02-01T00:00:00.000Z'
    const addWishes = async (n: number) => {
      const ids = Array.from({ length: n }, () => ulid())
      const work = env.DB.prepare(
        'INSERT INTO work (id, title, title_norm, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      const wish = env.DB.prepare(
        'INSERT INTO wishlist (user_id, work_id, created_at) VALUES (?, ?, ?)',
      )
      await env.DB.batch(ids.map((id) => work.bind(id, `上限 ${id}`, `上限 ${id}`, now, now)))
      await env.DB.batch(ids.map((id) => wish.bind(userId, id, now)))
    }
    const wishNote = async () => {
      const html = await (await get('/settings/export', { Cookie: cookie })).text()
      return html.match(/<span>マイリスト<\/span><span class="note">([^<]*)<\/span>/)?.[1]
    }
    await addWishes(EXPORT_WISHLIST_LIMIT)
    expect(await wishNote()).toBe(`${EXPORT_WISHLIST_LIMIT} 件`)
    await addWishes(1)
    expect(await wishNote()).toBe(
      `${EXPORT_WISHLIST_LIMIT + 1} 件（先頭 ${EXPORT_WISHLIST_LIMIT} 件まで）`,
    )
  })

  it('画面に CSV のリンク。spoiler=1 は記録のリンクにだけ引き継ぐ', async () => {
    const { cookie, userId } = await loginAs(env, { subject: 'csv-page' })
    const w = await insertWork(env, { title: 'CSV 画面' })
    await insertManyAttempts(userId, w, 501)

    const html = await (await get('/settings/export?spoiler=1', { Cookie: cookie })).text()
    expect(html).toContain('href="/settings/export/attempts.csv?part=1&amp;spoiler=1"')
    expect(html).toContain('href="/settings/export/attempts.csv?part=2&amp;spoiler=1"')
    expect(html).toContain('href="/settings/export/sessions.csv?part=1"')
    expect(html).toContain('href="/settings/export/sessions.csv?part=2"')
    expect(html).toContain('href="/settings/export/wishlist.csv"')
    expect(html).not.toContain('sessions.csv?part=1&amp;spoiler=1')
    expect(html).toContain(
      '= + - @ で始まるセルは、表計算ソフトで数式として動かないよう先頭に &#39; を付けています。元のままの値が要るときは JSON を使ってください。',
    )
    expect(html).not.toContain('part=3')
  })
})
