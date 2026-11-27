// 記録系テーブルを scopedTo 以外から読ませないための検査（docs/auth.md §6 実装上の規約）。
// src/**/*.{ts,tsx} で src/db/schema からの import / re-export に禁止語があり、許可リスト外なら exit 1。
// `import * as` と `export *` は全テーブルを持ち出せるので、許可リスト外なら名前に関係なく違反。
// ネタバレ部品（src/ui/spoiler.tsx の SpoilerFragment / SpoilerPage / spoilerHeaders）の import と、
// `as OwnAttempt` / `<OwnAttempt>` のキャスト（src/db/scoped.ts 以外）も違反。
// エクスポートの型（OwnExportAttempt / OwnExportWish。ネタバレメモを持ち得る）を src/ui/** から import するのも違反。
// フレンドの射影（vFriendAttempt）は許可リストのファイルでも src/db/scoped.ts 以外は違反。
// `import * as` / `export *` も許可リストのファイルでは src/db/client.ts 以外は違反（`s.vFriendAttempt` で読めるので）。
// 許可リスト外では、文字列中の生 SQL で FROM / JOIN / UPDATE / INTO の後ろに記録系の表名・ビュー名があっても違反。
// 生 SQL の v_friend_attempt は許可リストのファイルでも src/db/scoped.ts 以外は違反。
// 引数でルートを差し替えられる（test/check-scoped-negative.mjs が一時ディレクトリで陰性を確かめる）。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = join(root, 'src/db/schema')

const forbidden = new Set([
  'attempt',
  'attemptGenre',
  'session',
  'image',
  'wishlist',
  'marketVisit',
  'vAttemptEnriched',
  'vFriendAttempt',
])
// フレンドの射影は asFriendOf だけが読む。許可リスト（counts.ts など）でも import させない
const friendOnly = new Set(['vFriendAttempt'])
// 生 SQL で読み書きさせない表名・ビュー名（forbidden の各テーブルの SQL 上の名前）
const forbiddenSql = [
  'attempt',
  'attempt_genre',
  'session',
  'image',
  'wishlist',
  'market_visit',
  'v_attempt_enriched',
  'v_friend_attempt',
]
// FROM attempt / JOIN "session" / UPDATE `image` / INTO wishlist（大文字小文字は問わない）
const rawSqlRe = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+["\`\\[]?(${forbiddenSql.join('|')})(?![\\w$])`,
  'gi',
)
const rawFriendSqlRe = /\b(?:FROM|JOIN|UPDATE|INTO)\s+["`[]?v_friend_attempt(?![\w$])/i
const allowed = new Set([
  'src/db/scoped.ts',
  'src/db/counts.ts',
  'src/auth/account.ts',
  // 統合時の FK 付け替え（UPDATE / DELETE のみ。行を SELECT しない）
  'src/db/merge.ts',
  // drizzle に schema 全体を渡すため import * as schema が要る
  'src/db/client.ts',
])

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })

// 文字列リテラルは残し、// と /* */ のコメントだけを空白に置き換える
// （コメント内の import を拾わない・コメントで import 文を分断して検査をすり抜けさせない）
const stripComments = (src) => {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += ' '
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      out += ' '
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i++
    }
  }
  return out
}

// import { a, type b as c } from '…' / export { … } from '…'
const namedRe = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
// import * as X from '…' / export * from '…' / export * as X from '…'
const starRe = /\b(?:import|export)\s+(?:type\s+)?\*\s*(?:as\s+[\w$]+\s+)?from\s*['"]([^'"]+)['"]/g

const spoilerPath = join(root, 'src/ui/spoiler')

// ネタバレ本文を描く部品。spoilerResponse（OwnAttempt しか受けない）を通さずに本文を出せるので import 先を絞る
const spoilerParts = new Set(['SpoilerFragment', 'SpoilerPage', 'spoilerHeaders'])
const spoilerAllowed = new Set([
  'src/ui/spoiler.tsx',
  'src/routes/records.tsx',
  // 部品見本（モックの記録で OwnAttempt を作れない）
  'src/routes/gallery.tsx',
])

