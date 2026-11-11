// マスタ書き込みの履歴（change_log）。本体の書き込みと同じ db.batch に入れる。

import { getTableColumns, getTableName } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import type { Db } from './client'
import { changeLog } from './schema'

export type ChangeAction = 'create' | 'update' | 'delete' | 'merge'

// 書いた主体。オーナー画面はユーザー、P4 の自動反映は agent トークン（change_log はちょうど片方）
export type Actor = { userId: string } | { tokenId: string }

// 書き込み関数に渡す文脈。proposalId は提案の承認・自動反映から書くときだけ
export type WriteCtx = { actor: Actor; proposalId?: string }

// drizzle の行（camelCase）を DB 列名（snake_case）キーの行全体に。無い列は null
export const columnRow = (
  table: SQLiteTable,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, col] of Object.entries(getTableColumns(table))) out[col.name] = row[key] ?? null
  return out
}

// change_log の INSERT 文を返す（実行はしない）。before / after は drizzle の行
export const logChange = (
  db: Db,
  p: {
    table: SQLiteTable
    rowId: string
    action: ChangeAction
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    actor: Actor
    proposalId?: string
  },
) =>
  db.insert(changeLog).values({
    id: ulid(),
    tableName: getTableName(p.table),
    rowId: p.rowId,
    action: p.action,
    beforeJson: p.before ? JSON.stringify(columnRow(p.table, p.before)) : null,
    afterJson: p.after ? JSON.stringify(columnRow(p.table, p.after)) : null,
    actorUserId: 'userId' in p.actor ? p.actor.userId : null,
    actorTokenId: 'tokenId' in p.actor ? p.actor.tokenId : null,
    proposalId: p.proposalId ?? null,
    createdAt: nowIso(),
  })
