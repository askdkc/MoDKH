# 目的別スキルとモデル入力の節約

通常のMODKHチャットとローカル子エージェントで自動的に有効です。追加のモデル呼び出し・パッケージ・Kiokuko接続は不要です。外部エージェントの内部プロンプトは対象外です。

## 目的別スキル

kiokuko-dshのスキル17件と参照資料を含む43ファイルを、原文のまま `skills/kiokuko-dsh/` に同梱しています。独自の短い `modkh-*` 代用品は廃止しました。

| 選択条件 | 注入するスキル |
| --- | --- |
| スキル適用時の入口 | `kiokuko-soul` |
| コードの実装・修正 | `coding-ideal-routine-skill`、`one-shot-software-completion`、`kiokuko-single-purpose-functions` |
| 調査・設計・レビュー | `kiokuko-investigate`、`kiokuko-architecture`、`kiokuko-review` |
| 性能・検証 | `kiokuko-benchmark`、`kiokuko-verification` |
| 小さな変更・導入や状態の変更 | `kiokuko-simple-work`、`veteran-programmer-skill` |
| UI | `kiokuko-ui-design-soul` |
| スキル・技術文書の作成 | `kiokuko-skill-authoring`、`kiokuko-technical-writing` |
| 記憶・Lisp | `memory-reasoning`、`kiokuko-lisp` |
| 日本語の依頼、またはJapanese指定 | `natural-japanese-output` |

日本語・英語のキーワード一致で選び、`$kiokuko-review` のような明示指定を優先します。意味を理解する分類器ではなく、否定や引用も意味解析しません。任意の専門スキルは最大3件で、SOUL・コーディングの共通手順・日本語出力は別枠です。合計の注入上限は48 KiBです。旧12 KiB制限では実際の共通手順さえ収まらないため変更しています。利用者の実際の依頼・既存の上位指示・ツール承認が常に優先されます。

スキル内で著者が `kiokuko:runtime` と指定した部分は全て保持し、`documentation` 部分だけを初期注入から除きます。未分類のスキルはfrontmatterを除いて全文を保持します。独自の要約で規則を削りません。

モデルは `list_skills` で17件の名前・説明・参照パスを確認し、`read_skill` で必要な本文・詳細資料を読みます。`resource` は一覧にある相対パスだけを受け付けます。長い本文には `nextLine` が返り、`startLine` に指定して続きを取得できます。組み込みworker/explorerにも両ツールを公開しています。独自の子プラグインは必要に応じて許可ツール一覧へ追加してください。

DSH固有の `kioku_*`、`lisp_*`、Akinator、Goal、lease、`coding_workflow`、`task_completion` はMODKHにはありません。注入時・参照読み取り時にMODKHの適用規則を付け、存在しないAPIの呼び出し・導入・完了待ちを禁止し、実際のMODKHツールと承認に従わせます。Lispワーカーや自動記憶保存そのものを移植したという意味ではありません。

本文を途中で切ると制約が落ちるため、予算に入らない本文は丸ごと省略して通知します。完全一致する本文も一度だけ注入します。手順は一つの依頼中では固定し、モデルに送るsystem入力にだけ追加します。セッション履歴へ書き込まないため、再開・ツール往復による蓄積を防ぎます。次の依頼では選び直し、ローカルファイルの更新も読み直します。表示のbytesは注入テキストのUTF-8サイズであり、トークン数ではありません。

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

## ツール出力

AI SDK経由とChatGPT Responses経由の両方で、モデルに渡す投影だけを変更します。保存済みの原文・call ID・status・承認・再実行防止は変更しません。

1. 連続して同じ行が現れる出力は、文字列と回数のJSONへ可逆変換します。改行・順序・末尾文字列を保持し、説明を含めてもUTF-8サイズが小さくなるときだけ採用します。対象は1,024〜2,000,000 UTF-16コード単位です。
2. それでも1件16 KiBの枠を超える場合、原文の先頭と末尾を残し、中間省略を明示します。圧縮JSONを途中で切ることはしません。
3. 既存の全体128 KiB枠は新しい結果から割り当てます。枠を使い切った古い結果にも省略通知が残るため、通知・APIの外枠を含む総リクエストが128 KiB以内になる保証ではありません。

一般的な会話の要約や自動削除は行いません。実プロバイダーのトークン数・キャッシュ・請求額の削減率は未測定です。可逆な文字数削減が、そのまま料金削減率になるとは限りません。

## 参考実装と検証

[kiokuko-dsh](https://github.com/askdkc/kiokuko-dsh) のローカル参照コミット `795172935041acb29718860458a59501a98fd466` にある、目的別選択、実行手順と文書の分離、重複注入回避、可逆な反復文字列圧縮を参考にMODKHのループへ独立実装しました。KiokukoのDB・タスク状態・モデルによるスキル選択・意味的要約は移植していません。スキルセットは後続の修正で `88dac41e9f92d4638a214825b40e6967499be961` から同梱しました。`manifest.json` に全43ファイルのSHA-256を記録し、読み込み時とビルド時に検証します。MITライセンスも同梱しています。

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
