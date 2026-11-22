# 目的別スキルとモデル入力の節約

通常のMODKHチャットとローカル子エージェントで自動的に有効です。追加のモデル呼び出し・パッケージ・Kiokuko接続は不要です。外部エージェントの内部プロンプトは対象外です。

## 目的別スキル

kiokuko-dshのスキル17件と参照資料を含む43ファイルを、原文のまま `skills/kiokuko-dsh/` に同梱しています。独自の短い `modkh-*` 代用品は廃止しました。pstack 0.15.46（MIT）をMODKH向けに移植した1件と参照資料68件を `skills/pstack/` に別バンドルとして置いています。各バンドルは自前の `manifest.json` とSHA-256で検証します。

| 選択条件 | 注入するスキル |
| --- | --- |
| スキル適用時の入口 | `kiokuko-soul` |
| コードの実装・修正 | `coding-ideal-routine-skill`、`one-shot-software-completion`、`kiokuko-single-purpose-functions` |
| 調査・設計・レビュー | `kiokuko-investigate`、`kiokuko-architecture`、`kiokuko-review` |
| 性能・検証 | `kiokuko-benchmark`、`kiokuko-verification` |
| 小さな変更・導入や状態の変更 | `kiokuko-simple-work`、`veteran-programmer-skill` |
| 毎ターン（依頼内容を問わず、任意の3件とは別枠） | `kiokuko-ui-design-soul` |
| スキル・技術文書の作成 | `kiokuko-skill-authoring`、`kiokuko-technical-writing` |
| 記憶・Lisp | `memory-reasoning`、`kiokuko-lisp` |
| 日本語の依頼、またはJapanese指定 | `natural-japanese-output` |
| `pstack`・`poteto-mode` の指定、またはこの作業規律で進める指示 | `pstack` |
| `/pstack on` を実行した後（依頼文を問わず） | `pstack` |

日本語・英語のキーワード一致で選び、`$kiokuko-review` のような明示指定を優先します。意味を理解する分類器ではなく、否定や引用も意味解析しません。任意の専門スキルは最大3件で、SOUL・コーディングの共通手順・日本語出力は別枠です。合計の注入上限は48 KiBです。旧12 KiB制限では実際の共通手順さえ収まらないため変更しています。利用者の実際の依頼・既存の上位指示・ツール承認が常に優先されます。

スキル内で著者が `kiokuko:runtime` と指定した部分は全て保持し、`documentation` 部分だけを初期注入から除きます。未分類のスキルはfrontmatterを除いて全文を保持します。独自の要約で規則を削りません。

モデルは `list_skills` で18件の名前・説明・参照パスを確認し、`read_skill` で必要な本文・詳細資料を読みます。`resource` は一覧にある相対パスだけを受け付けます。長い本文には `nextLine` が返り、`startLine` に指定して続きを取得できます。組み込みworker/explorerにも両ツールを公開しています。独自の子プラグインは必要に応じて許可ツール一覧へ追加してください。

DSH固有の `kioku_*`、`lisp_*`、Akinator、Goal、lease、`coding_workflow`、`task_completion` はMODKHにはありません。注入時・参照読み取り時にMODKHの適用規則を付け、存在しないAPIの呼び出し・導入・完了待ちを禁止し、実際のMODKHツールと承認に従わせます。Lispワーカーや自動記憶保存そのものを移植したという意味ではありません。

本文を途中で切ると制約が落ちるため、予算に入らない本文は丸ごと省略して通知します。一度の選択で本文が完全一致する場合は重複を除きます。通常のCLI会話では、選んだ手順をsystem入力に一度だけ載せ、同じ起動中は本文を固定します。次の依頼で新たに選んだ手順は上限内で追加します。本文はセッション履歴に保存せず、再起動後は選び直します。表示のbytesは注入テキストのUTF-8サイズであり、トークン数ではありません。

### プロジェクト固有のスキル

作業ルートの `.modkh/skills.json` に、既存の手順ファイルを登録できます。

```json
[
  {
    "name": "php-project",
    "description": "このプロジェクトのPHP実装手順",
    "keywords": ["PHP", "Laravel", "Eloquent"],
    "path": "docs/php-workflow.md"
  }
]
```

`PHPの処理を調査` などのキーワード一致、または `$php-project` の明示指定で本文を読みます。`description` は説明用で、選択には `keywords` を使用します。全本文の事前注入や自動ダウンロードは行いません。既存の `SKILL.md` もpathで指定できますが、本文全体をそのまま扱うため、実行手順だけの短いファイルを推奨します。

