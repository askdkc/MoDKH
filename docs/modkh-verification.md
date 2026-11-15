# MoDKH 実装・検証状況

2026-11-15、日本時間。**PLAN.md全体は未完了。** この報告は現在の変更と実行結果を対象とし、計画に記載された過去のクラウド試作結果を流用していない。

基準HEAD: `0285cd0ddace3ab317b76953586e3f7c839fe0f3`。開始時の変更はREADME見出しの空白と未追跡のPLAN.md。これらを保持して独立作業コピーで開発・検証し、ソース変更を元の作業ディレクトリへ反映した。commit/push/グローバルインストール/本番プロセス操作は実行していない。

環境: Darwin arm64、Node 26.13.0、npm 9.6.7、SBCL 2.6.10、Apple clang 21.0.0。空き容量の初回確認は約28 GiB。Linux実行環境は使用できていない。既存依存は読み取り共有し、npm ciや追加インストールは実行していない。

機械判読の結果・SHA256は [modkh-evidence.json](modkh-evidence.json)。再現方法は [modkh.md](modkh.md)。

## 残作業指示への今回の対応（2026-11-15）

元のPLANを読み直し、開始時のdirtyソースを独立コピーして再測定した。開始時は414件中353成功・58失敗・3skip。最終は427件中361成功・58失敗・8skip。**PLAN全体は未完了**。以下の不足項目を補助診断やmock成功で置き換えていない。

| 受入項目 | 現在の実装状態 | 今回の実測と残り |
|---|---|---|
| 1: CL-LSP導入・定義・push/pull診断 | 未実装／未検証 | private Roswell/SBCL/ASDF/Lem cold bootstrapは未実装。CL-LSP実プロセスなし。公式Lemのinitializeではdiagnostic-providerがコメントアウトされ、didOpenは文書登録のみ。ソース調査は実測の代替ではない。 |
| 1追加: 診断の代替 | 補助機能を実装・実測 | `commonlisp-reader.ts`で既存SBCLのreaderのみを実行。日本語・絵文字・入れ子・文字列・コメント・不正構文を確認。通常フォームも`#.`も評価せず、独自packageやread-time evalはunverified。構文読取可能を意味診断正常としない。code_diagnosticsはLSPが未確認ならToolErrorを維持。 |
| 2: CL/Svelte実文法 | 未実装／取得・ビルド不能 | 実WASMは依然12文法のみ。CL/Svelte用WASM・tree-sitter CLI・Emscripten・wasm-ldがない。埋込領域・UTF-8座標の受入は未達。既存言語経路は関連suiteと実TSで再確認。 |
| 3: 編集と検証器 | 部分実装 | single-use検証、検証開始後のedit拒否、全source依存の検証前後比較、ctime/mtimeも含む復元検出、削除時のstale判定を追加。既存dirty bytesをsnapshotとして扱いgit基準へ戻さない。対象外・保護manifest・symlink差替え・no-opの既存試験も実行。OS readonly境界・外部依存閉包・任意の対象外OS書込みの拒否は未実装。 |
| 4: 委譲と完了判定 | 配線は実装・試験成功／自律モデルは未検証 | 実SBCL設定→head一覧→子ツール→固定Node検証→head receiptをビルド済みentryで再実行。全文スキル・欠落tool・証跡不足・虚偽doneの既存試験も再実行。実モデルの自律選択試験は未実施。 |
| 5: Lean/TLC | wrapper実装／実runtime未検証 | 直接sorry・誤定理・独自公理・生成公理・推移sorryを扱う実Lean試験5件を追加したが全てskip。既存実Lean1/TLC2もskip。wrapperのunverifiedは維持。TLC cfg/hash/対象scopeの実装は維持され、実TLC受入は未達。 |
| 元PLANのその他 | 状態を維持 | PHP native実ダウンロード、Linux各cold install、Tailwind実hover、全OS検証、一般的TOCTOU保証は未達。Lisp API・30観測＋8編集preset・権限制限・TLC/Lean evidence・型付きexit結果は現行試験で回帰確認。動的登録のACKをwatch実装とはしていない。 |

