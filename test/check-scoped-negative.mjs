// scripts/check-scoped.mjs の陰性テスト（npm run lint から呼ぶ）。
// Workers の vitest pool では子プロセスもファイル書き込みも使えないので、node で動く別スクリプトにしている。
// 一時ディレクトリに src/ を作り、違反ごとに check-scoped を走らせて exit 1 になることを確かめる。

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-scoped.mjs')

// files: { 'src/…': 本文 }。src/db/schema.ts は空で置く（import 先の解決に要るだけ）
const run = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'check-scoped-'))
  try {
    for (const [path, body] of Object.entries({ 'src/db/schema.ts': '', ...files })) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), body)
    }
    return spawnSync(process.execPath, [script, dir], { encoding: 'utf8' }).status
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const cases = [
  // [名前, files, 期待する exit code]
  [
    '名前付き import（許可リスト外）',
    { 'src/routes/x.ts': "import { attempt } from '../db/schema'" },
    1,
  ],
  ['star import（許可リスト外）', { 'src/routes/x.ts': "import * as s from '../db/schema'" }, 1],
  [
    'star import（許可リストの counts.ts）',
    { 'src/db/counts.ts': "import * as s from './schema'" },
    1,
  ],
  [
    'star import（許可リストの scoped.ts）',
    { 'src/db/scoped.ts': "import * as s from './schema'" },
    1,
  ],
  ['export *（許可リストの merge.ts）', { 'src/db/merge.ts': "export * from './schema'" }, 1],
  [
    'vFriendAttempt（許可リストの counts.ts）',
    { 'src/db/counts.ts': "import { vFriendAttempt } from './schema'" },
    1,
  ],
  [
    '生 SQL: FROM v_friend_attempt',
    { 'src/db/x.ts': 'const q = sql`SELECT * FROM v_friend_attempt`' },
    1,
  ],
  [
    '生 SQL: JOIN v_attempt_enriched',
    { 'src/db/x.ts': 'const q = sql`SELECT 1 FROM work w JOIN v_attempt_enriched a ON 1`' },
    1,
  ],
  [
    '生 SQL: from "attempt"（小文字・引用符付き）',
    { 'src/db/x.ts': `const q = 'select * from "attempt"'` },
    1,
  ],
  ['生 SQL: UPDATE session', { 'src/db/x.ts': "db.prepare('UPDATE session SET memo = ?')" }, 1],
  [
    '生 SQL: INSERT INTO wishlist',
    { 'src/db/x.ts': 'sql`INSERT INTO wishlist (user_id) VALUES (1)`' },
    1,
  ],
  ['生 SQL: DELETE FROM image', { 'src/db/x.ts': 'sql`DELETE FROM image WHERE 1`' }, 1],
  [
    '生 SQL: JOIN attempt_genre',
    { 'src/db/x.ts': 'sql`SELECT 1 FROM work JOIN attempt_genre g`' },
    1,
  ],
  [
    '生 SQL: FROM v_friend_attempt（許可リストの counts.ts）',
    { 'src/db/counts.ts': 'const q = sql`SELECT COUNT(*) FROM v_friend_attempt f`' },
    1,
  ],
  ['生 SQL: FROM market_visit', { 'src/db/x.ts': 'sql`SELECT * FROM market_visit`' }, 1],
  // 陽性の対照: フレンド系・user の生 SQL、client.ts の star import、コメント中の SQL は通る
  [
    '対照: friend_request / friendship / block / user / session_token',
    {
      'src/db/friends.ts': [
        'sql`SELECT r.id FROM friend_request r JOIN user u ON u.id = r.from_user_id`',
        'sql`DELETE FROM friendship WHERE 1`',
        'sql`INSERT OR IGNORE INTO block (user_id) SELECT 1`',
        'sql`UPDATE user SET friend_code = NULL`',
        'sql`DELETE FROM session_token WHERE 1`',
        'sql`SELECT * FROM attempts_log`',
        '// SELECT * FROM attempt',
      ].join('\n'),
      'src/db/client.ts': "import * as schema from './schema'",
      'src/db/scoped.ts': "import { attempt, vFriendAttempt } from './schema'\nsql`FROM attempt`",
      'src/db/counts.ts': "import { attempt } from './schema'\nsql`FROM attempt a`",
    },
    0,
  ],
]

let failed = 0
for (const [name, files, want] of cases) {
  const got = run(files)
  if (got !== want) {
    failed++
    console.error(`NG ${name}: exit ${got}（期待 ${want}）`)
  }
}
if (failed > 0) process.exit(1)
console.log(`check:scoped negative ok（${cases.length} 件）`)
