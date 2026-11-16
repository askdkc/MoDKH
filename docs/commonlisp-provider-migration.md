# Common Lispサーバー切替（2026-11-16）

現在のMacリポジトリで、自動導入元を `askdkc/cl-lsp` に変更。

- 専用領域に新しいcheckoutを取得し、付属 `scripts/install-headless.ros --prefix` で構築する。依存は `vendor/`。取得revision、同梱ソース一覧・installer・launcherのdigestを記録。
- 旧Lemの追加取得、Qlot、独自ASDFレジストリ修復、Autotools、CL+SSL/OpenSSL選択コードを削除。不要になった専用テストを、新しい導入契約と失敗経路のテストに置換。
- 旧提供元の成功receiptを再利用しない。旧提供元の失敗キャッシュで新しい導入を停止させない。autoInstall=falseは従来どおり通信・書込みを行わない。
- 実initialize、ファイル同期、定義応答によるready判定、未評価global定義と診断の観測、SBCL補助診断の非評価境界は維持。
- 手動手順は `ros install askdkc/cl-lsp`。既存のグローバル設定やインストールは変更していない。

## 検証

Darwin arm64。既存のローカル `askdkc/cl-lsp` checkout（clean、revision `594f9be291159e146fc2d51d3c3b56f93f227a7c`）をリポジトリ内の検証専用snapshotにコピー。private HOME/ROSWELL_HOMEと既存のsystem SBCLで、新しいMoDKH導入関数を実行し、ネイティブ/Lispビルドと生成ランチャーの `--help` が成功した。ネットワークからの冷開始取得試験とは区別する。

生成ランチャーを実LSPクライアントから `--stdio` で起動。最初の8秒期限では初期化が完了せず、45秒期限で再確認すると `USOCKET:OPERATION-NOT-PERMITTED-ERROR` が記録された。内部ソケットが実行環境に拒否され、initializeはタイムアウト。両試行とも終了処理は確認済み。同期・定義・診断の実応答には到達していない。未応答をreadyに変更していない。

- 最終sourceの型検査・build・`git diff --check`：成功。dist再生成済み。
- Common Lisp・Roswell関連：17成功。
- 全体：450件、384成功・58失敗・8skip。58失敗は履歴 `ci-repair/full-final.log` と試験名・error・codeが一致（HTTP EPERM57、watch EMFILE1）。旧依存処理の削除に伴い全試験数は減っている。
- Linux実動作、ネットワークからの全自動導入、グローバル版への反映は未検証／未実施。PLAN全体は未完了。

証跡：`.dkh-feasibility/askdkc-cl-lsp/`（build-receipts.json、lsp-45s.json、full-final.log、comparison.json、identity.json）。commit・pushは行っていない。
