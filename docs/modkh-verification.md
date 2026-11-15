# MoDKH 実装・検証状況

2026-11-15。**PLAN全体は未完了。** 原PLANは変更していない。

基準HEAD: `f3af9d9bd2308957a8a167c47f5e0f38eb3e3839`。開始時の元作業ツリーの差分は未追跡の `PLAN.md` のみ。独立作業コピーで実装・検証後、ユーザーの明示指示により `/Users/dkc/Sites/Src/mdkh` へ11ファイルのパッチを適用した。既存の `PLAN.md` は保持し、変更ソース・テスト8ファイルが検証済みコピーとバイト一致することを確認した。commit、push、グローバル導入、設定変更は行っていない。前回報告のHEAD・361成功という数値を今回の証拠として流用していない。

実行環境はDarwin arm64、Node 26.13.0、npm 9.6.7、SBCL 2.6.10。既存node_modulesを読取共有。Linux実機は使用していない。cloud環境の一覧取得はツールエラーとなり、代替実行環境を確保できなかった。

## 今回の変更

| ファイル | 内容 |
|---|---|
| `src/language/commonlisp-install.ts` | private HOME/Roswell/XDG/prefixで段階的に構築。公式latest metadataのOS/CPU/glibc別assetとSHA256を選択、private SBCL/ASDF/Quicklisp、公式Lem依存、native async-process、launcher、成功marker、実initialize/同期/lexical定義検査を接続。失敗段階・cleanup・revisionをreceiptへ保存。global未評価定義と診断は別観測。 |
| `src/language/install.ts` | CL通常自動導入入口を接続。長時間導入lockのheartbeat、lock取得後の失敗cache再確認、不完全なmanaged cacheの拒否。autoInstall=falseのno-write/no-networkを維持。 |
| `src/language/native.ts` | 既存の取得先・サイズ・時間を制限したdownloadを共用公開。 |
| `src/language/lsp/client.ts` | initialized/didOpen/didChange通知のPromiseをawaitしEPIPEの未処理rejectionを防止。所有プロセスグループの終了を待つ。重複disposeは同じPromise。停止不明は例外。 |
| `src/language/lsp/pool.ts` | evictionの停止失敗を捨てず、settled/disposeAllへ伝搬。全serverの停止結果を収集。 |
| `test/language.commonlisp-install.test.ts` | 6件。OS/CPU/glibc/checksum、autoInstall=false、DNS失敗・cooldown、事前abort、同時導入、cc不在、不完全receipt/launcher改変を検査。ネットワークはfixture。 |
| `test/language.lsp.test.ts`, `test/fixtures/fake-lsp.mjs` | 実Node子プロセスの停止と冪等dispose、poolのcleanup不明伝搬を追加。 |
| `docs/modkh-verification.md`, `docs/modkh-failure-comparison.json`, `docs/modkh-evidence.json` | 現在の基準・実行結果・同一性に更新。 |

CL bootstrapはソースの部分実装であり、実導入成功ではない。空private領域から通常のensureInstalled入口を実行し、Apple clangの能力確認は成功、`api.github.com` の `ENOTFOUND` によりrelease-metadataで停止した。成功stateは作成されず失敗receiptが保存された。ダウンロード・コンパイル・warmup・CL-LSP起動・定義・push/pull診断は未実行。最後のsource修正はreceiptの検証方針を実測成功と誤読させない文言修正であり、実DNS失敗receiptは修正前の観測としてそのまま保存した。

新導入はprivate Roswellを構築する。既存グローバルRoswell/SBCL/ASDFの能力に基づく選択的再利用は未完成。Git commitとRoswell SHA256の記録経路はあるが、Quicklisp推移依存の完全inventory・独立認証・hash閉包は未実装。再利用時の検査はlauncherと成功receiptであり、依存閉包再検査ではない。warmup成功markerだけではreadyにせずlexical定義応答を要求するが、その成功経路は実ホストでは未検証。インストーラは公式配布元の実行コードを実行する信頼境界を持ち、OS sandboxではない。プロジェクトのload/evalを導入probeには追加していない。

