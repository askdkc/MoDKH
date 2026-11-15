# MoDKH 最終ソースの検証記録

2026-11-15。**PLAN全体は未完了。** 編集先 `/Users/dkc/Sites/Src/mdkh`、branch `main`。基準HEAD `3e2ae09e40e85d27154a4ccdcda5831ae04544d3`。開始時git statusはclean。現在のリポジトリを直接編集し、既存PLANを変更していない。commit/push/グローバル環境の更新なし。CL構築・通知EPIPE・process cleanupと前回文法digest検査はHEADに存在し、再適用していない。

## 今回の直接変更

| ファイル | 内容 |
|---|---|
| `src/subagents/verification.ts` | ホスト所有の隔離要件を追加。requiredなら検証器を起動せずnot-executed/unavailable/not-started receiptを返す。source適用なし。receipt digestに隔離方針も含める。 |
| `src/subagents/service.ts`, `src/cli/chat.ts`, `src/index.ts` | `--verification-isolation required\|integrity-only` を入口からホスト検証まで伝搬。不正値拒否。子のrequestやplugin定義には変更権限なし。 |
| `test/lisp.edit-service.test.ts` | required時の対象外marker非作成、承認呼出しゼロ、source未適用、JSON保存/再読後の終了状態・digest保持、receipt再利用拒否。 |
| `test/lisp.cli.test.ts` | 実入口でrequired拒否がheadへ返る試験を追加。両policyで子の実model requestへの2スキル全文、source digest、構造化receiptをassert。 |
| `test/language.grammar-artifact.test.mjs` | packed artifactから8技術＋formalの9presetを実SBCLで評価。同じartifactの入口とスキルを使った子の編集/検証/拒否を実行。 |
| `scripts/modkh-mutation-check.mjs` | required拒否を削除する改変試験を追加。既存10種を維持。 |
| `scripts/modkh-language-probe.mjs` | PHPの不正コードに対する実push/pull診断を別記録。空診断で成功にしない。PHP定義位置を呼出し箇所へ修正。 |
| `docs/modkh.md`, 本書、比較JSON、証跡JSON | 使用方法、方針の限界、現在の証拠に更新。 |

### 隔離方針の契約

```sh
node dist/index.js chat --lisp-config agents.lisp \
  --trust-lisp-sha256 REVIEWED_SHA256 --verification-isolation required
```

現在は検証済みOS backendがないためrequiredは常に未実行を返す。**OS隔離そのものを実装したという意味ではない。** 無隔離への自動降格はない。互換既定値integrity-onlyは既存のsnapshot/鮮度/manifest検査を維持し、`private-snapshot-not-os-sandbox` と明示。信頼したコード専用で、OS書込み防止・秘密保護ではない。`os-enforced`を返す経路はない。信頼Lisp設定自体の任意コード実行もこの方針のsandbox対象ではない。

## 実測と未達

- **CL-LSP**: 新規private領域・通常ensureInstalled入口で再試行。compiler確認後、`api.github.com` のDNSがENOTFOUND。取得以降は未実行で、initialize/同期/lexical/global定義/push/pull診断は未検証。成功stateを作らない。既存SBCL reader副作用反例は関連suiteで成功。
- **実CL/Svelte文法**: `registry.npmjs.org` DNS失敗。CL/Svelte WASMと構築ツール未取得。既存12WASM・整合性試験を維持。CL/Svelteの実ノード/埋込座標/ABI/上流revision/license受入は未完了。
- **OS隔離**: sandbox-execで最小profile＋`/usr/bin/true`を再probeしexit71、`sandbox_apply: Operation not permitted`。cleanup settled。能力probeは製品backendではない。権限変更・迂回なし。Linux実機試験なし。
- **watch EMFILE**: 新しいNodeプロセスで空fixtureディレクトリへのfs.watchを1個だけ作るprobeもEMFILE。全体suiteの並行負荷がなくても失敗する。これだけでOS制約の内部原因まで確定したとは言わない。元の子孫停止試験を削除せず失敗として保持。
- **PHP実LSP**: `/opt/homebrew/bin/phpantom_lsp`で初期化・hover・定義参照成功。構文エラー入りファイルはpull応答が空、push通知0。診断品質の受入は未達。空の有効pull reportというプロトコル事実と「エラーなし」は別。実binary digestを保存。
- **Tailwind実LSP**: `/opt/homebrew/bin/tailwindcss-language-server --stdio` を新規fixtureからcold起動。FSEvents stream起動失敗、hover null、診断waiting。定義済みselectorの配線は通っても実hover受入は未達。
- **TS実LSP**: 既存 `/usr/local/bin/typescript-language-server --stdio` で初期化・定義・型不一致診断・終了確認成功。latest cold installではない。
- **実モデル**: 設定にollama-cloudのモデルがあることだけ確認。`ollama.com` DNS解決失敗。自律委譲は未実施。資格情報の有効性は未確認で、scripted成功とは分離。
- **LSPファイル変更監視**: 現行client/registerCapabilityはACKのみ。実監視は未実装で、今回も完了扱いにしない。8技術すべての実機能成功は未達。

## 最終変更後のコマンド

cwdは現在のリポジトリ、テストでは `TMPDIR="$PWD/.dkh-feasibility/final-plan/tmp"` を指定。既存除外領域内でfixture・private導入・ログ・改変試験snapshotを作成。snapshotを実装保存先にしていない。

