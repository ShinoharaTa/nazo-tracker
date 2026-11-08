// スキーマ v1。定義の出典は docs/data-model.md と docs/auth.md。
// ID は ULID の TEXT、日時は ISO 8601 TEXT（UTC）、日付は YYYY-MM-DD TEXT、真偽は INTEGER 0/1。
// 文書で NOT NULL / 既定値が明示されていない列は NULL 可・既定値なしで置いている。

import { type SQL, sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// CHECK 用: 列が列挙値のいずれか（NULL は通る）
const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`"${column}" IN (${values.map((v) => `'${v}'`).join(', ')})`)

// CHECK 用: 真偽値 0/1
const bool01 = (column: string): SQL => sql.raw(`"${column}" IN (0, 1)`)

// CHECK 用: 1-5 の評価値
const score1to5 = (column: string): SQL => sql.raw(`"${column}" BETWEEN 1 AND 5`)

// ---------------------------------------------------------------------------
// 列挙値
// ---------------------------------------------------------------------------

export const organizationAliasKinds = ['former_name', 'alt_spelling', 'label'] as const
export const workKinds = ['hall', 'room', 'stroll', 'line', 'web', 'takeaway', 'other'] as const
export const workAliasKinds = ['former_title', 'alt_spelling', 'subtitle'] as const
export const shopKinds = ['booth', 'official_store', 'physical_store', 'other'] as const
export const runChannels = ['performance', 'online', 'sale'] as const
export const attemptStatuses = ['purchased', 'in_progress', 'cleared', 'failed', 'dropped'] as const
export const shareOverrides = ['hidden', 'status', 'rating', 'memo'] as const
export const imageKinds = ['key_visual', 'clear_panel', 'other'] as const
export const friendRequestStatuses = ['pending', 'accepted', 'declined', 'canceled'] as const
export const requestKinds = [
  'new_work',
  'fix_work',
  'new_organization',
  'new_shop',
  'new_booth',
  'new_room_venue',
  'new_genre',
  'import_trailcast',
  'other',
] as const
export const requestStatuses = [
  'open',
  'triaged',
  'rejected',
  'processing',
  'proposed',
  'done',
  'needs_info',
] as const
export const sourceMethods = ['escape_mcp', 'webfetch', 'manual', 'pds'] as const
export const proposalKinds = ['create', 'update', 'link', 'merge', 'create_attempt_import'] as const
export const proposalStatuses = [
  'pending',
  'applied',
  'auto_applied',
  'rejected',
  'superseded',
  'suppressed',
] as const
export const apiTokenRoles = ['agent'] as const
export const userRoles = ['member', 'owner'] as const
export const shareLevels = ['none', 'status', 'rating', 'memo'] as const
export const oauthStateModes = ['login', 'link'] as const

// ---------------------------------------------------------------------------
// マスタ（data-model.md §2）
// ---------------------------------------------------------------------------

export const organization = sqliteTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
    slug: text('slug').unique(),
    siteUrl: text('site_url'),
    escapeIdUrl: text('escape_id_url').unique(),
    note: text('note'),
    mergedIntoId: text('merged_into_id').references((): AnySQLiteColumn => organization.id),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (t) => [index('organization_name_norm_idx').on(t.nameNorm)],
)

export const organizationAlias = sqliteTable(
  'organization_alias',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').references(() => organization.id),
    name: text('name'),
    nameNorm: text('name_norm'),
    kind: text('kind', { enum: organizationAliasKinds }),
    since: text('since'),
    until: text('until'),
  },
  (t) => [
    index('organization_alias_name_norm_idx').on(t.nameNorm),
    check('organization_alias_kind_check', oneOf('kind', organizationAliasKinds)),
  ],
)

