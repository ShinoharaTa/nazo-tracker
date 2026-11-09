# 認証・認可

## 1. 方針
- OAuth / OIDC のみ。パスワード無し。**メール・氏名・アバターは保存しない。** 保存するのは `provider + subject`（Google `sub` / Discord user id / Bluesky DID / X user id）と、ユーザーが自分で付ける表示名。
- 要求スコープは最小: Google `openid`（email/profile 要求しない）、Discord `identify`、Bluesky `atproto`、X `users.read tweet.read`（X は最小でもこの 2 つが必要、2025 年時点）。
- プロバイダのアクセストークン／リフレッシュトークンは**ログイン完了後に破棄**（後で呼ぶ用事がない）。

## 2. テーブル
- `user(id, display_name, role(member / owner), friend_code NULL, default_share_level(none / status / rating / memo; 既定 status、v1 は固定で UI 無し), exclude_from_counts INT 既定 0, created_at, last_seen_at, deleted_at)`
- `identity(provider, subject, user_id, created_at, last_login_at)` PK(provider, subject)
- `session_token(id, user_id, expires_at, created_at, ua_hint)` — ログインセッション（進行ログの `session` とは別）。Cookie は署名付き session token、30 日。属性は §7 を参照（Secure は APP_ORIGIN が https のときのみ）。`id` には token の SHA-256 を入れる（§7）
- `oauth_state(state, provider, code_verifier, mode(login / link), user_id NULL, expires_at, nonce NULL)` — PKCE、10 分、1 回限り（callback で DELETE RETURNING で取り出す）。`state` は cookie `oauth` とも照合する。`nonce` は OIDC（Google）の ID トークンと照合する値で、Discord では NULL
- `recovery_code(user_id, code_hash, used_at)` PK(user_id, code_hash) — 復旧コード（決定）

## 3. プロバイダ別

| | Google | Discord | Bluesky (AT Protocol) | X |
|---|---|---|---|---|
| 方式 | OIDC + PKCE | OAuth2 + PKCE | AT Proto OAuth（PAR + DPoP + PKCE、`client-metadata.json` を公開 URL で配信、ES256 鍵を Worker secret に） | OAuth 2.0 + PKCE |
| subject | `sub` | user id | DID（ハンドル→DID 解決、PDS 発見が必要） | user id |
| 費用 | ¥0 | ¥0 | ¥0 | Free tier ¥0（ログイン可は要確認）/ Basic $200/月 |
| 実装 | 小 | 小 | **中〜大**（Workers 向けライブラリの成熟度要確認。state/DPoP nonce を D1 に） | 小（審査あり） |
| リスク | 低 | 低 | 仕様変化の追従 | 規約・料金変更が頻繁。開発者契約で用途申告が要る |

決定: Google + Discord から開始 → Bluesky は P6 → X は見送り。

- ID トークンの署名（JWKS）は検証しない。token endpoint から TLS で直接受け取るため（OIDC Core 3.1.3.7）。iss / aud / exp / nonce は照合する。
- Discord: scope は `identify` のみ、認可 URL に `prompt=none`（`prompt=none` は既に認可済みのユーザーの同意画面を省略するだけで、初回は同意画面が出る（Discord 公式 docs））。API は v10 に固定（`/api/v10/oauth2/token`・`/api/v10/users/@me`）。token 応答の `token_type` が `Bearer`（大文字小文字は区別しない）で `scope` に `identify` を含むことを確かめ、`GET /api/v10/users/@me` の `id` を subject にする。`username` 等は読まない・保存しない。access_token は `/users/@me` を呼んだら捨てる。OIDC ではないので nonce は使わない（`oauth_state.nonce` は NULL）。
- `<PROVIDER>_CLIENT_ID` と `<PROVIDER>_CLIENT_SECRET` のどちらかが空なら、そのプロバイダは「準備中」（`/login` のボタンは無効、`/auth/<provider>` は 503）。

## 4. 複数プロバイダの紐付け
- ログイン中に「連携を追加」→ `oauth_state.mode=link` で OAuth → 戻りで `identity` を現在の user に追加。
- 既に別 user に紐付いた identity なら拒否（アカウント統合は v1 では行わない）。
- 解除は identity が 2 つ以上あるときのみ。

## 5. 復旧（メール無しの前提）

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| R-1 2 プロバイダ推奨 | 設定画面で「もう 1 つ連携を」と促す | 実装ゼロ | 1 つしか繋いでいない人は詰む |
| R-2 復旧コード | 1 回限りコードを数個発行（ハッシュ保存）。コードでログインし新プロバイダを紐付け | 自己解決できる | 控えを失うと無効 |
| R-3 オーナー手動付け替え | 依頼を受け、本人確認（登録済み記録の内容を答えてもらう等）して identity を付け替え | 最後の砦 | 手間、なりすましリスク |

