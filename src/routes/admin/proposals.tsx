// 提案の一覧・承認・まとめて承認・却下・自動反映の取り消しと ON/OFF（/admin/proposals*）。requireOwner は admin/index.tsx で掛かる。
// 承認・取り消しは src/pipeline/apply.ts が組み立てた文を db.batch の 1 回で書く。記録・人数は読まない（countsFor を呼ばない）。

import { type Context, Hono } from 'hono'
import { currentUser } from '../../auth/middleware'
import { createDb, type Db } from '../../db/client'
import { countingD1 } from '../../db/d1-count'
import { runStmts } from '../../db/master-write'
import {
  type AdminProposalField,
  type AdminProposalTab,
  adminProposalTabs,
  bulkApprovable,
  countPendingProposals,
  getAdminProposal,
  getAdminProposals,
  getRawRow,
  getTargetRow,
  listAdminProposals,
  namesOf,
  nextPendingId,
  otherPendingForTarget,
  otherPendingWithEscapeUrl,
  type ProposalRow,
  proposalStatusOf,
  resolveCandidates,
} from '../../db/proposals'
import { getAutoApply, setAutoApply } from '../../db/settings'
import type { AppEnv } from '../../env'
import {
  ALREADY_PROCESSED,
  appliedIdsOf,
  approvalChoiceOf,
  BULK_CALL_LIMIT,
  BULK_ITEM_WORST,
  BULK_MAX,
  BULK_PRE_CALLS,
  buildApproval,
  buildRejection,
  buildRevert,
  bulkChoiceOf,
  kindSelectable,
  linkable,
  REVERT_BLOCKED,
  REVERT_EXPIRED,
  rejectionChoiceOf,
  revertable,
} from '../../pipeline/apply'
import { type ProposalTable, placeholderOf } from '../../pipeline/fields'
import { AdminNotFound, AdminPage } from '../../ui/admin'
import {
  BulkConfirm,
  type BulkItem,
  type BulkResult,
  BulkResults,
  bulkItemOf,
  bulkMissingItemOf,
  headlineOf,
  ProposalDetail,
  type ProposalDetailProps,
  ProposalsList,
  type RefNames,
  RevertConfirm,
  refTables,
} from '../../ui/proposals'
import { toPage } from '../ui'

const proposals = new Hono<AppEnv>({ strict: false })

// 提案の中身（出典の抜粋・依頼元）を含むので共有キャッシュに載せない（/proposals 自体も含む）
proposals.use('/proposals/*', async (c, next) => {
  await next()
  c.res.headers.set('Cache-Control', 'private, no-store')
})

const toTab = (v: string | undefined): AdminProposalTab =>
  (adminProposalTabs as readonly string[]).includes(v ?? '') ? (v as AdminProposalTab) : 'pending'

const notFoundPage = () => (
  <AdminPage section="proposals" title="見つかりませんでした">
    <AdminNotFound back="/admin/proposals" />
  </AdminPage>
)

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>

// 詳細に出すもの一式（提案・項目・参照先の名前・候補・同じ対象 / 同じ URL の承認待ち）
const load = async (db: Db, id: string) => {
  const d = await getAdminProposal(db, id)
  if (!d) return null
  const { row: p, fields } = d
  const table = p.targetTable as ProposalTable
  const want: Record<ProposalTable, string[]> = {
    work: [],
    run: [],
    organization: [],
    venue: [],
    shop: [],
  }
  if (p.targetId && table in want) want[table].push(p.targetId)
  for (const f of fields) {
    const t = refTables[f.field]
    if (!t) continue
    for (const v of [f.oldValue, f.newValue]) if (v && !v.startsWith('@')) want[t].push(v)
  }
  const keys = Object.keys(want) as ProposalTable[]
  const [maps, candidates] = await Promise.all([
    Promise.all(keys.map((t) => namesOf(db, t, want[t]))),
    resolveCandidates(db, p.matchCandidatesJson),
  ])
  const names = Object.fromEntries(keys.map((t, n) => [t, maps[n]])) as RefNames
  const escapeUrl =
    p.kind === 'create' ? fields.find((f) => f.field === 'run.escape_id_url')?.newValue : null
  const pending = p.status === 'pending'
  const [sameTarget, sameEscapeUrl] = pending
    ? await Promise.all([
        otherPendingForTarget(db, p),
        escapeUrl ? otherPendingWithEscapeUrl(db, p, escapeUrl) : [],
      ])
    : [[], []]
  // update の形式の Select の既定（今の値）
  const currentKind =
    p.kind === 'update' && table === 'work' && p.targetId
      ? (((await getTargetRow(db, 'work', p.targetId))?.kind as string | null | undefined) ?? null)
      : null
  const parentStatus = p.followUpOfId ? await proposalStatusOf(db, p.followUpOfId) : null
  return { p, fields, names, candidates, sameTarget, sameEscapeUrl, currentKind, parentStatus }
}

