#!/bin/sh
# MoDKH tarball 受け入れスクリプト。
# npm pack → 隔離ディレクトリへインストール → 固定応答モデルで
# 読む → 承認して編集 → テスト実行 → 再起動して再開 を確認する。
# 不正引数・ルート外・承認拒否・二重実行防止も確認する。
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/modkh-accept.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
# パッケージ・依存・キャッシュを同じ検証領域へ隔離し、利用者の共有キャッシュを変更しない。
export npm_config_cache="$WORK/npm-cache"

# 1) tarball を作る
cd "$ROOT"
npm pack --pack-destination "$WORK" >/dev/null
TARBALL=$(ls "$WORK"/modkh-*.tgz)

# 2) 隔離ディレクトリへ正規の方法で導入
mkdir -p "$WORK/install"
cd "$WORK/install"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$TARBALL" >/dev/null
CLI="$WORK/install/node_modules/modkh/dist/index.js"
test -f "$CLI" || { echo "FAIL: dist/index.js が tarball に含まれていない"; exit 1; }
"$CLI" --version >/dev/null || { echo "FAIL: --version が動かない"; exit 1; }

export MODKH_HOME="$WORK/home"
PROJ="$WORK/project"
mkdir -p "$PROJ"
printf '# modkh サンプル\n' > "$PROJ/README.md"

# 3) 新規セッション: 読む → ワークスペース内は自動承認で編集 → コマンド実行 → 完了
OUT1=$(printf '作業を開始して\n/exit\n' | "$CLI" chat --model fixed/scripted --cwd "$PROJ")
echo "$OUT1" | grep -q '(応答終了' || { echo "FAIL: 最初のセッションが完了しなかった"; echo "$OUT1"; exit 1; }
echo "$OUT1" | grep -q 'OUT_OF_ROOT' || { echo "FAIL: ルート外参照の拒否が観測されない"; echo "$OUT1"; exit 1; }
if echo "$OUT1" | grep -Eq '\(自動承認: |承認要求'; then
  echo "FAIL: ワークスペース内の自動承認で不要な通知または確認が表示された"
  echo "$OUT1"
  exit 1
fi
grep -q '固定応答モデルによる追記' "$PROJ/README.md" || { echo "FAIL: 編集が反映されていない"; exit 1; }
MARKLINES=$(grep -c '実行マーカー' "$PROJ/marker.txt" || true)
[ "$MARKLINES" = "1" ] || { echo "FAIL: マーカーが1行でない: $MARKLINES"; exit 1; }
SID=$(printf '%s\n' "$OUT1" | sed -n 's/^セッション \(.*\) を開始します.*/\1/p')
[ -n "$SID" ] || { echo "FAIL: セッションIDが取れない"; exit 1; }

# 4) 不正引数: 存在しないプロバイダーは明示エラーで終了コード1(自動切替なし)
OUTBAD=$("$CLI" chat --model incompatible-provider/xyz --cwd "$PROJ" </dev/null 2>&1 || true)
echo "$OUTBAD" | grep -q '自動で切り替え' || { echo "FAIL: 不正引数の明示エラーがない"; echo "$OUTBAD"; exit 1; }

# 5) 承認拒否: 拒否したコマンドは実行されない(permissions=none で毎回確認、EOF で拒否扱い)
rm -f "$PROJ/marker.txt"
printf '{"permissions":"none"}\n' > "$WORK/none-config.json"
mkdir -p "$WORK/none-home" && cp "$WORK/none-config.json" "$WORK/none-home/config.json"
OUT2=$(printf '作業を開始して\ny\n/exit\n' | MODKH_HOME="$WORK/none-home" "$CLI" chat --model fixed/scripted --cwd "$PROJ" 2>&1 || true)
echo "$OUT2" | grep -q '(拒否)' || { echo "FAIL: 承認拒否が観測されない"; echo "$OUT2"; exit 1; }
test ! -e "$PROJ/marker.txt" || { echo "FAIL: 拒否したのにコマンドが実行された"; exit 1; }

# 6) 中断: コマンド実行(sleep 2)中に Ctrl+C 相当 → 通信と子プロセスを止める
PROJ2="$WORK/project2"
mkdir -p "$PROJ2"
printf '# modkh サンプル\n' > "$PROJ2/README.md"
SID2_FILE="$WORK/sid2.txt"
( printf '作業を開始して\ny\ny\n'; sleep 4 ) | "$CLI" chat --model fixed/scripted --cwd "$PROJ2" > "$WORK/out3.log" 2>&1 &
CLI_PID=$!
i=0
until grep -q '実行マーカー' "$PROJ2/marker.txt" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 100 ] || ! kill -0 "$CLI_PID" 2>/dev/null; then
    kill -TERM "$CLI_PID" 2>/dev/null || true
    wait "$CLI_PID" || true
    echo "FAIL: 中断対象のコマンドが始まらない"
    cat "$WORK/out3.log"
    exit 1
  fi
  sleep 0.1
done
kill -INT "$CLI_PID" 2>/dev/null || true
set +e
wait "$CLI_PID"
RC3=$?
set -e
grep -q '(中断しました' "$WORK/out3.log" || { echo "FAIL: 中断が観測されない"; cat "$WORK/out3.log"; exit 1; }
grep -c '実行マーカー' "$PROJ2/marker.txt" | grep -q '^1$' || { echo "FAIL: 中断後のマーカーが1行でない"; exit 1; }
SID2=$(sed -n 's/^セッション \(.*\) を開始します.*/\1/p' "$WORK/out3.log")
[ -n "$SID2" ] || { echo "FAIL: 中断セッションのIDが取れない"; exit 1; }

