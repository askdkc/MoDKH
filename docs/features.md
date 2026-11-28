# 追加機能と設定

## 待機中の表示

モデルやツールの応答を待っている間は、入力欄の空きにアニメーションが走ります。`/annimation off` で非表示にし、`/annimation on` で戻せます。切り替えは起動中のみ有効です。最初から非表示にするには `MODKH_NO_ANIMATION=1 modkh` で起動してください。待機メッセージと経過時間は引き続き表示されます。

## 修正を繰り返したときの一時停止

同じファイル群を編集するたびに、同じコマンドで同じエラーが出るか、同じタブのスナップショットが変わらない状態が3回続くと、次の対象ファイルの編集を保留し、チャットで方針を尋ねます。同じ画面や画像を目視確認する場合も、3回の編集と確認の後にさらに編集しようとした時点で尋ねます。画像の仕上がりはユーザーが判断できます。確認だけを繰り返しても修正回数は増えません。

途中までの編集とツール結果は残ります。同じチャットに期待する結果や次の指示を入力してください。この判定は AgenticReplay を無効にしていても働きます。

## pstack での形式検証

pstack が状態遷移や並行処理の不変条件、定理の形式検証を必要と判断すると、モデル JSON と Lean の証明元を指定します。ハーネスは作業完了前に前鬼（Stateright）と後鬼（Lean）を順に呼び、それぞれの結果をセッションに保存します。通常の編集では起動しません。Lisp で検証入力を指定している場合は、その指定を使います。

前鬼には Stateright、後鬼には起動時の `--lean` 指定が必要です。証明の合格判定には、独立した期待命題を `--lean-contract`、照合する定理名を `--lean-theorem` で指定します。前鬼の探索が完了し、後鬼が指定命題を証明できた場合に「形式検証は合格」と表示します。Lean のコンパイルだけで終わった場合は未検証です。

## 通信記録

