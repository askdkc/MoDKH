# 前鬼のStateright試作（履歴）

この試作は `native/stateright` の本実装に移行しました。現在の導入・利用は[Staterightの手順](../../docs/stateright.md)を参照してください。以下は初期のCounterモデル比較の記録です。

Javaを使わず、[Stateright](https://github.com/stateright/stateright)で既存の有限モデルの検証条件と反例を再現する、ソースチェックアウト向けの実験です。Stateright本体は `Cargo.toml`、推移依存は `Cargo.lock` で固定します。

## 実行

Rust/Cargo（[公式導入手順](https://www.rust-lang.org/tools/install)）とMoDKHのNode.js/npm環境を用意し、リポジトリのルートで実行します。

```sh
npm ci
cargo test --locked --manifest-path experiments/stateright-zenki/Cargo.toml
node experiments/stateright-zenki/acceptance.mjs
```

初回のみCargoが依存を取得します。このコマンドはRustの回帰テスト後、MoDKHの実際の `run_command` から成功・失敗の両ケースを実行し、終了コード、JSON判定、探索数、反例を確認します。入力元とRustモデル・lockfileのSHA-256も出力します。

個別に実行する場合:

```sh
cargo run --locked --manifest-path experiments/stateright-zenki/Cargo.toml -- good
cargo run --locked --manifest-path experiments/stateright-zenki/Cargo.toml -- bad
```

`good` は終了コード0、`bad` は反例を検出して終了コード1になります。不正な引数は終了コード2で、検証成功のJSONを返しません。通常チャットからは、このコマンドを実行して結果を確認するよう依頼できます。

## 元モデルとの対応

対象は [Counter.tla](../../test/fixtures/formal/Counter.tla)、[good.cfg](../../test/fixtures/formal/good.cfg)、[bad.cfg](../../test/fixtures/formal/bad.cfg) です。

| 元の条件 | Rust側と期待結果 |
|---|---|
| `Init == x = 0` | 初期状態 `[0]` |
| `Next == /\ x < 2 /\ x' = x + 1` | `Increment` による `0 → 1 → 2`、2からの遷移なし |
| `Good == x <= 2` | 3状態を探索し `passed`、反例なし |
| `Bad == x <= 1` | `failed`、最短反例 `[0,1,2]` と2回の `Increment` |
| `CHECK_DEADLOCK FALSE` | 状態2で停止しても、それだけでは不合格にしない |

反例は独立した算術条件でも再生検査します。元ファイルが変わると対応テストが失敗するため、Rust側の移植を見直す必要があります。実TLCとの並列比較は行っていません。Javaを実行・導入せず、既存ソースの定義と独立した期待値を基準にしています。

## 設計と範囲

前鬼の現在の役割に合わせ、Rustの `Model` が状態・操作・不変条件を持ち、StaterightのBFSが反例を探索します。CLIはその結果をJSONと終了コードに変換し、MoDKHは既存のプロセス実行・停止機構で呼び出します。ACL2への証明方式の変更やTLA+インタープリタの自作は、この試作には含めません。

これは `Counter-v1` だけの手動移植です。任意の `.tla` の読み込み、fairness・時間的性質の互換性、実装との等価性、一般的なモデルの停止保証は提供しません。Rust実装をコンパイル・実行するため、扱うソースとCargo依存は信頼できるものに限ります。

既存の `verify_tla`、`formal.lisp` の `micro-zenki`、ホストの形式検証完了判定はまだTLC経路です。この試作の結果をそこへ自動登録することはありません。npm配布物にも試作は同梱せず、Rustは通常のMoDKH利用には不要です。

本体移行では、検証対象・不変条件をホスト側で固定する入力契約、結果と対象の対応、未完了探索を成功にしない判定、前鬼の委譲と完了確認まで接続する必要があります。今回確認するのは、その前段階の有限モデル探索と実行経路です。
