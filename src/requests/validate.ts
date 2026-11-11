// リクエストの投稿・返信の入力の検証（部品は src/lib/form.ts）。fix_work の対象作品の存在・未統合と、
// 1 日の上限・同じ URL の重複はルートで DB を見て確かめる。

import type { RequestPayload } from '../db/requests'
import { done, type Form, field, str, url } from '../lib/form'
import type { RequestKind } from '../ui/labels'

// 依頼者が選べる種類。new_booth（P7）と import_trailcast（P5、オーナーのみ）は不可
export const memberRequestKinds = [
  'new_work',
  'fix_work',
  'new_organization',
  'new_shop',
  'new_room_venue',
  'new_genre',
  'other',
] as const satisfies readonly RequestKind[]

export type MemberRequestKind = (typeof memberRequestKinds)[number]

export const isMemberRequestKind = (v: string): v is MemberRequestKind =>
  (memberRequestKinds as readonly string[]).includes(v)

export const requestFields = ['kind', 'url', 'title', 'organization', 'note', 'target'] as const

// 名前の欄のラベル。作品の種類だけ「作品名」
export const titleLabel = (kind: string): string =>
  kind === 'new_work' || kind === 'fix_work' ? '作品名' : '名前'

// escape.id（www. などのサブドメインも）のマイページ（/me と /me/…）。本人の記録が載るので受け付けない
export const isEscapeIdMyPage = (href: string): boolean => {
  const u = new URL(href)
  const host = u.hostname === 'escape.id' || u.hostname.endsWith('.escape.id')
  return host && (u.pathname === '/me' || u.pathname.startsWith('/me/'))
}

// target は fix_work のときだけ見る。ルートが引いた未統合の作品の id（無い・統合済みなら null）
export const parseRequest = (f: Form, { targetId }: { targetId: string | null }) => {
  const errors: string[] = []
  const kind = isMemberRequestKind(f.kind) ? f.kind : null
  if (!kind) errors.push('種類の値が正しくありません。')
  let u = field(errors, 'URL', f.url, url())
  if (u && isEscapeIdMyPage(u)) {
    errors.push(
      'escape.id のマイページの URL は受け付けられません。公演ページの URL を貼ってください。',
    )
    u = null
  }
  const title = field(errors, titleLabel(f.kind), f.title, str(200))
  const organization = field(errors, '団体', f.organization, str(200))
  const note = field(errors, 'メモ', f.note, str(2000, { multiline: true }))
  if (kind === 'new_work' && f.url === '' && f.title === '') {
    errors.push('URL か作品名のどちらかを入れてください。')
  }
  if (kind === 'fix_work') {
    if (!targetId) errors.push('直す作品が見つかりません。作品のページからやり直してください。')
    if (f.note === '') errors.push('直してほしい内容をメモに書いてください。')
  }
  if (kind === 'new_room_venue' && f.url === '') {
    errors.push('店舗の公式サイトの URL を入れてください。')
  }
  if ((kind === 'new_organization' || kind === 'new_shop' || kind === 'new_genre') && !f.title) {
    errors.push('名前を入れてください。')
  }
  if (kind === 'other' && f.note === '') errors.push('内容をメモに書いてください。')
  // キーは値のあるものだけ
  const payload: RequestPayload = {}
  if (u) payload.url = u
  if (title) payload.title = title
  if (organization) payload.organization = organization
  if (note) payload.note = note
  if (kind === 'fix_work' && targetId) payload.target_id = targetId
  return done<{ kind: MemberRequestKind; payload: RequestPayload }>(errors, {
    kind: kind ?? 'other',
    payload,
  })
}

export const replyFields = ['reply'] as const

// needs_info への返信。必須・2000 字
export const parseReply = (f: Form) => {
  const errors: string[] = []
  const reply = field(errors, '返信', f.reply, str(2000, { multiline: true }), true)
  return done<string>(errors, reply ?? '')
}

export const statusChangeFields = ['to', 'note', 'question'] as const

// オーナーが送れる行き先。open は遷移の表に無いので canTransition で必ず断られる
const ownerTargets = ['triaged', 'rejected', 'needs_info', 'done', 'open'] as const
export type OwnerTarget = (typeof ownerTargets)[number]

export const isOwnerTarget = (v: string): v is OwnerTarget =>
  (ownerTargets as readonly string[]).includes(v)

// オーナーの状態変更（POST /admin/requests/:id/status）の付随入力。to の値と遷移の可否はルートで先に見る。
// rejected は見送る理由が必須、needs_info は質問が必須（1000 字）
export const parseStatusChange = (f: Form, to: OwnerTarget) => {
  const errors: string[] = []
  const note = field(errors, 'メモ', f.note, str(2000, { multiline: true }))
  if (to === 'rejected' && f.note === '') {
    errors.push('見送る理由をメモに書いてください（依頼者には見えません）。')
  }
  const question = field(
    errors,
    '質問',
    f.question,
    str(1000, { multiline: true }),
    to === 'needs_info',
  )
  return done<{ note: string | null; question: string | null }>(errors, {
    note: to === 'triaged' || to === 'rejected' ? note : null,
    question: to === 'needs_info' ? question : null,
  })
}