変更ファイル:

- `src/language/commonlisp-reader.ts`: 評価しない補助構文検査とbounded receipt。
- `src/tools/language.ts`: LSP未確認を維持したままCL補助検査を返す。
- `src/language/lsp/client.ts`: ENOENTの捕捉、文書版の一致、pull report shape確認、push/pull証跡。
- `src/subagents/verification.ts`: 一度限りの検証、編集終了、全入力の変更検出。
- `scripts/modkh-language-probe.mjs`: CL lexical定義と不正ファイル診断を別々に記録。未検証はexit1。プロジェクトをload/evalしない。
- `scripts/modkh-mutation-check.mjs`: 検証再利用、復元検出、pull診断の改変試験を追加。
- `test/language.commonlisp-reader.test.ts`, `test/language.lsp.test.ts`, `test/fixtures/fake-lsp.mjs`, `test/lisp.edit-service.test.ts`, `test/formal.lean-real.test.ts`: 回帰・反例試験。

| 今回の最終変更後のコマンド | 観測結果 |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass、12文法・17スキル |
| `node --test test/lisp*.test.ts test/formal*.test.ts test/language*.test.ts` | 86件: 77 pass / 1 fail / 8 skip。1 failは既存HTTP listenerのEPERM。 |
| `npm test` | 427件: 361 pass / 58 fail / 8 skip |
| ビルド済みchat entryの`test/lisp.cli.test.ts` | 1 pass、実Node受入test・source適用・親receipt |
| `node scripts/modkh-language-probe.mjs typescript /usr/local/bin/typescript-language-server OUTPUT.json --stdio` | 実既存TS LSPでinitialize・型不一致診断・定義参照成功。最新のcold installではない。 |
| `node scripts/modkh-mutation-check.mjs OUTPUT.json` | 10改変すべて対応試験が検出 |

58件は**失敗名とerror/codeを個別照合**し、追加失敗・消えた失敗・原因変化はいずれも0。[全件比較](modkh-failure-comparison.json)に開始時と最終結果を保存。57件が`listen EPERM`、1件が`EMFILE ... watch`。全体greenではない。新規5skipは実Lean counterexampleであり、元の3skipを解消したという意味ではない。

OS実測はDarwin arm64のみ。Linux環境は使用しておらず、Linux成功を主張しない。`curl --max-time 10 -I https://registry.npmjs.org/tree-sitter-svelte`はDNS解決失敗。`sandbox-exec`の無変更probeは` sandbox_apply: Operation not permitted`で拒否され、再試行・迂回していない。Java runtime、Lean、Roswell、CL-LSP、WASMビルド用ツールチェーンを確認できなかった。必要な依存を取得できる許可済み環境とOS隔離機能が揃うまで、これらの実受入はblocked。未実装のCL bootstrap／実文法経路／OS分離の追加実装も必要。