決定: R-1 + R-2 + R-3 の全部。

## 6. 認可
| 主体 | できること |
|---|---|
| 未ログイン | マスタ閲覧（匿名の「プレイ済み n 人 / マイリスト n 人」を含む。ぼかし後の値のみ） |
| member | 自分の attempt / session / image / market_visit / wishlist / stats の CRUD、匿名人数へのオプトアウト設定、request 投稿、自分の request の状態閲覧、表示名・連携・share level・friend_code の変更、フレンド申請/承認/解除/ブロック、**フレンドの記録を share level の射影で閲覧**、画像の通報、退会 |
| owner | member + マスタ直接編集、request 一覧・選別、proposal 承認/却下、api_token 発行、自動反映 ON/OFF、genre 編集、通報画像の非表示。**他人の記録を見る画面・API は無い**（フレンドとしては一般 member と同じ） |
| agent (token) | マスタ読、request 読と状態更新（processing / proposed / needs_info）、source・proposal 作成、match API。記録・フレンド・画像は 403 |

### フレンド閲覧の規則
- `/api/friends/:userId/*` は (1) viewer と target の `friendship` が存在、(2) どちらの向きにも `block` が無い、を満たすときだけ 200。満たさなければ **404**（存在を漏らさない）。
- 返す列は level 別の射影のみ（data-model.md §6）。**v1 は `status` 射影に固定**（決定）。P11 で `default_share_level` / `share_override` を UI に出し、`hidden` の行を除外する。
- **`spoiler_memo` と `spoiler=1` の画像はどの level でも返さない。** 射影の型に列が無い（設定で開けない）。決定。
- フレンド申請は `friend_code` 経由のみ（決定）。1 日 20 件まで。pending は相手が承認/拒否するまで 30 日で自動 canceled。

### 実装上の規約
- 禁止語チェックは `scripts/check-scoped.mjs`（`npm run lint` に含む）。
- オーナー画面は `/admin/*`（`requireOwner`。owner 以外は 404、未ログインの GET は `302 /login`・POST は 401）。オーナー用 JSON API は `/api/admin/*`（owner 以外は未ログインを含め JSON の 404 `{ "error": "not_found" }`）。
- 記録系のルートは `/api/me/*`（本人。wishlist もここ）と `/api/friends/:userId/*`（射影）のみ。それ以外の URL でユーザー id を取らない。
- 匿名人数は `/api/works` / `/api/works/:id` のマスタ応答に含め、**サーバー側でぼかしてから返す**（生の人数は返さない）。user_id を返す経路は無い。
- リポジトリ層: `scopedTo(viewerId)` が `own()` と `asFriendOf(targetUserId)` を返す。`asFriendOf` は friendship / block を検証してから、level 別の列セットだけを持つ型（`FriendAttemptStatus | FriendAttemptRating | FriendAttemptMemo`）を返す（v1 で呼ばれるのは Status のみ）。`spoiler_memo` と `spoiler=1` の image を含む型は `own()` にしか存在しない。これ以外に attempt / session / image を読む経路を作らない。
- 画像の配信 `GET /img/:imageId` も同じ `scopedTo` を通す。R2 の公開 URL・署名 URL は作らない。
- マスタ側のクエリが attempt / wishlist を JOIN してよいのは、`countsFor(workIds)`（匿名人数、DISTINCT user_id の COUNT だけを返す専用関数）と、viewer の friendship を起点にした「フレンド n 人」（`asFriendOf` 経由）の 2 箇所だけ。それ以外は lint で禁止語に。
  - 例外: マスタの統合（`src/db/merge.ts`、data-model.md §5）は attempt / wishlist / session の FK を **UPDATE / DELETE するだけ**で、行も件数も SELECT しない。`scripts/check-scoped.mjs` の許可リストに入っている。
- 退会（`POST /settings/delete`。本人のセッション必須、CSRF 適用、URL にユーザー id を取らない。オーナーは退会不可）: 次を `db.batch` の 1 回で順に行う（実装は `src/auth/account.ts`）。匿名人数からも消える。

