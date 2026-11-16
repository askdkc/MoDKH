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

[依存パッケージ](docs/setup.md) · [言語解析](docs/languages.md) · [Lispプリセット](docs/presets.md)
