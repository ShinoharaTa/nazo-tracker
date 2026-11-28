#!/usr/bin/env node
// nazo-tracker の agent API を呼ぶ MCP サーバー（stdio。何も listen しない）。
//
// 起動（Claude Code への登録は mcp/README.md）:
//   source ~/.nvm/nvm.sh && npx tsx src/server.ts
//
// 設定: ~/.config/nazo-tracker/agent.env（mode 0600）に NAZO_AGENT_TOKEN=...、任意で NAZO_AGENT_BASE_URL=...
//       別のファイルを使うときだけ環境変数 NAZO_AGENT_ENV_FILE にそのパスを入れる

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './app.js'
import { loadConfig } from './config.js'

const config = loadConfig()
const server = buildServer(config)

// stdio が転送路なので、ログは stderr にだけ書く。トークンは書かない
process.on('unhandledRejection', (e) => {
  console.error('[nazo-mcp] unhandled rejection:', e instanceof Error ? e.name : typeof e)
})

await server.connect(new StdioServerTransport())
console.error(
  config.ok
    ? `[nazo-mcp] stdio server ready (接続先: ${new URL(config.config.baseUrl).host})`
    : `[nazo-mcp] stdio server ready（設定エラーのため全ツールがエラーを返す: ${config.message}）`,
)
