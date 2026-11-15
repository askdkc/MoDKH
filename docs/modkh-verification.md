# MoDKH 現在のMacリポジトリでの実装・検証

2026-11-15。**PLAN全体は未完了。** 実装先は `/Users/dkc/Sites/Src/mdkh`、branch `main`、基準HEAD `6b0412d60eae22092048fe756c41f066e10627f9`。開始時の未コミット変更は未追跡の `PLAN.md` のみ。これを保持し、現在のファイルを直接編集した。commit・push・グローバル設定変更は行っていない。

## 前回変更の確認

CL private段階構築、導入失敗/中断/同時導入/cache拒否、LSP通知Promiseのawait、所有process group停止とcleanup失敗伝搬はHEADに存在する。旧パッチを読み、`git apply --check --whitespace=error /tmp/modkh-isolated-u8396o8e/modkh-remaining.patch` を実行したところ既に適用済みのため拒否された。強制適用せず、現在の実装と関連試験を確認した。旧パッチを読んだ以外、今回の実装・試験データは現在のリポジトリ内。

## 今回の変更ファイル

| ファイル | 変更と目的 |
|---|---|
| `scripts/build-grammars.mjs` | 文法欠損・不正WASM header・license不在をbuild失敗にする。全入力確認後にコピーし、途中失敗時に古い成功manifestを残さない。固定のパッケージ版文字列を廃止し、実package metadata、license、各WASMのSHA256を記録。 |
| `src/language/syntax/assets.ts` | 文法IDとmanifest schema/重複/size/SHA256/licenseを確認。古いmanifestや改変ファイルは明示エラー。列挙でも検証できない文法を利用可能としない。 |
| `src/language/syntax/parser.ts` | digest確認済みのバイト列をLanguage.loadへ渡し、確認後に同じパスを再読込しない。 |
| `test/language.grammar-artifact.test.mjs` | 3試験。欠損・破損のbuild拒否、実npm packを展開して同梱WASMでTS/JS/PHP/HTML/CSSを解析、日本語・CRLF位置、改変後のエラーと他文法の正常動作を確認。 |
| `package.json` | 既存全TS試験を維持し、新しいmjs試験も全体suiteに含める。 |
| `test/harness.context.test.ts`, `test/tools.guard.test.ts` | 検索fixtureに独立Git境界を作り、リポジトリ内の除外領域に配置しても親のignore規則を誤継承させない。検索結果のassertは保持。 |
| `test/language.install-fallback.test.ts` | fake npmのCommonJSをbin/package.jsonで明示し、親リポジトリのESM設定に依存しない。元の導入/拒否assertは保持。 |
| `docs/modkh-verification.md`, `docs/modkh-failure-comparison.json`, `docs/modkh-evidence.json` | 今回の結果・比較・source/dist identityを記録。 |

文法は既存12種類のみ。Common Lisp/Svelteの実WASMを追加したわけではない。npm配布packageのdigestはバイト同一性の根拠であり、個々の文法の上流revisionや独立認証の代替ではない。CL/Svelteを他言語文法で偽装していない。

## 実ホストでの到達点

Darwin arm64で実行。CLは新しいprivate領域を `.dkh-feasibility/current-mac/` 配下に作成し、通常のensureInstalled入口を使用。compiler-capabilityは成功、release-metadataは `ENOTFOUND api.github.com` で失敗。失敗receiptを保存し成功stateを作らなかった。Roswell取得以降、CL-LSP initialize/didOpen/lexical定義/global定義/push診断/pull診断は未実行。提供元SBCL readerのno-eval回帰試験は別途成功し、通常フォーム・`#.`・package生成の副作用反例を保持した。

現在の権限で `/usr/bin/sandbox-exec -p '(version 1) (deny default) (allow process*) (allow file-read*)' /usr/bin/true` をbounded実行。exit71、`sandbox_apply: Operation not permitted`、cleanup settled。これは能力確認専用profileであり、製品の隔離実装ではない。強いOS隔離はblocked。拒否を迂回せず、無隔離の実行を強い隔離として報告しない。既存の改変検出と明示的な `private-snapshot-not-os-sandbox` は維持。ネットワーク/秘密/書込み先の完全なOS境界は未実装。

`curl --max-time 10 -I https://api.github.com/repos/roswell/roswell/releases/latest` も名前解決失敗。tree-sitter CLI、Emscripten、wasm-ld、Lean、Roswell、bwrapはPATH上にない。`/usr/bin/java -version` はJava Runtime不在。新規WASM構築と形式runtimeの取得・実行はblocked。Linux実行は行っていない。実モデル接続による委譲も未実施であり、scripted試験と区別する。

## 最終変更後のコマンドと結果

全コマンドのcwdは現在のMacリポジトリ。テストでは `TMPDIR="$PWD/.dkh-feasibility/current-mac/tmp"` を指定。ここは既存の `.gitignore` で除外済み。パッケージ検査用cacheも同じリポジトリ内に限定。snapshotは改変試験だけに使用し、実装先にはしていない。

