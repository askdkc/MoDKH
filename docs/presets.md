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

## 前鬼・後鬼と作業を始める

`formal.lisp` を同じ手順で確認し、そのファイルの SHA-256 を指定して起動します。

```sh
modkh chat --lisp-config experiments/presets/formal.lisp --trust-lisp-sha256 REVIEWED_SHA256 \
  --java /path/to/java --tla-jar /path/to/tla2tools.jar --lean /path/to/lean
```

チャットにコーディング依頼を入力すると、親エージェントが依頼を検証できる単位に分けます。前鬼には TLA+ のモデルと設定を、後鬼には Lean の入力と対象定理を割り当て、両者の実行記録と実装の受け入れ結果を突き合わせます。たとえば、対応する入力を用意したうえで「注文のキャンセル条件を変更したい。前鬼には `Orders.tla` と `Orders.cfg`、後鬼には `Orders.lean` を使って、まず変更範囲と確認項目を整理して」と依頼できます。

`formal.lisp` に登録されているのは検証担当です。実装の編集も委譲する場合は、確認済みの同じ Lisp ファイルに編集担当と [検証コマンド・対象ファイルの設定](modkh.md#one-file-edit-and-independent-acceptance)を加え、SHA-256 を取り直してください。

`(set-head-instruction "...")` は、信頼済みの Lisp 設定から親エージェントに進め方を渡します。この設定があるセッションでは、`--routing auto` を指定していても通常のチャット入力は親を通ります。`/agents run` などで担当を明示した場合は、その担当を直接呼び出します。

## どんなときに役立つか

定義や参照の検索、診断などを専用ツール付きの担当に切り出せます。対応する言語サーバーが必要な操作もあります。編集は対象ファイルと固定の検証コマンドを設定したときだけ有効になります。通常のチャットと比べた速度やトークン消費の改善幅は未計測です。

[編集・検証の設定](modkh.md) · [言語解析](languages.md)
