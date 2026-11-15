# MoDKH

**Mixture of DKH** — Common Lispで専門担当を定義し、ヘッドモデルから調査・編集・検証を委譲できるコーディングハーネス。

npmパッケージ名・コマンド名は `modkh`。既存の `dkh` コマンドとは別にインストールします。設定先は `~/.config/modkh`（変更する場合は `MODKH_HOME`）です。

既存の `.dkh`・`~/.config/dkh` は自動で読み込み・移行しません。新しい保存先は `.modkh`・`~/.config/modkh`、環境変数は `MODKH_HOME`・`MODKH_PLAIN` です。初回は `/connect` で接続を設定してください。Lisp設定も `(in-package :modkh)` を使用します。

## インストール

Node.jsは `package.json` の `engines` を満たす現行版を使います。ソースからの導入にはnpmとGit、Lisp設定にはSBCLが必要です。

### macOS

[Homebrew](https://brew.sh/)を用意して実行します。Command Line Toolsが導入済みなら最初の行は不要です。

```sh
xcode-select --install
brew install node git sbcl
```

### Arch Linux

```sh
sudo pacman -Syu --needed base-devel nodejs npm git sbcl
```

### リポジトリから起動

```sh
npm ci
npm run build
node dist/index.js
```

コマンドとして導入する場合（npmへの公開は不要）：

```sh
archive=$(npm pack --silent)
npm install -g "./$archive" && modkh
```

旧tarballで `/bin/dkh` の `EEXIST` が出た場合は、修正済みのこのリポジトリから上記の `npm pack` をやり直してください。既存の `dkh` を削除したり、`--force` で上書きする必要はありません。

初回は `/connect` で接続先とモデルを選択します。ChatGPT認証やAPIキーに対応し、Ollama Local以外はローカルモデルの導入不要です。[プロバイダー設定](docs/models.md)

## Lispで担当を登録する

SBCLだけで設定を評価できます。設定用途にはRoswell・Quicklisp・CL-LSPは不要です。
リポジトリのルートで8技術と前鬼・後鬼のプリセットをまとめます。

```sh
cat experiments/presets/*.lisp > agents.lisp
# agents.lispを読み、実行してよい内容か確認する
hash=$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync("agents.lisp")).digest("hex"))')
node dist/index.js chat --lisp-config agents.lisp --trust-lisp-sha256 "$hash" --sbcl sbcl
```

Lisp設定は任意コードとして実行されます。未承認の設定を自動読込せず、追加で `load` するファイルは入口のhashでは保護されません。設定を変更したら内容を再確認してhashを取り直します。

チャットの `/agents` で担当を確認できます。編集担当には、ホスト側で対象ソース・保護ファイル・固定検証コマンドを指定する必要があります。[設定API・編集検証・形式検証](docs/modkh.md)

## Common Lispの言語解析

CL-LSPにはSBCL、ASDF、Quicklisp、Qlot、Lemとその依存（`micros` など）、CL-LSP、Cコンパイラ・make・tarが必要です。設定評価とは別の機能です。

MoDKHの自動導入は専用領域でRoswellから依存を構築します。既存のグローバルQuicklispを変更しません。Lispプロジェクト内で次を実行します。

```sh
modkh language install --detected
modkh language status
# 失敗原因を解消した後、次回利用時の再試行を許可
modkh language retry commonlisp
```

`install --detected` はCommon Lispだけでなく、そのディレクトリで検出した言語を対象にします。既存CL-LSPの指定、手動のRoswell/Qlot準備、OS別の追加依存は[依存パッケージとLisp環境](docs/setup.md)を参照してください。

**CL-LSP自動構築の実起動、CL/Svelteの実Tree-sitter文法、強いOS検証隔離は未完了です。** SBCL補助診断とCL-LSPの診断は別扱いです。[検証状況](docs/modkh-verification.md)

## よく使う操作

| 操作 | コマンド |
|---|---|
| 接続先・モデルを選ぶ | `/connect`、`/models` |
| 推論設定を保存 | `/reasoning high --save` |
| 担当一覧 | `/agents` |
| 承認設定を確認 | `/allow` |
| 保存したキーを管理 | `/keys` |
| 言語解析の状態 | `modkh language status` |
| 開発時の検証 | `npm run typecheck`、`npm run build`、`npm test` |

承認ポリシーはOS sandboxではありません。セッション記録は作業ルートの `.modkh/sessions/` に保存します。

詳細：[入力](docs/input.md) · [言語解析](docs/languages.md) · [サブエージェント](docs/subagents.md) · [Web検索](docs/web.md) · [スキルと入力節約](docs/context-efficiency.md)
