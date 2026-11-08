// 列挙値の表示ラベル。値の正本は src/db/schema.ts。

import type { attemptStatuses, workKinds } from '../db/schema'

export type WorkKind = (typeof workKinds)[number]
export type AttemptStatus = (typeof attemptStatuses)[number]

export const workKindLabels: Record<WorkKind, string> = {
  hall: '公演',
  room: 'ルーム',
  stroll: '周遊',
  line: 'LINE',
  web: 'Web',
  takeaway: '持ち帰り',
  other: 'その他',
}

export const attemptStatusLabels: Record<AttemptStatus, string> = {
  purchased: '買った',
  in_progress: '進行中',
  cleared: 'クリア',
  failed: '失敗',
  dropped: '断念',
}
