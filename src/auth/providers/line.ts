// LINE ログイン（OIDC + PKCE）。scope は openid のみで、プロフィール・メールアドレスは受け取らない

import { verifyIdToken } from './id-token'
import type { OAuthProvider } from './types'

const ISSUERS = ['https://access.line.me']

// LINE の ID トークンを検証して sub を返す。どれか失敗なら null。
// 署名（JWKS）は検証しない。Google と同じく ID トークンは token endpoint から TLS で直接受け取っており、
// OIDC Core 3.1.3.7 の 6 項により署名検証の代わりに TLS のサーバ検証を使ってよいため（依存を増やさない）
export const parseAndVerifyLineIdToken = (
  idToken: unknown,
  { clientId, nonce }: { clientId: string; nonce: string | null },
): string | null => verifyIdToken(idToken, { issuers: ISSUERS, clientId, nonce })

export const line: OAuthProvider = {
  name: 'line',
  label: 'LINE',
  clientId: (env) => env.LINE_CLIENT_ID,
  clientSecret: (env) => env.LINE_CLIENT_SECRET,
  usesNonce: true,
  authorizeUrl: ({ clientId, redirectUri, state, codeChallenge, nonce }) => {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid',
      state,
      nonce: nonce ?? '',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return `https://access.line.me/oauth2/v2.1/authorize?${q}`
  },
  tokenUrl: 'https://api.line.me/oauth2/v2.1/token',
  subjectOf: async (token, { clientId, nonce }) => {
    if (typeof token !== 'object' || token === null) return null
    return parseAndVerifyLineIdToken((token as { id_token?: unknown }).id_token, {
      clientId,
      nonce,
    })
  },
}
