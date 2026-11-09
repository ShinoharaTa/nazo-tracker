import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../src/db/client'
import { scopedTo } from '../src/db/scoped'
import { loginAs } from './helpers/auth'

const db = createDb(env.DB)
const now = '2026-11-08T00:00:00.000Z'

const befriend = (a: string, b: string) => {
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return env.DB.prepare('INSERT INTO friendship (user_lo, user_hi, created_at) VALUES (?, ?, ?)')
    .bind(lo, hi, now)
    .run()
}

const blockUser = (from: string, to: string) =>
  env.DB.prepare('INSERT INTO block (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)')
    .bind(from, to, now)
    .run()

let a = ''
let b = ''
beforeAll(async () => {
  a = (await loginAs(env, { subject: 'scoped-a' })).userId
  b = (await loginAs(env, { subject: 'scoped-b' })).userId
})

describe('scopedTo().own()', () => {
  it('profile() は自分の行', async () => {
    const p = await scopedTo(db, a).own().profile()
    expect(p.id).toBe(a)
    expect(p.displayName).toBe('ななしさん')
    expect(p.role).toBe('member')
    expect(p.friendCode).toBeNull()
    expect(p.excludeFromCounts).toBe(false)
    expect(typeof p.createdAt).toBe('string')
  })

  it('updateDisplayName は自分だけを変え、ほかの user に影響しない', async () => {
    await scopedTo(db, a).own().updateDisplayName('えー')
    expect((await scopedTo(db, a).own().profile()).displayName).toBe('えー')
    expect((await scopedTo(db, b).own().profile()).displayName).toBe('ななしさん')
  })

  it('linkedProviders() は自分の identity だけ。他人の identity は混ざらない', async () => {
    await env.DB.prepare(
      "INSERT INTO identity (provider, subject, user_id, created_at) VALUES ('google', 'scoped-b-google', ?, ?)",
    )
      .bind(b, now)
      .run()
    expect(await scopedTo(db, a).own().linkedProviders()).toEqual(new Set(['dev']))
    expect(await scopedTo(db, b).own().linkedProviders()).toEqual(new Set(['dev', 'google']))
  })
})

describe('scopedTo().asFriendOf()', () => {
  it('friendship が無ければ null', async () => {
    const x = (await loginAs(env, { subject: 'scoped-x' })).userId
    const y = (await loginAs(env, { subject: 'scoped-y' })).userId
    expect(await scopedTo(db, x).asFriendOf(y)).toBeNull()
  })

  it('friendship があれば FriendRepo（どちらから見ても）', async () => {
    const x = (await loginAs(env, { subject: 'scoped-f1' })).userId
    const y = (await loginAs(env, { subject: 'scoped-f2' })).userId
    await befriend(x, y)
    expect(await scopedTo(db, x).asFriendOf(y)).toEqual({ targetUserId: y, level: 'status' })
    expect(await scopedTo(db, y).asFriendOf(x)).toEqual({ targetUserId: x, level: 'status' })
  })

  it('friendship があっても viewer → target の block があれば null', async () => {
    const x = (await loginAs(env, { subject: 'scoped-b1' })).userId
    const y = (await loginAs(env, { subject: 'scoped-b2' })).userId
    await befriend(x, y)
    await blockUser(x, y)
    expect(await scopedTo(db, x).asFriendOf(y)).toBeNull()
    expect(await scopedTo(db, y).asFriendOf(x)).toBeNull()
  })

  it('friendship があっても target → viewer の block があれば null', async () => {
    const x = (await loginAs(env, { subject: 'scoped-b3' })).userId
    const y = (await loginAs(env, { subject: 'scoped-b4' })).userId
    await befriend(x, y)
    await blockUser(y, x)
    expect(await scopedTo(db, x).asFriendOf(y)).toBeNull()
    expect(await scopedTo(db, y).asFriendOf(x)).toBeNull()
  })

  it('自分自身は null', async () => {
    expect(await scopedTo(db, a).asFriendOf(a)).toBeNull()
  })
})