const detailPage = (d: Loaded, opts: Partial<ProposalDetailProps> = {}) => (
  <AdminPage section="proposals" title="提案">
    <ProposalDetail
      {...d}
      kindSelectable={kindSelectable(d.p, d.fields)}
      linkable={linkable(d.p)}
      revertable={revertable(d.p)}
      {...opts}
    />
  </AdminPage>
)

proposals.get('/proposals', async (c) => {
  const db = c.get('db')
  const tab = toTab(c.req.query('tab'))
  const page = toPage(c.req.query('page'))
  const [{ items, hasNext }, pendingCount, autoApply] = await Promise.all([
    listAdminProposals(db, { tab, page }),
    countPendingProposals(db),
    getAutoApply(db),
  ])
  return c.html(
    <AdminPage section="proposals" title="提案">
      <ProposalsList
        tab={tab}
        pendingCount={pendingCount}
        items={items}
        page={page}
        hasNext={hasNext}
        autoApply={autoApply}
        saved={c.req.query('saved') === '1'}
      />
    </AdminPage>,
  )
})

// 自動反映の ON / OFF。Switch は on のときだけ auto_apply=on が届く。無ければ OFF
proposals.post('/proposals/settings', async (c) => {
  const body = await c.req.parseBody()
  await setAutoApply(c.get('db'), body.auto_apply === 'on', currentUser(c).id)
  return c.redirect('/admin/proposals?saved=1', 302)
})

// ---- まとめて承認（P5 計画 §4。create で候補 0 件の承認待ちを、1 件ずつ既存の承認処理に全項目採用で通す）

const BULK_NONE = '提案を 1 件以上選んでください。'
const BULK_NOT_ALLOWED = '候補つき・更新・紐付け・統合の提案は、詳細から 1 件ずつ承認してください。'
const BULK_NOT_FOUND = '提案が見つかりません。'
const BULK_WRITE_FAILED = '書き込めませんでした。詳細を開いて確かめてください。'

// 送られた id（空を除き、重複は 1 つに。送られた順）
const bulkIdsOf = (v: unknown): string[] => [
  ...new Set(
    (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== ''),
  ),
]

type BulkLoaded = {
  id: string
  d: { row: ProposalRow; fields: AdminProposalField[] } | null
  item: BulkItem
}

// 提案・項目と、表示に使う名前（題名・団体）。提案・項目は 1 文ずつ、名前は表ごとに 1 文で引く（1 提案あたり各表 2 つまで）
const bulkLoad = async (db: Db, ids: string[]): Promise<BulkLoaded[]> => {
  const loaded = await getAdminProposals(db, ids)
  const ds = ids.map((id) => loaded.get(id) ?? null)
  const want: Record<ProposalTable, string[]> = {
    work: [],
    run: [],
    organization: [],
    venue: [],
    shop: [],
  }
  for (const d of ds) {
    if (!d) continue
    const t = d.row.targetTable as ProposalTable
    if (d.row.kind !== 'create') {
      if (d.row.targetId && t in want) want[t].push(d.row.targetId)
      continue
    }
    for (const f of d.fields) {
      if (!f.newValue || placeholderOf(f)) continue
      if (f.field === 'run.work_id' && t === 'run') want.work.push(f.newValue)
      if (f.field === `${t}.primary_organization_id` || f.field === `${t}.organization_id`) {
        want.organization.push(f.newValue)
      }
    }
  }
  const keys = Object.keys(want) as ProposalTable[]
  const maps = await Promise.all(keys.map((t) => namesOf(db, t, want[t])))
  const names = Object.fromEntries(keys.map((t, n) => [t, maps[n]])) as RefNames
  return ids.map((id, n) => {
    const d = ds[n]
    return { id, d, item: d ? bulkItemOf(d.row, d.fields, names) : bulkMissingItemOf(id) }
  })
}

// まとめて承認に入れられない理由（入れられるなら null）
const bulkBlockOf = (l: BulkLoaded): string | null =>
  !l.d
    ? BULK_NOT_FOUND
    : l.d.row.status !== 'pending'
      ? ALREADY_PROCESSED
      : bulkApprovable(l.d.row)
        ? null
        : BULK_NOT_ALLOWED