公式ソース確認: [CL-LSPのASDF依存](https://github.com/cxxxr/cl-lsp/blob/master/cl-lsp.asd)、[Lem lifecycle](https://github.com/lem-project/lem/blob/main/extensions/language-server/controller/lifecycle.lisp)、[文書同期](https://github.com/lem-project/lem/blob/main/extensions/language-server/controller/document-synchronization.lisp)。定義参照の成功と診断の成功を同一視しない。

## 元PLAN項目別の状態

| PLAN対象 | 状態 | 実装・証拠と残り |
|---|---|---|
| A: 実Lisp設定 | 実装・試験成功 | 実SBCL、ハッシュ不一致の実行拒否、条件式、管理API、未知フィールド/重複/上限、タイムアウト、最小環境、全文スキル、セッション限定登録を検証。任意LispコードのOS sandboxではない。 |
| B: プリセット | 設定・注入成功、実能力は一部未達 | 8ファイルを実SBCLで評価。観測30＋編集8。編集は固定check＋owner manifestでのみ有効。前鬼・後鬼を追加。CL/Svelteの構造抽出は文法未同梱のため未達。 |
| C: ヘッド委譲 | 実入口で成功 | `runChat`とビルド済み`dist/cli/chat.js`でlist→構造担当→編集担当→固定Node検証→親への結果を確認。子セッションに保存。ヘッドの直接edit/shell/formal権限なし。`dist/index.js`でも前鬼・後鬼の一覧、builtin除外を確認。モデルはscriptedであり自由判断能力の証明ではない。HTTPモデル要求は環境の待受拒否で未検証。 |
| D: 限定編集 | 1ファイルの信頼済み入力で成功、強い隔離は未達 | target allowlist、owner source/protected manifest、専用snapshot、no-follow fd/inode/digest確認、並行変更のstale判定、固定コマンドのtyped receipt、失敗時非適用、no-op分類を実装。検証器・外部依存の完全な隔離、悪意ある実行物、あらゆるOS競合に対する保証はない。 |
| 4: LSP selector | 実装・限定検証成功 | 子へのlanguageTools供給、Tailwind強制selector、cold query、実document言語、未通知診断のerror化。プロトコルfixtureと実TypeScriptで確認。Tailwind実hoverは下記の環境障害で未確認。 |
| 4: CL/Svelte WASM | 未実装・取得阻害 | 現行同梱12文法のみ。新規WASM、由来/ライセンスと実座標テストは未追加。既存HTML/JS文法をCL/Svelte対応と偽装していない。 |
| 5: LSP導入 | 部分実装 | OS/CPU識別、npm latest、私有環境、停止制限、disk確認、60秒cooldown、導入後initialize、package名とbin名の分離。PHP公式asset選択・SHA256検証・リンク拒否・初期化経路を実装し、checksum拒否を試験。実ダウンロード・Linux導入は未検証。 |
| 5: TypeScript互換依存 | 実装・限定検証成功 | latestにtsserver.jsがなければ、導入した公式server READMEの明示的なnpm互換指定を一度だけ再解決。JS language serviceで実際の型不一致診断を検査し、initialize後のみ公開。選択指定・README/API SHA256・解決版をreceiptへ。実TypeScript APIとfixtureによるnpm/LSP導入制御を検証。実registryからのcold installは未検証。 |
| 5: Common Lisp bootstrap | 未実装 | Roswell/SBCL/Quicklisp/ASDF/Lem/async-process/CL-LSPのprivate cold bootstrapは追加できていない。公式asset・依存内容を検証できないまま推測した導入手順を実行していない。 |
| 6: 前鬼/TLC | wrapper実装、実TLC未実行 | ホスト固定Java/JAR、入力snapshot、承認、heap/workers/time/output制限、exit＋完了証跡の分類、hashとcfgを返す。実TLC正誤fixtureはJava/TLC未導入によりskip。 |
| 7: 後鬼/Lean | 分類実装、実Lean未実行 | exit0もaccepted/unverified・ToolResult errorを維持。偽stdout、空、真/別目標/sorry/生成axiom入力でfake compilerを使ったwrapper回帰は成功。実Leanでの推移sorry・生成公理・import依存閉包実験は未実行。証明妥当性を保証する実装は行っていない。 |

## 過去の実装時点のコマンド結果（今回の最終ソースの証拠とは区別）

| コマンド | 結果 |
|---|---|
| 変更前 `npm run typecheck` / `npm run build` | pass / pass |
| 変更前 `npm test` | 373件: 315 pass、58 fail、0 skip |
| 変更後 `npm run typecheck` | pass |
| 変更後 `npm run build` | pass。12文法・17同梱スキルを検証 |
| `node --test test/lisp*.test.ts test/formal*.test.ts test/language.overlay.test.ts test/language.install-platform.test.ts` | 37件: 34 pass、0 fail、3 skip（実Lean1、実TLC2） |
| ビルド済みchat入口の同じ委譲・編集統合試験 | 1 pass、0 fail、0 skip |
| ビルド済み`dist/index.js`でLisp設定＋`/agents` | exit0、前鬼・後鬼表示、builtinなし |
| 変更後 `npm test` | 414件: 353 pass、58 fail、3 skip |
| 反映後の `npm run typecheck` / `git diff --check` | pass / pass。実装・試験・文書191ファイルの一致とsource SHA256一致を確認 |
| 故意の改変7種 | 7種すべて対応テストで検出 |

変更前後の失敗テスト名の集合は一致。57件が `listen EPERM: operation not permitted 127.0.0.1`、1件が `EMFILE: too many open files, watch`。これらを成功やskipに変更していない。全体greenではない。

改変検査は別の使い捨てコピーで実行した。子へのlanguageTools供給削除、target allowlist削除、検証のexit0条件削除、tsserverファイル検査削除、Leanのerror伝搬削除を、それぞれCLI統合・編集・導入能力・proofStatus試験が検出した。Leanの検出力はwrapper分類の範囲であり実Lean kernel検証ではない。

## 追加実装の検証

`test/language.typescript-capability.test.ts` と `test/language.install-fallback.test.ts` の4件成功。公式READMEの互換指定抽出、実TypeScriptの型不一致診断、空APIの拒否、互換指定がない場合の拒否とstaging削除を検査。既存導入・chat入口試験を合わせ8件成功。追加2種のmutation（意味診断の検査削除・互換選択の強制失敗）も検出。

根拠: [公式typescript-language-server README](https://github.com/typescript-language-server/typescript-language-server/blob/master/README.md) を2026-11-15に確認。実装に特定majorを埋め込まず、導入された配布物のREADMEから選ぶ。npmとLSP初期化はこの導入制御試験ではfixtureであり、実ネットワーク導入成功の証拠ではない。

## 過去の実サーバー測定（TypeScriptのみ今回再測定）

一時プロジェクトと秘密を含まない環境だけを使用し、既存バイナリを実行した。新規インストールはしていない。

| サーバー | 実測結果 |
|---|---|
| TypeScript language server 4.3.3（既存） | initialize、型不一致診断、定義位置取得が成功。latestのcold installを試した結果ではない。 |
| Tailwind language server 0.14.29（既存） | initialize成功。bundled watcherが`Error starting FSEvents stream`で失敗。hoverはnull、未通知診断。`display:flex`の取得成功とはしない。 |
| Svelte language server 0.16.5（既存） | initialize成功まで。意味解析品質・埋込文法座標は未確認。 |
| PHPantom（既存、version未収集、binary hash収集） | initialize成功まで。診断品質は未確認。 |
| CL-LSP / Lean / TLC | 実行可能な必要runtimeがない。JavaコマンドはあるがJava Runtimeを検出できなかった。 |

`curl --max-time 15 -I https://registry.npmjs.org/tree-sitter-svelte` は `Could not resolve host: registry.npmjs.org`。ネットワーク取得・追加WASM配布物・最新公式release metadataを実行環境で検証できない。制約を迂回してインストールしていない。

## 検証の解釈と残作業

- `verification.status=passed` は固定コマンドの確定exit0と記録したsnapshot/hash一致を示す。OS sandbox、任意依存閉包の完全性、要求そのものの正しさは保証しない。private snapshotをreadonly mountや外部検証器の代用とはしていない。
- 今回の編集workflowは既存ファイル1件。複数ファイルtransaction、新規作成、rename/deleteは拒否する。
- 子がdoneと言うだけでは完了にしない。必要ツールの未実行/失敗、Lean proof-unverifiedを親へ伝える。
- Common Lisp bootstrap、CL/Svelte WASM、実registryからのTS互換依存再解決確認、強い検証器隔離、実Lean/TLC・Tailwind hover・Linuxのcold installが残る。環境があっても未実装部分への追加実装は必要。
- 残りの実導入検証には、公式registry/GitHubへ接続できる許可済みLinux環境と、必要runtimeが要る。MacのFSEvents/HTTP待受制限はこの変更では解除していない。
- ソースは作業ディレクトリへ反映。ビルドと実入口検証は独立作業コピーで行い、ユーザーのglobal `dkh` / 既存dist実行環境は更新していない。再ビルドは手順書のコマンドで行える。

推奨コミットメッセージ（未コミット）:

```text
feat: add trusted Lisp microagents and host-verified delegation for MoDKH
```
