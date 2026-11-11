// スキーマ v1。定義の出典は docs/data-model.md と docs/auth.md。
// ID は ULID の TEXT、日時は ISO 8601 TEXT（UTC）、日付は YYYY-MM-DD TEXT、真偽は INTEGER 0/1。
// 文書で NOT NULL / 既定値が決まっていない列は NULL 可・既定値なしで置いている。

import { type SQL, sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
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
  'reverted',
] as const
export const apiTokenRoles = ['agent'] as const
export const userRoles = ['member', 'owner'] as const
export const shareLevels = ['none', 'status', 'rating', 'memo'] as const
export const oauthStateModes = ['login', 'link'] as const
export const appSettingKeys = ['auto_apply'] as const

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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('organization_name_norm_idx').on(t.nameNorm)],
)

export const organizationAlias = sqliteTable(
  'organization_alias',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
    kind: text('kind', { enum: organizationAliasKinds }).notNull(),
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
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
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
    workId: text('work_id')
      .notNull()
      .references(() => work.id),
    title: text('title').notNull(),
    titleNorm: text('title_norm').notNull(),
    kind: text('kind', { enum: workAliasKinds }).notNull(),
  },
  () => [check('work_alias_kind_check', oneOf('kind', workAliasKinds))],
)

export const venue = sqliteTable('venue', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  prefecture: text('prefecture'),
  address: text('address'),
  organizationId: text('organization_id').references(() => organization.id),
  mergedIntoId: text('merged_into_id').references((): AnySQLiteColumn => venue.id),
})

export const shop = sqliteTable(
  'shop',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: shopKinds }).notNull(),
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
    channel: text('channel', { enum: runChannels }).notNull(),
    organizationId: text('organization_id').references(() => organization.id),
    billedAs: text('billed_as'),
    venueId: text('venue_id').references(() => venue.id),
    shopId: text('shop_id').references(() => shop.id),
    startOn: text('start_on'),
    endOn: text('end_on'),
    isPermanent: integer('is_permanent').notNull().default(0),
    escapeIdUrl: text('escape_id_url').unique(),
    ticketUrl: text('ticket_url'),
    priceYen: integer('price_yen'),
    escapeTypeRaw: text('escape_type_raw'),
    note: text('note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('run_work_idx').on(t.workId),
    index('run_venue_permanent_idx').on(t.venueId, t.isPermanent),
    check('run_channel_check', oneOf('channel', runChannels)),
    check('run_is_permanent_check', bool01('is_permanent')),
    // channel='sale' → shop_id 必須
    check('run_sale_shop_check', sql`"channel" <> 'sale' OR "shop_id" IS NOT NULL`),
    // venue_id は performance のみ、shop_id は sale のみ
    check('run_venue_channel_check', sql`"channel" = 'performance' OR "venue_id" IS NULL`),
    check('run_shop_channel_check', sql`"channel" = 'sale' OR "shop_id" IS NULL`),
  ],
)

export const market = sqliteTable('market', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameNorm: text('name_norm').notNull(),
  siteUrl: text('site_url'),
})

export const marketEdition = sqliteTable(
  'market_edition',
  {
    id: text('id').primaryKey(),
    marketId: text('market_id')
      .notNull()
      .references(() => market.id),
    label: text('label').notNull(),
    startOn: text('start_on'),
    endOn: text('end_on'),
    venueId: text('venue_id').references(() => venue.id),
    escapeIdUrl: text('escape_id_url').unique(),
    sourceUrl: text('source_url'),
    externalKey: text('external_key'),
  },
  (t) => [unique('market_edition_market_external_key_unique').on(t.marketId, t.externalKey)],
)

export const booth = sqliteTable(
  'booth',
  {
    id: text('id').primaryKey(),
    marketEditionId: text('market_edition_id')
      .notNull()
      .references(() => marketEdition.id),
    organizationId: text('organization_id').references(() => organization.id),
    nameAsListed: text('name_as_listed').notNull(),
    boothNo: text('booth_no'),
    detailUrl: text('detail_url'),
    days: text('days'),
  },
  (t) => [unique('booth_market_edition_detail_url_unique').on(t.marketEditionId, t.detailUrl)],
)

