// 部品見本（/_ui 以下）。UI_GALLERY="1" のときだけ index.ts から渡される

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { Gallery, galleryRecord } from '../ui/Gallery'
import { SpoilerFragment, SpoilerPage, spoilerHeaders } from '../ui/spoiler'

const gallery = new Hono<AppEnv>({ strict: false })

gallery.get('/', (c) => c.html(<Gallery />))

// 見本の SpoilerCard の取得先。星降る街の記録のネタバレを返す。
// 見本は OwnAttempt を作れないので spoilerResponse を使わず、断片・全体ページとヘッダを自分で組む
gallery.get('/spoiler', (c) => {
  const r = galleryRecord()
  const body = {
    memo: r.spoiler,
    photos: r.photos.filter((p) => p.sp).map((p) => ({ label: p.k })),
  }
  spoilerHeaders(c)
  if (c.req.header('X-Requested-With') === 'fetch') return c.html(<SpoilerFragment {...body} />)
  return c.html(<SpoilerPage body={body} page={{ back: '/_ui', tab: 'records' }} />)
})

export default gallery
