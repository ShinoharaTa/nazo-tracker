// テスト用の偽 API（127.0.0.1 の空きポート）と一時の agent.env。本番にも実ファイルの agent.env にも触れない。

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

// 本物のトークンと同じ形の偽物。全出力にこの文字列が無いことを確かめる
export const TOKEN = 'nzt_TEST-secret-0123456789abcdefXYZ'

export type Call = {
  method: string
  path: string
  query: URLSearchParams
  auth: string | undefined
  body: unknown
}

// hang: 何も返さない。stall: ヘッダと本文の頭だけ返して止める。raw: 本文をそのまま（壊れた JSON 用）
export type Reply =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | { status: number; raw: string }
  | 'hang'
  | 'stall'
export type Handler = (call: Call) => Reply

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => {
      s += c
    })
    req.on('end', () => resolve(s))
  })

export const startFake = async (handler: Handler) => {
  const calls: Call[] = []
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const raw = await readBody(req)
    const call: Call = {
      method: req.method ?? '',
      path: u.pathname,
      query: u.searchParams,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    }
    calls.push(call)
    const r = handler(call)
    if (r === 'hang') return
    if (r === 'stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"items":')
      return
    }
    if ('raw' in r) {
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(r.raw)
      return
    }
    res.writeHead(r.status, { 'Content-Type': 'application/json', ...r.headers })
    res.end(JSON.stringify(r.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// 一時ディレクトリに agent.env を書く。mode は既定 0600
export const tmpEnv = (content: string, mode = 0o600) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nazo-mcp-test-'))
  const file = path.join(dir, 'agent.env')
  writeFileSync(file, content)
  chmodSync(file, mode)
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
