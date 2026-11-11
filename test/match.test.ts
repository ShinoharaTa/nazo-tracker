import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import type { MatchResult } from '../src/db/match'
import app from '../src/index'
import { dice, normalizeMatchUrl, trigrams } from '../src/lib/match'
import { loginAs } from './helpers/auth'
import { insertOrg, insertOrgAlias, insertRun, insertWork, insertWorkAlias } from './helpers/master'

const get = (query: string, cookie?: string) =>
  app.request(`/api/admin/match?${query}`, { headers: cookie ? { Cookie: cookie } : {} }, env)

const q = (p: Record<string, string>) => new URLSearchParams(p).toString()

describe('trigrams / dice', () => {
  it('3 文字未満は文字列そのもの、それ以外は長さ 3 の部分文字列', () => {
    expect([...trigrams('ab')]).toEqual(['ab'])
    expect([...trigrams('abcd')].sort()).toEqual(['abc', 'bcd'])
    expect([...trigrams('猫の手も')].sort()).toEqual(['の手も', '猫の手'].sort())
  })

  it('同一は 1、無関係は 0', () => {
    expect(dice(trigrams('wordeal'), trigrams('wordeal'))).toBe(1)
    expect(dice(trigrams('abcdef'), trigrams('uvwxyz'))).toBe(0)
  })

  it('URL の正規化', () => {
    expect(normalizeMatchUrl('https://ESCAPE.id/foo-org/e-bar?x=1#y')).toBe(
      'https://escape.id/foo-org/e-bar/',
    )
    expect(normalizeMatchUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeMatchUrl('not a url')).toBeNull()
    expect(normalizeMatchUrl('https://u:p@escape.id/foo-org/e-bar/')).toBe(
      'https://escape.id/foo-org/e-bar/',
    )
  })
})

