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

## 画像の削除依頼

マスタの画像（作品の OGP 画像・団体のロゴ）は URL だけを持ち、実体は公開元にある（design.md §3.4.2）。こちらで止める手順:

| 依頼の単位 | オーナーの操作（1 操作） | 効果 |
|---|---|---|
| 作品 1 つ | `/admin/works/:id` の「画像を載せない」にチェックして保存 | `image_blocked=1`、`image_url` / `image_page_url` を NULL（同じ保存で）。change_log に残る |
| 団体まるごと | `/admin/orgs/:id` の「画像を載せない」にチェックして保存 | ロゴを NULL、`image_blocked=1`。その団体が primary の作品の画像は**表示の判定で**出なくなる（作品側の URL は消さない） |
| ホストまるごと（escape.id から言われた場合） | `src/lib/image-url.ts` の `IMAGE_HOSTS` から外す PR をマージしてデプロイ | その host の画像が全部出なくなる。新しい提案も 400 |
| 全停止 | `wrangler.toml` の `MASTER_IMAGES` を `"0"` にしてデプロイ（急ぐときは Cloudflare のダッシュボードで変数を変える） | 表示だけ止まる。データはそのまま |

- 「画像を載せない」にチェックした保存では、フォームに URL が残っていても空にして保存する。解除はチェックを外して保存。
- 止めた行に対して validators で 400 になるのは、その行の画像の URL を**新しく入れる・別の値に変える**提案だけ（URL が変わっても、他の項目と束になっても）。画像に触れない提案（題名だけの update など）は通る。団体を止めた場合は、その団体の作品に画像を新しく入れる・別の値に変える提案も 400。変わっていない画像の値は検証し直さない（data-model.md「画像の URL の検証」）。
- 依頼の理由・日付は、団体は `organization.note`（非公開）、作品は GitHub の issue に残す。
- こちらに実体が無いので、R2・キャッシュから消す作業は無い。
- 削除依頼の連絡先: **運営者の SNS アカウントへの連絡で受け付ける。** Bluesky [@shino3.net](https://bsky.app/profile/shino3.net)、X [@SHINOHARATTT](https://x.com/SHINOHARATTT)。ログイン不要の公開ページ `/about`「データの扱い」（本文は `src/ui/Layout.tsx` の `DataPolicy`。PC の設定タブの表紙と共用）に載せ、作品詳細・団体詳細の出典行の「掲載について ›」から `/about#images` へ辿れる。
