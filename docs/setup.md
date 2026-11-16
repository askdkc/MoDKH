# 依存パッケージとLisp環境

## 必須・任意の区別

| 用途 | 必要なもの |
|---|---|
| MoDKHの起動・ビルド | Node.js（package.jsonのengines準拠）、npm。ソース取得にはGit |
| npm依存 | `npm ci` でpackage-lock.jsonどおりに導入。個別のグローバル導入は不要 |
| Lisp担当設定・補助構文診断 | SBCL。ASDF/QuicklispやLSPは設定評価には不要 |
| CL-LSPの構築 | Cコンパイラ、make、tar/bzip2、Git、HTTPS接続。専用領域へRoswell、SBCL、ASDFとaskdkc/cl-lspを導入。Lisp依存はCL-LSPに同梱 |
| 導入時のHTTPS通信 | curl、CA証明書。CL-LSP用のOpenSSL設定やQlotは不要 |
| 前鬼（TLC） | Javaと公式の `tla2tools.jar` |
| 後鬼（Lean） | Lean。elanでtoolchainを管理可能 |
| 文法WASMの再構築 | Tree-sitter CLIとEmscripten。通常buildは同梱用の既存WASMをコピーするため不要 |

npmの直接依存はAI SDK（`ai`、`@ai-sdk/anthropic`、`deepseek`、`google`、`openai`、`openai-compatible`）、`vscode-jsonrpc`、`web-tree-sitter`。開発依存はTypeScript、`@types/node`、`tree-sitter-wasms`です。正確な一覧は[package.json](../package.json)、解決済み推移依存は[package-lock.json](../package-lock.json)を参照してください。

## macOS

```sh
# 未導入の場合のみ
xcode-select --install
brew install node git sbcl curl ca-certificates

# Roswellを手動で使う場合のみ
brew install roswell

# 前鬼を使う場合のみ。システムJavaの置換は不要
brew install openjdk
export PATH="$(brew --prefix openjdk)/bin:$PATH"

# 文法をソースから再構築する開発者のみ
brew install emscripten tree-sitter-cli
```

`cc`・`make`はCommand Line Tools、`tar`・`bzip2`はOSのものを使います。既存のSBCLやQuicklispが動作するなら、削除・再導入する必要はありません。

## Arch Linux

```sh
sudo pacman -Syu --needed base-devel nodejs npm git sbcl curl ca-certificates tar bzip2

# Roswellを手動で使う場合のみ
sudo pacman -S --needed roswell

# 前鬼を使う場合のみ
sudo pacman -S --needed jre-openjdk

# 文法をソースから再構築する開発者のみ
sudo pacman -S --needed emscripten tree-sitter-cli
```

上記はArch Linuxの公式パッケージ向けです。Linuxの実CL-LSP・隔離機構をこのREADME更新で実機検証したものではありません。

## Common Lisp

MoDKHは [askdkc/cl-lsp](https://github.com/askdkc/cl-lsp) を専用領域に導入します。同梱の `vendor/` とheadless installerを使用し、別のLem・Qlot・OpenSSL設定は不要です。取得revisionと同梱ソース一覧のdigestを記録し、LSPの初期化・同期・定義応答を確認します。

手動で管理する場合のみ、次を実行します（`~/.roswell` を更新します）。

```sh
ros install askdkc/cl-lsp
~/.roswell/bin/cl-lsp --help
```

Roswellが既存checkoutを再利用して古いコードを読む場合は、そのcheckoutを更新してから再導入します。MoDKHの自動導入は新しい専用checkoutを取得します。

既に動くCL-LSPがある場合は `~/.config/modkh/config.json` の既存設定に次を統合します。

```json
{
  "language": {
    "autoInstall": false,
    "servers": {
      "commonlisp": { "command": "/absolute/path/to/cl-lsp", "args": [] }
    }
  }
}
```

`autoInstall: false` は全言語の自動導入を止めます。CL-MCP-Serverの `run-server.lisp` はMCP用なので、このLSP設定の実行ファイルには指定しません。

## その他の言語・形式検証

必要な言語だけ準備してください。対象プロジェクト自体の依存は、そのプロジェクトの通常の手順で導入します。

| 対象 | MoDKHが使うパッケージ・実行ファイル |
|---|---|
| JS / TS / TSX | `typescript-language-server`、`typescript`（専用npm prefixへ自動導入） |
| Svelte | `svelte-language-server`（自動導入） |
| HTML / CSS | `vscode-langservers-extracted`（自動導入） |
| Tailwind CSS | `@tailwindcss/language-server`（自動導入）、対象側のTailwind設定・依存 |
| Python | `basedpyright`（自動導入）、対象側のPython環境 |
| PHP | PHPantom（対応releaseの自動導入経路あり）、対象側のPHP/Composer依存 |
| Rust | Rust toolchainと `rust-analyzer`（ホスト側で準備） |
| C / C++ | LLVMの `clangd`、対象側のヘッダー・ビルド情報 |
| Ruby | Rubyと `ruby-lsp` gem（ホスト側で準備） |
| Swift | Swift toolchainの `sourcekit-lsp`。macOSではXcodeのtoolchainも利用可能 |

Leanは[公式インストール手順](https://lean-lang.org/install/)、TLCのjarは[公式release](https://github.com/tlaplus/tlaplus/releases/latest)を使用します。取得した実行ファイルを指定します。

```sh
modkh chat --lisp-config experiments/presets/formal.lisp --trust-lisp-sha256 REVIEWED_SHA256 \
  --lean /absolute/path/to/lean \
  --java /absolute/path/to/java --tla-jar /absolute/path/to/tla2tools.jar
```

[プリセットの手順](presets.md)で `formal.lisp` を確認し、そのSHA-256を `REVIEWED_SHA256` に指定します。現在のLean結果は成功終了でも `accepted / unverified`。TLCの成功は指定した有限モデルに限定されます。

CL/Svelteの実WASMは未同梱であり、Emscriptenを入れるだけでは有効になりません。強いOS検証隔離も未提供です。[機能ごとの検証状況](modkh-verification.md)

公式情報：[Homebrew SBCL](https://formulae.brew.sh/formula/sbcl)・[Roswell](https://formulae.brew.sh/formula/roswell)・[Arch SBCL](https://archlinux.org/packages/extra/x86_64/sbcl/)・[Arch Roswell](https://archlinux.org/packages/extra/x86_64/roswell/)・[CL-LSP](https://github.com/askdkc/cl-lsp)
