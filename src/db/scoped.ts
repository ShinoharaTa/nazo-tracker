// 利用者のデータを読む唯一の入口（docs/auth.md §6 実装上の規約）。
// own() は本人の行だけ、asFriendOf() は friendship / block を確かめてから射影だけを返す。
// 記録系テーブルをこのファイル以外から import しないことは scripts/check-scoped.mjs で検査する。

import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { ulid } from '../lib/id'
import { nowIso, todayJst } from '../lib/time'
import type { Db } from './client'
import { PAGE_SIZE } from './master'
import {
  attempt,
  attemptGenre,
  type attemptStatuses,
  block,
  friendship,
  identity,
  image,
  organization,
  type runChannels,
  session,
  user,
  type userRoles,
  vAttemptEnriched,
  wishlist,
  work,
  type workKinds,
} from './schema'

type AttemptStatus = (typeof attemptStatuses)[number]

// OwnAttempt は own() の中でしか作れない（brand の symbol を export しない）。
// ネタバレ本文を返す spoilerResponse（src/ui/spoiler.tsx）はこの型しか受けない
declare const ownBrand: unique symbol

// v_attempt_enriched の 1 行（spoiler_memo を持たない）。一覧・統計用
export type OwnAttemptRow = {
  id: string
  workId: string
  runId: string | null
  status: AttemptStatus
  purchasedOn: string | null
  attemptNo: number
  startedOn: string | null
  finishedOn: string | null
  durationSec: number | null
  partySize: number | null
  companions: string | null
  rating: number | null
  difficulty: number | null
  volume: number | null
  memo: string | null
  createdAt: string
  updatedAt: string
  // 以下ビュー由来。displayOn は一覧の日付スタブ（NULL は「日付なし」）
  displayOn: string | null
  lastPlayedOn: string | null
  sessionCount: number
  sessionDurationSec: number | null
  work: {
    id: string
    title: string
    kind: (typeof workKinds)[number] | null
    org: { id: string; name: string } | null
  }
  run: {
    id: string
    channel: (typeof runChannels)[number]
    startOn: string | null
    endOn: string | null
    venue: { id: string; name: string; prefecture: string | null } | null
  } | null
}

export type OwnSession = {
  id: string
  playedOn: string
  durationSec: number | null
  progressNote: string | null
  companions: string | null
  memo: string | null
  locationText: string | null
  createdAt: string
}

// 進行ログの追加で書く列（venue_id は P3 では書かない。場所は location_text のみ）
export type SessionInput = {
  playedOn: string
  durationSec: number | null
  progressNote: string | null
  locationText: string | null
  companions: string | null
  memo: string | null
}

// 進行ログを足すときの記録の結果（data-model.md §3 session）。失敗はステータス変更で付ける
export const sessionOutcomes = ['keep', 'cleared', 'dropped'] as const
export type SessionOutcome = (typeof sessionOutcomes)[number]

// 記録 1 件の全部（ネタバレメモ・ジャンル・進行ログ込み）。本人だけが得られる
export type OwnAttempt = OwnAttemptRow & {
  readonly [ownBrand]: true
  spoilerMemo: string | null
  genreIds: string[]
  // played_on DESC, created_at DESC
  sessions: OwnSession[]
}

export type AttemptListTab = 'all' | 'pending'

// 詳しい編集で書く列（日付は入力値そのまま。空は NULL）
export type AttemptPatch = {
  status: AttemptStatus
  runId: string | null
  purchasedOn: string | null
  startedOn: string | null
  finishedOn: string | null
  durationSec: number | null
  partySize: number | null
  companions: string | null
  rating: number | null
  difficulty: number | null
  volume: number | null
  memo: string | null
}

// マイリストの 1 行。latestStatus は本人の最新の記録（attempt_no DESC, created_at DESC）。記録が無ければ null
export type OwnWishRow = {
  workId: string
  title: string
  kind: (typeof workKinds)[number] | null
  org: { id: string; name: string } | null
  createdAt: string
  latestStatus: AttemptStatus | null
}

export type OwnProfile = {
  id: string
  displayName: string
  role: (typeof userRoles)[number]
  friendCode: string | null
  excludeFromCounts: boolean
  createdAt: string
}

