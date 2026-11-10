import { describe, expect, it } from 'vitest'
import { norm } from '../src/lib/norm'

describe('norm', () => {
  it.each([
    ['ＷＯＲＤＥＡＬ　2026', 'wordeal'],
    // 【…】は中身ごと消える。「」は括弧文字だけ
    ['【追加公演】猫の手も借りたい', '猫の手も借りたい'],
    ['「星降る街」', '星降る街'],
    ['星降る街（再演）', '星降る街'],
    // 残りが空になる末尾削除はしない
    ['第2弾', '第2弾'],
    ['2026', '2026'],
    // 記号だけの名前は記号を残す
    ['???', '???'],
    ['A・B', 'ab'],
  ])('%s → %s', (input, expected) => {
    expect(norm(input)).toBe(expected)
  })

  it('記号に混ざった % _ \\ は消える', () => {
    expect(norm('100%_\\達成')).toBe('100達成')
  })
})
