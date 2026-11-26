// 運用の設定（app_setting）の読み書き。行が無ければ既定値（自動反映は OFF）。

import { eq } from 'drizzle-orm'
import { nowIso } from '../lib/time'
import type { Db } from './client'
import { appSetting } from './schema'

// 自動反映（docs/agent-pipeline.md §4 A-3）。'1' のときだけ ON
export const getAutoApply = async (db: Db): Promise<boolean> => {
  const row = await db
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, 'auto_apply'))
    .get()
  return row?.value === '1'
}

export const setAutoApply = async (db: Db, on: boolean, userId: string): Promise<void> => {
  const set = { value: on ? '1' : '0', updatedAt: nowIso(), updatedByUserId: userId }
  await db
    .insert(appSetting)
    .values({ key: 'auto_apply', ...set })
    .onConflictDoUpdate({ target: appSetting.key, set })
}