# 7) 再開: 再起動して --resume。結果不明ツールは自動再実行しない
OUT4=$(printf '/exit\n' | "$CLI" chat --model fixed/scripted --cwd "$PROJ2" --resume "$SID2" 2>&1)
echo "$OUT4" | grep -q '再開します' || { echo "FAIL: 再開が観測されない"; echo "$OUT4"; exit 1; }
echo "$OUT4" | grep -q '自動では再実行しません' || { echo "FAIL: 結果不明ツールの警告がない"; echo "$OUT4"; exit 1; }
grep -c '実行マーカー' "$PROJ2/marker.txt" | grep -q '^1$' || { echo "FAIL: 再開時に二重実行された"; exit 1; }

# 8) 裸起動 + /connect: モデル指定なしで起動し、対話中に接続して会話する
PROJ3="$WORK/project3"
mkdir -p "$PROJ3"
printf '# modkh サンプル\n' > "$PROJ3/README.md"
OUT5=$(printf '/connect\n/connect fixed/scripted\n作業を開始して\ny\ny\ny\n/exit\n' | "$CLI" --cwd "$PROJ3" 2>&1 || true)
echo "$OUT5" | grep -q 'OpenAI' || { echo "FAIL: /connect 単体の使い方が観測されない"; echo "$OUT5"; exit 1; }
echo "$OUT5" | grep -q '接続しました: fixed/scripted' || { echo "FAIL: /connect での接続が観測されない"; echo "$OUT5"; exit 1; }
echo "$OUT5" | grep -q '(応答終了' || { echo "FAIL: /connect 後の会話が完了しなかった"; echo "$OUT5"; exit 1; }
grep -q '固定応答モデルによる追記' "$PROJ3/README.md" || { echo "FAIL: /connect 後の編集が反映されていない"; exit 1; }
# 固定シナリオを通常の接続として保存・復元しない。
OUTNOMODEL=$(printf 'hello\n/exit\n' | "$CLI" --cwd "$PROJ3" 2>&1 || true)
LASTJSON=$(ls -t "$WORK/home/sessions"/*.jsonl | head -1)
head -1 "$LASTJSON" | grep -q '"model":"unconnected"' || { echo "FAIL: 固定モデルが自動復元された"; echo "$OUTNOMODEL"; exit 1; }
echo "$OUTNOMODEL" | grep -q 'モデル未接続' || { echo "FAIL: 未接続時の案内がない"; echo "$OUTNOMODEL"; exit 1; }
if echo "$OUTNOMODEL" | grep -q '▶ run_command'; then echo "FAIL: 指定していない固定シナリオが実行された"; exit 1; fi

# 未接続のホームで送信すると、接続先選びが自動で開く。
FRESH_HOME="$WORK/fresh-home"
mkdir -p "$FRESH_HOME"
OUTUNCONNECTED=$(printf 'hello\n/exit\n' | MODKH_HOME="$FRESH_HOME" "$CLI" --cwd "$PROJ3" 2>&1 || true)
echo "$OUTUNCONNECTED" | grep -q 'Connect an integration' || { echo "FAIL: 未接続時の接続選択が始まらない"; echo "$OUTUNCONNECTED"; exit 1; }

# 9) 配布済み CLI で検索・番号選択。認証経路も配布物で回帰検証する。
OUTMODELS=$(printf '/models ScRiPt\n1\n/connect\n\n/exit\n' | "$CLI" --cwd "$PROJ3")
echo "$OUTMODELS" | grep -q '1. fixed/scripted' || { echo 'FAIL: 検索候補がない'; exit 1; }
echo "$OUTMODELS" | grep -q '接続中: fixed/scripted' || { echo 'FAIL: モデル選択が反映されない'; exit 1; }
MODKH_TEST_ENTRY="$CLI" MODKH_TEST_CHAT="$WORK/install/node_modules/modkh/dist/cli/chat.js" MODKH_TEST_TERMINAL="$WORK/install/node_modules/modkh/dist/cli/terminal.js" node --test --test-reporter=tap \
  "$ROOT/test/cli.interactive.test.ts" "$ROOT/test/cli.safety.test.ts" \
  "$ROOT/test/cli.stop.test.ts" "$ROOT/test/cli.compaction.test.ts" "$ROOT/test/cli.memory.test.ts" "$ROOT/test/cli.tui.test.ts" \
  "$ROOT/test/cli.agenticreplay.test.ts" "$ROOT/test/terminal.drag-copy.test.ts" \
  "$ROOT/test/plugins.entry.test.ts" "$ROOT/test/subagents.cli.test.ts" "$ROOT/test/composer.flow.test.ts" "$ROOT/test/cli.harness.test.ts"

# 10) 言語機能: 配布物から空の管理領域へ実TypeScriptサーバーを自動導入し、診断・再利用・編集後の再診断を確認。
PROJLANG="$WORK/langproject"
mkdir -p "$PROJLANG/src"
printf '{"compilerOptions":{"strict":true,"target":"es2022","module":"esnext","moduleResolution":"bundler"},"include":["src"]}\n' > "$PROJLANG/tsconfig.json"
printf 'export const value: number = "oops";\n' > "$PROJLANG/src/bad.ts"
python3 "$ROOT/scripts/language-acceptance.py" "$CLI" "$WORK" "$PROJLANG"

# Verify the exported SDK from the installed package, not the source checkout.
node --input-type=module -e 'await import("modkh/plugin-api")'
test -f node_modules/modkh/dist/plugins/api.d.ts
printf 'import type { LocalPlugin } from "modkh/plugin-api"; const plugin: LocalPlugin = { define: () => ({ system: "Review", tools: ["read_file"] }) }; void plugin;\n' > sdk-consumer.ts
node "$ROOT/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck --target es2023 --module nodenext sdk-consumer.ts

echo "ACCEPTANCE_OK"
