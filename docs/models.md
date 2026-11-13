# モデル接続と ChatGPT ログイン

## モデル参照

`chat --model <provider>/<model>`、または対話中の `/connect <provider>/<model> [--base-url <url>]` で `provider` を選ぶ。`/connect` は未接続で起動したハーネスに後から接続するためのコマンド。
モデルは明示的に指定する。接続に失敗しても別の接続先へ自動で切り替えない。

- `fixed/scripted`: 固定応答モデル。オフライン検証・受け入れ確認専用
- `openai|anthropic|google|deepseek/<model>`: AI SDK アダプター。
  API キーは `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `DEEPSEEK_API_KEY` から読む。未設定なら明示エラーで終了する
- `openrouter|groq|xai|ollama|lmstudio/<model>`: OpenAI 互換アダプター。
  既定のベース URL は各社の公開 URL。`OLLAMA_BASE_URL` / `LMSTUDIO_BASE_URL` で上書きできる
- `compatible/<model> --base-url <url>`: 任意の OpenAI 互換 URL
- `chatgpt/<model>`: OpenAI 公開 Responses API。事前に `auth login chatgpt` が必要

## Sign in with ChatGPT

```sh
dkh auth login chatgpt
```

- PKCE (S256) で `https://auth.openai.com` から認可コードを取得する
- ローカルの `http://localhost:1455` でコールバックを受け取り、`error` パラメータも扱う
- 取得したトークンは `$DKH_HOME/chatgpt-auth.json`(既定 `~/.config/dkh/`)
  にパーミッション 0600 で保存する(ハーネス専用の保存先。Claude Code 等とは共有しない)
- チャット時は公開 Responses API (`/v1/responses`) に `store: false` で接続し、
  ツールは `type: "function"` (`strict: false`) で宣伝する

実 OAuth フローのライブ検証は行っていない(外部認証が必要なため)。PKCE 生成、
コールバック待ち、トークン交換、Responses API の SSE 解析は偽サーバで単体検証済み。
