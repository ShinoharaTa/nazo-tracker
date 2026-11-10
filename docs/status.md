# 残作業の一覧（2026-11-09 時点）

完成（v1 = design.md §9 の P0〜P11）までに残っているものを、進める順に並べる。
各 Phase の詳細は対応する issue と `docs/design.md` §9 を見る。この表は節目ごとに更新する。

## 済み

| 区分 | 内容 | issue / PR |
|---|---|---|
| P0 | 雛形、Hono + D1 + Drizzle、スキーマ v1、`/healthz` | — |
| UI 基盤 | モノクロ手帳テーマ、スマホ 1 カラム / PC 見開き、ネタバレ遅延読み込み | #13 → #16 |
| スキーマ補強 | インデックス・CHECK・UNIQUE 追加 | #22 → #23 |
| P1 認証 | セッション（ハッシュ保存・延長・固定化対策）、仮ログイン、オーナー判定、`scopedTo`、表示名、退会、Google / Discord OAuth | #2, #17〜#21 → #24〜#28 |
| 運用 docs | デプロイ手順・ローカル開発手順 | #31 → #32 |

## 進行中

| 内容 | 状態 |
|---|---|
| 仮ログインを LAN の開発機 IP でも使えるように（`AUTH_DEV_HOSTS`） | PR #34 レビュー済み・未マージ |
| **P2 マスタ**: 閲覧 UI（作品一覧・詳細・団体）→ オーナー CRUD → 名寄せ API | #3。計画 → 子 issue → PR の順。閲覧 UI を最初に出す |

## 残り（機能、進める順）

| Phase | issue | 内容 | 依存 |
|---|---|---|---|
| P2 | #3 | マスタ CRUD（オーナー）、作品 / 団体 / 会場 / 回の閲覧 UI、`GET /api/admin/match` | P1 |
| P3 | #4 | 記録（attempt / session）、難易度・物量・ジャンル・ネタバレメモ、マイリスト、本人の一覧・統計、匿名人数（ぼかし・オプトアウト） | P2 |
| P4 | #5 | リクエスト投稿・一覧、agent トークン、proposal API、承認 UI（差分・却下記憶・自動反映） | P3 |
| P5 | #6 | `nazo-admin` CLI、`/process-queue`、escape MCP 手順、trailcast インポート | P4 |
| P6 | #7 | Bluesky ログイン、複数プロバイダ紐付け（`oauth_state.mode='link'`）、復旧コード | P1 |
| P7 | #8 | 出店（market / edition / booth）、gamemarket.jp 取り込み、得意傾向の統計、エクスポート | P3 |
| P8 | #9 | フレンド（招待リンク・申請・承認・ブロック）、`asFriendOf` の status 射影、作品ページの「フレンド n 人」 | P3 |
| P9 | #10 | 画像（R2、クライアント縮小、EXIF 検査、ネタバレ写真は本人のみ、通報・削除、容量上限）。退会時の R2 実体削除 `TODO(P9)` もここ | P3 |
| P10 | #11 | ルーム型一覧（都道府県 → 店舗 → 作品）、常設 run、kind / is_permanent の推定 → 承認 | P2, P4 |
| P11 | #12 | フレンド公開範囲設定（既定 share level、記録ごと hidden、写真の表示）、Bluesky フォローからの候補 | P8, P9 |

### 各 Phase への申し送り（レビューで決まった制約）

- **P3（#4）**: ネタバレ断片 `spoilerResponse` は `own()` でしか得られない型からだけ呼べるようにする。`v_attempt_enriched` から `spoiler_memo` を外し、フレンド射影は必ずそのビュー経由。匿名人数は `'none' | 'few' | number` を返す唯一の関数にし、生 COUNT をテンプレートに渡さない。
- **P4（#5）**: 自動反映の 7 日取り消しは、attempt / wishlist が付いた work・run を FK で物理削除できない。取り消し = `merged_into_id` 付け替え か 取り消し不可 かを着手前に決め、`proposal.status` に取り消し後の値を足す。`/api/agent/*` は記録系ルートを持たない別サブアプリにする。
- **P6（#7）**: `completeOAuth` は `mode !== 'login'` を failed にしている。link 用の経路を別に作る（DELETE RETURNING で行は消費される点に注意）。

## 残り（機能以外）

| 区分 | 内容 | issue |
|---|---|---|
| DB | D1 ビュー（`v_*`）の作成 | #14 |
| 認証まわり | ログイン系エンドポイントのレート制限（`oauth_state` の掃除は P1 で対応済み） | #29 |
| 認証まわり | 「すべての端末からログアウト」 | #30 |
| 本番デプロイ | D1 作成 → `database_id` 置換、`db:migrate:remote`、secret 3 つ、Google / Discord の OAuth アプリ登録と CLIENT_ID、`OWNER_IDENTITIES`、`AUTH_DEV_LOGIN=0` / `UI_GALLERY=0` 確認、カスタムドメイン nazo.shino3.net + `workers_dev = false` | `docs/ops.md`（ユーザー作業） |
| 実機確認 | Google 初回ログイン、Discord 初回の同意画面、Discord が PKCE（`code_verifier`）を受理するか | `docs/ops.md` |
| 任意 | Google Fonts のセルフホスト（Klee One / IBM Plex Mono / Zen Kaku Gothic New） | — |

## 進め方（固定）

1. Phase ごとに spec-writer が計画（PR 分割・ルート・DB・テスト観点）を書く
2. 子 issue を切り、implementer が 1 PR = 1 論点で実装
3. pr-reviewer（Fable）が PR 単位でレビュー → 修正 → Phase 終了時に通しレビュー
4. マージはユーザーの指示があってから
