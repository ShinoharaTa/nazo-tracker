// 仮ログイン（開発用）。AUTH_DEV_LOGIN="1"・APP_ORIGIN がローカル・Host がローカルの 3 条件が揃ったときだけ有効

import { Hono } from 'hono'
import { loginWithIdentity, redirectAfterLogin } from '../auth/login'
import type { AppEnv } from '../env'
import { Field } from '../ui/components'
import { Document } from '../ui/Layout'

const dev = new Hono<AppEnv>({ strict: false })

const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

const hostnameOf = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

dev.use('*', async (c, next) => {
  const originHost = hostnameOf(new URL(c.env.APP_ORIGIN).host)
  const reqHost = hostnameOf(c.req.header('host') ?? new URL(c.req.url).host)
  const enabled =
    c.env.AUTH_DEV_LOGIN === '1' &&
    originHost !== null &&
    LOCAL_HOSTS.includes(originHost) &&
    reqHost !== null &&
    LOCAL_HOSTS.includes(reqHost)
  if (!enabled) return c.notFound()
  await next()
})

dev.get('/login', (c) =>
  c.html(
    <Document title="仮ログイン">
      <div id="app">
        <form class="login" method="post" action="/_dev/login">
          <h1>仮ログイン</h1>
          <p class="note" style="margin:0">
            開発用。provider = dev の identity でログインします。
          </p>
          <Field label="subject" name="subject" value="owner" />
          <button type="submit" class="btn pri">
            ログイン
          </button>
        </form>
      </div>
    </Document>,
  ),
)

dev.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(subject)) {
    return c.text('subject は英数字・_・- の 1〜32 文字にしてください', 400)
  }
  const { isNew } = await loginWithIdentity(c, { provider: 'dev', subject })
  return redirectAfterLogin(c, isNew)
})

export default dev
