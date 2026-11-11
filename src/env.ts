// Worker の環境変数・binding と、Hono のコンテキスト変数の型。src と test はここから参照する。

import type { SessionUser } from './auth/session'
import type { Db } from './db/client'

export type Bindings = {
  DB: D1Database
  // 本番 https://nazo.shino3.net、開発・テスト http://127.0.0.1:8787。CSRF の Origin 照合に使う
  APP_ORIGIN: string
  // session cookie の署名鍵（secret）
  SESSION_SECRET: string
  // "1" のときだけ仮ログイン /_dev/login を有効にする（APP_ORIGIN と Host がローカルであることも必要）
  AUTH_DEV_LOGIN?: string
  // 仮ログインで 127.0.0.1 / localhost に加えて許可するホスト。カンマ区切り、プライベート IPv4 だけ採用
  AUTH_DEV_HOSTS?: string
  // オーナーにする identity。provider:subject のカンマ区切り
  OWNER_IDENTITIES?: string
  // Google の OAuth クライアント ID。空なら Google ログインは「準備中」
  GOOGLE_CLIENT_ID?: string
  // Google の OAuth クライアントシークレット（secret）
  GOOGLE_CLIENT_SECRET?: string
  // Discord の OAuth クライアント ID。空なら Discord ログインは「準備中」
  DISCORD_CLIENT_ID?: string
  // Discord の OAuth クライアントシークレット（secret）
  DISCORD_CLIENT_SECRET?: string
  // "1" のときだけ部品見本 GET /_ui を有効にする
  UI_GALLERY?: string
}

export type Variables = {
  db: Db
  user: SessionUser | null
  // session_token.id（cookie の token の SHA-256）。未ログインは null
  sessionId: string | null
  // api_token.id。/api/agent/* の requireAgent を通ったときだけ入る
  agentTokenId: string
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }
