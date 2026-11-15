# モデル接続と ChatGPT ログイン

## モデル参照と選択画面

`dkh` を起動し、`/connect` で OpenAI / OpenCode / Ollama Local / Ollama Cloud / OpenRouter / Infron / Hermes Agent を選ぶ。
TTYでは入力で検索、↑↓で選択、Enterで決定、Escで戻る。OpenAIではChatGPT OAuthとAPIキーを選べる。
APIキーは環境変数を優先し、未設定ならTTYで伏せ字入力できる。入力したキーは `keys.json`(0600)に保存し、次回起動時に再利用する。
`/models` は組み込み候補からの選択であり、利用可能なモデルの完全な一覧ではない。

`chat --model <provider>/<model>`、または `/connect <provider>/<model> [--base-url <url>]` で直接指定もできる。
接続に失敗しても別の接続先へ自動で切り替えない。モデルの選択だけではAPI到達や利用権限は検証されない。

## 選んだモデルの保存と次回起動

`/connect` や `/models` で接続したモデル(と `--base-url`)は `config.json` に保存され、次回の起動はそのモデルで開く。
`--model` を渡したときはそちらが優先。`--resume` はセッション自身の接続を最優先する。`fixed/*` は検証専用なので保存しない。

復元には認証情報も要る。TTYで入力したAPIキーは `keys.json`(0600)に保存され、次回起動時に自動で読まれる。
環境変数だけで接続した場合はキーが保存されないため、その環境変数を外した状態で起動すると復元できない。
そのときは「保存済みキーが無い」と表示するので、`/connect <provider>` で1度キーを保存すれば以降は自動で復元される。

`config.json` は一時ファイルに書いてから置き換えるため、強制終了で途中まで書かれた状態を残さない。
万一JSONが壊れていても `model` など復元に必要な値は読み取り、壊れた内容は `config.json.broken` に退避する。
手書きした未知のキーは保存時に保持される。

| Provider | 認証 | 既定URL・設定 |
| --- | --- | --- |
| `openai` | `OPENAI_API_KEY` | OpenAI API |
| `opencode` | `OPENCODE_API_KEY` | `https://opencode.ai/inference/openai/v1` / `OPENCODE_BASE_URL` |
| `ollama`（Local） | 不要 | `http://127.0.0.1:11434/v1` / `OLLAMA_BASE_URL` |
| `ollama-cloud` | `OLLAMA_API_KEY` | `https://ollama.com/v1` / `OLLAMA_CLOUD_BASE_URL` |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `infron` | `INFRON_API_KEY` | `https://llm.onerouter.pro/v1` / `INFRON_BASE_URL` |
| `hermes` | `HERMES_API_KEY` | `http://127.0.0.1:8642/v1` / `HERMES_BASE_URL` |
| `chatgpt` | ChatGPT OAuth | `https://chatgpt.com/backend-api/codex/responses` |

既存の `anthropic` / `google` / `deepseek` / `groq` / `xai` / `lmstudio` も直接指定と `/models` から利用できる。
`compatible/<model> --base-url <url>` は任意のOpenAI互換API、`fixed/scripted` はオフライン検証専用。

HermesはモデルAPIではなく、サーバー側でツールを実行する別エージェント。
Hermes側の `API_SERVER_KEY` をDKHの `HERMES_API_KEY` に指定する。
DKHの個別承認やStopでリモートの副作用を制御・停止できる保証はないため、接続時に確認画面を出す。

## Ollama Local / Cloud

`/connect` には **Ollama Local** と **Ollama Cloud** を別々に表示する。
ローカルは従来どおり `/connect ollama`。クラウドは `/connect ollama-cloud` でキーとモデルを選ぶ。
`/models ollama-cloud/` でもクラウド候補に絞り込める。

クラウドの組み込み候補は `gemma4:31b`、`gpt-oss:120b`、`gpt-oss:20b`。
一覧外は直接入力できる。候補は固定リストで、モデルの利用可否は送信時に確認する。
[公式の直接接続手順](https://docs.ollama.com/api/openai-compatibility)に従い、
`https://ollama.com/v1` と `OLLAMA_API_KEY` を使う。ローカルOllamaのインストール・サインインは不要。
直接APIでは `:cloud` 接尾辞を付けず、[API一覧のモデル名](https://ollama.com/api/tags)をそのまま使う。
`OLLAMA_BASE_URL` はLocalだけ、`OLLAMA_CLOUD_BASE_URL` はCloudだけに適用する。
Cloudのキー未設定・通信失敗時にLocalへ自動で切り替えない。

## Sign in with ChatGPT

```sh
dkh auth login chatgpt
# またはDKH内で /connect → OpenAI → ChatGPT
```

- PKCE (S256) とランダムなstateを使い、`https://auth.openai.com/oauth/authorize` で認証する。
- ローカルの `http://127.0.0.1:1455/auth/callback` を待ち受けてからブラウザを開く。
- 正しいパス・stateのコールバックだけを受理し、`/oauth/token` で一度だけ交換する。
- トークンを `$DKH_HOME/chatgpt-auth.json`（既定 `~/.config/dkh/`）へ0600で保存した後、ブラウザに成功を表示する。
- ポート使用中、認証拒否、交換エラーは端末に表示する。他プロセスは停止しない。Ctrl+Cで中止でき、コールバックサーバーも閉じる。
- ブラウザが自動で開かなければ表示URLを手動で開く。SSH・コンテナではコールバックへ到達できる構成が必要。
- 期限切れの認証は次の送信前に更新する。更新失敗時は `/connect chatgpt` で再認証する。モデル要求を自動再送しない。
- ChatGPT用トークンはCodex Responsesへ送信する。通常のOpenAI APIキー用エンドポイントとは分離する。
  `store: false`、フラットな `type: "function"` のツール定義を使う。

## 検証範囲と参照

実OAuthログインや有料モデルへのライブ送信は未検証。ローカルの偽HTTPサーバーで
PKCE・コールバック・交換・保存・キャンセル・ポート競合・期限切れ更新とCLI接続を検証する。
TTY入出力ストリームの統合テストに加え、`scripts/terminal-acceptance.py` は実PTYで操作する。
PTY権限のないサンドボックスでは後者を実行できない。

- [OpenAI CodexのOAuth実装](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)
- [OpenCode Console](https://opencode.ai/docs/console/models/)
- [Infron OpenAI-compatible API](https://infron.ai/docs/llm-apis/openai-compatible-api/overview)
- [Hermes Agent API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
