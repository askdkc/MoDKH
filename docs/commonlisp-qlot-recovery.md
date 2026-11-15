# CL-LSP導入のQlot判定修正

2026-11-15、`/Users/dkc/Sites/Src/mdkh`、HEAD `018c1bc` に対する未コミット変更。Darwin arm64。開始時の作業ツリーはclean。

## 実測と修正

ユーザー環境の `last-failure.json` はQlot bootstrap成功後、`qlot-capability` が stdout `Qlot 1.8.4\n`、stderr空、exit255、cleanup settledで停止していた。

[Qlot CLI](https://github.com/fukamachi/qlot/blob/master/src/cli.lisp) の `--version` は `print-version` 後に `(uiop:quit -1)` を呼ぶ。この終了を導入失敗と扱ったMoDKH側のバグ。255全般を許容せず、RoswellからASDFの `qlot/cli` ロード、関数の存在、版情報付き専用証跡を確認する方式に変更した。正常終了と終了処理の確認も必要。

[async-process ASD](https://github.com/lem-project/async-process/blob/master/src/async-process.asd) は `src/` にあり、[GNUmakefile](https://github.com/lem-project/async-process/blob/master/GNUmakefile) は親にある。旧コードはASDのディレクトリでmakeしていた。所有領域内の実ソースからビルド入口を探索し、欠落時は拒否する。Autoconf・Automake・Libtoolの能力確認を追加。macOSではHomebrewのglibtoolizeを確認する。

失敗メッセージにstdoutとcleanupを追加。定義参照probeは空白のcharacter16から、参照するvalueの開始位置17に修正した。ただし実CL-LSPでの定義応答は今回未検証。

## 検証

- `npm run typecheck`: 成功。
- `npm run build`: 成功、文法12件・スキル17件。同じsourceからdistを再生成。
- `node --test test/language.commonlisp*.test.ts test/language.roswell-archive.test.ts`: 最終変更後19成功。
- 実SBCLの回帰試験で旧version判定が255になること、新しい生成probeがfixture CLIをロードして専用証跡を返すことを確認。実Qlot全体の再導入試験とは区別する。
- `npm test`: 最終変更後452件、386成功・58失敗・8skip。
- 58失敗は履歴ログ `namespace/full.log` と試験名・error・codeを重複も含め照合し一致。57 HTTP EPERM、1 watch EMFILE。変更直前の全体再実行との比較ではない。
- skipはLean6件（transitive sorry、sorry、false theorem、custom axiom、generated axiom、true theorem）、TLC2件（good.cfg、bad.cfg）。必要runtime/設定なし。
- `git diff --check`: 成功。

再ビルド済み `dist/language/commonlisp-install.js` から、リポジトリ内の空の専用領域に実導入を試行。`release-metadata` で `ENOTFOUND: getaddrinfo ENOTFOUND api.github.com`。ユーザーのQlotまで進んだ実行とは別の制限。実CL-LSP起動・同期・定義・診断は未検証。Linux実機も未検証。PLAN全体は未完了。

ログは `.dkh-feasibility/qlot-exit-fix/`。source SHA256: `6b47e6ef35178575382eb62e57ebdc91e333c688b2033d9a652a02f095fedf50`。dist SHA256: `10376e47264238d2eda156d78f2ca81a1ca5b7265da9fff5a251dfab4839fe48`（`scripts/modkh-source-identity.mjs`）。グローバルインストール・commit・pushは行っていない。
