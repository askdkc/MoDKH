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
/reasoning high --save   # 推論レベルの変更・保存
/keys                    # 保存済みAPIキーの一覧 / /keys remove <provider>
```

モデル選択の先頭行は `🔍 キーワード検索` です。入力欄に打ち込むと絞り込まれ、空白区切りは語順を問いません（`seek deep` で deepseek が一致）。Enterで確定、↑↓で移動します。

Ollama Cloudの候補には deepseek-v4.1-flash や glm-5.3-flash などの代表的なモデルを同梱しています（`ollama.com/v1/models` の取得結果）。一覧は目安であり、利用可否は契約に依存します。一覧にないモデルは `/connect ollama-cloud/<model>` で直接指定できます。

Ollama Cloudのキーは[こちら](https://ollama.com/settings/keys)で作成できます。キーを保存したくない場合は環境変数（`OLLAMA_API_KEY` など）を使ってください。
## コマンド実行

`run_command` は1回ごとに新しいシェルで実行し、`[exit code: N]` と `--- stdout ---` / `--- stderr ---` を返します。

**終了コードが0以外でも実行結果として返ります。** `grep` が一致なしで1を返す、テストが落ちる、`git diff` が差分なしで0を返す — これらは失敗の報告ではなく、次を決めるための材料です。ツールエラーになるのは、起動失敗・シグナルによる停止・停止の確認不能だけです。

```jsonc
// 呼び出し例
{ "command": "node --test", "description": "run unit tests" }
```

- `cwd` は次の呼び出しに引き継がれません。`cd` ではなく `cwd` を指定します。
- `shell` で `bash` / `zsh` を選べます（既定は `sh`）。bash 固有の構文が必要なときだけ指定します。
- `timeoutMs` で制限時間を指定できます（既定120秒、上限600秒）。
- **制限時間に達してもコマンドは殺しません。** そのままバックグラウンドジョブへ移り、`job_id` が返ります。締め切りで作業を捨てないためです。制限時間を厳密な失敗として扱いたい場合は `run_in_background` を使わず、ジョブ機能のない構成で実行してください。
- 出力が上限を超えたときは**先頭と末尾の両方**を残します。末尾には失敗の理由が入ることが多いためです。
- Ctrl+C で中断した場合も、それまでの出力を添えて結果不明として報告します。

### バックグラウンド実行

`run_in_background: true` を付けると、コマンドの終了を待たずに `job_id` を返します。ビルドやテストの全体実行など、制限時間に収まらない見込みの処理で使います。

```jsonc
{ "command": "npm test", "description": "run the full suite", "run_in_background": true }
// → [job_id: bash-1a2b3c4d5e6f7a8b] [status: running]
```

| ツール | 用途 |
|---|---|
| `job_output` | 前回の読み取り以降に増えた出力だけを返す。`wait: true` で新しい出力か終了まで待つ |
| `job_list` | 実行中・終了済みのジョブ一覧 |
| `job_kill` | 停止する。停止を確認してから結果を返す |

バックグラウンドジョブに制限時間はありません。終了するか `job_kill` で止めるまで動きます。ジョブが終わると完了通知がモデルへ届くので、待たずに別の作業を進められます。CLI を終了すると動いているジョブは停止します。

前景で実行したコマンドが `timeoutMs` に達した場合も、同じ経路でジョブになります。締め切りで途中までの成果を捨てず、`job_id` から続きを読めます。

```jsonc
{ "command": "npm test", "timeoutMs": 300 }
// → [job_id: bash-…] [status: running]
//    制限時間(300ms)に達したためバックグラウンドジョブへ移した。コマンドは実行を続けている。
```

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

## Web検索と外部取得

`web_search` と `fetch_url` は外部ネットワークへの通信なので、**既定の承認ポリシーでは毎回確認**します（`/allow all` のときだけ自動）。

| ツール | 内容 | 必要なもの |
|---|---|---|
| `web_search` | Web検索を1回行い、タイトル・URL・要約を最大10件返す | `BRAVE_SEARCH_API_KEY`（または `/connect brave-search` で保存したキー） |
| `fetch_url` | http/https のURLを1件取得し、HTMLは本文テキストにして返す | なし |

- 検索語とURLは外部サービスへ送られます。承認画面に送信内容が出るので、送る前に確認してください。
- `fetch_url` は**転送のたびに**承認を求めます。転送先は人間が承認したURLとは別の場所になり得るためです。
- 本文は既定512 KiBで受信を打ち切り、表示は32 KiBまでにします。打ち切った場合は結果に明示します。
- `http`/`https` 以外と、URLに資格情報を埋めた指定は拒否します。
- 取得結果は事実の保証ではありません。内容の真偽は検証しません。
- どちらも読み取り専用として扱い、編集もワークスペースの変更もしません。

## 画面の使い方

出力は端末の通常スクリーンバッファに流し込む(代替スクリーンは使わない)。完成した行は一度だけ描き、その後は端末のスクロールバックに確定するため、マウスホイールやスクロールで**全履歴を辿れる**。入力欄・状態行は画面最下部で更新されるだけなので、過去の出力は消えない。

モデルの推論(プロバイダーが返したもの)は `(推論)` の見出し付きで表示し、応答やツール要求に移るときに本文へ流し込む。推論は表示専用で、会話の本文には混ぜない。

推論ブロック・diff(`+`/`-`/`@@`)・コードブロック(```で囲まれた部分)・ユーザー行などは色分けして表示する。端末の背景色を OSC 11 で問い合わせ、ダーク/ライトそれぞれで読みやすいパレットを選ぶ(応答が得られない場合はダーク想定、`NO_COLOR` で色自体を無効化)。

