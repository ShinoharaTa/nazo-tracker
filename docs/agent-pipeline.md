# 補完パイプライン（リクエスト → Claude → 提案 → 承認）

## 1. 流れ

```mermaid
sequenceDiagram
  participant M as メンバー
  participant W as Worker (API)
  participant O as オーナー
  participant C as Claude (このサーバー)
  M->>W: POST /requests（HTML フォーム）{kind, url, title, note}
  O->>W: 事前選別（triaged / rejected）※任意
  O->>C: tmux で「キュー処理して」(/process-queue)
  C->>W: GET /api/agent/requests?status=triaged,open
  C->>C: escape MCP get_event / WebFetch / match API
  C->>W: POST /api/agent/sources, POST /api/agent/proposals
  W->>W: 自動反映ルール判定 (A-3、既定 OFF) → auto_applied or pending
  O->>W: 承認 UI: 差分・出典・候補を見て 承認 / 却下 / 紐付け先変更
  W->>W: 反映 + change_log、request を done
```

## 2. リクエスト

- 誰でも（ログイン済み）投稿。kind と `payload_json`（`url`, `title`, `organization`, `note`, `target_id`）。直近 24 時間で 20 件/人まで（オーナーは対象外）。
- 一覧はオーナーのみ。依頼者の表示名は見える（記録は見えない）。
- `needs_info` でオーナー/Claude から依頼者に質問（依頼者は自分のリクエストの状態と質問だけ見える）。

## 3. Claude の処理手順（`/process-queue` の中身、CLI 経由）

1. `nazo-admin queue list --status triaged,open` で取得（open は A-1 を省略した場合）。
2. 各件を `processing` に。
3. 調査:
   - `url` が escape.id → MCP `get_event`、必要なら `list_dates`。`source(method=escape_mcp)` を登録。作品の画像は公演ページの **og:image の URL**（`ogImageUrl`）を `work.image_url`、公演ページの URL を `work.image_page_url` に、団体のロゴは主催のアイコン（= 団体ページの og:image）の URL を `organization.logo_url`、団体ページ（`https://escape.id/<slug>-org/`）を `organization.logo_page_url` に提案する（出典は公演情報と同じ source、確信度 0.95。画像の実体は落とさない）。`imageUrl`（縦ポスター優先で og:image と別物になりうる）は提案に含めない。escape.id は形式を区別していない前提なので、`work.kind` は説明文・公式サイトから推定して confidence 付きで提案し、オーナーが承認時に確定する（`type` の生値は `run.escape_type_raw` に参考として残す）。終了日が無く常設らしい（期間「-」/開始日のみ）なら `is_permanent=1` を提案し confidence を 0.7 に下げる。
   - それ以外の URL → robots 確認 → WebFetch。`source(method=webfetch)`。
   - URL 無し → 公式サイトを検索で探す。見つからなければ `needs_info`。
4. `nazo-admin match --title --org` で候補を取得。
5. 提案を作る（kind=create/update/link/merge、各フィールドに source_id、confidence、match_candidates）。
6. request を `proposed` に。失敗は `needs_info` + 理由。
7. 最後にサマリをオーナーに返す（件数、pending の URL）。

確信度の目安: escape.id 由来の構造化フィールド 0.95 / 公式サイト本文から読んだ値 0.7 / 推測 0.4 / 常設判定 0.7。

Claude が**触らないもの**: 画像の実体（取得・アップロードとも。URL を提案に書くだけ）、ユーザーの写真、ユーザーの記録（attempt / session / image）、フレンド関係、ジャンルの付与。評価項目は手入力のみ。

`work.kind` / `is_permanent` の確定: 提案の `proposal_field` に `kind`（推定値 + 根拠の source）を含め、承認 UI でオーナーが選び直せるセレクトにする。A-3 自動反映の対象で `work.kind` / `run.is_permanent` の confidence < 0.9 なら、その項目だけ**入れずに**作品・回を反映し（kind = NULL、is_permanent = 0）、同じ値の `update` 提案（pending、`follow_up_of_id` = 元の提案、リクエストは付けない）を同じ batch で作る。記録はすぐ付けられ、kind が決まるまでステータスは 5 択のまま。