| コマンド | 結果 |
|---|---|
| `git diff --check` | 成功 |
| `npm run typecheck` | 成功 |
| `npm run build` | 成功、現在のdistを再生成。12文法/17スキル。 |
| `node --test test/lisp*.test.ts test/formal*.test.ts test/language*.test.ts test/language.grammar-artifact.test.mjs` | 99件: 90成功 / 1失敗 / 8skip |
| `npm test` | 440件: 374成功 / 58失敗 / 8skip、exit1 |
| ビルド済みchat/fixedをMODKH_TEST_CHAT/MODKH_TEST_FIXEDで指定した `node --test test/lisp.cli.test.ts` | 2成功。scriptedモデル/実SBCL/実Node検証またはrequired拒否。 |
| `node scripts/modkh-mutation-check.mjs .dkh-feasibility/final-plan/mutations.json` | 既存10＋required拒否削除1、11件すべて検出 |
| `node scripts/modkh-language-probe.mjs typescript /usr/local/bin/typescript-language-server .dkh-feasibility/final-plan/typescript.json --stdio` | 成功 |
| 同probeのphp `/opt/homebrew/bin/phpantom_lsp` / tailwind `/opt/homebrew/bin/tailwindcss-language-server --stdio` | いずれもunverified、exit1。上記の範囲のみ実測。 |
| `node scripts/modkh-source-identity.mjs .dkh-feasibility/final-plan/identity.json` | 最終source/dist SHA256記録 |

開始時438件:372成功/58失敗/8skip。最終440件:374成功/58失敗/8skip。全58件の試験名・error・codeが一致。新規・消失・同名原因変化いずれも0。[全件比較](modkh-failure-comparison.json)。HTTP待受EPERM57件、watch EMFILE1件を成功に置き換えていない。

関連suiteの1失敗は `test/language.integration.test.ts:108` の `the public CLI wires analysis into read_file without any extra flag`。`listen EPERM: operation not permitted 127.0.0.1` であり、全体58件に含まれる。

## 8件のskip（全件未実行）

| 試験名 | 実行時の理由 |
|---|---|
| `real Lean transitive sorry remains unverified even when its consumer is accepted` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean sorry cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean false theorem cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean custom axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean generated axiom cannot be certified by compiler acceptance` | Official Lean executable unavailable; real kernel/counterexample tests not run |
| `real Lean true theorem is accepted/unverified` | Official Lean executable not supplied |
| `real TLC good.cfg` | Java/TLC host settings not supplied |
| `real TLC bad.cfg` | Java/TLC host settings not supplied |

LeanはPATH上に見つからず、`/usr/bin/java -version` はJava Runtime不在。取得もネットワークでblocked。安全な初版のaccepted/unverifiedを維持し、fake compiler結果を実証明と呼ばない。TLC model/cfg/範囲receiptを保持するが実runtimeは未検証。

## 原PLAN・追加要求の棚卸し

| 対象 | 分類 | 根拠／残る条件 |
|---|---|---|
| 0–2: 編集先と基準 | 完了 | 現在Macに直接反映、基準測定・既存差分保持。 |
| 3A: 実Lisp設定 | 完了（限定契約） | 実SBCL、信頼hash、未知/重複/原子性、timeout回帰。追加loadの信頼は入口hashでは保証しない。 |
| 3B: preset/必須スキル | 完了（配布・注入）／実能力は部分実装 | packed9preset実評価、子model requestへの本文一致。CL/Svelte能力は未達。 |
| 3C: 委譲・迂回拒否 | 部分実装／実モデルblocked | packed実入口、head直接edit/shell/formalなし、子限定ツール、未検証を完了にしない回帰。自律モデル未実施。 |
| 3D: 編集・独立検証 | 部分実装／OS隔離blocked | 強い隔離必須時の非実行を追加。既存改変/鮮度を維持。OS readonly依存閉包・全競合保証なし。 |
| 4: LSP/Tree-sitter | 部分実装／blocked | TS実応答、PHP定義成功。PHP不正診断/Tailwind hover/実watch/CL・Svelte実文法未達。 |
| 5: 自動導入 | 部分実装／blocked | private構築ソース・失敗回帰あり。CL冷導入DNSで停止。Linux実導入なし。 |
| 6: 前鬼 | 部分実装／blocked | preset/配布/ツール分類確認。実TLC2件未実行。 |
| 7: 後鬼 | 部分実装／blocked | accepted/unverified維持。実Lean6件未実行。形式検証の実モデル委譲未実施。 |
| 8: テスト受入 | 部分実装 | 最終一式実行。58失敗/8skip残。 |
| 9: 過去Linux結果 | 未検証 | 今回の実測へ流用しない。 |
| 10: 引渡し | 部分実装 | git diff、証跡、制約を保存。全PLAN受入は未達。 |

新規create/rename/deleteと複数ファイルの安全な適用は既存仕様上未対応、既存1ファイルの編集・変更なしverified/unverifiedを区別。host receiptをJSON保存/再読して終了状態・source digestが保持されることを実入口でassertしたが、ディスク改ざんへの署名検証を実装したという意味ではない。

[証跡JSON](modkh-evidence.json)に最終source/dist identity、各実サーバー、host probe、11改変、ログhashを保存。source更新・build済みdist・実入口試験は現在のリポジトリに反映済み。グローバルコマンドや稼働中のハーネスは更新していない。

次に必要なのは、公式配布元へ到達できる許可済みネットワーク、実WASM構築toolchain/artifact、許可されたOS隔離backend、Lean/Java/TLC runtime、モデルへの利用可能な接続。これらを取得/実測するまでは当該項目を完了に変更しない。
