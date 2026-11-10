import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OwnAttemptRow } from '../src/db/scoped'
import app from '../src/index'
import {
  byDifficulty,
  byGenre,
  computeStats,
  defaultView,
  doneByKind,
  doneMonthly,
  splitByVisit,
  summarizeDone,
  summarizeVisit,
  visitByKind,
  visitMonthly,
} from '../src/lib/stats'
import { isoToJstDate, todayJst } from '../src/lib/time'
import { MonthStack, RateBars } from '../src/ui/components'
import { StatsPage } from '../src/ui/stats'
import { loginAs } from './helpers/auth'
import { insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertWish } from './helpers/records'

type Kind = OwnAttemptRow['work']['kind']

// 純関数用の行。指定しない列は NULL / 既定値。kind の既定は room（来場型）
let seq = 0
const row = (
  p: Partial<OwnAttemptRow> & Pick<OwnAttemptRow, 'status'> & { kind?: Kind },
): OwnAttemptRow => {
  seq++
  const { kind = 'room', ...rest } = p
  const id = rest.id ?? `a${seq}`
  return {
    id,
    workId: rest.workId ?? `w${seq}`,
    runId: null,
    purchasedOn: null,
    attemptNo: 1,
    startedOn: null,
    finishedOn: null,
    durationSec: null,
    partySize: null,
    companions: null,
    rating: null,
    difficulty: null,
    volume: null,
    memo: null,
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    displayOn: null,
    lastPlayedOn: null,
    sessionCount: 0,
    sessionDurationSec: null,
    work: { id: rest.workId ?? `w${seq}`, title: 't', kind, org: null },
    run: null,
    ...rest,
  }
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)

