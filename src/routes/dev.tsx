// 仮ログイン（開発用）。AUTH_DEV_LOGIN="1"・APP_ORIGIN が許可ホスト・Host が許可ホストの 3 条件が揃ったときだけ有効
// 許可ホストは 127.0.0.1 / localhost と、AUTH_DEV_HOSTS に書いたプライベート IPv4

import { Hono } from 'hono'
import { loginWithIdentity, redirectAfterLogin } from '../auth/login'
import type { AppEnv } from '../env'
import { Field } from '../ui/components'
import { Document } from '../ui/Layout'

const dev = new Hono<AppEnv>({ strict: false })

const LOCAL_HOSTS = ['127.0.0.1', 'localhost']

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)

// 10.0.0.0/8・172.16.0.0/12・192.168.0.0/16 の IPv4 リテラルだけ true
const isPrivateIPv4 = (s: string): boolean => {
  const m = IPV4.exec(s)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// AUTH_DEV_HOSTS（カンマ区切り）からプライベート IPv4 だけ採用する。それ以外は無視
const allowedHosts = (extra: string | undefined): string[] => [
  ...LOCAL_HOSTS,
  ...(extra ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isPrivateIPv4),
]

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
  const hosts = allowedHosts(c.env.AUTH_DEV_HOSTS)
  const enabled =
    c.env.AUTH_DEV_LOGIN === '1' &&
    originHost !== null &&
    hosts.includes(originHost) &&
    reqHost !== null &&
    hosts.includes(reqHost)
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
