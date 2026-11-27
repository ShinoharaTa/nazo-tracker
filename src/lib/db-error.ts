// D1 の書き込みエラーの判定。確かめてから書くまでの間の競合（二度押しなど）を捕まえるのに使う。

// UNIQUE 違反か（D1 は cause に元の SQLite のエラーを持つ）
export const isUniqueViolation = (e: unknown): boolean =>
  String((e as { cause?: unknown })?.cause ?? e).includes('UNIQUE constraint failed')