export const work = sqliteTable(
  'work',
  {
    id: text('id').primaryKey(),
    title: text('title'),
    titleNorm: text('title_norm'),
    kind: text('kind', { enum: workKinds }),
    primaryOrganizationId: text('primary_organization_id').references(() => organization.id),
    officialUrl: text('official_url').unique(),
    description: text('description'),
    playerMin: integer('player_min'),
    playerMax: integer('player_max'),
    estimatedMinutes: integer('estimated_minutes'),
    timeLimitMinutes: integer('time_limit_minutes'),
    firstReleasedOn: text('first_released_on'),
    mergedIntoId: text('merged_into_id').references((): AnySQLiteColumn => work.id),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (t) => [
    index('work_title_norm_idx').on(t.titleNorm),
    check('work_kind_check', oneOf('kind', workKinds)),
  ],
)

export const workAlias = sqliteTable(
  'work_alias',
  {
    id: text('id').primaryKey(),
    workId: text('work_id').references(() => work.id),
    title: text('title'),
    titleNorm: text('title_norm'),
    kind: text('kind', { enum: workAliasKinds }),
  },
  () => [check('work_alias_kind_check', oneOf('kind', workAliasKinds))],
)

export const venue = sqliteTable('venue', {
  id: text('id').primaryKey(),
  name: text('name'),
  nameNorm: text('name_norm'),
  prefecture: text('prefecture'),
  address: text('address'),
  organizationId: text('organization_id').references(() => organization.id),
  mergedIntoId: text('merged_into_id').references((): AnySQLiteColumn => venue.id),
})

export const shop = sqliteTable(
  'shop',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    kind: text('kind', { enum: shopKinds }),
    url: text('url').unique(),
    organizationId: text('organization_id').references(() => organization.id),
  },
  () => [check('shop_kind_check', oneOf('kind', shopKinds))],
)

export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    workId: text('work_id')
      .notNull()
      .references(() => work.id),
    channel: text('channel', { enum: runChannels }),
    organizationId: text('organization_id').references(() => organization.id),
    billedAs: text('billed_as'),
    venueId: text('venue_id').references(() => venue.id),
    shopId: text('shop_id').references(() => shop.id),
    startOn: text('start_on'),
    endOn: text('end_on'),
    isPermanent: integer('is_permanent'),
    escapeIdUrl: text('escape_id_url').unique(),
    ticketUrl: text('ticket_url'),
    priceYen: integer('price_yen'),
    escapeTypeRaw: text('escape_type_raw'),
    note: text('note'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  () => [
    check('run_channel_check', oneOf('channel', runChannels)),
    check('run_is_permanent_check', bool01('is_permanent')),
    // channel='sale' → shop_id 必須
    check('run_sale_shop_check', sql`"channel" <> 'sale' OR "shop_id" IS NOT NULL`),
  ],
)

export const market = sqliteTable('market', {
  id: text('id').primaryKey(),
  name: text('name'),
  nameNorm: text('name_norm'),
  siteUrl: text('site_url'),
})

export const marketEdition = sqliteTable('market_edition', {
  id: text('id').primaryKey(),
  marketId: text('market_id').references(() => market.id),
  label: text('label'),
  startOn: text('start_on'),
  endOn: text('end_on'),
  venueId: text('venue_id').references(() => venue.id),
  escapeIdUrl: text('escape_id_url'),
  sourceUrl: text('source_url'),
  externalKey: text('external_key'),
})

export const booth = sqliteTable(
  'booth',
  {
    id: text('id').primaryKey(),
    marketEditionId: text('market_edition_id').references(() => marketEdition.id),
    organizationId: text('organization_id').references(() => organization.id),
    nameAsListed: text('name_as_listed'),
    boothNo: text('booth_no'),
    detailUrl: text('detail_url'),
    days: text('days'),
  },
  (t) => [unique('booth_market_edition_detail_url_unique').on(t.marketEditionId, t.detailUrl)],
)

export const boothItem = sqliteTable('booth_item', {
  id: text('id').primaryKey(),
  boothId: text('booth_id').references(() => booth.id),
  workId: text('work_id').references(() => work.id),
  titleAsListed: text('title_as_listed'),
  priceYen: integer('price_yen'),
})

// ---------------------------------------------------------------------------
// 認証（auth.md §2）
// ---------------------------------------------------------------------------

export const user = sqliteTable(
  'user',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name'),
    role: text('role', { enum: userRoles }),
    friendCode: text('friend_code'),
    defaultShareLevel: text('default_share_level', { enum: shareLevels }).default('status'),
    excludeFromCounts: integer('exclude_from_counts').default(0),
    createdAt: text('created_at'),
    lastSeenAt: text('last_seen_at'),
    deletedAt: text('deleted_at'),
  },
  () => [
    check('user_role_check', oneOf('role', userRoles)),
    check('user_default_share_level_check', oneOf('default_share_level', shareLevels)),
    check('user_exclude_from_counts_check', bool01('exclude_from_counts')),
  ],
)

export const identity = sqliteTable(
  'identity',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: text('user_id').references(() => user.id),
    createdAt: text('created_at'),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
)

// ログインセッション。auth.md では `session` だが、進行ログの `session` と衝突するため
// data-model.md §3 の表記に合わせて `session_token` とする。
export const sessionToken = sqliteTable('session_token', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => user.id),
  expiresAt: text('expires_at'),
  createdAt: text('created_at'),
  uaHint: text('ua_hint'),
})

