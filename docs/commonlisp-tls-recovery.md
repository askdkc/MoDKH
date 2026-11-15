# macOSのQlot / CL+SSL修正（2026-11-16 JST）

対象は `/Users/dkc/Sites/Src/mdkh`、Darwin arm64。既存のロゴ変更とREADMEの編集用ファイルには触れていない。

## 原因と変更

ユーザーの `last-failure.json` の `lem-dependencies` には、`The alien function "ASN1_STRING_data" is undefined.` が記録されていた。今回の直接原因はDNSではない。Qlotが案内した詳細ログは、MoDKHの失敗後cleanupによって既に削除されていた。

このMacの `/opt/homebrew/opt/openssl/lib/libcrypto.dylib` は `ASN1_STRING_get0_data` を提供するが `ASN1_STRING_data` を提供しない。CL+SSLの実ソースは後者を使用する。標準の選択で実SBCLから同じエラー（exit1）を再現した。

- macOSのHomebrew配下にあるOpenSSLのペアを探索し、別プロセスで実ロードして必要なAPIを確認する。バージョン番号で合否を決めない。今回は標準のライブラリを拒否し、既存の `/opt/homebrew/Cellar/openssl@3/3.5.9/lib` を選択した。コードにこの版は固定していない。
- CL+SSLの公式設定APIでライブラリの実パスを指定し、再コンパイルして、別ライブラリ向けのコンパイル済み条件分岐を持ち越さない。Qlotは設定を読み込んだRoswellプロセスから呼ぶ。CL-LSPの起動準備にも同じ設定を渡す。
- コンパイル出力はstderrに流し、LSPのstdoutを汚さない。証明書検証の無効化、HTTPへの置換、Homebrewのリンク変更は行わない。
- 失敗時の `qlot-error-*.log` は、通常ファイルかつ2 MiB以下のものを `last-failure.json` の `diagnostics` に保存してから作業領域を削除する。

参照した実ソース：[Qlot HTTP](https://github.com/fukamachi/qlot/blob/master/src/http.lisp)、[CL+SSL FFI](https://github.com/cl-plus-ssl/cl-plus-ssl/blob/master/src/ffi.lisp)、[CL+SSLライブラリ選択](https://github.com/cl-plus-ssl/cl-plus-ssl/blob/master/src/reload.lisp)。ローカルCL+SSLの `src/config.lisp` で明示設定APIも確認した。

## 最終検証

- 実SBCL / 実CL+SSL：標準設定は同じ未定義関数エラー。生成した修正設定ではASN1文字列を作成し、`ASN1_STRING_data` を呼び、解放してexit0。stdoutは専用成功証跡のみ。この試験はローカルASDF依存を使用し、Quicklispのダウンロードは行っていない。
- `npm run typecheck`、`npm run build`、`git diff --check`：成功。
- `node --test test/language.commonlisp*.test.ts`：21成功。ロード対象のAPI欠損、未完了出力、TLS設定の順序、失敗ログ保存を含む。
- `npm test`：456件、390成功・58失敗・8skip。履歴 `qlot-exit-fix/full-final.log` と58件の試験名・error・codeが一致。HTTP待受EPERM57件、watch EMFILE1件。変更直前の新規実行との比較ではない。
- skipはLean6件とTLC2件で、必要runtimeまたは設定がない既存試験。

詳細ログとsource/distの同一性記録：`.dkh-feasibility/tls-fix/`。最終sourceからdistを再ビルドした。グローバル版の更新・commit・pushはしていない。

CL-LSPの冷開始からの依存取得、initialize、定義参照、診断までの通し試験は今回未実施。今回実証したのは、このMacでのCL+SSLエラーの再現と解消、導入コードへの接続、回帰試験の範囲。Linuxの実ライブラリ試験は行っていない。PLAN全体は未完了。
