# 見た目の方針: Noto Sans・視覚的な重心・ペンの差し色

> 更新（2026-11-10）: Klee One は全廃（#75 見出し、#79 `.pen`）。以下で Klee One とある所は Noto Sans JP に読み替える。`.pen` は --fg・500。
> 状態（2026-11-10）: §1 フォント、§2.2 スケール、§3 ペンの部品、§3.6 の演出（押すと沈む・保存直後の蛍光ペン・作成直後のハンコ）、§4.2 記録詳細の結果の行、§4.5 統計の成功率、§4.4 人数を 1 行に、は実装済み。
> 未実装: §4.3 会期の `.due`・検索一致の `<mark>`、§4.4 `.mine` / `.period`、§4.5「得意」、ステータス変更後の `?status=1` のハンコ。仮の値（まもなく終了 = 14 日、得意 = 母数 5 件以上）はユーザー了承済み。

前提: ノートの地（ドット方眼・--bg/--surface/--line・ライトのみ）とステータス＝線種はそのまま。
ux-review-2.md（以下 UR2）の M1〜M6 / R1〜R14 / O1〜O7 と矛盾しないように書いた。重なる項目は §5 で「どちらが持つか」を決めている。
注記: 描画は headless Chromium のスクショで確認した。実機（iOS Safari 等）とアニメーションの見え方は未確認。

---

## 1. フォント（決め打ち）

| 用途 | 書体 | ウェイト | 判断 |
|---|---|---|---|
| 本文・ラベル・一覧・ボタン・節見出し（.sect h2） | **Noto Sans JP** | 400 / 500 / 700 | 採用。Zen Kaku Gothic New は**捨てる** |
| ページ見出し（.top h1）・.brand・.login h1・.cover .big・.sheet h3 | **Noto Sans JP** | 700 | Klee One は明朝のように見えて読みにくいので見出しにも使わない（#75） |
| 短い注記 `.pen`（結果の行の「2 回目 · 3 日目」） | **Noto Sans JP** | 500 | 手書き体はやめた（#79）。青ペンだとリンクと紛れるので色は --fg |
| 数字（日付 stub・KPI・.num・棒の値・月別・.sub の日付） | **IBM Plex Mono** | 500 / 600 | **残す**。桁揃えのため。数字以外（ラベル・「記録」など）には使わない |

- `.sect h2` は Klee One 16px → **Noto Sans JP 700 / 15px** に変える（細い手書き体が 16px で弱く、節の切れ目が読めない。UR2 §2「文字サイズと階層」）。
- 戻る版の `.top h1.sub`（app.css:934-940、mono 12px）は Noto 500 / 13px muted に変える。数字ではないので mono をやめる。
- Noto Sans JP 単体の `tabular-nums` は Google Fonts 版で効くか未確認。桁を揃えたい所は mono を使い続けるので依存しない。`body { font-variant-numeric: tabular-nums }` は保険として入れておく（効かなくても害は無い）。
- 見出し・作品名だけ `font-feature-settings: "palt"`（約物の詰め）。「【ダミー】」の括弧の空きが詰まる。本文には付けない（読みやすさ優先）。

読み込み（Layout.tsx:16-17 の FONTS を置き換え）:
```
https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap
```
トークン（app.css:19-21）:
```css
--sans: "Noto Sans JP", "Hiragino Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
--mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
```
- 重さ: Noto Sans JP は unicode-range で分割配信されるので、使った字の分だけ落ちる。3 ウェイトで十分（300/900 は入れない）。

---

## 2. 視覚的な重心

### 2.1 決め方（全画面共通の規則）
1. 画面ごとに「一番見たいもの」を **1 つ**決める。それだけが **最大サイズ × 700（数字は mono 600）× --fg** を持つ。
2. 2 番目（ステータス印・日付など）は「サイズは小さく、形で目立つ」（枠・塗り）。
3. それ以外はすべて 13px 以下・400・muted に落とす。**大きくて muted、小さくて太字、を作らない**（今の「マイリスト 3 人」20px や「–/5」20px がこれ）。
4. 蛍光ペンは 1 番目か、1 番目の中の 1 語にだけ引く（§3）。
5. 余白: 1 番目の塊の上下は 20px 以上、塊の中は 6〜8px。塊の間を空けて「どこからどこまでが主役か」を見せる。

