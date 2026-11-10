// フォーム入力の検証の部品。全て trim し、空文字は NULL。ブラウザの required は補助で、正はサーバー側。
// 各パーサは空でない値だけを受け取り、エラーは「{項目名}」に続く文で返す。
// オーナー画面（src/admin/validate.ts）と記録（src/records/validate.ts）で共有する。

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
export type Parser<T> = (raw: string) => Parsed<T>

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
export const ng = (error: string): Parsed<never> => ({ ok: false, error })

const URL_MAX = 2000

export type Form = Record<string, string>

// フォームの値を文字列だけにして trim。File や欠けた項目は空文字
export const formOf = (body: Record<string, unknown>, names: readonly string[]): Form => {
  const out: Form = {}
  for (const n of names) {
    const v = body[n]
    out[n] = typeof v === 'string' ? v.trim() : ''
  }
  return out
}

// 新規作成フォームの初期値
export const emptyForm = (names: readonly string[]): Form =>
  Object.fromEntries(names.map((n) => [n, '']))

// 長さはコードポイントで数える。制御文字は不可（multiline のときだけ改行 \r \n を許す）
export const str =
  (max: number, { multiline = false }: { multiline?: boolean } = {}): Parser<string> =>
  (raw) => {
    const rest = multiline ? raw.replace(/[\r\n]/g, '') : raw
    if (/\p{Cc}/u.test(rest)) return ng('に改行や制御文字は使えません。')
    if ([...raw].length > max) return ng(`は ${max} 文字以内にしてください。`)
    return ok(raw)
  }

// http(s) の絶対 URL だけ（href に出すため javascript: などは拒否）。保存値は正規化後の href。
// new URL() はタブ・改行を黙って除去するので、空白を含む入力は先に拒否する
export const url = (): Parser<string> => (raw) => {
  if (raw.length > URL_MAX) return ng(`は ${URL_MAX} 文字以内にしてください。`)
  if (/\s/.test(raw)) return ng('に空白は使えません。')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return ng('は http:// か https:// で始まる URL にしてください。')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return ng('は http:// か https:// で始まる URL にしてください。')
  }
  return ok(u.href)
}

// YYYY-MM-DD で実在する日
export const date = (): Parser<string> => (raw) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const t = new Date(Date.UTC(y, mo - 1, d))
    if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) {
      return ok(raw)
    }
  }
  return ng('は YYYY-MM-DD の形の実在する日付にしてください。')
}

export const int =
  (min: number, max: number): Parser<number> =>
  (raw) => {
    if (!/^-?\d{1,9}$/.test(raw)) return ng('は整数で入力してください。')
    const n = Number(raw)
    if (n < min || n > max) return ng(`は ${min}〜${max} にしてください。`)
    return ok(n)
  }

export const oneOf =
  <T extends string>(values: readonly T[]): Parser<T> =>
  (raw) =>
    (values as readonly string[]).includes(raw) ? ok(raw as T) : ng('の値が正しくありません。')

// 1 項目を検証してエラーを errors に足す。空なら null（required なら「入力してください」）
export const field = <T>(
  errors: string[],
  label: string,
  raw: string,
  parse: Parser<T>,
  required = false,
): T | null => {
  if (raw === '') {
    if (required) errors.push(`${label}を入力してください。`)
    return null
  }
  const r = parse(raw)
  if (!r.ok) {
    errors.push(`${label}${r.error}`)
    return null
  }
  return r.value
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export const done = <T>(errors: string[], value: T): Validated<T> =>
  errors.length ? { ok: false, errors } : { ok: true, value }
