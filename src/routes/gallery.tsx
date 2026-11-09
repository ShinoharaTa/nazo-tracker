// 部品見本（/_ui 以下）。UI_GALLERY="1" のときだけ index.ts から渡される

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { Gallery, galleryRecord } from '../ui/Gallery'
import { spoilerResponse } from '../ui/spoiler'

const gallery = new Hono<AppEnv>({ strict: false })

gallery.get('/', (c) => c.html(<Gallery />))

// 見本の SpoilerCard の取得先。星降る街の記録のネタバレを返す
gallery.get('/spoiler', (c) => {
  const r = galleryRecord()
  return spoilerResponse(
    c,
    { memo: r.spoiler, photos: r.photos.filter((p) => p.sp).map((p) => ({ label: p.k })) },
    { back: '/_ui', tab: 'records' },
  )
})

export default gallery