const scopedPath = join(root, 'src/db/scoped')

// エクスポートの型は src/lib/export.ts で直列化する。UI 部品に渡させない（#66）
const exportTypes = new Set(['OwnExportAttempt', 'OwnExportWish'])
const isUi = (rel) => rel.startsWith('src/ui/')

// OwnAttempt は own() だけが作る。キャストで作れないようにする
const ownCastRe = /\bas\s+OwnAttempt\b|<\s*OwnAttempt\s*>/

const resolvesTo = (file, spec, target) =>
  spec.startsWith('.') && resolve(dirname(file), spec).replace(/\.(ts|tsx|js)$/, '') === target

// target からの import / re-export。star は import * as / export *、names は名前付きの元の名前
const importsOf = (file, src, target) => {
  let star = false
  const names = []
  for (const m of src.matchAll(starRe)) {
    if (resolvesTo(file, m[1], target)) star = true
  }
  for (const m of src.matchAll(namedRe)) {
    if (!resolvesTo(file, m[2], target)) continue
    names.push(
      ...m[1]
        .split(',')
        .map(
          (s) =>
            s
              .trim()
              .replace(/^type\s+/, '')
              .split(/\s+as\s+/)[0],
        )
        .filter(Boolean),
    )
  }
  return { star, names }
}

const violations = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file)
  const src = stripComments(readFileSync(file, 'utf8'))
  if (!allowed.has(rel)) {
    const { star, names } = importsOf(file, src, schemaPath)
    if (star) violations.push(`${rel}: *（schema 全体）`)
    const hit = names.filter((n) => forbidden.has(n))
    if (hit.length > 0) violations.push(`${rel}: ${hit.join(', ')}`)
    const tables = [...new Set([...src.matchAll(rawSqlRe)].map((m) => m[1].toLowerCase()))]
    if (tables.length > 0) violations.push(`${rel}: 生 SQL の ${tables.join(', ')}`)
  } else {
    const { star, names } = importsOf(file, src, schemaPath)
    if (star && rel !== 'src/db/client.ts') {
      violations.push(`${rel}: *（schema 全体。名前付きで import する）`)
    }
    if (rel !== 'src/db/scoped.ts') {
      const hit = names.filter((n) => friendOnly.has(n))
      if (rawFriendSqlRe.test(src)) hit.push('生 SQL の v_friend_attempt')
      if (hit.length > 0) violations.push(`${rel}: ${hit.join(', ')}（asFriendOf だけが読む）`)
    }
  }
  if (!spoilerAllowed.has(rel)) {
    const { star, names } = importsOf(file, src, spoilerPath)
    if (star) violations.push(`${rel}: *（ネタバレ部品）`)
    const hit = names.filter((n) => spoilerParts.has(n))
    if (hit.length > 0) violations.push(`${rel}: ${hit.join(', ')}（spoilerResponse を使う）`)
  }
  if (isUi(rel)) {
    const { star, names } = importsOf(file, src, scopedPath)
    if (star) violations.push(`${rel}: *（scoped 全体。エクスポートの型を持ち出せる）`)
    const hit = names.filter((n) => exportTypes.has(n))
    if (hit.length > 0)
      violations.push(`${rel}: ${hit.join(', ')}（src/lib/export.ts で直列化する）`)
  }
  if (rel !== 'src/db/scoped.ts' && ownCastRe.test(src)) {
    violations.push(`${rel}: OwnAttempt へのキャスト（own().getAttempt() から得る）`)
  }
}

if (violations.length > 0) {
  console.error('記録系テーブル・ネタバレ部品は src/db/scoped.ts（scopedTo）経由で使ってください:')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log('check:scoped ok')