- 名前は英小文字で始まる英小文字・数字・ハイフン、最大64文字。重複・組み込み名の上書きは不可。
- 一覧は64 KiB・128件まで。keywordsは32件まで、各1〜80文字。descriptionは500文字まで。
- pathは作業ルート内の相対パス。範囲外へ解決されるシンボリックリンク、通常ファイルでないもの、12 KiBを超える本文は注入しません。
- 不正な一覧・読めない本文は通知して通常の作業を続けます。未選択の本文は読みません。
- `.modkh/` をgitignoreしている場合、一覧を共有するには明示的に管理対象にしてください。
- 埋め込み利用では `runAgentLoop` の `skills: false` で注入を無効化できます。

`.git` があるワークスペースでは、起動時に `.gitignore` の末尾へ `.modkh/` と `.agenticreplay/` が無ければ追加します。既存の行は書き換えず、揃っていれば何もしません。`.git` が無いディレクトリは変更しません。書けない場合は起動時に一度だけ理由を表示し、会話は続けます。

## ツール出力

AI SDK経由とChatGPT Responses経由の両方で、モデルに渡す投影だけを変更します。保存済みの原文・call ID・status・承認・再実行防止は変更しません。

1. 連続して同じ行が現れる出力は、文字列と回数のJSONへ可逆変換します。改行・順序・末尾文字列を保持し、説明を含めてもUTF-8サイズが小さくなるときだけ採用します。対象は1,024〜2,000,000 UTF-16コード単位です。
2. それでも1件16 KiBの枠を超える場合、原文の先頭と末尾を残し、中間省略を明示します。圧縮JSONを途中で切ることはしません。
3. 128 KiBの枠は保存されたツールメッセージごとに割り当てます。後続の結果を追加しても、すでに送信した結果の本文は変わりません。会話全体のサイズは履歴とともに増えます。

実プロバイダーのトークン数・キャッシュ・請求額の削減率は未測定です。文字数の削減率と料金の削減率は異なります。

`cache` の表示はプロバイダーが報告した値だけを使います。DeepSeek は `prompt_cache_hit_tokens` を報告するため、キャッシュ読取りは入力に含めた値として表示されます。

## プロバイダーのキャッシュを保つ入力の並び

DeepSeek などのプロバイダーは、直前のリクエストと先頭から一致する部分をキャッシュとして再利用します。一致は先頭から途切れるまでなので、変わらない内容を前に、ターンごとに変わる内容を後ろに置きます。

- system指示（基本方針と選択済みスキル）は起動中に固定し、毎回同じバイト列を送ります。
- 記憶の検索結果は、そのターンだけの参考データです。system の末尾に足すと、その位置から後ろの履歴全体がキャッシュミスになるため、最新の入力として末尾へ付け、セッション履歴には保存しません。
- ツール結果の投影は送信済みの本文を書き換えないため、履歴が伸びても既存部分の一致は保たれます。

計測例（DeepSeek のリクエスト本文を模した4ターン・各ターン5ステップ、ツール出力を含む約125万文字の送信）では、記憶を system に置くとキャッシュミス相当が23.1%、最新入力に置くと9.6%でした。文字数の比較であり、実プロバイダーの請求額やトークン数の削減率ではありません。

## 会話履歴の自動圧縮

通常のCLI会話では、直前の会話リクエストでプロバイダーが報告した入力トークン数が、選択中のモデルのコンテキスト長の75%に達すると、次の送信前に古い履歴を要約します。キャッシュ済みの入力も含みます。ツール呼び出し後も同じ条件で判定します。セッション累計、子エージェント、要約リクエストの使用量は加算しません。初回・再開直後・接続変更直後は最初の実測値を待ちます。次に追加する入力のトークン数は送信前には分からないため、大きな追加入力が上限を超えることはあります。

ChatGPTではローカルのCodexモデルカタログ、Google・Anthropicではモデル情報API、ローカルOllamaとLM Studioでは稼働中モデルの情報、OpenRouterなどの互換接続では接続先のモデル一覧から容量を取得します。容量を公開していない接続先では、`config.json` に `"modelContextWindows": {"compatible/my-model": 65536}` のようにトークン単位で指定できます。容量または入力トークン数が不明な間は自動圧縮を見送ります。

直近の履歴は `compactionKeepTurns`（既定6、1〜50）ターン残します。要約できる本文が送信本文の1/8に満たない場合は見送ります。要約に失敗した場合や短くならなかった場合は、要約対象がさらにその分増えるまで再試行を控えます。従来のバイト基準を明示的に使う場合は `compactionAutoBytes`（32 KiB〜8 MiBをバイト単位で指定）を設定します。この場合の1/8は設定したバイト数が基準です。0で自動圧縮を無効にできます。

元のメッセージとツール結果はセッションに残り、`--resume` 後も最後に保存した要約と直近の履歴をモデルへ渡します。固定応答モデル、Hermes Agent、子エージェントでは新たな自動圧縮を行いません。

