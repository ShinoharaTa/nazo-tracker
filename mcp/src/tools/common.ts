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
  invalid_response:
    '応答が JSON ではありませんでした。接続先（NAZO_AGENT_BASE_URL）を確かめてください。',
  // 書き込み（POST / PATCH）
  duplicate_pending:
    '同じ内容の提案が既に pending です（proposal_id）。新しく出さず get_proposal で確かめてください。',
  suppressed: '同じ内容の提案は却下済みです（reason）。再提案しないでください。',
  duplicate_escape_id_url:
    '同じ escape.id URL の回が既にあります（run_id / work_id）。create ではなく既存の行を使ってください。',
  invalid_fields: 'details の項目ごとのエラーを見て値を直してください。',
  unknown_field:
    '項目名は get_schema の proposal_fields（kind × target_table）にあるものだけ使えます。',
  duplicate_field: '同じ項目を 2 回入れないでください。',
  invalid_placeholder:
    '@<表> は get_schema の placeholders の列だけで、その表の項目が同じ束にあるときだけ使えます。',
  invalid_candidates:
    'match_candidates は最大 20 件、table は work / organization / venue、score は 0〜1、reason は 40 文字までです。',
  invalid_confidence: 'confidence は 0〜1 の数にしてください。',
  no_change: '今の値と同じなので提案は要りません。',
  source_not_found: 'source_id には add_source が返した id を入れてください。',
  target_not_found: 'target_id を確かめてください（match / search_master / get_row）。',
  target_merged: '対象は統合済みです。get_row の merged_into_id の行を対象にしてください。',
  request_not_found: 'request_id を確かめてください。',
  request_not_processing: '先に set_request_status で processing にしてから提案してください。',
  no_pending_proposal:
    'このリクエストに pending の提案がありません。create_proposal で出してから proposed にしてください。',
  invalid_transition:
    'from の状態から to には変えられません。get_request で今の状態を確かめてください。',
  question_required: 'needs_info には question（依頼者への質問）が要ります。',
  question_too_long: 'question は 1000 文字までです。',
  note_too_long: 'note は 2000 文字までです。',
  forbidden_source: 'x.com / twitter.com / t.co と escape.id の /me/ は出典にできません。',
  method_host_mismatch: 'method escape_mcp は escape.id の URL だけに使えます。',
  invalid_method: 'method は get_schema の source_methods から選んでください。',
  robots_not_checked:
    'webfetch は robots.txt で許可を確かめ、robots_checked: true にしてください。',
  invalid_fetched_at:
    'fetched_at はタイムゾーン付きの ISO 8601（例: 2026-11-28T12:00:00Z）にしてください。',
  invalid_content_hash: 'content_hash は SHA-256 の 16 進 64 文字にしてください。',
  excerpt_too_long: 'excerpt は 500 文字までです。',
  too_large: '本文が 64 KiB を超えています。項目を減らしてください。',
}

// 書き込みは再試行しない。応答が無いか 5xx のときは、届いたかどうかが分からない
const WRITE_UNKNOWN_HINT =
  '書き込みは自動で再試行していません。届いている可能性があるので、list_proposals / get_request で確かめてから出し直してください。'

const DEFAULT_HINT = '本文の error と項目を見て、入力を直してから呼び直してください。'

export const apiErrorResult = (e: unknown, write = false) => {
  if (!(e instanceof ApiError)) {
    // 想定外の例外。文言にトークンが混ざる経路は無いが、念のため種類だけを返す
    return errorText(`エラー: 想定外の失敗（${e instanceof Error ? e.name : typeof e}）`)
  }
  const lines = [`エラー: ${e.message}`]
  if (e.body) lines.push(`本文: ${json(e.body)}`)
  const unknown = write && (e.status === 0 || e.status >= 500)
  lines.push(`次の手: ${unknown ? WRITE_UNKNOWN_HINT : (HINTS[e.code] ?? DEFAULT_HINT)}`)
  return errorText(lines.join('\n'))
}

export const encodeId = (id: string) => encodeURIComponent(id.trim())