### 2.2 文字サイズとウェイトのスケール
最小 12px（11px・10px は廃止。UR2 R3 を包含）。

| トークン | px | 行の高さ | 主なウェイト | 使い所 |
|---|---|---|---|---|
| `--fs-xs` | 12 | 1.5 | 500 / 700 | ステータス印 .chip、stub の年月、KPI のラベル、月別の目盛り（10→12） |
| `--fs-s` | 13 | 1.6 | 400 | .meta、.note、.field のラベル（色は --fg、UR2 R3）、棒の値 |
| `--fs-m` | 15 | 1.7 | 400 / 700 | 本文、.kv、ボタン（700）、.sect h2（700） |
| `--fs-l` | 17 | 26px（罫線に合わせる、UR2 M4） | 700 | 一覧の作品名 .title（16→17） |
| `--fs-xl` | 22 | 1.4 | 700 | 詳細の作品名、結果の行の日付（mono 20 は例外的にここに含める） |
| `--fs-2xl` | 28 | 1.2 | 700（Noto）/ 600（mono） | ページ見出し .top h1（26→28）、統計の副 KPI |
| `--fs-3xl` | 40 | 1.1 | 600（mono） | 統計の成功率だけ |

| ウェイト | 用途 |
|---|---|
| 400 | 本文・meta・note・値 |
| 500 | ラベル（KPI ラベル・.field ラベル・.top h1.sub）、stub の日（20px） |
| 700 | 作品名・節見出し・ボタン・ステータス印・棒の % |

一覧の stub の日付は **24px/600 → 20px/500** に下げる。今は stub の「10」が行の中で一番重く、作品名とステータスに勝っている（pc_records）。

### 2.3 画面ごとの「一番見たいもの」
| 画面 | 1 番目 | 2 番目 | 落とすもの |
|---|---|---|---|
| 記録一覧 | 作品名 | ステータス印 | 形式・団体、難易度・同行、stub の年月 |
| 記録詳細 | 結果（ステータス）と日付 | 作品名 | 評価の数字・参加情報 |
| 作品一覧 | 作品名 | 会期の状態（開催中/まもなく終了/終了） | 人数・形式 |
| 作品詳細 | 自分の状況（記録・マイリスト）と期間 | 作品名・「記録する」 | 匿名の人数、基本情報 |
| 統計 | 成功率 | 得意なジャンル 1 つ | 内訳・棒の件数 |
| 記録の追加 | 検索欄と一致した語 → フォームではステータスの 5 択 | 作品名 | 説明文 |

---

## 3. ペンの差し色

### 3.1 トークン
```css
--hl: #ffe45c;        /* 蛍光ペン（黄） */
--pen-red: #b4302a;   /* 赤ペン */
--pen-blue: #1f4fa3;  /* 青ペン */
--danger: var(--pen-red);   /* 今は #1c1c1c。使っているのは .spoil-title だけ（app.css:1013） */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);

/* 蛍光マーカーの色（黄以外は統計のグラフ系列とそれを指す KPI だけ。§3.3） */
--mk-yellow: var(--hl);   /* #ffe45c（既存の --hl。値は変えない） */
--mk-pink:   #ff9ec4;     /* 失敗 */
--mk-green:  #8fdc7a;     /* 成功 */
--mk-cyan:   #86d0f2;     /* Web */
--mk-orange: #ffb257;     /* 周遊 */
--mk-purple: #c3a6f2;     /* LINE */
--mk-gray:   #d3cfc4;     /* その他・形式未設定 */
/* 模様（インク 60% の細線。色と必ず組にする） */
--ink-pat: rgb(28 28 28 / 0.6);
--pat-diag:  repeating-linear-gradient(45deg,  var(--ink-pat) 0 1px, transparent 1px 5px);
--pat-back:  repeating-linear-gradient(-45deg, var(--ink-pat) 0 1px, transparent 1px 5px);
--pat-horiz: repeating-linear-gradient(0deg,   var(--ink-pat) 0 1px, transparent 1px 4px);
--pat-dot:   radial-gradient(var(--ink-pat) 0.9px, transparent 1.3px);   /* --ps: 4px 4px と組 */
--pat-grid:  repeating-linear-gradient(0deg, var(--ink-pat) 0 1px, transparent 1px 4px),
             repeating-linear-gradient(90deg, var(--ink-pat) 0 1px, transparent 1px 4px);
```
`--info` / `--warn` / `--accent` は未使用なので触らない（--accent は黒のまま。主ボタンは黒塗りを続ける）。

