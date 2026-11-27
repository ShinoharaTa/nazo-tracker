// Google（OIDC + PKCE）。scope は openid のみで、メールアドレス等は受け取らない

import { verifyIdToken } from './id-token'
import type { OAuthProvider } from './types'

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

// Google の ID トークンを検証して sub を返す。どれか失敗なら null（検証の中身と署名を検証しない理由は ./id-token.ts）
export const parseAndVerifyIdToken = (
  idToken: unknown,
  { clientId, nonce }: { clientId: string; nonce: string | null },
): string | null => verifyIdToken(idToken, { issuers: ISSUERS, clientId, nonce })

export const google: OAuthProvider = {
  name: 'google',
  label: 'Google',
  clientId: (env) => env.GOOGLE_CLIENT_ID,
  clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
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
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  },
  tokenUrl: 'https://oauth2.googleapis.com/token',
  subjectOf: async (token, { clientId, nonce }) => {
    if (typeof token !== 'object' || token === null) return null
    return parseAndVerifyIdToken((token as { id_token?: unknown }).id_token, { clientId, nonce })
  },
}