const bulkErrorPage = (c: Context<AppEnv>, error: string) =>
  c.html(
    <AdminPage section="proposals" title="まとめて承認">
      <BulkConfirm items={[]} skipped={[]} errors={[error]} />
    </AdminPage>,
    400,
  )

// BULK_MAX を超えて選ばれたら先頭 BULK_MAX 件だけを対象にし、その旨を出す
const bulkOverNote = (all: number) =>
  all > BULK_MAX
    ? `${all} 件選ばれていました。一度に選べるのは ${BULK_MAX} 件までなので、先頭 ${BULK_MAX} 件だけを対象にしました。`
    : undefined

// 確認ページ（題名と団体の一覧）。GET なので書き込まない
proposals.get('/proposals/bulk', async (c) => {
  const all = bulkIdsOf(c.req.queries('id'))
  if (all.length === 0) return bulkErrorPage(c, BULK_NONE)
  const loaded = await bulkLoad(c.get('db'), all.slice(0, BULK_MAX))
  const items: BulkItem[] = []
  const skipped: BulkResult[] = []
  for (const l of loaded) {
    const block = bulkBlockOf(l)
    if (block) skipped.push({ ...l.item, result: 'failed', errors: [block] })
    else items.push(l.item)
  }
  return c.html(
    <AdminPage section="proposals" title="まとめて承認">
      <BulkConfirm items={items} skipped={skipped} over={bulkOverNote(all.length)} />
    </AdminPage>,
  )
})

// 1 件ずつ buildApproval → write（1 提案 = 1 batch、先頭の change_log で二重送信を止める）。失敗しても残りは進める。
// D1 の呼び出しを数え、次の 1 件を最悪の見積もりで足すと上限を超えるならそこで打ち切り、残りは「未処理」（pending のまま）
proposals.post('/proposals/bulk', async (c) => {
  const all = bulkIdsOf((await c.req.parseBody({ all: true })).id)
  if (all.length === 0) return bulkErrorPage(c, BULK_NONE)
  // middleware で使った分は見積もりで足しておく。write / getAdminProposal も c.get('db') を使うので差し替える
  const d1 = countingD1(c.env.DB, BULK_PRE_CALLS)
  const db = createDb(d1.db)
  c.set('db', db)
  const userId = currentUser(c).id
  const results: BulkResult[] = []
  for (const l of await bulkLoad(db, all.slice(0, BULK_MAX))) {
    const push = (result: BulkResult['result'], errors: string[] = []) =>
      results.push({ ...l.item, result, errors })
    const block = bulkBlockOf(l)
    if (block || !l.d) {
      push('failed', [block ?? BULK_NOT_FOUND])
      continue
    }
    if (d1.n.calls + BULK_ITEM_WORST > BULK_CALL_LIMIT) {
      push('unprocessed')
      continue
    }
    try {
      const r = await buildApproval(db, l.d.row, l.d.fields, bulkChoiceOf(l.d.fields), [], userId)
      if (!r.ok) push('failed', r.errors)
      else if (!(await write(c, l.id, r.stmts))) push('failed', [ALREADY_PROCESSED])
      else push('applied')
    } catch (e) {
      console.error(`まとめて承認: ${l.id}`, e)
      push('failed', [BULK_WRITE_FAILED])
    }
  }
  return c.html(
    <AdminPage section="proposals" title="まとめて承認">
      <BulkResults results={results} over={bulkOverNote(all.length)} />
    </AdminPage>,
  )
})

proposals.get('/proposals/:id', async (c) => {
  const db = c.get('db')
  const d = await load(db, c.req.param('id'))
  if (!d) return c.html(notFoundPage(), 404)
  const applied = c.req.query('applied') === '1'
  return c.html(
    detailPage(d, { applied, nextId: applied ? await nextPendingId(db, d.p.id) : null }),
  )
})

const isNotNullViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes('NOT NULL constraint failed')

// 文を書く。読んでから書くまでの間に処理されていた（先頭の提案の change_log が NOT NULL で落ちる）なら false
const write = async (
  c: Context<AppEnv>,
  id: string,
  stmts: Parameters<typeof runStmts>[1],
): Promise<boolean> => {
  try {
    await runStmts(c.get('db'), stmts)
    return true
  } catch (e) {
    if (!isNotNullViolation(e)) throw e
    const now = await getAdminProposal(c.get('db'), id)
    if (now?.row.status === 'pending') throw e
    return false
  }
}

const alreadyProcessed = async (c: Context<AppEnv>, id: string) => {
  const d = await load(c.get('db'), id)
  if (!d) return c.html(notFoundPage(), 404)
  return c.html(detailPage(d, { errors: [ALREADY_PROCESSED] }), 409)
}

