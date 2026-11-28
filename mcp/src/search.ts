// search_master の中身。/index/:table（名前と別名）を全頁引いて、手元で部分一致・近い名前を探す。
// 正規化は Worker と同じ src/lib/norm.ts を使う（name_norm / title_norm と同じ規則）。

import { norm } from '../../src/lib/norm.js'
import type { ApiClient } from './client.js'

export const searchTables = ['work', 'organization', 'venue'] as const
export type SearchTable = (typeof searchTables)[number]

// /index の 1 頁の件数（API の上限）と、頁送りの上限（取りすぎ・止まらない next の歯止め）
const PAGE_LIMIT = 1000
const MAX_PAGES = 50
// 近い名前として出す下限（文字 bigram の Dice 係数）
const SIMILAR_MIN = 0.5

export type SearchHit = {
  table: SearchTable
  id: string
  name: string
  // 当たったのが別名のときの別名
  alias: string | null
  score: number
  reason: string
  org_id?: string | null
  prefecture?: string | null
}

type IndexRow = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const fetchAll = async (client: ApiClient, table: SearchTable, part: 'name' | 'alias') => {
  const rows: IndexRow[] = []
  let after: string | undefined
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await client.get(`/index/${table}`, { part, limit: PAGE_LIMIT, after })
    if (Array.isArray(r.items)) rows.push(...(r.items as IndexRow[]))
    const next = str(r.next)
    if (!next) return { rows, truncated: false }
    after = next
  }
  return { rows, truncated: true }
}

const bigrams = (s: string): string[] => {
  const cs = [...s]
  if (cs.length < 2) return cs
  return cs.slice(0, -1).map((c, i) => c + cs[i + 1])
}

// 文字 bigram の Dice 係数（0〜1）
export const similarity = (a: string, b: string): number => {
  const x = bigrams(a)
  const y = bigrams(b)
  if (x.length === 0 || y.length === 0) return 0
  const rest = [...y]
  let hit = 0
  for (const g of x) {
    const i = rest.indexOf(g)
    if (i >= 0) {
      hit++
      rest.splice(i, 1)
    }
  }
  return (2 * hit) / (x.length + y.length)
}

// 正規化した名前どうしの点と理由。当たらなければ null
export const scoreOf = (q: string, n: string): { score: number; kind: string } | null => {
  if (!q || !n) return null
  if (n === q) return { score: 1, kind: 'exact' }
  if (n.includes(q) || q.includes(n)) {
    const [s, l] = n.length < q.length ? [n, q] : [q, n]
    return {
      score: Math.round((0.7 + 0.25 * ([...s].length / [...l].length)) * 100) / 100,
      kind: 'partial',
    }
  }
  const sim = similarity(q, n)
  if (sim >= SIMILAR_MIN) return { score: Math.round(sim * 0.7 * 100) / 100, kind: 'similar' }
  return null
}

export const searchMaster = async (
  client: ApiClient,
  table: SearchTable,
  query: string,
  limit: number,
): Promise<{ query_norm: string; items: SearchHit[]; truncated: boolean }> => {
  const q = norm(query)
  const nameCol = table === 'work' ? 'title' : 'name'
  const normCol = table === 'work' ? 'title_norm' : 'name_norm'
  const idCol = table === 'work' ? 'work_id' : table === 'organization' ? 'organization_id' : 'id'

  const names = await fetchAll(client, table, 'name')
  const aliases =
    table === 'venue' ? { rows: [], truncated: false } : await fetchAll(client, table, 'alias')

  // 主名（id → 行）。別名の行に主名を添えるのに使う
  const main = new Map<string, IndexRow>()
  for (const r of names.rows) {
    const id = str(r[idCol])
    if (id) main.set(id, r)
  }

  const best = new Map<string, SearchHit>()
  const consider = (r: IndexRow, isAlias: boolean) => {
    const id = str(r[idCol])
    const text = str(r[nameCol])
    if (!id || !text) return
    const s = scoreOf(q, str(r[normCol]) ?? norm(text))
    if (!s) return
    const prev = best.get(id)
    if (prev && prev.score >= s.score) return
    const m = isAlias ? main.get(id) : r
    const hit: SearchHit = {
      table,
      id,
      name: (m && str(m[nameCol])) ?? text,
      alias: isAlias ? text : null,
      score: s.score,
      reason: `${isAlias ? 'alias' : 'name'}_${s.kind}`,
    }
    if (table === 'work') hit.org_id = str(r.org_id)
    if (table === 'venue') hit.prefecture = str(r.prefecture)
    best.set(id, hit)
  }
  for (const r of names.rows) consider(r, false)
  for (const r of aliases.rows) consider(r, true)

  const items = [...best.values()]
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
  return { query_norm: q, items, truncated: names.truncated || aliases.truncated }
}