### 3.2 コントラスト（WCAG 2.x の式で計算）
| 前景 | --surface #FFFEFA | --bg #F6F4EE | --surface2 #EFECE4 | --hl の上 |
|---|---|---|---|---|
| --fg #1C1C1C | 16.89 | 15.49 | 14.44 | **13.39** |
| --muted #6B6A66 | 5.37 | 4.92 | 4.59 | **4.26（AA 不可）** |
| --pen-red #B4302A | **6.13** | 5.62 | 5.24 | 4.86 |
| --pen-blue #1F4FA3 | **7.69** | 7.06 | 6.57 | 6.10 |
| --surface を赤/青の上に（塗りの印・ボタン） | 6.13 / 7.69 | | | |

- 赤・青とも 12px の小さい字でも AA（4.5）を満たす。
- **muted の字の下に蛍光ペンを引かない**（4.26 で AA を切る）。蛍光ペンの下は --fg か --pen-red の字だけ。
- 蛍光ペン自体と紙の差は 1.26:1 しかない。**蛍光ペンは飾りで、意味は持たせない**（引いてある語は、引かなくても太字・大きさで既に 1 番目になっている）。
- 赤と黒の差は 2.76:1、青と黒は 2.20:1。色覚の型によっては赤・青が黒に見える前提で、**色の意味は必ず形（線種・下線・波線・書体）でも出す**（§3.4）。

蛍光マーカー 7 色（同じ式）:
| マーカー | 黒字 #1c1c1c を上に | 紙 --surface #fffefa との差 | 紙 --bg #f6f4ee との差 | muted #6b6a66 を上に | 赤ペン #b4302a を上に |
|---|---|---|---|---|---|
| 黄 #ffe45c | **13.39** | 1.26 | 1.16 | 4.26 ✗ | 4.86 |
| ピンク #ff9ec4 | **8.88** | 1.90 | 1.75 | 2.82 ✗ | 3.22 ✗ |
| 緑 #8fdc7a | **10.30** | 1.64 | 1.51 | 3.27 ✗ | 3.73 ✗ |
| 水色 #86d0f2 | **10.00** | 1.69 | 1.55 | 3.18 ✗ | 3.63 ✗ |
| 橙 #ffb257 | **9.54** | 1.77 | 1.62 | 3.03 ✗ | 3.46 ✗ |
| 紫 #c3a6f2 | **8.16** | 2.07 | 1.90 | 2.59 ✗ | 2.96 ✗ |
| 灰 #d3cfc4 | **10.95** | 1.54 | 1.42 | 3.48 ✗ | 3.97 ✗ |

- 黒字はどの色の上でも AA（4.5）を大きく超える。**マーカーの上に置く字は --fg だけ**（muted・赤ペンは全色で不可。「muted に引かない」を全色に広げる）。
- 紙との差は全色 3:1 未満 → WCAG 1.4.11（図形 3:1）を色では満たせない。**色付きの塗りは必ず 1px の --fg の枠で囲む**（棒は `.tr` の枠、月別は `.stk` の枠）。境界はインクが担い、色は補助。
- 色どうしの差は最大でも 黄×紫 1.64、緑×水色 1.03、ピンク×橙 1.07。2 型色覚（Machado 2009 で模擬）では 緑×ピンク が 1.05（D 型）。→ **色だけで系列を見分けさせない**。模様とラベルが必須（§3.7）。

