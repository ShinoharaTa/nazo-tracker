import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

const now = '2026-01-01T00:00:00.000Z'

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, display_name, created_at) VALUES ('u_a', 'A', ?1), ('u_b', 'B', ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO work (id, title, title_norm, created_at, updated_at) VALUES ('w_1', 'W', 'w', ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO attempt (id, user_id, work_id, status, created_at, updated_at) VALUES ('a_1', 'u_a', 'w_1', 'cleared', ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO image (id, user_id, attempt_id, kind, r2_key, bytes, content_type, created_at) VALUES ('i_1', 'u_a', 'a_1', 'other', 'k', 1, 'image/jpeg', ?1)",
    ).bind(now),
  ])
})

describe('friend_request', () => {
  it('自分宛の申請は CHECK で失敗する', async () => {
    const insert = env.DB.prepare(
      "INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES ('fr_self', 'u_a', 'u_a', 'pending', ?1)",
    ).bind(now)
    await expect(insert.run()).rejects.toThrow(/CHECK constraint failed/)
  })

  it('他人宛の申請は入る', async () => {
    const res = await env.DB.prepare(
      "INSERT INTO friend_request (id, from_user_id, to_user_id, status, created_at) VALUES ('fr_ok', 'u_a', 'u_b', 'pending', ?1)",
    )
      .bind(now)
      .run()
    expect(res.success).toBe(true)
  })
})

describe('image_report', () => {
  it('同じ画像への同じ人の重複通報は UNIQUE で失敗する', async () => {
    const report = (id: string) =>
      env.DB.prepare(
        "INSERT INTO image_report (id, image_id, reporter_user_id, created_at) VALUES (?1, 'i_1', 'u_b', ?2)",
      ).bind(id, now)
    await report('ir_1').run()
    await expect(report('ir_2').run()).rejects.toThrow(/UNIQUE constraint failed/)
  })
})

describe('api_token', () => {
  it('created_at は NOT NULL', async () => {
    const insert = env.DB.prepare(
      "INSERT INTO api_token (id, name, token_hash, role) VALUES ('t_1', 'agent', 'h', 'agent')",
    )
    await expect(insert.run()).rejects.toThrow(/NOT NULL constraint failed/)
  })
})
