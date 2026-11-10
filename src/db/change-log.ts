// マスタ書き込みの履歴（change_log）。本体の書き込みと同じ db.batch に入れる。

import { getTableColumns, getTableName } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import type { Db } from './client'
import { changeLog } from './schema'

export type ChangeAction = 'create' | 'update' | 'delete' | 'merge'

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
    actorUserId: string
  },
) =>
  db.insert(changeLog).values({
    id: ulid(),
    tableName: getTableName(p.table),
    rowId: p.rowId,
    action: p.action,
    beforeJson: p.before ? JSON.stringify(columnRow(p.table, p.before)) : null,
    afterJson: p.after ? JSON.stringify(columnRow(p.table, p.after)) : null,
    actorUserId: p.actorUserId,
    actorTokenId: null,
    proposalId: null,
    createdAt: nowIso(),
  })