### 3.3 3 色の規則
| ペン | 使う | 使わない | 上限 |
|---|---|---|---|
| **蛍光ペン（黄）** `.hl` | 画面の 1 番目の中の 1〜2 語（統計の主役の数字、記録詳細の日付、作品詳細の会期の終わり、PC の選択中の作品名）／検索で一致した語 `<mark>`／保存直後のメッセージ（§3.5） | 一覧の各行（繰り返すと意味が消える）、ボタン、見出し、muted の字、ステータス印 | **色を問わず合算で 1 画面 2 か所まで**。例外は検索一致（何件出ても 1 回と数える）と保存メッセージ（数秒で役目を終える） |
| **蛍光ペン（黄以外）** `.hl.mk-*` | グラフの系列を指す字だけ（統計の KPI の値で、凡例と同じ色。例: 成功率に緑 `.hl.mk-green`） | 統計画面の外すべて、黄の「使わない」と同じ所 | 黄と合算で 1 画面 2 か所まで |
| **グラフの塗り** `.r-*` / `.k-*` | 統計のグラフ・凡例（§3.7） | 字の強調 | 上限なし（字の強調ではないので数えない） |
| **赤ペン** `--pen-red` | 失敗（.st-failed）、期限（終了まで 14 日以内の会期 `.due`）、ネタバレの見出し（.spoil-title）、削除・退会などの戻せない操作（.btn.danger の文字と破線） | 本文、作品名、リンク、成功率が低いこと（「苦手」を責めない）、入力エラー以外の注記 | 意味で使う（失敗・期限）分はデータ次第で上限なし。ただし **1 行に赤は 1 つまで**。飾りの赤は作らない |
| **青ペン** `--pen-blue` | 枠の無い文字リンク（作品・団体・会場・外部リンク・「ネタバレメモを編集」「作品を見る ›」）＝**必ず下線つき** | 一覧の行全体（.ticket は行ごとリンクだが文字は黒のまま）、枠つきボタン（黒のまま）、塗りのボタン、見出し、長文メモ | リンクは上限なし。`.pen` は 1 画面 3 か所まで（記録詳細と進行ログだけで使う） |

部品見本（`/_ui` のギャラリー）は例外で、7 色の見本を並べるため上限も「統計画面の外では使わない」も当てはめない。

統計画面での数え方: ルーム・公演 = hero の緑 1 か所、持ち帰り・周遊など = hero の黄 1 か所。§4.5 の未実装「得意」（2 か所目）はこの後も入れられる。

青ペンは文字リンクだけに使う。短い注記 `.pen` は当初青＋手書き体にしたが、リンクと紛れるので --fg の Noto Sans 500 にした（#79）。

### 3.4 ステータスの線種との関係（決定: **線種は保ったまま、色は失敗にだけ足す**）
| ステータス | 今 | 変更後 |
|---|---|---|
| クリア | 黒塗り | そのまま（一番重い形のまま） |
| 進行中 | 黒の実線 | そのまま |
| 買った | 黒の破線 | そのまま |
| 失敗 | 黒の二重線 | **赤の二重線＋赤字**（`.st-failed { border-color: var(--pen-red); color: var(--pen-red) }`） |
| 断念 | muted の枠＋取り消し線 | そのまま |

- 色で置き換えない理由: 赤と黒は 2.76:1 で、色覚によっては同じ暗い色に見える。二重線が残っていれば失敗と読める。
- 青をステータスに使わない理由: 青＝「押せる」の約束を崩さないため。
- 「進行中」と「買った」の実線/破線が小さいと区別しにくい件（UR2 pending）は色で解かない。UR2 R4（印の幅を揃える）と、印の 12px 700 で対応する。
- 蛍光ペンはステータス印に重ねない（塗りのクリア印の上では見えず、枠の印の上では線種が読みにくくなる）。

