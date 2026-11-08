// テスト補助。本物の経路（POST /_dev/login）を通してログインし、session cookie を返す

import app from '../../src/index'

export const ORIGIN = 'http://127.0.0.1:8787'

// Set-Cookie から値の入った session=… を取り出す（削除用の空の session= は飛ばす）
export const sessionCookieOf = (res: Response): string | null => {
  for (const sc of res.headers.getSetCookie()) {
    const pair = sc.split(';')[0]
    if (pair.startsWith('session=') && pair !== 'session=') return pair
  }
  return null
}

export const loginAs = async (
  env: Cloudflare.Env,
  { subject, owner = false, cookie }: { subject: string; owner?: boolean; cookie?: string },
): Promise<{ cookie: string; userId: string; res: Response }> => {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (cookie) headers.Cookie = cookie
  const res = await app.request(
    '/_dev/login',
    { method: 'POST', headers, body: new URLSearchParams({ subject }).toString() },
    { ...env, AUTH_DEV_LOGIN: '1', OWNER_IDENTITIES: owner ? `dev:${subject}` : '' },
  )
  const session = sessionCookieOf(res)
  if (res.status !== 302 || !session) throw new Error(`loginAs failed: ${res.status}`)
  const row = await env.DB.prepare(
    "SELECT user_id FROM identity WHERE provider = 'dev' AND subject = ?",
  )
    .bind(subject)
    .first<{ user_id: string }>()
  if (!row) throw new Error('identity が作られていない')
  return { cookie: session, userId: row.user_id, res }
}
