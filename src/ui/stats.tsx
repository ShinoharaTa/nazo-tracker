// 本人の統計（/stats）。集計は src/lib/stats.ts。JS は使わず、見方（来場型 / 完了型）と年は GET パラメータで切り替える

import type { DoneKind, Stats, VisitKind } from '../lib/stats'
import {
  CountBars,
  doneKindClass,
  Empty,
  Kpis,
  Legend,
  MonthStack,
  RateBars,
  TopBar,
} from './components'
import { workKindLabels } from './labels'

export type StatsView = 'visit' | 'done'

export type StatsPageProps = {
  stats: Stats
  view: StatsView
  year: number
  thisYear: number
  minYear: number
  capped: boolean
  wishlist: { total: number; played: number }
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

// view は既定がデータ次第なので常に付ける。year は今年なら省く
const statsHref = (p: { view: StatsView; year: number; thisYear: number }) => {
  const sp = new URLSearchParams({ view: p.view })
  if (p.year !== p.thisYear) sp.set('year', String(p.year))
  return `/stats?${sp.toString()}`
}

const doneKindLabel = (k: DoneKind) => (k === null ? '形式未設定' : workKindLabels[k])
const visitKindLabel = (k: VisitKind) => workKindLabels[k]

const resultSeries = {
  cls: (k: 'cleared' | 'failed') => (k === 'cleared' ? 'r-ok' : 'r-ng'),
  label: (k: 'cleared' | 'failed') => (k === 'cleared' ? '成功' : '失敗'),
}
const resultLegend = [
  { label: '成功', cls: 'r-ok' },
  { label: '失敗', cls: 'r-ng' },
]

const sumSeries = (series: readonly { counts: readonly number[] }[]) =>
  series.reduce((sum, s) => sum + s.counts.reduce((a, b) => a + b, 0), 0)

const MonthHead = (p: StatsPageProps & { title: string }) => (
  <div class="row">
    <h2>
      {p.title} {p.year} 年
    </h2>
    <nav aria-label="年" style="display:flex;gap:8px">
      {p.year > p.minYear ? (
        <a class="btn ghost" href={statsHref({ ...p, year: p.year - 1 })}>
          ‹ 前年
        </a>
      ) : null}
      {p.year < p.thisYear ? (
        <a class="btn ghost" href={statsHref({ ...p, year: p.year + 1 })}>
          翌年 ›
        </a>
      ) : null}
    </nav>
  </div>
)

const Wishlist = ({ wishlist }: StatsPageProps) => (
  <div class="sect">
    <h2>マイリスト</h2>
    <p>
      {wishlist.total} 件 · うちプレイ済み {wishlist.played} 件
    </p>
  </div>
)

const VisitView = (p: StatsPageProps) => {
  const { summary, byDifficulty, byGenre, byKind, monthly } = p.stats.visit
  const noResult = <Empty>ルーム・公演の結果はまだありません。</Empty>
  return (
    <>
      <Kpis
        items={[
          {
            label: '成功率',
            hero: true,
            mark: 'green',
            value: pct(summary.rate),
            note: `作品ベース ${pct(summary.rateByWork)}`,
          },
          {
            label: '参加',
            value: summary.played,
            note: `成功 ${summary.cleared} / 失敗 ${summary.failed}`,
          },
          { label: '予約済み', value: summary.reserved, note: '参加予定' },
        ]}
      />
      {summary.played ? (
        <div class="sect">
          <Legend items={resultLegend} />
        </div>
      ) : null}
      <div class="sect">
        <h2>難易度別の成功率</h2>
        {summary.played ? <RateBars items={byDifficulty} /> : noResult}
      </div>
      <div class="sect">
        <h2>ジャンル別の成功率</h2>
        {byGenre.length ? <RateBars items={byGenre} /> : <Empty>まだデータがありません。</Empty>}
      </div>
      <div class="sect">
        <h2>形式別の成功率</h2>
        {summary.played ? (
          <RateBars items={byKind.map((k) => ({ ...k, label: visitKindLabel(k.kind) }))} />
        ) : (
          noResult
        )}
      </div>
      <div class="sect">
        <MonthHead {...p} title="月別の成功・失敗" />
        {sumSeries(monthly) ? (
          <MonthStack series={monthly} {...resultSeries} />
        ) : (
          <Empty>{p.year} 年の記録はありません。</Empty>
        )}
      </div>
      {summary.excluded ? (
        <p class="note">
          ルーム・公演の「進行中」「断念」（以前の記録）{summary.excluded}{' '}
          件は集計に入れていません。
        </p>
      ) : null}
      <Wishlist {...p} />
      <p class="note" style="margin-top:14px">
        成功率 = 成功 ÷（成功＋失敗）。予約済みは含めません。統計は自分だけに表示されます。
      </p>
    </>
  )
}

const DoneView = (p: StatsPageProps) => {
  const { summary, byKind, monthly } = p.stats.done
  return (
    <>
      <Kpis
        items={[
          {
            label: '完了',
            hero: true,
            value: summary.cleared,
            note: `断念 ${summary.dropped}${summary.failed ? ` · 失敗 ${summary.failed}` : ''}`,
          },
          { label: '進行中', value: summary.inProgress, note: '始めた・続きあり' },
          { label: '積み謎', value: summary.backlog, note: '買った・未着手' },
        ]}
      />
      <div class="sect">
        <h2>形式別の完了数</h2>
        {byKind.length ? (
          <CountBars
            items={byKind.map((k) => ({
              label: doneKindLabel(k.kind),
              count: k.cleared,
              cls: doneKindClass(k.kind),
            }))}
          />
        ) : (
          <Empty>まだ完了した記録がありません。</Empty>
        )}
      </div>
      <div class="sect">
        <MonthHead {...p} title="月別の完了数" />
        {sumSeries(monthly) ? (
          <>
            <Legend
              items={monthly.map((s) => ({
                label: doneKindLabel(s.key),
                cls: doneKindClass(s.key),
              }))}
            />
            <MonthStack series={monthly} cls={doneKindClass} label={doneKindLabel} />
          </>
        ) : (
          <Empty>{p.year} 年の記録はありません。</Empty>
        )}
      </div>
      <Wishlist {...p} />
      <p class="note" style="margin-top:14px">
        完了 =
        クリアした記録の数です。ルーム・公演は「ルーム・公演」で成功率として見られます。統計は自分だけに表示されます。
      </p>
    </>
  )
}

export const StatsPage = (p: StatsPageProps) => (
  <>
    <TopBar title="統計" />
    <nav class="chips" aria-label="集計の対象">
      {[
        { view: 'visit' as const, label: 'ルーム・公演' },
        { view: 'done' as const, label: '持ち帰り・周遊など' },
      ].map((f) => {
        const href = statsHref({ view: f.view, year: p.year, thisYear: p.thisYear })
        return f.view === p.view ? (
          <a class="fchip on" href={href} aria-current="page">
            {f.label}
          </a>
        ) : (
          <a class="fchip" href={href}>
            {f.label}
          </a>
        )
      })}
    </nav>
    {p.capped ? <p class="note">直近 5000 件だけを集計しています</p> : null}
    {p.view === 'visit' ? <VisitView {...p} /> : <DoneView {...p} />}
  </>
)
