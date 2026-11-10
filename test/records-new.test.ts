import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import app from '../src/index'
import { loginAs } from './helpers/auth'
import { insertOrg, insertWork } from './helpers/master'

let cookie = ''
const ids: Record<string, string> = {}

beforeAll(async () => {
  cookie = (await loginAs(env, { subject: 'records-new-test' })).cookie
  const org = await insertOrg(env, { name: '記録選択テスト団' })
  ids.work = await insertWork(env, { title: 'ピッカー検証の謎', kind: 'room', orgId: org })
})

// ログイン済みで GET する
const get = (path: string) => app.request(path, { headers: { Cookie: cookie } }, env)

describe('GET /records/new（作品選択・仮）', () => {
  it('未ログインは /login へ 302', async () => {
    const res = await app.request('/records/new', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login')
  })

  it('q 無しは検索の案内を出す', async () => {
    const res = await get('/records/new')
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('作品名か団体名で検索してください')
    expect(h).toContain('action="/records/new"')
    expect(h).toContain('記録の保存は次の段階で入ります')
    expect(h).not.toContain('作品マスタは P2 で入ります')
  })

  it('q ありは一致した作品を作品ページへのリンクで出す', async () => {
    const res = await get(`/records/new?q=${encodeURIComponent('ピッカー')}`)
    expect(res.status).toBe(200)
    const h = await res.text()
    expect(h).toContain('ピッカー検証の謎')
    expect(h).toContain(`href="/works/${ids.work}"`)
  })

  it('0 件は一致なしの文言', async () => {
    const res = await get(`/records/new?q=${encodeURIComponent('存在しない作品名zzz')}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('「存在しない作品名zzz」に一致する作品はありません')
  })
})
