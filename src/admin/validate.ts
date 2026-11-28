// オーナー画面のフォーム入力の検証。全て trim し、空文字は NULL。ブラウザの required は補助で、正はここ。
// 各パーサは空でない値だけを受け取り、エラーは「{項目名}」に続く文で返す。
// 共通の部品は src/lib/form.ts（ここから re-export する）。

import type { Db } from '../db/client'
import {
  isLiveOrg,
  isLiveVenue,
  liveOrgImageBlocked,
  orgAliasNormTaken,
  orgUniqueTaken,
  runEscapeUrlTaken,
  shopExists,
  shopUrlTaken,
  workAliasNormTaken,
  workOfficialUrlTaken,
} from '../db/master'
import {
  organizationAliasKinds,
  runChannels,
  shopKinds,
  workAliasKinds,
  workKinds,
} from '../db/schema'
import {
  date,
  done,
  type Form,
  field,
  int,
  ng,
  ok,
  oneOf,
  type Parser,
  str,
  url,
} from '../lib/form'
import { imagePageUrl, imageUrl } from '../lib/image-url'
import { norm } from '../lib/norm'
import { prefectures } from '../lib/prefectures'

export {
  date,
  emptyForm,
  type Form,
  formOf,
  int,
  ng,
  ok,
  oneOf,
  type Parsed,
  type Parser,
  str,
  url,
  type Validated,
} from '../lib/form'

const NAME_MAX = 200
const NOTE_MAX = 4000
// 住所の上限は名前と同じにしている
const ADDRESS_MAX = 200
const PLAYERS_MAX = 99
const MINUTES_MAX = 6000
const PRICE_MAX = 999999

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

// ---------------------------------------------------------------------------
// マスタの画像（作品の画像・団体のロゴ。URL だけを持つ。docs/design.md §3.4.2）
// ---------------------------------------------------------------------------

// 「画像を載せない」の値（チェックボックス。空なら載せる）
export const imageBlockedValues = ['1'] as const

// 画像の URL と取得元の項目名（作品 / 団体）
export const workImageFields = ['image_url', 'image_page_url'] as const
export const orgImageFields = ['logo_url', 'logo_page_url'] as const

// オーナーのフォームで「画像を載せない」にチェックした保存は、URL が残っていても空にして保存する
// （載せない設定の行に URL があるエラーは agent の提案でだけ出す）
export const clearBlockedImage = (f: Form, fields: readonly [string, string]): Form =>
  f.image_blocked === '1' ? { ...f, [fields[0]]: '', [fields[1]]: '' } : f

// 画像の URL と取得元（label は「画像」か「ロゴ」）。組で入れる・載せない設定の行には入れない
const imageOf = (
  errors: string[],
  label: string,
  rawUrl: string,
  rawPage: string,
  rawBlocked: string,
) => {
  const imgUrl = field(errors, label, rawUrl, imageUrl())
  const pageUrl = field(errors, `${label}の取得元`, rawPage, imagePageUrl())
  const blocked = field(errors, '画像を載せない', rawBlocked, oneOf(imageBlockedValues))
  if ((rawUrl === '') !== (rawPage === '')) {
    errors.push(`${label}と${label}の取得元は両方入れてください。`)
  }
  if (blocked && rawUrl !== '') {
    errors.push(`画像を載せない設定です。${label}の URL を空にしてください。`)
  }
  return { imgUrl, pageUrl, blocked: blocked ? 1 : 0 }
}

// ---------------------------------------------------------------------------
// organization
// ---------------------------------------------------------------------------

export const orgFields = [
  'name',
  'site_url',
  'escape_id_url',
  'note',
  'logo_url',
  'logo_page_url',
  'image_blocked',
] as const

export type OrgInput = {
  name: string
  siteUrl: string | null
  escapeIdUrl: string | null
  slug: string | null
  note: string | null
  logoUrl: string | null
  logoPageUrl: string | null
  imageBlocked: number
}