export const oauthState = sqliteTable(
  'oauth_state',
  {
    state: text('state').primaryKey(),
    provider: text('provider'),
    codeVerifier: text('code_verifier'),
    mode: text('mode', { enum: oauthStateModes }),
    userId: text('user_id').references(() => user.id),
    expiresAt: text('expires_at'),
  },
  () => [check('oauth_state_mode_check', oneOf('mode', oauthStateModes))],
)

export const recoveryCode = sqliteTable('recovery_code', {
  userId: text('user_id').references(() => user.id),
  codeHash: text('code_hash'),
  usedAt: text('used_at'),
})

// ---------------------------------------------------------------------------
// ユーザー領域（data-model.md §3）
// ---------------------------------------------------------------------------

export const attempt = sqliteTable(
  'attempt',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    workId: text('work_id')
      .notNull()
      .references(() => work.id),
    runId: text('run_id').references(() => run.id),
    status: text('status', { enum: attemptStatuses }),
    purchasedOn: text('purchased_on'),
    attemptNo: integer('attempt_no'),
    startedOn: text('started_on'),
    finishedOn: text('finished_on'),
    durationSec: integer('duration_sec'),
    partySize: integer('party_size'),
    companions: text('companions'),
    rating: integer('rating'),
    difficulty: integer('difficulty'),
    volume: integer('volume'),
    memo: text('memo'),
    spoilerMemo: text('spoiler_memo'),
    shareOverride: text('share_override', { enum: shareOverrides }),
    sourceRef: text('source_ref'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (t) => [
    unique('attempt_user_source_ref_unique').on(t.userId, t.sourceRef),
    index('attempt_user_status_idx').on(t.userId, t.status),
    index('attempt_user_finished_on_idx').on(t.userId, t.finishedOn),
    index('attempt_user_work_idx').on(t.userId, t.workId),
    index('attempt_work_status_user_idx').on(t.workId, t.status, t.userId),
    check('attempt_status_check', oneOf('status', attemptStatuses)),
    check('attempt_share_override_check', oneOf('share_override', shareOverrides)),
    check('attempt_rating_check', score1to5('rating')),
    check('attempt_difficulty_check', score1to5('difficulty')),
    check('attempt_volume_check', score1to5('volume')),
  ],
)

export const genre = sqliteTable(
  'genre',
  {
    id: text('id').primaryKey(),
    label: text('label'),
    sortOrder: integer('sort_order'),
    archived: integer('archived'),
  },
  () => [check('genre_archived_check', bool01('archived'))],
)

export const attemptGenre = sqliteTable(
  'attempt_genre',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempt.id),
    genreId: text('genre_id')
      .notNull()
      .references(() => genre.id),
    userId: text('user_id').references(() => user.id),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.genreId] }),
    index('attempt_genre_user_genre_idx').on(t.userId, t.genreId),
  ],
)

export const image = sqliteTable(
  'image',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => user.id),
    attemptId: text('attempt_id').references(() => attempt.id),
    kind: text('kind', { enum: imageKinds }),
    spoiler: integer('spoiler'),
    r2Key: text('r2_key'),
    thumbR2Key: text('thumb_r2_key'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    contentType: text('content_type'),
    removedAt: text('removed_at'),
    removedReason: text('removed_reason'),
    createdAt: text('created_at'),
  },
  () => [
    check('image_kind_check', oneOf('kind', imageKinds)),
    check('image_spoiler_check', bool01('spoiler')),
  ],
)

export const imageReport = sqliteTable('image_report', {
  id: text('id').primaryKey(),
  imageId: text('image_id').references(() => image.id),
  reporterUserId: text('reporter_user_id').references(() => user.id),
  reason: text('reason'),
  createdAt: text('created_at'),
})

export const friendRequest = sqliteTable(
  'friend_request',
  {
    id: text('id').primaryKey(),
    fromUserId: text('from_user_id').references(() => user.id),
    toUserId: text('to_user_id').references(() => user.id),
    status: text('status', { enum: friendRequestStatuses }),
    createdAt: text('created_at'),
    respondedAt: text('responded_at'),
  },
  (t) => [
    uniqueIndex('friend_request_pending_unique')
      .on(t.fromUserId, t.toUserId)
      .where(sql`"status" = 'pending'`),
    check('friend_request_status_check', oneOf('status', friendRequestStatuses)),
  ],
)

