# 認証・認可

## 1. 方針
- OAuth / OIDC のみ。パスワード無し。**メール・氏名・アバターは保存しない。** 保存するのは `provider + subject`（Google `sub` / Discord user id / Bluesky DID / X user id）と、ユーザーが自分で付ける表示名。
- 要求スコープは最小: Google `openid`（email/profile 要求しない）、Discord `identify`、Bluesky `atproto`、X `users.read tweet.read`（X は最小でもこの 2 つが必要、2025 年時点）。
- プロバイダのアクセストークン／リフレッシュトークンは**ログイン完了後に破棄**（後で呼ぶ用事がない）。

## 2. テーブル
- `user(id, display_name, role(member / owner), friend_code NULL, default_share_level(none / status / rating / memo; 既定 status、v1 は固定で UI 無し), exclude_from_counts INT 既定 0, created_at, last_seen_at, deleted_at)`
- `identity(provider, subject, user_id, created_at, last_login_at)` PK(provider, subject)
- `session_token(id, user_id, expires_at, created_at, ua_hint)` — ログインセッション（進行ログの `session` とは別）。Cookie は署名付き session id、30 日、`Secure; HttpOnly; SameSite=Lax`
- `oauth_state(state, provider, code_verifier, mode(login / link), user_id NULL, expires_at)` — PKCE、10 分
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
- 記録系のルートは `/api/me/*`（本人。wishlist もここ）と `/api/friends/:userId/*`（射影）のみ。それ以外の URL でユーザー id を取らない。
- 匿名人数は `/api/works` / `/api/works/:id` のマスタ応答に含め、**サーバー側でぼかしてから返す**（生の人数は返さない）。user_id を返す経路は無い。
- リポジトリ層: `scopedTo(viewerId)` が `own()` と `asFriendOf(targetUserId)` を返す。`asFriendOf` は friendship / block を検証してから、level 別の列セットだけを持つ型（`FriendAttemptStatus | FriendAttemptRating | FriendAttemptMemo`）を返す（v1 で呼ばれるのは Status のみ）。`spoiler_memo` と `spoiler=1` の image を含む型は `own()` にしか存在しない。これ以外に attempt / session / image を読む経路を作らない。
- 画像の配信 `GET /img/:imageId` も同じ `scopedTo` を通す。R2 の公開 URL・署名 URL は作らない。
- マスタ側のクエリが attempt / wishlist を JOIN してよいのは、`countsFor(workIds)`（匿名人数、DISTINCT user_id の COUNT だけを返す専用関数）と、viewer の friendship を起点にした「フレンド n 人」（`asFriendOf` 経由）の 2 箇所だけ。それ以外は lint で禁止語に。
- 退会: user を `deleted_at`、identity / session_token / attempt / session（進行ログ）/ attempt_genre / image（R2 含む）/ friendship / friend_request / block / market_visit / wishlist を物理削除（匿名人数からも消える）。request / proposal の `requester_user_id` は NULL。
