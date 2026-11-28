// agent API の HTTP クライアント。Bearer を付けて JSON を送受信するだけ（値の検証は Worker に任せる）。
// トークンは Authorization ヘッダにだけ載せ、エラーの文言・本文には入れない。

import type { Config } from './config.js'

export const TIMEOUT_MS = 20_000

// API の失敗。status 0 は応答が無かった（ネットワーク・タイムアウト・送る前の失敗）。code は本文の error（無ければ http_<status>）
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(status ? `HTTP ${status} ${code}` : code)
  }
}

export type Query = Record<string, string | number | undefined>

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

// ヘッダに載せられるトークン（空白・改行・非 ASCII を含まない）
const TOKEN_FORMAT = /^[\x21-\x7e]+$/

const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

// やり直してよい失敗（応答が無い・5xx）。送る前の失敗やリダイレクトはやり直しても同じ
const retriable = (e: ApiError) =>
  e.status >= 500 || e.code === 'timeout' || e.code === 'network_error'

export class ApiClient {
  readonly host: string

  constructor(
    private readonly config: Pick<Config, 'token' | 'baseUrl'>,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.host = new URL(config.baseUrl).host
  }

  // path は /api/agent より後ろ（/whoami など）。undefined と空文字のクエリは付けない
  url(path: string, query: Query = {}): string {
    const u = new URL(`/api/agent${path}`, this.config.baseUrl)
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  get(path: string, query?: Query): Promise<Record<string, unknown>> {
    return this.request('GET', path, query)
  }

  post(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request('POST', path, undefined, body)
  }

  patch(path: string, body: unknown): Promise<Record<string, unknown>> {
    return this.request('PATCH', path, undefined, body)
  }

  // GET だけ、応答が無いか 5xx のとき 1 回だけやり直す。POST / PATCH は二重に書くのでやり直さない
  async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const tries = method === 'GET' ? 2 : 1
    let last: ApiError | null = null
    for (let i = 0; i < tries; i++) {
      try {
        return await this.once(method, this.url(path, query), body)
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        last = e
        if (!retriable(e)) throw e
      }
    }
    throw last as ApiError
  }

  private async once(method: string, url: string, body: unknown): Promise<Record<string, unknown>> {
    if (!TOKEN_FORMAT.test(this.config.token)) throw new ApiError(0, 'invalid_token_format', null)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        // 転送先へは行かない（Bearer を別の場所へ送らない）。3xx はそのまま受けて redirect にする
        redirect: 'manual',
      })
    } catch (e) {
      throw new ApiError(0, isTimeout(e) ? 'timeout' : 'network_error', null)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      throw new ApiError(res.status, 'redirect', null)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch (e) {
      // 本文の受信中に時間切れになったのは timeout（JSON でないだけなら下の invalid_response）
      if (isTimeout(e)) throw new ApiError(0, 'timeout', null)
      json = null
    }
    if (!res.ok) {
      const b = isObj(json) ? json : null
      const code = typeof b?.error === 'string' ? b.error : `http_${res.status}`
      throw new ApiError(res.status, code, b)
    }
    if (!isObj(json)) throw new ApiError(res.status, 'invalid_response', null)
    return json
  }
}
