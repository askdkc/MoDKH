# DKH

## インストール

Node.js **24.16以上**が必要です。このリポジトリのディレクトリで実行します。

```sh
npm install
npm run build
npm pack
npm install -g ./dkh-0.1.0.tgz
dkh
```

## AIプロバイダーの設定

DKHを起動して `/connect` を入力し、プロバイダーとモデルを選びます。
APIキーは環境変数で設定可能です。端末上で/connectから入力して設定も可能です。入力したキーはそのセッション内だけで保持します。

| プロバイダー | 設定方法 |
| --- | --- |
| OpenAI | ChatGPTのブラウザ認証、または `OPENAI_API_KEY` |
| OpenCode | `OPENCODE_API_KEY` |
| Ollama Local | ローカルでOllamaを起動。既定は `http://127.0.0.1:11434/v1`。キー不要 |
| Ollama Cloud | `OLLAMA_API_KEY`。ローカルOllamaのインストールは不要 |
| OpenRouter | `OPENROUTER_API_KEY` |
| Infron | `INFRON_API_KEY` |
| Hermes Agent | APIサーバーを起動し、サーバー側の `API_SERVER_KEY` と同じ値を `HERMES_API_KEY` に設定 |

環境変数で設定する例：

```sh
export OLLAMA_API_KEY="your-api-key"
dkh
```

DKH内で直接選ぶこともできます。

```text
/connect openai          # ChatGPT認証 / APIキーを選択
/connect ollama          # ローカルのモデルを選択
/connect ollama-cloud    # クラウドのモデルを選択
/models                 # モデル候補を検索
```

Ollama Cloudのキーは[こちら](https://ollama.com/settings/keys)で作成できます。
Hermes Agentはサーバー側でツールを実行するため、DKHの個別承認・Stopの保証対象外です。

その他の接続先やURLの変更方法は[プロバイダー設定の詳細](<docs/models.md>)を参照してください。

子への調査・実装の委譲は `/agents`。追加方法と制限は[サブエージェント](<docs/subagents.md>)を参照してください。
複数行入力とMacの画像貼り付けは[入力ガイド](<docs/input.md>)を参照してください。
LSP・tree-sitterによる構造解析と編集後の診断は自動で行われます。対応状況と設定は[言語解析](<docs/languages.md>)を参照してください。