### 3.5 CSS の部品
```css
/* 蛍光ペン: 字の下 40% に引く。2 行に折れても行ごとに引く */
.hl, mark.hl {
  color: inherit;
  background: linear-gradient(transparent 58%, var(--hl) 58%, var(--hl) 94%, transparent 94%) no-repeat;
  background-size: 100% 100%;
  padding-inline: 0.12em;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
/* 青ペンのリンク（枠の無い a だけ。.btn/.ticket/.tab/.fchip/nav/.idx/.menu は除外） */
a:not([class]), a.meta, .kv a, .card a:not(.btn) {
  color: var(--pen-blue);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
/* 短い注記 */
.pen { font-weight: 500; font-size: 15px; color: var(--fg); }
/* 期限: 赤の波線。色が見えなくても波線で読める */
.due { color: var(--pen-red); text-decoration: underline wavy var(--pen-red); text-underline-offset: 4px; }
```
（リンクのセレクタは目安。`a:not([class])` で拾えない所は実装時に個別に足す。）

### 3.6 気持ちよさ（pure CSS、すべて 300ms 未満・ease-out、emil-design-eng の基準）
1. **押すと沈む**（UR2 O1 を吸収）
   ```css
   .btn, .fab, .fchip, .seg label, .gtag { transition: transform 140ms var(--ease-out); }
   .btn:active, .fab:active, .fchip:active, .seg label:active, .gtag:active { transform: scale(0.97); }
   .ticket { transition: transform 140ms var(--ease-out); }
   .ticket:active { transform: scale(0.99); }   /* 大きい部品は控えめに */
   ```
2. **保存すると蛍光ペンが引かれる**: SSR なので「保存後に開いたページで 1 回だけ」走らせる。`?saved=1` / `?created=1` のときだけ `.hint` の文言・「保存しました」に `.hl.draw` を付ける。
   ```css
   .hl.draw { background-size: 0% 100%; animation: hl-draw 260ms var(--ease-out) 120ms forwards; }
   @keyframes hl-draw { to { background-size: 100% 100%; } }
   ```
3. **ステータスを変えるとハンコが押される**: ステータス変更後の詳細で、結果の行の印に `.stamp` を付ける。
   ```css
   .chip.stamp { animation: stamp 180ms var(--ease-out); }
   @keyframes stamp { from { transform: scale(1.12) rotate(-4deg); opacity: 0.5; } to { transform: none; opacity: 1; } }
   ```
   今のステータス変更は `/records/:id` へ flag なしで戻している（src/routes/records.tsx:258）。`?status=1` を付けて RecordDetail に渡す必要がある（小さい TSX 変更）。
4. reduced motion:
   ```css
   @media (prefers-reduced-motion: reduce) {
     .btn, .fab, .fchip, .seg label, .gtag, .ticket { transition: none; }
     .btn:active, .fab:active, .fchip:active, .seg label:active, .gtag:active, .ticket:active { transform: none; }
     .hl.draw { animation: none; background-size: 100% 100%; }  /* 最後の状態だけ見せる */
     .chip.stamp { animation: none; }
   }
   ```
   既存の `.sw::after` の reduced-motion（app.css:886-890）と同じブロックにまとめる。

### 3.7 グラフの系列（色＋模様）
1 色 1 意味でアプリ全体に固定する。すべての塗りに模様とインクの枠を併用し、色覚によらず模様とラベルで読めるようにする。
| クラス | 意味 | 色 `--c` | 模様 `--p` | 凡例の字 |
|---|---|---|---|---|
| `.r-ok` | 成功（来場型） | `--mk-green` | `--pat-diag`（旧来の黒斜線の後継） | 成功 |
| `.r-ng` | 失敗（来場型） | `--mk-pink` | なし（無地） | 失敗 |
| `.k-stroll` | 周遊 | `--mk-orange` | `--pat-diag` | 周遊 |
| `.k-line` | LINE | `--mk-purple` | `--pat-dot`（`--ps: 4px 4px`） | LINE |
| `.k-web` | Web | `--mk-cyan` | `--pat-horiz` | Web |
| `.k-takeaway` | 持ち帰り | `--mk-yellow` | なし（無地） | 持ち帰り |
| `.k-other` | その他 | `--mk-gray` | `--pat-back` | その他 |
| `.k-none` | 形式未設定 | `--mk-gray` | `--pat-grid` | 形式未設定 |
- 失敗をピンクの**無地**にするのは「成功率が低いことを赤で責めない」（§3.3）に合わせるため。赤ペンは使わない。
- 公演・ルームに形式の色は付けない（来場型の見方では色 = 成功/失敗）。
- 完了型の形式の並び（凡例・棒・月別の積み上げ下→上）は `workKinds` の順（stroll, line, web, takeaway, other）→ 形式未設定。

