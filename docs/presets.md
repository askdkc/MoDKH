# Lispプリセット

引数なしの `modkh` には、PHP・Common Lisp・JavaScript・TypeScript・Svelte・HTML・CSS・Tailwind CSS の調査担当が組み込まれています。親モデルが依頼を分割して順に委譲し、結果をまとめます。たとえば、対応するモデルに接続して「`src/client.ts` と `src/server.js` の構造を調べ、共通点をまとめて」と依頼できます。担当は `/agents` に `modkh-micro-` で始まる名前で表示されます。

組み込み担当を登録するために SBCL は不要です。診断や参照検索などには言語別の機能が必要です。以下の Lisp プリセットは、担当を独自に編成したり、検証付き編集を設定したりする場合に使います。

[プリセット一覧](../experiments/presets/)から使う言語のファイルを選びます。SBCLを用意し、ファイルを置いたプロジェクトで実行します。以下はリポジトリのルートでTypeScript用を使う例です。

```sh
less experiments/presets/ts.lisp
shasum -a 256 experiments/presets/ts.lisp
modkh chat --lisp-config experiments/presets/ts.lisp --trust-lisp-sha256 REVIEWED_SHA256
```

Lispファイルはコードとして実行されます。内容を確認し、表示されたSHA-256を `REVIEWED_SHA256` に入れます。ファイルを変更したら確認とハッシュ計算をやり直します。

チャットで `/agents` を開くと担当を確認できます。たとえば `/agents route ts outline Inspect src/index.ts` で構造調査を委譲できます。

## 役小角・前鬼・後鬼と作業を始める

複数言語の調査も役小角に委譲させる場合は、[言語別の担当一覧](../experiments/presets/language-microagents.lisp)を `formal.lisp` と同じ設定にまとめます。次の例はリポジトリのルートで実行します。

```sh
cat experiments/presets/formal.lisp experiments/presets/language-microagents.lisp > agents-with-languages.lisp
shasum -a 256 agents-with-languages.lisp
```

内容を確認し、起動例の `--lisp-config` に `agents-with-languages.lisp`、`--trust-lisp-sha256` にその SHA-256 を指定します。役小角は言語、作業種別、ツールの一覧から `micro-ts-outline` などを直接選べます。子には対象ファイルを一つ渡し、定義・参照・ホバーには対象位置も添えます。各調査担当は専用ツール一つで、結果と位置を返します。言語別に編集を委譲する場合は、対象と保護テストを設定した編集担当を追加してください。

TypeScript・JavaScript・PHP・HTML・CSSの構文検索には、`micro-ts-syntax-search` などの担当を使えます。ファイルと宣言名を渡すと、Tree-sitterが候補の宣言全体の範囲を返します。役小角はこの範囲を編集担当に引き継げます。編集担当は現行ソースを読み取ってから変更を適用します。

`formal.lisp` を同じ手順で確認し、そのファイルの SHA-256 を指定して起動します。

```sh
modkh chat --lisp-config experiments/presets/formal.lisp --trust-lisp-sha256 REVIEWED_SHA256 \
  --java /path/to/java --tla-jar /path/to/tla2tools.jar --lean /path/to/lean \
  --lean-contract Expected.lean --lean-theorem orders_cancel
```

通常チャットでは、MoA の親エージェントが **役小角（`enno-oduno`）** を担います。役小角は依頼を検証できる単位に分け、担当ごとの作業と確認条件を `run_subagent` の `task` に、全体の目的と関係する依存関係を `context` に渡します。委譲ごとに結果を受け取ってから次の担当に進みます。前鬼（`micro-zenki`）には `formalInput.path` と `formalInput.config` で TLA+ のモデルと設定を、後鬼（`micro-goki`）には `formalInput.path` で証明元の Lean ファイルを指定します。ホストは指定されたパスで各担当の検証ツールを一度実行します。起動時の `--lean-contract` と `--lean-theorem` は対象定理の照合に使います。後鬼から命題不一致が返れば、その条件は不合格として記録します。役小角は両者のツール結果と実装の受け入れ結果を元の依頼に照らして確認します。

`formal.lisp` に登録されているのは検証担当です。実装の編集も委譲する場合は、確認済みの同じ Lisp ファイルに編集担当と [検証コマンド・対象ファイルの設定](modkh.md#one-file-edit-and-independent-acceptance)を加え、SHA-256 を取り直してください。

`(require-head-checks)` を含む正式プリセットでは、修正や実装を依頼したターンを終える前に、ホストがそのターンの検証記録を確認します。結果が不足していれば、同じターンで役小角に確認を続けさせます。Lean の命題不一致は形式検証の不合格です。不合格が確定すると、ホストはそのターンの追加のツール呼び出しを止めます。同じセッションの次の依頼は、次のターンで得た検証記録で判定します。

プロジェクト固有の入力が決まっている場合は、信頼する Lisp 設定に次のように書くと、役小角が応答を終えようとした時点でホストが不足している検証を補えます。

```lisp
(set-head-check-inputs "Orders.tla" "Orders.cfg" "Orders.lean")
```

第4引数に編集担当の ID を指定すると、その担当に登録された1つのソースの編集・反映も完了条件に加わります。ホストが補う処理にも通常の委譲、承認、受け入れチェックが適用されます。設定を変更したら SHA-256 を取り直してください。

編集担当を設定した実装依頼で、役小角の応答が委譲前に出力上限 `length` に達した場合、ホストは設定済みソースの先頭60行を読み、同じチャットターンを一度続けます。復帰直後の応答では、指定編集担当への `run_subagent` 一件だけを受け付けます。途中で切れた応答は実行記録に残します。その応答にツール要求が含まれていた場合は、実行せずにターンをエラーで終えます。編集担当から `EDIT_TURN_LIMIT` が届いた場合は編集不合格が確定します。

`(set-head-instruction "...")` は、信頼済みの Lisp 設定から親エージェントの進め方を指定します。指定した進め方が、標準の委譲手順とターンごとの汎用スキル指示に代わります。この設定があるセッションでは、`--routing auto` を指定していても通常のチャット入力は親を通ります。`/agents run` などで担当を明示した場合は、その担当を直接呼び出します。

## どんなときに役立つか

定義や参照の検索、診断などを専用ツール付きの担当に切り出せます。対応する言語サーバーが必要な操作もあります。編集は対象ファイルと固定の検証コマンドを設定したときだけ有効になります。通常のチャットと比べた速度やトークン消費の改善幅は未計測です。

[編集・検証の設定](modkh.md) · [言語解析](languages.md)
