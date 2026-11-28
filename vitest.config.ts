import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations')
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: 'http://127.0.0.1:8787',
            SESSION_SECRET: 'test-session-secret-0123456789abcdef',
            // wrangler.toml の [vars]（本番値）と .dev.vars（ローカル値）に左右されないよう、既定値を固定する（#50）。
            // 値を変えて試すテストは、各テスト内で env を上書きする
            AUTH_DEV_LOGIN: '0',
            AUTH_DEV_HOSTS: '',
            OWNER_IDENTITIES: '',
            UI_GALLERY: '0',
            MASTER_IMAGES: '0',
            GOOGLE_CLIENT_ID: '',
            GOOGLE_CLIENT_SECRET: '',
            DISCORD_CLIENT_ID: '',
            DISCORD_CLIENT_SECRET: '',
            LINE_CLIENT_ID: '',
            LINE_CLIENT_SECRET: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      // mcp/ は node で動く別パッケージ（テストは mcp 側の tsx --test）。Workers プールでは回さない
      exclude: [...configDefaults.exclude, 'mcp/**'],
    },
  }
})
