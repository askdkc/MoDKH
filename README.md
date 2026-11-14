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
APIキーは環境変数で設定できます。`/connect` で入力したキーは `~/.config/dkh/keys.json`（`DKH_HOME` 指定時はその配下）に保存し、次回以降は入力不要です。ファイルは本人だけが読める権限で作り、環境変数が設定されていればそちらを優先します。保存したキーの一覧と削除は `/keys` で行えます。

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
/models                  # モデル候補を検索（語順自由）
/keys                    # 保存済みAPIキーの一覧 / /keys remove <provider>
```

モデル選択の先頭行は `🔍 キーワード検索` です。入力欄に打ち込むと絞り込まれ、空白区切りは語順を問いません（`seek deep` で deepseek が一致）。Enterで確定、↑↓で移動します。

Ollama Cloudの候補には deepseek-v4.1-flash や glm-5.3-flash などの代表的なモデルを同梱しています（`ollama.com/v1/models` の取得結果）。一覧は目安であり、利用可否は契約に依存します。一覧にないモデルは `/connect ollama-cloud/<model>` で直接指定できます。

Ollama Cloudのキーは[こちら](https://ollama.com/settings/keys)で作成できます。キーを保存したくない場合は環境変数（`OLLAMA_API_KEY` など）を使ってください。
## 承認ポリシー

既定では、ワークスペース内のコマンド実行と編集は確認なしで実行します。ワークスペースの外に出る操作だけ確認します。実行した内容は `(自動承認: command — …)` のように記録に残ります。

```text
/allow           # 現在の設定を表示
/allow all       # すべて確認なし
/allow workspace # ワークスペース内のみ確認なし（既定）
/allow none      # 読み取り以外は毎回確認
/allow all --save  # 末尾に --save で次回以降も維持
```

`~/.config/dkh/config.json` の `permissions` でも設定できます（`DKH_HOME` 指定時はその配下）。設定値が不正な場合は `workspace` に戻し、その旨を表示します。

**これは承認を求めるかどうかの設定で、OSレベルの隔離ではありません。** `all` でもコマンドは通常のユーザー権限で動きます。停止（Ctrl+C）はどの設定でも有効です。

Hermes Agentはサーバー側でツールを実行するため、DKHの個別承認・Stopの保証対象外です。

その他の接続先やURLの変更方法は[プロバイダー設定の詳細](<docs/models.md>)を参照してください。

子への調査・実装の委譲は `/agents`。追加方法と制限は[サブエージェント](<docs/subagents.md>)を参照してください。
複数行入力とMacの画像貼り付けは[入力ガイド](<docs/input.md>)を参照してください。
LSP・tree-sitterによる構造解析と編集後の診断は自動で行われます。対応状況と設定は[言語解析](<docs/languages.md>)を参照してください。