## 4. 承認モデル

| 状態 | 誰が | 内容 |
|---|---|---|
| pending | — | 既定。オーナー承認待ち |
| auto_applied | Worker | A-3 ルール該当。`revert_until = now+7d`。承認 UI の「自動反映」タブ（期限内だけ。過ぎたら「済み」）に出て、確認ページから取り消し |
| applied | オーナー | 承認。フィールド単位で採否を選べる（部分承認） |
| rejected | オーナー | 理由を書く。`rejection_memory(fingerprint)` に保存 |
| suppressed | Worker | fingerprint が rejection_memory に一致。**行は作らず** Claude に 409 `suppressed` を返して再提案を止める（この status の行はできない。enum には残す） |
| reverted | オーナー | 自動反映の取り消し（`reverted_at` / `reverted_by_user_id`）。作った行は物理削除 |
| superseded | Worker | 自動反映を取り消したときの follow-up の pending も superseded にする。update / link / merge で、同じ request_id（どちらも無しを含む）・同じ kind・同じ (target_table, target_id) の新しい提案が来た（新しい行の INSERT と同じ batch）。別のリクエストや別の kind（update で merge / link）は置き換えない |

A-3 自動反映ルール（Worker 側、`src/pipeline/auto.ts`。`/admin/proposals` 上部の Switch で ON/OFF、`app_setting('auto_apply')`。**既定 OFF**＝行が無ければ OFF）。全部満たすときだけ反映:
1. 設定が ON
2. `kind=create` かつ `target_table IN (work, run)`
3. 束に団体・会場・販売先の節が無い（新しい団体・会場を含む提案は表記ゆれを人が見るので承認待ち）
4. 全項目に source があり、全 source の method = `escape_mcp`
5. `run.escape_id_url` がある
6. `work.kind` / `run.is_permanent` 以外の confidence がすべて ≥ 0.9
7. Worker の完全一致候補（`worker:`）が 0 件、かつ agent の候補に score ≥ 0.8 が無い。同じ `run.escape_id_url` で回を作る承認待ちも無い（`pending_same_url`。どちらを採るかは人が決める）
8. リクエストがあるなら kind = `new_work`

`hold: true` の提案は条件判定の対象外（常に pending。§5 の `POST /api/agent/proposals`）。

`update` / `merge` / `link` / 参加記録インポートは常に pending。

画像（`work.image_url` / `image_page_url`）は特別扱いしない（許可ホスト + escape MCP 由来なので、条件を満たせば画像つきで自動反映されうる）。団体の節がある束は 3 で承認待ちなので、**ロゴは必ず人が見る**。

反映は `POST /api/agent/proposals` の 1 batch: 提案（`auto_applied`・`revert_until`・`applied_json`、項目の `accepted` は入れた項目 1 / 入れなかった kind・is_permanent 0）→ 作品 → 回（change_log は actor = トークン、`proposal_id`）→ follow-up → リクエストの自動 done。応答は 201 `{"status":"auto_applied","revert_until":ISO,"follow_ups":[id…]}`。書き込みの UNIQUE 違反は 409（同じ fingerprint の pending → `duplicate_pending`、同じ escape.id URL の回 → `duplicate_escape_id_url`、ほか → `conflict`）。一覧の期限は JST の「M/D HH:mm まで」。

取り消し（`GET/POST /admin/proposals/:id/revert`、退会と同じ確認の checkbox）: `auto_applied` で `revert_until` が未来のときだけ（それ以外 409）。1 batch で 回 → 作品を**物理 DELETE**（change_log `delete`、actor = オーナー）、提案を `reverted`、follow-up と、取り消す作品・回を対象にした承認待ち（update / link / merge）を `superseded`（change_log は「まだ pending なら」の INSERT … SELECT で、書いた行と揃える。承認済みの follow-up はそのまま残し、詳細に「元の作品は取り消されました」と出す）。あとから記録・マイリスト・別名・別の回・統合が付いた行は D1 の FK 違反で batch ごと巻き戻るので、409「取り消せません。統合を使ってください」と作品の統合画面へのリンクを出す（何が付いたかは読まない）。統合された作品・別の作品に付け替えられた回は書く前に同じ 409 にする。取り消した fingerprint は却下記憶に入れない（同じ URL を出し直せる）。

