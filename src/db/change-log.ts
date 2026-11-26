// マスタ書き込みと agent の提案の履歴（change_log）。本体の書き込みと同じ db.batch に入れる。

import { getTableColumns, getTableName, type SQL, sql } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { ulid } from '../lib/id'
import { nowIso } from '../lib/time'
import type { Db } from './client'
import { changeLog } from './schema'

export type ChangeAction = 'create' | 'update' | 'delete' | 'merge'

// 書いた主体。オーナー画面はユーザー、P4 の自動反映は agent トークン（change_log はちょうど片方）
export type Actor = { userId: string; tokenId?: never } | { tokenId: string; userId?: never }

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

type LogParams = {
  table: SQLiteTable
  rowId: string | SQL
  action: ChangeAction
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  actor: Actor
  proposalId?: string
}

const logValues = (p: LogParams) => ({
  id: ulid(),
  tableName: getTableName(p.table),
  rowId: p.rowId,
  action: p.action,
  beforeJson: p.before ? JSON.stringify(columnRow(p.table, p.before)) : null,
  afterJson: p.after ? JSON.stringify(columnRow(p.table, p.after)) : null,
  actorUserId: p.actor.userId ?? null,
  actorTokenId: p.actor.tokenId ?? null,
  proposalId: p.proposalId ?? null,
  createdAt: nowIso(),
})

// change_log の INSERT 文を返す（実行はしない）。before / after は drizzle の行。
// rowId に SQL（副問い合わせ）を渡すと、それが NULL のとき NOT NULL 違反で batch ごと失敗する（承認の二重送信よけ）
export const logChange = (db: Db, p: LogParams) => db.insert(changeLog).values(logValues(p))

// when が真のときだけ 1 行入れる INSERT … SELECT（偽なら何もせず、batch も止めない）。
// 同じ batch の UPDATE … WHERE と同じ条件を、その UPDATE より前に置いて、書いた行と履歴を揃える
export const logChangeIf = (db: Db, p: LogParams, when: SQL) => {
  const v = logValues(p)
  // 列は表の定義順（drizzle は INSERT INTO change_log (全列) で出す）
  const cols = Object.keys(getTableColumns(changeLog)) as (keyof typeof v)[]
  return db.insert(changeLog).select(
    sql`SELECT ${sql.join(
      cols.map((k) => sql`${v[k]}`),
      sql`, `,
    )} WHERE ${when}`,
  )
}
