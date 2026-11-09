// オーナー画面のフォーム入力の検証。全て trim し、空文字は NULL。ブラウザの required は補助で、正はここ。
// 各パーサは空でない値だけを受け取り、エラーは「{項目名}」に続く文で返す。

import type { Db } from '../db/client'
import {
  isLiveOrg,
  isLiveVenue,
  orgUniqueTaken,
  runEscapeUrlTaken,
  shopExists,
  shopUrlTaken,
  workOfficialUrlTaken,
} from '../db/master'
import {
  organizationAliasKinds,
  runChannels,
  shopKinds,
  workAliasKinds,
  workKinds,
} from '../db/schema'
import { prefectures } from '../lib/prefectures'

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
type Parser<T> = (raw: string) => Parsed<T>

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const ng = (error: string): Parsed<never> => ({ ok: false, error })

const URL_MAX = 2000
const NAME_MAX = 200
const NOTE_MAX = 4000
// 住所の上限は名前と同じにしている
const ADDRESS_MAX = 200
const PLAYERS_MAX = 99
const MINUTES_MAX = 6000
const PRICE_MAX = 999999

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

// url() のあと query/hash 除去・末尾 / 付与（host は url() で小文字）。re に合わなければ msg
const escapeUrl =
  (re: RegExp, msg: string): Parser<string> =>
  (raw) => {
    const base = url()(raw)
    if (!base.ok) return base
    const u = new URL(base.value)
    u.search = ''
    u.hash = ''
    if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`
    const s = u.href
    return re.test(s) ? ok(s) : ng(msg)
  }

// escape.id の団体 URL。正規化のあと https://escape.id/〇〇-org/ であること
export const escapeOrgUrl = (): Parser<string> =>
  escapeUrl(
    /^https:\/\/escape\.id\/[^/]+-org\/$/,
    'は https://escape.id/〇〇-org/ の形にしてください。',
  )

// escape.id のイベント URL（run）。正規化のあと https://escape.id/〇〇-org/e-〇〇/ であること
export const escapeRunUrl = (): Parser<string> =>
  escapeUrl(
    /^https:\/\/escape\.id\/[^/]+-org\/e-[^/]+\/$/,
    'は https://escape.id/〇〇-org/e-〇〇/ の形にしてください。',
  )

// 正規化済みの escape.id 団体 URL から slug（crazylemon-org → crazylemon）
export const slugOf = (escapeIdUrl: string | null): string | null => {
  if (!escapeIdUrl) return null
  const m = /^https:\/\/escape\.id\/([^/]+)-org\/$/.exec(escapeIdUrl)
  return m ? m[1] : null
}

// 1 項目を検証してエラーを errors に足す。空なら null（required なら「入力してください」）
const field = <T>(
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

// raw が空なら null。exists が false なら「見つからないか、統合済み」
const refId = async (
  errors: string[],
  label: string,
  raw: string,
  exists: (id: string) => Promise<boolean>,
): Promise<string | null> => {
  if (raw === '') return null
  if (await exists(raw)) return raw
  errors.push(`${label}が見つからないか、統合済みです。`)
  return null
}

const liveOrgId = (db: Db, errors: string[], label: string, raw: string) =>
  refId(errors, label, raw, (id) => isLiveOrg(db, id))

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const done = <T>(errors: string[], value: T): Validated<T> =>
  errors.length ? { ok: false, errors } : { ok: true, value }

// ---------------------------------------------------------------------------
// organization
// ---------------------------------------------------------------------------

export const orgFields = ['name', 'site_url', 'escape_id_url', 'note'] as const

export type OrgInput = {
  name: string
  siteUrl: string | null
  escapeIdUrl: string | null
  slug: string | null
  note: string | null
}

export const validateOrg = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const name = field(errors, '名前', f.name, str(NAME_MAX), true)
  const siteUrl = field(errors, '公式サイト', f.site_url, url())
  const escapeIdUrl = field(errors, 'escape.id の URL', f.escape_id_url, escapeOrgUrl())
  const note = field(errors, 'メモ', f.note, str(NOTE_MAX, { multiline: true }))
  const slug = slugOf(escapeIdUrl)
  if (escapeIdUrl && (await orgUniqueTaken(db, { escapeIdUrl, slug }, selfId))) {
    errors.push('同じ escape.id URL の団体があります。')
  }
  return done<OrgInput>(errors, { name: name ?? '', siteUrl, escapeIdUrl, slug, note })
}

export const orgAliasFields = ['name', 'kind', 'since', 'until'] as const

export type OrgAliasInput = {
  name: string
  kind: (typeof organizationAliasKinds)[number]
  since: string | null
  until: string | null
}

export const validateOrgAlias = (f: Form) => {
  const errors: string[] = []
  const name = field(errors, '別名', f.name, str(NAME_MAX), true)
  const kind = field(errors, '種類', f.kind, oneOf(organizationAliasKinds), true)
  const since = field(errors, '開始日', f.since, date())
  const until = field(errors, '終了日', f.until, date())
  if (since && until && since > until) errors.push('開始日は終了日より前にしてください。')
  return done<OrgAliasInput>(errors, {
    name: name ?? '',
    kind: kind ?? organizationAliasKinds[0],
    since,
    until,
  })
}

// ---------------------------------------------------------------------------
// venue / shop
// ---------------------------------------------------------------------------

export const venueFields = ['name', 'prefecture', 'address', 'organization_id'] as const

export type VenueInput = {
  name: string
  prefecture: string | null
  address: string | null
  organizationId: string | null
}

export const validateVenue = async (db: Db, f: Form) => {
  const errors: string[] = []
  const name = field(errors, '名前', f.name, str(NAME_MAX), true)
  const prefecture = field(errors, '都道府県', f.prefecture, oneOf(prefectures))
  const address = field(errors, '住所', f.address, str(ADDRESS_MAX))
  const organizationId = await liveOrgId(db, errors, '運営団体', f.organization_id)
  return done<VenueInput>(errors, { name: name ?? '', prefecture, address, organizationId })
}

export const shopFields = ['name', 'kind', 'url', 'organization_id'] as const

export type ShopInput = {
  name: string
  kind: (typeof shopKinds)[number]
  url: string | null
  organizationId: string | null
}

export const validateShop = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const name = field(errors, '名前', f.name, str(NAME_MAX), true)
  const kind = field(errors, '種類', f.kind, oneOf(shopKinds), true)
  const shopUrl = field(errors, 'URL', f.url, url())
  const organizationId = await liveOrgId(db, errors, '団体', f.organization_id)
  if (shopUrl && (await shopUrlTaken(db, shopUrl, selfId))) {
    errors.push('同じ URL の販売先があります。')
  }
  return done<ShopInput>(errors, {
    name: name ?? '',
    kind: kind ?? shopKinds[0],
    url: shopUrl,
    organizationId,
  })
}

// ---------------------------------------------------------------------------
// work / work_alias
// ---------------------------------------------------------------------------

export const workFields = [
  'title',
  'kind',
  'primary_organization_id',
  'official_url',
  'description',
  'player_min',
  'player_max',
  'estimated_minutes',
  'time_limit_minutes',
  'first_released_on',
] as const

export type WorkInput = {
  title: string
  kind: (typeof workKinds)[number] | null
  primaryOrganizationId: string | null
  officialUrl: string | null
  description: string | null
  playerMin: number | null
  playerMax: number | null
  estimatedMinutes: number | null
  timeLimitMinutes: number | null
  firstReleasedOn: string | null
}

// kind は空（未設定）を許す
export const validateWork = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const title = field(errors, '題名', f.title, str(NAME_MAX), true)
  const kind = field(errors, '形式', f.kind, oneOf(workKinds))
  const primaryOrganizationId = await liveOrgId(db, errors, '団体', f.primary_organization_id)
  const officialUrl = field(errors, '公式サイト', f.official_url, url())
  const description = field(errors, '説明', f.description, str(NOTE_MAX, { multiline: true }))
  const playerMin = field(errors, '最少人数', f.player_min, int(1, PLAYERS_MAX))
  const playerMax = field(errors, '最多人数', f.player_max, int(1, PLAYERS_MAX))
  const estimatedMinutes = field(errors, '所要時間', f.estimated_minutes, int(1, MINUTES_MAX))
  const timeLimitMinutes = field(errors, '制限時間', f.time_limit_minutes, int(1, MINUTES_MAX))
  const firstReleasedOn = field(errors, '初演・発売日', f.first_released_on, date())
  if (playerMin !== null && playerMax !== null && playerMin > playerMax) {
    errors.push('最少人数は最多人数以下にしてください。')
  }
  if (officialUrl && (await workOfficialUrlTaken(db, officialUrl, selfId))) {
    errors.push('同じ公式サイトの作品があります。')
  }
  return done<WorkInput>(errors, {
    title: title ?? '',
    kind,
    primaryOrganizationId,
    officialUrl,
    description,
    playerMin,
    playerMax,
    estimatedMinutes,
    timeLimitMinutes,
    firstReleasedOn,
  })
}

export const workAliasFields = ['title', 'kind'] as const

export type WorkAliasInput = {
  title: string
  kind: (typeof workAliasKinds)[number]
}

export const validateWorkAlias = (f: Form) => {
  const errors: string[] = []
  const title = field(errors, '別名', f.title, str(NAME_MAX), true)
  const kind = field(errors, '種類', f.kind, oneOf(workAliasKinds), true)
  return done<WorkAliasInput>(errors, { title: title ?? '', kind: kind ?? workAliasKinds[0] })
}

// ---------------------------------------------------------------------------
// run（work_id はフォームに出さず URL から）
// ---------------------------------------------------------------------------

export const runFields = [
  'channel',
  'organization_id',
  'billed_as',
  'venue_id',
  'shop_id',
  'start_on',
  'end_on',
  'is_permanent',
  'escape_id_url',
  'ticket_url',
  'price_yen',
  'escape_type_raw',
  'note',
] as const

export type RunInput = {
  channel: (typeof runChannels)[number]
  organizationId: string | null
  billedAs: string | null
  venueId: string | null
  shopId: string | null
  startOn: string | null
  endOn: string | null
  isPermanent: number
  escapeIdUrl: string | null
  ticketUrl: string | null
  priceYen: number | null
  escapeTypeRaw: string | null
  note: string | null
}

// channel の制約は schema の CHECK と同じ（sale → shop_id 必須、venue_id は performance のみ、shop_id は sale のみ）。
// 加えて is_permanent は performance のみ
export const validateRun = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const channel = field(errors, '種別', f.channel, oneOf(runChannels), true)
  const organizationId = await liveOrgId(db, errors, '名義団体', f.organization_id)
  const billedAs = field(errors, '名義の表記', f.billed_as, str(NAME_MAX))
  const venueId = await refId(errors, '会場', f.venue_id, (id) => isLiveVenue(db, id))
  const shopId = await refId(errors, '販売先', f.shop_id, (id) => shopExists(db, id))
  const startOn = field(errors, '開始日', f.start_on, date())
  const endOn = field(errors, '終了日', f.end_on, date())
  const permanent = field(errors, '常設', f.is_permanent, oneOf(['1']))
  const escapeIdUrl = field(errors, 'escape.id の URL', f.escape_id_url, escapeRunUrl())
  const ticketUrl = field(errors, 'チケットの URL', f.ticket_url, url())
  const priceYen = field(errors, '価格', f.price_yen, int(0, PRICE_MAX))
  const escapeTypeRaw = field(errors, 'escape.id の type', f.escape_type_raw, str(NAME_MAX))
  const note = field(errors, 'メモ', f.note, str(NOTE_MAX, { multiline: true }))
  if (channel === 'sale' && f.shop_id === '') errors.push('販売では販売先を選んでください。')
  if (channel && channel !== 'performance' && f.venue_id !== '') {
    errors.push('会場は公演のときだけ選べます。')
  }
  if (channel && channel !== 'sale' && f.shop_id !== '') {
    errors.push('販売先は販売のときだけ選べます。')
  }
  if (channel && channel !== 'performance' && permanent) {
    errors.push('常設は公演のときだけ選べます。')
  }
  if (startOn && endOn && startOn > endOn) errors.push('開始日は終了日より前にしてください。')
  if (escapeIdUrl && (await runEscapeUrlTaken(db, escapeIdUrl, selfId))) {
    errors.push('同じ escape.id URL の回があります。')
  }
  return done<RunInput>(errors, {
    channel: channel ?? runChannels[0],
    organizationId,
    billedAs,
    venueId,
    shopId,
    startOn,
    endOn,
    isPermanent: permanent ? 1 : 0,
    escapeIdUrl,
    ticketUrl,
    priceYen,
    escapeTypeRaw,
    note,
  })
}
