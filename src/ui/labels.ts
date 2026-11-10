// 列挙値の表示ラベル。値の正本は src/db/schema.ts。

import type { Bucket } from '../db/counts'
import type {
  attemptStatuses,
  organizationAliasKinds,
  runChannels,
  shopKinds,
  workAliasKinds,
  workKinds,
} from '../db/schema'

export type WorkKind = (typeof workKinds)[number]
export type AttemptStatus = (typeof attemptStatuses)[number]
export type RunChannel = (typeof runChannels)[number]
export type WorkAliasKind = (typeof workAliasKinds)[number]
export type OrganizationAliasKind = (typeof organizationAliasKinds)[number]
export type ShopKind = (typeof shopKinds)[number]

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

// 匿名人数（src/db/counts.ts の Bucket）の表示。none は出さない（null）
export const countLabel = (b: Bucket): string | null =>
  b === 'none' ? null : b === 'few' ? '少数' : `${b} 人`
