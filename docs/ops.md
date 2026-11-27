# 運用手順

## 本番デプロイ

初回だけ 1〜9 を行う。2 回目以降は 2（新しい migration があるとき）と 10。

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
6. LINE: LINE Developers コンソール（https://developers.line.biz/console/）でプロバイダを作り、その下に「LINE ログイン」チャネルを作る（アプリタイプ: ウェブアプリ）。
   - コールバック URL: `https://nazo.shino3.net/auth/line/callback` と `http://127.0.0.1:8787/auth/line/callback`
   - メールアドレス取得権限（OpenID Connect の email）は申請しない。scope はアプリ側で openid のみ要求する
   - チャネル ID を `wrangler.toml` の `[vars]` の `LINE_CLIENT_ID`、チャネルシークレットは `npx wrangler secret put LINE_CLIENT_SECRET`
   - チャネルを「公開済み」にする（「開発中」のままだと、チャネルに開発者ロールで登録した人しかログインできない）
   - LINE のユーザー ID（sub）はプロバイダごとに異なる。チャネルは同じプロバイダの下に置き続ける（作り直すと全員の sub が変わり別ユーザー扱いになる）。
7. オーナー: `wrangler.toml` の `OWNER_IDENTITIES = "discord:<自分の Discord ユーザー ID>"`（provider は `google` / `discord` / `line` を使える。LINE なら `line:<sub>`）。反映は次回ログイン時（既にログイン中なら一度ログアウトして再ログイン）。自分の LINE の sub は、一度 LINE でログインしてから `npx wrangler d1 execute nazo-tracker --remote --command "SELECT user_id, subject FROM identity WHERE provider = 'line'"` で引く（`subject` 列が sub）。
8. `wrangler.toml` の `AUTH_DEV_LOGIN = "0"`、`UI_GALLERY = "0"` を確認する。
9. カスタムドメインは `wrangler.toml` の `routes = [{ pattern = "nazo.shino3.net", custom_domain = true }]` と `workers_dev = false` で設定済み。`shino3.net` の DNS ゾーンが同じ Cloudflare アカウントにあれば、`npm run deploy` で DNS レコードと証明書が自動で作られる（ダッシュボードでの操作は不要。既に同名の DNS レコードがあると deploy が失敗するので、その場合は先に消す）。
10. `npm run deploy` のあと確認する:
    - `curl -I https://nazo.shino3.net/healthz` が 200
    - `curl -I https://nazo.shino3.net/records` が 302、`location: /login`

### 実アプリでの初回確認

テストではプロバイダをモックしているので、次は本番で一度だけ手で確かめる。

- Discord の初回ログインで同意画面が出る（`prompt=none` は認可済みユーザーの同意画面を省くだけ）
- Discord が PKCE（`code_verifier`）を受理する（token 交換が通り、`/login?error=failed` にならない）
- Google の初回ログインが通り、`/settings/name?welcome=1` に着く
- LINE の初回ログインが通り、`/settings/name?welcome=1` に着く（チャネルが「公開済み」なら開発者ロール以外のアカウントでも通る）

## レート制限

Workers の Rate Limiting binding（`wrangler.toml` の `[[ratelimits]]`）で、未ログインで叩ける入口の連打を止める。判定は `src/lib/rate-limit.ts` の `allow`。
拠点ごと・結果整合なので上限を少し超えて通ることがある（雑な連打を止める水準）。

| 入口 | binding（namespace_id） | 上限 | key | 超えたとき |
|---|---|---|---|---|
| `GET /auth/:provider` | `AUTH_LIMITER`（29001） | 10 回 / 60 秒 | `begin:<IP>` | 302 `/login?error=busy`（ログイン画面に「アクセスが集中しています。1 分ほど待ってからもう一度お試しください。」） |
| `GET /auth/:provider/callback` | `AUTH_LIMITER`（29001） | 同上（開始とは別に数える） | `cb:<IP>` | 302 `/login?error=busy`（開始と同じ） |
| `/api/agent/*`（`requireAgent` より前） | `AGENT_LIMITER`（29002） | 300 回 / 60 秒 | `agent:<IP>` | 429、`Retry-After: 60`、`{"error":"rate_limited"}` |

- IP は `CF-Connecting-IP` ヘッダだけを見る。無いとき（ローカル・テスト）、binding が無いとき、`limit()` が例外を投げたときは制限しない。
- `/_dev/login` と `POST /requests` には掛けない（`POST /requests` の 1 日 20 件は D1 の COUNT で数える）。
- `namespace_id` はアカウント内で共有される番号。同じアカウントの他の Worker と重ねない。
- Workers Free で deploy が拒否された場合は、`wrangler.toml` の `[[ratelimits]]` 2 ブロックを消せば戻せる（binding が無いとコードは何もしない）。
- WAF のレート制限ルール（ダッシュボード）: 未設定。作ったらここに 1 行残す（対象パス・回数 / 10 秒・作成日）。

deploy 後の確認（前半は Discord の認可 URL、後半は `/login?error=busy` へ戻る）:

```sh
for i in $(seq 12); do curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://nazo.shino3.net/auth/discord; done
```

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

同じ LAN の別端末から開発機の IP で開くときは、`.dev.vars` を次のようにして `npx wrangler dev --ip <IP> --local` で起動する（`npm run dev` は `--ip 127.0.0.1` 固定で、`-- --ip` を重ねると wrangler がエラーになる）（`<IP>` はプライベート IPv4、例 `10.1.111.70`）:

```sh
APP_ORIGIN=http://<IP>:8787
AUTH_DEV_HOSTS=<IP>
```

`http://<IP>:8787/_dev/login` で仮ログインできる。起動中は同じ LAN の誰でもオーナーで入れるので、確認が終わったら止める。

OAuth を試すときは `.dev.vars` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（または `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`、`LINE_CLIENT_ID` / `LINE_CLIENT_SECRET`）を入れる。リダイレクト URI は手順 4〜6 の `http://127.0.0.1:8787/...` を使う。