describe('src/lib/stats', () => {
  it('splitByVisit: hall / room は visit、それ以外と NULL は done', () => {
    const kinds: Kind[] = ['hall', 'room', 'stroll', 'line', 'web', 'takeaway', 'other', null]
    const { visit, done } = splitByVisit(kinds.map((kind) => row({ status: 'cleared', kind })))
    expect(visit.map((r) => r.work.kind)).toEqual(['hall', 'room'])
    expect(done.map((r) => r.work.kind)).toEqual([
      'stroll',
      'line',
      'web',
      'takeaway',
      'other',
      null,
    ])
  })

  it('summarizeVisit: 旧ステータス（進行中・断念）は excluded に数え、成功率に入れない', () => {
    const s = summarizeVisit([
      row({ status: 'cleared' }),
      row({ status: 'cleared' }),
      row({ status: 'cleared' }),
      row({ status: 'failed' }),
      row({ status: 'purchased' }),
      row({ status: 'in_progress' }),
      row({ status: 'dropped' }),
    ])
    expect(s).toMatchObject({
      records: 7,
      played: 4,
      cleared: 3,
      failed: 1,
      reserved: 1,
      excluded: 2,
      rate: 0.75,
    })
  })

  it('summarizeVisit([]) は成功率 null、played 0', () => {
    expect(summarizeVisit([])).toMatchObject({ played: 0, rate: null, rateByWork: null })
  })

  it('rateByWork: 同じ作品の failed(1) → cleared(2) は作品ベース 100%、挑戦ベース 50%', () => {
    const s = summarizeVisit([
      row({ status: 'failed', workId: 'w', attemptNo: 1 }),
      row({ status: 'cleared', workId: 'w', attemptNo: 2 }),
    ])
    expect(s.rate).toBe(0.5)
    expect(s.rateByWork).toBe(1)
  })

  it('rateByWork: attempt_no が同じなら created_at が新しい方', () => {
    const s = summarizeVisit([
      row({ status: 'cleared', workId: 'w', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ status: 'failed', workId: 'w', createdAt: '2026-01-01T00:00:00.000Z' }),
    ])
    expect(s.rateByWork).toBe(1)
  })

  it('rateByWork: 代表に断念・進行中・予約済みは選ばない', () => {
    const s = summarizeVisit([
      row({ status: 'cleared', workId: 'w', attemptNo: 1 }),
      row({ status: 'dropped', workId: 'w', attemptNo: 2 }),
      row({ status: 'cleared', workId: 'v', attemptNo: 1 }),
      row({ status: 'in_progress', workId: 'v', attemptNo: 2 }),
      // 結果が 1 件も無い作品は分母に入れない
      row({ status: 'purchased', workId: 'u', attemptNo: 1 }),
      row({ status: 'dropped', workId: 't', attemptNo: 1 }),
    ])
    expect(s.rateByWork).toBe(1)
  })

  it('summarizeDone: 積み謎は purchased だけ（進行中は入らない）', () => {
    const s = summarizeDone([
      row({ status: 'cleared', kind: 'takeaway' }),
      row({ status: 'cleared', kind: 'stroll' }),
      row({ status: 'failed', kind: 'web' }),
      row({ status: 'dropped', kind: 'line' }),
      row({ status: 'in_progress', kind: 'stroll' }),
      row({ status: 'in_progress', kind: null }),
      row({ status: 'purchased', kind: 'takeaway' }),
    ])
    expect(s).toEqual({
      records: 7,
      cleared: 2,
      failed: 1,
      dropped: 1,
      inProgress: 2,
      backlog: 1,
    })
  })

  it('byDifficulty は ★1〜★5 の 5 行固定。difficulty NULL と断念は分母に入れない', () => {
    const d = byDifficulty([
      row({ status: 'cleared', difficulty: 3 }),
      row({ status: 'cleared', difficulty: 3 }),
      row({ status: 'cleared', difficulty: 5 }),
      row({ status: 'failed', difficulty: 5 }),
      row({ status: 'dropped', difficulty: 5 }),
      row({ status: 'cleared' }),
    ])
    expect(d.map((x) => x.label)).toEqual(['★1', '★2', '★3', '★4', '★5'])
    expect(d[2]).toMatchObject({ total: 2, cleared: 2 })
    expect(d[4]).toMatchObject({ total: 2, cleared: 1 })
    expect(d[0]).toMatchObject({ total: 0, cleared: 0 })
  })

  it('byGenre は成功率 DESC, 件数 DESC, ラベル ASC。分母 0 と rows に無い記録は除く', () => {
    const rows = [
      row({ id: 'x1', status: 'cleared' }),
      row({ id: 'x2', status: 'failed' }),
      row({ id: 'x3', status: 'cleared' }),
      row({ id: 'x4', status: 'purchased' }),
      row({ id: 'x5', status: 'cleared' }),
    ]
    const g = byGenre(
      rows,
      [
        { attemptId: 'x1', genreId: 'half' },
        { attemptId: 'x2', genreId: 'half' },
        { attemptId: 'x1', genreId: 'one' },
        { attemptId: 'x1', genreId: 'two' },
        { attemptId: 'x3', genreId: 'two' },
        { attemptId: 'x4', genreId: 'none' },
        { attemptId: 'gone', genreId: 'gone' },
        // one と同率・同数。ラベル順で one（い）より前
        { attemptId: 'x5', genreId: 'first' },
      ],
      new Map([
        ['one', 'い'],
        ['first', 'あ'],
      ]),
    )
    expect(g.map((x) => [x.genreId, x.label, x.cleared, x.total])).toEqual([
      ['two', 'two', 2, 2],
      ['first', 'あ', 1, 1],
      ['one', 'い', 1, 1],
      ['half', 'half', 1, 2],
    ])
  })

  it('visitByKind: room だけでも hall（total 0）の行が出る。順は hall, room', () => {
    const k = visitByKind([row({ status: 'cleared', kind: 'room' }), row({ status: 'failed' })])
    expect(k).toEqual([
      { kind: 'hall', total: 0, cleared: 0 },
      { kind: 'room', total: 2, cleared: 1 },
    ])
  })

  it('doneByKind: cleared 0 の形式は出さない。順は workKinds、NULL が最後', () => {
    const k = doneByKind([
      row({ status: 'cleared', kind: null }),
      row({ status: 'cleared', kind: 'takeaway' }),
      row({ status: 'cleared', kind: 'takeaway' }),
      row({ status: 'cleared', kind: 'stroll' }),
      row({ status: 'dropped', kind: 'web' }),
      row({ status: 'in_progress', kind: 'line' }),
    ])
    expect(k).toEqual([
      { kind: 'stroll', cleared: 1 },
      { kind: 'takeaway', cleared: 2 },
      { kind: null, cleared: 1 },
    ])
  })

  it('visitMonthly: 成功・失敗の 2 系列で各 12 要素。断念・予約済み・年外は数えない', () => {
    const m = visitMonthly(
      [
        row({ status: 'cleared', finishedOn: '2026-10-03', startedOn: '2026-09-01' }),
        row({ status: 'failed', finishedOn: '2026-10-04' }),
        // UTC 11/30 16:00 は JST 12/1
        row({ status: 'failed', createdAt: '2026-11-30T16:00:00.000Z' }),
        row({ status: 'dropped', startedOn: '2026-10-20' }),
        row({ status: 'purchased', purchasedOn: '2026-10-05' }),
        row({ status: 'cleared', finishedOn: '2025-10-01' }),
      ],
      2026,
    )
    expect(m.map((s) => s.key)).toEqual(['cleared', 'failed'])
    expect(m.every((s) => s.counts.length === 12)).toBe(true)
    expect(m[0]?.counts[9]).toBe(1)
    expect(m[1]?.counts[9]).toBe(1)
    expect(m[1]?.counts[11]).toBe(1)
    expect(sum(m[0]?.counts ?? [])).toBe(1)
    expect(sum(m[1]?.counts ?? [])).toBe(2)
  })

  it('doneMonthly: その年に 0 件の形式は系列に出ない。cleared 以外は数えない', () => {
    const m = doneMonthly(
      [
        row({ status: 'cleared', kind: 'web', finishedOn: '2026-03-01' }),
        row({ status: 'cleared', kind: 'stroll', startedOn: '2026-10-20' }),
        row({ status: 'cleared', kind: 'line', finishedOn: '2025-03-01' }),
        row({ status: 'dropped', kind: 'other', finishedOn: '2026-03-01' }),
        row({ status: 'in_progress', kind: 'takeaway', startedOn: '2026-03-01' }),
      ],
      2026,
    )
    expect(m.map((s) => s.key)).toEqual(['stroll', 'web'])
    expect(m[0]?.counts[9]).toBe(1)
    expect(m[1]?.counts[2]).toBe(1)
  })

  it('doneMonthly: created_at は JST で月を取り、基準日が取れない行（created_at が不正）は数えず、落ちない', () => {
    expect(isoToJstDate('not-a-date')).toBeNull()
    const m = doneMonthly(
      [
        row({ status: 'cleared', kind: 'takeaway', createdAt: 'not-a-date' }),
        // UTC 11/30 16:00 は JST 12/1
        row({ status: 'cleared', kind: 'takeaway', createdAt: '2026-11-30T16:00:00.000Z' }),
      ],
      2026,
    )
    expect(m).toHaveLength(1)
    expect(sum(m[0]?.counts ?? [])).toBe(1)
    expect(m[0]?.counts[11]).toBe(1)
  })

  it('defaultView: 来場型 0 件・完了型ありなら done、それ以外は visit', () => {
    const view = (rows: OwnAttemptRow[]) =>
      defaultView(computeStats(rows, [], new Map(), { year: 2026 }))
    expect(view([row({ status: 'cleared', kind: 'takeaway' })])).toBe('done')
    expect(view([])).toBe('visit')
    expect(view([row({ status: 'purchased', kind: 'hall' })])).toBe('visit')
    expect(
      view([row({ status: 'purchased', kind: 'hall' }), row({ status: 'cleared', kind: 'web' })]),
    ).toBe('visit')
  })

  it('capped なら「直近 5000 件だけを集計しています」を出す', async () => {
    const props = {
      stats: computeStats([], [], new Map(), { year: 2026 }),
      view: 'visit' as const,
      year: 2026,
      thisYear: 2026,
      minYear: 2000,
      wishlist: { total: 0, played: 0 },
    }
    expect(String(await StatsPage({ ...props, capped: true }))).toContain(
      '直近 5000 件だけを集計しています',
    )
    expect(String(await StatsPage({ ...props, capped: false }))).not.toContain('直近 5000 件')
  })

  it('記録 0 件の visit は KPI を — / 0 で出し、グラフは Empty（凡例なし）', async () => {
    const html = String(
      await StatsPage({
        stats: computeStats([], [], new Map(), { year: 2026 }),
        view: 'visit',
        year: 2026,
        thisYear: 2026,
        minYear: 2000,
        capped: false,
        wishlist: { total: 0, played: 0 },
      }),
    )
    expect(html).toContain('<b><span class="hl mk-green">—</span></b>')
    expect(html).toContain('<b>0</b><span>成功 0 / 失敗 0</span>')
    expect(html.match(/ルーム・公演の結果はまだありません。/g)).toHaveLength(2)
    expect(html).toContain('2026 年の記録はありません。')
    expect(html).not.toContain('class="legend"')
    expect(html).not.toContain('以前の記録')
  })

  it('done の hero 注記: 失敗があるときだけ「 · 失敗 n」を足す', async () => {
    const done = async (rows: OwnAttemptRow[]) =>
      String(
        await StatsPage({
          stats: computeStats(rows, [], new Map(), { year: 2026 }),
          view: 'done',
          year: 2026,
          thisYear: 2026,
          minYear: 2000,
          capped: false,
          wishlist: { total: 0, played: 0 },
        }),
      )
    const base = [row({ status: 'cleared', kind: 'web' }), row({ status: 'dropped', kind: 'web' })]
    expect(await done(base)).toContain('<b><span class="hl">1</span></b><span>断念 1</span>')
    expect(
      await done([
        ...base,
        row({ status: 'failed', kind: 'web' }),
        row({ status: 'failed', kind: 'line' }),
      ]),
    ).toContain('<b><span class="hl">1</span></b><span>断念 1 · 失敗 2</span>')
  })
})