## 参考実装と検証

[kiokuko-dsh](https://github.com/askdkc/kiokuko-dsh) のローカル参照コミット `795172935041acb29718860458a59501a98fd466` にある、目的別選択、実行手順と文書の分離、重複注入回避、可逆な反復文字列圧縮を参考にMODKHのループへ独立実装しました。KiokukoのDB・タスク状態・モデルによるスキル選択・意味的要約は移植していません。スキルセットは後続の修正で `88dac41e9f92d4638a214825b40e6967499be961` から同梱しました。`manifest.json` に全43ファイルのSHA-256を記録し、読み込み時とビルド時に検証します。MITライセンスも同梱しています。

pstackは `cursor/plugins` の `pstack` 0.15.46（コミット `792440e8a560a4a3f63748cdee70491ecd412982`、MIT、Copyright (c) 2026 Lauren Tan）をMODKH向けに移植しました。上流のモデルslug、slash command、Task tool、cloud agent、`/loop`、todolist、`agent-transcripts` は、MODKHのplugin ID、`subagents` 設定、`start_subagent`、`read_skill`、セッション記録に置き換えています。`skills/pstack/manifest.json` に69ファイルのSHA-256を記録します。`SKILL.md` は索引だけを持ち、原則24件・プレイブック20件・補助手順24件は `read_skill('pstack', 'references/<name>.md')` で必要時に読みます。

```sh
node --test test/bundled.skills.test.ts test/skills.context.test.ts test/context.efficiency.test.ts
npm run typecheck
npm run build
node scripts/verify-skill-package.mjs
npm test
```

2026-11-15の検証では、旧ループを隔離コピーに戻すとスキル注入テストが失敗することを確認しています。全体テストにはローカルHTTPサーバーとファイル監視を使うケースがあるため、それらを許可した環境での実行が必要です。

### 初回の確認結果（スキルセット同梱前）

対象はMODKH `7a93e8c731e4fcec190ee09986bedf1756412f11` を基点とする今回の変更です。

- `npm run typecheck`、`npm run build`、`git diff --check`: 成功。
- `node --test test/bundled.skills.test.ts test/skills.context.test.ts test/context.efficiency.test.ts test/agent.loop.test.ts test/subagents.service.test.ts`: 36件成功。
- `npm test`: 366件中308件成功、58件失敗。57件はローカルHTTP待受の `EPERM`、1件は `fs.watch` の `EMFILE`。追加のAI SDK送信形式テストは、その後の関連36件に含めて成功。HTTP結合テストは未検証。
- ビルド済み `dist/index.js` を一時的な作業ルート・専用の `MODKH_HOME`・`fixed/scripted` で実行し、`modkh-debug` 選択表示、README編集、コマンドのマーカー作成、終了コード0を確認。実プロバイダーによる課題解決能力の検証ではない。
- 隔離コピーで旧ループに戻すと注入テストが失敗。圧縮を無効にする変更、末尾を捨てる変更も、それぞれ回帰テストが検出。
- 合成反復ログは90,010 bytes → 176 bytes。これはこの入力のUTF-8サイズ比較に限定され、トークン・料金の測定ではない。

グローバルにインストール済みのMODKHの更新・動作確認、実プロバイダーへの通信は行っていません。

### スキルセット同梱後の確認結果

- 17スキル・26参照資料（計43ファイル）が移植元とバイト単位で一致。全ファイルのSHA-256検証とruntimeブロック抽出が成功。
- `npm run typecheck`、`npm run build`、`git diff --check`: 成功。
- `node --test test/bundled.skills.test.ts test/skills.context.test.ts test/context.efficiency.test.ts test/agent.loop.test.ts test/subagents.service.test.ts test/tools.guard.test.ts`: 53件成功。
- `npm test`: 373件中315件成功、58件失敗。ローカルHTTP待受の `EPERM` 57件、ファイル監視の `EMFILE` 1件。これらの結合検証は未完了。
- `node scripts/verify-skill-package.mjs`: npm packした配布物を一時ディレクトリへ展開し、別の作業ルートで実際の共通ループからコーディング手順・UI手順を注入、`read_skill` で参照資料を取得できた。隔離した配布物の本文を改変するとハッシュ検証が拒否することも確認。
- 先に追加したコーディング受け入れテストは、同梱・接続前には `missing kiokuko-soul` で失敗し、導入後に成功。
- 注入量の例: 英語のバグ修正29,772 bytes、日本語のUI修正38,379 bytes、Lispコード実装45,929 bytes。全17件の一括注入ではなく、必要な共通手順と専門手順を選択した結果。実トークン数・料金・実モデルが手順へ従う品質は未測定。
