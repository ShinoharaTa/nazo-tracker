const toBase64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

// 推測不能なトークン。32 バイトで 43 文字
export const randomToken = (bytes = 32): string =>
  toBase64url(crypto.getRandomValues(new Uint8Array(bytes)))

export const sha256Base64url = async (value: string): Promise<string> =>
  toBase64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  )

// 招待コード（friend_code）の文字種。見間違えやすい l・o・0・1 を除いた 32 種で、1 文字 5 bit
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

// 招待コードの書式（16 文字 = 80 bit）。照合はここ 1 か所の正規表現で行う
export const FRIEND_CODE_LENGTH = 16
export const FRIEND_CODE_RE = /^[a-km-np-z2-9]{16}$/

// 各バイトの下位 5 bit で CODE_CHARS を引く（256 は 32 の倍数なので偏らない）
export const randomCode = (length: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => CODE_CHARS[b & 31]).join('')
