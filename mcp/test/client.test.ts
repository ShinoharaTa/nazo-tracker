import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiClient, ApiError } from '../src/client.js'
import { startFake, TOKEN } from './helpers.js'

test('Bearer を付け、/api/agent の下を呼ぶ。空のクエリは付けない', async () => {
  const fake = await startFake(() => ({ status: 200, body: { ok: 1 } }))
  try {
    const c = new ApiClient({ token: TOKEN, baseUrl: fake.url })
    assert.deepEqual(
      await c.get('/requests', { status: 'a,b', limit: 3, after: undefined, x: '' }),
      {
        ok: 1,
      },
    )
    const call = fake.calls[0]
    assert.equal(call?.path, '/api/agent/requests')
    assert.equal(call?.auth, `Bearer ${TOKEN}`)
    assert.equal(call?.query.toString(), 'status=a%2Cb&limit=3')
  } finally {
    await fake.close()
  }
})

test('GET は 5xx のとき 1 回だけやり直す', async () => {
  let n = 0
  const fake = await startFake(() =>
    ++n === 1 ? { status: 503, body: { error: 'x' } } : { status: 200, body: { ok: n } },
  )
  try {
    const c = new ApiClient({ token: TOKEN, baseUrl: fake.url })
    assert.deepEqual(await c.get('/whoami'), { ok: 2 })
    assert.equal(fake.calls.length, 2)
  } finally {
    await fake.close()
  }
})

test('GET は 2 回目も 5xx ならそのエラー（3 回目は無い）', async () => {
  const fake = await startFake(() => ({ status: 500, body: { error: 'boom' } }))
  try {
    const c = new ApiClient({ token: TOKEN, baseUrl: fake.url })
    await assert.rejects(c.get('/whoami'), (e) => e instanceof ApiError && e.code === 'boom')
    assert.equal(fake.calls.length, 2)
  } finally {
    await fake.close()
  }
})

test('4xx はやり直さず、本文の error をコードにする', async () => {
  const fake = await startFake(() => ({ status: 404, body: { error: 'not_found' } }))
  try {
    const c = new ApiClient({ token: TOKEN, baseUrl: fake.url })
    await assert.rejects(
      c.get('/requests/x'),
      (e) => e instanceof ApiError && e.status === 404 && e.code === 'not_found',
    )
    assert.equal(fake.calls.length, 1)
  } finally {
    await fake.close()
  }
})

test('タイムアウトは timeout。GET は 1 回だけやり直す', async () => {
  const fake = await startFake(() => 'hang')
  try {
    const c = new ApiClient({ token: TOKEN, baseUrl: fake.url }, 100)
    await assert.rejects(c.get('/whoami'), (e) => e instanceof ApiError && e.code === 'timeout')
    assert.equal(fake.calls.length, 2)
  } finally {
    await fake.close()
  }
})

test('つながらないときは network_error（エラー文にトークンが無い）', async () => {
  const fake = await startFake(() => ({ status: 200, body: {} }))
  const url = fake.url
  await fake.close()
  const c = new ApiClient({ token: TOKEN, baseUrl: url })
  await assert.rejects(
    c.get('/whoami'),
    (e) => e instanceof ApiError && e.code === 'network_error' && !String(e.stack).includes(TOKEN),
  )
})
