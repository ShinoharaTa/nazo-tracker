// 部品見本（GET /_ui）。左にモックの記録一覧、右に「星降る街の周遊録」の記録詳細と部品を並べる。

import {
  Bars,
  Empty,
  Field,
  Kpis,
  MonthCols,
  Sheet,
  SpoilerCard,
  StatusChip,
  StatusSeg,
  StubDate,
  Switch,
  Tabs,
  Ticket,
  TopBar,
} from './components'
import { type GalleryRecord, records, works } from './gallery-data'
import { Layout } from './Layout'
import { workKindLabels } from './labels'

const SELECTED = 'r2'

const workOf = (r: GalleryRecord) => {
  const w = works.find((x) => x.id === r.work)
  if (!w) throw new Error(`unknown work: ${r.work}`)
  return w
}

// 進行中や日付未入力で進行ログがある記録は、最新の進行ログの日付を出す（モックの stubDate と同じ）
const stubDateOf = (r: GalleryRecord): string | null => {
  const d =
    r.status === 'in_progress' || (!r.date && r.sessions.length) ? r.sessions[0]?.date : r.date
  return d || null
}

const List = () => (
  <>
    <TopBar
      title="記録"
      action={
        <a class="btn ghost" style="min-height:40px" href="/_ui">
          {records.filter((r) => r.status === 'cleared' || r.status === 'failed').length} 件プレイ ›
        </a>
      }
    />
    <Tabs
      items={[
        { key: 'all', label: 'すべて', href: '/_ui' },
        { key: 'pending', label: '進行中・積み謎', href: '/_ui' },
        { key: 'wish', label: 'マイリスト', href: '/_ui' },
      ]}
      current="all"
      label="記録の絞り込み"
    />
    <div class="list">
      {records.map((r) => {
        const w = workOf(r)
        const extra = [r.diff ? `難易度 ${r.diff}` : '', r.companions ? `同行 ${r.companions}` : '']
          .filter(Boolean)
          .join(' · ')
        return (
          <Ticket
            href="/_ui"
            selected={r.id === SELECTED}
            stub={<StubDate date={stubDateOf(r)} />}
            meta={`${workKindLabels[w.kind]} · ${w.org}`}
            title={w.title}
            chip={<StatusChip status={r.status} />}
            extra={extra || undefined}
          />
        )
      })}
    </div>
  </>
)

// 右ページに出す記録（星降る街の周遊録）
export const galleryRecord = (): GalleryRecord => {
  const r = records.find((x) => x.id === SELECTED)
  if (!r) throw new Error('gallery record not found')
  return r
}

