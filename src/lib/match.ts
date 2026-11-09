// 名寄せの純関数（docs/data-model.md §5）。DB を引く側は src/db/match.ts。

// 長さ 3 の部分文字列の集合（パディング無し）。3 文字未満は文字列そのもの 1 つ。長さはコードポイントで数える
export const trigrams = (s: string): Set<string> => {
  const cs = [...s]
  if (cs.length < 3) return new Set([s])
  const out = new Set<string>()
  for (let i = 0; i + 3 <= cs.length; i++) out.add(cs.slice(i, i + 3).join(''))
  return out
}

// Dice 係数 2|A∩B| / (|A|+|B|)
export const dice = (a: Set<string>, b: Set<string>): number => {
  if (a.size + b.size === 0) return 0
  let both = 0
  for (const x of a) if (b.has(x)) both++
  return (2 * both) / (a.size + b.size)
}

// 候補の下限（これ未満は「新規」扱い）
export const SIMILAR_MIN = 0.8
export const CANDIDATES_MAX = 10

export type Candidate = {
  id: string
  name: string
  score: number
  reason: string
  via: 'name' | 'alias'
  organization?: { id: string; name: string }
  // reason 'escape_id_url' のときだけ。一致した run
  runId?: string
}

// 同じ id は最大スコアだけ残し（同点は先に来た方）、降順で上位 CANDIDATES_MAX 件
export const rankCandidates = (cs: Candidate[]): Candidate[] => {
  const best = new Map<string, Candidate>()
  for (const c of cs) {
    const cur = best.get(c.id)
    if (!cur || c.score > cur.score) best.set(c.id, c)
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATES_MAX)
}

const URL_MAX = 2000

// escape.id の URL を run.escape_id_url と比べられる形にする（host 小文字、query / hash 除去、末尾 / 付与）。
// http(s) 以外・解釈できない・長すぎるものは null
export const normalizeMatchUrl = (raw: string): string | null => {
  if (raw.length > URL_MAX) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  u.search = ''
  u.hash = ''
  if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`
  // URL は host を小文字にして返す
  return u.toString()
}