describe('グラフの部品', () => {
  it('RateBars: total 0 の行は .tr が空で値 —', async () => {
    const html = String(
      await RateBars({
        items: [
          { label: '★1', total: 0, cleared: 0 },
          { label: '★2', total: 4, cleared: 3 },
        ],
      }),
    )
    expect(html).toContain(
      '<div class="bar"><span>★1</span><div class="tr"></div><span class="v">—</span></div>',
    )
    expect(html).toContain(
      '<div class="tr"><div class="fl r-ok" style="width:75%"></div><div class="fl r-ng" style="width:25%"></div></div><span class="v">75% · 3/4</span>',
    )
  })

  it('MonthStack: 各 .col に role="img" と内訳の aria-label。0 件の系列は描かない', async () => {
    const counts = (m: number, n: number) => Array.from({ length: 12 }, (_, i) => (i === m ? n : 0))
    const html = String(
      await MonthStack({
        series: [
          { key: 'cleared', counts: counts(9, 3) },
          { key: 'failed', counts: [0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0] },
        ],
        cls: (k) => (k === 'cleared' ? 'r-ok' : 'r-ng'),
        label: (k) => (k === 'cleared' ? '成功' : '失敗'),
      }),
    )
    expect(html.match(/<div class="col" role="img"/g)).toHaveLength(12)
    expect(html).toContain('aria-label="10月 成功 3・失敗 1"><span>4</span><div class="stk">')
    // 9 月は失敗だけ（成功の i は出さない）
    expect(html).toContain(
      'aria-label="9月 失敗 2"><span>2</span><div class="stk"><i class="r-ng" style="height:30px"></i></div><span>9</span>',
    )
    expect(html).toContain('aria-label="1月 0 件"><span></span><span>1</span></div>')
  })
})

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
let carol = { cookie: '', userId: '' }
const thisYear = Number(todayJst().slice(0, 4))

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'stats-alice' })
  bob = await loginAs(env, { subject: 'stats-bob' })
  carol = await loginAs(env, { subject: 'stats-carol' })
  const w = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) => insertWork(env, { title: `統計の謎${n}`, kind: 'hall' })),
  )
  const takeaway = await insertWork(env, { title: '統計の持ち帰り', kind: 'takeaway' })
  const stroll = await insertWork(env, { title: '統計の周遊', kind: 'stroll' })
  // 形式未設定（kind NULL）
  const noKind = await insertWork(env, { title: '統計の形式未設定' })
  const on = `${thisYear}-10-01`
  const a1 = await insertAttempt(env, {
    userId: alice.userId,
    workId: w[0],
    status: 'cleared',
    finishedOn: on,
    difficulty: 3,
  })
  await insertGenre(env, a1, alice.userId, 'g_logic')
  await insertAttempt(env, {
    userId: alice.userId,
    workId: w[1],
    status: 'cleared',
    finishedOn: on,
  })
  await insertAttempt(env, {
    userId: alice.userId,
    workId: w[2],
    status: 'cleared',
    finishedOn: on,
  })
  await insertAttempt(env, { userId: alice.userId, workId: w[3], status: 'failed', finishedOn: on })
  // 来場型の旧ステータス（集計に入れず、件数を注記する）
  await insertAttempt(env, {
    userId: alice.userId,
    workId: w[4],
    status: 'dropped',
    finishedOn: on,
  })
  await insertAttempt(env, { userId: alice.userId, workId: w[5], status: 'purchased' })
  // 完了型: 持ち帰り 2（1 回目・2 回目）、周遊 1、周遊の進行中 1
  await insertAttempt(env, {
    userId: alice.userId,
    workId: takeaway,
    status: 'cleared',
    finishedOn: on,
  })
  await insertAttempt(env, {
    userId: alice.userId,
    workId: takeaway,
    status: 'cleared',
    attemptNo: 2,
    finishedOn: on,
  })
  await insertAttempt(env, {
    userId: alice.userId,
    workId: stroll,
    status: 'cleared',
    finishedOn: on,
  })
  await insertAttempt(env, {
    userId: alice.userId,
    workId: stroll,
    status: 'in_progress',
    attemptNo: 2,
    startedOn: on,
  })
  await insertAttempt(env, {
    userId: alice.userId,
    workId: noKind,
    status: 'cleared',
    finishedOn: on,
  })
  await insertWish(env, alice.userId, w[0])
  await insertWish(env, alice.userId, w[5])
  // bob の記録は alice の数字に入らない（w[5] は alice が買っただけ・bob は失敗。alice のマイリストではプレイ済みにしない）
  for (const id of w) {
    await insertAttempt(env, { userId: bob.userId, workId: id, status: 'failed', finishedOn: on })
  }
  await insertWish(env, bob.userId, w[1])
  // carol は来場型 0 件
  await insertAttempt(env, {
    userId: carol.userId,
    workId: takeaway,
    status: 'cleared',
    finishedOn: on,
  })
})

