// 自動反映ルール（docs/agent-pipeline.md §4 A-3）の判定。純関数（DB は引かない。必要な値は呼び出し側が集めて渡す）。
// 全部満たすときだけ反映する。work.kind / run.is_permanent は確信度が低くても反映を止めず、入れずに反映して別の承認待ちにする。

import type { ProposalItem, ProposalKind, ProposalTable } from './fields'

// 反映してよい確信度（kind / is_permanent 以外は全項目これ以上）
export const AUTO_CONFIDENCE_MIN = 0.9
// agent の候補にこのスコア以上があれば、既存の作品かもしれないので反映しない
export const AUTO_CANDIDATE_SCORE_MAX = 0.8
// 確信度が低くても反映を止めない項目（入れずに反映して follow-up の承認待ちにする）
export const deferrableFields = ['work.kind', 'run.is_permanent'] as const

export type AutoApplyInput = {
  // app_setting.auto_apply
  enabled: boolean
  kind: ProposalKind
  targetTable: ProposalTable
  items: readonly Pick<ProposalItem, 'field' | 'table' | 'newValue' | 'sourceId' | 'confidence'>[]
  // source の id → method（項目の source_id で引く。無い id は出典なしと同じ）
  sourceMethods: ReadonlyMap<string, string>
  // Worker の完全一致候補（worker: 付き）の件数
  workerCandidates: number
  // agent が送った候補のスコア
  agentScores: readonly number[]
  // 紐付くリクエストの種類（無ければ null）
  requestKind: string | null
}

export type AutoApplyDecision = {
  apply: boolean
  // 反映しない理由（反映するときは 'ok'）
  reason:
    | 'ok'
    | 'disabled'
    | 'kind'
    | 'new_master'
    | 'source'
    | 'no_escape_url'
    | 'low_confidence'
    | 'candidates'
    | 'request_kind'
  // 入れずに反映し、follow-up の承認待ちにする項目（反映するときだけ。値が空の項目は入れても既定と同じなので含めない）
  deferred: string[]
}

const no = (reason: Exclude<AutoApplyDecision['reason'], 'ok'>): AutoApplyDecision => ({
  apply: false,
  reason,
  deferred: [],
})

const isDeferrable = (field: string) => (deferrableFields as readonly string[]).includes(field)

export const autoApplyDecision = (input: AutoApplyInput): AutoApplyDecision => {
  if (!input.enabled) return no('disabled')
  if (input.kind !== 'create' || (input.targetTable !== 'work' && input.targetTable !== 'run')) {
    return no('kind')
  }
  // 新しい団体・会場・販売先は人が表記ゆれを見る
  if (input.items.some((i) => i.table !== 'work' && i.table !== 'run')) return no('new_master')
  if (
    !input.items.every((i) => i.sourceId && input.sourceMethods.get(i.sourceId) === 'escape_mcp')
  ) {
    return no('source')
  }
  if (!input.items.some((i) => i.field === 'run.escape_id_url' && i.newValue)) {
    return no('no_escape_url')
  }
  if (input.items.some((i) => !isDeferrable(i.field) && i.confidence < AUTO_CONFIDENCE_MIN)) {
    return no('low_confidence')
  }
  if (input.workerCandidates > 0 || input.agentScores.some((s) => s >= AUTO_CANDIDATE_SCORE_MAX)) {
    return no('candidates')
  }
  if (input.requestKind !== null && input.requestKind !== 'new_work') return no('request_kind')
  return {
    apply: true,
    reason: 'ok',
    deferred: input.items
      .filter((i) => isDeferrable(i.field) && i.newValue && i.confidence < AUTO_CONFIDENCE_MIN)
      .map((i) => i.field),
  }
}
