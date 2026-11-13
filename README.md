# dkh

単独で動く最小コーディングハーネス CLI

- Node.js >= 24.16 / TypeScript
- プラグイン基盤も Web UI も持たない
- 外部サービスの API キーは環境変数から読む。失敗しても別の接続先へ自動で切り替えない

## インストール

```sh
npm pack
npm install -g ./dkh-0.1.0.tgz   # または tarball を隔離環境に導入
```

## 使い方

モデル指定なしで起動すると、opencode のようにハーネスが開いて未接続で待つ。
接続は対話中の `/connect` で行う:

```sh
dkh                                           # ハーネスを開始(未接続)。/connect で接続
dkh chat --model fixed/scripted --cwd <dir>   # 固定応答モデル(オフライン検証用)
dkh chat --model openai/gpt-5.2 --cwd <dir>   # OPENAI_API_KEY が必要
dkh chat --model compatible/<model> --base-url http://localhost:1234/v1 --cwd <dir>
dkh chat --resume <session-id> --cwd <dir>    # 中断した会話を再開
dkh auth login chatgpt                        # Sign in with ChatGPT
dkh session list
```

対話中:

```text
/connect <provider>/<model> [--base-url <url>]   # その場でモデルを接続(AI API / chatgpt / fixed)
/connect                                      # 接続状態と認証メニューを表示
/connect chatgpt                              # 起動したままブラウザで ChatGPT 認証
/models [検索語]                              # モデル名を部分一致検索し、番号で選択
```

`/connect` → `1` (または `chatgpt`) で表示される URL をブラウザで開いて認証します。
認証後は `/models chatgpt` でモデルを選択できます。未認証の ChatGPT モデルを
直接指定した場合も認証を開始します。API キー方式は従来どおり環境変数を使います。

`/models` は大文字小文字を区別しない部分一致検索です。空白区切りで複数語を指定できます。
一覧内で検索語を入力すると再検索、番号で接続、`*` で全候補、空行・`/cancel` で戻ります。
一覧は組み込みの候補であり、利用可能なモデルの完全な一覧ではありません。
一覧外は `/connect <provider>/<model>` で指定してください。
接続に失敗しても以前の接続を維持し、メニュー操作は会話履歴に記録しません。

モデル接続先:

| 参照 | アダプター | 必要なもの |
| --- | --- | --- |
| `fixed/scripted` | 固定応答(スクリプト) | なし |
| `openai/`・`anthropic/`・`google/`・`deepseek/<model>` | AI SDK | 各社の API キー(環境変数) |
| `openrouter/`・`groq/`・`xai/`・`ollama/`・`lmstudio/<model>` | OpenAI互換 | API キーまたはローカルサーバ |
| `compatible/<model> --base-url <url>` | OpenAI互換 | 任意の OpenAI 互換 URL |
| `chatgpt/<model>` | OpenAI 公開 Responses API | `/connect chatgpt` または `auth login chatgpt` |

端末での操作:

- 会話は `> ` プロンプトに入力する。`/exit` で終了
- 未接続のままメッセージを送ると、実行せずに `/connect` の案内を出す。
  接続はセッション内のみ有効(設定ファイルには書かない)
- 編集・コマンド実行は 1 件ずつ差分(またはコマンド)を表示して承認を求める。`y` で実行、それ以外は拒否
- Ctrl+C(1 回目)でモデル通信・子プロセス・以降のツールを中断し、セッションを保存する。
  再開(`--resume`)すると、結果不明のツールは自動では再実行しない旨を表示する

## 設定

`$DKH_HOME/config.json`(既定: `~/.config/dkh/config.json`):

```json
{
  "memory": {
    "enabled": false,
    "command": "kiokuko",
    "args": ["mcp", "--profile", "chatgpt-memory"]
  }
}
```

メモリを有効にすると、各依頼の前に読み取り許可のあるグローバル記憶を検索し、
今回のモデル入力だけに参考データとして渡す。記憶は命令や権限ではなく、現在のソースとの照合が必要。
取得の待機予算は1.5秒(子プロセスの回収時間は別)。利用不可・タイムアウトを表示して本作業を続ける。
元の依頼・ツール結果は残し、過去の参考記憶を会話メッセージへ積み増さない。

