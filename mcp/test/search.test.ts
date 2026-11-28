import assert from 'node:assert/strict'
import { test } from 'node:test'
import { norm } from '../../src/lib/norm.js'
import { ApiClient } from '../src/client.js'
import { dice, levenshtein, scoreOf, searchMaster, similarity } from '../src/search.js'
import { type Call, startFake, TOKEN } from './helpers.js'

// 1 頁 2 件ずつ返す /index。part=alias も見る
const pages = (rows: Record<string, unknown>[], call: Call) => {
  const after = call.query.get('after')
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0
  const items = rows.slice(start, start + 2)
  const next = start + 2 < rows.length ? (items.at(-1)?.id ?? null) : null
  return { status: 200, body: { items, next } }
}

const work = (id: string, title: string, org: string | null = null) => ({
  id,
  work_id: id,
  title,
  title_norm: norm(title),
  org_id: org,
})

test('work: 名前と別名を全頁引き、部分一致・別名・近い名前を返す', async () => {
  const names = [
    work('w1', '星降る夜の図書館'),
    work('w2', '無関係な公演'),
    work('w3', '図書館からの脱出【追加公演】', 'o1'),
    work('w4', 'まったく別'),
    work('w5', '星降る夜の図書室'),
  ]
  const aliases = [
    {
      id: 'a1',
      work_id: 'w4',
      title: '星降る夜の図書館',
      title_norm: norm('星降る夜の図書館'),
      org_id: null,
    },
    { id: 'a2', work_id: 'w2', title: 'べつめい', title_norm: 'べつめい', org_id: null },
    { id: 'a3', work_id: 'w1', title: '星降る', title_norm: norm('星降る'), org_id: null },
  ]
  const fake = await startFake((call) => {
    if (call.path !== '/api/agent/index/work') return { status: 404, body: { error: 'nf' } }
    return pages(call.query.get('part') === 'alias' ? aliases : names, call)
  })
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'work',
      '星降る夜の図書館',
      20,
    )
    // 頁送り: name 3 頁 + alias 2 頁
    assert.equal(fake.calls.filter((c) => c.query.get('part') === 'name').length, 3)
    assert.equal(fake.calls.filter((c) => c.query.get('part') === 'alias').length, 2)
    assert.equal(fake.calls[1]?.query.get('after'), 'w2')
    assert.equal(fake.calls[0]?.query.get('limit'), '1000')

    const byId = new Map(r.items.map((h) => [h.id, h]))
    assert.equal(byId.get('w1')?.reason, 'name_exact')
    assert.equal(byId.get('w1')?.score, 1)
    // 別名で完全一致。主名を name、当たった別名を alias に
    assert.deepEqual(
      { name: byId.get('w4')?.name, alias: byId.get('w4')?.alias, reason: byId.get('w4')?.reason },
      { name: 'まったく別', alias: '星降る夜の図書館', reason: 'alias_exact' },
    )
    assert.equal(byId.get('w5')?.reason, 'name_similar')
    assert.ok(!byId.has('w2'))
    // 点の高い順
    assert.deepEqual(
      r.items.map((h) => h.score),
      [...r.items.map((h) => h.score)].sort((a, b) => b - a),
    )
    assert.equal(r.truncated, false)
  } finally {
    await fake.close()
  }
})

test('部分一致: 短い語で長い題名に当たる。org_id を添える', async () => {
  const fake = await startFake((call) =>
    pages(
      call.query.get('part') === 'alias' ? [] : [work('w3', '図書館からの脱出【追加公演】', 'o1')],
      call,
    ),
  )
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'work',
      '図書館',
      20,
    )
    assert.equal(r.items[0]?.reason, 'name_partial')
    assert.equal(r.items[0]?.org_id, 'o1')
  } finally {
    await fake.close()
  }
})

test('venue は別名を引かない。limit で切る', async () => {
  const venues = [1, 2, 3, 4].map((i) => ({
    id: `v${i}`,
    name: `テスト会場${i}`,
    name_norm: norm(`テスト会場${i}`),
    prefecture: '東京都',
  }))
  const fake = await startFake((call) => pages(venues, call))
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'venue',
      'テスト会場',
      2,
    )
    assert.ok(fake.calls.every((c) => c.query.get('part') === 'name'))
    assert.equal(r.items.length, 2)
    assert.equal(r.items[0]?.prefecture, '東京都')
  } finally {
    await fake.close()
  }
})

