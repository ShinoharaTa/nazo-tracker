import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_BASE_URL, loadConfig, parseBaseUrl, parseEnv } from '../src/config.js'
import { TOKEN, tmpEnv } from './helpers.js'

const load = (content: string, mode?: number) => {
  const env = tmpEnv(content, mode)
  try {
    return { ...loadConfig({ NAZO_AGENT_ENV_FILE: env.file }), file: env.file }
  } finally {
    env.cleanup()
  }
}

test('0600 ならトークンを読み、接続先の既定は本番', () => {
  const r = load(`NAZO_AGENT_TOKEN=${TOKEN}\n`)
  assert.ok(r.ok)
  assert.equal(r.config.token, TOKEN)
  assert.equal(r.config.baseUrl, DEFAULT_BASE_URL)
})

for (const mode of [0o640, 0o644, 0o604, 0o660, 0o666, 0o700 | 0o004]) {
  test(`mode ${mode.toString(8)} は使わず chmod 600 を促す（トークンは文言に出ない）`, () => {
    const r = load(`NAZO_AGENT_TOKEN=${TOKEN}\n`, mode)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.message.includes('chmod 600'))
    assert.ok(!r.ok && !r.message.includes(TOKEN))
  })
}

test('0400 は使える（group / other に権限が無い）', () => {
  assert.ok(load(`NAZO_AGENT_TOKEN=${TOKEN}\n`, 0o400).ok)
})

test('ファイルが無い・トークンが無いとエラー', () => {
  const missing = loadConfig({ NAZO_AGENT_ENV_FILE: '/nonexistent/nazo/agent.env' })
  assert.equal(missing.ok, false)
  const empty = load('# comment only\n')
  assert.ok(!empty.ok && empty.message.includes('NAZO_AGENT_TOKEN'))
})

test('NAZO_AGENT_BASE_URL: https と 127.0.0.1 / localhost の http だけ', () => {
  assert.equal(parseBaseUrl('https://example.com/x/y'), 'https://example.com')
  assert.equal(parseBaseUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787')
  assert.equal(parseBaseUrl('http://localhost:8787'), 'http://localhost:8787')
  assert.equal(parseBaseUrl('http://nazo.shino3.net'), null)
  assert.equal(parseBaseUrl('http://10.1.111.70:8787'), null)
  assert.equal(parseBaseUrl('http://127.0.0.1.example.com'), null)
  assert.equal(parseBaseUrl('ftp://127.0.0.1'), null)
  assert.equal(parseBaseUrl('https://u:p@example.com'), null)
  assert.equal(parseBaseUrl('not a url'), null)

  const bad = load(`NAZO_AGENT_TOKEN=${TOKEN}\nNAZO_AGENT_BASE_URL=http://example.com\n`)
  assert.ok(!bad.ok && !bad.message.includes(TOKEN))
  const local = load(`NAZO_AGENT_TOKEN=${TOKEN}\nNAZO_AGENT_BASE_URL=http://127.0.0.1:8787\n`)
  assert.ok(local.ok && local.config.baseUrl === 'http://127.0.0.1:8787')
})

test('parseEnv: コメント・export・引用符', () => {
  assert.deepEqual(parseEnv(`# x\n\nexport A=1\nB = "two"\nC='3'\nbroken line\nD=a=b\n`), {
    A: '1',
    B: 'two',
    C: '3',
    D: 'a=b',
  })
})

test('parseEnv: 値の後ろの「空白 + #」はコメント。引用符の中の # は値', () => {
  assert.deepEqual(
    parseEnv(
      [
        'A=abc # コメント',
        'B=abc#def',
        'C="x # y" # コメント',
        "D='q' #c",
        'E=  v\t# tab の後ろ',
        'F=#only',
      ].join('\n'),
    ),
    { A: 'abc', B: 'abc#def', C: 'x # y', D: 'q', E: 'v', F: '#only' },
  )
  const r = load(`NAZO_AGENT_TOKEN=${TOKEN} # 発行日 2026-11-28\n`)
  assert.ok(r.ok && r.config.token === TOKEN)
})

test('所有者が実行ユーザーと違えば使わない', () => {
  const env = tmpEnv(`NAZO_AGENT_TOKEN=${TOKEN}\n`)
  try {
    const uid = process.getuid?.() ?? 0
    const r = loadConfig({ NAZO_AGENT_ENV_FILE: env.file }, uid + 1)
    assert.ok(!r.ok && r.message.includes('所有者を確かめてください'))
    assert.ok(!r.ok && !r.message.includes(TOKEN))
    assert.ok(loadConfig({ NAZO_AGENT_ENV_FILE: env.file }, uid).ok)
  } finally {
    env.cleanup()
  }
})

test('トークンは環境変数からは読まない', () => {
  const env = tmpEnv('# no token\n')
  try {
    const r = loadConfig({ NAZO_AGENT_ENV_FILE: env.file, NAZO_AGENT_TOKEN: TOKEN })
    assert.equal(r.ok, false)
  } finally {
    env.cleanup()
  }
})