export const boothItem = sqliteTable(
  'booth_item',
  {
    id: text('id').primaryKey(),
    boothId: text('booth_id')
      .notNull()
      .references(() => booth.id),
    workId: text('work_id').references(() => work.id),
    titleAsListed: text('title_as_listed').notNull(),
    priceYen: integer('price_yen'),
  },
  (t) => [index('booth_item_work_idx').on(t.workId)],
)

// ---------------------------------------------------------------------------
// 認証（auth.md §2）
// ---------------------------------------------------------------------------

export const user = sqliteTable(
  'user',
  {
    id: text('id').primaryKey(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: userRoles }).notNull().default('member'),
    // NULL で招待停止。NULL は複数行あってよい
    friendCode: text('friend_code').unique(),
    defaultShareLevel: text('default_share_level', { enum: shareLevels })
      .notNull()
      .default('status'),
    excludeFromCounts: integer('exclude_from_counts').notNull().default(0),
    createdAt: text('created_at').notNull(),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    createdAt: text('created_at').notNull(),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index('identity_user_idx').on(t.userId),
  ],
)

// ログインセッション。進行ログの `session` と区別するため `session_token` とする。
export const sessionToken = sqliteTable(
  'session_token',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
    uaHint: text('ua_hint'),
  },
  (t) => [index('session_token_user_idx').on(t.userId)],
)

export const oauthState = sqliteTable(
  'oauth_state',
  {
    state: text('state').primaryKey(),
    provider: text('provider').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    mode: text('mode', { enum: oauthStateModes }).notNull(),
    userId: text('user_id').references(() => user.id),
    expiresAt: text('expires_at').notNull(),
    // OIDC の nonce（Google のみ）。ID トークンの nonce と照合する
    nonce: text('nonce'),
  },
  () => [check('oauth_state_mode_check', oneOf('mode', oauthStateModes))],
)

export const recoveryCode = sqliteTable(
  'recovery_code',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.codeHash] })],
)

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
    status: text('status', { enum: attemptStatuses }).notNull(),
    purchasedOn: text('purchased_on'),
    attemptNo: integer('attempt_no').notNull().default(1),
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
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
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
    label: text('label').notNull().unique(),
    sortOrder: integer('sort_order').notNull(),
    archived: integer('archived').notNull().default(0),
  },
  () => [check('genre_archived_check', bool01('archived'))],
)

export const attemptGenre = sqliteTable(
  'attempt_genre',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempt.id, { onDelete: 'cascade' }),
    genreId: text('genre_id')
      .notNull()
      .references(() => genre.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempt.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: imageKinds }).notNull(),
    spoiler: integer('spoiler').notNull().default(0),
    r2Key: text('r2_key').notNull(),
    thumbR2Key: text('thumb_r2_key'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes').notNull(),
    contentType: text('content_type').notNull(),
    removedAt: text('removed_at'),
    removedReason: text('removed_reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('image_attempt_idx').on(t.attemptId),
    index('image_user_idx').on(t.userId),
    check('image_kind_check', oneOf('kind', imageKinds)),
    check('image_spoiler_check', bool01('spoiler')),
  ],
)

export const imageReport = sqliteTable(
  'image_report',
  {
    id: text('id').primaryKey(),
    imageId: text('image_id')
      .notNull()
      .references(() => image.id, { onDelete: 'cascade' }),
    reporterUserId: text('reporter_user_id')
      .notNull()
      .references(() => user.id),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique('image_report_image_reporter_user_unique').on(t.imageId, t.reporterUserId)],
)