const Detail = () => {
  const r = galleryRecord()
  const w = workOf(r)
  const spPhotos = r.photos.filter((p) => p.sp)
  const pubPhotos = r.photos.filter((p) => !p.sp)
  return (
    <>
      <TopBar
        back="/_ui"
        label="記録"
        action={
          <button type="button" class="btn ghost" style="min-height:40px" data-open="gallery-sheet">
            編集
          </button>
        }
      />
      <div class="card">
        <div style="display:flex;flex-direction:column;gap:6px">
          <span class="meta">
            {workKindLabels[w.kind]} · {w.org} · {w.area} ›
          </span>
          <span class="title" style="font-size:22px">
            {w.title}
          </span>
        </div>
        <div class="row" style="justify-content:flex-start">
          <StatusChip status={r.status} />
          {r.sessions[0] ? (
            <span class="note">
              {r.sessions[0].progress} · {r.sessions.length}日目
            </span>
          ) : null}
        </div>
        <div class="nums">
          <div class="num">
            <span>難易度</span>
            <b>{r.diff || '–'}/5</b>
          </div>
          <div class="num">
            <span>物量</span>
            <b>{r.vol || '–'}/5</b>
          </div>
          <div class="num">
            <span>合計</span>
            <b>{r.sessions.length ? `${r.sessions.length}日` : '–'}</b>
          </div>
        </div>
      </div>
      <div class="sect">
        <h2>ステータス</h2>
        <StatusSeg name="status" value={r.status} idPrefix="detail-status" />
      </div>
      <div class="sect">
        <h2>参加</h2>
        <dl class="kv">
          <dt>開始日</dt>
          <dd>{r.sessions[r.sessions.length - 1]?.date}</dd>
          <dt>同行者</dt>
          <dd>{r.companions}</dd>
          <dt>人数</dt>
          <dd>{r.party}人</dd>
        </dl>
      </div>
      <div class="sect">
        <h2>ジャンル</h2>
        <div class="gtags">
          {r.genres.map((g) => (
            <span class="gtag">{g}</span>
          ))}
        </div>
      </div>
      <div class="sect">
        <div class="row">
          <h2>進行ログ</h2>
          <button type="button" class="btn" style="min-height:40px;background:none">
            ＋ 進行ログ
          </button>
        </div>
        {r.sessions.map((s, i) => (
          <div class="log">
            <div class="rail">
              <div class="dot" />
              {i < r.sessions.length - 1 ? <div class="ln" /> : null}
            </div>
            <div class="body">
              <span class="sub">
                {s.date} · {s.time}
              </span>
              <b>{s.progress}</b>
              {s.memo ? (
                <span class="note" style="font-size:13px">
                  {s.memo}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div class="sect">
        <h2>写真</h2>
        <div class="photos">
          {pubPhotos.map((p) => (
            <div class="ph">{p.k}</div>
          ))}
          <button type="button" class="ph add" aria-label="写真を追加">
            ＋
          </button>
        </div>
      </div>
      <div class="sect">
        <SpoilerCard
          src="/_ui/spoiler"
          count={{ memo: r.spoiler ? 1 : 0, photos: spPhotos.length }}
        />
      </div>
      <div class="sect">
        <button type="button" class="btn danger">
          記録を削除
        </button>
      </div>
    </>
  )
}

// 蛍光マーカー 7 色（docs/visual-design.md §3.1）。黄以外は統計のグラフ系列だけに使う
const markers = [
  { name: 'yellow', label: '黄（強調・持ち帰り）' },
  { name: 'green', label: '緑（成功）' },
  { name: 'pink', label: 'ピンク（失敗）' },
  { name: 'cyan', label: '水色（Web）' },
  { name: 'orange', label: '橙（周遊）' },
  { name: 'purple', label: '紫（LINE）' },
  { name: 'gray', label: '灰（その他・形式未設定）' },
] as const

const Parts = () => (
  <>
    <div class="sect">
      <h2>部品: 蛍光マーカー</h2>
      <div style="display:flex;flex-direction:column;gap:6px">
        {markers.map((m) => (
          <div class="row" style="justify-content:flex-start;gap:8px">
            <i
              style={`display:inline-block;width:28px;height:16px;border:1px solid var(--fg);background:var(--mk-${m.name})`}
            />
            {m.name === 'yellow' ? (
              <span class="hl">{m.label}</span>
            ) : m.name === 'green' || m.name === 'pink' ? (
              <span class={`hl mk-${m.name}`}>{m.label}</span>
            ) : (
              // クラスを作っていない色は見本だけ inline で塗る
              <span class="hl" style={`--hl:var(--mk-${m.name})`}>
                {m.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
    <div class="sect">
      <h2>部品: StatusSeg</h2>
      <StatusSeg name="status-sample" idPrefix="parts-status" />
    </div>
    <div class="sect">
      <h2>部品: Switch</h2>
      <Switch label="断念を失敗に含める" name="sw-off" />
      <Switch label="作品の人数に自分を含める" name="sw-on" checked />
    </div>
    <div class="sect">
      <h2>部品: Kpis</h2>
      <Kpis
        items={[
          { label: 'プレイ', value: 6, note: 'クリア 3 / 失敗 3' },
          { label: '成功率', value: '50%', note: '断念を除く' },
          { label: '積み謎', value: 2, note: '買った・進行中' },
        ]}
      />
    </div>
    <div class="sect">
      <h2>部品: Bars</h2>
      <Bars
        items={[
          { label: '★2', total: 1, cleared: 1 },
          { label: '★3', total: 1, cleared: 1 },
          { label: '★4', total: 3, cleared: 1 },
          { label: '★5', total: 1, cleared: 0 },
          { label: '★1', total: 0, cleared: 0 },
        ]}
      />
    </div>
    <div class="sect">
      <h2>部品: MonthCols</h2>
      <MonthCols counts={[0, 0, 0, 0, 1, 1, 0, 1, 1, 2, 0, 0]} />
    </div>
    <div class="sect">
      <h2>部品: Empty</h2>
      <Empty>ここに出る記録はまだありません。</Empty>
    </div>
    <div class="sect">
      <h2>部品: Sheet</h2>
      <button type="button" class="btn" data-open="gallery-sheet">
        シートを開く
      </button>
    </div>
    <Sheet id="gallery-sheet" title="記録を編集">
      <div class="grid2">
        <Field label="日付" name="date" type="date" value="2026-10-04" />
        <Field label="人数" name="party" type="number" value="2" />
      </div>
      <Field label="同行者" name="companions" value="みお" placeholder="例: みお、けい" />
      <Field label="メモ" name="memo" multiline />
      <div class="btns">
        <button type="button" class="btn" data-close>
          やめる
        </button>
        <button type="button" class="btn pri" data-close>
          保存
        </button>
      </div>
    </Sheet>
  </>
)

export const Gallery = () => (
  <Layout
    title="部品見本"
    tab="records"
    left={<List />}
    right={
      <>
        <Detail />
        <Parts />
      </>
    }
  />
)
