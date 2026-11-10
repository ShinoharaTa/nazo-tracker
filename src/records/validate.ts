// 記録フォームの入力の検証（部品は src/lib/form.ts）。work_id の存在・未統合はルートで getWork を使って確かめる。

import { attemptStatuses } from '../db/schema'
import { date, done, type Form, field, oneOf } from '../lib/form'
import type { AttemptStatus } from '../ui/labels'

export const newRecordFields = ['work_id', 'status', 'on'] as const

export type NewRecordInput = { status: AttemptStatus; on: string | null }

// 軽い記録（POST /records）。status は必須、on は空なら NULL
export const parseNewRecord = (f: Form) => {
  const errors: string[] = []
  if (f.status === '') errors.push('ステータスを選んでください。')
  const status = field(errors, 'ステータス', f.status, oneOf(attemptStatuses))
  const on = field(errors, '日付', f.on, date())
  return done<NewRecordInput>(errors, { status: status ?? attemptStatuses[0], on })
}
