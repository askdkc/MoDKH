# CL-LSPビルド出力の上限修正（2026-11-16）

ユーザーの `last-failure.json` で、`bundled-runtime-install` のstderrが524,288バイトちょうどで途切れていた。従来の実行器は512 KiBを超えるとプロセス群を停止し、後始末を確認できなかった場合は元の停止原因をunknownで上書きしていた。

CL-LSPのbundled buildのみ、保持上限を16 MiB（16,777,216バイト）へ拡大し、超過時は末尾を保持して処理を続ける方式に変更。総出力量と省略の有無をreceiptに記録する。通常の検証コマンドは従来どおり超過で停止する。timeout/abortと終了処理の確認は両方式で維持。終了処理がunknownでも、元の停止原因をterminationReasonに保持する。

- 17 MiB超のstderrを出す実プロセスがexit0で完了し、末尾16 MiBと完了マーカーを保持する回帰試験に成功。
- 通常の出力量制限による停止、UTF-8境界、tail方式でもtimeoutすること、stderrが満杯でも最後のstdoutを取得できることを確認。
- 関連11試験成功。最終sourceの型検査・build・diff check成功。
- リポジトリ内の検証用snapshotから実CL-LSPを新しいprefix/cacheへ再ビルド。588,347バイトの出力を生成し、exit0・cleanup settled。生成ランチャーの `--help` も成功。LSP初期化・定義応答の検証とは別。

ログ：`.dkh-feasibility/build-output/`。実ビルド後に追加したstdout/stderr間の保持枠調整は、最終の実プロセス回帰試験で確認した。グローバルインストールと、以前cleanupがunknownだった試行の削除・プロセス操作は行っていない。

旧失敗記録が再試行を止める場合は、更新したグローバル版で `modkh language retry commonlisp` を実行してから導入する。commit・pushはしていない。
