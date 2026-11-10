import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OwnAttemptRow } from '../src/db/scoped'
import app from '../src/index'
import { byDifficulty, byGenre, computeStats, monthly, summarize } from '../src/lib/stats'
import { isoToJstDate, todayJst } from '../src/lib/time'
import { StatsPage } from '../src/ui/stats'
import { loginAs } from './helpers/auth'
import { insertWork } from './helpers/master'
import { insertAttempt, insertGenre, insertWish } from './helpers/records'

// 純関数用の行。指定しない列は NULL / 既定値
let seq = 0
const row = (p: Partial<OwnAttemptRow> & Pick<OwnAttemptRow, 'status'>): OwnAttemptRow => {
  seq++
  const id = p.id ?? `a${seq}`
  return {
    id,
    workId: p.workId ?? `w${seq}`,
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
    work: { id: p.workId ?? `w${seq}`, title: 't', kind: null, org: null },
    run: null,
    ...p,
  }
}

// cleared 3 / failed 1 / dropped 1 / purchased 1 / in_progress 1
const basic = () => [
  row({ status: 'cleared', difficulty: 3 }),
  row({ status: 'cleared', difficulty: 3 }),
  row({ status: 'cleared', difficulty: 5 }),
  row({ status: 'failed', difficulty: 5 }),
  row({ status: 'dropped', difficulty: 5 }),
  row({ status: 'purchased' }),
  row({ status: 'in_progress' }),
]

