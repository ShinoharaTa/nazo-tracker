// 利用者のデータを読む唯一の入口（docs/auth.md §6 実装上の規約）。
// own() は本人の行だけ、asFriendOf() は friendship / block を確かめてから射影だけを返す。
// 記録系テーブルをこのファイル以外から import しないことは scripts/check-scoped.mjs で検査する。

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { ulid } from '../lib/id'
import type { ImageSource } from '../lib/image-url'
import { nowIso, todayJst } from '../lib/time'
import type { Db } from './client'
import { PAGE_SIZE } from './master'
import {
  attempt,
  attemptGenre,
  type attemptStatuses,
  block,
  friendship,
  genre,
  identity,
  image,
  organization,
  type runChannels,
  session,
  user,
  type userRoles,
  vAttemptEnriched,
  vFriendAttempt,
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
  // マスタの画像。出すかは shownImage で決める
  image: ImageSource
  createdAt: string
  latestStatus: AttemptStatus | null
}

// エクスポート（src/lib/export.ts）の記録 1 件。spoilerMemo は exportPart の spoiler: true のときだけキーがある
export type OwnExportAttempt = {
  id: string
  work: {
    id: string
    title: string
    kind: (typeof workKinds)[number] | null
    org: { id: string; name: string } | null
  }
  runId: string | null
  venue: { name: string; prefecture: string | null } | null
  status: AttemptStatus
  attemptNo: number
  purchasedOn: string | null
  startedOn: string | null
  finishedOn: string | null
  durationSec: number | null
  partySize: number | null
  companions: string | null
  rating: number | null
  difficulty: number | null
  volume: number | null
  // genre.sort_order 順のラベル
  genres: string[]
  memo: string | null
  spoilerMemo?: string | null
  sourceRef: string | null
  createdAt: string
  updatedAt: string
  // played_on ASC, created_at ASC
  sessions: (OwnSession & { startedAt: string | null; endedAt: string | null })[]
}

export type OwnExportWish = {
  work: {
    id: string
    title: string
    kind: (typeof workKinds)[number] | null
    org: { id: string; name: string } | null
  }
  memo: string | null
  createdAt: string
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
  // 記録一覧。COALESCE(display_on, created_at の JST の日付) DESC, created_at DESC。50 件ずつ
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
  // oldestCreatedAt はいちばん古い登録の created_at（0 件なら null）
  wishlistSummary(): Promise<{ total: number; played: number; oldestCreatedAt: string | null }>
  // 統計（src/lib/stats.ts）の入力。created_at DESC で最大 STATS_LIMIT 件。超えたら capped
  statsRows(): Promise<{
    rows: OwnAttemptRow[]
    genres: { attemptId: string; genreId: string }[]
    capped: boolean
  }>
  // エクスポート画面の件数
  exportCounts(): Promise<{ attempts: number; sessions: number; wishlist: number }>
  // 記録を attempt.id ASC で EXPORT_PART 件ずつ。part は 1 始まり（範囲の検査は呼び出し側）。
  // spoiler: true のときだけ spoiler_memo を読み、spoilerMemo のキーを付ける
  exportPart(part: number, opts: { spoiler: boolean }): Promise<OwnExportAttempt[]>
  // マイリスト全件。created_at ASC で最大 limit 件（既定 EXPORT_WISHLIST_LIMIT）。超えたら truncated
  exportWishlist(limit?: number): Promise<{ items: OwnExportWish[]; truncated: boolean }>
}

// フレンドに見せる記録 1 件（v_friend_attempt）。この 6 つ以外の列を持たない（docs/auth.md §6）
export type FriendAttemptStatus = {
  workId: string
  workTitle: string
  workKind: (typeof workKinds)[number] | null
  status: AttemptStatus
  startedOn: string | null
  finishedOn: string | null
}

