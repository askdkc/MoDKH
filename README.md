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

ツールの実行状態をその場で記録するには、`MODKH_TOOL_RECORD_FILE=/絶対パス/tools.jsonl modkh` で起動します。既存のディレクトリにあるファイルへ追記し、ファイルがなければ作成します。各行にはセッション、ターン（開始メッセージの位置）、モデルへの接続試行、候補通番、call ID、状態、理由コードが入ります。コマンド開始後にプロセスが落ちた場合、最後の状態は `unknown` です。バックグラウンドジョブの受付と終了は同じジョブ ID で追えます。対応版の AgenticReplay は終了時にこの実行分だけを取り込みます。

## 前鬼・後鬼による形式検証（任意）

<img src="./enno-oduno.png" alt="役小角と前鬼・後鬼" width="150">

前鬼（Stateright）は有限状態モデルの反例を探し、後鬼（Lean）は定理の証明を検査します。前鬼を使うには、Rust と Cargo を用意して次を実行します。

```sh
modkh stateright install
modkh stateright status
modkh
```

## ガイド

- [モデルの接続とログイン](docs/models.md) · [画像・PDFを使った依頼](docs/input.md)
- [専門エージェントへの委譲](docs/subagents.md) · [Lisp プリセット](docs/presets.md)
- [OS 別のセットアップ](docs/setup.md) · [言語解析](docs/languages.md) · [前鬼による形式検証](docs/stateright.md)
- [脆弱性検査ツールのインストール](docs/features.md#cyber-用のツール任意)（Trivy、OSV-Scanner、Semgrep、Gitleaks、sqlmap、Nmap、Nuclei、Nikto）
- [追加機能と設定](docs/features.md)（通信記録、MCP サーバー、ブラウザ検証など）
