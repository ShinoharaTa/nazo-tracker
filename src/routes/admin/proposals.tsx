// 提案の一覧・承認・却下・自動反映の取り消しと ON/OFF（/admin/proposals*）。requireOwner は admin/index.tsx で掛かる。
// 承認・取り消しは src/pipeline/apply.ts が組み立てた文を db.batch の 1 回で書く。記録・人数は読まない（countsFor を呼ばない）。

import { type Context, Hono } from 'hono'
import { currentUser } from '../../auth/middleware'
import type { Db } from '../../db/client'
import { runStmts } from '../../db/master-write'
import {
  type AdminProposalTab,
  adminProposalTabs,
  countPendingProposals,
  getAdminProposal,
  getRawRow,
  getTargetRow,
  listAdminProposals,
  namesOf,
  nextPendingId,
  otherPendingForTarget,
  otherPendingWithEscapeUrl,
  resolveCandidates,
} from '../../db/proposals'
import { getAutoApply, setAutoApply } from '../../db/settings'
import type { AppEnv } from '../../env'
import {
  ALREADY_PROCESSED,
  appliedIdsOf,
  approvalChoiceOf,
  buildApproval,
  buildRejection,
  buildRevert,
  kindSelectable,
  linkable,
  REVERT_BLOCKED,
  REVERT_EXPIRED,
  rejectionChoiceOf,
  revertable,
} from '../../pipeline/apply'
import type { ProposalTable } from '../../pipeline/fields'
import { AdminNotFound, AdminPage } from '../../ui/admin'
import {
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
    <AdminPage title="提案">
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
  <AdminPage title="自動反映の取り消し">
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