診断は提供元を分ける。既存SBCL reader補助診断と `#.` 評価禁止を保持。CL-LSPの空/未着/pull未対応を診断成功にしない。新receiptのreadyはlexical定義だけの意味であり、diagnostics.verifiedとは別。実CL-LSPによる不正入力診断受入は未達。

## 最終変更後の試験

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass、12文法・17スキル。CL/Svelte実文法は含まれない。 |
| `node --test test/lisp*.test.ts test/formal*.test.ts test/language*.test.ts` | 94件、85 pass / 1 fail / 8 skip。HTTP待受EPERMが1件。 |
| `npm test` | 435件、369 pass / 58 fail / 8 skip。exit1。 |
| `MODKH_TEST_CHAT=file:///tmp/modkh-isolated-u8396o8e/dist/cli/chat.js MODKH_TEST_FIXED=file:///tmp/modkh-isolated-u8396o8e/dist/model/fixed.js node --test test/lisp.cli.test.ts` | 1 pass。scriptedモデル、実SBCL、実Node受入、headへのreceipt返却。 |
| `node scripts/modkh-mutation-check.mjs /tmp/modkh-iso-mutations.json` | 既存10改変すべて検出。テストを弱めていない。 |
| `node scripts/modkh-language-probe.mjs typescript /usr/local/bin/typescript-language-server /tmp/modkh-iso-real-ts.json --stdio` | 実既存TS LSPでinitialize・定義・型不一致診断・cleanup成功。registryからのlatest導入成功ではない。 |
| `node scripts/modkh-source-identity.mjs /tmp/modkh-iso-identity.json` | sourceとdistのSHA256を記録。対象一覧は同script。テストとdocsはこのsource集合外。 |

開始時にも型検査・buildを実行し成功。全体は427件、360 pass / 59 fail / 8 skipで、前回報告361/58/8と一致しなかった。追加の `pool reuses one server per key and caps concurrent servers` は未処理 `write EPIPE`。通知Promiseの処理後、最終suiteでは再発しなかった。残る58件は57件の`listen EPERM`と1件の`EMFILE ... watch`。**各試験名・error・codeの照合で、新規失敗0、同名原因変化0、EPIPEの1件のみ消失。** 件数だけの比較ではない。[全件比較](modkh-failure-comparison.json)。全体greenではない。

sourceとビルド成果物の同一性、実TSのhash、冷開始CL失敗receipt、改変試験結果は [modkh-evidence.json](modkh-evidence.json)。以下の独立コピー検証とは別に、反映先でも型検査・build・試験を実施する。反映後の結果は本書末尾に記録する。

## 8件の未実行

| 試験名 | 未実行理由 | 状態 |
|---|---|---|
| `real Lean transitive sorry remains unverified even when its consumer is accepted` | Official Lean executable unavailable; real kernel/counterexample tests not run | blocked |
| `real Lean sorry cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run | blocked |
| `real Lean false theorem cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run | blocked |
| `real Lean custom axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run | blocked |
| `real Lean generated axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run | blocked |
| `real Lean true theorem is accepted/unverified` | Official Lean executable not supplied | blocked |
| `real TLC good.cfg` | Java/TLC host settings not supplied | blocked |
| `real TLC bad.cfg` | Java/TLC host settings not supplied | blocked |

`command -v lean`で実行物なし、`/usr/bin/java -version`はJava Runtime不在。Java/TLCのhost指定もない。DNS制約下で新規実runtimeを導入できず、全8件は未実行のまま。fake compilerによる分類試験の成功を実Lean検証と呼ばない。

## 元PLANの棚卸し

