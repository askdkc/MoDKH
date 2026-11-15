# サブエージェント・プラグイン

## 使う

```text
/connect fixed/scripted
/agents
/agents run dkh-explorer 調査する内容
/agents run dkh-worker 実装する内容
```

`/agents run` だけなら種類と依頼を選択・入力できます。`fixed/scripted` はオフライン検証用の固定手順で、依頼に応じて推論するモデルではありません。通常の作業では `/connect` で利用するモデルを接続してください。

- **dkh-explorer**: 列挙・検索・読み取りのみ。編集、シェル、再委譲は実行できません。
- **dkh-worker**: 親が持つファイル・コマンドツールを利用します。編集・コマンドごとの承認は省略しません。
- 承認にはプラグインIDと子IDが表示されます。拒否やCtrl+Cで中断でき、終了後は入力に戻ります。
- 親セッションの子は同時に1つ、深さは1段。親は結果保存・後片付けを待ちます。別DKHプロセスとの編集排他は保証しません。
- 子は独立したモデルと履歴を持ちます。親の全履歴、記憶、認証キーをプロンプトへ自動コピーしません。
- `completed` / `ok` は実行終了であり、依頼達成やテスト合格の証明ではありません。

モデル向けの入口は `list_subagents` と `run_subagent({ pluginId, task, context? })` です。子には委譲ツールを渡しません。モデルからのインストール・有効化も許可しません。

## ローカルパッケージを登録する

```sh
dkh plugin add ./my-reviewer
dkh plugin list
dkh plugin disable my-reviewer
dkh plugin enable my-reviewer
dkh plugin remove my-reviewer
```

登録時には内容のSHA256と警告を確認し、信頼する場合のみ `y` を入力します。登録と一覧表示ではESMをimportしません。起動前に保存した内容のdigestを再確認し、改変・無効化・重複IDは拒否します。更新は実行終了後に登録解除し、新しい内容を改めて信頼・登録してください。登録解除は監査用パッケージや会話履歴を削除しません。

有効・無効の変更は新しい子の起動時に検査します。受理済みの実行を消しません。子モデル・ツールの設定変更はDKHを次に起動したときに読み込みます。組み込みは無効化できますが、削除できません。

**プラグインは任意のNode.jsコードです。OSサンドボックスではありません。** 信頼するコードだけを登録してください。管理APIを使わずにファイルやネットワークへアクセスする悪意あるコードを防ぐ仕組みではありません。npm取得、依存解決、インストールスクリプト、HMRはありません。

## パッケージ形式・local API

パッケージは自己完結したディレクトリです。以下は作成するファイルの例です。

`plugin.json`:

```json
{
  "apiVersion": 1,
  "id": "my-reviewer",
  "version": "1.0.0",
  "title": "Reviewer",
  "description": "変更を読み取り、問題点を報告する",
  "kind": "local",
  "entry": "./index.mjs"
}
```

`index.mjs`:

```js
export function define() {
  return {
    system: "変更を読み取り、確認できた問題と未確認事項を区別して報告する。",
    tools: ["list_files", "search_files", "read_file"]
  };
}
```

`define()` は同期関数です。実行用の状態・プロセスを作らず、定義データを返してください。公開型は `import type { LocalPlugin, ExternalPlugin } from 'modkh/plugin-api'` で利用できます。

IDは英小文字始まりの小文字英数字・ハイフンで64文字まで。`dkh-` は予約済み。API版は整数 `1` のみ。未知フィールド、範囲外entry、シンボリックリンクは拒否します。entryはパッケージ内の `.js` または `.mjs` です。

上限はmanifest 64 KiB、パッケージ10 MiB・1,000エントリ（ディレクトリを含む）、深さ32。依頼32 KiB、補足128 KiB、結果テキスト64 KiB。切り捨てずエラーにします。子には120秒で停止を要求します（後片付け時間は別）。ローカルモデルは既存ループの最大25ターンです。

## 子モデルとツール制限

設定は `DKH_HOME/config.json`、未指定なら `XDG_CONFIG_HOME/dkh/config.json`、さらに未指定なら `~/.config/dkh/config.json` です。既存の `memory` 設定を残して `subagents` を追加してください。

