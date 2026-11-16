import test from 'node:test';
import assert from 'node:assert/strict';
import { textWidth, wrap, wrapText } from '../src/cli/editor.ts';

test('wrapText keeps every character and never exceeds the width', () => {
  const text = '1. `TextSink.text()` の重なり計算を修正し、`produced == headBudget+tailBudget` のテストを追加する。';
  for (const width of [1, 2, 3, 5, 8, 20, 40, 80]) {
    const lines = wrapText(text, width);
    assert.equal(lines.join(''), text, `width ${width} loses no character`);
    for (const line of lines) {
      // 全角1文字は2セルなので、幅1では1文字で溢れる。1文字以上を必ず置く。
      assert.ok(textWidth(line) <= Math.max(width, 2), `width ${width}: ${JSON.stringify(line)}`);
    }
  }
});

test('wrapText prefers a break after a space or Japanese punctuation instead of splitting a token', () => {
  const text = 'produced == headBudget+tailBudget`、produced == budget';
  const lines = wrapText(text, 30);
  assert.ok(lines.join('').includes('headBudget+tailBudget'), 'the long token stays in one piece');
  assert.ok(lines.every(line => textWidth(line) <= 30));
  // 空白の直後で切れている(語頭が次行へ落ちる)。
  assert.ok(lines.slice(1).every(line => !/^\s/.test(line) || line.trim() === ''), 'no line starts with the break space');
});

test('wrapText hard-splits a token wider than the line but still keeps the text', () => {
  const token = 'x'.repeat(25);
  const lines = wrapText(token, 10);
  assert.deepEqual(lines.map(textWidth), [10, 10, 5]);
  assert.equal(lines.join(''), token);
});

test('wrapText leaves blank and short lines untouched, unlike the cell-only wrap', () => {
  assert.deepEqual(wrapText('', 10), ['']);
  assert.deepEqual(wrapText('short', 10), ['short']);
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b']);
  assert.deepEqual(wrap('abc', 10), ['abc']);
});

test('wrapText strips colours and control characters like wrap does', () => {
  assert.deepEqual(wrapText('\u001b[31mred\u001b[0m', 10), ['red']);
});