差分表示: フィールドごとに `old → new`、出典ドメイン、取得日時、確信度。候補があれば「既存 X に紐付ける」ボタン。

承認 UI（`/admin/proposals*`、`src/routes/admin/proposals.tsx` / `src/pipeline/apply.ts`）:
- 項目ごとに採否（`accept_<proposal_field.id>`）。`work.kind` は Checkbox ではなく形式の Select で選び直す（提案と同じ値なら採用）。create work は候補の作品に紐付けられる（`link_work_id`。作品は作らず回だけを作り、work.* と、作品からしか参照されていない節（`work.primary_organization_id` の `@organization` だけが指す団体など）は不採用）。update の形式の Select は今の値が既定（提案の値は「提案: 〇〇」）。候補は保存された `match_candidates_json` のうち、未統合で存在する行だけを出す。
- update / link / merge は、採用した項目の今の値が `old_value` と違えば 409 で今の値を出し、`force=1` の「それでも反映する」でだけ反映。対象が無い・統合済みは 409。
- 「現在の行（create は空）+ 採用した項目 + 形式」を提案の投稿と同じ validators に通す。節の項目を全部外すとその節（団体・会場・販売先・回）は作らない。`@<表>` の参照だけを残すと 400。
- 書き込みは 1 batch: 提案の change_log（先頭。まだ pending でなければ NOT NULL 違反で batch ごと失敗させ、二重送信で二重に作らない）→ マスタ（団体 → 会場 → 販売先 → 作品 → 回、または update / relink / merge の Stmts。change_log は actor = オーナー、`proposal_id`）→ proposal `applied`・`applied_json`（作った / 変えた行。紐付け先の既存作品は入れない）→ proposal_field `accepted` → リクエストの自動 done。
- 却下は理由必須（500 字）、「同じ内容の再提案を止める」（既定 on）で `rejection_memory` に UPSERT。
- リクエストの自動 done: 承認・却下・自動反映の batch の最後で、`proposed` か `processing`（agent が proposed にする前に処理し終えた）で、紐付く提案の pending が 0 件なら `done`（その後の agent の `proposed` への PATCH は 409 `invalid_transition`）。
- 同じ対象の承認待ち、同じ `run.escape_id_url` で回を作る承認待ちがほかにあれば詳細に出す（後者はどれか 1 件を承認すると残りは「同じ escape.id URL の回があります。」で止まる）。束の中でほかの項目から参照されていない団体・会場・販売先の節には注記を出す（採用すると単独で作る）。
- `shop.organization_id` も `@organization` で同じ束の団体を指せる。

