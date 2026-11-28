// マスタの画像（作品の画像・団体のロゴ。URL だけを持つ）の検証とオーナーの編集フォーム（#150）
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { emptyForm, orgFields, validateOrg, validateWork, workFields } from '../src/admin/validate'
import { createDb } from '../src/db/client'
import { createToken } from '../src/db/tokens'
import app from '../src/index'
import { loginAs, ORIGIN } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'

const IMG = 'https://static.escape.id/i/o/takarush/abc.png'
const PAGE = 'https://escape.id/takarush-org/e-room666/'
const LOGO = 'https://static.escape.id/o/takarush/nanica_logo.png'
const ORG_PAGE = 'https://escape.id/takarush-org/'

const get = (path: string, cookie: string) =>
  app.request(path, { headers: { Cookie: cookie } }, env)

const post = (path: string, form: Record<string, string>, cookie: string) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
      },
      body: new URLSearchParams(form).toString(),
    },
    env,
  )

type ImageRow = {
  image_url: string | null
  image_page_url: string | null
  image_blocked: number
}
type LogoRow = {
  logo_url: string | null
  logo_page_url: string | null
  image_blocked: number
}

const workRow = (id: string) =>
  env.DB.prepare('SELECT image_url, image_page_url, image_blocked FROM work WHERE id = ?')
    .bind(id)
    .first<ImageRow>()
const orgRow = (id: string) =>
  env.DB.prepare('SELECT logo_url, logo_page_url, image_blocked FROM organization WHERE id = ?')
    .bind(id)
    .first<LogoRow>()

const logsOf = async (rowId: string) =>
  (
    await env.DB.prepare(
      'SELECT action, before_json, after_json FROM change_log WHERE row_id = ? ORDER BY id',
    )
      .bind(rowId)
      .all<{ action: string; before_json: string | null; after_json: string | null }>()
  ).results

const setImage = (table: 'work' | 'organization', id: string, sets: Record<string, unknown>) => {
  const cols = Object.keys(sets)
  return env.DB.prepare(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  )
    .bind(...cols.map((c) => sets[c]), id)
    .run()
}

const errorsOf = async (res: Response) => {
  const html = await res.text()
  return [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1])
}

let owner: { cookie: string; userId: string }

beforeAll(async () => {
  owner = await loginAs(env, { subject: 'mi-owner', owner: true })
})

describe('マイグレーション 0009', () => {
  it('列 6 つが足され、image_blocked の既定は 0', async () => {
    const id = await insertWork(env, { title: `既定 ${crypto.randomUUID()}` })
    expect(await workRow(id)).toEqual({ image_url: null, image_page_url: null, image_blocked: 0 })
    const org = await insertOrg(env, { name: `既定 ${crypto.randomUUID()}` })
    expect(await orgRow(org)).toEqual({ logo_url: null, logo_page_url: null, image_blocked: 0 })
  })
})

