// 画面部品。見た目は public/app.css（参照モックのクラス）に従う。

import type { Child } from 'hono/jsx'
import { attemptStatuses } from '../db/schema'
import { type AttemptStatus, attemptStatusLabels } from './labels'

const BackIcon = () => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M15 5l-7 7 7 7" />
  </svg>
)

export const SearchIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
)

// 記録・作品の一覧の 1 行
export const Ticket = (props: {
  href: string
  stub: Child
  meta: Child
  title: string
  chip?: Child
  extra?: Child
  selected?: boolean
}) => (
  <a class={props.selected ? 'ticket sel' : 'ticket'} href={props.href}>
    <div class="stub">{props.stub}</div>
    <div class="tbody">
      <div class="row">
        <span class="meta">{props.meta}</span>
        {props.chip}
      </div>
      <span class="title">{props.title}</span>
      {props.extra ? <span class="meta">{props.extra}</span> : null}
    </div>
  </a>
)

export const StatusChip = ({ status }: { status: AttemptStatus }) => (
  <span class={`chip st-${status}`}>{attemptStatusLabels[status]}</span>
)

// YYYY-MM-DD を「年.月」と「日」に分けて出す
export const StubDate = ({ date }: { date: string | null }) => {
  if (!date) {
    return (
      <span class="nd">
        日付
        <br />
        なし
      </span>
    )
  }
  const [y, m, d] = date.split('-')
  return (
    <>
      <span class="m">
        {y}.{m}
      </span>
      <span class="d">{d}</span>
    </>
  )
}

// h1 版（title）と、戻るリンク版（back + label）
export const TopBar = (props: {
  title?: string
  back?: string
  label?: string
  action?: Child
}) => {
  if (props.back) {
    return (
      <div class="top">
        <a class="back" href={props.back} aria-label="戻る">
          <BackIcon />
        </a>
        <h1 class="sub">{props.label}</h1>
        {props.action ?? <span style="width:44px" />}
      </div>
    )
  }
  return (
    <div class="top">
      <h1>{props.title}</h1>
      {props.action}
    </div>
  )
}

export const Tabs = <K extends string>(props: {
  items: readonly { key: K; label: string; href: string }[]
  current: K
  label: string
}) => (
  <nav class="tabs" aria-label={props.label}>
    {props.items.map((t) =>
      t.key === props.current ? (
        <a class="tab on" href={t.href} aria-current="page">
          {t.label}
        </a>
      ) : (
        <a class="tab" href={t.href}>
          {t.label}
        </a>
      ),
    )}
  </nav>
)

// ステータス 5 択。radio は CSS で隠し、checked の label を塗る
export const StatusSeg = (props: {
  name: string
  value?: AttemptStatus
  legend?: string
  idPrefix?: string
}) => {
  const prefix = props.idPrefix ?? props.name
  return (
    <fieldset class="seg">
      <legend class="vh">{props.legend ?? 'ステータス'}</legend>
      {attemptStatuses.map((s) => (
        <>
          <input
            type="radio"
            id={`${prefix}-${s}`}
            name={props.name}
            value={s}
            checked={props.value === s}
          />
          <label for={`${prefix}-${s}`}>{attemptStatusLabels[s]}</label>
        </>
      ))}
    </fieldset>
  )
}

export const Field = (props: {
  label: Child
  name: string
  type?: string
  value?: string
  placeholder?: string
  multiline?: boolean
}) =>
  props.multiline ? (
    <label class="field">
      {props.label}
      <textarea name={props.name} placeholder={props.placeholder}>
        {props.value}
      </textarea>
    </label>
  ) : (
    <label class="field">
      {props.label}
      <input
        type={props.type ?? 'text'}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
      />
    </label>
  )

export const Switch = (props: {
  label: string
  name: string
  checked?: boolean
  disabled?: boolean
}) => (
  <label class="switch">
    <span>{props.label}</span>
    <input
      type="checkbox"
      // biome-ignore lint/a11y/useAriaPropsForRole: checked 状態がそのまま aria-checked になる。静的に書くと操作後にずれる
      role="switch"
      class="sw"
      name={props.name}
      checked={props.checked}
      disabled={props.disabled}
    />
  </label>
)

export const Menu = ({ children }: { children?: Child }) => <div class="menu">{children}</div>

