// agent トークン（api_token）の読み書き（docs/agent-pipeline.md §5）。
// D1 には SHA-256 のハッシュだけを置き、平文は createToken の戻り値で 1 回だけ返す。

import { and, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import { ulid } from '../lib/id'
import { randomToken, sha256Base64url } from '../lib/random'
import { addDays, nowIso } from '../lib/time'
import type { Db } from './client'
import { apiToken } from './schema'

export const TOKEN_PREFIX = 'nzt_'
export const TOKEN_DAYS = [30, 90, 180] as const
// v1 は画面で選ばない固定値
const SCOPES = ['master:read', 'request:rw', 'source:write', 'proposal:write'] as const

export const hashToken = (token: string): Promise<string> => sha256Base64url(token)

export type TokenRow = {
  id: string
  name: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

const cols = {
  id: apiToken.id,
  name: apiToken.name,
  expiresAt: apiToken.expiresAt,
  lastUsedAt: apiToken.lastUsedAt,
  revokedAt: apiToken.revokedAt,
  createdAt: apiToken.createdAt,
}

export const createToken = async (
  db: Db,
  name: string,
  days: number,
): Promise<{ id: string; token: string; expiresAt: string }> => {
  const id = ulid()
  const token = `${TOKEN_PREFIX}${randomToken()}`
  const now = nowIso()
  const expiresAt = addDays(now, days)
  await db.insert(apiToken).values({
    id,
    name,
    tokenHash: await hashToken(token),
    role: 'agent',
    scopesJson: JSON.stringify(SCOPES),
    expiresAt,
    createdAt: now,
  })
  return { id, token, expiresAt }
}

// 新しい順。件数は少ない（オーナーが手で発行する）のでページ分けしない
export const listTokens = (db: Db): Promise<TokenRow[]> =>
  db.select(cols).from(apiToken).orderBy(desc(apiToken.createdAt), desc(apiToken.id))

export const getToken = async (db: Db, id: string): Promise<TokenRow | null> =>
  (await db.select(cols).from(apiToken).where(eq(apiToken.id, id)).limit(1))[0] ?? null

// 失効済みなら何もしない（最初の失効日時を残す）
export const revokeToken = async (db: Db, id: string): Promise<void> => {
  await db
    .update(apiToken)
    .set({ revokedAt: nowIso() })
    .where(and(eq(apiToken.id, id), isNull(apiToken.revokedAt)))
}

export type ActiveToken = Pick<TokenRow, 'id' | 'name' | 'expiresAt' | 'lastUsedAt'>

// 使えるトークン: role = agent・未失効・期限内。expires_at が NULL の行は作らないので、あっても使えない扱い
export const findActiveToken = async (db: Db, hash: string): Promise<ActiveToken | null> =>
  (
    await db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        expiresAt: apiToken.expiresAt,
        lastUsedAt: apiToken.lastUsedAt,
      })
      .from(apiToken)
      .where(
        and(
          eq(apiToken.tokenHash, hash),
          eq(apiToken.role, 'agent'),
          isNull(apiToken.revokedAt),
          isNotNull(apiToken.expiresAt),
          gt(apiToken.expiresAt, nowIso()),
        ),
      )
      .limit(1)
  )[0] ?? null

export const touchToken = async (db: Db, id: string): Promise<void> => {
  await db.update(apiToken).set({ lastUsedAt: nowIso() }).where(eq(apiToken.id, id))
}