describe('validateWork の画像', () => {
  const db = () => createDb(env.DB)
  const form = (over: Record<string, string>) => ({
    ...emptyForm(workFields),
    title: '画像の作品',
    ...over,
  })

  it('画像と取得元を組で入れると正規化して通る', async () => {
    const v = await validateWork(db(), form({ image_url: `${IMG}?t=sm`, image_page_url: PAGE }))
    expect(v).toMatchObject({
      ok: true,
      value: { imageUrl: IMG, imagePageUrl: PAGE, imageBlocked: 0 },
    })
  })

  it('片方だけ → 落ちる（どちら側でも）', async () => {
    for (const over of [{ image_url: IMG }, { image_page_url: PAGE }] as Record<string, string>[]) {
      const v = await validateWork(db(), form(over))
      expect(v).toEqual({ ok: false, errors: ['画像と画像の取得元は両方入れてください。'] })
    }
  })

  it('許可外 host・http・取得元が X → 落ちる', async () => {
    expect(
      await validateWork(
        db(),
        form({ image_url: 'http://static.escape.id/a.png', image_page_url: PAGE }),
      ),
    ).toEqual({ ok: false, errors: ['画像は https://static.escape.id/ の URL にしてください。'] })
    expect(
      await validateWork(db(), form({ image_url: IMG, image_page_url: 'https://x.com/a' })),
    ).toEqual({
      ok: false,
      errors: ['画像の取得元に escape.id のマイページと X（Twitter）の URL は使えません。'],
    })
  })

  it('載せない設定（image_blocked=1）で URL がある → 落ちる（agent の提案の経路）', async () => {
    const v = await validateWork(
      db(),
      form({ image_url: IMG, image_page_url: PAGE, image_blocked: '1' }),
    )
    expect(v).toEqual({
      ok: false,
      errors: ['画像を載せない設定です。画像の URL を空にしてください。'],
    })
    expect(await validateWork(db(), form({ image_blocked: '1' }))).toMatchObject({
      ok: true,
      value: { imageUrl: null, imagePageUrl: null, imageBlocked: 1 },
    })
  })

  it('image_blocked は 1 か空だけ', async () => {
    expect(await validateWork(db(), form({ image_blocked: '0' }))).toEqual({
      ok: false,
      errors: ['画像を載せないの値が正しくありません。'],
    })
  })

  it('団体が載せない設定で URL がある → 落ちる。URL が無ければ通る', async () => {
    const org = await insertOrg(env, { name: `載せない団体 ${crypto.randomUUID()}` })
    await setImage('organization', org, { image_blocked: 1 })
    expect(
      await validateWork(
        db(),
        form({ primary_organization_id: org, image_url: IMG, image_page_url: PAGE }),
      ),
    ).toEqual({ ok: false, errors: ['この団体は画像を載せない設定です。'] })
    expect(await validateWork(db(), form({ primary_organization_id: org }))).toMatchObject({
      ok: true,
      value: { primaryOrganizationId: org },
    })
  })

  it('統合済みの団体は従来どおり落ちる', async () => {
    const into = await insertOrg(env, { name: `統合先 ${crypto.randomUUID()}` })
    const merged = await insertOrg(env, {
      name: `統合済み ${crypto.randomUUID()}`,
      mergedIntoId: into,
    })
    expect(await validateWork(db(), form({ primary_organization_id: merged }))).toEqual({
      ok: false,
      errors: ['団体が見つからないか、統合済みです。'],
    })
  })
})

describe('validateOrg のロゴ', () => {
  const db = () => createDb(env.DB)
  const form = (over: Record<string, string>) => ({
    ...emptyForm(orgFields),
    name: 'ロゴの団体',
    ...over,
  })

  it('組で入れると通る。片方だけ・載せない設定で URL → 落ちる', async () => {
    expect(
      await validateOrg(db(), form({ logo_url: LOGO, logo_page_url: ORG_PAGE })),
    ).toMatchObject({
      ok: true,
      value: { logoUrl: LOGO, logoPageUrl: ORG_PAGE, imageBlocked: 0 },
    })
    expect(await validateOrg(db(), form({ logo_url: LOGO }))).toEqual({
      ok: false,
      errors: ['ロゴとロゴの取得元は両方入れてください。'],
    })
    expect(
      await validateOrg(
        db(),
        form({ logo_url: LOGO, logo_page_url: ORG_PAGE, image_blocked: '1' }),
      ),
    ).toEqual({ ok: false, errors: ['画像を載せない設定です。ロゴの URL を空にしてください。'] })
  })

  it('.svg・サブドメイン・userinfo のロゴ → 落ちる', async () => {
    for (const [logo, error] of [
      [
        'https://static.escape.id/o/a.svg',
        'ロゴは png / jpg / webp / gif の画像の URL にしてください。',
      ],
      [
        'https://a.static.escape.id/o/a.png',
        'ロゴは https://static.escape.id/ の URL にしてください。',
      ],
      [
        'https://u:p@static.escape.id/o/a.png',
        'ロゴは https://static.escape.id/ の URL にしてください。',
      ],
    ]) {
      expect(
        await validateOrg(db(), form({ logo_url: logo, logo_page_url: ORG_PAGE })),
        logo,
      ).toEqual({ ok: false, errors: [error] })
    }
  })
})

describe('オーナーの作品編集フォーム', () => {
  it('編集ページに画像の 2 項目と「画像を載せない」がある', async () => {
    const id = await insertWork(env, { title: `フォーム ${crypto.randomUUID()}` })
    await setImage('work', id, { image_url: IMG, image_page_url: PAGE })
    const html = await (await get(`/admin/works/${id}`, owner.cookie)).text()
    expect(html).toContain('name="image_url"')
    expect(html).toContain(`value="${IMG}"`)
    expect(html).toContain('name="image_page_url"')
    expect(html).toContain('name="image_blocked"')
    expect(html).toContain('画像を載せない')
  })

  it('URL を入れて保存 → 行と change_log に入る', async () => {
    const title = `画像を入れる ${crypto.randomUUID()}`
    const id = await insertWork(env, { title })
    const res = await post(
      `/admin/works/${id}`,
      { title, image_url: `${IMG}?t=md`, image_page_url: PAGE },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      image_url: IMG,
      image_page_url: PAGE,
    })
  })

  it('「画像を載せない」にチェックして保存 → URL が残っていても NULL になり change_log に残る', async () => {
    const title = `載せない作品 ${crypto.randomUUID()}`
    const id = await insertWork(env, { title })
    await setImage('work', id, { image_url: IMG, image_page_url: PAGE })
    const res = await post(
      `/admin/works/${id}`,
      { title, image_url: IMG, image_page_url: PAGE, image_blocked: '1' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(await workRow(id)).toEqual({ image_url: null, image_page_url: null, image_blocked: 1 })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('update')
    expect(JSON.parse(logs[0].before_json ?? '{}')).toMatchObject({
      image_url: IMG,
      image_blocked: 0,
    })
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      image_url: null,
      image_page_url: null,
      image_blocked: 1,
    })
    // 編集ページではチェックが付いたまま
    const html = await (await get(`/admin/works/${id}`, owner.cookie)).text()
    expect(html).toMatch(/name="image_blocked" value="1" checked/)
    // チェックを外して保存すると解除
    await post(`/admin/works/${id}`, { title }, owner.cookie)
    expect((await workRow(id))?.image_blocked).toBe(0)
  })

  it('団体が載せない設定の作品に URL を入れる → 400', async () => {
    const org = await insertOrg(env, { name: `載せない団体 ${crypto.randomUUID()}` })
    await setImage('organization', org, { image_blocked: 1 })
    const title = `団体が載せない ${crypto.randomUUID()}`
    const id = await insertWork(env, { title, orgId: org })
    const res = await post(
      `/admin/works/${id}`,
      { title, primary_organization_id: org, image_url: IMG, image_page_url: PAGE },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await errorsOf(res)).toEqual(['この団体は画像を載せない設定です。'])
    expect(await workRow(id)).toEqual({ image_url: null, image_page_url: null, image_blocked: 0 })
  })

  it('作成でも画像を入れられる。片方だけ → 400', async () => {
    const title = `新規の画像 ${crypto.randomUUID()}`
    const bad = await post('/admin/works/new', { title, image_url: IMG }, owner.cookie)
    expect(bad.status).toBe(400)
    expect(await errorsOf(bad)).toEqual(['画像と画像の取得元は両方入れてください。'])
    const res = await post(
      '/admin/works/new',
      { title, image_url: IMG, image_page_url: PAGE },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    const id = /\/admin\/works\/([^/?]+)/.exec(res.headers.get('location') ?? '')?.[1] ?? ''
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
  })
})