// v1 は level = 'status' だけ（Rating / Memo の射影は P11 で足す）
export type FriendRepo = {
  readonly targetUserId: string
  // 相手の表示名（asFriendOf の判定と同じ問い合わせで読む）
  readonly displayName: string
  readonly level: 'status'
  // COALESCE(finished_on, started_on) DESC（NULL は最後）, created_at DESC。50 件ずつ
  listAttempts(opts: { page: number }): Promise<{ items: FriendAttemptStatus[]; hasNext: boolean }>
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

// エクスポート 1 ファイルの記録数・マイリストの上限（docs/data-model.md §7）。CPU 時間を見て調整する
export const EXPORT_PART = 500
export const EXPORT_WISHLIST_LIMIT = 5000

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
        desc(sql`COALESCE(${v.displayOn}, date(${v.createdAt}, '+9 hours'))`),
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

  // 日付は COALESCE で「左が NULL なら右」。WHERE は id と user_id の両方。
  // 新しい日付が開始日より前なら開始日を下げる（started_on <= finished_on を保つ。SQLite の MIN は NULL を返すので
  // 終了系で started_on が NULL のときは NULL のまま）
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
              startedOn: sql`MIN(COALESCE(${attempt.startedOn}, ${on}, ${today}), COALESCE(${on}, ${today}))`,
              finishedOn: null,
            }
          : (() => {
              const finishedOn = sql`COALESCE(${on}, ${attempt.finishedOn}, ${today})`
              return { finishedOn, startedOn: sql`MIN(${attempt.startedOn}, ${finishedOn})` }
            })()
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
    // played_on が開始日より前なら開始日を下げる（started_on <= finished_on を保つ）
    const startedOn = sql`MIN(COALESCE(${attempt.startedOn}, ${input.playedOn}), ${input.playedOn})`
    // keep で買った → 進行中に変わるときは setStatus と同じく finished_on を消す。
    // keep で status が終了系のまま（finished_on を書き換えない）なら、開始日は finished_on も超えない
    const set =
      outcome === 'keep'
        ? {
            status: sql`CASE WHEN ${attempt.status} = 'purchased' THEN 'in_progress' ELSE ${attempt.status} END`,
            finishedOn: sql`CASE WHEN ${attempt.status} = 'purchased' THEN NULL ELSE ${attempt.finishedOn} END`,
            startedOn: sql`CASE WHEN ${attempt.status} IN ('cleared', 'failed', 'dropped') THEN MIN(COALESCE(${attempt.startedOn}, ${input.playedOn}), ${input.playedOn}, COALESCE(${attempt.finishedOn}, ${input.playedOn})) ELSE ${startedOn} END`,
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
        imageUrl: work.imageUrl,
        imagePageUrl: work.imagePageUrl,
        imageBlocked: work.imageBlocked,
        orgImageBlocked: organization.imageBlocked,
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
      items: rows
        .slice(0, PAGE_SIZE)
        .map(({ orgId, orgName, imageUrl, imagePageUrl, imageBlocked, orgImageBlocked, ...r }) => ({
          ...r,
          org: orgId && orgName ? { id: orgId, name: orgName } : null,
          image: {
            url: imageUrl,
            pageUrl: imagePageUrl,
            blocked: imageBlocked,
            orgBlocked: orgImageBlocked,
          },
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
        oldestCreatedAt: sql<string | null>`min(${wishlist.createdAt})`,
      })
      .from(wishlist)
      .where(eq(wishlist.userId, viewerId))
      .get()
    return {
      total: row?.total ?? 0,
      played: row?.played ?? 0,
      oldestCreatedAt: row?.oldestCreatedAt ?? null,
    }
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

  async exportCounts() {
    const [attempts, sessions, wishes] = await db.batch([
      db.select({ n: sql<number>`count(*)` }).from(attempt).where(eq(attempt.userId, viewerId)),
      db.select({ n: sql<number>`count(*)` }).from(session).where(eq(session.userId, viewerId)),
      db.select({ n: sql<number>`count(*)` }).from(wishlist).where(eq(wishlist.userId, viewerId)),
    ])
    return {
      attempts: attempts[0]?.n ?? 0,
      sessions: sessions[0]?.n ?? 0,
      wishlist: wishes[0]?.n ?? 0,
    }
  },

  // 進行ログ・ジャンル・ネタバレは part の記録 id を副問い合わせで絞る（id を bind すると D1 の変数上限を超える）。
  // どの文も user_id = viewerId を入れる
  async exportPart(part, { spoiler }) {
    const offset = (part - 1) * EXPORT_PART
    const ids = db
      .select({ id: attempt.id })
      .from(attempt)
      .where(eq(attempt.userId, viewerId))
      .orderBy(asc(attempt.id))
      .limit(EXPORT_PART)
      .offset(offset)
    const rowsQ = db
      .select({ ...enrichedColumns, sourceRef: v.sourceRef })
      .from(v)
      .where(eq(v.userId, viewerId))
      .orderBy(asc(v.id))
      .limit(EXPORT_PART)
      .offset(offset)
    const genresQ = db
      .select({ attemptId: attemptGenre.attemptId, label: genre.label })
      .from(attemptGenre)
      .innerJoin(genre, eq(genre.id, attemptGenre.genreId))
      .where(and(eq(attemptGenre.userId, viewerId), inArray(attemptGenre.attemptId, ids)))
      .orderBy(asc(genre.sortOrder), asc(genre.id))
    const sessionsQ = db
      .select({
        id: session.id,
        attemptId: session.attemptId,
        playedOn: session.playedOn,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationSec: session.durationSec,
        progressNote: session.progressNote,
        companions: session.companions,
        memo: session.memo,
        locationText: session.locationText,
        createdAt: session.createdAt,
      })
      .from(session)
      .where(and(eq(session.userId, viewerId), inArray(session.attemptId, ids)))
      .orderBy(asc(session.playedOn), asc(session.createdAt), asc(session.id))
    // spoiler でなければネタバレの文は発行しない
    const [rows, genres, sessions, spoilers] = spoiler
      ? await db.batch([
          rowsQ,
          genresQ,
          sessionsQ,
          db
            .select({ id: attempt.id, spoilerMemo: attempt.spoilerMemo })
            .from(attempt)
            .where(and(eq(attempt.userId, viewerId), inArray(attempt.id, ids))),
        ])
      : [...(await db.batch([rowsQ, genresQ, sessionsQ])), null]
    const genresOf = Map.groupBy(genres, (g) => g.attemptId)
    const sessionsOf = Map.groupBy(sessions, (s) => s.attemptId)
    const spoilerOf = new Map(spoilers?.map((s) => [s.id, s.spoilerMemo]))
    return rows.map((r) => {
      const a = toAttemptRow(r)
      return {
        id: a.id,
        work: a.work,
        runId: a.runId,
        venue: a.run?.venue ? { name: a.run.venue.name, prefecture: a.run.venue.prefecture } : null,
        status: a.status,
        attemptNo: a.attemptNo,
        purchasedOn: a.purchasedOn,
        startedOn: a.startedOn,
        finishedOn: a.finishedOn,
        durationSec: a.durationSec,
        partySize: a.partySize,
        companions: a.companions,
        rating: a.rating,
        difficulty: a.difficulty,
        volume: a.volume,
        genres: (genresOf.get(a.id) ?? []).map((g) => g.label),
        memo: a.memo,
        ...(spoiler ? { spoilerMemo: spoilerOf.get(a.id) ?? null } : {}),
        sourceRef: r.sourceRef,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        sessions: (sessionsOf.get(a.id) ?? []).map(({ attemptId, ...s }) => s),
      }
    })
  },

  // 1 件多く読んで上限を超えたかを判定する
  async exportWishlist(limit = EXPORT_WISHLIST_LIMIT) {
    const rows = await db
      .select({
        workId: wishlist.workId,
        title: work.title,
        kind: work.kind,
        orgId: organization.id,
        orgName: organization.name,
        memo: wishlist.memo,
        createdAt: wishlist.createdAt,
      })
      .from(wishlist)
      .innerJoin(work, eq(work.id, wishlist.workId))
      .leftJoin(organization, eq(organization.id, work.primaryOrganizationId))
      .where(eq(wishlist.userId, viewerId))
      .orderBy(asc(wishlist.createdAt), asc(wishlist.workId))
      .limit(limit + 1)
    const items = rows.slice(0, limit).map((r) => ({
      work: {
        id: r.workId,
        title: r.title,
        kind: r.kind,
        org: r.orgId && r.orgName ? { id: r.orgId, name: r.orgName } : null,
      },
      memo: r.memo,
      createdAt: r.createdAt,
    }))
    return { items, truncated: rows.length > limit }
  },
})

