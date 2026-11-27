import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { OwnAttemptRow } from '../src/db/scoped'
import app from '../src/index'
import { splitCompanions } from '../src/lib/companions'
import {
  backlogOldest,
  byCompanion,
  byDifficulty,
  byGenre,
  byOrg,
  byVolume,
  computeStats,
  defaultView,
  doneAverages,
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
import { insertOrg, insertWork } from './helpers/master'
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
    const kinds: Kind[] = [
      'hall',
      'room',
      'stroll',
      'line',
      'web',
      'takeaway',
      'cafe',
      'box',
      'other',
      null,
    ]
    const { visit, done } = splitByVisit(kinds.map((kind) => row({ status: 'cleared', kind })))
    expect(visit.map((r) => r.work.kind)).toEqual(['hall', 'room'])
    expect(done.map((r) => r.work.kind)).toEqual([
      'stroll',
      'line',
      'web',
      'takeaway',
      'cafe',
      'box',
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

  it('doneByKind: カフェ・箱は持ち帰りの後、その他の前', () => {
    const k = doneByKind([
      row({ status: 'cleared', kind: 'other' }),
      row({ status: 'cleared', kind: 'box' }),
      row({ status: 'cleared', kind: 'cafe' }),
      row({ status: 'cleared', kind: 'takeaway' }),
      row({ status: 'failed', kind: 'cafe' }),
    ])
    expect(k).toEqual([
      { kind: 'takeaway', cleared: 1 },
      { kind: 'cafe', cleared: 1 },
      { kind: 'box', cleared: 1 },
      { kind: 'other', cleared: 1 },
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
      defaultView(computeStats(rows, [], new Map(), { year: 2026, today: '2026-11-27' }))
    expect(view([row({ status: 'cleared', kind: 'takeaway' })])).toBe('done')
    expect(view([])).toBe('visit')
    expect(view([row({ status: 'purchased', kind: 'hall' })])).toBe('visit')
    expect(
      view([row({ status: 'purchased', kind: 'hall' }), row({ status: 'cleared', kind: 'web' })]),
    ).toBe('visit')
  })

  it('capped なら「直近 5000 件だけを集計しています」を出す', async () => {
    const props = {
      stats: computeStats([], [], new Map(), { year: 2026, today: '2026-11-27' }),
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
        stats: computeStats([], [], new Map(), { year: 2026, today: '2026-11-27' }),
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
    expect(html.match(/ルーム・公演の結果はまだありません。/g)).toHaveLength(3)
    expect(html).toContain('2026 年の記録はありません。')
    expect(html).not.toContain('class="legend"')
    expect(html).not.toContain('以前の記録')
  })

  it('done の hero 注記: 失敗があるときだけ「 · 失敗 n」を足す', async () => {
    const done = async (rows: OwnAttemptRow[]) =>
      String(
        await StatsPage({
          stats: computeStats(rows, [], new Map(), { year: 2026, today: '2026-11-27' }),
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

describe('src/lib/stats（得意傾向）', () => {
  // 同じジャンルの記録を n 件（先頭 cleared 件が成功、残りは失敗）
  const genreRows = (genreId: string, n: number, cleared: number) =>
    Array.from({ length: n }, (_, i) => ({
      row: row({ status: i < cleared ? 'cleared' : 'failed' }),
      genreId,
    }))
  const genreOf = (list: { row: OwnAttemptRow; genreId: string }[]) =>
    byGenre(
      list.map((x) => x.row),
      list.map((x) => ({ attemptId: x.row.id, genreId: x.genreId })),
      new Map(),
    )

  it('byGenre の得意: 4 件 100% には付かず、5 件以上で成功率が最高の 1 行だけに付く', () => {
    const g = genreOf([
      ...genreRows('four', 4, 4),
      ...genreRows('five', 5, 4),
      ...genreRows('six', 6, 3),
    ])
    expect(g.map((x) => [x.genreId, x.best])).toEqual([
      ['four', false],
      ['five', true],
      ['six', false],
    ])
    expect(genreOf(genreRows('four', 4, 4)).some((x) => x.best)).toBe(false)
  })

  it('byGenre の得意: 5 件以上の最高でも成功率 50% 未満なら付けない', () => {
    expect(genreOf(genreRows('five', 5, 0)).map((x) => x.best)).toEqual([false])
    expect(genreOf(genreRows('five', 5, 1)).map((x) => x.best)).toEqual([false])
    expect(genreOf(genreRows('five', 5, 3)).map((x) => x.best)).toEqual([true])
    // A 4/4 は母数不足で対象外、B 3/5 に付く
    expect(
      genreOf([...genreRows('A', 4, 4), ...genreRows('B', 5, 3)]).map((x) => [x.genreId, x.best]),
    ).toEqual([
      ['A', false],
      ['B', true],
    ])
    // 同率は並びの先頭（件数の多い方）だけ
    expect(
      genreOf([...genreRows('x', 5, 4), ...genreRows('y', 10, 8)]).map((x) => [x.genreId, x.best]),
    ).toEqual([
      ['y', true],
      ['x', false],
    ])
  })

  it('byVolume は 量 1〜量 5 の 5 行固定。volume NULL と旧ステータスは分母に入れない', () => {
    const v = byVolume([
      row({ status: 'cleared', volume: 2 }),
      row({ status: 'failed', volume: 2 }),
      row({ status: 'dropped', volume: 2 }),
      row({ status: 'in_progress', volume: 2 }),
      row({ status: 'purchased', volume: 2 }),
      row({ status: 'cleared', volume: 5 }),
      row({ status: 'cleared' }),
    ])
    expect(v).toEqual([
      { label: '量 1', total: 0, cleared: 0 },
      { label: '量 2', total: 2, cleared: 1 },
      { label: '量 3', total: 0, cleared: 0 },
      { label: '量 4', total: 0, cleared: 0 },
      { label: '量 5', total: 1, cleared: 1 },
    ])
  })

  const orgRow = (
    org: { id: string; name: string } | null,
    status: OwnAttemptRow['status'],
    rating: number | null = null,
  ) => {
    const r = row({ status, rating })
    return { ...r, work: { ...r.work, org } }
  }

  it('byOrg: 2 件は出ず 3 件から。旧ステータスは数えない。団体なしは出ない', () => {
    const a = { id: 'oa', name: 'A' }
    const b = { id: 'ob', name: 'B' }
    const rows = [
      orgRow(a, 'cleared'),
      orgRow(a, 'failed'),
      orgRow(a, 'dropped'),
      orgRow(a, 'in_progress'),
      orgRow(a, 'purchased'),
      orgRow(b, 'cleared'),
      orgRow(b, 'cleared'),
      orgRow(b, 'failed'),
      orgRow(null, 'cleared'),
      orgRow(null, 'cleared'),
      orgRow(null, 'cleared'),
    ]
    expect(byOrg(rows).map((o) => [o.orgId, o.cleared, o.total])).toEqual([['ob', 2, 3]])
    expect(byOrg([...rows, orgRow(a, 'cleared')]).map((o) => [o.orgId, o.total])).toEqual([
      ['oa', 3],
      ['ob', 3],
    ])
  })

  it('byOrg: 成功率 DESC → 件数 DESC → 名前 ASC、上位 10。平均評価は rating がある成功・失敗の平均', () => {
    const orgs = Array.from({ length: 12 }, (_, i) => ({
      id: `o${i}`,
      name: `団体${String.fromCharCode(0x41 + i)}`,
    }))
    const rows = orgs.flatMap((o, i) => [
      // o0 / o1 は 4 件、それ以外は 3 件。o0〜o5 は全勝、o6〜 は 1 敗
      ...(i < 2 ? [orgRow(o, 'cleared')] : []),
      orgRow(o, 'cleared', i === 0 ? 4 : null),
      orgRow(o, 'cleared', i === 0 ? 5 : null),
      orgRow(o, i < 6 ? 'cleared' : 'failed', i === 0 ? 4 : null),
    ])
    // 予約済みの評価は平均に入れない
    rows.push(orgRow(orgs[0], 'purchased', 1))
    const o = byOrg(rows)
    expect(o.map((x) => x.orgId)).toEqual([
      'o0',
      'o1',
      'o2',
      'o3',
      'o4',
      'o5',
      'o6',
      'o7',
      'o8',
      'o9',
    ])
    expect(o[0].rating).toBeCloseTo(13 / 3)
    expect(o[1].rating).toBeNull()
  })

  it('splitCompanions: 全角・半角の区切りと空白で分け、空と 1 記録内の重複を捨てる', () => {
    expect(splitCompanions('あや、けん,ゆう，みき/はる／なな\u3000そら  りく')).toEqual([
      'あや',
      'けん',
      'ゆう',
      'みき',
      'はる',
      'なな',
      'そら',
      'りく',
    ])
    expect(splitCompanions(' 、、 あや ,, あや／けん ')).toEqual(['あや', 'けん'])
    expect(splitCompanions('、 ／')).toEqual([])
    expect(splitCompanions('')).toEqual([])
    expect(splitCompanions(null)).toEqual([])
  })

  it('byCompanion: 1 記録内の重複は 1 回。3 件以上だけ、成功率の順', () => {
    const v = byCompanion([
      row({ status: 'cleared', companions: 'あや、あや,けん' }),
      row({ status: 'failed', companions: 'あや／けん' }),
      row({ status: 'cleared', companions: 'あや けん' }),
      row({ status: 'cleared', companions: 'ゆう' }),
      row({ status: 'cleared', companions: 'みき' }),
      row({ status: 'cleared', companions: 'みき' }),
      row({ status: 'cleared', companions: 'みき' }),
      row({ status: 'dropped', companions: 'ゆう' }),
      row({ status: 'purchased', companions: 'ゆう' }),
    ])
    expect(v.map((x) => [x.label, x.cleared, x.total])).toEqual([
      ['みき', 3, 3],
      ['あや', 2, 3],
      ['けん', 2, 3],
    ])
  })

  it('summarizeVisit.retries: attempt_no >= 2 の成功・失敗だけ', () => {
    expect(
      summarizeVisit([
        row({ status: 'cleared', attemptNo: 2 }),
        row({ status: 'failed', attemptNo: 3 }),
        row({ status: 'cleared' }),
        row({ status: 'purchased', attemptNo: 2 }),
        row({ status: 'dropped', attemptNo: 2 }),
      ]).retries,
    ).toBe(2)
  })

  it('完了型の記録は visit の物量・団体・同行者・再挑戦に混ざらない', () => {
    const org = { id: 'od', name: 'D' }
    const done = Array.from({ length: 3 }, () => {
      const r = row({
        status: 'cleared',
        kind: 'takeaway',
        volume: 3,
        companions: 'あや',
        attemptNo: 2,
      })
      return { ...r, work: { ...r.work, org } }
    })
    const v = computeStats(done, [], new Map(), { year: 2026, today: '2026-11-27' }).visit
    expect(v.byVolume.every((x) => x.total === 0)).toBe(true)
    expect(v.byOrg).toEqual([])
    expect(v.byCompanion).toEqual([])
    expect(v.summary.retries).toBe(0)
  })
})

describe('src/lib/stats（完了側の傾向）', () => {
  it('backlogOldest: purchased だけを purchased_on の古い順、NULL は最後、同じ日は created_at 順、上位 10', () => {
    const rows = [
      row({
        id: 'none',
        status: 'purchased',
        kind: 'takeaway',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      row({ id: 'new', status: 'purchased', kind: 'web', purchasedOn: '2026-11-20' }),
      row({
        id: 'old2',
        status: 'purchased',
        kind: 'line',
        purchasedOn: '2025-05-01',
        createdAt: '2026-02-02T00:00:00.000Z',
      }),
      row({
        id: 'old1',
        status: 'purchased',
        kind: null,
        purchasedOn: '2025-05-01',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
      row({ id: 'cl', status: 'cleared', kind: 'web', purchasedOn: '2024-01-01' }),
      row({ id: 'ip', status: 'in_progress', kind: 'web', purchasedOn: '2024-01-01' }),
      // 来場型の purchased は予約済みなので出さない
      row({ id: 'room', status: 'purchased', kind: 'room', purchasedOn: '2024-01-01' }),
    ]
    const b = backlogOldest(rows, '2026-11-27')
    expect(b.map((x) => [x.attemptId, x.days])).toEqual([
      ['old1', 575],
      ['old2', 575],
      ['new', 7],
      ['none', null],
    ])
    const many = Array.from({ length: 12 }, (_, i) =>
      row({
        id: `m${i}`,
        status: 'purchased',
        kind: 'takeaway',
        purchasedOn: `2026-01-${String(12 - i).padStart(2, '0')}`,
      }),
    )
    const top = backlogOldest(many, '2026-11-27')
    expect(top).toHaveLength(10)
    expect(top[0].attemptId).toBe('m11')
    expect(top[0].purchasedOn).toBe('2026-01-01')
  })

  it('computeStats: 来場型の予約済みは積み謎の古い順に出ない', () => {
    const d = computeStats(
      [
        row({ status: 'purchased', kind: 'hall', purchasedOn: '2020-01-01' }),
        row({ status: 'purchased', kind: 'room' }),
        row({ id: 'tk', status: 'purchased', kind: 'takeaway' }),
      ],
      [],
      new Map(),
      { year: 2026, today: '2026-11-27' },
    ).done
    expect(d.backlogOldest.map((x) => x.attemptId)).toEqual(['tk'])
  })

  it('doneAverages: cleared だけを形式ごと、値がある行だけで平均。無ければ null。順は doneKindOrder', () => {
    const a = doneAverages([
      row({ status: 'cleared', kind: null, difficulty: 2 }),
      row({ status: 'cleared', kind: 'takeaway', difficulty: 3, volume: 2 }),
      row({ status: 'cleared', kind: 'takeaway', difficulty: 4 }),
      row({ status: 'cleared', kind: 'takeaway' }),
      row({ status: 'dropped', kind: 'takeaway', difficulty: 1, volume: 1 }),
      row({ status: 'purchased', kind: 'line', difficulty: 5 }),
      row({ status: 'cleared', kind: 'stroll' }),
      row({ status: 'cleared', kind: 'room', difficulty: 5, volume: 5 }),
    ])
    expect(a).toEqual([
      { kind: 'stroll', difficulty: null, volume: null },
      { kind: 'takeaway', difficulty: 3.5, volume: 2 },
      { kind: null, difficulty: 2, volume: null },
    ])
  })

  const donePage = async (rows: OwnAttemptRow[]) =>
    String(
      await StatsPage({
        stats: computeStats(rows, [], new Map(), { year: 2026, today: '2026-11-27' }),
        view: 'done',
        year: 2026,
        thisYear: 2026,
        minYear: 2000,
        capped: false,
        wishlist: { total: 0, played: 0 },
      }),
    )

  it('done の画面: 形式別の平均は小数 1 桁・無ければ「—」、積み謎は記録へのリンクと経過日数', async () => {
    const html = await donePage([
      row({ status: 'cleared', kind: 'takeaway', difficulty: 3, volume: 4 }),
      row({ status: 'cleared', kind: 'takeaway', difficulty: 4 }),
      row({ status: 'cleared', kind: 'web' }),
      row({ id: 'p1', status: 'purchased', kind: 'line', purchasedOn: '2026-11-24' }),
      row({ id: 'p2', status: 'purchased', kind: 'line' }),
    ])
    expect(html).toContain(
      '<dl class="kv"><dt>Web</dt><dd>難易度 — · 物量 —</dd><dt>持ち帰り</dt><dd>難易度 3.5 · 物量 4.0</dd></dl>',
    )
    expect(html).toContain(
      '<a href="/records/p1"><span>t</span><span class="note">3 日前に購入</span></a><a href="/records/p2"><span>t</span><span class="note">日付なし</span></a>',
    )
  })

  it('done の画面: 0 件なら形式別の平均・積み謎の古い順は Empty', async () => {
    const html = await donePage([])
    expect(html.match(/まだ完了した記録がありません。/g)).toHaveLength(2)
    expect(html).toContain('買った・未着手の記録はありません。')
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

  it('RateBars: best はラベルに蛍光ペン＋「得意」、note は棒の下の注記', async () => {
    const html = String(
      await RateBars({
        items: [
          { label: '論理', total: 5, cleared: 5, best: true },
          { label: '団体', total: 3, cleared: 3, note: '平均評価 4.3' },
        ],
      }),
    )
    expect(html).toContain(
      '<div class="bar"><span><span class="hl">論理</span> <span class="pen">得意</span></span>',
    )
    expect(html).toContain(
      '<span class="v">100% · 3/3</span><span class="bar-note">平均評価 4.3</span></div>',
    )
    expect(html.match(/class="hl"/g)).toHaveLength(1)
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

describe('GET /stats（カフェ・箱）', () => {
  let dave = { cookie: '', userId: '' }
  beforeAll(async () => {
    dave = await loginAs(env, { subject: 'stats-dave' })
    const cafe = await insertWork(env, { title: '統計のカフェ', kind: 'cafe' })
    const box = await insertWork(env, { title: '統計の箱', kind: 'box' })
    const on = `${thisYear}-10-01`
    await insertAttempt(env, {
      userId: dave.userId,
      workId: cafe,
      status: 'cleared',
      finishedOn: on,
    })
    await insertAttempt(env, {
      userId: dave.userId,
      workId: box,
      status: 'cleared',
      finishedOn: on,
    })
    await insertAttempt(env, {
      userId: dave.userId,
      workId: box,
      status: 'cleared',
      attemptNo: 2,
      finishedOn: on,
    })
  })

  it('完了数の側に出る（棒・凡例・月別）。来場型には入らない', async () => {
    const done = await (await get('/stats?view=done', dave.cookie)).text()
    expect(done).toContain('<b><span class="hl">3</span></b><span>断念 0</span>')
    expect(done).toContain(
      '<div class="bar"><span>カフェ</span><div class="tr"><div class="fl k-cafe" style="width:50%"></div></div><span class="v">1 件</span></div>',
    )
    expect(done).toContain(
      '<div class="bar"><span>箱</span><div class="tr"><div class="fl k-box" style="width:100%"></div></div><span class="v">2 件</span></div>',
    )
    expect(done).toContain(
      '<ul class="legend"><li><i class="key k-cafe"></i>カフェ</li><li><i class="key k-box"></i>箱</li></ul>',
    )
    expect(done).toContain('aria-label="10月 カフェ 1・箱 2"><span>3</span>')
    const visit = await (await get('/stats?view=visit', dave.cookie)).text()
    expect(visit).not.toContain('k-cafe')
    expect(visit).not.toContain('k-box')
  })
})

describe('GET /stats（得意傾向）', () => {
  let erin = { cookie: '', userId: '' }
  beforeAll(async () => {
    erin = await loginAs(env, { subject: 'stats-erin' })
    const org = await insertOrg(env, { name: '傾向の団体' })
    const few = await insertOrg(env, { name: '傾向の少ない団体' })
    const w = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        insertWork(env, { title: `傾向の謎${n}`, kind: 'room', orgId: n <= 5 ? org : few }),
      ),
    )
    const take = await insertWork(env, { title: '傾向の持ち帰り', kind: 'takeaway', orgId: few })
    const on = `${thisYear}-09-01`
    // 論理 5 件（成功 4・失敗 1、物量 4）。団体は 5 件、同行者「あや」「けん」は 3 件、5 件目は再挑戦
    const results = ['cleared', 'cleared', 'cleared', 'cleared', 'failed'] as const
    for (const [i, status] of results.entries()) {
      const id = await insertAttempt(env, {
        userId: erin.userId,
        workId: w[i],
        status,
        finishedOn: on,
        volume: 4,
        rating: i < 2 ? 4 : i === 2 ? 5 : undefined,
        companions: i < 3 ? 'あや、けん' : undefined,
        attemptNo: i === 4 ? 2 : 1,
      })
      await insertGenre(env, id, erin.userId, 'g_logic')
    }
    // 少ない団体は 2 件（出ない。うち 1 件は再挑戦）。完了型の記録は団体別に入らない
    await insertAttempt(env, {
      userId: erin.userId,
      workId: w[5],
      status: 'cleared',
      finishedOn: on,
    })
    await insertAttempt(env, {
      userId: erin.userId,
      workId: w[5],
      status: 'failed',
      attemptNo: 2,
      finishedOn: on,
    })
    await insertAttempt(env, {
      userId: erin.userId,
      workId: take,
      status: 'cleared',
      attemptNo: 2,
      finishedOn: on,
    })
  })

  it('?view=visit: 物量・団体・同行者・再挑戦と、ジャンルの「得意」。蛍光ペンは 2 か所', async () => {
    const html = await (await get('/stats?view=visit', erin.cookie)).text()
    expect(html).toContain('<b>7</b><span>成功 5 / 失敗 2 · 再挑戦 2</span>')
    expect(html).toMatch(barOf('量 4', '80% · 4/5'))
    expect(html).toMatch(barOf('量 1', '—'))
    expect(html).toContain(
      '<span><span class="hl">論理</span> <span class="pen">得意</span></span>',
    )
    expect(html).toContain(
      '<span class="v">80% · 4/5</span><span class="bar-note">平均評価 4.3</span>',
    )
    expect(html).not.toContain('傾向の少ない団体')
    expect(html).toMatch(barOf('あや', '100% · 3/3'))
    expect(html).toMatch(barOf('けん', '100% · 3/3'))
    expect(html.match(/class="hl[ "]/g)).toHaveLength(2)
    // 団体別・同行者別だけラベルを棒の上に置く
    expect(html.match(/<div class="bars label-top">/g)).toHaveLength(2)
  })

  it('成功・失敗の記録はあるが 3 件以上の団体・同行者が無いときの文言', async () => {
    const html = await (await get('/stats?view=visit', bob.cookie)).text()
    expect(html).toContain('3 件以上の団体はまだありません。')
    expect(html).toContain('3 件以上の同行者はまだありません。')
  })

  it('同行者名の <script> はエスケープされる', async () => {
    const rows = Array.from({ length: 3 }, () =>
      // 「/」は区切りなので閉じタグは付けない
      row({ status: 'cleared', companions: '<script>alert(1)' }),
    )
    const html = String(
      await StatsPage({
        stats: computeStats(rows, [], new Map(), { year: 2026, today: '2026-11-27' }),
        view: 'visit',
        year: 2026,
        thisYear: 2026,
        minYear: 2000,
        capped: false,
        wishlist: { total: 0, played: 0 },
      }),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)')
  })

  it('記録 0 件なら団体別・同行者別は Empty、「再挑戦」「得意」は出さない', async () => {
    const html = await (await get('/stats?view=visit', carol.cookie)).text()
    expect(html).toContain('<b>0</b><span>成功 0 / 失敗 0</span>')
    expect(html).not.toContain('得意')
    expect(html).not.toContain('再挑戦')
    expect(html.match(/まだデータがありません。/g)).toHaveLength(3)
    expect(html).not.toContain('3 件以上の')
  })
})

describe('GET /stats（完了側の傾向）', () => {
  let frank = { cookie: '', userId: '' }
  // 今日（JST）から n 日前の YYYY-MM-DD
  const daysAgo = (n: number) =>
    new Date(Date.parse(todayJst()) - n * 86_400_000).toISOString().slice(0, 10)
  beforeAll(async () => {
    frank = await loginAs(env, { subject: 'stats-frank' })
    const take = await insertWork(env, { title: '傾向の積み持ち帰り', kind: 'takeaway' })
    const web = await insertWork(env, { title: '傾向の積みWeb', kind: 'web' })
    const room = await insertWork(env, { title: '傾向の予約ルーム', kind: 'room' })
    await insertAttempt(env, {
      userId: frank.userId,
      workId: take,
      status: 'purchased',
      purchasedOn: daysAgo(3),
    })
    await insertAttempt(env, { userId: frank.userId, workId: web, status: 'purchased' })
    await insertAttempt(env, {
      userId: frank.userId,
      workId: room,
      status: 'purchased',
      purchasedOn: daysAgo(30),
    })
    await insertAttempt(env, {
      userId: frank.userId,
      workId: web,
      status: 'cleared',
      attemptNo: 2,
      difficulty: 2,
      volume: 3,
      finishedOn: daysAgo(1),
    })
  })

  it('?view=done: 積み謎の古い順（経過日数は今日 JST から、予約済みは出ない）と形式別の平均', async () => {
    const html = await (await get('/stats?view=done', frank.cookie)).text()
    expect(html).toMatch(
      /<a href="\/records\/[0-9A-Z]+"><span>傾向の積み持ち帰り<\/span><span class="note">3 日前に購入<\/span><\/a><a href="\/records\/[0-9A-Z]+"><span>傾向の積みWeb<\/span><span class="note">日付なし<\/span><\/a><\/div>/,
    )
    expect(html).not.toContain('傾向の予約ルーム')
    expect(html).toContain('<dt>Web</dt><dd>難易度 2.0 · 物量 3.0</dd>')
  })
})
