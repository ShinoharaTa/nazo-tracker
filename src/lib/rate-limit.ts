// レート制限（docs/ops.md「レート制限」）。Workers の Rate Limiting binding を引き、通してよいかを返す。
// 拠点ごと・結果整合なので上限を少し超えて通ることがある。雑な連打を止めるためのもので、厳密な回数制限ではない

// limiter が無い（binding 未設定）・key が無い（CF-Connecting-IP が無い）ときは素通し。
// limit() が例外を投げたときも、制限の故障でログインや agent を止めないよう素通しにする
export const allow = async (
  limiter: RateLimit | undefined,
  key: string | null,
): Promise<boolean> => {
  if (!limiter || key === null) return true
  try {
    const { success } = await limiter.limit({ key })
    return success
  } catch (e) {
    console.error('レート制限の判定に失敗（素通し）', e)
    return true
  }
}