proposals.post('/proposals/:id/approve', async (c) => {
  const db = c.get('db')
  const d = await load(db, c.req.param('id'))
  if (!d) return c.html(notFoundPage(), 404)
  if (d.p.status !== 'pending') return c.html(detailPage(d, { errors: [ALREADY_PROCESSED] }), 409)
  const choice = approvalChoiceOf(await c.req.parseBody(), d.fields)
  const r = await buildApproval(db, d.p, d.fields, choice, d.candidates, currentUser(c).id)
  if (!r.ok) {
    return c.html(
      detailPage(d, { choice, errors: r.errors, stale: r.status === 409 ? r.stale : undefined }),
      r.status,
    )
  }
  if (!(await write(c, d.p.id, r.stmts))) return alreadyProcessed(c, d.p.id)
  return c.redirect(`/admin/proposals/${encodeURIComponent(d.p.id)}?applied=1`, 302)
})

proposals.post('/proposals/:id/reject', async (c) => {
  const db = c.get('db')
  const d = await load(db, c.req.param('id'))
  if (!d) return c.html(notFoundPage(), 404)
  if (d.p.status !== 'pending') return c.html(detailPage(d, { errors: [ALREADY_PROCESSED] }), 409)
  const rejection = rejectionChoiceOf(await c.req.parseBody())
  const r = buildRejection(db, d.p, rejection, currentUser(c).id)
  if (!r.ok) return c.html(detailPage(d, { rejection, rejectErrors: r.errors }), 400)
  if (!(await write(c, d.p.id, r.stmts))) return alreadyProcessed(c, d.p.id)
  return c.redirect('/admin/proposals?tab=pending', 302)
})

const isFkViolation = (e: unknown) =>
  String((e as { cause?: unknown })?.cause ?? e).includes('FOREIGN KEY constraint failed')

// 取り消せないときの統合画面（作った作品か、回の作品）
const mergeHrefOf = async (db: Db, d: Loaded): Promise<string | null> => {
  const a = appliedIdsOf(d.p.appliedJson)
  const workId =
    a.work ?? (a.run ? ((await getRawRow(db, 'run', a.run))?.workId as string | undefined) : null)
  return workId ? `/admin/works?merge_from=${encodeURIComponent(workId)}` : null
}

const revertPage = (d: Loaded, opts: { error?: string; mergeHref?: string | null } = {}) => (
  <AdminPage section="proposals" title="自動反映の取り消し">
    <RevertConfirm
      p={d.p}
      headline={headlineOf(d.p, d.fields, d.names)}
      canRevert={revertable(d.p) && opts.error !== REVERT_BLOCKED}
      {...opts}
    />
  </AdminPage>
)

proposals.get('/proposals/:id/revert', async (c) => {
  const d = await load(c.get('db'), c.req.param('id'))
  if (!d) return c.html(notFoundPage(), 404)
  return c.html(revertPage(d, revertable(d.p) ? {} : { error: REVERT_EXPIRED }))
})

proposals.post('/proposals/:id/revert', async (c) => {
  const db = c.get('db')
  const d = await load(db, c.req.param('id'))
  if (!d) return c.html(notFoundPage(), 404)
  if (!revertable(d.p)) return c.html(revertPage(d, { error: REVERT_EXPIRED }), 409)
  const body = await c.req.parseBody()
  if (body.confirm !== 'yes') {
    return c.html(revertPage(d, { error: '確認のチェックを入れてください。' }), 400)
  }
  const blocked = async () =>
    c.html(revertPage(d, { error: REVERT_BLOCKED, mergeHref: await mergeHrefOf(db, d) }), 409)
  const r = await buildRevert(db, d.p, currentUser(c).id)
  if (!r.ok) return r.error === REVERT_BLOCKED ? blocked() : c.html(revertPage(d, r), 409)
  try {
    await runStmts(db, r.stmts)
  } catch (e) {
    // あとから記録・別名・別の回などが付いた（何が付いたかは読まない）
    if (isFkViolation(e)) return blocked()
    // 読んでから書くまでの間に取り消された・期限を過ぎた（先頭の提案の change_log が NOT NULL で落ちる）
    if (!isNotNullViolation(e)) throw e
    const now = await load(db, d.p.id)
    if (!now) return c.html(notFoundPage(), 404)
    if (revertable(now.p)) throw e
    return c.html(revertPage(now, { error: REVERT_EXPIRED }), 409)
  }
  return c.redirect(`/admin/proposals/${encodeURIComponent(d.p.id)}`, 302)
})

export default proposals
