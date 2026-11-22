---
name: pstack
description: pstack（poteto-mode）の厳格な作業手順。速く進むために先に深く潜り、書く量を減らして品質を上げる。pstack・poteto-mode の指定、またはこの作業規律で進める指示のときに使う。原則・プレイブック・補助手順を参照資料に持つ。
---

# pstack

「if you want to go fast, go deep first」。成果物はより少ないコードで、より高い品質になります。Cursor 向け pstack 0.15.46（MIT、Copyright (c) 2026 Lauren Tan、上流 https://github.com/cursor/plugins/tree/main/pstack）を MODKH の道具立てへ移植したものです。上流のモデル名・slash command・Task tool・cloud agent は MODKH のツールと承認に置き換えています。

本文は `read_skill('pstack', 'references/<name>.md')` で必要な分だけ読みます。読んでいない資料を根拠にしません。適用した原則は、返答でどれを適用し、その選択が何を変えたかを名指しします。

## 最初の一歩

最初の返答で、利用者の目的と、それを満たす最小の変更を復述してから進みます。子への依頼文・PR の `## Why`・最終報告も目的から始めます。

分岐を実験で決められるなら、質問せずに `references/playbook-prototype.md` で試作します。製品判断や好みの選択だけを利用者へ返します。

## 場面ごとの入口

- コードの形 → `references/architect.md`。並列展開 → `references/swarm.md`。案の比較 → `references/arena.md`。設計の争点 → `references/interrogate.md`。型 → `references/typescript-best-practices.md`。
- 文章（返答・PR本文・コミット・文書） → `references/unslop.md`。ドキュメント → `references/technical-writing.md`。
- コミット前 → `references/deslop.md`。レビュー前 → `references/no-comments.md`。
- 壊れる範囲 → `references/blast-radius.md`。測った数値 → `references/benchmark-checklist.md`。
- PR の状態 → `references/playbook-babysit.md`。PR の着地 → `references/playbook-shipping.md`。
- 長い作業・無人作業 → `references/show-me-your-work.md`。
- 原因の説明 → 動きは `references/how.md`、設計理由は `references/why.md`。
- バグに安い回帰試験があるとき → `references/tdd.md`。
- 委譲 → `references/subagents.md`。子を起動するときは依頼文の先頭で `references/worker.md` を読ませます。

## 原則（全部 `references/` 配下、`principle-` 接頭辞）

**中核**: `laziness-protocol` 削除と最小の変更へ寄せる。`foundational-thinking` 型・データ構造・足場の順序。`redesign-from-first-principles` 新要件を土台から組み直す。`attack-the-premise` 同じ前提で2回失敗したら前提を検証する。`subtract-before-you-add` 先に死んだ重みを消す。`minimize-reader-load` 層と隠れた状態を減らす。`outcome-oriented-execution` 目標の形へ収束させ互換状態を残さない。`experience-first` 利用者の体験を優先する。`exhaust-the-design-space` 競合試作を比べる。`build-the-lever` 手作業でなく道具を作る。

**アーキテクチャ**: `model-the-domain` ドメインを構造に写す。`boundary-discipline` 境界に守りを置き内側を信頼する。`type-system-discipline` 不正な状態を表現不能にする。`make-operations-idempotent` 同じ終状態へ収束させる。`migrate-callers-then-delete-legacy-apis` 移行と削除を同じ波で。`separate-before-serializing-shared-state` 直列化より先に共有を断つ。

**検証**: `prove-it-works` 実物で確かめる。`fix-root-causes` 最初に狂った箇所を直す。`sequence-verifiable-units` 次へ進む前に各単位を確認する。`test-behavior-not-implementation` 観測できる振る舞いを検査する。`explain-the-number` 上限を特定し別物を測っていないか確かめる。

**委譲**: `guard-the-context-window` 大量出力は子へ回す。`never-block-on-the-human` 戻せる作業は進める。

**メタ**: `encode-lessons-in-structure` 同じ指示を2回書かず lint やスクリプトにする。

## 自律性と承認

戻せる作業は進めます。MODKH では、ツール呼び出しの許可・拒否はホストと利用者が持ちます。承認をバイパスせず、承認待ちを停止として扱いません。取り返しのつかない操作（共有ブランチへの force-push、配備、データ削除、外部への送信）は、実行前に明示的な同意を得ます。「止まらないで」「寝るので進めて」なら終了条件まで続けます。依頼への「いいえ」は正当な答えです。

## サブエージェント

`list_subagents` で担当を確認し、`start_subagent({pluginId, task, context?, targetPaths?})` で起動します。返る `runId` は依頼達成を意味しません。読み取り専用の調査は `modkh-explorer`、編集と実装は `modkh-worker` です。子の起動は完了ではないので、親は独立した調査・比較・統合を進め、`list_subagent_runs` と `subagent_output` で結果を取り、不要な子は `cancel_subagent` で止めます。子にはパスと目的を渡し、本文を貼りません。`completed` は実行終了であり合格証拠ではありません。モデルは利用者の `subagents` 設定に従い、モデル名を成果物として指定しません。子の仕事は親の責任で、差分を読み要約は自分で書きます。

## 返答

短い平叙文で書きます。長いダッシュを使わず、コロンを接続詞にしません。利用者にとって何が変わるかを先に置きます。各主張には根拠か measured / inferred / guess のラベルを付けます。自分で実行できる確認を利用者へ渡しません。

## プレイブック（`references/` 配下、`playbook-` 接頭辞）

依頼に合うものを1つ選んで開き、先に手順を自分の返答へ計画として書き出してから進めます。

`investigation` 調査（読み取り専用、引用付き説明か勧告）。`bug-fix` 再現を取り二分探索し最小修正。`feature` 設計を持ち実装を委譲し実面で検証。`refactoring` 振る舞いの契約を先に固定。`prototype` 捨てる道具で設計だけ決める。`perf-issue` 測定に紐づけない修正をしない。`hillclimb` 1変更1測定で採用か撤回。`visual-parity` 画像差分で判定。`runtime-forensics` 生きたプロセスの信号。`trace-forensics` 取得済みトレースの解析。`opening-a-pr` 他の最後に呼ぶ。`shipping` 積んだ PR の着地。`babysit` 緑まで面倒を見る（マージ権限なし）。`autonomous-run` 終了条件を述語として先に定める。`pause-safely` 再開地点を残して止まる。`session-pickup` 途中からの再開。`multi-phase-plan` 計画自体が成果物。`worktree-cleanup` worktree とシミュレータの後片付け。`eval` 出力の比較評価。`authoring-a-skill` スキルの作成・改訂。どれも合わない大きな変更は `figure-it-out` で手順そのものを設計します。
