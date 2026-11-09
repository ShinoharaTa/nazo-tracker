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