| コマンド | 結果 |
|---|---|
| `git diff --check` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功。現在のdist再生成、12文法・17スキル。 |
| `node --test test/lisp*.test.ts test/formal*.test.ts test/language*.test.ts test/language.grammar-artifact.test.mjs` | 97件、88成功 / 1失敗 / 8skip。 |
| `npm test` | 438件、372成功 / 58失敗 / 8skip。exit1。 |
| `MODKH_TEST_CHAT=file:///Users/dkc/Sites/Src/mdkh/dist/cli/chat.js MODKH_TEST_FIXED=file:///Users/dkc/Sites/Src/mdkh/dist/model/fixed.js node --test test/lisp.cli.test.ts` | 1成功。scriptedモデル、実SBCL、実Node受入。 |
| `node scripts/modkh-mutation-check.mjs .dkh-feasibility/current-mac/mutations.json` | 既存10改変すべて検出。 |
| `node scripts/modkh-language-probe.mjs typescript /usr/local/bin/typescript-language-server .dkh-feasibility/current-mac/typescript.json --stdio` | 実既存TS LSPの初期化・定義・診断・cleanup成功。latest導入ではない。 |
| `node scripts/modkh-source-identity.mjs .dkh-feasibility/current-mac/identity.json` | source/dist SHA256を保存。scopeは同script。 |

開始時は435件、365成功/62失敗/8skip。前回より増えた4件は、リポジトリ内TMPDIRで親Git除外設定/ESM設定を継承したfixtureの失敗。修正後は全4件が成功。最終58件は前回報告の58件と**試験名・error・codeが一致**し、開始時との比較でも新規失敗0・同名原因変化0。57件はHTTP待受EPERM、1件はwatchのEMFILE。テスト削除や成功偽装はしていない。比較全件は [modkh-failure-comparison.json](modkh-failure-comparison.json)。

関連試験の1失敗は `test/language.integration.test.ts:108` の `the public CLI wires analysis into read_file without any extra flag`。原因は `listen EPERM: operation not permitted 127.0.0.1`。全体58失敗に含まれる同一試験で、追加の59件目ではない。

## 8件のskip（今回も全件未実行）

| 試験名 | 実行時に記録された理由 |
|---|---|
| `real Lean transitive sorry remains unverified even when its consumer is accepted` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean sorry cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean false theorem cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean custom axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean generated axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean true theorem is accepted/unverified` | Official Lean executable not supplied |
| `real TLC good.cfg` | Java/TLC host settings not supplied |
| `real TLC bad.cfg` | Java/TLC host settings not supplied |

Lean/Javaの実runtimeを得られていないため解消できていない。wrapperやfake compilerの成功を実Lean/TLC成功と呼ばず、Leanはexit0でもunverifiedを維持。TLCのモデル・cfg・検査範囲の証跡も維持する。

## 元PLANと追加要求の状態

| 項目 | 分類 | 根拠・残件 |
|---|---|---|
| 0–2: 編集先・既存確認・初期測定 | 完了 | 現在のmainを直接編集。既存PLAN保持。 |
| 3A: 実Lisp設定 | 完了（既存限定契約） | 実SBCL回帰成功。OS sandboxの保証ではない。 |
| 3B: プリセット・スキル本文 | 部分実装 | 既存設定/全文注入を再検証。CL/Svelte実構造能力未達。 |
| 3C: ヘッド委譲 | 部分実装／未検証 | ビルド済みscripted入口は成功。実モデル未実施。 |
| 3D: 編集担当と受入検証器 | 部分実装／blocked | 既存snapshot/鮮度/改変/receiptを維持。Mac隔離機構は拒否。Linux実分離なし。 |
| 4: LSP・文法 | 部分実装／blocked | 既存WASMのbuild・配布・digest検査とpack実試験を追加。CL/Svelte実文法・埋込位置・上流revision/license受入は未達。 |
| 5: 自動導入 | 部分実装／blocked | 前回bootstrapはHEADに反映済み。実CL冷開始はDNSで停止。各OS成功・依存閉包・global意味解析は未検証。 |
| 6: TLC | 部分実装／blocked | wrapperと範囲receiptは保持、実runtimeなし。 |
| 7: Lean | 部分実装／blocked | 未検証分類と反例試験を保持。実runtime/対象同一性/推移公理の正式検証は未達。 |
| 8: 全受入 | 部分実装 | 最終コマンド実行済みだが58fail/8skip。 |
| 9: 過去Linux試作 | 未検証 | 今回の成功証拠に流用しない。 |
| 10: 引渡し | 部分実装 | 現在のgit diffで確認可能。全受入未達を明示。 |

現在のdistは更新・入口検証済み。グローバルインストールや稼働中のハーネスは更新していない。[機械判読証跡](modkh-evidence.json)にidentity、実CL失敗、OS拒否、改変結果、ログhashを保存。全PLAN完了・全体green・実CL導入成功は主張しない。
