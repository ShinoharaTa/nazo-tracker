// agent トークンの一覧・発行・失効（/admin/tokens*）。requireOwner は admin/index.tsx で掛かる。
// 発行の POST は 302 せず、その場で平文を 1 回だけ表示する（D1 にはハッシュしか残らない）。

import { Hono } from 'hono'
import {
  createToken,
  getToken,
  listTokens,
  revokeToken,
  TOKEN_DAYS,
  type TokenRow,
} from '../../db/tokens'
import type { AppEnv } from '../../env'
import { done, type Form, field, formOf, oneOf, str } from '../../lib/form'
import { isoToJstDate, isPast } from '../../lib/time'
import { AdminNotFound, AdminPage } from '../../ui/admin'
import { Empty, Field, FormErrors, Select, TopBar } from '../../ui/components'

const NAME_MAX = 40
const DEFAULT_DAYS = '90'
const fields = ['name', 'days'] as const

const tokens = new Hono<AppEnv>({ strict: false })

// 平文を含む応答があるので、一覧も含めて共有キャッシュに載せない
tokens.use('/tokens/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'private, no-store')
})

const stateOf = (t: TokenRow): string => {
  if (t.revokedAt) return '失効'
  if (!t.expiresAt || isPast(t.expiresAt)) return '期限切れ'
  return '有効'
}

const dateOf = (iso: string | null, empty: string) => (iso ? (isoToJstDate(iso) ?? iso) : empty)

const validate = (form: Form) => {
  const errors: string[] = []
  const name = field(errors, '名前', form.name, str(NAME_MAX), true)
  const days = field(
    errors,
    '期限',
    form.days,
    oneOf(TOKEN_DAYS.map(String) as readonly string[]),
    true,
  )
  return done(errors, { name: name ?? '', days: Number(days) })
}

const NewForm = ({ values, errors = [] }: { values: Form; errors?: readonly string[] }) => (
  <form method="post" action="/admin/tokens" class="list">
    <FormErrors errors={errors} />
    <Field label="名前" name="name" value={values.name} required />
    <Select
      label="期限"
      name="days"
      options={TOKEN_DAYS.map((d) => ({ value: String(d), label: `${d} 日` }))}
      value={values.days}
      required
    />
    <button type="submit" class="btn pri">
      発行
    </button>
  </form>
)

const newPage = (values: Form, errors?: readonly string[]) => (
  <AdminPage title="agent トークンを発行">
    <TopBar back="/admin/tokens" label="agent トークンを発行" />
    <div class="sect" style="margin-top:4px">
      <NewForm values={values} errors={errors} />
    </div>
  </AdminPage>
)

tokens.get('/tokens', async (c) => {
  const rows = await listTokens(c.get('db'))
  return c.html(
    <AdminPage title="agent トークン">
      <TopBar
        back="/settings"
        label="agent トークン"
        action={
          <a class="btn" href="/admin/tokens/new">
            発行
          </a>
        }
      />
      <div class="sect" style="margin-top:4px">
        {rows.length ? (
          <div class="list">
            {rows.map((t) => {
              const state = stateOf(t)
              return (
                <div class="card">
                  <p>{t.name}</p>
                  <dl class="kv">
                    <dt>状態</dt>
                    <dd>{state}</dd>
                    <dt>作成日</dt>
                    <dd>{dateOf(t.createdAt, '')}</dd>
                    <dt>期限</dt>
                    <dd>{dateOf(t.expiresAt, 'なし')}</dd>
                    <dt>最終利用</dt>
                    <dd>{dateOf(t.lastUsedAt, '未使用')}</dd>
                  </dl>
                  {state === '有効' ? (
                    <form method="post" action={`/admin/tokens/${t.id}/revoke`}>
                      <button type="submit" class="btn danger">
                        失効
                      </button>
                    </form>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <Empty>トークンはありません。</Empty>
        )}
      </div>
    </AdminPage>,
  )
})

tokens.get('/tokens/new', (c) => c.html(newPage({ name: '', days: DEFAULT_DAYS })))

tokens.post('/tokens', async (c) => {
  const form = formOf(await c.req.parseBody(), fields)
  const v = validate(form)
  if (!v.ok) return c.html(newPage(form, v.errors), 400)
  const { token, expiresAt } = await createToken(c.get('db'), v.value.name, v.value.days)
  return c.html(
    <AdminPage title="agent トークンを発行しました">
      <TopBar back="/admin/tokens" label="発行しました" />
      <div class="sect" style="margin-top:4px">
        <div class="list">
          {/* 47 文字の切れ目の無い文字列なので、狭い画面では途中で折り返す */}
          <p style="overflow-wrap:anywhere">
            <code>{token}</code>
          </p>
          <p class="note">
            この画面を閉じると二度と表示されません。サーバーの
            <code>~/.config/nazo-tracker/agent.env</code> に <code>NAZO_AGENT_TOKEN=…</code>
            として保存し、<code>chmod 600</code> してください。
          </p>
          <p class="note">再読み込みすると、もう 1 本発行されます。</p>
          <p class="note">期限: {dateOf(expiresAt, '')}</p>
          <a class="btn" href="/admin/tokens">
            一覧へ
          </a>
        </div>
      </div>
    </AdminPage>,
  )
})

tokens.post('/tokens/:id/revoke', async (c) => {
  const db = c.get('db')
  const t = await getToken(db, c.req.param('id'))
  if (!t) {
    return c.html(
      <AdminPage title="見つかりませんでした">
        <AdminNotFound back="/admin/tokens" />
      </AdminPage>,
      404,
    )
  }
  await revokeToken(db, t.id)
  return c.redirect('/admin/tokens', 302)
})

export default tokens