describe('GET /api/admin/match', () => {
  const ids: Record<string, string> = {}
  let owner = ''

  beforeAll(async () => {
    owner = (await loginAs(env, { subject: 'match-owner', owner: true })).cookie
    ids.org = await insertOrg(env, { name: 'マッチ検証団' })
    await insertOrgAlias(env, { organizationId: ids.org, name: '旧マッチ団', kind: 'former_name' })
    ids.oldOrg = await insertOrg(env, { name: '統合前マッチ団', mergedIntoId: ids.org })
    ids.other = await insertOrg(env, { name: '別のマッチ団体' })
    ids.word = await insertWork(env, { title: 'MATCHWORD', kind: 'room', orgId: ids.org })
    ids.wordOther = await insertWork(env, { title: 'MATCHWORD', kind: 'hall', orgId: ids.other })
    ids.run = await insertRun(env, {
      workId: ids.word,
      channel: 'performance',
      escapeIdUrl: 'https://escape.id/matchorg-org/e-matchword/',
    })
    ids.cat = await insertWork(env, {
      title: '猫の手も借りたい猫カフェ開店準備からの脱出！',
      kind: 'room',
    })
    ids.merged = await insertWork(env, { title: 'マッチ統合済み作品', mergedIntoId: ids.cat })
    ids.aliased = await insertWork(env, { title: 'マッチ本題', kind: 'room' })
    await insertWorkAlias(env, { workId: ids.aliased, title: 'マッチ旧題', kind: 'former_title' })
    // Dice 1.0 だが文字列が違う組（Workers は similar を返さない）
    ids.doki = await insertWork(env, { title: 'どきどき', kind: 'room', orgId: ids.org })
    ids.doki3 = await insertWork(env, { title: 'どきどきどき', kind: 'room' })
    // 題名で完全一致、別名は似ているだけの作品
    ids.pika = await insertWork(env, { title: 'ぴかぴか', kind: 'room' })
    await insertWorkAlias(env, { workId: ids.pika, title: 'ぴかぴかぴか', kind: 'alt_spelling' })
    // primary は別団体、run の名義が検証団
    ids.byRun = await insertWork(env, { title: '名義で当たる作品', kind: 'room', orgId: ids.other })
    await insertRun(env, { workId: ids.byRun, channel: 'performance', organizationId: ids.org })
    ids.short = await insertWork(env, { title: '謎', kind: 'room' })
    ids.shortOrg = await insertOrg(env, { name: 'ナゾ' })
  })

  const match = async (p: Record<string, string>): Promise<MatchResult> => {
    const res = await get(q(p), owner)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    return res.json()
  }

  it('未ログインは JSON の 404（302 ではない）', async () => {
    const res = await get(q({ title: 'MATCHWORD' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('member は JSON の 404', async () => {
    const { cookie } = await loginAs(env, { subject: 'match-member' })
    const res = await get(q({ title: 'MATCHWORD' }), cookie)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('title も url も無ければ 400', async () => {
    const res = await get(q({ org: 'マッチ検証団' }), owner)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'title_or_url_required' })
  })

  it('javascript: の url は 400', async () => {
    const res = await get(q({ url: 'javascript:alert(1)' }), owner)
    expect(res.status).toBe(400)
  })

  it('題名の完全一致は 0.85', async () => {
    const r = await match({ title: 'MATCHWORD' })
    expect(r.titleNorm).toBe('matchword')
    expect(r.orgNorm).toBeNull()
    const ws = r.works.filter((w) => w.id === ids.word || w.id === ids.wordOther)
    expect(ws).toHaveLength(2)
    for (const w of ws) expect(w).toMatchObject({ score: 0.85, reason: 'title', via: 'name' })
  })

  it('norm で同じになる題名も 0.85', async () => {
    const r = await match({ title: 'ＭＡＴＣＨＷＯＲＤ 2026' })
    expect(r.titleNorm).toBe('matchword')
    expect(r.works.find((w) => w.id === ids.word)).toMatchObject({ score: 0.85, reason: 'title' })
  })

  it('同団体の題名一致は 0.95（団体を別名で渡しても）', async () => {
    for (const org of ['マッチ検証団', '旧マッチ団', '統合前マッチ団']) {
      const r = await match({ title: 'MATCHWORD', org })
      expect(r.works[0]).toEqual({
        id: ids.word,
        name: 'MATCHWORD',
        score: 0.95,
        reason: 'same_org_title',
        via: 'name',
        organization: { id: ids.org, name: 'マッチ検証団' },
      })
      // 別団体の同名作品は 0.85 のまま
      expect(r.works.find((w) => w.id === ids.wordOther)?.score).toBe(0.85)
      expect(r.organizations[0]).toMatchObject({ id: ids.org, score: 1, reason: 'name' })
      // 統合済みの団体は候補に出ない
      expect(r.organizations.some((o) => o.id === ids.oldOrg)).toBe(false)
    }
  })

  it('url の一致は 1.0 と runId', async () => {
    const r = await match({ url: 'https://escape.id/matchorg-org/e-matchword?ref=x' })
    expect(r.titleNorm).toBeNull()
    expect(r.works).toEqual([
      {
        id: ids.word,
        name: 'MATCHWORD',
        score: 1,
        reason: 'escape_id_url',
        via: 'name',
        organization: { id: ids.org, name: 'マッチ検証団' },
        runId: ids.run,
      },
    ])
  })

  it('似た題名は Workers では返さない（完全一致だけ）', async () => {
    const r = await match({ title: '猫の手も借りたい猫カフェ開店準備からの脱出' })
    // 「！」は norm で消えるので完全一致になる
    expect(r.works.find((w) => w.id === ids.cat)?.reason).toBe('title')
    const s = await match({ title: '猫の手も借りたい猫カフェ開店準備から脱出' })
    expect(s.works).toEqual([])
  })

  it('無関係なら works は空', async () => {
    const r = await match({ title: 'まったく関係のないぞ題名xyz' })
    expect(r.works).toEqual([])
  })

  it('統合済みの作品は候補に出ない', async () => {
    const r = await match({ title: 'マッチ統合済み作品' })
    expect(r.works.some((w) => w.id === ids.merged)).toBe(false)
  })

  it('別名だけ一致すると via alias', async () => {
    const r = await match({ title: 'マッチ旧題' })
    expect(r.works[0]).toMatchObject({
      id: ids.aliased,
      name: 'マッチ本題',
      score: 0.85,
      reason: 'title',
      via: 'alias',
    })
  })

  it('似た団体名は Workers では返さない', async () => {
    const r = await match({ title: 'MATCHWORD', org: 'マッチ検証団体' })
    expect(r.organizations).toEqual([])
  })

  it('Dice 1.0 でも文字列が違えば候補に出ない', async () => {
    const r = await match({ title: 'どきどき', org: 'マッチ検証団' })
    expect(r.works).toEqual([
      expect.objectContaining({ id: ids.doki, score: 0.95, reason: 'same_org_title' }),
    ])
  })

  it('別名が似ているだけなら題名の一致 1 件だけ', async () => {
    const r = await match({ title: 'ぴかぴか' })
    expect(r.works.filter((w) => w.id === ids.pika)).toEqual([
      expect.objectContaining({ score: 0.85, reason: 'title', via: 'name' }),
    ])
  })

  it('run の団体名義でも same_org_title（primary は別団体）', async () => {
    const r = await match({ title: '名義で当たる作品', org: 'マッチ検証団' })
    expect(r.works[0]).toMatchObject({
      id: ids.byRun,
      score: 0.95,
      reason: 'same_org_title',
      organization: { id: ids.other, name: '別のマッチ団体' },
    })
  })

  it('有効だが一致しない url は 200 で空', async () => {
    const r = await match({ url: 'https://escape.id/nothing-org/e-nothing/' })
    expect(r.works).toEqual([])
  })

  it('userinfo 付きの url は一致なし', async () => {
    const r = await match({ url: 'https://u:p@escape.id/matchorg-org/e-matchword/' })
    expect(r.works).toEqual([])
  })

  it('1〜2 文字の title は完全一致だけ', async () => {
    const r = await match({ title: '謎' })
    expect(r.works).toEqual([expect.objectContaining({ id: ids.short, reason: 'title' })])
    expect((await match({ title: 'ぬぬ' })).works).toEqual([])
  })

  it('2 文字の org は完全一致だけ', async () => {
    const r = await match({ title: 'MATCHWORD', org: 'ナゾ' })
    expect(r.orgNorm).toBe('ナゾ')
    expect(r.organizations).toEqual([
      { id: ids.shortOrg, name: 'ナゾ', score: 1, reason: 'name', via: 'name' },
    ])
  })

  it('title / org が 200 文字を超えると 400', async () => {
    const long = '謎'.repeat(201)
    const t = await get(q({ title: long }), owner)
    expect(t.status).toBe(400)
    expect(await t.json()).toEqual({ error: 'title_too_long' })
    const o = await get(q({ title: 'MATCHWORD', org: long }), owner)
    expect(o.status).toBe(400)
    expect(await o.json()).toEqual({ error: 'org_too_long' })
    // ちょうど 200 文字は通る
    expect((await get(q({ title: '謎'.repeat(200) }), owner)).status).toBe(200)
  })
})