---

## 4. 画面ごとの適用例

### 4.1 記録一覧（RecordsList / RecordTicket、records.tsx:61-78, 165-211）
- 重み: `.title` 17/700 --fg（唯一の太字）。`.meta`・extra 13/400 muted。stub `.d` 20/500 --fg、`.m` 12 muted（UR2 R6 で月見出しが入れば stub は日と曜日だけ）。印 12/700。
- 蛍光ペン: **SP は 0**。PC の選択中だけ `.ticket.sel .title` に `.hl`（1 か所）。同時に UR2 O3 の黒い太い影をやめ、`.ticket.sel { border-color: var(--fg); box-shadow: 2px 2px 0 var(--surface2) }` にする（選択の印を「影」から「蛍光ペン」に移す）。
- 赤: 失敗の印だけ。青: なし（行ごとリンクなので文字を青くしない）。
- TopBar の「46 件プレイ ›」は黒の ghost ボタンのまま。

### 4.2 記録詳細（RecordDetail、records.tsx:422-576）
- カードの中を 3 段にする:
  1. `a.meta`（作品へのリンク、青＋下線、13px。タップ高さは UR2 O4 の `padding-block`）
  2. `.title` 22/700
  3. **結果の行 `.res`**（新設）: `StatusChip` を `.chip.lg`（15px/700、padding 4px 12px）＋ 日付 `.res-date`（mono 20/600、`.hl`）＋ `.pen`「2 回目 · 3 日目」。
     日付はステータスに応じて finishedOn / startedOn / purchasedOn（= 一覧の displayOn）を出す。
- `.nums` は 20 → 17px mono に下げる（結果の行より軽くする）。全部未評価なら UR2 R1 で出さない。
- 蛍光ペン: 結果の日付（1）＋保存直後の `.hint` / 「保存しました」（2、`.draw`）。
- 赤: 失敗の印、`.spoil-title`「ネタバレ」、「記録を削除」の文字と破線。青: 作品リンク・「ネタバレメモを編集」・`.pen`（結果の行と進行ログの `.log .body b` の進み具合）。
- ステータス変更後は結果の行の印に `.stamp`。

### 4.3 作品一覧（WorkTicket、master.tsx:76-110）
- 重み: `.title` 17/700。人数は UR2 M5 の muted mono 文字。
- 会期 extra: 開催中・販売中 → 13/400 --fg、終了 → muted、**終了まで 14 日以内 → `.due`（赤の波線）で「〜11/30 終了」**。WorkTicket に `today` を渡す必要がある（runStatus と同じ比較。UR2 O5 を吸収）。
- 蛍光ペン: 検索語があるときだけ、作品名の一致部分を `<mark class="hl">`（UR2 O6 を吸収。背景 surface2 ではなく蛍光ペンにする）。PC の選択中は 4.1 と同じ。
- 青: なし（行ごとリンク）。

### 4.4 作品詳細（WorkDetail、master.tsx:209-339）
- カードの中を「meta（団体リンク青）→ 作品名 22/700 → **自分の状況 `.mine`** → **期間 `.period`**」の順にする。
  - `.mine`: 記録あり → 最新の `StatusChip` `.chip.lg` ＋ 日付（mono 17）＋ `.pen`「2 回目」。記録なし・マイリストあり → 15/500「マイリストに入れています」。どちらも無し → 13 muted「まだ記録していません」。
    UR2 R9 の「あなたの記録」節（StatusChip つきの一覧）は下に残し、カードには最新 1 件だけを出す。
  - `.period`: 代表の回（開催中・販売中を優先）の `runStatus` と期間。開催中なら終わりの日に `.hl`（1）、14 日以内なら `.hl` の代わりに `.due`（赤と黄を重ねない）。
