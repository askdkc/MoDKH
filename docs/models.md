# モデル接続と ChatGPT ログイン

## モデル参照と選択画面

`modkh` を起動し、`/connect` で OpenAI / OpenCode Zen / OpenCode Go / Local LLM / Ollama Local / llama.cpp Local / Ollama Cloud / OpenRouter / Infron / Hermes Agent を選ぶ。
TTYでは入力で検索、↑↓で選択、Enterで決定、Escで戻る。OpenAIではChatGPT OAuthとAPIキーを選べる。
APIキーは環境変数を優先し、未設定ならTTYで伏せ字入力できる。入力したキーは `keys.json`(0600)に保存し、次回起動時に再利用する。
OpenAIのモデル一覧は選択画面を開くたびに公式から取得する。APIキーでは `https://api.openai.com/v1/models`、
Sign in with ChatGPT では `https://api.openai.com/v1/models` を使い、アカウントに返されたモデルIDを表示する。
`/models openai`、`/models chatgpt` でも再取得できる。取得中はCtrl+Cで中止でき、失敗時は理由を表示する。
古い固定リストや保存済み一覧へのフォールバックは行わない。再度開いて取得し直すか、モデルIDを直接指定できる。
`/models` では、保存済みのAPIキー・環境変数のAPIキー・ChatGPTのOAuth認証で使える接続先のモデルをまとめて選べる。
`/models <検索語>` で接続先をまたいで絞り込める。接続先の名前を指定すると、その一覧だけを取得する。
他のプロバイダーも同じ方針で、`/connect` と `/models` を開くたびに各プロバイダーの一覧APIから取得する。
AIプロバイダーはモデルの追加・廃止が多いため、組み込みの固定モデル一覧は持たない。
`fixed/scripted`(オフライン検証用)だけは取得元が無いため常に候補に出す。

`chat --model <provider>/<model>`、または `/connect <provider>/<model> [--base-url <url>]` で直接指定もできる。
接続に失敗しても別の接続先へ自動で切り替えない。モデルの選択だけではAPI到達や利用権限は検証されない。

起動時にAPIキーを渡すには `--apikey` を使う。たとえば次のコマンドで、Local LLM に接続できる。

```sh
modkh --model local-llm/my-model --base-url http://localhost:1234/v1 --apikey "$LOCAL_LLM_API_KEY"
```

`--apikey` は起動時の接続先で環境変数や保存済みキーより優先され、その起動中だけ有効になる。キーが不要な場合はオプションを省略する。

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
| `opencode` | `OPENCODE_API_KEY` | `https://opencode.ai/zen/v1` / `OPENCODE_BASE_URL` |
| `opencode-go` | `OPENCODE_API_KEY`(Zenと共通) | `https://opencode.ai/zen/go/v1` / `OPENCODE_GO_BASE_URL` |
| `local-llm` | 任意のAPIキー | `/connect local-llm` でベースURL（例 `http://localhost:1234/v1`）を入力 |
| `ollama`（Local） | 不要 | `http://127.0.0.1:11434/v1` / `OLLAMA_BASE_URL` |
| `llama-server`（Local） | 不要 | `http://127.0.0.1:8080/v1` / `LLAMA_SERVER_BASE_URL` |
| `ollama-cloud` | `OLLAMA_API_KEY` | `https://ollama.com/v1` / `OLLAMA_CLOUD_BASE_URL` |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `infron` | `INFRON_API_KEY` | `https://llm.onerouter.pro/v1` / `INFRON_BASE_URL` |
| `hermes` | `HERMES_API_KEY` | `http://127.0.0.1:8642/v1` / `HERMES_BASE_URL` |
| `chatgpt` | ChatGPT OAuth | `https://api.openai.com/v1/responses` |

既存の `anthropic` / `google` / `deepseek` / `groq` / `xai` / `lmstudio` も直接指定と `/models` から利用できる。
`compatible/<model> --base-url <url>` は任意のOpenAI互換API、`fixed/scripted` はオフライン検証専用。

HermesはモデルAPIではなく、サーバー側でツールを実行する別エージェント。
Hermes側の `API_SERVER_KEY` をMODKHの `HERMES_API_KEY` に指定する。
MODKHの個別承認やStopでリモートの副作用を制御・停止できる保証はないため、接続時に確認画面を出す。

Local LLM はOpenAI互換APIに接続する。APIキーが不要なら空欄のままEnterを押し、モデルを選ぶ。キーは接続先URLごとに保存され、同じURLに空欄で接続し直すと削除される。

## Ollama Local / Cloud