export const friendRequest = sqliteTable(
  'friend_request',
  {
    id: text('id').primaryKey(),
    fromUserId: text('from_user_id')
      .notNull()
      .references(() => user.id),
    toUserId: text('to_user_id')
      .notNull()
      .references(() => user.id),
    status: text('status', { enum: friendRequestStatuses }).notNull(),
    createdAt: text('created_at').notNull(),
    respondedAt: text('responded_at'),
  },
  (t) => [
    uniqueIndex('friend_request_pending_unique')
      .on(t.fromUserId, t.toUserId)
      .where(sql`"status" = 'pending'`),
    index('friend_request_to_status_idx').on(t.toUserId, t.status),
    check('friend_request_status_check', oneOf('status', friendRequestStatuses)),
    check('friend_request_self_check', sql`"from_user_id" <> "to_user_id"`),
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
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userLo, t.userHi] }),
    index('friendship_user_hi_idx').on(t.userHi),
    check('friendship_order_check', sql`"user_lo" < "user_hi"`),
  ],
)

export const block = sqliteTable(
  'block',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    blockedUserId: text('blocked_user_id')
      .notNull()
      .references(() => user.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.blockedUserId] }),
    index('block_blocked_user_idx').on(t.blockedUserId),
    check('block_self_check', sql`"user_id" <> "blocked_user_id"`),
  ],
)

// 進行ログ
export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempt.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    playedOn: text('played_on').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    durationSec: integer('duration_sec'),
    progressNote: text('progress_note'),
    companions: text('companions'),
    memo: text('memo'),
    venueId: text('venue_id').references(() => venue.id),
    locationText: text('location_text'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('session_attempt_idx').on(t.attemptId),
    index('session_user_played_on_idx').on(t.userId, t.playedOn),
  ],
)

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
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workId] }), index('wishlist_work_idx').on(t.workId)],
)

export const marketVisit = sqliteTable('market_visit', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  marketEditionId: text('market_edition_id')
    .notNull()
    .references(() => marketEdition.id),
  visitedOn: text('visited_on').notNull(),
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
    kind: text('kind', { enum: requestKinds }).notNull(),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: requestStatuses }).notNull().default('open'),
    triageNote: text('triage_note'),
    // needs_info の質問（依頼者に見える）
    question: text('question'),
    // 依頼者の返信
    reply: text('reply'),
    // agent のメモ（オーナーだけが見る）
    agentNote: text('agent_note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('request_status_idx').on(t.status),
    index('request_requester_created_idx').on(t.requesterUserId, t.createdAt),
    check('request_kind_check', oneOf('kind', requestKinds)),
    check('request_status_check', oneOf('status', requestStatuses)),
  ],
)

export const source = sqliteTable(
  'source',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    domain: text('domain'),
    method: text('method', { enum: sourceMethods }).notNull(),
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
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role', { enum: apiTokenRoles }).notNull(),
    scopesJson: text('scopes_json'),
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  () => [check('api_token_role_check', oneOf('role', apiTokenRoles))],
)

export const proposal = sqliteTable(
  'proposal',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').references(() => request.id),
    kind: text('kind', { enum: proposalKinds }).notNull(),
    targetTable: text('target_table').notNull(),
    targetId: text('target_id'),
    confidence: real('confidence'),
    status: text('status', { enum: proposalStatuses }).notNull().default('pending'),
    fingerprint: text('fingerprint').notNull(),
    matchCandidatesJson: text('match_candidates_json'),
    createdByTokenId: text('created_by_token_id').references(() => apiToken.id),
    createdAt: text('created_at').notNull(),
    reviewedAt: text('reviewed_at'),
    reviewerUserId: text('reviewer_user_id').references(() => user.id),
    reviewNote: text('review_note'),
    revertUntil: text('revert_until'),
    // 作った / 変えた行の id {"organization"?,"venue"?,"shop"?,"work"?,"run"?}
    appliedJson: text('applied_json'),
    revertedAt: text('reverted_at'),
    revertedByUserId: text('reverted_by_user_id').references(() => user.id),
    followUpOfId: text('follow_up_of_id').references((): AnySQLiteColumn => proposal.id),
  },
  (t) => [
    // 同じ fingerprint の pending は 1 件まで
    uniqueIndex('proposal_pending_fingerprint_unique')
      .on(t.fingerprint)
      .where(sql`"status" = 'pending'`),
    index('proposal_status_idx').on(t.status),
    index('proposal_target_table_target_idx').on(t.targetTable, t.targetId),
    index('proposal_request_idx').on(t.requestId),
    check('proposal_kind_check', oneOf('kind', proposalKinds)),
    check('proposal_status_check', oneOf('status', proposalStatuses)),
  ],
)