export type OwnRepo = {
  profile(): Promise<OwnProfile>
  updateDisplayName(name: string): Promise<void>
  // 連携済みの provider 名
  linkedProviders(): Promise<Set<string>>
  // 記録一覧。COALESCE(display_on, created_at の日付) DESC, created_at DESC。50 件ずつ
  listAttempts(opts: {
    tab: AttemptListTab
    page: number
  }): Promise<{ items: OwnAttemptRow[]; hasNext: boolean }>
  // 他人の id・無い id は null
  getAttempt(id: string): Promise<OwnAttempt | null>
  // 作品ページの「あなたの記録」。attempt_no DESC
  attemptsOfWork(
    workId: string,
  ): Promise<{ id: string; status: AttemptStatus; attemptNo: number; displayOn: string | null }[]>
  // 軽い記録。on は status に応じて purchased_on / started_on / finished_on のどれかに入る。新しい id を返す
  createAttempt(input: {
    workId: string
    status: AttemptStatus
    on: string | null
  }): Promise<string>
  // ステータス変更。日付は data-model.md §3 の表どおり。他人の id・無い id は false
  setStatus(id: string, status: AttemptStatus, on: string | null): Promise<boolean>
  // 詳しい編集。attempt_genre は genreIds で置き換える。他人の id・無い id は false
  updateAttempt(id: string, patch: AttemptPatch, genreIds: readonly string[]): Promise<boolean>
  // null で消す。他人の id・無い id は false
  updateSpoilerMemo(id: string, text: string | null): Promise<boolean>
  // image → session → attempt_genre → attempt。他人の id・無い id は false
  deleteAttempt(id: string): Promise<boolean>
  // 進行ログの追加。記録の status / 日付は outcome で決める（data-model.md §3 session）。他人の id・無い id は false
  addSession(attemptId: string, input: SessionInput, outcome: SessionOutcome): Promise<boolean>
  // 記録の status / 日付は戻さない。他人の id・無い id・別の記録のログは false
  deleteSession(attemptId: string, sessionId: string): Promise<boolean>
  // status IN (cleared, failed) の件数
  playedCount(): Promise<number>
  // 匿名人数（src/db/counts.ts）から自分を外すか。true で exclude_from_counts = 1
  setExcludeFromCounts(exclude: boolean): Promise<void>
  // マイリスト。created_at DESC。unplayed は記録が 1 件も無い作品だけ。50 件ずつ
  listWishlist(opts: {
    unplayed: boolean
    page: number
  }): Promise<{ items: OwnWishRow[]; hasNext: boolean }>
  isWished(workId: string): Promise<boolean>
  // 登録済みなら何もしない（INSERT OR IGNORE）
  addWish(workId: string): Promise<void>
  removeWish(workId: string): Promise<void>
  // マイリストの件数と、うちプレイ済み（cleared / failed の記録がある）作品の数
  wishlistSummary(): Promise<{ total: number; played: number }>
  // 統計（src/lib/stats.ts）の入力。created_at DESC で最大 STATS_LIMIT 件。超えたら capped
  statsRows(): Promise<{
    rows: OwnAttemptRow[]
    genres: { attemptId: string; genreId: string }[]
    capped: boolean
  }>
}

// P1 は箱だけ。P8 で射影を返すメソッドを足す
export type FriendRepo = {
  readonly targetUserId: string
  readonly level: 'status'
}

export type Scoped = {
  readonly viewerId: string
  own(): OwnRepo
  asFriendOf(targetUserId: string): Promise<FriendRepo | null>
}

const v = vAttemptEnriched