describe('オーナーの団体編集フォーム', () => {
  it('編集ページにロゴの 2 項目と「画像を載せない」がある', async () => {
    const id = await insertOrg(env, { name: `ロゴのフォーム ${crypto.randomUUID()}` })
    const html = await (await get(`/admin/orgs/${id}`, owner.cookie)).text()
    expect(html).toContain('name="logo_url"')
    expect(html).toContain('name="logo_page_url"')
    expect(html).toContain('name="image_blocked"')
  })

  it('「画像を載せない」にチェックして保存 → ロゴが NULL になり change_log に残る。作品側の URL は消さない', async () => {
    const name = `ロゴを止める ${crypto.randomUUID()}`
    const id = await insertOrg(env, { name })
    await setImage('organization', id, { logo_url: LOGO, logo_page_url: ORG_PAGE })
    const work = await insertWork(env, { title: `団体の作品 ${crypto.randomUUID()}`, orgId: id })
    await setImage('work', work, { image_url: IMG, image_page_url: PAGE })
    const res = await post(
      `/admin/orgs/${id}`,
      { name, logo_url: LOGO, logo_page_url: ORG_PAGE, image_blocked: '1' },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(await orgRow(id)).toEqual({ logo_url: null, logo_page_url: null, image_blocked: 1 })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      logo_url: null,
      logo_page_url: null,
      image_blocked: 1,
    })
    expect(await workRow(work)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
  })

  it('ロゴを入れて保存 → 行に入る。許可外 host → 400', async () => {
    const name = `ロゴを入れる ${crypto.randomUUID()}`
    const id = await insertOrg(env, { name })
    const bad = await post(
      `/admin/orgs/${id}`,
      { name, logo_url: 'https://example.com/logo.png', logo_page_url: ORG_PAGE },
      owner.cookie,
    )
    expect(bad.status).toBe(400)
    expect(await errorsOf(bad)).toEqual([
      'ロゴは https://static.escape.id/ の URL にしてください。',
    ])
    const res = await post(
      `/admin/orgs/${id}`,
      { name, logo_url: LOGO, logo_page_url: ORG_PAGE },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(await orgRow(id)).toEqual({ logo_url: LOGO, logo_page_url: ORG_PAGE, image_blocked: 0 })
  })
})

// ---- 変わっていない画像の値は検証し直さない

let token = ''
beforeAll(async () => {
  token = (await createToken(createDb(env.DB), 'master-image', 90)).token
})

const api = async (body: unknown) => {
  const res = await app.request(
    '/api/agent/proposals',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const pf = (field: string, newValue: string | null) => ({
  field,
  new_value: newValue,
  source_id: null,
  confidence: 0.95,
})

// 全項目を採用して承認する
const approveAll = async (proposalId: string) => {
  const rows = (
    await env.DB.prepare('SELECT id FROM proposal_field WHERE proposal_id = ?')
      .bind(proposalId)
      .all<{ id: string }>()
  ).results
  return post(
    `/admin/proposals/${proposalId}/approve`,
    Object.fromEntries(rows.map((r) => [`accept_${r.id}`, '1'])),
    owner.cookie,
  )
}

const titleOf = async (id: string) =>
  (await env.DB.prepare('SELECT title FROM work WHERE id = ?').bind(id).first<{ title: string }>())
    ?.title

// 画像つきの作品の団体を「画像を載せない」にした状態
const blockedOrgWork = async () => {
  const org = await insertOrg(env, { name: `止めた団体 ${crypto.randomUUID()}` })
  const title = `止めた団体の作品 ${crypto.randomUUID()}`
  const id = await insertWork(env, { title, orgId: org })
  await setImage('work', id, { image_url: IMG, image_page_url: PAGE })
  await setImage('organization', org, { image_blocked: 1 })
  return { org, id, title }
}

describe('変わっていない画像の値は検証し直さない', () => {
  it('(a) 団体を止めたあと、agent の work.title だけの update が 201 で通り、承認後も画像 3 列が保たれる', async () => {
    const { id } = await blockedOrgWork()
    const newTitle = `題名だけ変える ${crypto.randomUUID()}`
    const r = await api({
      kind: 'update',
      target_table: 'work',
      target_id: id,
      fields: [pf('work.title', newTitle)],
    })
    expect(r.status).toBe(201)
    expect((await approveAll(r.body.id as string)).status).toBe(302)
    expect(await titleOf(id)).toBe(newTitle)
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
  })

  it('(b) 同じ状態でオーナーの編集フォームから題名だけ変えて保存できる', async () => {
    const { org, id } = await blockedOrgWork()
    const newTitle = `フォームで題名だけ ${crypto.randomUUID()}`
    const res = await post(
      `/admin/works/${id}`,
      { title: newTitle, primary_organization_id: org, image_url: IMG, image_page_url: PAGE },
      owner.cookie,
    )
    expect(res.status).toBe(302)
    expect(await titleOf(id)).toBe(newTitle)
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
  })

  it('(c) 同じ状態で画像 URL を別の値に変えると従来のエラー。空にするのは通る', async () => {
    const { org, id, title } = await blockedOrgWork()
    const res = await post(
      `/admin/works/${id}`,
      {
        title,
        primary_organization_id: org,
        image_url: 'https://static.escape.id/i/o/takarush/other.png',
        image_page_url: PAGE,
      },
      owner.cookie,
    )
    expect(res.status).toBe(400)
    expect(await errorsOf(res)).toEqual(['この団体は画像を載せない設定です。'])
    const cleared = await post(
      `/admin/works/${id}`,
      { title, primary_organization_id: org },
      owner.cookie,
    )
    expect(cleared.status).toBe(302)
    expect(await workRow(id)).toEqual({ image_url: null, image_page_url: null, image_blocked: 0 })
  })

  it('(d) image_blocked=1 の作品への題名だけの update が通り、3 列が保たれる', async () => {
    const id = await insertWork(env, { title: `止めた作品 ${crypto.randomUUID()}` })
    await setImage('work', id, { image_blocked: 1 })
    const newTitle = `止めた作品の題名 ${crypto.randomUUID()}`
    const r = await api({
      kind: 'update',
      target_table: 'work',
      target_id: id,
      fields: [pf('work.title', newTitle)],
    })
    expect(r.status).toBe(201)
    expect((await approveAll(r.body.id as string)).status).toBe(302)
    expect(await titleOf(id)).toBe(newTitle)
    expect(await workRow(id)).toEqual({ image_url: null, image_page_url: null, image_blocked: 1 })
  })

  it('許可外 host のまま残った値も、変えなければ検証し直さない。変えると落ちる', async () => {
    const db = createDb(env.DB)
    const old = { url: 'https://old.example.com/a.png', pageUrl: PAGE }
    const form = {
      ...emptyForm(workFields),
      title: '古い画像の作品',
      image_url: old.url,
      image_page_url: PAGE,
    }
    expect(await validateWork(db, form, 'self', old)).toMatchObject({
      ok: true,
      value: { imageUrl: old.url, imagePageUrl: PAGE },
    })
    expect(await validateWork(db, form)).toEqual({
      ok: false,
      errors: ['画像は https://static.escape.id/ の URL にしてください。'],
    })
    expect(
      await validateWork(db, { ...form, image_page_url: 'https://escape.id/a-org/' }, 'self', old),
    ).toEqual({ ok: false, errors: ['画像は https://static.escape.id/ の URL にしてください。'] })
  })
})

describe('載せない設定で取得元だけ入っているとき', () => {
  it('作品・団体・作品の団体とも「取得元ページの URL も空に」と案内する', async () => {
    const db = createDb(env.DB)
    const msg = '画像を載せない設定です。取得元ページの URL も空にしてください。'
    expect(
      await validateWork(db, {
        ...emptyForm(workFields),
        title: '取得元だけ',
        image_page_url: PAGE,
        image_blocked: '1',
      }),
    ).toEqual({ ok: false, errors: [msg] })
    expect(
      await validateOrg(db, {
        ...emptyForm(orgFields),
        name: '取得元だけの団体',
        logo_page_url: ORG_PAGE,
        image_blocked: '1',
      }),
    ).toEqual({ ok: false, errors: [msg] })
    const org = await insertOrg(env, { name: `止めた団体 ${crypto.randomUUID()}` })
    await setImage('organization', org, { image_blocked: 1 })
    expect(
      await validateWork(db, {
        ...emptyForm(workFields),
        title: '団体が止めた作品の取得元だけ',
        primary_organization_id: org,
        image_page_url: PAGE,
      }),
    ).toEqual({ ok: false, errors: [msg] })
  })
})

describe('agent の画像の提案', () => {
  const getJson = async (path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const appliedOf = async (proposalId: string) =>
    JSON.parse(
      (
        await env.DB.prepare('SELECT applied_json FROM proposal WHERE id = ?')
          .bind(proposalId)
          .first<{ applied_json: string | null }>()
      )?.applied_json ?? '{}',
    ) as Record<string, string>

  it('work.image_url つきの create が 201。採用で行と change_log に入る', async () => {
    const r = await api({
      kind: 'create',
      target_table: 'work',
      fields: [
        pf('work.title', `画像つきの新作 ${crypto.randomUUID()}`),
        pf('work.image_url', `${IMG}?t=sm`),
        pf('work.image_page_url', PAGE),
      ],
    })
    expect(r.status).toBe(201)
    expect((await approveAll(r.body.id as string)).status).toBe(302)
    const id = (await appliedOf(r.body.id as string)).work
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
    const logs = await logsOf(id)
    expect(logs.map((l) => l.action)).toEqual(['create'])
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      image_url: IMG,
      image_page_url: PAGE,
    })
  })

  it('work の update が 201。採用で行と change_log に入る', async () => {
    const id = await insertWork(env, { title: `画像を足す ${crypto.randomUUID()}` })
    const r = await api({
      kind: 'update',
      target_table: 'work',
      target_id: id,
      fields: [pf('work.image_url', IMG), pf('work.image_page_url', PAGE)],
    })
    expect(r.status).toBe(201)
    expect((await approveAll(r.body.id as string)).status).toBe(302)
    expect(await workRow(id)).toEqual({ image_url: IMG, image_page_url: PAGE, image_blocked: 0 })
    const logs = await logsOf(id)
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].before_json ?? '{}')).toMatchObject({ image_url: null })
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      image_url: IMG,
      image_page_url: PAGE,
    })
  })

  it('organization のロゴの update が 201。採用で行と change_log に入る', async () => {
    const org = await insertOrg(env, { name: `ロゴを足す ${crypto.randomUUID()}` })
    const r = await api({
      kind: 'update',
      target_table: 'organization',
      target_id: org,
      fields: [pf('organization.logo_url', LOGO), pf('organization.logo_page_url', ORG_PAGE)],
    })
    expect(r.status).toBe(201)
    expect((await approveAll(r.body.id as string)).status).toBe(302)
    expect(await orgRow(org)).toEqual({ logo_url: LOGO, logo_page_url: ORG_PAGE, image_blocked: 0 })
    const logs = await logsOf(org)
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0].after_json ?? '{}')).toMatchObject({
      logo_url: LOGO,
      logo_page_url: ORG_PAGE,
    })
  })

  it('image_blocked は work / organization とも create・update で 400 unknown_field', async () => {
    const work = await insertWork(env, { title: `agent の対象 ${crypto.randomUUID()}` })
    const org = await insertOrg(env, { name: `agent の対象団体 ${crypto.randomUUID()}` })
    const cases: Record<string, unknown>[] = [
      {
        kind: 'update',
        target_table: 'work',
        target_id: work,
        fields: [pf('work.image_blocked', '1')],
      },
      {
        kind: 'create',
        target_table: 'work',
        fields: [pf('work.title', `新作 ${crypto.randomUUID()}`), pf('work.image_blocked', '1')],
      },
      {
        kind: 'update',
        target_table: 'organization',
        target_id: org,
        fields: [pf('organization.image_blocked', '1')],
      },
      {
        kind: 'create',
        target_table: 'organization',
        fields: [
          pf('organization.name', `新団体 ${crypto.randomUUID()}`),
          pf('organization.image_blocked', '1'),
        ],
      },
    ]
    for (const body of cases) {
      expect(await api(body), `${body.kind} ${body.target_table}`).toEqual({
        status: 400,
        body: { error: 'unknown_field' },
      })
    }
  })

  it('載せない設定の行への画像の update は 400 invalid_fields', async () => {
    const work = await insertWork(env, { title: `止めた作品 ${crypto.randomUUID()}` })
    await setImage('work', work, { image_blocked: 1 })
    expect(
      await api({
        kind: 'update',
        target_table: 'work',
        target_id: work,
        fields: [pf('work.image_url', IMG), pf('work.image_page_url', PAGE)],
      }),
    ).toEqual({
      status: 400,
      body: {
        error: 'invalid_fields',
        details: ['画像を載せない設定です。画像の URL を空にしてください。'],
      },
    })
    const org = await insertOrg(env, { name: `止めた団体 ${crypto.randomUUID()}` })
    await setImage('organization', org, { image_blocked: 1 })
    const r = await api({
      kind: 'update',
      target_table: 'organization',
      target_id: org,
      fields: [pf('organization.logo_url', LOGO), pf('organization.logo_page_url', ORG_PAGE)],
    })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('invalid_fields')
    expect(await orgRow(org)).toEqual({ logo_url: null, logo_page_url: null, image_blocked: 1 })
  })

  it('schema に画像の 4 項目と image_hosts が出る。image_blocked は出ない', async () => {
    const r = await getJson('/api/agent/schema')
    expect(r.status).toBe(200)
    const pfs = r.body.proposal_fields as Record<string, Record<string, string[]>>
    for (const kind of ['create', 'update']) {
      expect(pfs[kind].work).toEqual(
        expect.arrayContaining(['work.image_url', 'work.image_page_url']),
      )
      expect(pfs[kind].organization).toEqual(
        expect.arrayContaining(['organization.logo_url', 'organization.logo_page_url']),
      )
      expect(pfs[kind].work).not.toContain('work.image_blocked')
      expect(pfs[kind].organization).not.toContain('organization.image_blocked')
    }
    expect(r.body.image_hosts).toEqual(['static.escape.id'])
  })

  it('承認画面に新しい値と今の値のプレビューの <img>（no-referrer）が出る。許可外の値は文字だけ', async () => {
    const OLD = 'https://static.escape.id/i/o/takarush/old.png'
    const id = await insertWork(env, { title: `画像を替える ${crypto.randomUUID()}` })
    await setImage('work', id, { image_url: OLD, image_page_url: PAGE })
    const r = await api({
      kind: 'update',
      target_table: 'work',
      target_id: id,
      fields: [pf('work.image_url', IMG)],
    })
    expect(r.status).toBe(201)
    const html = await (await get(`/admin/proposals/${r.body.id}`, owner.cookie)).text()
    const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0])
    expect(imgs).toHaveLength(2)
    for (const [img, src] of [
      [imgs[0], OLD],
      [imgs[1], IMG],
    ]) {
      expect(img).toContain(`src="${src}"`)
      expect(img).toContain('referrerpolicy="no-referrer"')
      expect(img).toContain('loading="lazy"')
      expect(img).toContain('max-width:160px')
      expect(img).toContain('object-fit:contain')
    }
    expect(html).toContain('画像')

    // 今の値が許可外 host（古い値）なら <img> にしない
    const legacy = await insertWork(env, { title: `古い画像 ${crypto.randomUUID()}` })
    await setImage('work', legacy, {
      image_url: 'https://old.example.com/a.png',
      image_page_url: PAGE,
    })
    const r2 = await api({
      kind: 'update',
      target_table: 'work',
      target_id: legacy,
      fields: [pf('work.image_url', IMG)],
    })
    expect(r2.status).toBe(201)
    const html2 = await (await get(`/admin/proposals/${r2.body.id}`, owner.cookie)).text()
    expect(html2).toContain('https://old.example.com/a.png')
    expect([...html2.matchAll(/<img [^>]*>/g)].map((m) => m[0])).toEqual([
      expect.stringContaining(`src="${IMG}"`),
    ])
  })
})