export const validateOrg = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const name = field(errors, '名前', f.name, str(NAME_MAX), true)
  const siteUrl = field(errors, '公式サイト', f.site_url, url())
  const escapeIdUrl = field(errors, 'escape.id の URL', f.escape_id_url, escapeOrgUrl())
  const note = field(errors, 'メモ', f.note, str(NOTE_MAX, { multiline: true }))
  const logo = imageOf(errors, 'ロゴ', f.logo_url, f.logo_page_url, f.image_blocked)
  const slug = slugOf(escapeIdUrl)
  if (escapeIdUrl && (await orgUniqueTaken(db, { escapeIdUrl, slug }, selfId))) {
    errors.push('同じ escape.id URL の団体があります。')
  }
  return done<OrgInput>(errors, {
    name: name ?? '',
    siteUrl,
    escapeIdUrl,
    slug,
    note,
    logoUrl: logo.imgUrl,
    logoPageUrl: logo.pageUrl,
    imageBlocked: logo.blocked,
  })
}

export const orgAliasFields = ['name', 'kind', 'since', 'until'] as const

// 別名の追加で、同じ親に同じ表記（*_norm）の別名があるとき（団体・作品共通）
export const ALIAS_TAKEN = '同じ別名がすでにあります。'

export type OrgAliasInput = {
  name: string
  kind: (typeof organizationAliasKinds)[number]
  since: string | null
  until: string | null
}

export const validateOrgAlias = async (db: Db, f: Form, organizationId: string) => {
  const errors: string[] = []
  const name = field(errors, '別名', f.name, str(NAME_MAX), true)
  const kind = field(errors, '種類', f.kind, oneOf(organizationAliasKinds), true)
  const since = field(errors, '開始日', f.since, date())
  const until = field(errors, '終了日', f.until, date())
  if (since && until && since > until) errors.push('開始日は終了日より前にしてください。')
  if (name && (await orgAliasNormTaken(db, organizationId, norm(name)))) {
    errors.push(ALIAS_TAKEN)
  }
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
  'image_url',
  'image_page_url',
  'image_blocked',
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
  imageUrl: string | null
  imagePageUrl: string | null
  imageBlocked: number
}

export const validateWork = async (db: Db, f: Form, selfId?: string) => {
  const errors: string[] = []
  const title = field(errors, '題名', f.title, str(NAME_MAX), true)
  // kind は任意（親の決定: 形式不明のまま登録できるように。P4 の提案も NULL で入る）
  const kind = field(errors, '形式', f.kind, oneOf(workKinds))
  // 団体の存在確認と「画像を載せない」を同じ 1 クエリで読む（まとめて承認のクエリ数を増やさない）
  let orgImageBlocked = false
  const primaryOrganizationId = await refId(
    errors,
    '団体',
    f.primary_organization_id,
    async (id) => {
      const blocked = await liveOrgImageBlocked(db, id)
      orgImageBlocked = blocked === true
      return blocked !== null
    },
  )
  const officialUrl = field(errors, '公式サイト', f.official_url, url())
  const description = field(errors, '説明', f.description, str(NOTE_MAX, { multiline: true }))
  const playerMin = field(errors, '最少人数', f.player_min, int(1, PLAYERS_MAX))
  const playerMax = field(errors, '最多人数', f.player_max, int(1, PLAYERS_MAX))
  const estimatedMinutes = field(errors, '所要時間', f.estimated_minutes, int(1, MINUTES_MAX))
  const timeLimitMinutes = field(errors, '制限時間', f.time_limit_minutes, int(1, MINUTES_MAX))
  const firstReleasedOn = field(errors, '初演・発売日', f.first_released_on, date())
  const image = imageOf(errors, '画像', f.image_url, f.image_page_url, f.image_blocked)
  if (orgImageBlocked && f.image_url !== '') errors.push('この団体は画像を載せない設定です。')
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
    imageUrl: image.imgUrl,
    imagePageUrl: image.pageUrl,
    imageBlocked: image.blocked,
  })
}

export const workAliasFields = ['title', 'kind'] as const

export type WorkAliasInput = {
  title: string
  kind: (typeof workAliasKinds)[number]
}

export const validateWorkAlias = async (db: Db, f: Form, workId: string) => {
  const errors: string[] = []
  const title = field(errors, '別名', f.title, str(NAME_MAX), true)
  const kind = field(errors, '種類', f.kind, oneOf(workAliasKinds), true)
  if (title && (await workAliasNormTaken(db, workId, norm(title)))) errors.push(ALIAS_TAKEN)
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

// 常設の値（チェックボックス。空なら常設でない）
export const permanentValues = ['1'] as const

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
  const permanent = field(errors, '常設', f.is_permanent, oneOf(permanentValues))
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
