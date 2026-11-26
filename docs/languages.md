# 言語解析（LSP・tree-sitter）

MODKHは対象ファイルの言語を検出し、必要な解析器だけを準備して、読み取り・編集・調査に使います。利用者が毎回「LSPを使って」と指示したり、言語ごとにインストールする必要はありません。

## 自動で起きること

| 契機 | 実行内容 |
| --- | --- |
| 対象ファイルの初回 `read_file` | 言語検出、構文解析、言語サーバーの準備要求、構造と診断を本文に付記 |
| `create_file` / `edit_file` 成功後 | 新内容で再解析し、LSPへ同期して診断を取得 |
| `code_outline` など | 構文構造・定義・参照・ホバーを取得 |
| セッション終了 | 起動した言語サーバーをすべて停止 |

解析は**補助情報**です。解析が失敗・タイムアウトしても、読み取りや編集の成否は変わりません。編集が成功したあとに解析だけが失敗しても、二重編集はしません。

初期値では、同時に起動する言語サーバーは3台までです。上限を超えると最も長く使っていないサーバーを停止します。

## 対応状況

実サーバー・実WASMで起動と診断を確認したものだけを「実証済み」としています。実証していないものは未検証です。

| 対象 | 構文解析（WASM同梱） | 言語サーバー | 実証状況 |
| --- | --- | --- | --- |
| TypeScript / JavaScript / TSX | あり | typescript-language-server（自動導入） | 実証済み（型エラー検出・編集後の解消・再利用） |
| CSS | あり | vscode-css-language-server（自動導入） | 実証済み（構文エラー検出） |
| HTML | あり | vscode-html-language-server（自動導入） | 起動・診断取得は実証済み。不正HTMLを診断0件とする仕様は実測どおり |
| Python | あり | basedpyright（自動導入） | 起動・診断は未実証 |
| Rust / C / C++ | あり | rust-analyzer / clangd（既存実行ファイルのみ） | 起動・診断は未実証。toolchainが無い場合は意味解析を縮退 |
| Ruby / Swift / PHP | あり | ruby-lsp / sourcekit-lsp / PHPantom（既存実行ファイルのみ） | 未実証。SDKやgemが無い場合は縮退 |
| Svelte | **なし** | svelte-language-server（自動導入） | 文法WASMが未収録のため構文解析は縮退。意味解析は未実証 |
| Tailwind CSS | ホスト言語の文法 | @tailwindcss/language-server（自動導入） | 未実証 |
| Common Lisp | **なし** | CL-LSP（既存実行ファイルのみ） | 未実証。マクロ展開や評価は行わない |

Svelte・Common Lisp は文法WASMを同梱していないため、`code_outline` などは「対象外」と理由を返します。本文の読み書きは通常どおりできます。

## 導入と保存先

- 解析器は `MODKH_HOME`（既定は `~/.config/modkh`）配下の `language/` に置きます。対象プロジェクトの依存・lockfileは変更しません。
- npm系は専用prefixと専用キャッシュへ導入し、`--ignore-scripts` で導入時のコード実行を避けます。プロジェクトや利用者のnpmキャッシュは変更しません。
- npmレジストリへプロキシ経由でしか接続できない環境では、起動元のシェルで `MODKH_LANGUAGE_NPM_PROXY=http://proxy.example:8080` を設定できます。認証情報を含まない HTTP(S) のURLのみ受け付け、npmによる導入だけに渡します。独自のCAが必要なら、信頼するPEMを `MODKH_LANGUAGE_NPM_CA_FILE=/absolute/path/to/ca.pem` でnpmのみに指定します。TLS検証は無効にしません。通常のプロキシ環境変数・利用者のnpm設定・認証情報を自動継承することはありません。
- 導入先は一時領域に作り、検証後に原子的に公開します。同時導入はロックで排他します。
- 導入した版・取得元・検証時刻は `language/state.json` に記録します。毎起動時にlatestを取り直しません。
- 失敗はその言語だけの縮退です。記録した失敗を同じターンで無限に再試行しません。

### 操作コマンド

```sh
modkh language status            # 検出・導入状態・文法の有無
modkh language install           # すべての宣言済み言語を導入（手操作は通常不要）
modkh language install --detected # 検出した言語だけ
modkh language retry <id>        # 失敗記録を消して再試行
modkh language update            # 導入済みサーバーと文法を検証し直す
```

通常利用ではこれらは不要です。最初の読み取りで自動的に準備します。

## 設定

`config.json` の `language` で調整できます。不正な値は既定へ戻します。

```json
{
  "language": {
    "autoInstall": true,
    "disabled": ["ruby"],
    "installTimeoutMs": 180000,
    "requestTimeoutMs": 20000,
    "servers": {
      "python": { "command": "/opt/homebrew/bin/pyright-langserver", "args": ["--stdio"] }
    }
  }
}
```

- `autoInstall: false` にすると自動導入しません。既存サーバーだけを使います。
- `servers` は言語ごとの明示指定です。指定した実行ファイルを優先します。
- `disabled` の言語は解析しません（本文操作は可能）。

## ツール

`search_files` は文字列検索として残ります。シンボル調査では次を優先します。

- `code_outline`: 関数・クラスなどの一覧と宣言全体の範囲
- `code_syntax_search`: ファイル内の宣言名を部分一致で絞り、同名候補ごとに宣言全体の範囲を返す
- `code_definition` / `code_references` / `code_hover`: 位置的問い合わせ
- `code_diagnostics`: 現在の内容を同期して診断を取得

構文ツールの行と桁は1から数え、終了位置は範囲に含めません。編集時は、返された範囲で現行ソースを確認してから変更します。定義や参照の問い合わせには、行末の「名前位置」を言語サーバーのツールに渡せます。

## 状態の区別

診断について次の3状態を混同しません。

- **診断0件**: サーバーが現在の版に対して「問題なし」を通知した
- **未通知**: まだ結果が来ていない（成功ではない）
- **古い版**: 通知された版が現在の内容より古い（現在の診断として返さない）

文書を変更したときは版を進め、古い版の診断は捨てます。同じ内容の再解析では版を進めません。

## 境界と制約

- 位置はLSP仕様のUTF-16単位です。UTF-8バイト位置とは異なります。CRLFも変換しません。
- サーバー発の `workspace/applyEdit` は適用しません。編集は必ず承認付きツール経由です。
- ファイルツールのルート制限は、外部LSPプロセス自体を隔離するものではありません。サーバーは利用者権限で動きます。
- 2 MiBを超えるファイルは解析しません（本文操作は可能）。
- XcodeやOS管理者権限が必要なSDKは自動取得しません。前提不足として表示します。
- 実端末・実サーバーでの検証はmacOS arm64が中心です。Linux等は別途検証が必要です。

## 検証

```sh
npm run typecheck
npm test
npm run build
sh scripts/acceptance.sh
```

`npm run build` は文法WASMを `dist/language/grammars/` へ同梱します（約20MB）。`scripts/acceptance.sh` は隔離環境へ配布物を導入し、空の管理領域からの自動導入、実際の型エラー診断、再利用時に再導入しないこと、修正後に診断が消えること、`language status` が状態を変更しないことを確認します。
