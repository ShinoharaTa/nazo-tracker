// ツールの戻り値の組み立て。読むのは LLM なので、本文は詰めた JSON、エラーは API のコードと次の手を 1 行。

import { ApiError } from '../client.js'

export const result = (text: string, structured: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  structuredContent: structured,
})

export const json = (v: unknown) => JSON.stringify(v)

export const errorText = (text: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text }],
})

// API の error コードごとの次の手。無いコードは既定の 1 行
const HINTS: Record<string, string> = {
  invalid_token:
    'トークンが無効か期限切れです。/admin/tokens で発行し直し、agent.env の NAZO_AGENT_TOKEN を差し替えてから MCP サーバーを再起動してください。',
  insufficient_scope:
    'トークンに required の scope がありません。/admin/tokens で発行し直してください。',
  rate_limited: '60 秒ほど待ってから呼び直してください。',
  forbidden: 'この API は agent からは呼べません（承認・記録系などは MCP に無い）。',
  not_found: 'id を確かめてください（一覧のツールで引き直す）。',
  invalid_status:
    '状態の値は get_schema の request_statuses / proposal_statuses から選んでください。',
  invalid_table: 'table の値を確かめてください。',
  invalid_part: 'part の値を確かめてください。',
  title_or_url_required: 'title か url のどちらかを渡してください。',
  invalid_url: 'url は http(s) の URL を渡してください。',
  invalid_after: 'after には前回の結果の next をそのまま渡してください。',
  invalid_request_id: 'request_id は空にせず、使わないときは省いてください。',
  timeout: '応答が 20 秒以内に返りませんでした。少し待って呼び直してください。',
  network_error: '接続先に届きませんでした。接続先と回線を確かめてください。',
  redirect: '接続先（NAZO_AGENT_BASE_URL）を確かめてください（リダイレクトには従っていません）。',
  invalid_token_format:
    'トークンに改行・空白・非 ASCII の文字が入っていて送れません。agent.env の値を確かめてください。',
  invalid_response:
    '応答が JSON ではありませんでした。接続先（NAZO_AGENT_BASE_URL）を確かめてください。',
}

const DEFAULT_HINT = '本文の error と項目を見て、入力を直してから呼び直してください。'

export const apiErrorResult = (e: unknown) => {
  if (!(e instanceof ApiError)) {
    // 想定外の例外。文言にトークンが混ざる経路は無いが、念のため種類だけを返す
    return errorText(`エラー: 想定外の失敗（${e instanceof Error ? e.name : typeof e}）`)
  }
  const lines = [`エラー: ${e.message}`]
  if (e.body) lines.push(`本文: ${json(e.body)}`)
  lines.push(`次の手: ${HINTS[e.code] ?? DEFAULT_HINT}`)
  return errorText(lines.join('\n'))
}

export const encodeId = (id: string) => encodeURIComponent(id.trim())