まとめて承認（`GET/POST /admin/proposals/bulk`、承認待ちタブの Checkbox → 確認ページ（題名と団体）→ 結果）:
- 選べるのは `kind=create` で、保存された名寄せ候補（`match_candidates_json`）が 0 件の pending だけ。候補つき・update / link / merge は Checkbox を出さず、POST に混ぜても反映しない（結果に理由を出す）。非オーナーは 404（`requireOwner`）。
- 1 件ずつ上の承認処理（全項目採用・形式は提案の値・新しく作る）に通す。1 提案 = 1 batch で、先頭の change_log で二重送信を止める仕組みもそのまま。途中で 1 件が検証・書き込みで落ちても残りは進め、件ごとに結果を出す。
- 確認ページの団体は、束が新しく作るもの（`@organization`）を「団体（新しく作る）: 〇〇」、既存の参照先を「団体: 〇〇」と分けて出す。選んだ提案の中で新しく作る団体名（`norm` で比較）が重なるときは、上に「同じ名前の団体を新しく作る提案が複数あります。…先に団体だけを承認してください。」を出す（追加のクエリなし）。
- 選べるのは 1 回 `BULK_MAX` = 50 件まで（一覧の 1 ページと同じ。「すべて選ぶ」も先頭 50 件）。51 件以上送られたら先頭 50 件だけを対象にし、その旨を出す。
- 件数では切らず、実行時のクエリ数で打ち切る。根拠: Workers Free の D1 は 1 回の呼び出しで 50 クエリまで（`db.batch()` は 1 と数える。https://developers.cloudflare.com/d1/platform/limits/ ）。POST の中では `env.DB` を数える Proxy（`src/db/d1-count.ts`。prepare した文の run / all / first / raw と batch を 1 ずつ）で包んだ db を使い、前段の middleware の分は見積もり `BULK_PRE_CALLS` = 5（最大 3 + 余裕 2）を最初に足す。各提案の前に「使用数 + `BULK_ITEM_WORST`（13）> `BULK_CALL_LIMIT`（48）」なら、その件以降は処理せず「未処理」（pending のまま）にする。
  - 実測（1 件あたり、`test/admin-proposals-bulk.test.ts`）: 団体だけ 1、`@organization` の束 2、既存の団体・会場を指す作品 + 回 6、販売の束（`@shop` + 作品 + 回 sale + escape_id_url、団体は既存・URL も全部入り）9。先読み（提案・項目・名前）は 2〜5。1 回で承認できるのは、団体だけなら 29 件、一番重い束では 4 件。
  - 13 は、実測の最大 9 に全部入りの束の余地と、書き込みが NOT NULL で落ちたとき（二重送信）の読み直し 2 を見たもの。
  - 名前の先読み（`namesOf`）は D1 の 1 文 100 変数に当たらないよう 50 個ずつに分けて読む（分けた分も数に入る）。50 件選んでも 48 以下に収まることをテストで確かめている。
- 結果は「承認 n 件 / 失敗 m 件 / 未処理 k 件」と件ごとの行（失敗は理由つき）。未処理があれば「続けて承認する ›」（一覧へ）を出す。見つからない id の行は詳細へのリンクにしない。

fingerprint = sha256(kind, target_table, target_id or title_norm, 正規化した new_value 群)。

## 5. Claude → D1 書き込み経路（比較）

| 案 | 経路 | 認証 | 権限の最小化 | 業務検証 | 実装 | 運用 |
|---|---|---|---|---|---|---|
| W-1 **アプリ REST API + CLI**（推薦） | `nazo-admin` → `/api/agent/*` | Bearer（長期トークン、ハッシュ保存、90 日期限） | ◎ role=agent: マスタ読 / request 読・状態更新 / source・proposal 書。記録・フレンド・画像・R2 は 403 | ◎ Worker が検証・名寄せ・自動反映判定 | 小 | 小（ローテーション） |
| W-2 Worker 上のリモート MCP | Claude から Streamable HTTP MCP | 同上 + MCP 認証 | ◎ | ◎ | 中 | 小 |
| W-3 `wrangler d1 execute` 直接 | CF API トークンで SQL | CF API トークン（D1 Edit はアカウント内全 D1 に及ぶ） | ✗ trailcast の D1 まで書ける。行レベル制御なし | ✗ 検証を素通り | 小 | 中（事故リスク） |

**推薦 W-1。** W-3 は緊急時のオーナー手作業のみに限定し、Claude には渡さない。W-2 は W-1 の上に後付け可能。