- 匿名の人数（WorkNums、master.tsx:190-206）は 20px の `.nums` をやめ、カード下端の 13px muted 1 行「プレイ済み 12 人 · マイリスト 3 人」に落とす（今は 20px で主役を奪っている。pc_work）。
- 「記録する」は黒塗りの主ボタンのまま。外部リンク（escape.id・チケット・公式サイト）は青＋下線。

### 4.5 統計（StatsPage、src/ui/stats.tsx）
- 見方を chip で切り替える: 「ルーム・公演」（`?view=visit`）/「持ち帰り・周遊など」（`?view=done`）。1 画面に主役は 1 つ（§2.1）。
- KPI は 2 段: 1 段目 `.kpi.hero`（全幅）= ラベル 13/500、値 **mono 40/600 に蛍光ペン**（1）、注記 13 muted。2 段目は 2 列、値 mono 28/600。
  - visit: hero「成功率」に**緑** `.hl.mk-green`（成功の系列と同じ色）、注記「作品ベース 63%」。2 段目「参加」（注記「成功 26 / 失敗 20」）・「予約済み」（注記「参加予定」）。
  - done: hero「完了」（cleared の件数）に**黄** `.hl`、注記「断念 4」（失敗があれば「 · 失敗 n」を足す）。2 段目「進行中」（注記「始めた・続きあり」）・「積み謎」（purchased のみ、注記「買った・未着手」）。
- 棒: ラベル 13 --fg、% 13/700 --fg mono、件数 12 muted（UR2 R14 の上に乗せる）。塗りは §3.7 の系列の色と模様、枠は 1px の --fg。
  - visit の成功率の棒（難易度別・ジャンル別・形式別）は 1 本に成功（緑＋斜線）と失敗（ピンク無地）を並べ、境目にインクの線。凡例「成功 / 失敗」を KPI の下に 1 つ。
  - done の「形式別の完了数」は形式ごとの色と模様の棒（幅は最大の形式を 100%）。
  - 月別は系列の積み上げ（visit = 成功・失敗、done = その年にある形式だけ。done は見出しの下に凡例）。各月に `role="img"` と内訳の `aria-label`。最大の高さ 60px。
- 来場型の旧ステータス（進行中・断念）は集計から外し、件数を `.note` で注記する。
- 蛍光ペンの 2 か所目: ジャンル別で成功率が最高の 1 行のラベルに `.hl`＋ 12px の `.pen`「得意」。母数 5 件以上のときだけ（1/1 の 100% を得意と言わない）。stats.tsx の RateBars に `best` を渡す。（未実装）
- 赤で「低い成功率」は塗らない（§3.3）。失敗の塗りもピンクの無地で、赤ペンは使わない。

### 4.6 記録の追加（NewRecordSearch / NewRecordForm、records.tsx:218-322）
- 検索: `.sect h2`「何を記録しますか？」を 17/700 に上げる（この画面の見出し）。検索欄は今のまま。結果の作品名の一致部分を `<mark class="hl">`。UR2 R8（自分の状態）が入ったら、印はステータスの規則どおり（失敗は赤）。
- フォーム: 作品名 22/700、ステータスの 5 択（checked は黒塗りのまま。選択に色を使わない）、日付ラベル 13 --fg、保存は黒塗り。「作品を見る ›」は青リンク。
- 保存後は記録詳細へ（`?created=1`）→ `.hint` の文言に `.hl.draw`、結果の行の印に `.stamp`。ここが「記録を付けた」瞬間なので、気持ちよさの演出をここに集める。

---

## 5. 実装の PR 分割

UR2 の PR（1 fix/ui-layout-breaks、2 fix/status-vocabulary、3 fix/user-facing-copy、4 feature/list-scanning）と重ならないよう、**次の項目は UR2 から外してこちらで持つ**: R3（文字サイズ +1px → PR-A のスケールに含める）、O1（押したときの反応 → PR-B）、O3（選択中の影 → PR-C）、O5（会期の強弱 → PR-C）、O6（検索一致 → PR-C）。

