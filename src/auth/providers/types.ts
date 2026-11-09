// OAuth プロバイダの共通の形と登録（docs/auth.md §3）。共通の流れは ../oauth.ts

import type { Bindings } from '../../env'
import type { Provider } from '../login'
import { google } from './google'

export type OAuthProviderName = Exclude<Provider, 'dev'>

export type OAuthProvider = {
  name: OAuthProviderName
  // 画面に出す名前
  label: string
  // 未設定（空文字を含む）なら「準備中」扱い
  clientId: (env: Bindings) => string | undefined
  clientSecret: (env: Bindings) => string | undefined
  // OIDC の nonce を使うか（oauth_state.nonce に保存して ID トークンと照合する）
  usesNonce: boolean
  authorizeUrl: (p: {
    clientId: string
    redirectUri: string
    state: string
    codeChallenge: string
    nonce: string | null
  }) => string
  tokenUrl: string
  // token endpoint の応答（JSON）から subject を取り出す。検証に失敗したら null
  subjectOf: (
    token: unknown,
    ctx: { clientId: string; nonce: string | null; fetch: typeof fetch },
  ) => Promise<string | null>
}

// 登録済みのプロバイダ。Discord は PR-5 で足す
export const oauthProviders: Partial<Record<OAuthProviderName, OAuthProvider>> = { google }

export const findOAuthProvider = (name: string): OAuthProvider | null =>
  Object.hasOwn(oauthProviders, name) ? (oauthProviders[name as OAuthProviderName] ?? null) : null