セッションごとの実行記録(会話・ツール実行・状態)は、作業ルートの `.dkh/sessions/<id>.md` に人間が読める形で保存する。ワークスペースにコミットしたくない場合は `.gitignore` に `.dkh/` を追加する(このリポジトリには追加済み)。

## 推論レベル

`/reasoning` でモデルの推論レベルを変えられる。

```text
/reasoning                  # 現在のレベル表示
/reasoning low|medium|high|minimal|off  # 次の送信から適用
/reasoning high --save      # config.json に保存し、次回起動時からも使う
```

- OpenAI系と openai互換系(ollama / openrouter / `compatible` など)は `reasoning_effort` として送る。
- Anthropic は thinking バジェット(low=2048 / medium=8192 / high=16384)、Google は `thinkingBudget` に変換する。
- ChatGPT(Responses)は `reasoning.effort` に渡す。deepseek と fixed はレベルの指定に対応しない。
- 対応していないレベル・プロバイダーではパラメーターを送らない(プロバイダーの既定に任せる)。

`off` は openai 互換系ではパラメーター自体を送らない。Google だけ `thinkingBudget: 0` で停止を明示する。

## 前回のモデルとタイムアウト

- `/connect` で接続したモデルは `~/.config/dkh/config.json` に記録され、次回起動時に**そのまま復元**される。`--base-url` を使った接続(s compatible/xxx など)は URL も覚える。復元できない場合(キーが無いなど)は未接続で開き、その理由を表示する。
- モデル応答のタイムアウトは**無通信時間**で測る(既定600秒)。生成が長くても返信が続いている限り止まらない。config.json の `timeoutMs`(5000〜1800000の整数)で調整できる。

```json
{ "timeoutMs": 900000 }
```

## 1回の指示での往復上限

1つの指示に対してツールを何度も呼べます。既定の上限は500往復で、通常の長い作業は収まりません。これは暴走を止めるための安全弁です。

上限に達しても作業内容と結果はセッションに残るため、同じセッションで続きを指示できます。上限を変えるには `~/.config/dkh/config.json` に `maxTurns` を書きます（1〜10000、`DKH_HOME` 指定時はその配下）。

```json
{ "maxTurns": 1000 }
```

子への調査・実装の委譲は `/agents`。追加方法と制限は[サブエージェント](<docs/subagents.md>)を参照してください。
複数行入力とMacの画像貼り付けは[入力ガイド](<docs/input.md>)を参照してください。
LSP・tree-sitterによる構造解析と編集後の診断は自動で行われます。対応状況と設定は[言語解析](<docs/languages.md>)を参照してください。
Web検索と外部URLの取得は[Web検索](<docs/web.md>)を参照してください。