| # | 文 |
|---|---|
| 1 | `DELETE image_report WHERE reporter_user_id = ?`（本人の画像への他人の通報は 2 の cascade で消える） |
| 2 | `DELETE image WHERE user_id = ?`（R2 の実体削除は P9） |
| 3 | `DELETE session WHERE user_id = ?`（進行ログ） |
| 4 | `DELETE attempt_genre WHERE user_id = ?` |
| 5 | `DELETE attempt WHERE user_id = ?` |
| 6 | `DELETE wishlist WHERE user_id = ?` / `DELETE market_visit WHERE user_id = ?` |
| 7 | `DELETE friendship WHERE user_lo = ? OR user_hi = ?` / `DELETE friend_request WHERE from_user_id = ? OR to_user_id = ?` / `DELETE block WHERE user_id = ? OR blocked_user_id = ?` |
| 8 | `DELETE recovery_code / oauth_state / session_token / identity WHERE user_id = ?` |
| 9 | `UPDATE request SET requester_user_id = NULL WHERE requester_user_id = ?` |
| 10 | `UPDATE user SET deleted_at = now, display_name = '退会したユーザー', friend_code = NULL WHERE id = ?` |

  `user` 行は残す（`change_log.actor_user_id` / `proposal.reviewer_user_id` の FK 先）。`deleted_at` の入った user の cookie は未ログイン扱い（§7）。同じアカウントで再ログインすると新しい user になる。

## 7. セッションとオーナー（P1 で決定）

### セッション
- token = `crypto.getRandomValues` 32 バイトの base64url（43 文字）。ULID は使わない（推測不能であること）。
- cookie `session` に token を署名付き（HMAC-SHA256、鍵は secret `SESSION_SECRET`）で置く。属性は `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`。`Secure` は `APP_ORIGIN` が `https:` のときだけ（開発は http://127.0.0.1 のため。同じ理由で `__Host-` prefix は使わない）。
- **`session_token.id` には token そのものではなく SHA-256（base64url）を保存する。** D1 の中身が漏れても cookie を作れない。認証・ログアウト・セッション固定対策の削除は、cookie の token をハッシュしてから引く。
- `expires_at = created_at + 30 日`。スライド延長: 認証済みリクエストで残り 15 日未満なら `expires_at = now + 30 日` に更新し、cookie も出し直す。それ以外は書かない。
- `user.last_seen_at` はログイン時と、認証済みリクエストで UTC の日付が変わったときだけ更新する。
- 期限切れ行の掃除はログイン処理の中で行う（`session_token` と `oauth_state` の `expires_at < now` を全ユーザー分削除）。cron は作らない。
- `ua_hint` = `User-Agent` の先頭 120 文字（無ければ NULL）。
- 署名不一致・存在しない・期限切れ・`user.deleted_at IS NOT NULL` の cookie は未ログイン扱いにし、cookie を削除する。
- ログイン成功時は必ず新しい token を発行し、それまでの cookie の行を削除する（セッション固定対策）。
- ログアウトは `POST /auth/logout` のみ。状態を変える POST は `Origin` が `APP_ORIGIN` と一致するか `Sec-Fetch-Site: same-origin` のときだけ通す（CSRF）。
- hono/csrf はフォーム系 Content-Type の POST のみ Origin を検査する。JSON API は CORS preflight に依存（P2 以降の `/api/*` で注意）。
- 初回ログインで作る user の表示名は「ななしさん」。初回は `/settings/name?welcome=1` へ送る（強制はしない）。

### オーナー
- 環境変数 `OWNER_IDENTITIES`（wrangler.toml `[vars]`）に `provider:subject` をカンマ区切りで書く（空白は trim）。例: `discord:123456789012345678`。
- ログイン時にその identity が含まれていれば `user.role = 'owner'` にする。照合は完全一致（部分一致・大文字小文字の緩和はしない）。**自動降格はしない**（外したいときは D1 を直接更新する）。
- オーナー昇格はログイン時に判定。値を変えたら一度ログアウトして再ログイン。
- オーナー用の画面・API にオーナー以外が来たら 404（存在を漏らさない）。

### 仮ログイン（開発用）
- `GET/POST /_dev/login` で `provider = 'dev'` の identity にログインできる。`AUTH_DEV_LOGIN = "1"`、`APP_ORIGIN` のホストが `127.0.0.1` / `localhost`、リクエストの `Host` が `127.0.0.1` / `localhost` の 3 条件が揃ったときだけ有効で、それ以外は 404。本番の wrangler.toml は `AUTH_DEV_LOGIN = "0"`。
- 開発は `APP_ORIGIN` と同じ origin（`http://127.0.0.1:8787`）でアクセスする。curl で POST するときは `-H "Origin: http://127.0.0.1:8787"` が必要（CSRF の照合）。