### トークン管理
- 発行: オーナー UI（`/admin/tokens`）で名前（40 字）と期限（30 / 90（既定）/ 180 日）を指定 → 平文（`nzt_` + 32 バイト base64url）は発行の応答で一度だけ表示（`Cache-Control: no-store`）→ `~/.config/nazo-tracker/agent.env`（0600）に `NAZO_AGENT_TOKEN=`。scopes は v1 では固定（`master:read` / `request:rw` / `source:write` / `proposal:write`、画面で選ばない）。
- 保存: D1 には SHA-256 ハッシュのみ（Secret は増やさない）。`last_used_at` は NULL か 1 時間より前のときだけ更新。失効は UI（再発行は新しく発行して古い方を失効）。
- `/api/agent/*`: `Authorization: Bearer <token>` だけで認証し、cookie は見ない。無い・失効・期限切れ・でたらめは区別せず 401 `{"error":"invalid_token"}` + `WWW-Authenticate: Bearer`。全応答 `Cache-Control: no-store`。POST / PUT / PATCH と、本文のある DELETE（`Content-Length` > 0 か `Transfer-Encoding` あり。本文の無い DELETE は検査しない）は `application/json` 以外 415、本文 64 KiB 超 413、壊れた JSON 400。定義していないパスは 403 `{"error":"forbidden"}`。疎通確認は `GET /api/agent/whoami` → `{"token_id","name","expires_at"}`。
- 読み取りとリクエスト状態（`src/routes/api-agent.ts`）。匿名人数・記録に関する値は返さない（`countsFor` を呼ばない）:
  - `GET /api/agent/requests?status=open,triaged&limit=50`: status はカンマ区切り（既定 `triaged`、不正値 400 `invalid_status`）、limit は 1〜100（範囲外は寄せる）。`created_at` 昇順。`{items:[{id,kind,payload,status,question,reply,created_at,updated_at}]}`。依頼者の id・表示名、`triage_note`・`agent_note` は返さない。
  - `GET /api/agent/requests/:id`: 同じ形 1 件。無い → 404 `not_found`。
  - `PATCH /api/agent/requests/:id` `{status, question?, note?}`: 遷移は `canTransition` の agent の行だけ（表に無い遷移 409 `{"error":"invalid_transition","from","to"}`）。needs_info は `question` 必須（400 `question_required`、1000 字まで）、needs_info にすると前の `reply` を消す。`note` は `agent_note` に（2000 字まで）。200 `{id,status}`。
  - `GET /api/agent/match?title=&org=&url=`: `/api/admin/match` と同じ検証・同じ形（完全一致のみ）。
  - `GET /api/agent/rows/:table/:id`: table ∈ work / run / organization / venue / shop（不正 400 `invalid_table`）。DB 列名の行 1 つ（`note` は除く）。work は `aliases`・`runs` も付ける（各 200 件まで。超えたら切って `truncated: true` を付ける）。統合済みも返す。無い → 404 `not_found`。
  - `GET /api/agent/index/:table?part=name|alias&after=&limit=1000`: table ∈ work / organization / venue（venue は name のみ、不正 400 `invalid_part`）。未統合だけ（alias は未統合の作品・団体の別名）、id 昇順、limit は 1〜1000（既定 1000）。work `{id,work_id,title,title_norm,org_id}`、organization `{id,organization_id,name,name_norm}`、venue `{id,name,name_norm,prefecture}`。`{items, next}`（続きがあれば最後の id、無ければ null。次は `after=<next>`）。
  - `GET /api/agent/schema`: 提案で書ける項目と値の一覧（MCP のツール説明の元。二重管理しない）。`{proposal_fields:{<kind>:{<target_table>:["<表>.<列>"…]}}, enums:{"work.kind","run.channel","shop.kind","venue.prefecture","run.is_permanent"}, placeholders:{"<表>.<列>":"@<表>"}, source_methods, request_statuses, proposal_statuses}`。`proposal_fields` は `src/pipeline/fields.ts` の表（`parseProposal` が許す項目）から作り、kind は create / update / link / merge（`create_attempt_import` は載せない）。`enums` は validators が値を限定している列で、`run.is_permanent` の `""` は常設でない（null と同じ）。`placeholders` は同じ束の行を指せる列とその値（`fields.ts` の `placeholders` から作る。例 `"work.primary_organization_id":"@organization"`）。`source_methods` は agent が送れるもの（`escape_mcp` / `webfetch` / `pds`）。`image_hosts` は画像の URL に使えるホスト（`src/lib/image-url.ts` の `IMAGE_HOSTS`。例 `["static.escape.id"]`）。
