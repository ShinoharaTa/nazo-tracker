// 設定の読み込み。トークンは agent.env からだけ読み、環境変数では受けない（設定ファイルに値を書かせない）。
// ここで作るエラー文にはファイルの中身を入れない（トークンが混ざりうる）。

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_ENV_FILE = path.join(os.homedir(), '.config', 'nazo-tracker', 'agent.env')
export const DEFAULT_BASE_URL = 'https://nazo.shino3.net'

export type Config = { token: string; baseUrl: string; envFile: string }
export type ConfigResult = { ok: true; config: Config } | { ok: false; message: string }

// 平文の http を許す host（手元の wrangler dev だけ）
const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

// KEY=VALUE の行だけ読む。# の行と空行は飛ばす。値が ' か " で始まれば閉じる引用符までを値にし、
// そうでなければ後ろの「空白 + # 以降」をコメントとして落とす
export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t)
    if (!m) continue
    const raw = (m[2] ?? '').trim()
    const q = raw[0]
    const end = q === '"' || q === "'" ? raw.indexOf(q, 1) : -1
    out[m[1] as string] = end > 0 ? raw.slice(1, end) : raw.replace(/\s+#.*$/, '').trim()
  }
  return out
}

// 接続先は origin だけにする。http は手元の host のとき、userinfo 付きは不可
export const parseBaseUrl = (raw: string): string | null => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname)) return u.origin
  return null
}

// 開いた fd で所有者・mode を確かめ、同じ fd から読む（確かめてから読むまでの間に差し替えられない）。
// uid は実行ユーザー（テストで差し替える）
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): ConfigResult => {
  const envFile = env.NAZO_AGENT_ENV_FILE?.trim() || DEFAULT_ENV_FILE
  let fd: number
  try {
    fd = openSync(envFile, 'r')
  } catch {
    return {
      ok: false,
      message: `設定ファイル ${envFile} が読めません。/admin/tokens でトークンを発行し、NAZO_AGENT_TOKEN=... を書いて chmod 600 してください。`,
    }
  }
  let text: string
  try {
    const st = fstatSync(fd)
    if (uid !== undefined && st.uid !== uid) {
      return {
        ok: false,
        message: `設定ファイル ${envFile} の所有者が実行ユーザーと違います。所有者を確かめてください。`,
      }
    }
    // group / other に 1 ビットでも権限があれば使わない
    if ((st.mode & 0o077) !== 0) {
      const m = (st.mode & 0o777).toString(8).padStart(3, '0')
      return {
        ok: false,
        message: `設定ファイル ${envFile} の権限が ${m} です。chmod 600 ${envFile} してから MCP サーバーを再起動してください。`,
      }
    }
    text = readFileSync(fd, 'utf8')
  } catch {
    return { ok: false, message: `設定ファイル ${envFile} が読めません。` }
  } finally {
    closeSync(fd)
  }
  const vars = parseEnv(text)
  const token = vars.NAZO_AGENT_TOKEN ?? ''
  if (!token) {
    return { ok: false, message: `設定ファイル ${envFile} に NAZO_AGENT_TOKEN がありません。` }
  }
  const rawBase = vars.NAZO_AGENT_BASE_URL || DEFAULT_BASE_URL
  const baseUrl = parseBaseUrl(rawBase)
  if (!baseUrl) {
    return {
      ok: false,
      message: `NAZO_AGENT_BASE_URL が使えません。https:// か、http://127.0.0.1 / http://localhost だけを指定できます。`,
    }
  }
  return { ok: true, config: { token, baseUrl, envFile } }
}
