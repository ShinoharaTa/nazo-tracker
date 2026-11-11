// 列挙値の表示ラベル。値の正本は src/db/schema.ts。

import {
  attemptStatuses,
  type organizationAliasKinds,
  type requestKinds,
  type requestStatuses,
  type runChannels,
  type shopKinds,
  type workAliasKinds,
  type workKinds,
} from '../db/schema'
import type { SessionOutcome } from '../db/scoped'

export type WorkKind = (typeof workKinds)[number]
export type AttemptStatus = (typeof attemptStatuses)[number]
export type RunChannel = (typeof runChannels)[number]
export type WorkAliasKind = (typeof workAliasKinds)[number]
export type OrganizationAliasKind = (typeof organizationAliasKinds)[number]
export type ShopKind = (typeof shopKinds)[number]
export type RequestKind = (typeof requestKinds)[number]
export type RequestStatus = (typeof requestStatuses)[number]

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

// 来場型（ルーム・公演）。進行中が無く、予約済み・成功・失敗だけ
export const isVisitKind = (kind: WorkKind | null | undefined): boolean =>
  kind === 'hall' || kind === 'room'

const visitStatuses: readonly AttemptStatus[] = ['purchased', 'cleared', 'failed']
// 持ち帰りには失敗が無い
const takeawayStatuses: readonly AttemptStatus[] = [
  'purchased',
  'in_progress',
  'cleared',
  'dropped',
]

// 作品の形式で選べるステータス（形式未設定は全部）
export const statusesFor = (kind: WorkKind | null | undefined): readonly AttemptStatus[] =>
  isVisitKind(kind) ? visitStatuses : kind === 'takeaway' ? takeawayStatuses : attemptStatuses

// 来場型の purchased は「予約済み」、cleared は「成功」
export const statusLabel = (status: AttemptStatus, kind?: WorkKind | null): string => {
  if (isVisitKind(kind)) {
    if (status === 'purchased') return '予約済み'
    if (status === 'cleared') return '成功'
  }
  return attemptStatusLabels[status]
}

// 進行ログを足すときの結果。値の正本は src/db/scoped.ts の sessionOutcomes
export const outcomeLabels: Record<SessionOutcome, string> = {
  keep: '進行中のまま',
  cleared: 'クリア',
  dropped: '断念',
}

export const runChannelLabels: Record<RunChannel, string> = {
  performance: '公演',
  online: '配信',
  sale: '販売',
}

export const workAliasKindLabels: Record<WorkAliasKind, string> = {
  former_title: '旧題',
  alt_spelling: '表記ゆれ',
  subtitle: '副題',
}

export const organizationAliasKindLabels: Record<OrganizationAliasKind, string> = {
  former_name: '旧名',
  alt_spelling: '表記ゆれ',
  label: 'レーベル',
}

// booth が BOOTH（booth.pm）か即売会の手売りかは未決。仮に BOOTH
export const shopKindLabels: Record<ShopKind, string> = {
  booth: 'BOOTH',
  official_store: '公式通販',
  physical_store: '実店舗',
  other: 'その他',
}

export const requestKindLabels: Record<RequestKind, string> = {
  new_work: '作品を追加',
  fix_work: '作品の情報を直す',
  new_organization: '団体を追加',
  new_shop: '販売先を追加',
  new_booth: '出店を追加',
  new_room_venue: '常設店舗を追加',
  new_genre: 'ジャンルを追加',
  import_trailcast: 'trailcast から取り込む',
  other: 'その他',
}

// 依頼者に見せる状態。open と triaged は区別しない（選別は依頼者に関係ない）
export const requestStatusLabels: Record<RequestStatus, string> = {
  open: '受付済み',
  triaged: '受付済み',
  processing: '調べています',
  proposed: '確認中',
  done: '対応しました',
  rejected: '見送りました',
  needs_info: '質問があります',
}

// 名寄せ候補の reason（src/db/match.ts）。未知の値はそのまま
const matchReasonLabels: Record<string, string> = {
  escape_id_url: 'escape.id の URL が一致',
  same_org_title: '同じ団体で同じ題名',
  title: '同じ題名',
  similar: '似た題名',
  name: '同じ名前',
}

export const matchReasonLabel = (reason: string): string =>
  Object.hasOwn(matchReasonLabels, reason) ? matchReasonLabels[reason] : reason

// 匿名人数（src/db/counts.ts）の表示。0 は出さない（null）
export const countLabel = (n: number): string | null => (n > 0 ? `${n} 人` : null)
