# MoDKH名前空間への統一

旧DKHから独立した保存先と識別子へ変更しました。ユーザーの既存データやグローバルインストールは変更していません。旧設定の暗黙フォールバック・移行はありません。

| 対象 | 新しい値 |
|---|---|
| 設定・認証・セッション・言語cache | XDG_CONFIG_HOME/modkh（既定 ~/.config/modkh） |
| 保存先指定 | MODKH_HOME |
| 行入力モード | MODKH_PLAIN |
| ワークスペース記録 | .modkh/sessions |
| ワークスペーススキル設定 | .modkh/skills.json |
| Lisp設定package | :modkh |
| 組込み担当ID | modkh-worker、modkh-explorer |
| CLI・LSP/MCPクライアント識別名 | modkh |

初回は /connect で新しい保存先に接続を設定してください。独自Lisp設定は (in-package :modkh) に変更し、内容確認後にtrust hashを取り直します。旧 .dkh や ~/.config/dkh は削除しません。

ソース・全プリセット・組込みplugin・利用手順・試験と受入スクリプトの参照を更新。名前の由来 Mixture of DKH、第三者の同梱スキル原文・hash、過去の検証記録、旧環境を模した回帰fixture、除外済みの検証領域 .dkh-feasibility は履歴/出典として保持しています。

## 検証（macOS arm64）

- npm run typecheck / npm run build / git diff --check: 成功。
- 保存先・workspace記録・skills・plugin lifecycle・実SBCL設定: 26成功。
- npm test: 448件、382成功、58失敗、8skip。58件の試験名/error/codeは前回記録と一致、新規失敗なし。全体成功とはしません。
- 実ビルドCLIをfixed/scriptedで起動し、.modkh/sessionsに記録を作成。.dkhは未作成。意図的に指定した旧DKH_HOMEのmarkerだけが残り、そこへ追加書込みなし。
- 全体suite内のpacked artifact試験も成功。実モデル委譲・実CL-LSPの完了を示すものではありません。
- CIは未pushのため未実行。既報のCI SBCL導入漏れは今回の名前空間修正とは別の未修正事項です。

source digest: 3bbfb42d5b84b768875e16cbcb9bb1ccd56b500badeb84466ffcb380237c4641

built dist digest: b16931ac24bad5cf1d779b5bf8875c7b8b3e188b44b516bc94b917fddf6896ca

既存グローバルコマンドにはまだ反映していません。READMEの手順で再pack・導入が必要です。commit/pushなし。