- 出典と提案（`src/routes/api-agent.ts`、形と検証は `src/pipeline/fields.ts`）。Worker は外部へ fetch しない:
  - `POST /api/agent/sources` `{url, method, fetched_at, content_hash?, excerpt?, robots_checked}` → 201 `{"id"}`。`domain` は Worker が host（小文字）から入れる。`method` は `escape_mcp` / `webfetch` / `pds`（`manual` などは 400 `invalid_method`）。禁止の取得元（escape.id / `*.escape.id` の `/me` 以下、host が `x.com` / `twitter.com` / `t.co` そのものかそのサブドメイン）は 400 `forbidden_source`。`escape_mcp` は host `escape.id` のみ（400 `method_host_mismatch`）、`webfetch` は `robots_checked` = 1 必須（400 `robots_not_checked`）。`url` 不正・userinfo（`user:pass@`）付き 400 `invalid_url`、`robots_checked` は 0 / 1 / true / false（400 `invalid_robots_checked`）、`fetched_at` はタイムゾーン付き ISO 8601（400 `invalid_fetched_at`、UTC の toISOString の形で保存）、`content_hash` は 64 桁 hex（400 `invalid_content_hash`）、`excerpt` ≤ 500 字（400 `excerpt_too_long`）。
  - `POST /api/agent/proposals` `{kind, target_table, target_id?, request_id?, fields:[{field, new_value, source_id, confidence}], match_candidates?, hold?}` → 201 `{"id","status":"pending"|"auto_applied","fingerprint","revert_until":null|ISO,"follow_ups":[id…]}`。A-3（§4）に合えば `auto_applied`、それ以外は `pending`。
    - `hold`（true / false、既定 false）: true なら A-3 の判定をせず、設定が ON で条件を満たしていても `pending`（MCP の `create_proposal` は常に true を送る）。false・無しは従来どおり。true / false 以外（null・0 / 1・文字列も）は 400 `invalid_hold`。fingerprint には含めない。
    - 項目は `<表>.<列>`（列はフォーム名）、値はフォームと同じ文字列（前後の空白を落とし、空は null）で、承認時と同じ validators に通す（エラーは 400 `{"error":"invalid_fields","details":[…]}`）。書ける列・kind ごとの節は `src/pipeline/fields.ts` の表（それ以外・`note`・`image_blocked` は 400 `unknown_field`）。create は work / run の束に新しい団体・会場・販売先を入れられ、`@organization` / `@venue` / `@shop` で同じ束の行を指す（節が無ければ 400 `invalid_placeholder`）。
    - kind 不正 400 `invalid_kind`、`create_attempt_import` 400 `kind_not_supported`、target_table 不正 400 `invalid_target_table`、create に target_id 400 `target_id_not_allowed`、それ以外で無し 400 `target_id_required`、同じ field 2 回 400 `duplicate_field`、confidence が 0〜1 でない 400 `invalid_confidence`、候補（最大 20 件 `{table: work|organization|venue, id, score 0〜1, reason ≤ 40 字}`。id は 64 字まで、存在は確かめない）不正 400 `invalid_candidates`、無い source_id 400 `{"error":"source_not_found","field"}`。
    - `request_id` は任意。無い 404 `request_not_found`、`processing` でない 409 `request_not_processing`。target が無い 404 `target_not_found`、統合済み 409 `target_merged`。create で既存の回の `run.escape_id_url` 409 `{"error":"duplicate_escape_id_url","run_id","work_id"}`。update で全項目が今の値と同じ・link で同じ作品 400 `no_change`。
    - 保存する `new_value` と fingerprint は validator が正規化した後の値（URL の末尾スラッシュ、`08` と `8` などの書き方の違いを畳み、却下記憶・重複をすり抜けないようにする）。参照プレースホルダと `run.work_id` は送られた値のまま。
    - `old_value` と fingerprint は Worker が計算する（agent の old_value は無視）。fingerprint = sha256 hex(`[kind, target_table, target_id ?? norm(主名), [field, new_value] を field 昇順]`)。confidence と source は含めない。`proposal.confidence` は項目の最小値。
    - rejection_memory に当たれば行を作らず 409 `{"error":"suppressed","reason"}`。同じ fingerprint の pending があれば 409 `{"error":"duplicate_pending","proposal_id"}`。
    - Worker 自身の完全一致候補（`work.title` / 束の団体名 / `run.escape_id_url` で `findCandidates`、対象そのものは除く）を `reason` に `worker:` を付けて agent の候補の後ろに足し、`match_candidates_json` に保存する。
    - 書き込みは 1 batch: 置き換える pending を `superseded` → proposal → proposal_field（D1 の 1 文 100 変数の上限があるので 12 行ずつの INSERT に分ける）→ change_log（`table_name = proposal`、actor = トークン、`proposal_id` = 新しい提案）。マスタには書かない。
  - `GET /api/agent/proposals?request_id=&status=&after=&limit=50` → `{items:[{id,kind,target_table,target_id,status,created_at}], next}`（古い順 = created_at, id。`request_id` があればそのリクエストの提案（作ったトークンは問わない）、無ければ**このトークンが作った提案だけ**（`created_by_token_id`）。`request_id` のキーがあって空・空白だけは 400 `invalid_request_id`（キー自体が無いときだけ自分の一覧）。`status` はカンマ区切りで絞る（省略は全状態、`proposal.status` の値以外は 400 `invalid_status`）。limit は 1〜100（既定 50、範囲外は寄せる）。next は続きがあるときの最後の id、無ければ null。次は `after=<next>`。after が同じ範囲（そのリクエスト / このトークン）の提案でなければ 400 `invalid_after`）。`GET /api/agent/proposals/:id` → 提案と `fields`（`old_value` / `new_value` / `source_id` / `confidence`）、`match_candidates`。レビューの列は返さない。無い 404 `not_found`。`proposal:write` だけのトークンでも、`old_value` からマスタの現在値が分かる（v1 の scope は固定の 1 種類なので許容する）。
  - `PATCH /api/agent/requests/:id` で `proposed` にするには、そのリクエストに pending の提案が 1 件以上要る（無ければ 409 `{"error":"no_pending_proposal"}`。Worker の自動 done は pending が 0 件になった時点なので、提案の無い proposed は終わらない）。