export const friendship = sqliteTable(
  'friendship',
  {
    userLo: text('user_lo')
      .notNull()
      .references(() => user.id),
    userHi: text('user_hi')
      .notNull()
      .references(() => user.id),
    createdAt: text('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userLo, t.userHi] }),
    check('friendship_order_check', sql`"user_lo" < "user_hi"`),
  ],
)

export const block = sqliteTable('block', {
  userId: text('user_id').references(() => user.id),
  blockedUserId: text('blocked_user_id').references(() => user.id),
  createdAt: text('created_at'),
})

// 進行ログ
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  attemptId: text('attempt_id').references(() => attempt.id),
  userId: text('user_id').references(() => user.id),
  playedOn: text('played_on').notNull(),
  startedAt: text('started_at'),
  endedAt: text('ended_at'),
  durationSec: integer('duration_sec'),
  progressNote: text('progress_note'),
  companions: text('companions'),
  memo: text('memo'),
  venueId: text('venue_id').references(() => venue.id),
  locationText: text('location_text'),
  createdAt: text('created_at'),
})

export const wishlist = sqliteTable(
  'wishlist',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    workId: text('work_id')
      .notNull()
      .references(() => work.id),
    memo: text('memo'),
    createdAt: text('created_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] }), index('wishlist_work_idx').on(t.workId)],
)

export const marketVisit = sqliteTable('market_visit', {
  id: text('id').primaryKey(),
  userId: text('user_id').references(() => user.id),
  marketEditionId: text('market_edition_id').references(() => marketEdition.id),
  visitedOn: text('visited_on'),
  memo: text('memo'),
})

// ---------------------------------------------------------------------------
// 補完パイプライン（data-model.md §4）
// ---------------------------------------------------------------------------

export const request = sqliteTable(
  'request',
  {
    id: text('id').primaryKey(),
    requesterUserId: text('requester_user_id').references(() => user.id),
    kind: text('kind', { enum: requestKinds }),
    payloadJson: text('payload_json'),
    status: text('status', { enum: requestStatuses }),
    triageNote: text('triage_note'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  () => [
    check('request_kind_check', oneOf('kind', requestKinds)),
    check('request_status_check', oneOf('status', requestStatuses)),
  ],
)

export const source = sqliteTable(
  'source',
  {
    id: text('id').primaryKey(),
    url: text('url'),
    domain: text('domain'),
    method: text('method', { enum: sourceMethods }),
    fetchedAt: text('fetched_at'),
    contentHash: text('content_hash'),
    excerpt: text('excerpt'),
    robotsChecked: integer('robots_checked'),
  },
  () => [
    check('source_method_check', oneOf('method', sourceMethods)),
    check('source_robots_checked_check', bool01('robots_checked')),
  ],
)

export const apiToken = sqliteTable(
  'api_token',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    tokenHash: text('token_hash'),
    role: text('role', { enum: apiTokenRoles }),
    scopesJson: text('scopes_json'),
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  () => [check('api_token_role_check', oneOf('role', apiTokenRoles))],
)

export const proposal = sqliteTable(
  'proposal',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').references(() => request.id),
    kind: text('kind', { enum: proposalKinds }),
    targetTable: text('target_table'),
    targetId: text('target_id'),
    confidence: real('confidence'),
    status: text('status', { enum: proposalStatuses }),
    // 文書では「UNIQUE-ish」。一意制約にするか未確定のため通常の INDEX にしている
    fingerprint: text('fingerprint'),
    matchCandidatesJson: text('match_candidates_json'),
    createdByTokenId: text('created_by_token_id').references(() => apiToken.id),
    createdAt: text('created_at'),
    reviewedAt: text('reviewed_at'),
    reviewerUserId: text('reviewer_user_id').references(() => user.id),
    reviewNote: text('review_note'),
    revertUntil: text('revert_until'),
  },
  (t) => [
    index('proposal_fingerprint_idx').on(t.fingerprint),
    check('proposal_kind_check', oneOf('kind', proposalKinds)),
    check('proposal_status_check', oneOf('status', proposalStatuses)),
  ],
)

export const proposalField = sqliteTable('proposal_field', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').references(() => proposal.id),
  field: text('field'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  sourceId: text('source_id').references(() => source.id),
})

export const rejectionMemory = sqliteTable('rejection_memory', {
  fingerprint: text('fingerprint').primaryKey(),
  reason: text('reason'),
  createdAt: text('created_at'),
})

export const changeLog = sqliteTable('change_log', {
  id: text('id').primaryKey(),
  tableName: text('table_name'),
  rowId: text('row_id'),
  action: text('action'),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  // user_id か token_id のどちらか。参照先が 2 通りあるため FK は張らない
  actor: text('actor'),
  proposalId: text('proposal_id').references(() => proposal.id),
  createdAt: text('created_at'),
})