// href があればリンク、action があればそこへ POST するボタン、disabled なら押しても何も起きない
// aria-disabled のボタン、どれも無ければ表示だけ
export const MenuItem = (props: {
  label: Child
  note?: Child
  href?: string
  action?: string
  disabled?: boolean
}) => {
  const note = props.note ? <span class="note">{props.note}</span> : null
  if (props.disabled) {
    return (
      <button type="button" aria-disabled="true">
        <span>{props.label}</span>
        {note}
      </button>
    )
  }
  if (props.action) {
    return (
      <form method="post" action={props.action}>
        <button type="submit">
          <span>{props.label}</span>
          {note}
        </button>
      </form>
    )
  }
  if (props.href) {
    return (
      <a href={props.href}>
        <span>{props.label}</span>
        {note}
      </a>
    )
  }
  return (
    <div>
      <span>{props.label}</span>
      {note}
    </div>
  )
}

export const Kpis = (props: {
  items: readonly { label: string; value: Child; note?: string }[]
}) => (
  <div class="kpis">
    {props.items.map((k) => (
      <div class="kpi">
        <span>{k.label}</span>
        <b>{k.value}</b>
        {k.note ? <span>{k.note}</span> : null}
      </div>
    ))}
  </div>
)

// 成功率の横棒。total = クリア＋失敗、cleared = クリア
export const Bars = (props: {
  items: readonly { label: string; total: number; cleared: number }[]
}) => (
  <div class="bars">
    {props.items.map(({ label, total, cleared }) => (
      <div class="bar">
        <span>{label}</span>
        <div class="tr">
          <div class="fl" style={`width:${total ? (cleared / total) * 100 : 0}%`} />
        </div>
        <span class="v">
          {total ? `${Math.round((cleared / total) * 100)}% · ${cleared}/${total}` : '—'}
        </span>
      </div>
    ))}
  </div>
)

// 月別の縦棒（1〜12 月）
export const MonthCols = ({ counts }: { counts: readonly number[] }) => {
  const max = Math.max(1, ...counts)
  return (
    <div class="cols">
      {counts.map((n, i) => (
        <div class="col">
          <span>{n || ''}</span>
          <i style={`height:${(n / max) * 70}px`} />
          <span>{i + 1}</span>
        </div>
      ))}
    </div>
  )
}

// ネタバレ。本文は初期 HTML に含めず、public/app.js が「表示」操作時に src から断片を取得する。
// JS が無いときは src へ普通に遷移する（spoilerResponse が全体ページを返す）
export const SpoilerCard = (props: { src: string; count?: { memo: number; photos: number } }) => {
  const id = `spoil-${props.src.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
  return (
    <section class="spoil" data-spoiler>
      <div class="row">
        <h3 class="spoil-title">ネタバレ</h3>
        <a
          class="btn"
          href={props.src}
          data-spoiler-toggle
          aria-expanded="false"
          aria-controls={id}
        >
          表示
        </a>
      </div>
      <span class="lock">
        自分だけに表示されます。フレンドにも見えません。
        {props.count ? `（メモ ${props.count.memo} · 写真 ${props.count.photos}）` : ''}
      </span>
      <div id={id} class="spoil-body" hidden />
      <div class="veil" aria-hidden="true" />
    </section>
  )
}

export const Empty = ({ children }: { children?: Child }) => <div class="empty">{children}</div>

// 一覧の前後ページ（50 件ずつ）。params は引き継ぐクエリ（空文字は落とす）
export const Pager = (props: {
  base: string
  page: number
  hasNext: boolean
  params?: Record<string, string>
}) => {
  if (props.page <= 1 && !props.hasNext) return null
  const href = (page: number) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(props.params ?? {})) if (v) q.set(k, v)
    if (page > 1) q.set('page', String(page))
    const s = q.toString()
    return s ? `${props.base}?${s}` : props.base
  }
  return (
    <nav class="btns" aria-label="ページ" style="margin-top:14px">
      {props.page > 1 ? (
        <a class="btn ghost" href={href(props.page - 1)}>
          ‹ 前の 50 件
        </a>
      ) : null}
      {props.hasNext ? (
        <a class="btn ghost" href={href(props.page + 1)}>
          次の 50 件 ›
        </a>
      ) : null}
    </nav>
  )
}

// public/app.js が [data-open="id"] で開き、[data-close] で閉じる
export const Sheet = (props: { id: string; title: string; children?: Child }) => (
  <dialog class="sheet" id={props.id} aria-labelledby={`${props.id}-title`}>
    <div class="in">
      <div class="grab" />
      <div class="head">
        <h3 id={`${props.id}-title`}>{props.title}</h3>
        <button type="button" class="btn ghost" data-close>
          閉じる
        </button>
      </div>
      {props.children}
    </div>
  </dialog>
)
