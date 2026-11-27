// D1 の呼び出し回数を数える（まとめて承認の打ち切り。docs/agent-pipeline.md §4）。
// prepare した文の run / all / first / raw と batch を 1 回ずつ数える（batch は中の文の数によらず 1。D1 の 1 回の呼び出しあたりの上限と同じ数え方）。
// test/admin-proposals-bulk.test.ts も同じものでリクエスト全体を数える

export const countingD1 = (d1: D1Database, start = 0) => {
  const n = { calls: start }
  const raw = new WeakMap<object, D1PreparedStatement>()
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(st, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a))
        if (k === 'run' || k === 'all' || k === 'first' || k === 'raw') {
          const fn = (t[k] as (...a: unknown[]) => unknown).bind(t)
          return (...a: unknown[]) => {
            n.calls++
            return fn(...a)
          }
        }
        const v = Reflect.get(t, k)
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
    raw.set(p, st)
    return p
  }
  const db = new Proxy(d1, {
    get(t, k) {
      if (k === 'prepare') return (q: string) => wrap(t.prepare(q))
      if (k === 'batch') {
        // 本物の文に戻して渡す
        return (ss: D1PreparedStatement[]) => {
          n.calls++
          return t.batch(ss.map((x) => raw.get(x) ?? x))
        }
      }
      const v = Reflect.get(t, k)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  return { db, n }
}