応答終了後の「メモリ保存の提案」は任意。承認した提案そのものだけを `memory_capture` で保存する。
本作業の履歴・状態は先に保存される。Stop後は新しい承認や保存を開始しない。
保存送信後の切断・タイムアウトは `unknown` (結果不明)であり、未保存とは断定せず自動再送しない。
JSONLの `memory` イベントは `retrieved`・`supplied`・`unavailable`・`capture` を区別する。
`supplied` はアダプターへの入力を示すだけで、外部モデルの受信や判断への正しい適用を保証しない。

## セッションと保存先

- セッションは JSONL で `$DKH_HOME/sessions/`(既定: `~/.config/dkh/sessions/`)に保存
- ヘッダ・状態・メッセージを 1 行 1 イベントで追記し、`--resume` で再構築する
- 要求を副作用の前、各結果を次の副作用の前に追記・flushする。異常終了で結果が残らなければ再開時に `unknown` とする
- `not-executed` (未実行確認済み)、`unknown` (副作用不明)、`error` (観測した失敗)、`ok` (ツール終了)を区別する
- 同じcall IDの再提示は保存結果を返し、内容が異なれば拒否する。結果不明の操作は新IDでも同じツール名・引数なら再送しない。読み取り専用ツールは新IDで再確認できる
- 結果不明の操作はまずファイルやプロセスの現状を確認する。同一操作の再実行が必要と判断した場合は、確認結果を残して新規セッションで明示的に依頼する。別表現のコマンドが同じ副作用かどうかまでは自動判定しない
- 別の作業ルートへの再開は拒否する。同じセッションを複数CLIから同時に再開する運用は未対応
- `complete` はモデル応答の終了であり、目標達成の検証結果ではない。エラー・ターン上限・中断をEOFで完了へ変えない
- モデルの途中EOF・上限終了を成功扱いにせず、部分テキストを保存する。モデル送信の暗黙リトライは無効
- 承認待ちのStopは当該入力待ちだけを取り消す。次の指示は保持する。編集は承認後にもStop・対象変更を確認する

`run_command` はPOSIXの専用process groupを所有し、Stop時は通常の子孫も停止する。
シェル終了後に子が残っていても成功にせず、停止・結果不明として扱う。
これはOS sandboxではない。意図的なdaemon化や別groupへの離脱は管理対象外で、実行しないこと。
コマンドの非zero・signal終了、出力打ち切りを明示する。
シェル全体の終了コードはpipeline各段の成功やテスト成功の証明ではない。

## 検証

```sh
npm run build    # tsc ビルド(dist/ 生成)
npm test         # node --test によるオフライン回帰テスト
sh scripts/acceptance.sh   # tarball を隔離環境へ導入しての受け入れ確認
```

CI は `.github/workflows/ci.yml` で macOS arm64 と Linux x64 の両方で同じ手順を実行する。
配布物でもStop後の次指示、エラー状態、記憶の入力到達と障害分離を検証する。

## 評価軸と確認範囲

- 補助障害の待機: `memory.elapsedMs` とCLIの停止しない回帰テストで確認する
- 指示の再入力: 元の入力を保持し、承認待ちStop後の次指示が一度だけ保存・送信されることを実CLIで確認する
- Stop後の副作用・重複実行: 子孫停止、承認後のStop、同じID／新IDでの結果不明再送を回帰テストで確認する
- 完了の誤認: EOF、signal、非zero、モデル上限、保存結果不明を成功としない反例をテストする
- 記憶の到達: 偽MCP→実CLI→互換HTTPサーバの入力を検査する。誤りを防いだ割合は実タスクの独立評価が必要で、未測定

回帰テストの成功は実運用の事故率ゼロを意味しない。全ユーザーの確認回数や目標達成率を自動集計する機能は追加していない。

## 未検証の範囲

- 実モデルAPIとChatGPTの実OAuth、実Kiokuko MCPは未検証。偽サーバを使う境界・CLIテストで代替している
- 記憶が実際の判断で同じ誤りを防ぐ割合、長時間運用、複数CLIによる同時再開は未検証
- 意図的にprocess groupを離脱したdaemonは停止保証の対象外。OS全体を隔離するsandboxではない