| 項目 | 状態 | 証拠・残り |
|---|---|---|
| 0–2: 名称・境界・既存構造・初期測定 | 完了（今回の作業範囲） | MoDKH対象、基準HEADと差分保存、初期測定、独立コピー。 |
| 3A: 実Common Lisp設定 | 完了（限定契約） | 既存実SBCL試験を再実行。設定hash・最小env・管理API・失敗分類。任意LispのOS隔離ではない。 |
| 3B: 8技術プリセット・スキル本文 | 部分実装 | 既存8設定/38役割と本文注入試験成功。CL/Svelte実構造能力は未達。 |
| 3C: ヘッド委譲 | 部分実装／実モデル未検証 | 実ビルド入口＋scripted応答で成功。実モデルの自律委譲は未実施。 |
| 3D: 限定編集と検証 | 部分実装 | 既存snapshot/改変検出/単発receipt/鮮度/拒否を維持。OS readonly分離・依存閉包・一般的TOCTOU保証は未実装。 |
| 4: LSP・構文解析 | 部分実装／blocked | TS実LSP成功、既存言語回帰実行。CL/Svelteの実WASM・実ノード座標・pack後受入は未達。Tailwind実hover等も未検証。 |
| 5: 自動導入 | 部分実装／blocked | CL段階構築を追加したがDarwin実導入はDNSで停止。Linuxは選択fixtureのみ。PHP実download、各OSのcold導入、依存inventoryは未完。 |
| 6: 前鬼/TLC | 部分実装／blocked | モデル・cfg・範囲のreceiptを維持。実TLC good/bad未実行。 |
| 7: 後鬼/Lean | 部分実装／blocked | exit0でもunverifiedを維持。推移公理・対象同一性の信頼できる証明検査は未実装。実Lean6件未実行。 |
| 8: 全受入 | 部分実装 | 型検査/build/関連/全体/改変を再実行。58 fail / 8 skip。packed CL/Svelte実文法試験なし。 |
| 9: 過去クラウド結果 | 未検証 | 今回のLinux・実モデル・正式証明の証拠へ流用しない。 |
| 10: 引渡し | 部分実装 | ソース差分と更新検証記録を提供。全受入未達。明示指示により元Macへ反映。commit/pushなし。 |

## 残る制約

- Darwin arm64での実測のみ。Linux/x64の成功を主張しない。選択ロジックの4構成試験はmock。
- `curl --max-time 10 -I https://registry.npmjs.org/tree-sitter-svelte`もDNS失敗。Emscripten/tree-sitter CLI/必要WASMがなく、実文法ビルド・配布・位置検査はblocked。
- 前回のsandbox-exec拒否を迂回していない。今回OS分離は追加していない。hash・監視・プロセスグループ停止を強い隔離とは呼ばない。setsid等で脱出する悪意ある子孫を止める保証もない。
- compiler不在・事前abort・DNS・同時開始・不完全receiptは試験済み。ダウンロード中断からの実再開、20分timeout、native compile失敗、成功した既存導入の実再利用は未検証。
- 実モデル接続による委譲未実施。scriptedの配線成功と分離する。

公式出典: [Roswell release](https://github.com/roswell/roswell/releases/latest)、[Roswell build](https://github.com/roswell/roswell/blob/master/Makefile.am)、[CL-LSP](https://github.com/cxxxr/cl-lsp)、[Lem依存](https://github.com/lem-project/lem/blob/main/qlfile)、[async-process](https://github.com/lem-project/async-process)。公式ソースを調査したことと、生成launcherが実稼働したことを混同しない。

## 元リポジトリへの反映後の検証

ユーザーの明示指示で `/Users/dkc/Sites/Src/mdkh` へ適用済み。新規2ファイルを含む11ファイルの変更で、既存未追跡PLAN.mdを保持。commit/pushなし。

- `npm run typecheck`: 成功。
- `npm run build`: 成功。元リポジトリのdistを再生成。source/distのSHA256は独立コピーと一致。
- `node --test test/language.commonlisp-install.test.ts test/language.lsp.test.ts`: 22件すべて成功。
- ビルド済み `dist/cli/chat.js` / `dist/model/fixed.js` を指定した `node --test test/lisp.cli.test.ts`: 1件成功。
- `npm test`: 435件、369成功／58失敗／8skip。全失敗名・error・codeが独立コピーの最終試験と一致。
- `git diff --check`: 成功。

反映は完了したが、上記の実CL-LSP・実文法・OS隔離・実形式検証などの制約は残る。PLAN全体は未完了。
