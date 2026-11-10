// 本人の統計（/stats）。集計は src/lib/stats.ts。JS は使わず、断念の扱いと年は GET パラメータで切り替える

import { workKinds } from '../db/schema'
import type { Stats } from '../lib/stats'
import { Bars, Empty, Kpis, MonthCols, TopBar } from './components'
import { workKindLabels } from './labels'

export type StatsPageProps = {
  stats: Stats
  dropAsFail: boolean
  year: number
  thisYear: number
  minYear: number
  capped: boolean
  wishlist: { total: number; played: number }
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`)

// year は今年なら省く
const statsHref = (p: { dropAsFail: boolean; year: number; thisYear: number }) => {
  const sp = new URLSearchParams()
  if (p.dropAsFail) sp.set('drop', 'fail')
  if (p.year !== p.thisYear) sp.set('year', String(p.year))
  const qs = sp.toString()
  return qs ? `/stats?${qs}` : '/stats'
}

export const StatsPage = (p: StatsPageProps) => {
  const { summary } = p.stats
  // 形式は workKinds の順、未設定は最後
  const kindOrder = (k: (typeof p.stats.byKind)[number]['kind']) =>
    k === null ? workKinds.length : workKinds.indexOf(k)
  const kinds = [...p.stats.byKind].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
  return (
    <>
      <TopBar title="統計" />
      <nav class="chips" aria-label="断念の扱い">
        {[
          { on: !p.dropAsFail, label: '断念を除く', dropAsFail: false },
          { on: p.dropAsFail, label: '断念を失敗に含める', dropAsFail: true },
        ].map((f) => {
          const href = statsHref({ dropAsFail: f.dropAsFail, year: p.year, thisYear: p.thisYear })
          return f.on ? (
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
      <Kpis
        items={[
          {
            label: 'プレイ',
            value: summary.played,
            note: `クリア ${summary.cleared} / 失敗 ${summary.failed} / 断念 ${summary.dropped}`,
          },
          {
            label: '成功率',
            hero: true,
            value: pct(summary.rate),
            note: `作品ベース ${pct(summary.rateByWork)}`,
          },
          { label: '積み謎', value: summary.backlog, note: '買った・進行中' },
        ]}
      />
      <div class="sect">
        <h2>難易度別の成功率</h2>
        <Bars items={p.stats.byDifficulty} />
      </div>
      <div class="sect">
        <h2>ジャンル別の成功率</h2>
        {p.stats.byGenre.length ? (
          <Bars items={p.stats.byGenre} />
        ) : (
          <Empty>まだデータがありません。</Empty>
        )}
      </div>
      <div class="sect">
        <h2>形式別の成功率</h2>
        {kinds.length ? (
          <Bars
            items={kinds.map((k) => ({
              ...k,
              label: k.kind === null ? '形式未設定' : workKindLabels[k.kind],
            }))}
          />
        ) : (
          <Empty>まだデータがありません。</Empty>
        )}
      </div>
      <div class="sect">
        <div class="row">
          <h2>月別の参加数 {p.year} 年</h2>
          <nav aria-label="年" style="display:flex;gap:8px">
            {p.year > p.minYear ? (
              <a
                class="btn ghost"
                href={statsHref({
                  dropAsFail: p.dropAsFail,
                  year: p.year - 1,
                  thisYear: p.thisYear,
                })}
              >
                ‹ 前年
              </a>
            ) : null}
            {p.year < p.thisYear ? (
              <a
                class="btn ghost"
                href={statsHref({
                  dropAsFail: p.dropAsFail,
                  year: p.year + 1,
                  thisYear: p.thisYear,
                })}
              >
                翌年 ›
              </a>
            ) : null}
          </nav>
        </div>
        <MonthCols counts={p.stats.monthly} />
      </div>
      <div class="sect">
        <h2>マイリスト</h2>
        <p>
          {p.wishlist.total} 件 · うちプレイ済み {p.wishlist.played} 件
        </p>
      </div>
      <p class="note" style="margin-top:14px">
        成功率 = クリア
        ÷（クリア＋失敗）。買った・進行中は含めません。「断念を失敗に含める」では断念も失敗として数えます。統計は自分だけに表示されます。
      </p>
    </>
  )
}
