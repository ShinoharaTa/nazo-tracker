# 運用手順

## 本番デプロイ

初回だけ 1〜8 を行う。2 回目以降は 2（新しい migration があるとき）と 9。

1. D1 を作る: `npx wrangler d1 create nazo-tracker`。出力された ID で `wrangler.toml` の `database_id` を置き換える。
2. migration を当てる: `npm run db:migrate:remote`
3. session の署名鍵: `npx wrangler secret put SESSION_SECRET`。値は `openssl rand -base64 32` の出力（32 文字以上。短いと全ページ 500）。
4. Google: Google Cloud Console で OAuth クライアント（種類は「ウェブ アプリケーション」）を作る。
   - 承認済みのリダイレクト URI: `https://nazo.shino3.net/auth/google/callback` と `http://127.0.0.1:8787/auth/google/callback`
   - スコープは `openid` のみ
   - `GOOGLE_CLIENT_ID` は `wrangler.toml` の `[vars]`、シークレットは `npx wrangler secret put GOOGLE_CLIENT_SECRET`
5. Discord: Discord Developer Portal でアプリを作り、OAuth2 を同様に設定する。
   - Redirects: `https://nazo.shino3.net/auth/discord/callback` と `http://127.0.0.1:8787/auth/discord/callback`
   - scope は `identify` のみ
   - `DISCORD_CLIENT_ID` は `wrangler.toml` の `[vars]`、シークレットは `npx wrangler secret put DISCORD_CLIENT_SECRET`
6. オーナー: `wrangler.toml` の `OWNER_IDENTITIES = "discord:<自分の Discord ユーザー ID>"`。反映は次回ログイン時（既にログイン中なら一度ログアウトして再ログイン）。
7. `wrangler.toml` の `AUTH_DEV_LOGIN = "0"`、`UI_GALLERY = "0"` を確認する。
8. カスタムドメイン `nazo.shino3.net` を Worker に割り当て、`workers_dev = false` にする（`*.workers.dev` では公開しない）。
9. `npm run deploy` のあと確認する:
   - `curl -I https://nazo.shino3.net/healthz` が 200
   - `curl -I https://nazo.shino3.net/records` が 302、`location: /login`

### 実アプリでの初回確認

テストではプロバイダをモックしているので、次は本番で一度だけ手で確かめる。

- Discord の初回ログインで同意画面が出る（`prompt=none` は認可済みユーザーの同意画面を省くだけ）
- Discord が PKCE（`code_verifier`）を受理する（token 交換が通り、`/login?error=failed` にならない）
- Google の初回ログインが通り、`/settings/name?welcome=1` に着く

## ローカル開発

1. `.dev.vars.example` を `.dev.vars` にコピーする
2. `npm run db:migrate:local`
3. `npm run dev`（`127.0.0.1:8787` で待ち受ける）
4. `http://127.0.0.1:8787/_dev/login` で仮ログイン（`AUTH_DEV_LOGIN=1` のときだけ有効）

サーバーで動かして手元のブラウザから見るときは SSH のポートフォワードを使う:

```sh
ssh -L 8787:127.0.0.1:8787 <host>
```

手元で `http://127.0.0.1:8787` を開く（`APP_ORIGIN` と同じ origin でないと CSRF の照合で POST が 403 になる）。

OAuth を試すときは `.dev.vars` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（または `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`）を入れる。リダイレクト URI は手順 4・5 の `http://127.0.0.1:8787/...` を使う。
