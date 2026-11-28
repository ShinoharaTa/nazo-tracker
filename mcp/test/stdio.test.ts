// server.ts を子プロセスで起動し、stdio 越しに呼ぶ。stderr も含めてトークンが出ないことを確かめる。
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startFake, TOKEN, tmpEnv } from './helpers.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const serverTs = path.join(root, 'src', 'server.ts')

const run = async (envFile: string, calls: [string, Record<string, unknown>][]) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsx, serverTs],
    // 実ファイルの agent.env を読ませない（NAZO_AGENT_ENV_FILE は必ず一時ファイル）
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', NAZO_AGENT_ENV_FILE: envFile },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (d) => {
    stderr += String(d)
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(transport)
  const outputs: string[] = []
  try {
    const { tools } = await client.listTools()
    outputs.push(JSON.stringify(tools))
    for (const [name, args] of calls) {
      outputs.push(JSON.stringify(await client.callTool({ name, arguments: args })))
    }
  } finally {
    await client.close()
  }
  return { outputs, stderr }
}

const CALLS: [string, Record<string, unknown>][] = [
  ['whoami', {}],
  ['get_schema', {}],
  ['list_requests', {}],
  ['get_request', { id: 'r1' }],
  ['match', { title: 't' }],
  ['search_master', { table: 'organization', query: 'x' }],
  ['get_row', { table: 'venue', id: 'v1' }],
  ['list_proposals', {}],
  ['get_proposal', { id: 'p1' }],
]

test('stdio: 成功・API エラー・接続失敗のどれでも、出力と stderr にトークンが無い', async () => {
  let n = 0
  // 成功と 401 / 500 を交互に返す
  const fake = await startFake(() => {
    n++
    if (n % 3 === 0) return { status: 401, body: { error: 'invalid_token' } }
    if (n % 3 === 1) return { status: 500, body: { error: 'internal' } }
    return { status: 200, body: { items: [], next: null, name: 'agent', expires_at: null } }
  })
  const env = tmpEnv(`NAZO_AGENT_TOKEN=${TOKEN}\nNAZO_AGENT_BASE_URL=${fake.url}\n`)
  try {
    const r = await run(env.file, CALLS)
    assert.ok(fake.calls.length >= CALLS.length)
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${TOKEN}`))
    assert.ok(r.stderr.includes('stdio server ready'))
    for (const o of [...r.outputs, r.stderr]) assert.ok(!o.includes(TOKEN))

    // 接続先が落ちている
    await fake.close()
    const down = await run(env.file, CALLS)
    assert.ok(down.outputs.slice(1).every((o) => o.includes('network_error')))
    for (const o of [...down.outputs, down.stderr]) assert.ok(!o.includes(TOKEN))
  } finally {
    env.cleanup()
    await fake.close().catch(() => {})
  }
})

test('stdio: mode 0644 なら全ツールが chmod 600 のエラー（トークンは出ない）', async () => {
  const env = tmpEnv(`NAZO_AGENT_TOKEN=${TOKEN}\n`, 0o644)
  try {
    const r = await run(env.file, CALLS)
    assert.ok(
      r.outputs.slice(1).every((o) => o.includes('chmod 600') && o.includes('"isError":true')),
    )
    for (const o of [...r.outputs, r.stderr]) assert.ok(!o.includes(TOKEN))
  } finally {
    env.cleanup()
  }
})
