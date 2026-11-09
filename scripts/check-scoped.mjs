// 記録系テーブルを scopedTo 以外から読ませないための検査（docs/auth.md §6 実装上の規約）。
// src/**/*.{ts,tsx} で src/db/schema からの named import に禁止語があり、許可リスト外なら exit 1。

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
const allowed = new Set(['src/db/scoped.ts', 'src/db/counts.ts', 'src/auth/account.ts'])

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })

const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g

const violations = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file)
  if (allowed.has(rel)) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(importRe)) {
    if (!m[2].startsWith('.')) continue
    if (resolve(dirname(file), m[2]).replace(/\.ts$/, '') !== schemaPath) continue
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