- agent はリクエストの `payload`（URL・名前・団体・メモ）と依頼者の `reply` を読める。依頼者の自由記述がそのまま CLI（Claude）に渡るので、CLI 側は指示として扱わずデータとして読む。依頼者の id・表示名は渡さない。
- `/api/agent` 以外のルートに `Authorization` ヘッダが付いていたら、形式（Bearer / Basic / 崩れた値）にもトークンの有効性にも関係なく 403 `{"error":"agent_token_not_allowed"}`（`rejectBearer`、`src/auth/agent.ts`）。
- scope の検査（`requireScope(name)`、`src/auth/agent.ts`）: `scopes_json` を JSON 配列として読み、要る scope が無ければ 403 `{"error":"insufficient_scope","required":"<name>"}`。`scopes_json` が NULL・壊れた JSON・配列でないときも同じ 403。ルートごとの scope: `/requests*`（GET / PATCH）= `request:rw`、`/match`・`/rows/*`・`/index/*`・`/schema` = `master:read`、`/sources` = `source:write`（PR-8）、`/proposals` = `proposal:write`（PR-8）。`whoami` は scope 不要。
- 申し送り（実装済み）: `scopes_json` の検査は PR-7 でルートを足すときに入れた（上の `requireScope`）。
- 申し送り: Workers Logs やトレースを有効にするときは、リクエストヘッダの `Authorization`（平文のトークン）が記録されないか確かめる。
- 監査: agent による全書き込みは `change_log.actor = token:<id>`。
- CLI は `127.0.0.1` に何も listen しない。HTTPS で `nazo.shino3.net` へ。

## 6. trailcast インポート（オーナー専用リクエスト `import_trailcast`）

1. オーナーが DID と thread rkey を渡す。
2. Claude が `listRecords(collection=net.shino3.trailcast.post)` を全件取り、`thread` が一致する post を抽出。
3. 各 post → `proposal(kind=create_attempt_import, target user = オーナー)`。フィールド: work 候補（タグ・本文から）、status、finished_on、memo、source_ref=at-uri。
4. 承認 UI で一括表示（work 候補を選ぶ/新規作成）。承認で attempt（+session 1 件）作成。
5. `UNIQUE(user_id, source_ref)` で再実行は冪等。

他ユーザーの trailcast インポートは v1 では対象外（必要なら本人が UI から DID を入れる形で後付け）。
