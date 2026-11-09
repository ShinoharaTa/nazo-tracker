// Discord（OAuth 2.0 + PKCE）。scope は identify のみ。OIDC ではないので nonce は使わない

import type { OAuthProvider } from './types'

// token 応答の token_type・scope を確かめ、access_token で /users/@me を呼んで id を返す。どれか失敗なら null。
// username 等は読まない。access_token はこの関数を抜けたら捨てる
const userIdOf = async (token: unknown): Promise<string | null> => {
  if (typeof token !== 'object' || token === null) return null
  const { token_type, scope, access_token } = token as Record<string, unknown>
  if (token_type !== 'Bearer') return null
  if (typeof scope !== 'string' || !scope.split(' ').includes('identify')) return null
  if (typeof access_token !== 'string' || access_token === '') return null

  const res = await fetch('https://discord.com/api/users/@me', {
    headers: {
      Authorization: `Bearer ${access_token}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) return null
  const me: unknown = await res.json()
  if (typeof me !== 'object' || me === null) return null
  const { id } = me as { id?: unknown }
  if (typeof id !== 'string' || id === '') return null
  return id
}

export const discord: OAuthProvider = {
  name: 'discord',
  label: 'Discord',
  clientId: (env) => env.DISCORD_CLIENT_ID,
  clientSecret: (env) => env.DISCORD_CLIENT_SECRET,
  usesNonce: false,
  authorizeUrl: ({ clientId, redirectUri, state, codeChallenge }) => {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'identify',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'none',
    })
    return `https://discord.com/oauth2/authorize?${q}`
  },
  tokenUrl: 'https://discord.com/api/oauth2/token',
  subjectOf: (token) => userIdOf(token),
}