`/connect` には **Ollama Local** と **Ollama Cloud** を別々に表示する。
ローカルは従来どおり `/connect ollama`。クラウドは `/connect ollama-cloud` でキーとモデルを選ぶ。
`/models ollama-cloud` でもクラウド候補に絞り込める。

どちらの候補も固定値ではなく、`/v1/models` から取得した最新の一覧をそのまま並べる。
取得できなければ理由を表示し、モデルIDの直接入力を案内する。モデルの利用可否は送信時に確認する。
[公式の直接接続手順](https://docs.ollama.com/api/openai-compatibility)に従い、
`https://ollama.com/v1` と `OLLAMA_API_KEY` を使う。ローカルOllamaのインストール・サインインは不要。
直接APIでは `:cloud` 接尾辞を付けず、[API一覧のモデル名](https://ollama.com/api/tags)をそのまま使う。
`OLLAMA_BASE_URL` はLocalだけ、`OLLAMA_CLOUD_BASE_URL` はCloudだけに適用する。
Cloudのキー未設定・通信失敗時にLocalへ自動で切り替えない。

## llama.cpp Local とローカル推論の再送

`/connect` の **llama.cpp Local** は、利用者が起動した `llama-server` に接続する。
MODKH はモデルの取得・起動・ダウンロードを行わない。`modkh chat --model llama-server/<model>` に
`--base-url http://127.0.0.1:8080/v1` を添えて直接指定することもできる。

Ollama Local と llama.cpp Local では、受信した推論を次回の送信で同じ会話履歴の一部として返す。
ツール往復のたびにモデルが考え直さずに済むが、再送するフィールド名は接続先ごとに異なるため、
次の条件をすべて満たすときだけ有効にする。

- 接続先ホストが `localhost`・`127.0.0.1`・`[::1]` のいずれか
- 汎用 `compatible` ではなく `ollama` か `llama-server` のプリセット
- モデル名が `-cloud` / `:cloud` 系ではない

HTTPリダイレクトは追わない。`ollama-cloud` や外部URLへの上書きは対象外である。
推論の再送は、モデルとチャットテンプレートが対応している場合にだけ効果がある。
テンプレートが履歴の推論を無視すれば、通常のツール処理に戻るだけである。
記録(AgenticReplay)が有効な実行では、記録に2回目のコピーを残さないため再送しない。

## OpenCode Zen / Go

`/connect` には **OpenCode Zen** と **OpenCode Go** を別々に表示する。
どちらも同じ `OPENCODE_API_KEY` を使うため、片方で入力したキーがもう片方にも適用される
(保存名は `opencode` に寄せ、旧版が `opencode-go` で保存したキーも読み替える)。

| 接続先 | ベースURL | 差し替え用の環境変数 |
| --- | --- | --- |
| Zen | `https://opencode.ai/zen/v1` | `OPENCODE_BASE_URL` |
| Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_BASE_URL` |

Go は会話ごとの安定したセッションIDを要求し、無い場合は `400 MissingSessionID` を返す。
MODKHは `x-opencode-session` にプロセス単位のIDを、`user-agent` に `modkh/<version>` を付けて送る。
モデル一覧は両方とも `GET /models` から取得する(ZenとGoで内容は異なる)。

## Sign in with ChatGPT

```sh
modkh auth login chatgpt
# またはMODKH内で /connect → OpenAI → ChatGPT
```

ブラウザで MoDKH へのサインインと ChatGPT プランの利用を許可してください。端末にログイン成功が表示されたら、`/models chatgpt` でモデルを選べます。ブラウザが自動で開かない場合は端末の URL を使えます。コールバックには同じマシンの空きループバックポートを使います。

OpenAI の Sign in with ChatGPT DevKit がアプリ登録、ID トークンの検証、アクセストークンの更新を担当します。登録情報は `$MODKH_HOME/siwc/` に暗号化して保存し、暗号鍵は OS の資格情報ストアに保存します。Linux ではロック解除済みの Secret Service が必要です。

プラン利用の許可を得たリクエストは `https://api.openai.com/v1/responses` に送信し、`store: false` とストリーミングを使います。[公式 DevKit とライセンス](siwc/README.md)

## 検証範囲と参照

実OAuthログインや有料モデルへのライブ送信は未検証。ローカルの偽HTTPサーバーで
登録・コールバック・同意・保存・期限切れ更新と CLI 接続を検証する。
TTY入出力ストリームの統合テストに加え、`scripts/terminal-acceptance.py` は実PTYで操作する。
PTY権限のないサンドボックスでは後者を実行できない。

- [OpenAI Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)
- [OpenCode Console](https://opencode.ai/docs/console/models/)
- [Infron OpenAI-compatible API](https://infron.ai/docs/llm-apis/openai-compatible-api/overview)
- [Hermes Agent API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
