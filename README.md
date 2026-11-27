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

起動したら `/connect` で接続先とモデルを選び、作業を依頼します。

> テストが失敗する原因を調べて、修正後にテストを実行して。

`/agents` で利用できる専門エージェントを確認できます。

AgenticReplay を導入している環境では、モデル API の通信が記録されます。記録を止めて起動するには `MODKH_AGENTICREPLAY=0 modkh` を使います。

## ガイド

- [モデルの接続とログイン](docs/models.md) · [画像・PDFを使った依頼](docs/input.md)
- [専門エージェントへの委譲](docs/subagents.md) · [Lisp プリセット](docs/presets.md)
- [OS 別のセットアップ](docs/setup.md) · [言語解析](docs/languages.md) · [前鬼による形式検証](docs/stateright.md)
- [追加機能と設定](docs/features.md)（通信記録、MCP サーバー、ブラウザ検証など）
