// 記録系テーブルを scopedTo 以外から読ませないための検査（docs/auth.md §6 実装上の規約）。
// src/**/*.{ts,tsx} で src/db/schema からの import / re-export に禁止語があり、許可リスト外なら exit 1。
// `import * as` と `export *` は全テーブルを持ち出せるので、許可リスト外なら名前に関係なく違反。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = join(root, 'src/db/schema')

const forbidden = new Set([
  'attempt',
  'attemptGenre',
  'session',
  'image',
  'wishlist',
  'marketVisit',
])
const allowed = new Set([
  'src/db/scoped.ts',
  'src/db/counts.ts',
  'src/auth/account.ts',
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

const isSchema = (file, spec) =>
  spec.startsWith('.') && resolve(dirname(file), spec).replace(/\.(ts|js)$/, '') === schemaPath

const violations = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file)
  if (allowed.has(rel)) continue
  const src = stripComments(readFileSync(file, 'utf8'))
  for (const m of src.matchAll(starRe)) {
    if (isSchema(file, m[1])) violations.push(`${rel}: *（schema 全体）`)
  }
  for (const m of src.matchAll(namedRe)) {
    if (!isSchema(file, m[2])) continue
    const names = m[1]
      .split(',')
      .map(
        (s) =>
          s
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0],
      )
      .filter(Boolean)
    const hit = names.filter((n) => forbidden.has(n))
    if (hit.length > 0) violations.push(`${rel}: ${hit.join(', ')}`)
  }
}

if (violations.length > 0) {
  console.error('記録系テーブルは src/db/scoped.ts（scopedTo）経由で読んでください:')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log('check:scoped ok')
