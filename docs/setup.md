# 依存パッケージとLisp環境

## 必須・任意の区別

| 用途 | 必要なもの |
|---|---|
| MoDKHの起動・ビルド | Node.js（package.jsonのengines準拠）、npm。ソース取得にはGit |
| npm依存 | `npm ci` でpackage-lock.jsonどおりに導入。個別のグローバル導入は不要 |
| Lisp担当設定・補助構文診断 | SBCL。ASDF/QuicklispやLSPは設定評価には不要 |
| CL-LSPの構築 | Cコンパイラ、make、tar/bzip2、Git、HTTPS接続。専用領域へRoswell、SBCL、ASDF、Quicklisp、Qlot、Lem、CL-LSPを導入 |
| Lisp依存の取得・TLS | curl、CA証明書、OpenSSL。Lemの依存一覧は取得した `qlfile` が正本 |
| 前鬼（TLC） | Javaと公式の `tla2tools.jar` |
| 後鬼（Lean） | Lean。elanでtoolchainを管理可能 |
| 文法WASMの再構築 | Tree-sitter CLIとEmscripten。通常buildは同梱用の既存WASMをコピーするため不要 |

npmの直接依存はAI SDK（`ai`、`@ai-sdk/anthropic`、`deepseek`、`google`、`openai`、`openai-compatible`）、`vscode-jsonrpc`、`web-tree-sitter`。開発依存はTypeScript、`@types/node`、`tree-sitter-wasms`です。正確な一覧は[package.json](../package.json)、解決済み推移依存は[package-lock.json](../package-lock.json)を参照してください。

## macOS

```sh
# 未導入の場合のみ
xcode-select --install
brew install node git sbcl curl openssl ca-certificates

# Roswell/Qlotを手動で使う場合のみ
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
sudo pacman -Syu --needed base-devel nodejs npm git sbcl curl openssl ca-certificates tar bzip2

# Roswell/Qlotを手動で使う場合のみ
sudo pacman -S --needed roswell

# 前鬼を使う場合のみ
sudo pacman -S --needed jre-openjdk

# 文法をソースから再構築する開発者のみ
sudo pacman -S --needed emscripten tree-sitter-cli
```

上記はArch Linuxの公式パッケージ向けです。Linuxの実CL-LSP・隔離機構をこのREADME更新で実機検証したものではありません。

## Roswell・Quicklisp・Qlot

以下は**手動管理を選ぶ場合**の両OS共通手順です。`~/.roswell` を作成・更新するため、MoDKHの専用自動導入とは別です。既存設定がある場合は内容を確認してから実行します。

```sh
ros setup
ros install fukamachi/qlot
export PATH="$HOME/.roswell/bin:$PATH"
ros --version
qlot --version
sbcl --version
```

`export` は現在のシェルだけに適用します。RoswellはQuicklispを準備し、Qlotはプロジェクトの `qlfile` に記載された依存を解決します。SBCLを直接使う既存環境では、Quicklispは[公式導入手順](https://www.quicklisp.org/beta/#installation)に従います。通常の `~/.quicklisp` とRoswellのQuicklispは別環境です。

CL-LSPのREADMEにある `ros install lem-project/lem cxxxr/cl-lsp` は、このMacでLemの導入途中に失敗しました。成功確認済みの手順として扱わないでください。`System "micros" not found` はLemの依存環境が不完全、または現在のQuicklisp/ASDFから見えていないことを示します。Lemを取得しただけでは依存解決は完了しません。

MoDKH側は取得したLemの `qlfile` を専用領域で `qlot install --no-deps` に渡し、`QUICKLISP_HOME` をCL-LSPと内部プロセスで共有します。生成lock、段階別結果、ASDFの解決先を記録します。実ダウンロード・LSP応答の検証は未完了です。QlotやSBCLの導入成功だけでCL-LSPの動作成功とはしません。

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
node dist/index.js chat --lisp-config agents.lisp --trust-lisp-sha256 "$hash" \
  --lean /absolute/path/to/lean \
  --java /absolute/path/to/java --tla-jar /absolute/path/to/tla2tools.jar
```

`agents.lisp` の作成・確認と `$hash` の計算は[README](../README.md#lispで担当を登録する)の手順を先に実行します。現在のLean結果は成功終了でも `accepted / unverified`。TLCの成功は指定した有限モデルに限定されます。

CL/Svelteの実WASMは未同梱であり、Emscriptenを入れるだけでは有効になりません。強いOS検証隔離も未提供です。[機能ごとの検証状況](modkh-verification.md)

公式情報：[Homebrew SBCL](https://formulae.brew.sh/formula/sbcl)・[Roswell](https://formulae.brew.sh/formula/roswell)・[Arch SBCL](https://archlinux.org/packages/extra/x86_64/sbcl/)・[Arch Roswell](https://archlinux.org/packages/extra/x86_64/roswell/)・[Qlot](https://github.com/fukamachi/qlot)・[Lem](https://github.com/lem-project/lem)・[CL-LSP](https://github.com/cxxxr/cl-lsp)
