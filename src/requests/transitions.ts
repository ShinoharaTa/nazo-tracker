// リクエストの状態遷移（docs/data-model.md §4 の表）。誰がどこからどこへ変えられるかはここ 1 か所で決める。
// 付随する入力（見送る理由・質問）の必須は呼び出し側で見る。

import type { RequestStatus } from '../ui/labels'

export type RequestActor = 'requester' | 'owner' | 'agent' | 'worker'

// done / rejected は終わった状態（オーナーの質問・完了の対象外）
const closed: readonly RequestStatus[] = ['done', 'rejected']

export const canTransition = (
  from: RequestStatus,
  to: RequestStatus,
  by: RequestActor,
): boolean => {
  switch (by) {
    case 'requester':
      return from === 'needs_info' && to === 'open'
    case 'owner':
      if (from === 'open' && to === 'triaged') return true
      // 見送りは調べ始める前か、質問の返事待ちのときだけ（processing 以降は agent / 提案の側で終わらせる）
      if (to === 'rejected' && (from === 'open' || from === 'triaged' || from === 'needs_info')) {
        return true
      }
      if ((to === 'needs_info' || to === 'done') && !closed.includes(from)) return true
      // CLI が途中で止まったときの戻し
      return from === 'processing' && to === 'triaged'
    case 'agent':
      if ((from === 'open' || from === 'triaged') && to === 'processing') return true
      return from === 'processing' && (to === 'proposed' || to === 'needs_info' || to === 'triaged')
    case 'worker':
      // 紐付く提案の pending が 0 件になった時点（承認・却下・自動反映の batch の中）
      return from === 'proposed' && to === 'done'
  }
}