describe('src/lib/stats', () => {
  it('summary: 断念を除くと 75%、失敗に含めると 60%', () => {
    const rows = basic()
    const s = summarize(rows, false)
    expect(s).toMatchObject({ played: 4, cleared: 3, failed: 1, dropped: 1, backlog: 2 })
    expect(s.rate).toBe(0.75)
    expect(summarize(rows, true).rate).toBe(0.6)
  })

  it('記録が無ければ成功率は null', () => {
    expect(summarize([], false)).toMatchObject({ played: 0, rate: null, rateByWork: null })
  })

  it('rateByWork: 同じ作品の failed(1) → cleared(2) は作品ベース 100%、挑戦ベース 50%', () => {
    const rows = [
      row({ status: 'failed', workId: 'w', attemptNo: 1 }),
      row({ status: 'cleared', workId: 'w', attemptNo: 2 }),
    ]
    const s = summarize(rows, false)
    expect(s.rate).toBe(0.5)
    expect(s.rateByWork).toBe(1)
  })

  it('rateByWork: attempt_no が同じなら created_at が新しい方', () => {
    const rows = [
      row({ status: 'cleared', workId: 'w', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ status: 'failed', workId: 'w', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(summarize(rows, false).rateByWork).toBe(1)
  })

  it('rateByWork: 1 回目クリア・2 回目進行中なら、作品ベースはクリアとして数える', () => {
    const rows = [
      row({ status: 'cleared', workId: 'w', attemptNo: 1 }),
      row({ status: 'in_progress', workId: 'w', attemptNo: 2 }),
      row({ status: 'failed', workId: 'v', attemptNo: 1 }),
      // 結果が 1 件も無い作品は分母に入れない
      row({ status: 'purchased', workId: 'u', attemptNo: 1 }),
    ]
    expect(summarize(rows, false).rateByWork).toBe(0.5)
  })

  it('byDifficulty は ★1〜★5 の 5 行固定。difficulty NULL は除く', () => {
    const d = byDifficulty([...basic(), row({ status: 'cleared' })], false)
    expect(d.map((x) => x.label)).toEqual(['★1', '★2', '★3', '★4', '★5'])
    expect(d[2]).toMatchObject({ total: 2, cleared: 2 })
    expect(d[4]).toMatchObject({ total: 2, cleared: 1 })
    expect(byDifficulty(basic(), true)[4]).toMatchObject({ total: 3, cleared: 1 })
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
      false,
    )
    expect(g.map((x) => [x.genreId, x.label, x.cleared, x.total])).toEqual([
      ['two', 'two', 2, 2],
      ['first', 'あ', 1, 1],
      ['one', 'い', 1, 1],
      ['half', 'half', 1, 2],
    ])
  })

  it('monthly: 10 月に 2。finished_on → started_on → created_at（JST）の順に月を取る', () => {
    const m = monthly(
      [
        row({ status: 'cleared', finishedOn: '2026-10-03', startedOn: '2026-09-01' }),
        row({ status: 'dropped', startedOn: '2026-10-20' }),
        // UTC 11/30 16:00 は JST 12/1
        row({ status: 'failed', createdAt: '2026-11-30T16:00:00.000Z' }),
        row({ status: 'cleared', finishedOn: '2025-10-01' }),
        // 結果が付いていない記録は数えない
        row({ status: 'in_progress', startedOn: '2026-10-05' }),
        row({ status: 'purchased', purchasedOn: '2026-10-05' }),
      ],
      2026,
    )
    expect(m).toHaveLength(12)
    expect(m[9]).toBe(2)
    expect(m[10]).toBe(0)
    expect(m[11]).toBe(1)
    expect(m.reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('monthly: 基準日が取れない行（created_at が不正）は数えず、落ちない', () => {
    expect(isoToJstDate('not-a-date')).toBeNull()
    const m = monthly(
      [
        row({ status: 'cleared', createdAt: 'not-a-date' }),
        row({ status: 'cleared', finishedOn: '2026-03-01' }),
      ],
      2026,
    )
    expect(m.reduce((a, b) => a + b, 0)).toBe(1)
    expect(m[2]).toBe(1)
  })

  it('capped なら「直近 5000 件だけを集計しています」を出す', async () => {
    const props = {
      stats: computeStats([], [], new Map(), { dropAsFail: false, year: 2026 }),
      dropAsFail: false,
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
})

let alice = { cookie: '', userId: '' }
let bob = { cookie: '', userId: '' }
const thisYear = Number(todayJst().slice(0, 4))

beforeAll(async () => {
  alice = await loginAs(env, { subject: 'stats-alice' })
  bob = await loginAs(env, { subject: 'stats-bob' })
  const w = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) => insertWork(env, { title: `統計の謎${n}`, kind: 'hall' })),
  )
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
  await insertAttempt(env, {
    userId: alice.userId,
    workId: w[4],
    status: 'dropped',
    finishedOn: on,
  })
  await insertAttempt(env, { userId: alice.userId, workId: w[5], status: 'purchased' })
  await insertWish(env, alice.userId, w[0])
  await insertWish(env, alice.userId, w[5])
  // bob の記録は alice の数字に入らない（w[5] は alice が買っただけ・bob は失敗。alice のマイリストではプレイ済みにしない）
  for (const id of w) {
    await insertAttempt(env, { userId: bob.userId, workId: id, status: 'failed', finishedOn: on })
  }
  await insertWish(env, bob.userId, w[1])
})

// Bars の 1 行（ラベルと右端の値）
const barOf = (label: string, value: string) =>
  new RegExp(
    `<div class="bar"><span>${label}</span><div class="tr"><div class="fl" style="[^"]*"></div></div><span class="v">${value}</span></div>`,
  )

const get = (path: string, cookie = alice.cookie) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

describe('GET /stats', () => {
  it('未ログインは 302 /login', async () => {
    const res = await app.request('/stats', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('本人の数字だけを出す。Cache-Control は private, no-store', async () => {
    const res = await get('/stats')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const html = await res.text()
    expect(html.match(/class="kpi"/g)).toHaveLength(3)
    expect(html).toContain('<b>4</b><span>クリア 3 / 失敗 1 / 断念 1</span>')
    expect(html).toContain('<b>75%</b><span>作品ベース 75%</span>')
    expect(html).toContain('<b>1</b><span>買った・進行中</span>')
    expect(html).toContain('<a class="fchip on" href="/stats" aria-current="page">断念を除く</a>')
    expect(html).toMatch(barOf('論理', '100% · 1/1'))
    expect(html).toMatch(barOf('公演', '75% · 3/4'))
    expect(html).toMatch(barOf('★3', '100% · 1/1'))
    expect(html).toContain(`月別の参加数 ${thisYear} 年`)
    // 10 月に 5（クリア 3・失敗 1・断念 1）
    expect(html).toContain('<div class="col"><span>5</span>')
    expect(html).toContain('2 件 · うちプレイ済み 1 件')
    expect(html).not.toContain('翌年 ›')
  })

  it('?drop=fail は 60%、chip が「断念を失敗に含める」', async () => {
    const html = await (await get('/stats?drop=fail')).text()
    expect(html).toContain('<b>60%</b>')
    expect(html).toContain(
      '<a class="fchip on" href="/stats?drop=fail" aria-current="page">断念を失敗に含める</a>',
    )
  })

  it('年の切り替え。前年では 0 件、翌年リンクは drop を引き継ぐ', async () => {
    const html = await (await get(`/stats?drop=fail&year=${thisYear - 1}`)).text()
    expect(html).toContain(`月別の参加数 ${thisYear - 1} 年`)
    expect(html).not.toContain('<div class="col"><span>5</span>')
    expect(html).toContain('<a class="btn ghost" href="/stats?drop=fail">翌年 ›</a>')
    expect(html).toContain(`href="/stats?drop=fail&amp;year=${thisYear - 2}">‹ 前年`)
  })

  it.each(['1999', String(thisYear + 1), 'abcd', '20260'])('?year=%s は今年扱い', async (y) => {
    const html = await (await get(`/stats?year=${y}`)).text()
    expect(html).toContain(`月別の参加数 ${thisYear} 年`)
  })

  it('bob は bob の数字（alice の記録が混ざらない）', async () => {
    const html = await (await get('/stats', bob.cookie)).text()
    expect(html).toContain('<b>6</b><span>クリア 0 / 失敗 6 / 断念 0</span>')
    expect(html).toContain('<b>0%</b>')
    expect(html).toContain('1 件 · うちプレイ済み 1 件')
    // alice の難易度・ジャンル・形式が混ざらない
    expect(html).toMatch(barOf('★3', '—'))
    expect(html).not.toContain('論理')
    expect(html).toMatch(barOf('公演', '0% · 0/6'))
  })
})