```json
{
  "subagents": {
    "dkh-explorer": { "tools": ["read_file", "search_files"] },
    "my-reviewer": { "model": "fixed/scripted", "tools": ["read_file"] }
  }
}
```

実際のツール集合は **親の許可 ∩ ユーザー設定 ∩ プラグイン要求**。空配列ならツールを許可しません。不正な種類別設定はその種類を無効にして診断を表示し、設定全体が壊れている場合は子の起動を無効にします。通常の会話は利用できます。

モデル未指定なら親の現在の接続（接続先URLとセッション内の認証を含む）から別モデルを生成します。子モデル指定はユーザー設定のみ。モデルの引数による接続先の変更は拒否します。Hermesのサーバー側ツールをlocal子の権限で制御できないため、Hermesをlocal子モデルには使えません。既存の親のHermes接続は変更しません。

## external API

manifestの `kind` を `external` にします。

```js
export function start(request, host) {
  const result = host.run({ command: "node", args: ["--version"] })
    .then(receipt => ({ text: receipt.output }));
  return { result, async stop() { /* 自前のリソースも終了させる */ } };
}
```

`start` はPromiseでハンドルを返しても構いません。ホストから渡すのは依頼・明示的な補足と、`signal` / `run` だけです。親の履歴や管理オブジェクトは渡しません。

外部実行を開始する承認と、`host.run({command, args})` の個別承認は別です。コマンドの作業場所は固定され、引数はシェル展開されないよう引用します。親とユーザー設定に `run_command` が必要です。子プロセスへ引き継ぐ環境変数はPATH/HOME/TMPDIR/LANG/LC_ALLのみ。ただし信頼済みコードや外部CLI自身による認証ファイルへのアクセスを隔離するものではありません。

ホストは未awaitの管理プロセスも回収します。非ゼロ終了や結果不明を、プラグインが成功テキストを返しても正常扱いしません。終了時は `stop()` を呼び、3秒で回収を確認できなければ後片付け不明にします。リモート処理の停止や、管理API外のプロセス停止は保証できません。

同一Node.jsプロセス内のプラグインには協調的な停止が必要です。非同期importの中断はコードのアンロードではなく、結果と後片付けを `unknown` にします。同期的にイベントループを占有するコードを強制停止する隔離機構はありません。

## 記録・再起動・障害

親と子の履歴は別のJSONLです。親の委譲イベントに親子ID、実行ID、要求digest、プラグイン版・digest、モデル参照、ルート、親／ユーザーの権限上限とlocal子の実効ツール、結果・後片付け状態を保存します。APIキーは保存しません。

- 同じcall ID・同じ依頼は保存結果を返し、変わった依頼は競合になります。
- 要求だけ残った実行や `unknown` を、新しいcall IDや別プラグインで自動再送しません。
- 再起動は子を自動再開しません。完了済み結果の閲覧に、削除済みプラグインのロードは必要ありません。
- 取得済み出力は子の履歴にも残します。親の結果保存失敗は成功扱いせず、未確定記録を保持します。
- 既存v1ログは書き換えず、必要に応じてv2形式イベントを追記します。旧DKHへのダウングレード後の再開は非対応です。

登録データは設定ディレクトリ内の `plugins/catalog.json`、保存パッケージは `plugins/packages/ID/DIGEST`、実行leaseは `plugins/leases/ID/` にあります。leaseにはDKHプロセスのPIDとdigestが含まれます。クラッシュ時のlease・カタログロック・未完了stagingは自動削除しません。未確定のleaseがある種類の登録解除は拒否します。

不明な実行は、親子の記録、コマンド、対象ファイル、外部・リモート処理を確認してください。履歴を書き換えて成功扱いしたり、確認なしにロックやleaseを削除したりしないでください。初版には自動復旧・lease照合コマンドはありません。停止と影響を確認したうえで、新規の実行が必要か判断します。

## 検証

```sh
npm run typecheck
npm test
npm run build
sh scripts/acceptance.sh
```

受け入れ検証はtarballを隔離インストールし、インストールしたCLIから組み込み・追加local・external fixture、選択、個別承認、拒否、Ctrl+C後の入力復帰、無効化・登録解除、公開型の消費を確認します。実サービスの認証、Codex/Claude Code/ACP等の実製品アダプター、実PTY・スクリーンリーダーはこの検証に含みません。