test('similarity / scoreOf', () => {
  assert.equal(similarity('abcd', 'abcd'), 1)
  assert.equal(similarity('ab', 'cd'), 0)
  assert.equal(scoreOf('abc', 'abc')?.kind, 'exact')
  assert.equal(scoreOf('ab', 'xxabxx')?.kind, 'partial')
  assert.equal(scoreOf('abcdef', 'abcdxx')?.kind, 'similar')
  assert.equal(scoreOf('abc', 'xyz'), null)
  assert.equal(scoreOf('', 'xyz'), null)
})

test('近い名前: bigram で拾えない 1 字違いもレーベンシュタインで拾う', () => {
  assert.equal(levenshtein('abcd', 'abxd'), 1)
  assert.equal(levenshtein('タンブルウィード', 'タンブルウイード'), 1)
  // コードポイント単位（サロゲートペアも 1 文字）
  assert.equal(levenshtein('a😀b', 'a😃b'), 1)
  assert.ok(dice('abcd', 'abxd') < 0.5)
  const a = scoreOf('abcd', 'abxd')
  assert.equal(a?.kind, 'similar')
  assert.equal(a?.score, Math.round(0.75 * 0.7 * 100) / 100)
  const t = scoreOf(norm('タンブルウィード'), norm('タンブルウイード'))
  assert.equal(t?.kind, 'similar')
  assert.equal(t?.score, Math.round((1 - 1 / 8) * 0.7 * 100) / 100)
  assert.equal(scoreOf('abcd', 'abcd')?.score, 1)
})

test('部分一致で含まれる側が 1 文字なら 0.3（近い名前より下）。2 文字以上は 0.7〜0.95', () => {
  assert.deepEqual(scoreOf('abcd', 'd'), { score: 0.3, kind: 'partial' })
  assert.deepEqual(scoreOf('d', 'abcd'), { score: 0.3, kind: 'partial' })
  const two = scoreOf('abcd', 'cd')
  assert.ok(two && two.score >= 0.7 && two.score <= 0.95)
})

test('1 文字のマスタ名「D」は 1 字違いの近い名前より下、完全一致は 1', async () => {
  const fake = await startFake((call) =>
    pages(
      call.query.get('part') === 'alias'
        ? []
        : [work('w1', 'D'), work('w2', 'ABXD'), work('w3', 'ABCD'), work('w4', 'zzzz')],
      call,
    ),
  )
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'work',
      'ABCD',
      20,
    )
    assert.deepEqual(
      r.items.map((h) => [h.id, h.score, h.reason]),
      [
        ['w3', 1, 'name_exact'],
        ['w2', Math.round(0.75 * 0.7 * 100) / 100, 'name_similar'],
        ['w1', 0.3, 'name_partial'],
      ],
    )
  } finally {
    await fake.close()
  }
})

test('organization: 別名の行（organization_id）から主名を引く', async () => {
  const names = [
    { id: 'o1', organization_id: 'o1', name: '謎解き工房', name_norm: norm('謎解き工房') },
    { id: 'o2', organization_id: 'o2', name: '別の団体', name_norm: norm('別の団体') },
  ]
  const aliases = [
    { id: 'oa1', organization_id: 'o2', name: 'ナゾコウ', name_norm: norm('ナゾコウ') },
  ]
  const fake = await startFake((call) => {
    if (call.path !== '/api/agent/index/organization') return { status: 404, body: { error: 'nf' } }
    return pages(call.query.get('part') === 'alias' ? aliases : names, call)
  })
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'organization',
      'ナゾコウ',
      20,
    )
    assert.deepEqual(r.items, [
      {
        table: 'organization',
        id: 'o2',
        name: '別の団体',
        alias: 'ナゾコウ',
        score: 1,
        reason: 'alias_exact',
      },
    ])
  } finally {
    await fake.close()
  }
})

test('頁送りの上限で打ち切ったら truncated: true', async () => {
  let n = 0
  // next を返し続ける /index
  const fake = await startFake(() => {
    n++
    return { status: 200, body: { items: [work(`w${n}`, `題名${n}`)], next: `w${n}` } }
  })
  try {
    const r = await searchMaster(
      new ApiClient({ token: TOKEN, baseUrl: fake.url }),
      'work',
      '題名',
      20,
      { maxPages: 3 },
    )
    assert.equal(r.truncated, true)
    // name 3 頁 + alias 3 頁で止まる
    assert.equal(fake.calls.length, 6)
  } finally {
    await fake.close()
  }
})
