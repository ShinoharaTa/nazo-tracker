import assert from 'node:assert/strict'
import { test } from 'node:test'
import { norm } from '../../src/lib/norm.js'
import { ApiClient } from '../src/client.js'
import { scoreOf, searchMaster, similarity } from '../src/search.js'
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
