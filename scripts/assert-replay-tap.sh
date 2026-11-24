#!/bin/sh
# TAP 出力が「対象ケースを実際に実行し、合格した」ことを確認する。
#
# 未実行・SKIP・TODO・fail はいずれも失敗として扱う。依存不足でテストファイルが読み込めない
# 場合も `ok` 行が出ないため失敗になる。判定を1か所に置くのは、ソース版と tarball 版で
# 同じ基準を使うため。
#
# 使い方: assert-replay-tap.sh <TAP出力ファイル> <期待するケース名>...
set -eu
log=$1
shift
[ -f "$log" ] || { echo "FAIL: TAP 出力がない: $log"; exit 1; }
status=0
if ! grep -q '^# fail 0$' "$log"; then
  echo "FAIL: TAP の失敗数が0でない"
  status=1
fi
if ! grep -qE '^# (skipped|skip) 0$' "$log"; then
  echo "FAIL: SKIP が1件以上ある（未実行・依存不足を成功扱いにしない）"
  status=1
fi
if ! grep -q '^# todo 0$' "$log"; then
  echo "FAIL: TODO が残っている"
  status=1
fi
if grep -q '^not ok ' "$log"; then
  echo "FAIL: 不合格のケースがある"
  status=1
fi
[ "$#" -gt 0 ] || { echo "FAIL: 期待するケース名が指定されていない"; exit 1; }
for name in "$@"; do
  if ! grep -qE "^ok [0-9]+ - ${name}\$" "$log"; then
    echo "FAIL: 対象ケースが合格していない: $name"
    status=1
  fi
done
if [ "$status" -ne 0 ]; then
  echo "--- TAP 出力 ---"
  cat "$log"
  exit 1
fi
echo "TAP_OK"
