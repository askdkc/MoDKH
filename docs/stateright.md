# 前鬼とStateright

前鬼は[Stateright](https://github.com/stateright/stateright) 0.31.0による有限状態探索を使います。MoDKH同梱のRustソースから専用コマンド `modkh-stateright` を構築します。

## 導入・更新

[Rust公式手順](https://rust-lang.org/tools/install/)でRust/Cargoを用意し、`cargo --version` を確認します。macOSではビルド用のCommand Line Toolsも必要です。

```sh
modkh stateright install
modkh stateright status
modkh
```

初回ビルドには依存取得のネット接続が必要です。導入先は `~/.config/modkh/stateright/bin/modkh-stateright`（`MODKH_HOME` 指定時はその配下）です。次の起動で前鬼が自動登録されます。通常チャットでは親モデルに状態遷移や不変条件の検証を依頼してください。`/agents` に `modkh-micro-zenki` が表示されます。明示的に無効化した担当は自動で有効に戻しません。

更新時も同じinstallコマンドを使います。管理領域の検証器を優先し、なければPATH上の `modkh-stateright` を探します。独自の配置には `modkh --stateright /absolute/path/to/modkh-stateright` を使えます。RustライブラリがCargoのキャッシュにあるだけでは導入済みとは扱いません。

## モデルJSON

```json
{
  "schemaVersion": 1,
  "states": ["idle", "running", "done"],
  "initial": ["idle"],
  "transitions": [
    {"from": "idle", "to": "running", "action": "Start"},
    {"from": "running", "to": "done", "action": "Finish"}
  ],
  "invariants": [{"name": "ValidState", "allowedStates": ["idle", "running", "done"]}],
  "checkDeadlocks": false
}
```

全フィールド必須です。状態と遷移を明示し、各不変条件の許容状態を列挙します。到達可能な状態を幅優先探索し、許容状態から外れたら反例の状態列と操作列を返します。上記で `done` を許容状態から除けば反例になります。`checkDeadlocks: true` では、出る遷移がない到達状態も不合格です（正常な終端を含むため、モデルの意図に応じて指定してください）。

入力上限256KiB、状態1〜10,000件、不変条件1〜64件、遷移50,000件以下。検証時間は最大30秒です。未知のフィールド、重複名、存在しない状態への参照は拒否します。探索完了時のみpassedとし、反例はfailed、中断・時間切れ・不正な出力はunverifiedです。入力SHA-256を実行記録に結び付け、反例の遷移と違反をホストでも照合します。

親からは `run_subagent` に `pluginId: "modkh-micro-zenki"` と `formalInput: {"path": "Model.json"}` を渡します。Lisp正式プリセットでは担当IDは `micro-zenki` です。

## 旧TLC設定からの移行と範囲

`verify_tla`、`--java`、`--tla-jar` は廃止しました。TLA+/cfgの自動変換はありません。対象の状態・遷移・不変条件をJSONに書き直し、`verify_stateright` を使います。Lispは `(set-head-check-inputs "Model.json" "Proof.lean")` に変更し、設定のSHA-256を取り直してください。

検証するのはこの有限モデルだけです。公平性・時相論理・無限状態の証明、実装との等価性は扱いません。モデルの仮定と実装への対応をレビューし、実装の通常テストも併用してください。後鬼のLean検証は独立して利用できます。