// v_attempt_enriched から読む列（user_id / share_override / source_ref は画面に出さないので読まない）
const enrichedColumns = {
  id: v.id,
  workId: v.workId,
  runId: v.runId,
  status: v.status,
  purchasedOn: v.purchasedOn,
  attemptNo: v.attemptNo,
  startedOn: v.startedOn,
  finishedOn: v.finishedOn,
  durationSec: v.durationSec,
  partySize: v.partySize,
  companions: v.companions,
  rating: v.rating,
  difficulty: v.difficulty,
  volume: v.volume,
  memo: v.memo,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
  displayOn: v.displayOn,
  lastPlayedOn: v.lastPlayedOn,
  sessionCount: v.sessionCount,
  sessionDurationSec: v.sessionDurationSec,
  workTitle: v.workTitle,
  workKind: v.workKind,
  orgId: v.orgId,
  orgName: v.orgName,
  runChannel: v.runChannel,
  runStartOn: v.runStartOn,
  runEndOn: v.runEndOn,
  venueId: v.venueId,
  venueName: v.venueName,
  venuePrefecture: v.venuePrefecture,
}

// 呼び出し側で必ず user_id = viewerId を WHERE に入れる
const selectEnriched = (db: Db) => db.select(enrichedColumns).from(v)

type EnrichedSelect = Awaited<ReturnType<typeof selectEnriched>>[number]

const toAttemptRow = (r: EnrichedSelect): OwnAttemptRow => {
  const {
    workTitle,
    workKind,
    orgId,
    orgName,
    runChannel,
    runStartOn,
    runEndOn,
    venueId,
    venueName,
    venuePrefecture,
    ...rest
  } = r
  return {
    ...rest,
    work: {
      id: r.workId,
      title: workTitle,
      kind: workKind,
      org: orgId && orgName ? { id: orgId, name: orgName } : null,
    },
    run:
      r.runId && runChannel
        ? {
            id: r.runId,
            channel: runChannel,
            startOn: runStartOn,
            endOn: runEndOn,
            venue:
              venueId && venueName
                ? { id: venueId, name: venueName, prefecture: venuePrefecture }
                : null,
          }
        : null,
  }
}

const pendingStatuses = ['purchased', 'in_progress'] as const satisfies readonly AttemptStatus[]
const playedStatuses = ['cleared', 'failed'] as const satisfies readonly AttemptStatus[]

// 統計で読む記録の上限（docs/data-model.md §6）
export const STATS_LIMIT = 5000