// RateBars の 1 行（ラベルと右端の値）
const barOf = (label: string, value: string) =>
  new RegExp(
    `<div class="bar"><span>${label}</span><div class="tr">(<div class="fl r-ok" style="[^"]*"></div><div class="fl r-ng" style="[^"]*"></div>)?</div><span class="v">${value}</span></div>`,
  )

const get = (path: string, cookie = alice.cookie) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

const chipOn = (href: string, label: string) =>
  `<a class="fchip on" href="${href}" aria-current="page">${label}</a>`

describe('GET /stats', () => {
  it('未ログインは 302 /login', async () => {
    const res = await app.request('/stats', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('?view=visit: 来場型の成功率。旧ステータスは外して件数を注記。Cache-Control は private, no-store', async () => {
    const res = await get('/stats?view=visit')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = await res.text()
    expect(html.match(/class="kpi"/g)).toHaveLength(2)
    expect(html.match(/class="kpi hero"/g)).toHaveLength(1)
    expect(html).toContain('<b><span class="hl mk-green">75%</span></b><span>作品ベース 75%</span>')
    expect(html).toContain('<b>4</b><span>成功 3 / 失敗 1</span>')
    expect(html).toContain('<b>1</b><span>参加予定</span>')
    expect(html).toContain(chipOn('/stats?view=visit', 'ルーム・公演'))
    expect(html).not.toContain('断念を失敗に含める')
    expect(html).toContain(
      '<li><i class="key r-ok"></i>成功</li><li><i class="key r-ng"></i>失敗</li>',
    )
    expect(html).toMatch(barOf('論理', '100% · 1/1'))
    expect(html).toMatch(barOf('公演', '75% · 3/4'))
    expect(html).toMatch(barOf('ルーム', '—'))
    expect(html).toMatch(barOf('★3', '100% · 1/1'))
    expect(html).toContain(`月別の成功・失敗 ${thisYear} 年`)
    // 10 月に 4（成功 3・失敗 1。断念は数えない）
    expect(html).toContain('aria-label="10月 成功 3・失敗 1"><span>4</span>')
    expect(html).toContain(
      'ルーム・公演の「進行中」「断念」（以前の記録）1 件は集計に入れていません。',
    )
    expect(html).toContain('2 件 · うちプレイ済み 1 件')
    expect(html).not.toContain('翌年 ›')
    // 完了型の記録は混ざらない
    expect(html).not.toContain('k-takeaway')
  })

  it('?view=done: 完了数。形式別の棒と、出た形式だけの凡例', async () => {
    const html = await (await get('/stats?view=done')).text()
    expect(html).toContain(chipOn('/stats?view=done', '持ち帰り・周遊など'))
    expect(html).toContain('<b><span class="hl">4</span></b><span>断念 0</span>')
    expect(html).toContain('<b>1</b><span>始めた・続きあり</span>')
    expect(html).toContain('<b>0</b><span>買った・未着手</span>')
    expect(html).toContain(
      '<div class="bar"><span>周遊</span><div class="tr"><div class="fl k-stroll" style="width:50%"></div></div><span class="v">1 件</span></div>',
    )
    expect(html).toContain(
      '<div class="bar"><span>持ち帰り</span><div class="tr"><div class="fl k-takeaway" style="width:100%"></div></div><span class="v">2 件</span></div>',
    )
    expect(html).toContain(
      '<ul class="legend"><li><i class="key k-stroll"></i>周遊</li><li><i class="key k-takeaway"></i>持ち帰り</li><li><i class="key k-none"></i>形式未設定</li></ul>',
    )
    // 形式未設定は最後の行
    expect(html).toContain(
      '<div class="bar"><span>形式未設定</span><div class="tr"><div class="fl k-none" style="width:50%"></div></div><span class="v">1 件</span></div>',
    )
    expect(html).not.toContain('k-line')
    expect(html).toContain(`月別の完了数 ${thisYear} 年`)
    expect(html).toContain('aria-label="10月 周遊 1・持ち帰り 2・形式未設定 1"><span>4</span>')
    // 来場型の数字・旧ステータスの注記は出さない
    expect(html).not.toContain('mk-green')
    expect(html).not.toContain('以前の記録')
  })

  it('view 無し: 来場型ありなら visit、来場型 0 件なら done', async () => {
    const a = await (await get('/stats')).text()
    expect(a).toContain(chipOn('/stats?view=visit', 'ルーム・公演'))
    const c = await (await get('/stats', carol.cookie)).text()
    expect(c).toContain(chipOn('/stats?view=done', '持ち帰り・周遊など'))
    expect(c).toContain('<b><span class="hl">1</span></b>')
  })

  it('?view=bogus は既定と同じ。?drop=fail を付けても同じ HTML', async () => {
    const base = await (await get('/stats')).text()
    expect(await (await get('/stats?view=bogus')).text()).toBe(base)
    expect(await (await get('/stats?drop=fail')).text()).toBe(base)
    expect(await (await get('/stats?view=visit&drop=fail')).text()).toContain(
      '<span class="hl mk-green">75%</span>',
    )
  })

  it('年送りのリンクは view を引き継ぐ。前年は「{year} 年の記録はありません。」', async () => {
    const html = await (await get(`/stats?view=done&year=${thisYear - 1}`)).text()
    expect(html).toContain(`月別の完了数 ${thisYear - 1} 年`)
    expect(html).toContain(`${thisYear - 1} 年の記録はありません。`)
    expect(html).not.toContain('class="legend"')
    expect(html).toContain('<a class="btn ghost" href="/stats?view=done">翌年 ›</a>')
    expect(html).toContain(`href="/stats?view=done&amp;year=${thisYear - 2}">‹ 前年`)
    expect(html).toContain(`href="/stats?view=visit&amp;year=${thisYear - 1}">ルーム・公演`)
  })

  it.each(['1999', String(thisYear + 1), 'abcd', '20260'])('?year=%s は今年扱い', async (y) => {
    const html = await (await get(`/stats?view=visit&year=${y}`)).text()
    expect(html).toContain(`月別の成功・失敗 ${thisYear} 年`)
  })

  it('bob は bob の数字（alice の記録が混ざらない）', async () => {
    const visit = await (await get('/stats?view=visit', bob.cookie)).text()
    expect(visit).toContain('<b>6</b><span>成功 0 / 失敗 6</span>')
    expect(visit).toContain('<b><span class="hl mk-green">0%</span></b>')
    expect(visit).toContain('1 件 · うちプレイ済み 1 件')
    // alice の難易度・ジャンル・形式・旧ステータスが混ざらない
    expect(visit).toMatch(barOf('★3', '—'))
    expect(visit).not.toContain('論理')
    expect(visit).toMatch(barOf('公演', '0% · 0/6'))
    expect(visit).not.toContain('以前の記録')
    const done = await (await get('/stats?view=done', bob.cookie)).text()
    expect(done).toContain('<b><span class="hl">0</span></b><span>断念 0</span>')
    expect(done).toContain('まだ完了した記録がありません。')
  })
})