推奨の順番: **UR2-1 → PR-A → UR2-2 → UR2-3 → PR-B → PR-C → UR2-4**
（PR-A を UR2-2 より先にするのは、M4 の 26px 罫線合わせが文字サイズに依存するため。PR-B は UR2-2 が .chip/.st-* を触り終えてから。PR-C は UR2-3 の R1/R10 で記録詳細の並びが決まってから。）

### PR-A `feature/type-noto`（フォントとスケール。CSS ＋ Layout の 1 行）
- Layout.tsx:16-17 FONTS の URL
- app.css :root に `--sans/--hand` の変更、`--fs-xs`〜`--fs-3xl` を追加、`body { font-variant-numeric: tabular-nums }`
- サイズの付け替え: `.title`(202-206) 17、`.meta`(194) 13、`.stub .m/.d/.nd`(162-177) 12 / 20・500 / 12、`.note`(338) 13、`.num span`/`.kpi span`(395, 766) 12、`.field`(602-608) 13・--fg、`.col`(745) 12、`.proto`(879) 12、`.bar`(711) 13、`.top h1`(87-94) 28
- `.sect h2`(359-367) を Noto 700/15、`.top h1.sub`(934-940) を Noto 500/13、見出しと `.title` に `palt`
- 確認のスクショ: 全 20 枚（字面が全部変わる）。特に sp_records（罫線との位置）、sp_record_edit（ラベル）

### PR-B `feature/pen-tokens`（3 色の規則を部品に入れる。CSS のみ）
- :root に `--hl / --pen-red / --pen-blue / --ease-out`、`--danger` を `--pen-red` に
- 新設クラス: `.hl`, `mark.hl`, `.pen`, `.due`, `.chip.lg`, `.hl.draw`, `.chip.stamp` と keyframes
- 既存の変更: `.st-failed`(228-232) に赤、`.btn.danger`(421-423) の文字と破線を赤、枠の無いリンクを青＋下線（`a` の 51-53 行と 892-911 行の除外リストに合わせる）
- 押したときの反応（O1）と reduced-motion のまとめ（886-890）
- 画面の TSX は触らない（`.hl` などは定義だけ。使うのは PR-C）
- 確認: sp_records（失敗の印）、sp_record（リンク・削除ボタン・ネタバレ）、pc_work（外部リンク）

### PR-C `feature/visual-weight`（画面ごとの重心。TSX が中心）
- records.tsx: RecordDetail のカードに結果の行 `.res`（StatusChip lg・日付 hl・.pen）、`.nums` 17px、`saved/created` で `.hl.draw`、ステータス変更後の `.stamp`（routes/records.tsx:258 に `?status=1`、240-241 の読み取りに追加）、NewRecordSearch の `<mark>`、h2 17px
- master.tsx: WorkTicket に `today` と `q`（会期 `.due`・一致 `<mark>`）、WorkDetail のカードに `.mine` と `.period`、WorkNums を 1 行の muted に
- stats.tsx / components.tsx: `.kpi.hero`（Kpis に hero の指定）、Bars に `best`（ラベル hl ＋ .pen「得意」）
- app.css: `.res`, `.mine`, `.period`, `.kpi.hero`、`.ticket.sel`(1164-1167) を蛍光ペンに置き換え
- 設計判断が残る所: 「まもなく終了」の日数（14 日で決め打ちにした）、「得意」の母数（5 件）。変えるならこの PR の前に決める
- 確認: pc_record / sp_record（保存直後 `?created=1` と `?status=1` の 2 枚も）、pc_work / sp_work、pc_stats / sp_stats、pc_new（検索語あり）、break-ui 用に「会期が 3 日後に終わる作品」「全ジャンル母数 5 未満」のデータ

### 追加で欲しいスクショ
- PR-A 後: Noto に変えた sp_records / pc_records（罫線と字の位置）
- PR-C 後: `?created=1` の直後（蛍光ペンが引かれた最後の状態）、reduced-motion を有効にした同じ画面
- 色覚シミュレーション（Chrome DevTools の Rendering → Emulate vision deficiencies: protanopia / deuteranopia）で sp_records と pc_stats
