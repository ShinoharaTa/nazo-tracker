// 提案の一覧・承認・却下（/admin/proposals*）。requireOwner は admin/index.tsx で掛かる。
// 承認は src/pipeline/apply.ts が組み立てた文を db.batch の 1 回で書く。記録・人数は読まない（countsFor を呼ばない）。

import { type Context, Hono } from 'hono'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import { runStmts } from '../../db/master-write'
import {
  type AdminProposalTab,
  adminProposalTabs,
  countPendingProposals,
  getAdminProposal,
  getTargetRow,
  listAdminProposals,
  namesOf,
  nextPendingId,
  otherPendingForTarget,
  otherPendingWithEscapeUrl,
  resolveCandidates,
} from '../../db/proposals'
import type { AppEnv } from '../../env'
import {
  ALREADY_PROCESSED,
  approvalChoiceOf,
  buildApproval,
  buildRejection,
  kindSelectable,
  linkable,
  rejectionChoiceOf,
} from '../../pipeline/apply'
import type { ProposalTable } from '../../pipeline/fields'
import { AdminNotFound, AdminPage } from '../../ui/admin'
import {
  ProposalDetail,
  type ProposalDetailProps,
  ProposalsList,
  type RefNames,
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
  <AdminPage title="見つかりませんでした">
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
  return { p, fields, names, candidates, sameTarget, sameEscapeUrl, currentKind }
}

const detailPage = (d: Loaded, opts: Partial<ProposalDetailProps> = {}) => (
  <AdminPage title="提案">
    <ProposalDetail
      {...d}
      kindSelectable={kindSelectable(d.p, d.fields)}
      linkable={linkable(d.p)}
      {...opts}
    />
  </AdminPage>
)

proposals.get('/proposals', async (c) => {
  const db = c.get('db')
  const tab = toTab(c.req.query('tab'))
  const page = toPage(c.req.query('page'))
  const [{ items, hasNext }, pendingCount] = await Promise.all([
    listAdminProposals(db, { tab, page }),
    countPendingProposals(db),
  ])
  return c.html(
    <AdminPage title="提案">
      <ProposalsList
        tab={tab}
        pendingCount={pendingCount}
        items={items}
        page={page}
        hasNext={hasNext}
      />
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

export default proposals