const fv = vFriendAttempt

// フレンドの記録を読む唯一のクエリ。v_friend_attempt だけを読み、相手の user_id と共有範囲で必ず絞る
// （default_share_level / share_override は v1 では常に通るが、P11 で設定を出したときに穴にならないよう今から入れる）。
// asFriendOf の判定のあとに解除・ブロックされても読めないよう、friendship / 双方向の block もこのクエリの WHERE に入れる
const friendRepo = (
  db: Db,
  viewerId: string,
  targetUserId: string,
  displayName: string,
): FriendRepo => ({
  targetUserId,
  displayName,
  level: 'status',
  async listAttempts({ page }) {
    const date = sql`COALESCE(${fv.finishedOn}, ${fv.startedOn})`
    const rows = await db
      .select({
        workId: fv.workId,
        workTitle: fv.workTitle,
        workKind: fv.workKind,
        status: fv.status,
        startedOn: fv.startedOn,
        finishedOn: fv.finishedOn,
      })
      .from(fv)
      .innerJoin(user, eq(user.id, fv.userId))
      .where(
        and(
          eq(fv.userId, targetUserId),
          isNull(user.deletedAt),
          sql`EXISTS (SELECT 1 FROM ${friendship}
            WHERE ${friendship.userLo} = MIN(${viewerId}, ${fv.userId})
              AND ${friendship.userHi} = MAX(${viewerId}, ${fv.userId}))`,
          sql`NOT EXISTS (SELECT 1 FROM ${block}
            WHERE (${block.userId} = ${viewerId} AND ${block.blockedUserId} = ${fv.userId})
               OR (${block.userId} = ${fv.userId} AND ${block.blockedUserId} = ${viewerId}))`,
          ne(user.defaultShareLevel, 'none'),
          sql`COALESCE(${fv.shareOverride}, '') <> 'hidden'`,
        ),
      )
      .orderBy(asc(sql`${date} IS NULL`), desc(date), desc(fv.createdAt), desc(fv.workId))
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
    return { items: rows.slice(0, PAGE_SIZE), hasNext: rows.length > PAGE_SIZE }
  },
})

export const scopedTo = (db: Db, viewerId: string): Scoped => ({
  viewerId,
  own: () => ownRepo(db, viewerId),

  // friendship があり、どちらの向きにも block が無く、相手が退会していないときだけ返す。
  // 満たさなければ null（呼び出し側が 404 にする）。退会で friendship は消えるので deleted_at は二重の保険
  async asFriendOf(targetUserId: string) {
    if (targetUserId === viewerId) return null
    const [lo, hi] = viewerId < targetUserId ? [viewerId, targetUserId] : [targetUserId, viewerId]
    const [friend, blocked, target] = await db.batch([
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
      db
        .select({ displayName: user.displayName })
        .from(user)
        .where(and(eq(user.id, targetUserId), isNull(user.deletedAt)))
        .limit(1),
    ])
    if (friend.length === 0 || blocked.length > 0 || target.length === 0) return null
    return friendRepo(db, viewerId, targetUserId, target[0].displayName)
  },
})