const ownRepo = (db: Db, viewerId: string): OwnRepo => ({
  async profile() {
    const row = await db
      .select({
        id: user.id,
        displayName: user.displayName,
        role: user.role,
        friendCode: user.friendCode,
        excludeFromCounts: user.excludeFromCounts,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, viewerId))
      .get()
    if (!row) throw new Error('viewer の user 行が無い')
    return { ...row, excludeFromCounts: row.excludeFromCounts === 1 }
  },

  // WHERE は viewerId 固定。ほかの行は更新できない
  async updateDisplayName(name: string) {
    await db.update(user).set({ displayName: name }).where(eq(user.id, viewerId))
  },

  async linkedProviders() {
    const rows = await db
      .select({ provider: identity.provider })
      .from(identity)
      .where(eq(identity.userId, viewerId))
    return new Set(rows.map((r) => r.provider))
  },

  async listAttempts({ tab, page }) {
    const rows = await selectEnriched(db)
      .where(
        and(
          eq(v.userId, viewerId),
          tab === 'pending' ? inArray(v.status, [...pendingStatuses]) : undefined,
        ),
      )
      .orderBy(
        desc(sql`COALESCE(${v.displayOn}, substr(${v.createdAt}, 1, 10))`),
        desc(v.createdAt),
        desc(v.id),
      )
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
    return { items: rows.slice(0, PAGE_SIZE).map(toAttemptRow), hasNext: rows.length > PAGE_SIZE }
  },

  // spoiler_memo はビューに無いので attempt 表から読む。全て id と user_id の両方で絞る
  async getAttempt(id) {
    const [rows, spoilers, genres, sessions] = await db.batch([
      selectEnriched(db)
        .where(and(eq(v.id, id), eq(v.userId, viewerId)))
        .limit(1),
      db
        .select({ spoilerMemo: attempt.spoilerMemo })
        .from(attempt)
        .where(and(eq(attempt.id, id), eq(attempt.userId, viewerId)))
        .limit(1),
      db
        .select({ genreId: attemptGenre.genreId })
        .from(attemptGenre)
        .where(and(eq(attemptGenre.attemptId, id), eq(attemptGenre.userId, viewerId))),
      db
        .select({
          id: session.id,
          playedOn: session.playedOn,
          durationSec: session.durationSec,
          progressNote: session.progressNote,
          companions: session.companions,
          memo: session.memo,
          locationText: session.locationText,
          createdAt: session.createdAt,
        })
        .from(session)
        .where(and(eq(session.attemptId, id), eq(session.userId, viewerId)))
        .orderBy(desc(session.playedOn), desc(session.createdAt)),
    ])
    if (!rows[0] || !spoilers[0]) return null
    return {
      ...toAttemptRow(rows[0]),
      spoilerMemo: spoilers[0].spoilerMemo,
      genreIds: genres.map((g) => g.genreId),
      sessions,
    } as OwnAttempt
  },

  attemptsOfWork(workId) {
    return db
      .select({ id: v.id, status: v.status, attemptNo: v.attemptNo, displayOn: v.displayOn })
      .from(v)
      .where(and(eq(v.userId, viewerId), eq(v.workId, workId)))
      .orderBy(desc(v.attemptNo), desc(v.createdAt))
  },

  // attempt_no は同じ作品の自分の記録の MAX + 1 を INSERT の中で求める
  async createAttempt({ workId, status, on }) {
    const id = ulid()
    const now = nowIso()
    await db.insert(attempt).values({
      id,
      userId: viewerId,
      workId,
      status,
      purchasedOn: status === 'purchased' ? on : null,
      startedOn: status === 'in_progress' ? on : null,
      finishedOn: status === 'purchased' || status === 'in_progress' ? null : on,
      attemptNo: sql`(SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM attempt WHERE user_id = ${viewerId} AND work_id = ${workId})`,
      createdAt: now,
      updatedAt: now,
    })
    return id
  },

  // 日付は COALESCE で「左が NULL なら右」。WHERE は id と user_id の両方
  async setStatus(id, status, on) {
    const today = todayJst()
    const dates =
      status === 'purchased'
        ? {
            purchasedOn: sql`COALESCE(${on}, ${attempt.purchasedOn}, ${today})`,
            finishedOn: null,
          }
        : status === 'in_progress'
          ? {
              startedOn: sql`COALESCE(${attempt.startedOn}, ${on}, ${today})`,
              finishedOn: null,
            }
          : { finishedOn: sql`COALESCE(${on}, ${attempt.finishedOn}, ${today})` }
    const rows = await db
      .update(attempt)
      .set({ status, ...dates, updatedAt: nowIso() })
      .where(and(eq(attempt.id, id), eq(attempt.userId, viewerId)))
      .returning({ id: attempt.id })
    return rows.length > 0
  },

  // 事前 SELECT はしない（読んでから書くまでに消されると、無い attempt に attempt_genre を INSERT して FK で落ちる）。
  // UPDATE の行数で本人の記録かを判定し、attempt_genre の DELETE / INSERT は本人の attempt が在るときだけ効かせる。
  // 1 回の batch = 1 トランザクション
  async updateAttempt(id, patch, genreIds) {
    const mine = sql`EXISTS (SELECT 1 FROM ${attempt} WHERE ${attempt.id} = ${id} AND ${attempt.userId} = ${viewerId})`
    const update = db
      .update(attempt)
      .set({ ...patch, updatedAt: nowIso() })
      .where(and(eq(attempt.id, id), eq(attempt.userId, viewerId)))
      .returning({ id: attempt.id })
    const clearGenres = db
      .delete(attemptGenre)
      .where(and(eq(attemptGenre.attemptId, id), eq(attemptGenre.userId, viewerId), mine))
    const inserts = [...new Set(genreIds)].map((genreId) =>
      db.insert(attemptGenre).select(sql`SELECT ${id}, ${genreId}, ${viewerId} WHERE ${mine}`),
    )
    const [updated] = await db.batch([update, clearGenres, ...inserts])
    return updated.length > 0
  },

  async updateSpoilerMemo(id, text) {
    const rows = await db
      .update(attempt)
      .set({ spoilerMemo: text, updatedAt: nowIso() })
      .where(and(eq(attempt.id, id), eq(attempt.userId, viewerId)))
      .returning({ id: attempt.id })
    return rows.length > 0
  },

  // FK の cascade に頼らず子から順に消す（1 回の batch = 1 トランザクション）
  // TODO(P9): image の R2 オブジェクト（r2_key / thumb_r2_key）を消す
  async deleteAttempt(id) {
    const [, , , deleted] = await db.batch([
      db.delete(image).where(and(eq(image.attemptId, id), eq(image.userId, viewerId))),
      db.delete(session).where(and(eq(session.attemptId, id), eq(session.userId, viewerId))),
      db
        .delete(attemptGenre)
        .where(and(eq(attemptGenre.attemptId, id), eq(attemptGenre.userId, viewerId))),
      db
        .delete(attempt)
        .where(and(eq(attempt.id, id), eq(attempt.userId, viewerId)))
        .returning({ id: attempt.id }),
    ])
    return deleted.length > 0
  },

  // updateAttempt と同じく、本人の attempt が在ることを各文の中で確かめる（事前 SELECT に頼らない）。
  // INSERT → UPDATE の順に 1 回の batch（= 1 トランザクション）。UPDATE の行数で本人の記録かを判定する
  async addSession(attemptId, input, outcome) {
    const mine = sql`EXISTS (SELECT 1 FROM ${attempt} WHERE ${attempt.id} = ${attemptId} AND ${attempt.userId} = ${viewerId})`
    const now = nowIso()
    // 列の順は schema の session と同じ（id, attempt_id, user_id, played_on, started_at, ended_at, duration_sec,
    // progress_note, companions, memo, venue_id, location_text, created_at）
    const insert = db
      .insert(session)
      .select(
        sql`SELECT ${ulid()}, ${attemptId}, ${viewerId}, ${input.playedOn}, NULL, NULL, ${input.durationSec}, ${input.progressNote}, ${input.companions}, ${input.memo}, NULL, ${input.locationText}, ${now} WHERE ${mine}`,
      )
    const startedOn = sql`COALESCE(${attempt.startedOn}, ${input.playedOn})`
    const set =
      outcome === 'keep'
        ? {
            status: sql`CASE WHEN ${attempt.status} = 'purchased' THEN 'in_progress' ELSE ${attempt.status} END`,
            startedOn,
          }
        : { status: outcome, finishedOn: input.playedOn, startedOn }
    const update = db
      .update(attempt)
      .set({ ...set, updatedAt: now })
      .where(and(eq(attempt.id, attemptId), eq(attempt.userId, viewerId)))
      .returning({ id: attempt.id })
    const [, updated] = await db.batch([insert, update])
    return updated.length > 0
  },

  async deleteSession(attemptId, sessionId) {
    const rows = await db
      .delete(session)
      .where(
        and(
          eq(session.id, sessionId),
          eq(session.attemptId, attemptId),
          eq(session.userId, viewerId),
          sql`EXISTS (SELECT 1 FROM ${attempt} WHERE ${attempt.id} = ${attemptId} AND ${attempt.userId} = ${viewerId})`,
        ),
      )
      .returning({ id: session.id })
    return rows.length > 0
  },

  async playedCount() {
    const row = await db
      .select({ n: sql<number>`count(*)` })
      .from(attempt)
      .where(and(eq(attempt.userId, viewerId), inArray(attempt.status, [...playedStatuses])))
      .get()
    return row?.n ?? 0
  },

  // WHERE は viewerId 固定
  async setExcludeFromCounts(exclude) {
    await db
      .update(user)
      .set({ excludeFromCounts: exclude ? 1 : 0 })
      .where(eq(user.id, viewerId))
  },

  // 統合済みの作品も JOIN 条件で落とさない（統合で付け替わる前提だが、出しておく）
  async listWishlist({ unplayed, page }) {
    const latestStatus = sql<AttemptStatus | null>`(SELECT ${attempt.status} FROM ${attempt} WHERE ${attempt.userId} = ${viewerId} AND ${attempt.workId} = ${wishlist.workId} ORDER BY ${attempt.attemptNo} DESC, ${attempt.createdAt} DESC LIMIT 1)`
    const rows = await db
      .select({
        workId: wishlist.workId,
        title: work.title,
        kind: work.kind,
        orgId: organization.id,
        orgName: organization.name,
        createdAt: wishlist.createdAt,
        latestStatus,
      })
      .from(wishlist)
      .innerJoin(work, eq(work.id, wishlist.workId))
      .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
      .where(
        and(eq(wishlist.userId, viewerId), unplayed ? sql`${latestStatus} IS NULL` : undefined),
      )
      .orderBy(desc(wishlist.createdAt), desc(wishlist.workId))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
    return {
      items: rows.slice(0, PAGE_SIZE).map(({ orgId, orgName, ...r }) => ({
        ...r,
        org: orgId && orgName ? { id: orgId, name: orgName } : null,
      })),
      hasNext: rows.length > PAGE_SIZE,
    }
  },

  async isWished(workId) {
    const row = await db
      .select({ workId: wishlist.workId })
      .from(wishlist)
      .where(and(eq(wishlist.userId, viewerId), eq(wishlist.workId, workId)))
      .get()
    return row !== undefined
  },

  async addWish(workId) {
    await db
      .insert(wishlist)
      .values({ userId: viewerId, workId, createdAt: nowIso() })
      .onConflictDoNothing()
  },

  async removeWish(workId) {
    await db.delete(wishlist).where(and(eq(wishlist.userId, viewerId), eq(wishlist.workId, workId)))
  },

  // 単一表の select では drizzle が列を表名なしで出し、副問い合わせの中で attempt.work_id に化けるので、
  // 副問い合わせ側は別名 pa、外側は wishlist.work_id と書く
  async wishlistSummary() {
    const row = await db
      .select({
        total: sql<number>`count(*)`,
        played: sql<number>`coalesce(sum(EXISTS (SELECT 1 FROM ${attempt} pa WHERE pa.user_id = ${viewerId} AND pa.work_id = ${wishlist}.work_id AND pa.status IN ('cleared', 'failed'))), 0)`,
      })
      .from(wishlist)
      .where(eq(wishlist.userId, viewerId))
      .get()
    return { total: row?.total ?? 0, played: row?.played ?? 0 }
  },

  // 1 件多く読んで上限を超えたかを判定する。attempt_genre は記録で絞らず全件（集計側で rows に無いものを捨てる）
  async statsRows() {
    const [rows, genres] = await db.batch([
      selectEnriched(db)
        .where(eq(v.userId, viewerId))
        .orderBy(desc(v.createdAt), desc(v.id))
        .limit(STATS_LIMIT + 1),
      db
        .select({ attemptId: attemptGenre.attemptId, genreId: attemptGenre.genreId })
        .from(attemptGenre)
        .where(eq(attemptGenre.userId, viewerId)),
    ])
    return {
      rows: rows.slice(0, STATS_LIMIT).map(toAttemptRow),
      genres,
      capped: rows.length > STATS_LIMIT,
    }
  },
})

export const scopedTo = (db: Db, viewerId: string): Scoped => ({
  viewerId,
  own: () => ownRepo(db, viewerId),

  // friendship があり、どちらの向きにも block が無いときだけ返す。満たさなければ null（呼び出し側が 404 にする）
  async asFriendOf(targetUserId: string) {
    if (targetUserId === viewerId) return null
    const [lo, hi] = viewerId < targetUserId ? [viewerId, targetUserId] : [targetUserId, viewerId]
    const [friend, blocked] = await db.batch([
      db
        .select({ userLo: friendship.userLo })
        .from(friendship)
        .where(and(eq(friendship.userLo, lo), eq(friendship.userHi, hi)))
        .limit(1),
      db
        .select({ userId: block.userId })
        .from(block)
        .where(
          or(
            and(eq(block.userId, viewerId), eq(block.blockedUserId, targetUserId)),
            and(eq(block.userId, targetUserId), eq(block.blockedUserId, viewerId)),
          ),
        )
        .limit(1),
    ])
    if (friend.length === 0 || blocked.length > 0) return null
    return { targetUserId, level: 'status' }
  },
})
