// OIDC の ID トークンの検証（Google / LINE で共通）

const decodeBase64url = (s: string): string => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))
}

// ID トークンの payload を取り出し、iss（issuers のどれか）/ aud / exp / nonce を照合して sub を返す。どれか失敗なら null。
// 署名（JWKS）は検証しない。ID トークンは token endpoint から TLS で直接受け取っており、
// OIDC Core 3.1.3.7 の 6 項により署名検証の代わりに TLS のサーバ検証を使ってよいため（依存を増やさない）
export const verifyIdToken = (
  idToken: unknown,
  {
    issuers,
    clientId,
    nonce,
  }: { issuers: readonly string[]; clientId: string; nonce: string | null },
): string | null => {
  if (typeof idToken !== 'string' || !nonce) return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  let payload: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(decodeBase64url(parts[1]))
    if (typeof v !== 'object' || v === null) return null
    payload = v as Record<string, unknown>
  } catch {
    return null
  }
  const { iss, aud, exp, sub } = payload
  if (typeof iss !== 'string' || !issuers.includes(iss)) return null
  if (aud !== clientId) return null
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null
  if (payload.nonce !== nonce) return null
  if (typeof sub !== 'string' || sub === '') return null
  return sub
}
