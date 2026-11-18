# MoDKH

MoDKH（Mixture of DKH）は、Common Lispで専門エージェントを定義し、コードの調査・編集・検証を委譲できるコーディングハーネスです。

## インストール

Node.js（[対応バージョン](package.json)）とnpmを用意し、リポジトリのルートで実行します。

```sh
npm ci
npm run build
archive=$(npm pack --silent)
npm install -g "./$archive"
```

作業するプロジェクトで、初回起動前に言語サーバーを導入します。

```sh
modkh language install
modkh
```

初回起動後、`/connect` で接続先とモデルを選びます。

`agenticreplay version` が成功する環境では、[AgenticReplay](https://github.com/askdkc/AgenticReplay) がモデル API の通信をワークスペースの `.agenticreplay/runs/` に記録します。Ollama や LM Studio などの HTTP モデル API も対象です。HTTPS は AgenticReplay の既定ホストと、起動時に `--base-url` で指定したホストを記録します。記録を止めて起動するには `MODKH_AGENTICREPLAY=0 modkh` を使います。

通常の `modkh` で言語別のマイクロエージェントを使えます。複数言語をまたぐ依頼では、親モデルが調査を担当ごとに分けて委譲し、返ってきた結果をまとめます。`/agents` で利用できる担当を確認できます。

## 前鬼の形式検証（任意）

[Rust/Cargo](https://rust-lang.org/tools/install/)を導入してから実行します。Javaは不要です。

```sh
modkh stateright install
modkh stateright status
modkh
```

導入済みなら、通常起動で前鬼（`modkh-micro-zenki`）を自動登録します。親モデルは状態遷移・競合・不変条件の検証を前鬼に委譲します。`/agents` で確認できます。MoDKHを更新した際も `modkh stateright install` で検証器を更新できます。

検証対象は明示的な有限状態JSONモデルです。[モデルの書き方・導入先・制約](docs/stateright.md)を参照してください。

## ブラウザ検証（任意）

[browse](https://github.com/anomalyco/browse) を使うと、Chrome・Braveなどでページ表示、入力・クリック、スクリーンショット取得を行えます。PATH に実行可能な `browse` があれば、MoDKH は専用の `browse` ツールを登録します。接続状態の確認、HTTP(S) ページを開く、スナップショットの取得、クリック、フォーム入力は都度の許可なしで実行します。任意のスクリプトや管理コマンドには、従来どおり `run_command` の承認設定が適用されます。

```sh
npm install -g @opencode/browse
browse install --agent none
browse status --json
```

案内に従ってブラウザ拡張を導入・接続し、ブラウザを開いた状態で使います。`--agent none` は他のエージェントへのMCP登録を省く指定です。`status` の `extension.connected` が `true` なら接続済みです。`paired-offline` の場合は、拡張を導入したプロファイルを開き、拡張が有効か確認してください。

MoDKHには「browse CLIで `http://localhost:3000` を開き、画面操作とスクリーンショットで検証して」のように依頼します。操作方法は `browse --help` で確認できます。

[依存パッケージ](docs/setup.md) · [言語解析](docs/languages.md) · [Lispプリセット](docs/presets.md)
