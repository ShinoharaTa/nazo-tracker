// 書き込みツール（PATCH /requests/:id、POST /sources、POST /proposals）。値の検証は Worker に任せ、ここは形だけ見る。
// 自動で再試行しない（source や提案が二重に入る）。提案は常に hold: true で出し、pending 以外はエラーにする。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  encodeId,
  errorText,
  json,
  result,
  SOURCE_UNKNOWN_HINT,
  WRITE_UNKNOWN_HINT,
} from './common.js'
import { type ToolContext, withClient } from './read.js'

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const id = z.string().trim().min(1)
const score = z.number().min(0).max(1)

export function registerWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'set_request_status',
    {
      title: 'リクエストの状態を変える',
      description:
        'リクエストの状態を変える。調査を始めるとき processing、提案を出し終えたら proposed、' +
        '依頼者に聞けば進むとき needs_info（question が要る）、途中でやめるとき triaged に戻す（note に理由）。' +
        'proposed はこのリクエストに pending の提案が 1 件以上あるときだけ。',
      inputSchema: {
        id: id.describe('リクエストの id'),
        status: z.enum(['processing', 'proposed', 'needs_info', 'triaged']),
        question: z
          .string()
          .optional()
          .describe('依頼者への質問（needs_info のとき必須、1000 文字まで）'),
        note: z.string().optional().describe('メモ（2000 文字まで）'),
      },
      annotations: WRITE,
    },
    withClient(
      ctx,
      async (client, a: { id: string; status: string; question?: string; note?: string }) => {
        const r = await client.patch(`/requests/${encodeId(a.id)}`, {
          status: a.status,
          question: a.question,
          note: a.note,
        })
        return result(json(r), r)
      },
      WRITE_UNKNOWN_HINT,
    ),
  )

  server.registerTool(
    'add_source',
    {
      title: '出典を登録する',
      description:
        '取得した出典を登録し、id を返す（create_proposal の source_id に使う）。Worker は取りに行かず記録だけする。' +
        'method は get_schema の source_methods（escape_mcp は escape.id の URL だけ、webfetch は robots.txt を確かめたときだけ）。' +
        'x.com / twitter.com / t.co と escape.id の /me/ は出典にできない。',
      inputSchema: {
        url: z.string().trim().min(1).describe('取得した URL（http / https）'),
        method: z.string().trim().min(1).describe('escape_mcp / webfetch / pds'),
        fetched_at: z.string().trim().min(1).describe('取得日時（タイムゾーン付き ISO 8601）'),
        robots_checked: z
          .union([z.boolean(), z.literal(0), z.literal(1)])
          .describe('robots.txt で許可を確かめたか（true / false、1 / 0 も可）'),
        excerpt: z.string().optional().describe('根拠の抜粋（500 文字まで）'),
        content_hash: z.string().optional().describe('本文の SHA-256（16 進 64 文字）'),
      },
      annotations: WRITE,
    },
    withClient(
      ctx,
      async (
        client,
        a: {
          url: string
          method: string
          fetched_at: string
          robots_checked: boolean | 0 | 1
          excerpt?: string
          content_hash?: string
        },
      ) => {
        const r = await client.post('/sources', {
          url: a.url,
          method: a.method,
          fetched_at: a.fetched_at,
          // API には boolean で送る
          robots_checked: a.robots_checked === true || a.robots_checked === 1,
          excerpt: a.excerpt,
          content_hash: a.content_hash,
        })
        if (typeof r.id !== 'string' || !r.id) {
          return errorText(
            `エラー: 応答に出典の id がありません。\n本文: ${json(r)}\n次の手: ${SOURCE_UNKNOWN_HINT}`,
          )
        }
        return result(json({ id: r.id }), { id: r.id })
      },
      SOURCE_UNKNOWN_HINT,
    ),
  )

  server.registerTool(
    'create_proposal',
    {
      title: '提案を出す',
      description:
        'マスタへの提案を 1 件出す。必ず pending で入り、反映するかはオーナーが /admin/proposals で決める（自動反映はしない）。' +
        '書ける項目名（kind × target_table）・値の一覧・@<表> の参照は get_schema で確かめる。' +
        'create は target_id なし、update / link / merge は target_id が要る。request_id を付けるならそのリクエストは processing にしておく。',
      inputSchema: {
        kind: z.string().trim().min(1).describe('create / update / link / merge'),
        target_table: z.string().trim().min(1).describe('work / run / organization / venue / shop'),
        target_id: id.optional().describe('対象の行の id（create 以外）'),
        request_id: id.optional().describe('元のリクエストの id'),
        fields: z
          .array(
            z.object({
              field: z
                .string()
                .trim()
                .min(1)
                .describe('<表>.<列>（get_schema の proposal_fields）'),
              new_value: z.string().nullable().describe('新しい値。空にするなら null'),
              source_id: id.nullable().optional().describe('add_source の id'),
              confidence: score.describe('確信度 0〜1'),
            }),
          )
          .min(1),
        match_candidates: z
          .array(
            z.object({
              table: z.string().describe('work / organization / venue'),
              id: id,
              score: score,
              reason: z.string().describe('理由（40 文字まで）'),
            }),
          )
          .optional()
          .describe('近い既存の行（最大 20 件）'),
      },
      annotations: WRITE,
    },
    withClient(
      ctx,
      async (
        client,
        a: {
          kind: string
          target_table: string
          target_id?: string
          request_id?: string
          fields: {
            field: string
            new_value: string | null
            source_id?: string | null
            confidence: number
          }[]
          match_candidates?: { table: string; id: string; score: number; reason: string }[]
        },
      ) => {
        // hold は入力に出さず常に true（設定が ON でも自動反映させない）
        const r = await client.post('/proposals', {
          kind: a.kind,
          target_table: a.target_table,
          target_id: a.target_id,
          request_id: a.request_id,
          fields: a.fields,
          match_candidates: a.match_candidates,
          hold: true,
        })
        const out = { id: r.id, status: r.status, fingerprint: r.fingerprint }
        if (r.status !== 'pending') {
          return errorText(
            `警告: 提案が pending になっていません（status=${String(r.status)}）。hold: true を送ったのに pending 以外で入りました。` +
              `続けずに止め、/admin/proposals でこの提案（id=${String(r.id)}）を確かめてもらってください。\n${json(r)}`,
          )
        }
        return result(json(out), out)
      },
      WRITE_UNKNOWN_HINT,
    ),
  )
}