export const proposalField = sqliteTable(
  'proposal_field',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    sourceId: text('source_id').references(() => source.id),
    confidence: real('confidence'),
    // 承認時に入れる（1 = 採用 / 0 = 不採用）
    accepted: integer('accepted'),
  },
  (t) => [
    index('proposal_field_proposal_idx').on(t.proposalId),
    check('proposal_field_confidence_check', sql`"confidence" BETWEEN 0 AND 1`),
    check('proposal_field_accepted_check', bool01('accepted')),
  ],
)

export const rejectionMemory = sqliteTable('rejection_memory', {
  fingerprint: text('fingerprint').primaryKey(),
  reason: text('reason'),
  createdAt: text('created_at').notNull(),
})

export const changeLog = sqliteTable(
  'change_log',
  {
    id: text('id').primaryKey(),
    tableName: text('table_name').notNull(),
    rowId: text('row_id').notNull(),
    action: text('action').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    actorUserId: text('actor_user_id').references(() => user.id),
    actorTokenId: text('actor_token_id').references(() => apiToken.id),
    proposalId: text('proposal_id').references(() => proposal.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('change_log_table_name_row_idx').on(t.tableName, t.rowId),
    // actor はユーザーかトークンのちょうど片方
    check('change_log_actor_check', sql`("actor_user_id" IS NULL) <> ("actor_token_id" IS NULL)`),
  ],
)

// 運用の設定（キーは CHECK で限る）。行が無ければ既定値
export const appSetting = sqliteTable(
  'app_setting',
  {
    key: text('key', { enum: appSettingKeys }).primaryKey(),
    value: text('value').notNull(),
    updatedAt: text('updated_at').notNull(),
    updatedByUserId: text('updated_by_user_id').references(() => user.id),
  },
  () => [check('app_setting_key_check', oneOf('key', appSettingKeys))],
)

// ---------------------------------------------------------------------------
// ビュー（migrations/0004_v_attempt_enriched.sql で手書き。.existing() なので drizzle-kit は生成しない）
// ---------------------------------------------------------------------------

// attempt ⋈ work ⋈ run ⋈ venue ⋈ organization。spoiler_memo は含めない。読むのは src/db/scoped.ts だけ
// attempt / work / run / organization / venue / session を作り直す migration（drizzle-kit の __new_x）を書くときは、
// 先に DROP VIEW v_attempt_enriched → 表の作り直し → CREATE VIEW を同じ migration に入れる
export const vAttemptEnriched = sqliteView('v_attempt_enriched', {
  id: text('id').notNull(),
  userId: text('user_id').notNull(),
  workId: text('work_id').notNull(),
  runId: text('run_id'),
  status: text('status', { enum: attemptStatuses }).notNull(),
  purchasedOn: text('purchased_on'),
  attemptNo: integer('attempt_no').notNull(),
  startedOn: text('started_on'),
  finishedOn: text('finished_on'),
  durationSec: integer('duration_sec'),
  partySize: integer('party_size'),
  companions: text('companions'),
  rating: integer('rating'),
  difficulty: integer('difficulty'),
  volume: integer('volume'),
  memo: text('memo'),
  shareOverride: text('share_override', { enum: shareOverrides }),
  sourceRef: text('source_ref'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastPlayedOn: text('last_played_on'),
  sessionCount: integer('session_count').notNull(),
  sessionDurationSec: integer('session_duration_sec'),
  displayOn: text('display_on'),
  workTitle: text('work_title').notNull(),
  workKind: text('work_kind', { enum: workKinds }),
  orgId: text('org_id'),
  orgName: text('org_name'),
  runChannel: text('run_channel', { enum: runChannels }),
  runStartOn: text('run_start_on'),
  runEndOn: text('run_end_on'),
  venueId: text('venue_id'),
  venueName: text('venue_name'),
  venuePrefecture: text('venue_prefecture'),
}).existing()