`agenticreplay version` が成功する環境では、[AgenticReplay](https://github.com/askdkc/AgenticReplay) がモデル API の通信をワークスペースの `.agenticreplay/runs/` に記録します。Ollama や LM Studio などの HTTP モデル API も対象です。HTTPS は AgenticReplay の既定ホストと、起動時に `--base-url` で指定したホストを記録します。記録を止めて起動するには `MODKH_AGENTICREPLAY=0 modkh` を使います。

長時間の作業で AgenticReplay のイベントログが保存上限に達した場合は、そこまでの記録を「不完全」として残し、モデルとの会話を続けます。この動作には `AGENTICREPLAY_CONTINUE_ON_STORAGE_LIMIT` に対応した AgenticReplay が必要です。公開版 0.1.27 を使う場合は、`MODKH_AGENTICREPLAY=0 modkh` で通信記録を無効にしても、MoDKH の会話履歴は保存されます。

`.git` があるワークスペースでは、起動時に `.gitignore` の末尾へ `.modkh/` と `.agenticreplay/` を追加します。どちらも modkh がワークスペースへ書く実行記録で、プロジェクトの成果物ではありません。既存の行は書き換えず、既に書かれていれば何も追加しません。`.git` が無いディレクトリは変更せず、ワークスペース外を指すシンボリックリンクの `.gitignore` も書き換えません(その場合は起動時に一度だけ理由を表示します)。

## Local LLM に接続する

`/connect` で **Local LLM** を選び、OpenAI 互換 API のベース URL と API キーを入力してモデルを選びます。キーが不要な場合は空欄のまま Enter を押します。

モデル ID が分かっていれば、起動時に直接接続できます。次の例では、URL とモデル ID を接続先に合わせ、環境変数 `LOCAL_LLM_API_KEY` に用意したキーを渡します。認証が不要なら `--apikey "$LOCAL_LLM_API_KEY"` を省略します。

```sh
modkh --model local-llm/inkling-2-mini-sq-10 --base-url http://localhost:8888/v1 --apikey "$LOCAL_LLM_API_KEY"
```

## macOS の依存ツール（任意）

Lisp プリセット・前鬼（Stateright）・Rust 解析を使う場合だけ用意します。Node.js と npm の準備は [README](../README.md) を参照してください。

```sh
# Command Line Tools が未導入の場合のみ
xcode-select --install

# Lisp プリセットの設定評価と Common Lisp の補助構文診断で使う
brew install sbcl

# 前鬼と Rust 解析で使う
brew install rustup
export PATH="$(brew --prefix rustup)/bin:$PATH"   # keg-only のため PATH に追加する
rustup default stable
rustup component add rust-analyzer
```

`sbcl --version`、`cargo --version`、`rust-analyzer --version` がそれぞれバージョンを返せば準備完了です。`rust-analyzer --version` が「unavailable for the active toolchain」と出るときは、`rustup component add rust-analyzer` を実行してから確認してください。

`export PATH` の行は `~/.zshrc` に書くと次の起動でも有効になります。Homebrew の rustup は keg-only なので、`cargo` も `rust-analyzer` もこのディレクトリのラッパー経由で動きます。Rust 公式の [rustup](https://rust-lang.org/tools/install/) で導入した場合は stable が既定で入り `~/.cargo/bin` も PATH に入るため、`rustup component add rust-analyzer` だけで済みます。

Rust の解析だけが必要なら `brew install rust-analyzer` でも構いません。この場合は `cargo` が入らないため、`modkh stateright install` は実行できません。`rust-analyzer` を PATH 上のどこに置いても MoDKH は見つけます。

`modkh language install` は SBCL と Rust toolchain を自動導入しません。他のOS向けの手順は[依存パッケージ](setup.md)にあります。

## `/cyber` で点検する（任意のツール）

`modkh` の入力欄で `/cyber https://example.com/app` を実行すると、承認後に [skills/cyber/cyber/SKILL.md](../skills/cyber/cyber/SKILL.md) の手順を実行します。承認画面にはクエリを伏せた URL、接続するポート、実行する検査、起動しない検査、および各コマンドの制限時間を表示します。接続先は指定したホストだけで、リダイレクトは追跡しません。結果はリポジトリ外（ホーム直下の `security-audit.*`、ディレクトリ 0700・ファイル 0600）に保存します。

`/cyber <URL>` だけを指定した場合は、URL 側の検査だけを実行します。ソースが手元にない状態で依存関係を調べても意味がないため、代わりに「稼働中のサービスを特定し、そのサービスの既知の脆弱性を突く」検査にしています。

1. **ソース・依存関係・秘密情報**（`--source <パス>` を指定したときだけ）: `trivy fs --scanners vuln,misconfig`、`osv-scanner scan source -r`、`semgrep --config p/php --config p/javascript`、`gitleaks git` と `gitleaks dir` を、チェックアウトのルートで順に実行します。指定しない場合は「未実行」と表示し、URL 側の検査へ進みます。
2. **サービス特定**: `nmap -n -Pn -sT -sV --version-light` で、稼働しているソフトウェアと版を読みます。走査するのは代表的な35ポートと、URL が指定するポートそのもの（`8080` や `8443` などもれません）。`--quick-ports` を付けると URL のポートだけに絞ります。
3. **既知の脆弱性**: 手順2で判明したポートに対して `nmap --script vuln` を実行し、CVE 単位で既知の脆弱性を突きます。判明したサービスがなければ URL のポートを対象にします。
4. **Web 設定と SQL**: `nikto -Tuning 2 -Pause 1` で設定不備とデフォルトファイルだけを確認し、URL にクエリがあるときは `sqlmap --batch --smart --level 1 --risk 1` を稼働先に対して実行します。URL にクエリがなければ sqlmap は「未実行」です。
5. **記録**: 対象、接続元、日時、デプロイ版を書く欄、検出内容、再検査手順を `record.md` に残します。

各コマンドは既定で **60秒** の制限時間を持ちます。応答がない場合は「一部未確認」として打ち切り、**次の検査へ進みます**。1つのツールが固まっても全体は止まりません。制限時間は `--timeout <秒>` で変えられます。

| ツール | 確認する内容 |
| --- | --- |
| Trivy | 依存パッケージの既知の脆弱性と、Dockerfile などの設定不備 |
| OSV-Scanner | ロックファイルなどのパッケージと OSV の勧告 |
| Semgrep | p/php・p/javascript のルールに該当するファイルと行 |
| Gitleaks | 秘密情報の候補。値・一致文字列・前後の行は保存も表示もしない |
| Nmap -sV | 稼働中のソフトウェアと版、外部から到達できるポート |
| Nmap --script vuln | 判明したサービスの既知 CVE |
| Nikto | Web サーバーの設定不備とデフォルトファイル |
| sqlmap | クエリ付き URL の SQL インジェクション |

オプションは `--source <パス>`、`--timeout <秒>`、`--quick-ports`、`--udp-ports <一覧>`、`--no-nmap`、`--no-nikto`、`--no-sqlmap`、`--no-source` です。`/cyber help` に一覧が出ます。

各検査は「検出あり」「検出なし」「対象なし」「一部未確認」「未実行」「失敗」「中断」を分けて表示します。ツール未導入は「未実行」であり「検出なし」ではありません。制限時間による打ち切りは「一部未確認」であり「検出なし」ではありません。中断した場合は以降の検査を開始しません。

`ss -lntup` はサーバー自身の待ち受けを読む必要があるため使っていません。サーバーの待ち受けは、そのサーバー上で `sudo ss -lntup` を実行して確認してください。外部からの到達性は、公開側・VPN・LAN の各経路から別々に走査します。共有 CDN のアドレスはオリジンの代わりに検査しません。

次のツールを PATH に用意します。

**macOS（Homebrew）**

```sh
brew install trivy osv-scanner semgrep gitleaks sqlmap nmap nikto
```

**Arch Linux**

```sh
sudo pacman -Syu --needed trivy osv-scanner gitleaks sqlmap nmap nikto python-pipx
pipx install semgrep
pipx ensurepath
```

インストール後は、新しいターミナルで `command -v trivy osv-scanner semgrep gitleaks nmap nikto sqlmap` を実行すると配置先を確認できます。

## プロジェクトの MCP サーバー

プロジェクトのルートで `modkh` を起動すると、通常のチャットで次の stdio サーバーを使えます。Svelte と Laravel Boost は検出時に起動し、最初の依頼を待たずに接続します。どちらも MoDKH 自身が決めた固定の起動コマンドを作業ルートで実行するため、`permissions` の既定値 `workspace` でも起動時の確認は出ません。`permissions` を `none` にすると、この接続も含めて毎回確認します。接続中のサーバーはサイドバーに表示され、チャット終了時に切断します。

| プロジェクト | 検出条件 | 利用時のコマンド |
| --- | --- | --- |
| Svelte / SvelteKit | `package.json` の依存関係に `svelte` または `@sveltejs/kit` があるか、`svelte.config.js` / `.ts` がある | `npx -y @sveltejs/mcp`（初回はダウンロードする場合があります） |
| Laravel Boost | `artisan` があり、`composer.json` に `laravel/boost` があるか `boost.json` がある | `php artisan boost:mcp`（Boost の導入が必要です） |

ほかの stdio サーバーも、ルートの `.mcp.json` に登録できます。たとえば次の設定は、自動検出した `laravel-boost` の起動方法を上書きします。

```json
{"mcpServers":{"laravel-boost":{"command":"php","args":["artisan","boost:mcp"]}}}
```

チャットで「Svelte の公式ドキュメントで確認して」「Boost でルートを調べて」のように依頼してください。モデルは `mcp_list_tools` で引数の形式を調べ、`mcp_call_tool` で呼び出します。各操作にはコマンドの承認設定が適用され、自動接続済みなら同じ接続を再利用します。独自の起動コマンドを指定したサーバーは、従来どおり操作時にだけ接続します。設定を変えたら `modkh` を起動し直してください。HTTP / SSE 接続は対象外です。

## 前鬼・後鬼による形式検証（任意）

<img src="../enno-oduno.png" alt="役小角" width="150">

- **前鬼（Stateright）** は、有限状態モデルを探索し、守るべき条件が破られる手順を探します。
- **後鬼（Lean）** は、指定した定理の証明を検査し、その定理が期待した命題と一致するかを確かめます。

[Rust/Cargo](https://rust-lang.org/tools/install/)を導入してから実行します。

```sh
modkh stateright install
modkh stateright status
modkh
```

導入済みなら、通常起動で前鬼（`modkh-micro-zenki`）を自動登録します。親モデルは状態遷移・競合・不変条件の検証を前鬼に委譲します。`/agents` で確認できます。MoDKHを更新した際も `modkh stateright install` で検証器を更新できます。

検証対象は明示的な有限状態JSONモデルです。[モデルの書き方・導入先・制約](stateright.md)を参照してください。

## ブラウザ検証（任意）

[browse](https://github.com/anomalyco/browse) を使うと、Chrome・Braveなどでページ表示、入力・クリック、スクリーンショット取得を行えます。PATH に実行可能な `browse` があれば、MoDKH は専用の `browse` ツールを登録します。接続状態の確認、HTTP(S) ページを開く、スナップショットの取得、クリック、フォーム入力、スクリーンショットは都度の許可なしで実行します。任意のスクリプトや管理コマンドには、従来どおり `run_command` の承認設定が適用されます。

```sh
npm install -g @opencode/browse
browse install --agent none
browse status --json
```

案内に従ってブラウザ拡張を導入・接続し、ブラウザを開いた状態で使います。`--agent none` は他のエージェントへのMCP登録を省く指定です。`status` の `extension.connected` が `true` なら接続済みです。`paired-offline` の場合は、拡張を導入したプロファイルを開き、拡張が有効か確認してください。

MoDKHの専用 `browse` ツールで開いたタブとポップアップは、応答の完了・エラー・中断時に自動で閉じます。既存のタブは閉じません。終了を確認できなかった場合は対象のグループ名を表示し、セッション終了時にも再確認します。

`click` にはタブと対象要素の `ref` を指定します。canvas 内の図形など、要素単位で指定できない対象は、`ref` の代わりにページ上の CSS ピクセル座標 `x` と `y` を渡せます。クリック後の変化はスナップショットなどで確認します。ブラウザから結果が返らず中断した場合は、操作とその理由、保存済みのファイル、未確認の範囲を表示します。`--resume` で再び確認できます。

スクリーンショットは画像としてモデルへ直接渡します。撮影に使う一時ファイルは、ツールの終了時に削除します。接続先が画像入力に対応していない場合は、画像が未確認であることを表示し、テキストや他のツールを使って作業を続けます。`view_image` で開いた画像も同じ扱いです。

`run_command` から直接 `browse` CLIを使う場合は自動終了の対象外です。開いたタブのIDを控え、作業後に `browse tabs close --tab <id>` で閉じてください。操作方法は `browse --help` で確認できます。
